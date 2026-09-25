/*
 * Regression test for the orphaned-grandchild hang (2026-06-09).
 *
 * ensureBaseUrlReady's cleanup used to kill only the spawned wrapper
 * process. When launchCommand is an npm-style wrapper, its grandchild
 * (next-server) survived, kept the inherited stdio pipes open, and hung
 * any caller waiting on the gate through execFile, the blog-writer
 * publish workflows then died at their 10-minute job timeout.
 *
 * The fix kills the whole process group. This test launches a real
 * wrapper -> grandchild-server tree and asserts the grandchild is dead
 * after cleanup().
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { ensureBaseUrlReady } from "../ensure-base-url";
import type { GateConfig } from "../load-config";

const here = path.dirname(fileURLToPath(import.meta.url));
const wrapperPath = path.join(here, "fixtures", "launch-wrapper.mjs");

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("cleanup kills the grandchild server, not just the launch wrapper", async () => {
  const port = 49152 + (process.pid % 1000);
  const pidFile = path.join(
    os.tmpdir(),
    `gate-grandchild-${process.pid}-${port}.pid`,
  );
  process.env.GRANDCHILD_PID_FILE = pidFile;

  const config = {
    baseUrl: `http://127.0.0.1:${port}`,
    launchCommand: `node ${wrapperPath}`,
    startupTimeoutMs: 15_000,
    routes: [],
  } as unknown as GateConfig;

  let grandchildPid: number | null = null;
  try {
    const cleanup = await ensureBaseUrlReady(config);

    grandchildPid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(grandchildPid > 0, "grandchild wrote its pid");
    assert.ok(pidIsAlive(grandchildPid), "grandchild is serving before cleanup");

    await cleanup();

    // SIGTERM is async; give the group up to 3s to die before judging.
    let alive = true;
    for (let i = 0; i < 30 && alive; i++) {
      alive = pidIsAlive(grandchildPid);
      if (alive) await delay(100);
    }
    assert.equal(
      alive,
      false,
      "grandchild server must be dead after cleanup, an orphan here hangs execFile callers",
    );
  } finally {
    delete process.env.GRANDCHILD_PID_FILE;
    // Belt-and-braces: never leave an orphan behind if the assertion fails.
    if (grandchildPid && pidIsAlive(grandchildPid)) {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    fs.rmSync(pidFile, { force: true });
  }
});

/*
 * Regression test for the 2026-09-24 publish hang (site-monitor#273).
 *
 * gate-seo's FAIL path called process.exit(1) inside
 * `try { ... } finally { await stopServer(); }`. process.exit() does not run
 * finally blocks, so the detached server survived, held the inherited stdio
 * pipes, and the publisher's execFile("npm", ["run", "gate:seo"]) never
 * called back. The book and ADA publish runs sat silent for 20 minutes.
 *
 * Load-bearing: before the exit hook in ensureBaseUrlReady, the execFile
 * callback below never fires and the test fails on its bounded timeout.
 */
test("a gate that exits without cleanup does not orphan its server or hang an execFile caller", async () => {
  const { execFile } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");

  const port = 50152 + (process.pid % 1000);
  const pidFile = path.join(os.tmpdir(), `gate-exit-grandchild-${process.pid}-${port}.pid`);
  const fixture = path.join(here, "fixtures", "gate-exits-without-cleanup.ts");
  const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

  let grandchildPid: number | null = null;
  try {
    const outcome = await new Promise<{ code: number | null; killed: boolean }>((resolve) => {
      const child = execFile(
        process.execPath,
        ["--import", tsxLoader, fixture],
        {
          env: { ...process.env, GATE_FIXTURE_PORT: String(port), GRANDCHILD_PID_FILE: pidFile },
          // Bounded: without the fix the callback never fires on its own.
          timeout: 20_000,
          killSignal: "SIGKILL",
        },
        (error) => {
          const err = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
          resolve({ code: typeof err?.code === "number" ? err.code : err ? null : 0, killed: !!err?.killed });
        },
      );
      child.stdin?.end();
    });

    if (fs.existsSync(pidFile)) grandchildPid = Number(fs.readFileSync(pidFile, "utf8"));

    assert.equal(outcome.killed, false, "execFile had to be killed by its timeout: the gate hung its caller");
    assert.equal(outcome.code, 1, "the gate's own exit code reaches the caller");
    assert.ok(grandchildPid && grandchildPid > 0, "the fixture really launched a grandchild server");

    let alive = true;
    for (let i = 0; i < 30 && alive; i++) {
      alive = pidIsAlive(grandchildPid!);
      if (alive) await delay(100);
    }
    assert.equal(alive, false, "grandchild server must not outlive a gate that exited without cleanup");
  } finally {
    if (grandchildPid && pidIsAlive(grandchildPid)) {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    fs.rmSync(pidFile, { force: true });
  }
});
