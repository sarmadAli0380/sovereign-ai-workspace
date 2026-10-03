import { chmod, chown, lstat, readdir, realpath } from "node:fs/promises";

const TARGET_UID = 1000;
const TARGET_GID = 1000;
const ALLOWED = new Set(["/var/lib/sovereign/attachments", "/var/lib/sovereign/spool"]);

async function initialize(path: string): Promise<void> {
  if (!ALLOWED.has(path)) throw new Error(`refusing to initialize unexpected volume path ${JSON.stringify(path)}`);
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error(`deployment volume ${path} must be a real directory, not a link`);
  }
  const entries = await readdir(path);
  if (entries.length > 0 && (metadata.uid !== TARGET_UID || metadata.gid !== TARGET_GID)) {
    throw new Error(`refusing to change ownership of non-empty deployment volume ${path}`);
  }
  await chown(path, TARGET_UID, TARGET_GID);
  await chmod(path, 0o700);
}

if (typeof process.getuid !== "function" || process.getuid() !== 0) {
  throw new Error("deployment volume initialization must run as container root");
}

await initialize("/var/lib/sovereign/attachments");
await initialize("/var/lib/sovereign/spool");
console.log(JSON.stringify({ status: "ready", volumes: ["attachments", "event_spool"], owner: "1000:1000", mode: "0700" }));
