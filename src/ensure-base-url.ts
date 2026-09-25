import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { GateConfig } from "./load-config";

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0"]);

function canAutoLaunch(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return LOCAL_HOSTS.has(host);
  } catch {
    return false;
  }
}

async function probe(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(baseUrl, { redirect: "manual" });
    return response.status > 0;
  } catch {
    return false;
  }
}

export async function ensureBaseUrlReady(config: GateConfig): Promise<() => Promise<void>> {
  if (await probe(config.baseUrl)) {
    return async () => {};
  }

  if (!canAutoLaunch(config.baseUrl)) {
    throw new Error(
      `gate baseUrl is unreachable: ${config.baseUrl}. Start the site manually or point baseUrl/GATE_BASE_URL at a reachable host.`,
    );
  }

  if (!config.launchCommand) {
    throw new Error(
      `gate baseUrl is unreachable: ${config.baseUrl}. Add "launchCommand" to gate.config.json so the gate can start the local site automatically.`,
    );
  }

  const parsedBaseUrl = new URL(config.baseUrl);
  // launchCommand comes from this project's own gate.config.json (trusted, committed) and runs at
  // build time. Reject shell metacharacters and run it as an explicit argv array with shell:false
  // so a dynamic string can never reach a shell interpreter (removes the command-injection surface).
  if (/[;&|`$<>(){}"']/.test(config.launchCommand)) {
    throw new Error(
      `launchCommand must be a simple "program arg arg" string without shell metacharacters: ${config.launchCommand}`,
    );
  }
  const [launchProgram, ...launchArgs] = config.launchCommand.trim().split(" ").filter(Boolean);
  if (!launchProgram) {
    throw new Error(`launchCommand is empty after parsing: ${config.launchCommand}`);
  }
  const child = spawn(launchProgram, launchArgs, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOSTNAME: parsedBaseUrl.hostname,
      PORT: parsedBaseUrl.port || (parsedBaseUrl.protocol === "https:" ? "443" : "80"),
    },
    shell: false,
    stdio: "inherit",
    // Own process group (POSIX) so cleanup can kill the whole launch tree, not
    // just the wrapper. Gates run on macOS dev machines and ubuntu CI only.
    detached: true,
  });

  const killProcessGroup = (signal: NodeJS.Signals): boolean => {
    if (typeof child.pid !== "number") {
      return false;
    }
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // ESRCH: every process in the group has already exited.
      return false;
    }
  };

  // Last-resort cleanup for any exit that bypasses the caller's `finally`.
  // process.exit() does not unwind the stack, so a gate that calls it inside
  // `try { ... } finally { await stopServer(); }` never runs stopServer. The
  // detached server then outlives the gate, holds the inherited stdout/stderr
  // pipes open, and any caller waiting on the gate through execFile never
  // gets its callback. Observed 2026-09-24 (site-monitor#273): gate-seo FAILed,
  // exited via process.exit(1), and the book + ADA blog-writer publish runs
  // (participation-effect-site 35974056482, adaauditreport-web 35974055927)
  // hung silently until their 20-minute job timeout. 'exit' listeners must be
  // synchronous, so this sends SIGKILL; the graceful path is cleanup() below.
  const killOnExit = () => {
    killProcessGroup("SIGKILL");
  };
  process.once("exit", killOnExit);

  const cleanup = async () => {
    process.removeListener("exit", killOnExit);
    // Kill the process GROUP, not just the spawned wrapper. launchCommand is
    // usually an npm wrapper whose grandchild (e.g. next-server) survives a
    // direct child.kill, keeps the inherited stdio pipes open, and hangs any
    // caller that waits on this gate via execFile/pipes. Observed 2026-06-09:
    // blog-writer publish workflows hitting their 10-minute job timeout with
    // an orphaned next-server after gate-seo finished.
    if (!killProcessGroup("SIGTERM")) {
      return;
    }
    await delay(500);
    killProcessGroup("SIGKILL");
  };

  const timeoutMs = config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await probe(config.baseUrl)) {
      return cleanup;
    }

    if (child.exitCode !== null) {
      throw new Error(
        `launchCommand exited before ${config.baseUrl} became ready (exit ${child.exitCode}).`,
      );
    }

    await delay(POLL_INTERVAL_MS);
  }

  await cleanup();
  throw new Error(
    `launchCommand did not make ${config.baseUrl} reachable within ${timeoutMs}ms.`,
  );
}
