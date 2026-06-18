#!/usr/bin/env node
import { runGate } from "./_run.mjs";
runGate({
  binFileUrl: import.meta.url,
  scriptName: "gate-conversion-instrumentation-source",
  gateLabel: "gate-conversion-instrumentation-source",
});
