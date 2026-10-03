import { once } from "node:events";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { parseSingleNodeDeploymentConfig, readDeploymentSecrets } from "../src/deployment/config.ts";
import { getModels } from "../src/load-model.ts";
import { DurableJournalSink, EncryptedEventSpool, JournalConsumer } from "../src/storage/durable-journal.ts";
import { PgSqlExecutor } from "../src/storage/pg.ts";
import { RunHistoryProjector } from "../src/storage/run-history-projector.ts";
import {
  ConsumerCheckpointRepository,
  EventJournalRepository,
  MessageRepository,
} from "../src/storage/repositories/index.ts";
import { readSessionRegistryFile } from "../src/server/auth.ts";
import { DurableApprovalGateway, PostgresApprovalStore } from "../src/server/approval-gateway.ts";
import { PostgresRunCommandStore } from "../src/server/command-store.ts";
import { parseServerDeploymentConfig } from "../src/server/config.ts";
import { DeploymentOllamaRouteResolver } from "../src/server/deployment-route.ts";
import { RunEventBroker } from "../src/server/event-broker.ts";
import { createSovereignHttpServer } from "../src/server/http-server.ts";
import { DurableRunCommandGateway } from "../src/server/run-gateway.ts";
import { PostgresServerAccessController } from "../src/server/storage.ts";
import { PostgresIdentityStore } from "../src/server/identity-store.ts";
import { PostgresProductReadStore } from "../src/server/product-reads.ts";
import { PostgresRunControlGateway } from "../src/server/run-controls.ts";
import { ToolExecutionController } from "../src/tool-execution.ts";
import { ToolRegistry } from "../src/tool-registry.ts";

const deployment = parseSingleNodeDeploymentConfig();
const serverConfig = parseServerDeploymentConfig();
const secrets = await readDeploymentSecrets(deployment);
const pool = new Pool({
  host: deployment.database.host,
  port: deployment.database.port,
  database: deployment.database.name,
  user: deployment.database.user,
  password: secrets.databasePassword,
  max: 10,
  connectionTimeoutMillis: 15_000,
  idleTimeoutMillis: 30_000,
  application_name: "sovereign-c4-server",
});
const database = new PgSqlExecutor(pool);
const identities = new PostgresIdentityStore(database);
await identities.bootstrap(await readSessionRegistryFile(serverConfig.sessionRegistryFile));
const journal = new EventJournalRepository(database);
const spool = new EncryptedEventSpool({
  directory: deployment.storage.spoolRoot,
  key: secrets.spoolKey,
  maxEntries: deployment.storage.spoolMaxEntries,
  maxBytes: deployment.storage.spoolMaxBytes,
});
secrets.spoolKey.fill(0);
const durable = new DurableJournalSink({ journal, spool });
const consumer = new JournalConsumer({
  name: "run-history-v1",
  journal,
  checkpoints: new ConsumerCheckpointRepository(database),
});
const projector = new RunHistoryProjector(database);
let projectionTail: Promise<number> = Promise.resolve(0);
const projection = {
  drain(): Promise<number> {
    const operation = projectionTail.then(() => consumer.drain((delivery) => projector.apply(delivery)));
    projectionTail = operation.catch(() => 0);
    return operation;
  },
};
const routes = new DeploymentOllamaRouteResolver({
  config: loadConfig(),
  models: getModels(),
  deployment,
  freeMemoryBytes: serverConfig.admissionFreeBytes,
  deploymentHeadroomBytes: serverConfig.admissionHeadroomBytes,
});
const broker = new RunEventBroker(() => undefined);
const registry = new ToolRegistry();
const toolExecutionController = new ToolExecutionController({
  globalCapacity: 16,
  defaultCapabilityCapacity: 4,
});
const commands = new DurableRunCommandGateway({
  commands: new PostgresRunCommandStore(database),
  messages: new MessageRepository(database),
  routes,
  controls: new PostgresRunControlGateway({
    pool,
    policy: {
      maxConcurrentPerUser: serverConfig.maxConcurrentRunsPerUser,
      maxConcurrentPerModel: serverConfig.maxConcurrentRunsPerModel,
      maxRunsPerUserPerWindow: serverConfig.maxRunsPerUserPerWindow,
      rateWindowMs: serverConfig.rateWindowMs,
      maxTokensPerUserPerWindow: serverConfig.maxTokensPerUserPerWindow,
      maxSpendUsdPerUserPerWindow: serverConfig.maxSpendUsdPerUserPerWindow,
      budgetWindowMs: serverConfig.budgetWindowMs,
      leaseTtlMs: serverConfig.controlLeaseTtlMs,
    },
  }),
  durable,
  projection,
  deploymentId: serverConfig.deploymentId,
  runTimeoutMs: serverConfig.runTimeoutMs,
  registry,
  toolExecutionController,
  onBackgroundFailure: (_error, runId) => {
    process.stderr.write(`${JSON.stringify({ level: "error", code: "run.background-failed", runId })}\n`);
  },
});
const approvals = new DurableApprovalGateway({
  store: new PostgresApprovalStore(database),
  messages: new MessageRepository(database),
  registry,
  executionController: toolExecutionController,
  deploymentId: serverConfig.deploymentId,
  contextWindow: deployment.inference.contextWindow,
});
const server = createSovereignHttpServer({
  authenticator: identities,
  access: new PostgresServerAccessController(database),
  commands,
  replay: journal,
  identity: identities,
  approvals,
  reads: new PostgresProductReadStore(database),
  readiness: { async check() {
    try {
      await pool.query("SELECT 1");
      return await routes.ready();
    } catch {
      return false;
    }
  } },
  broker,
});

const projectionTimer = setInterval(() => {
  void projection.drain().catch(() => undefined);
}, serverConfig.projectionIntervalMs);
projectionTimer.unref();

server.listen(serverConfig.port, serverConfig.host);
await once(server, "listening");
process.stdout.write(`${JSON.stringify({ status: "listening", port: serverConfig.port })}\n`);

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  clearInterval(projectionTimer);
  server.close();
  server.closeIdleConnections();
  await Promise.race([once(server, "close"), new Promise((resolve) => setTimeout(resolve, 30_000))]);
  server.closeAllConnections();
  await pool.end();
};
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
