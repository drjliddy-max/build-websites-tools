#!/usr/bin/env node
import { runGate } from "./_run.mjs";
runGate({
  binFileUrl: import.meta.url,
  scriptName: "gate-indexability-source",
  gateLabel: "gate-indexability-source",
});
