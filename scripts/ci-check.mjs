#!/usr/bin/env node
// Runs the steps of `npm run check` in groups, so CI can run the slow
// agent-machine tests (about 2.5 minutes) beside everything else instead of
// after it. It reads the steps from package.json each time, so a step added
// to `check` is never left out of CI.
//
//   node scripts/ci-check.mjs --except machine   every step but machine/tests
//   node scripts/ci-check.mjs --only machine     just machine/tests
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { checkSteps, isMachineStep } from "./release/lib.mjs";

const args = process.argv.slice(2);
const group = { machine: isMachineStep };
const [mode, name] = args;
if (!["--except", "--only"].includes(mode) || !group[name]) {
  console.error("usage: ci-check.mjs --except machine | --only machine");
  process.exit(2);
}
const steps = checkSteps(readFileSync("package.json", "utf8")).filter((s) => (mode === "--only") === group[name](s));
if (mode === "--only" && !steps.length) {
  console.error(`No step of npm run check matches "${name}"; update scripts/ci-check.mjs.`);
  process.exit(1);
}
for (const step of steps) {
  const start = Date.now();
  try {
    execSync(step, { stdio: "inherit" });
  } catch {
    console.error(`\nFailed: ${step}`);
    process.exit(1);
  }
  console.log(`ok ${((Date.now() - start) / 1000).toFixed(1)}s  ${step}`);
}
