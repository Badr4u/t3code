#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Runs scenarios (scripts/scenarios) in the real app. See docs/operations/scenarios.md.
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { proveScenario } from "./scenario-runner/prove.ts";
import {
  REPO_ROOT,
  resolveScenarioPath,
  runScenario,
  scenarioName,
} from "./scenario-runner/run.ts";

const USAGE = `Usage:
  node scripts/scenario.ts run <scenario> [--app-dir <checkout>] [--out <dir>]
  node scripts/scenario.ts prove <scenario> --base <rev> [--head <rev>] [--out <dir>]
                                 [--upload-command "<command>"]

<scenario> is a name in scripts/scenarios or a path to a scenario file.
Both print a JSON result on stdout. Exit codes: 0 passed or proven, 1 not, 2 could not run.`;

const { values, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    "app-dir": { type: "string" },
    out: { type: "string" },
    base: { type: "string" },
    head: { type: "string" },
    "upload-command": { type: "string" },
  },
});
const [command, scenarioArg] = positionals;
if ((command !== "run" && command !== "prove") || scenarioArg === undefined) {
  console.error(USAGE);
  process.exit(2);
}
const scenarioPath = resolveScenarioPath(scenarioArg);
const outDir = NodePath.resolve(
  values.out ?? NodePath.join(REPO_ROOT, "artifacts/scenarios", scenarioName(scenarioPath)),
);

if (command === "run") {
  const result = await runScenario({
    scenarioPath,
    appDir: NodePath.resolve(values["app-dir"] ?? REPO_ROOT),
    outDir,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === "passed" ? 0 : result.status === "failed" ? 1 : 2);
}

if (values.base === undefined) {
  console.error(USAGE);
  process.exit(2);
}
const proof = await proveScenario({
  scenarioPath,
  base: values.base,
  head: values.head ?? "HEAD",
  outDir,
  ...(values["upload-command"] === undefined ? {} : { uploadCommand: values["upload-command"] }),
});
console.log(JSON.stringify(proof, null, 2));
const couldNotRun = proof.base.status === "error" || proof.head.status === "error";
process.exit(proof.failsOnBase && proof.passesOnHead ? 0 : couldNotRun ? 2 : 1);
