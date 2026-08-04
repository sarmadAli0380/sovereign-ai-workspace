/**
 * One-time OAuth login for a provider, persisted to the harness's own
 * credential store.
 *
 *   node scripts/login.ts openai-codex
 *
 * Runs pi-ai's first-party provider login flow. The harness never sees or
 * stores the token itself — the provider's flow returns a credential and
 * pi-ai writes it through the CredentialStore.
 *
 * Note this is NOT the same credential as the Codex CLI's
 * `~/.codex/auth.json`; pi-ai keeps its own store, so this is a separate
 * login even if you are already signed in to Codex elsewhere.
 */

import { getModels } from "../src/load-model.ts";
import { terminalAuthInteraction } from "../src/terminal-auth.ts";
import { DEFAULT_CREDENTIALS_PATH } from "../src/credential-store.ts";

const providerId = process.argv[2] ?? "openai-codex";

const models = getModels();
const provider = models.getProvider(providerId);

if (!provider) {
  const available = models
    .getProviders()
    .map((p) => p.id)
    .sort()
    .join(", ");
  console.error(`Unknown provider "${providerId}".\nAvailable: ${available}`);
  process.exit(1);
}

const authTypes = Object.keys(provider.auth) as ("api_key" | "oauth")[];
const authType = authTypes.includes("oauth") ? "oauth" : authTypes[0];

if (!authType) {
  console.error(`Provider "${providerId}" declares no auth strategy.`);
  process.exit(1);
}

console.log(`Logging in to ${provider.name ?? provider.id} via ${authType}…`);

try {
  await models.login(providerId, authType, terminalAuthInteraction());
  console.log(`\n✓ Logged in to ${providerId}.`);
  console.log(`  Credential stored in ${DEFAULT_CREDENTIALS_PATH} (gitignored).`);
  console.log(`  Verify the harness against it with: npm run verify`);
} catch (error) {
  console.error(`\n✗ Login failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
