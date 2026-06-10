/*
 * Test fixture: the "wrapper" a launchCommand typically is (npm run dev).
 * Spawns the grandchild server in the same process group and then waits on
 * it, exactly like npm waits on the script it runs. A naive child.kill on
 * this wrapper leaves the grandchild alive, the bug this fixture exists
 * to reproduce.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const grandchild = spawn(
  process.execPath,
  [path.join(here, "launch-grandchild-server.mjs")],
  { stdio: "inherit" },
);
grandchild.on("exit", (code) => process.exit(code ?? 0));
