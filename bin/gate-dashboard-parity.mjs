#!/usr/bin/env node
import { runGate } from "./_run.mjs";
runGate({
  binFileUrl: import.meta.url,
  scriptName: "gate-dashboard-parity",
  gateLabel: "gate-dashboard-parity",
});
