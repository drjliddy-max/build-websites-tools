/*
 * Behavioral regression tests for the 2026-09-24 blog publish hang
 * (site-monitor#273, FND-0091).
 *
 * gate-seo's FAIL branch called process.exit(1) inside
 * `try { ... } finally { await stopServer(); }`. process.exit() skips finally
 * blocks, so the dev server ensureBaseUrlReady() launched outlived the gate,
 * kept the inherited stdout/stderr pipes open, and the blog-writer publisher's
 * execFile("npm", ["run", "gate:seo"]) never called back. The book and ADA
 * publish runs sat in "Publish staged draft" until their 20-minute timeout.
 * gate-ada had the same shape at its load-failure and blocking-violation exits.
 *
 * These tests run the REAL gate binaries the way the publisher does: `npm run
 * gate:<name>` through execFile with piped stdio, against a fixture site started
 * by the gate's own launchCommand (wrapper -> grandchild, like npm -> next-server).
 * Each asserts, per the operator's acceptance for this repair:
 *   - the command terminates within a bound (execFile is not killed by timeout);
 *   - a failing gate still exits non-zero, and a passing gate still exits 0;
 *   - the launched server is dead afterwards;
 *   - the server received SIGTERM, i.e. the gate's own finally/stopServer ran.
 *     ensureBaseUrlReady's last-resort exit hook sends SIGKILL, which leaves no
 *     marker, so this assertion is load-bearing for the exitCode+return repair
 *     on its own, not just for the exit hook.
 * A source-text replacement of process.exit is not treated as proof; the
 * source assertion at the end only supplements these runs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const wrapperPath = path.join(here, "fixtures", "gate-site-wrapper.mjs");
const ROUTES = ["/", "/privacy", "/terms", "/accessibility", "/contact"];
// Generous for a cold tsx + JSDOM start on CI; the unfixed hang never returns.
const EXEC_TIMEOUT_MS = 45_000;

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

interface GateRun {
  code: number | null;
  killedByTimeout: boolean;
  elapsedMs: number;
  stdout: string;
  stderr: string;
  serverPid: number | null;
  serverGotSigterm: boolean;
  serverAliveAfter: boolean;
}

async function runGate(gate: "seo" | "ada", siteMode: string): Promise<GateRun> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bwt-gate-cleanup-${gate}-`));
  const pidFile = path.join(dir, "server.pid");
  const termMarker = path.join(dir, "server.sigterm");
  const port = await freePort();

  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "gate-cleanup-fixture",
      private: true,
      scripts: {
        "gate:seo": `node ${path.join(repoRoot, "bin", "gate-seo.mjs")}`,
        "gate:ada": `node ${path.join(repoRoot, "bin", "gate-ada.mjs")}`,
      },
    }),
  );
  fs.writeFileSync(
    path.join(dir, "gate.config.json"),
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${port}`,
      routes: ROUTES,
      launchCommand: `node ${wrapperPath}`,
      startupTimeoutMs: 20_000,
    }),
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GATE_SITE_MODE: siteMode,
    GATE_SITE_PID_FILE: pidFile,
    GATE_SITE_TERM_MARKER: termMarker,
    // Force gate-ada into html-snapshot mode everywhere, so the result does not
    // depend on whether this machine or runner has Chromium installed.
    PLAYWRIGHT_BROWSERS_PATH: path.join(dir, "no-browsers"),
  };
  delete env.GATE_BASE_URL;

  const started = Date.now();
  let serverPid: number | null = null;
  try {
    const outcome = await new Promise<{ code: number | null; killed: boolean; stdout: string; stderr: string }>(
      (resolve) => {
        // Same shape as blog-writer publisher.js runGate(): execFile("npm", ["run", "gate:seo"]).
        execFile(
          "npm",
          ["run", "--silent", `gate:${gate}`],
          { cwd: dir, env, timeout: EXEC_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 },
          (error, stdout, stderr) => {
            const err = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
            resolve({
              code: err ? (typeof err.code === "number" ? err.code : null) : 0,
              killed: !!err?.killed,
              stdout: String(stdout),
              stderr: String(stderr),
            });
          },
        );
      },
    );
    const elapsedMs = Date.now() - started;

    if (fs.existsSync(pidFile)) serverPid = Number(fs.readFileSync(pidFile, "utf8"));
    let alive = serverPid !== null && pidIsAlive(serverPid);
    for (let i = 0; i < 30 && alive; i++) {
      await delay(100);
      alive = pidIsAlive(serverPid!);
    }

    return {
      code: outcome.code,
      killedByTimeout: outcome.killed,
      elapsedMs,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      serverPid,
      serverGotSigterm: fs.existsSync(termMarker),
      serverAliveAfter: alive,
    };
  } finally {
    // Never leave an orphan behind when an assertion is about to fail.
    if (serverPid && pidIsAlive(serverPid)) {
      try {
        process.kill(serverPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertCleanTermination(run: GateRun, expectedCode: number, label: string): void {
  const output = `\n--- stdout\n${run.stdout}\n--- stderr\n${run.stderr}`;
  assert.equal(
    run.killedByTimeout,
    false,
    `${label}: execFile was killed by its ${EXEC_TIMEOUT_MS}ms timeout, the gate hung its caller${output}`,
  );
  assert.equal(run.code, expectedCode, `${label}: exit code${output}`);
  assert.ok(run.serverPid && run.serverPid > 0, `${label}: the gate really launched the fixture server${output}`);
  assert.equal(run.serverAliveAfter, false, `${label}: launched server outlived the gate${output}`);
  assert.equal(
    run.serverGotSigterm,
    true,
    `${label}: server never received SIGTERM, so the gate's finally/stopServer did not run${output}`,
  );
}

describe("gates stop the server they launched on every exit path (site-monitor#273)", () => {
  it("gate-seo FAIL exits 1, terminates, and stops the server", async () => {
    const run = await runGate("seo", "seo-fail");
    assertCleanTermination(run, 1, "gate-seo FAIL");
    assert.match(run.stderr, /gate:seo {2}FAIL: \d+ failure/);
  });

  it("gate-seo PASS still exits 0 and stops the server", async () => {
    const run = await runGate("seo", "pass");
    assertCleanTermination(run, 0, "gate-seo PASS");
    assert.match(run.stdout, /gate:seo {2}PASS/);
  });

  it("gate-seo whose main() throws exits 1 via the entry-point catch, after the finally", async () => {
    const run = await runGate("seo", "seo-throw");
    assertCleanTermination(run, 1, "gate-seo throw");
    assert.doesNotMatch(run.stdout, /gate:seo {2}PASS/);
  });

  it("gate-ada blocking violation exits 1, terminates, and stops the server", async () => {
    const run = await runGate("ada", "ada-blocking");
    assertCleanTermination(run, 1, "gate-ada blocking");
    assert.match(run.stderr, /gate:ada {2}FAIL: \d+ blocking violation/);
  });

  it("gate-ada unreachable route exits 1, terminates, and stops the server", async () => {
    const run = await runGate("ada", "ada-unreachable");
    assertCleanTermination(run, 1, "gate-ada unreachable");
    assert.match(run.stderr, /failed to load/);
    assert.doesNotMatch(run.stdout, /gate:ada {2}PASS/);
  });

  it("gate-ada PASS still exits 0 and stops the server", async () => {
    const run = await runGate("ada", "pass");
    assertCleanTermination(run, 0, "gate-ada PASS");
    assert.match(run.stdout, /gate:ada {2}PASS/);
  });
});

describe("source supplement: no process.exit inside the server-owning try", () => {
  for (const file of ["gate-seo.ts", "gate-ada.ts"]) {
    it(`${file} main() body exits only via exitCode + return`, () => {
      const code = fs
        .readFileSync(path.join(here, "..", file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      const start = code.indexOf("const stopServer = await ensureBaseUrlReady(config);");
      const end = code.indexOf("await stopServer();", start);
      assert.ok(start > 0 && end > start, `${file}: server-owning try not found; update this test`);
      assert.doesNotMatch(code.slice(start, end), /process\.exit\(/);
    });
  }
});
