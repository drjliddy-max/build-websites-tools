/*
 * Test fixture: the launchCommand wrapper for gate-site-server.mjs, standing in
 * for `npm run dev`. It spawns the server as a grandchild in the same process
 * group with inherited stdio and waits on it. That inherited stdio is what held
 * the publisher's execFile pipe open in site-monitor#273.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = spawn(process.execPath, [path.join(here, "gate-site-server.mjs")], {
  stdio: "inherit",
});
server.on("exit", (code) => process.exit(code ?? 0));
