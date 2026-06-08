#!/usr/bin/env node
import { runGate } from "./_run.mjs";
runGate({
  binFileUrl: import.meta.url,
  scriptName: "gate-ai-instrumentation-source",
  gateLabel: "gate-ai-instrumentation-source",
});
