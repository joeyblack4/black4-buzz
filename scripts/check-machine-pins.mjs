// machine/setup.sh installs ACP adapters that must speak the protocol of the
// vendored buzz-acp harness. machine/pins.json declares that pairing as one
// set; this fails when setup.sh (its variables or its comments) or the
// machine tests disagree with it, so nobody bumps one pin without the others.
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const pins = JSON.parse(read("machine/pins.json"));
const setup = read("machine/setup.sh");
const tests = read("machine/tests/test_agentctl.py");
const vars = Object.fromEntries([...setup.matchAll(/^([A-Z_]+)=(\S+)/gm)].map(([, name, value]) => [name, value]));
const problems = [];
const version = (text) => text.split(".").map(Number);
const atMost = (a, b) => {
  const [x, y] = [version(a), version(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  }
  return true;
};

const declared = new Set();
for (const [name, adapter] of Object.entries(pins.adapters)) {
  for (const [field, variable] of [["version", adapter.versionVar], ["sdk", adapter.sdkVar]]) {
    declared.add(variable);
    if (vars[variable] !== adapter[field]) {
      problems.push(`machine/setup.sh sets ${variable}=${vars[variable] ?? "(missing)"}, but machine/pins.json pins ${name} ${field} ${adapter[field]}.`);
    }
  }
  if (!atMost(adapter.sdk, pins.harness.maxAdapterSdk)) {
    problems.push(`machine/pins.json pins ${name} on SDK ${adapter.sdk}, newer than ${pins.harness.maxAdapterSdk}, the newest that buzz-acp ${pins.harness.release} can talk to.`);
  }
  if (!setup.includes(`"${name}": { "@agentclientprotocol/sdk": "$${adapter.sdkVar}" }`)) {
    problems.push(`machine/setup.sh no longer forces ${name}'s SDK to $${adapter.sdkVar} with npm overrides.`);
  }
}
for (const variable of Object.keys(vars)) {
  if (/_ACP_/.test(variable) && !declared.has(variable)) problems.push(`machine/setup.sh has ${variable}, which machine/pins.json does not declare.`);
}
for (const [, release] of setup.matchAll(/Buzz (\d+\.\d+\.\d+)/g)) {
  if (release !== pins.harness.release) problems.push(`machine/setup.sh says the harness is Buzz ${release}, but machine/pins.json pins buzz-acp ${pins.harness.release}.`);
}
for (const [, dir] of setup.matchAll(/(vendor\/buzz-[\d.]+)/g)) {
  if (dir !== pins.harness.vendorDir) problems.push(`machine/setup.sh names ${dir}, but machine/pins.json says the harness lives in ${pins.harness.vendorDir}.`);
}
for (const [, variable, value] of tests.matchAll(/self\.pins\["(\w+)"\],\s*"([\d.]+)"/g)) {
  if (vars[variable] !== value) problems.push(`machine/tests/test_agentctl.py expects ${variable}=${value}, but machine/setup.sh sets ${vars[variable] ?? "(missing)"}.`);
}
for (const [, release] of tests.matchAll(/Buzz (\d+\.\d+\.\d+)/g)) {
  if (release !== pins.harness.release) problems.push(`machine/tests/test_agentctl.py says the harness is Buzz ${release}, but machine/pins.json pins ${pins.harness.release}.`);
}

if (problems.length) {
  console.error("The machine's harness and adapter pins are not one consistent set:");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(`Machine pins agree: buzz-acp ${pins.harness.release} with ${Object.entries(pins.adapters).map(([name, adapter]) => `${name.split("/")[1]} ${adapter.version} (SDK ${adapter.sdk})`).join(", ")}.`);
