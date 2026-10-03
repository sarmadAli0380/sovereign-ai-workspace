import { lookup } from "node:dns/promises";
import { realpath, stat } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { cloneData } from "./clone-data.ts";

export interface ToolConcurrencyPolicy {
  globalCapacity: number;
  defaultCapabilityCapacity: number;
  capabilityCapacities?: Readonly<Record<string, number>>;
}

export interface ToolConcurrencyLease {
  release(): void;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${field} must be a positive whole number`);
  }
  return Number(value);
}

/** Process-local, non-queueing capacity gate shared by dispatchers. */
export class ToolExecutionController {
  readonly #globalCapacity: number;
  readonly #defaultCapabilityCapacity: number;
  readonly #capabilityCapacities: ReadonlyMap<string, number>;
  readonly #idempotentResults = new Map<string, Promise<ToolResultMessage>>();
  #globalUsed = 0;
  readonly #capabilityUsed = new Map<string, number>();

  constructor(policy: ToolConcurrencyPolicy) {
    if (typeof policy !== "object" || policy === null) {
      throw new TypeError("tool concurrency policy must be an object");
    }
    const allowed = new Set(["globalCapacity", "defaultCapabilityCapacity", "capabilityCapacities"]);
    const unknown = Object.keys(policy).filter((key) => !allowed.has(key));
    if (unknown.length > 0) throw new TypeError(`tool concurrency policy has unknown fields: ${unknown.join(", ")}`);
    this.#globalCapacity = positiveInteger(policy.globalCapacity, "globalCapacity");
    this.#defaultCapabilityCapacity = positiveInteger(
      policy.defaultCapabilityCapacity,
      "defaultCapabilityCapacity",
    );
    const capacities = new Map<string, number>();
    for (const [capability, capacity] of Object.entries(policy.capabilityCapacities ?? {})) {
      if (!/^[a-z][a-z0-9.-]*$/.test(capability)) {
        throw new TypeError(`capability capacity key ${JSON.stringify(capability)} is invalid`);
      }
      capacities.set(capability, positiveInteger(capacity, `capabilityCapacities.${capability}`));
    }
    this.#capabilityCapacities = capacities;
  }

  tryAcquire(capabilities: readonly string[], cost: number): ToolConcurrencyLease | undefined {
    const units = positiveInteger(cost, "concurrencyCost");
    const unique = [...new Set(capabilities)].sort();
    if (this.#globalUsed + units > this.#globalCapacity) return undefined;
    for (const capability of unique) {
      const used = this.#capabilityUsed.get(capability) ?? 0;
      const capacity = this.#capabilityCapacities.get(capability) ?? this.#defaultCapabilityCapacity;
      if (used + units > capacity) return undefined;
    }
    this.#globalUsed += units;
    for (const capability of unique) {
      this.#capabilityUsed.set(capability, (this.#capabilityUsed.get(capability) ?? 0) + units);
    }
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#globalUsed -= units;
        for (const capability of unique) {
          const next = (this.#capabilityUsed.get(capability) ?? units) - units;
          if (next === 0) this.#capabilityUsed.delete(capability);
          else this.#capabilityUsed.set(capability, next);
        }
      },
    };
  }

  idempotentResult(
    scope: string,
    execute: () => Promise<ToolResultMessage>,
  ): { promise: Promise<ToolResultMessage>; replayed: boolean } {
    const existing = this.#idempotentResults.get(scope);
    if (existing) return { promise: existing.then(cloneData), replayed: true };
    const promise = execute().then((result) => cloneData(result));
    this.#idempotentResults.set(scope, promise);
    promise.catch(() => this.#idempotentResults.delete(scope));
    return { promise: promise.then(cloneData), replayed: false };
  }
}

export const defaultToolExecutionController = new ToolExecutionController({
  globalCapacity: 64,
  defaultCapabilityCapacity: 16,
});

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export class WorkspaceConfinement {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(root: string): Promise<WorkspaceConfinement> {
    if (typeof root !== "string" || root.length === 0) throw new TypeError("workspace root must be non-empty");
    const canonical = await realpath(root);
    if (!(await stat(canonical)).isDirectory()) throw new TypeError("workspace root must be a directory");
    return new WorkspaceConfinement(canonical);
  }

  async existing(inputPath: string): Promise<string> {
    const candidate = await realpath(this.lexical(inputPath));
    if (!isWithin(this.root, candidate)) throw new Error("workspace.path-escape");
    return candidate;
  }

  async forCreate(inputPath: string): Promise<string> {
    const lexical = this.lexical(inputPath);
    const parent = await realpath(dirname(lexical));
    if (!isWithin(this.root, parent)) throw new Error("workspace.path-escape");
    const candidate = resolve(parent, basename(lexical));
    if (!isWithin(this.root, candidate)) throw new Error("workspace.path-escape");
    try {
      const existing = await realpath(candidate);
      if (!isWithin(this.root, existing)) throw new Error("workspace.path-escape");
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return candidate;
    }
  }

  private lexical(inputPath: string): string {
    if (typeof inputPath !== "string" || inputPath.length === 0 || inputPath.includes("\0")) {
      throw new TypeError("workspace path must be a non-empty string without NUL bytes");
    }
    const candidate = resolve(this.root, inputPath);
    if (!isWithin(this.root, candidate)) throw new Error("workspace.path-escape");
    return candidate;
  }
}

export interface ShellExecutionPolicy {
  allowedExecutables: readonly string[];
  allowedEnvironmentKeys: readonly string[];
  maxArguments: number;
  maxArgumentChars: number;
}

export interface ShellExecutionRequest {
  executable: string;
  args: readonly string[];
  cwd: string;
  environment?: Readonly<Record<string, string>>;
}

export interface ValidatedShellExecution extends ShellExecutionRequest {
  cwd: string;
  environment: Readonly<Record<string, string>>;
}

export async function validateShellExecution(
  request: ShellExecutionRequest,
  policy: ShellExecutionPolicy,
  workspace: WorkspaceConfinement,
): Promise<ValidatedShellExecution> {
  if (!policy.allowedExecutables.includes(request.executable)) throw new Error("shell.executable-denied");
  const maxArguments = positiveInteger(policy.maxArguments, "shell maxArguments");
  const maxArgumentChars = positiveInteger(policy.maxArgumentChars, "shell maxArgumentChars");
  if (!Array.isArray(request.args) || request.args.length > maxArguments) throw new Error("shell.arguments-denied");
  if (request.args.some((arg) => typeof arg !== "string") || request.args.join("").length > maxArgumentChars) {
    throw new Error("shell.arguments-denied");
  }
  const allowedKeys = new Set(policy.allowedEnvironmentKeys);
  const environment = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(request.environment ?? {})) {
    if (!allowedKeys.has(key) || typeof value !== "string" || key.includes("=") || key.includes("\0") || value.includes("\0")) {
      throw new Error("shell.environment-denied");
    }
    environment[key] = value;
  }
  return Object.freeze({
    executable: request.executable,
    args: Object.freeze([...request.args]),
    cwd: await workspace.existing(request.cwd),
    environment: Object.freeze(environment),
  });
}

export interface HttpExecutionPolicy {
  allowedSchemes: readonly ("http:" | "https:")[];
  allowedHosts?: readonly string[];
  allowedPorts?: readonly number[];
  allowPrivateAddresses?: boolean;
  maxRedirects: number;
  maxResponseBytes: number;
}

export interface HttpPolicyDependencies {
  fetch?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<readonly string[]>;
}

const NON_PUBLIC_DESTINATIONS = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) NON_PUBLIC_DESTINATIONS.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001:db8::", 32], ["2001:10::", 28], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) NON_PUBLIC_DESTINATIONS.addSubnet(network, prefix, "ipv6");

function privateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  // Treat IPv4-mapped IPv6 as non-public rather than risk a representation
  // bypass between the resolver, policy check, and socket layer.
  if (family === 6 && address.toLowerCase().startsWith("::ffff:")) return true;
  return NON_PUBLIC_DESTINATIONS.check(address, family === 4 ? "ipv4" : "ipv6");
}

async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  if (isIP(hostname)) return [hostname];
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

async function validateHttpUrl(
  raw: string,
  policy: HttpExecutionPolicy,
  resolveHost: (hostname: string) => Promise<readonly string[]>,
): Promise<{ url: URL; addresses: readonly string[] }> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("http.url-invalid"); }
  if (!policy.allowedSchemes.includes(url.protocol as "http:" | "https:")) throw new Error("http.scheme-denied");
  if (url.username || url.password) throw new Error("http.credentials-denied");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (policy.allowedHosts && !policy.allowedHosts.map((host) => host.toLowerCase()).includes(hostname)) {
    throw new Error("http.destination-denied");
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (policy.allowedPorts && !policy.allowedPorts.includes(port)) throw new Error("http.port-denied");
  const addresses = await resolveHost(hostname);
  if (addresses.length === 0) throw new Error("http.dns-empty");
  if (!policy.allowPrivateAddresses && addresses.some(privateAddress)) throw new Error("http.destination-denied");
  return { url, addresses };
}

function pinnedFetch(url: URL, addresses: readonly string[], init: RequestInit): Promise<Response> {
  return new Promise<Response>((resolveResponse, reject) => {
    const selected = addresses[0]!;
    const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = requester(url, {
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string> | undefined,
      signal: init.signal ?? undefined,
      lookup: (_hostname, _options, callback) => {
        callback(null, selected, isIP(selected) as 4 | 6);
      },
    }, (response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      resolveResponse(new Response(Readable.toWeb(response) as ReadableStream, {
        status: response.statusCode ?? 500,
        statusText: response.statusMessage,
        headers,
      }));
    });
    request.on("error", reject);
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body === "string" || init.body instanceof Uint8Array) request.write(init.body);
      else {
        request.destroy();
        reject(new TypeError("http request body must be a string or Uint8Array"));
        return;
      }
    }
    request.end();
  });
}

export async function fetchWithHttpPolicy(
  rawUrl: string,
  policy: HttpExecutionPolicy,
  init: RequestInit = {},
  dependencies: HttpPolicyDependencies = {},
): Promise<{ url: string; status: number; headers: Readonly<Record<string, string>>; body: Uint8Array }> {
  const fetcher = dependencies.fetch;
  const resolveHost = dependencies.resolveHost ?? defaultResolveHost;
  const maxResponseBytes = positiveInteger(policy.maxResponseBytes, "HTTP maxResponseBytes");
  if (!Number.isInteger(policy.maxRedirects) || policy.maxRedirects < 0) throw new TypeError("HTTP maxRedirects must be a non-negative whole number");
  if (init.redirect && init.redirect !== "manual") throw new Error("http.redirect-mode-denied");
  let destination = await validateHttpUrl(rawUrl, policy, resolveHost);
  for (let redirects = 0; ; redirects += 1) {
    const response = fetcher
      ? await fetcher(destination.url, { ...init, redirect: "manual" })
      : await pinnedFetch(destination.url, destination.addresses, init);
    if (response.status >= 300 && response.status < 400) {
      if (redirects >= policy.maxRedirects) throw new Error("http.redirect-limit");
      const location = response.headers.get("location");
      if (!location) throw new Error("http.redirect-location-missing");
      destination = await validateHttpUrl(new URL(location, destination.url).href, policy, resolveHost);
      continue;
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxResponseBytes)) {
      await response.body?.cancel();
      throw new Error("http.response-too-large");
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > maxResponseBytes) {
          await reader.cancel();
          throw new Error("http.response-too-large");
        }
        chunks.push(item.value);
      }
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return {
      url: destination.url.href,
      status: response.status,
      headers: Object.freeze(Object.fromEntries(response.headers.entries())),
      body,
    };
  }
}
