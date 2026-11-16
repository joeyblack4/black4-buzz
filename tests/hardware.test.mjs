// Black 4 hardware (the hosted agent type in plugins/black4) against a door
// double, then the real door transport against fake MCP and door servers:
// no machine, no network.
import test from "node:test";
import assert from "node:assert/strict";
import {
  askMachine, hardwareProvider, hardwareDefaults, MACHINES, machineOf, statusReader, harnessOptions, signInState, readyToCreate,
  createLogin, agentDirectory, summaryOf, signInOf, doorTransport, bodySha256, createSession, createMcp, readAnswer, memoryStore,
} from "../plugins/black4/plugin.js";
import { fakeAuthKit, fakeMcp, fakeDoor, https, sha256url, DOOR } from "./fakes.mjs";

/** A door double, in the shape of \`doorTransport\`'s \`ask\`: records each
 * request and answers with \`reply(request)\`. \`undefined\` means the door
 * cannot be reached; a promise is a slow machine. */
function machine(reply) {
  const seen = [];
  const ask = async (target, request) => {
    seen.push({ id: target.id, request: JSON.parse(JSON.stringify(request)) });
    const answer = await reply(request);
    if (answer === undefined) throw new Error(`Could not reach the ${target.label}: its door did not answer (operation timed out).`);
    return answer;
  };
  return { ask, seen, ops: () => seen.map((entry) => entry.request.op) };
}

const PUBKEY = "a".repeat(64);
const AUTH = ["auth", "b".repeat(64), "", "c".repeat(128)];
const UNKNOWN = { ok: false, error: "unknown op" };
const CODE = "fictional-code-7Q2X";
const harnesses = (claude = {}) => [
  { id: "claude", label: "Claude Code", installed: true, signedIn: false, account: null, ...claude },
  { id: "codex", label: "Codex", installed: true, signedIn: true, account: "ops@example.com" },
  { id: "grok", label: "Grok Build", installed: false, signedIn: null, account: null },
  { id: "goose", label: "Goose", installed: true, signedIn: null, account: null },
];

test("ask returns the machine's reply and names the machine's own error", async () => {
  const ok = machine(() => ({ ok: true, agents: [] }));
  assert.deepEqual(await askMachine(ok.ask, "commerce", { op: "list" }), { ok: true, agents: [] });
  assert.equal(ok.seen[0].id, "commerce");
  const refused = machine(() => ({ ok: false, error: "no such agent on this machine" }));
  await assert.rejects(askMachine(refused.ask, "commerce", { op: "status", pubkey: PUBKEY }), /no such agent/);
});

test("ask says so when the machine cannot be reached or is too slow", async () => {
  const down = machine(() => undefined);
  await assert.rejects(askMachine(down.ask, "commerce", { op: "list" }), /Could not reach the Commerce Mac: its door did not answer/);
  await assert.rejects(askMachine(undefined, "commerce", { op: "list" }), /Could not reach the Commerce Mac: sign in to Black 4 first/);
  const slow = machine(() => new Promise(() => {}));
  await assert.rejects(askMachine(slow.ask, "commerce", { op: "machine.status" }, { timeoutMs: 20 }), /did not answer in time/);
});

test("machines: a config or id names one, and anything else is the default", () => {
  assert.equal(machineOf("commerce").label, "Commerce Mac");
  assert.equal(machineOf({ machine: "commerce" }).id, "commerce");
  assert.equal(machineOf({ harness: "claude" }).id, "commerce", "a config from before machines");
  assert.equal(machineOf(undefined).id, "commerce");
  assert.equal(machineOf("gone").id, "commerce");
  assert.equal(hardwareDefaults().machine, "commerce");
  for (const entry of MACHINES) assert.match(entry.door, /^https:\/\/[a-z0-9.-]+$/);
});

test("a retried creation asks for the same agent, and activation carries the attestation", async () => {
  const box = machine((request) => (request.op === "provision" ? { ok: true, pubkey: PUBKEY } : { ok: true }));
  let ids = 0;
  const remote = hardwareProvider(box.ask, () => `request-${++ids}`);
  const input = { name: "Paid Media", community: "wss://example.communities.buzz.xyz", config: { harness: "codex" } };
  assert.deepEqual(await remote.provision(input), { pubkey: PUBKEY });
  await remote.provision(input);
  assert.equal(box.seen[0].request.requestId, "request-1");
  assert.equal(box.seen[1].request.requestId, "request-1");
  assert.deepEqual(box.seen[0].request.config, { ...hardwareDefaults(), harness: "codex", machine: "commerce" });

  await remote.activate({ pubkey: PUBKEY, name: "Paid Media", community: input.community, auth: AUTH });
  assert.deepEqual(box.seen[2].request, { op: "activate", pubkey: PUBKEY, community: input.community, auth: AUTH });
  await remote.provision(input);
  assert.equal(box.seen[3].request.requestId, "request-2");
});

test("every step goes to the agent's machine, and a legacy agent goes to commerce", async () => {
  const box = machine((request) => (request.op === "instructions.get" ? { ok: true, instructions: "Be brief." } : { ok: true }));
  const remote = hardwareProvider(box.ask);
  // Never seen by this copy (made before machines were a choice): the default.
  await remote.profile({ pubkey: PUBKEY, community: "wss://x", name: "Rock" });
  assert.equal(await remote.instructions.get({ pubkey: PUBKEY, community: "wss://x" }), "Be brief.");
  await remote.instructions.set({ pubkey: PUBKEY, community: "wss://x", instructions: "Be kind." });
  await remote.remove({ pubkey: PUBKEY, community: "wss://x" });
  assert.deepEqual(box.ops(), ["profile", "instructions.get", "instructions.set", "remove"]);
  assert.ok(box.seen.every((entry) => entry.id === "commerce"));
  assert.deepEqual(box.seen[0].request, { op: "profile", pubkey: PUBKEY, name: "Rock", picture: null });
});

test("with a second machine, creation follows the config and later steps find the agent", async () => {
  const extra = { id: "lab", label: "Lab Mac", door: "https://lab.example.test" };
  MACHINES.push(extra);
  try {
    const OTHER = "d".repeat(64);
    const box = machine((request) => {
      if (request.op === "provision") return { ok: true, pubkey: PUBKEY };
      if (request.op === "list") return { ok: true, agents: [] };
      return { ok: true };
    });
    const listing = machine((request) => (request.op === "list"
      ? { ok: true, agents: [{ pubkey: OTHER, harness: "goose", respondTo: "anyone" }] } : { ok: true }));
    const ask = (target, request) => (target.id === "lab" ? listing.ask(target, request) : box.ask(target, request));
    const directory = agentDirectory(ask);
    const remote = hardwareProvider(ask, () => "r", directory);
    await remote.provision({ name: "A", community: "wss://x", config: { machine: "commerce" } });
    await remote.remove({ pubkey: PUBKEY, community: "wss://x" });
    assert.deepEqual(box.ops(), ["provision", "remove"], "known agent: no search");
    await remote.remove({ pubkey: OTHER, community: "wss://x" });
    assert.deepEqual(listing.seen.map((entry) => entry.request), [{ op: "list" }, { op: "remove", pubkey: OTHER }]);
    assert.equal(summaryOf({ pubkey: OTHER }, directory), "Goose · Lab Mac");
  } finally {
    MACHINES.splice(MACHINES.indexOf(extra), 1);
  }
});

test("summary reads like 'Claude Code · Commerce Mac', from what it knows", () => {
  const directory = { peek: (pubkey) => (pubkey === PUBKEY ? { machine: "commerce", harness: "claude" } : undefined) };
  assert.equal(summaryOf({ pubkey: PUBKEY, config: undefined }, directory), "Claude Code · Commerce Mac");
  assert.equal(summaryOf({ pubkey: "e".repeat(64), config: { harness: "codex" } }, directory), "Codex · Commerce Mac");
  assert.equal(summaryOf({ pubkey: "e".repeat(64) }, directory), "Commerce Mac");
});

test("status is read once, shared, cached briefly and turned into a kind", async () => {
  let clock = 0;
  const box = machine(() => ({ ok: true, machine: "commerce", harnesses: harnesses() }));
  const reader = statusReader(box.ask, { now: () => clock, ttlMs: 1000 });
  assert.equal(reader.peek("commerce"), undefined);
  const [a, b] = await Promise.all([reader.read("commerce"), reader.read({ machine: "commerce" })]);
  assert.equal(a, b);
  assert.equal(a.kind, "ok");
  assert.equal(box.seen.length, 1, "two readers, one request");
  await reader.read("commerce");
  assert.equal(box.seen.length, 1, "cached");
  clock = 1500;
  assert.equal(reader.peek("commerce"), undefined);
  await reader.read("commerce");
  assert.equal(box.seen.length, 2, "stale after the cache time");
  await reader.read("commerce", { force: true });
  assert.equal(box.seen.length, 3);
  assert.deepEqual(box.seen[0].request, { op: "machine.status" });

  assert.deepEqual(await statusReader(machine(() => UNKNOWN).ask).read("commerce"), { kind: "unsupported" });
  const down = await statusReader(machine(() => undefined).ask).read("commerce");
  assert.equal(down.kind, "unreachable");
  assert.match(down.error, /Could not reach the Commerce Mac/);
});

test("harness choices follow what the machine has installed", () => {
  const ok = { kind: "ok", harnesses: harnesses() };
  assert.deepEqual(harnessOptions(ok).map((entry) => entry.id), ["claude", "codex", "goose"]);
  assert.deepEqual(harnessOptions(undefined).map((entry) => entry.id), ["claude", "codex", "grok", "goose"], "loading");
  assert.equal(harnessOptions({ kind: "unsupported" }).length, 4);
  assert.equal(harnessOptions({ kind: "unreachable", error: "x" }).length, 4);
  assert.deepEqual(harnessOptions({ kind: "ok", harnesses: [] }), []);
});

test("readiness for each sign-in state", () => {
  const ok = { kind: "ok", harnesses: harnesses() };
  const cases = [
    [undefined, "claude", "loading", false],
    [{ kind: "unreachable", error: "down" }, "claude", "unreachable", false],
    [{ kind: "unsupported" }, "claude", "unsupported", true],
    [ok, "claude", "signed-out", false],
    [ok, "codex", "signed-in", true],
    [ok, "goose", "unavailable", false], // an older runner: only Claude Code signs in from Buzz
    [ok, "grok", "not-installed", false],
  ];
  for (const [status, harness, kind, isReady] of cases) {
    const state = signInState(status, harness);
    assert.equal(state.kind, kind, `${harness} ${kind}`);
    assert.equal(readyToCreate(state), isReady, `${harness} ${kind} ready`);
  }
  assert.equal(signInState(ok, "codex").account, "ops@example.com");
  assert.equal(signInState({ kind: "ok", harnesses: harnesses({ signedIn: true, account: null }) }, "claude").account, null);
});

// What a runner with Codex and Grok sign-in reports (machine/agentctl machine.status).
const deviceRows = ({ codex = false, grok = false } = {}) => [
  { id: "claude", label: "Claude Code", installed: true, signedIn: true, account: null, signIn: "code" },
  { id: "codex", label: "Codex", installed: true, signedIn: codex, account: codex ? "owner@example.com" : null, signIn: "device" },
  { id: "grok", label: "Grok Build", installed: true, signedIn: grok, account: null, signIn: "device" },
  { id: "goose", label: "Goose", installed: true, signedIn: null, account: null, signIn: null,
    note: "Goose takes its model settings from the machine itself; Buzz cannot sign it in." },
];

test("Codex and Grok sign in from Buzz; an installed harness Buzz cannot sign in is shown unavailable", () => {
  const ok = { kind: "ok", harnesses: deviceRows() };
  const options = harnessOptions(ok);
  assert.deepEqual(options.map((entry) => entry.id), ["claude", "codex", "grok", "goose"]);
  assert.equal(options.find((entry) => entry.id === "goose").label, "Goose (unavailable)");
  assert.match(options.find((entry) => entry.id === "goose").unavailable, /cannot sign it in/);
  assert.ok(!options.find((entry) => entry.id === "codex").unavailable);
  for (const harness of ["codex", "grok"]) {
    assert.equal(signInState(ok, harness).kind, "signed-out");
    assert.equal(readyToCreate(signInState(ok, harness)), false);
  }
  assert.deepEqual(signInState({ kind: "ok", harnesses: deviceRows({ codex: true }) }, "codex"), { kind: "signed-in", account: "owner@example.com" });
  const goose = signInState(ok, "goose");
  assert.equal(goose.kind, "unavailable");
  assert.equal(readyToCreate(goose), false);
  assert.deepEqual(signInOf({ id: "codex", installed: true, signedIn: null }), { flow: null, reason: "This machine's runner cannot sign in Codex from Buzz yet." });
  assert.deepEqual(signInOf({ id: "claude", installed: true, signedIn: false }), { flow: "code", reason: null });
  assert.equal(harnessOptions({ kind: "ok", harnesses: [{ id: "grok", installed: false, signIn: "device" }] }).length, 0, "not installed: not offered");
});

test("a harness the machine's self-test says it cannot run is unavailable, even when signed in", () => {
  const rows = deviceRows({ codex: true });
  rows[1].problem = "its ACP SDK is 2.0.1, pinned 1.9.0";
  const ok = { kind: "ok", harnesses: rows };
  const codex = harnessOptions(ok).find((entry) => entry.id === "codex");
  assert.equal(codex.label, "Codex (unavailable)");
  assert.equal(codex.unavailable, "This machine cannot run it right now: its ACP SDK is 2.0.1, pinned 1.9.0.");
  assert.deepEqual(signInState(ok, "codex"), { kind: "unavailable", reason: codex.unavailable });
  assert.equal(readyToCreate(signInState(ok, "codex")), false);
  assert.ok(!harnessOptions(ok).find((entry) => entry.id === "claude").unavailable, "the others are unaffected");
});

test("sign-in: a device sign-in shows the link and code, then waits by itself until approved", async () => {
  let finishes = 0;
  const box = machine((request) => {
    if (request.op === "login.start") return { ok: true, loginId: "D1", url: "https://auth.openai.com/codex/device", needsCode: false, userCode: "ABCD-12EFG", expiresAt: 1 };
    if (request.op === "login.finish") return ++finishes < 3 ? { ok: true, signedIn: false, pending: true } : { ok: true, signedIn: true, account: "owner@example.com" };
    if (request.op === "machine.status") return { ok: true, harnesses: deviceRows({ codex: finishes >= 3 }) };
    return { ok: true };
  });
  const reader = statusReader(box.ask);
  const states = [];
  const login = createLogin(box.ask, "commerce", "codex", {
    onChange: (state) => states.push(state),
    onSignedIn: () => reader.read("commerce", { force: true }),
  });
  await login.start();
  assert.deepEqual(states.find((state) => state.step === "waiting"),
    { step: "waiting", url: "https://auth.openai.com/codex/device", needsCode: false, userCode: "ABCD-12EFG" });
  assert.deepEqual(box.seen[0].request, { op: "login.start", harness: "codex", flows: ["code", "device"] });
  for (let i = 0; i < 50 && login.state.step !== "idle"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(login.state, { step: "idle" });
  assert.deepEqual(box.ops(), ["login.start", "login.finish", "login.finish", "login.finish", "machine.status"]);
  assert.ok(box.seen.filter((entry) => entry.request.op === "login.finish").every((entry) => entry.request.loginId === "D1" && !("code" in entry.request)));
  assert.deepEqual(signInState(reader.peek("commerce"), "codex"), { kind: "signed-in", account: "owner@example.com" });
  await login.finish("pasted"); // nothing to paste in a device sign-in
  assert.equal(box.seen.length, 5);
});

test("sign-in: a status refresh that fails after a device approval still leaves the form idle", async () => {
  const box = machine((request) => {
    if (request.op === "login.start") return { ok: true, loginId: "D4", url: "https://auth.openai.com/codex/device", needsCode: false, userCode: "ABCD-12EFG" };
    if (request.op === "login.finish") return { ok: true, signedIn: true, account: null };
    return { ok: true };
  });
  const login = createLogin(box.ask, "commerce", "codex", { onSignedIn: () => Promise.reject(new Error("unreachable")) });
  await login.start();
  for (let i = 0; i < 50 && login.state.step !== "idle"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(login.state, { step: "idle" });
});

test("sign-in: Cancel stops waiting for a device approval and cancels it on the machine", async () => {
  let release;
  const box = machine((request) => {
    if (request.op === "login.start") return { ok: true, loginId: "D2", url: "https://accounts.x.ai/oauth2/device?user_code=QRST-UVWX", needsCode: false, userCode: "QRST-UVWX" };
    if (request.op === "login.finish") return new Promise((resolve) => { release = () => resolve({ ok: false, error: "This sign-in has expired or was cancelled. Start the sign-in again." }); });
    return { ok: true };
  });
  const login = createLogin(box.ask, "commerce", "grok");
  await login.start();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await login.cancel();
  release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(login.state, { step: "idle" }, "the cancelled wait's answer does not show an error");
  assert.deepEqual(box.ops(), ["login.start", "login.finish", "login.cancel"]);
});

test("sign-in: a refused or expired device approval is a plain error and the sign-in can start again", async () => {
  const box = machine((request) => {
    if (request.op === "login.start") return { ok: true, loginId: "D3", url: "https://auth.openai.com/codex/device", needsCode: false, userCode: "WXYZ-9876" };
    if (request.op === "login.finish") return { ok: false, error: "The sign-in was not approved. Start the sign-in again." };
    return { ok: true };
  });
  const login = createLogin(box.ask, "commerce", "codex");
  await login.start();
  for (let i = 0; i < 50 && login.state.step !== "idle"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(login.state, { step: "idle", error: "The sign-in was not approved. Start the sign-in again." });
  assert.deepEqual(box.ops(), ["login.start", "login.finish"], "no automatic new sign-in for a device flow");
});

test("sign-in: an older runner answers a Codex sign-in with a plain sentence", async () => {
  const box = machine(() => ({ ok: false, error: "Signing in from Buzz is only available for Claude Code on this machine." }));
  const login = createLogin(box.ask, "commerce", "codex");
  await login.start();
  assert.deepEqual(login.state, { step: "idle", error: "Signing in from Buzz is only available for Claude Code on this machine." });
});

/** Collects everything written to the console while `run` runs. */
async function console_(run) {
  const said = [];
  const saved = {};
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    saved[method] = console[method];
    console[method] = (...args) => said.push(args.map(String).join(" "));
  }
  try { await run(); } finally { Object.assign(console, saved); }
  return said;
}

test("sign-in: a wrong code shows the error and a new link, and the right code on the new login finishes", async () => {
  let signedIn = false;
  let starts = 0;
  const open = new Set();
  const box = machine((request) => {
    if (request.op === "login.start") {
      open.clear(); // a new start cancels any earlier one
      const loginId = `L${++starts}`;
      open.add(loginId);
      return { ok: true, loginId, url: `https://example.com/oauth?n=${starts}`, needsCode: true };
    }
    if (request.op === "login.finish") {
      if (!open.has(request.loginId)) return { ok: false, error: "That sign-in has ended. Start again." };
      open.delete(request.loginId); // any finish closes it
      if (request.code !== CODE) return { ok: false, error: "That code was not accepted." };
      signedIn = true;
      return { ok: true, signedIn: true, account: null };
    }
    if (request.op === "machine.status") return { ok: true, harnesses: harnesses({ signedIn }) };
    return { ok: true };
  });
  const reader = statusReader(box.ask);
  const states = [];
  const said = await console_(async () => {
    const login = createLogin(box.ask, "commerce", "claude", {
      onChange: (state) => states.push(state),
      onSignedIn: () => reader.read("commerce", { force: true }),
    });
    const first = login.start();
    const second = login.start();
    assert.equal(first, second, "a second click joins the first");
    await first;
    assert.deepEqual(login.state, { step: "waiting", url: "https://example.com/oauth?n=1", needsCode: true });

    await login.finish("wrong-code-000");
    assert.deepEqual(login.state, {
      step: "waiting", url: "https://example.com/oauth?n=2", needsCode: true, renewed: true,
      error: "That code was not accepted. Open the new link and paste its code.",
    });
    assert.ok(states.some((state) => state.step === "renewing" && state.error === "That code was not accepted."));

    await login.finish(`  ${CODE}\n`);
    assert.deepEqual(login.state, { step: "idle" });
  });
  assert.deepEqual(box.ops(), ["login.start", "login.finish", "login.start", "login.finish", "machine.status"]);
  const finishes = box.seen.filter((entry) => entry.request.op === "login.finish").map((entry) => entry.request);
  assert.deepEqual(finishes.map((request) => request.loginId), ["L1", "L2"], "the stale login is never finished again");
  assert.equal(finishes[1].code, CODE, "the pasted code is trimmed and sent");
  assert.deepEqual(signInState(reader.peek("commerce"), "claude"), { kind: "signed-in", account: null });
  assert.ok(states.some((state) => state.step === "done"));
  assert.ok(!JSON.stringify(states).includes(CODE), "the code is never kept in state");
  assert.ok(!said.join("\n").includes(CODE), "the code is never logged");
});

test("sign-in: one automatic restart per failed finish, and a failed restart offers Sign in", async () => {
  let starts = 0;
  const box = machine((request) => {
    if (request.op === "login.start") return ++starts === 1
      ? { ok: true, loginId: "L1", url: "https://example.com/a", needsCode: true }
      : { ok: false, error: "The machine is busy." };
    if (request.op === "login.finish") return { ok: false, error: "That code was not accepted." };
    return { ok: true };
  });
  const login = createLogin(box.ask, "commerce", "claude");
  await login.start();
  await login.finish("wrong-code-000");
  assert.deepEqual(login.state, { step: "idle", error: "That code was not accepted. The machine is busy." });
  assert.deepEqual(box.ops(), ["login.start", "login.finish", "login.start"], "no loop");
  await login.finish("again");
  assert.equal(box.seen.length, 3, "nothing to finish after a failed restart");
  await login.dispose();
  assert.equal(box.seen.length, 3, "no login left to cancel");
});

test("sign-in: closing the dialog after a restart cancels the new login, not the dead one", async () => {
  let starts = 0;
  const box = machine((request) => {
    if (request.op === "login.start") return { ok: true, loginId: `L${++starts}`, url: `https://example.com/${starts}`, needsCode: true };
    if (request.op === "login.finish") return { ok: false, error: "That code was not accepted." };
    return { ok: true };
  });
  const login = createLogin(box.ask, "commerce", "claude");
  await login.start();
  await login.finish("wrong-code-000");
  await login.dispose();
  assert.deepEqual(box.seen.at(-1).request, { op: "login.cancel", loginId: "L2" });
});

test("sign-in: an empty code is not sent", async () => {
  const box = machine(() => ({ ok: true, loginId: "L1", url: "https://example.com/a", needsCode: true }));
  const login = createLogin(box.ask, "commerce", "claude");
  await login.start();
  await login.finish("   ");
  assert.equal(login.state.error, "Paste the code first.");
  assert.deepEqual(box.ops(), ["login.start"]);
});

test("sign-in: Cancel cancels on the machine, also when it lands mid-start", async () => {
  const box = machine((request) => (request.op === "login.start"
    ? { ok: true, loginId: "L1", url: "https://example.com/a", needsCode: true } : { ok: true }));
  const login = createLogin(box.ask, "commerce", "claude");
  await login.start();
  await login.cancel();
  assert.deepEqual(login.state, { step: "idle" });
  assert.deepEqual(box.seen.at(-1).request, { op: "login.cancel", loginId: "L1" });

  let answer;
  const slow = machine((request) => (request.op === "login.start"
    ? new Promise((resolve) => { answer = () => resolve({ ok: true, loginId: "L2", url: "https://example.com/b", needsCode: true }); })
    : { ok: true }));
  const late = createLogin(slow.ask, "commerce", "claude");
  const started = late.start();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(late.state.step, "starting");
  await late.cancel();
  answer();
  await started;
  assert.deepEqual(late.state, { step: "idle" }, "a reply after Cancel does not reopen it");
  assert.deepEqual(slow.ops(), ["login.start", "login.cancel"]);
  assert.equal(slow.seen[1].request.loginId, "L2");
});

test("sign-in: closing the dialog mid-sign-in cancels it", async () => {
  const box = machine((request) => (request.op === "login.start"
    ? { ok: true, loginId: "L3", url: "https://example.com/c", needsCode: true } : { ok: true }));
  const login = createLogin(box.ask, "commerce", "claude");
  await login.start();
  await login.dispose();
  assert.deepEqual(box.ops(), ["login.start", "login.cancel"]);
  const idle = createLogin(box.ask, "commerce", "claude");
  await idle.dispose();
  assert.equal(box.seen.length, 2, "nothing to cancel, nothing sent");
});

test("sign-in: an unreachable machine or a missing link is a plain error", async () => {
  const down = createLogin(machine(() => undefined).ask, "commerce", "claude");
  await down.start();
  assert.equal(down.state.step, "idle");
  assert.match(down.state.error, /Could not reach the Commerce Mac/);
  const old = createLogin(machine(() => UNKNOWN).ask, "commerce", "claude");
  await old.start();
  assert.equal(old.state.error, "unknown op");
  const linkless = machine((request) => (request.op === "login.start" ? { ok: true, loginId: "L4", url: "javascript:alert(1)" } : { ok: true }));
  const bad = createLogin(linkless.ask, "commerce", "claude");
  await bad.start();
  assert.equal(bad.state.error, "The machine did not return a sign-in link.");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(linkless.ops(), ["login.start", "login.cancel"]);
});

test("the hardware part never logs (a pasted sign-in code must not reach a log)", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../plugins/black4/plugin.js", import.meta.url), "utf8");
  const part = source.slice(source.indexOf("// ---- Black 4 hardware ----"));
  assert.ok(part.length > 10000, "the hardware part is fenced");
  assert.doesNotMatch(part, /console\./);
});

// ---- the door: one pass per request, bound to the exact body -------------------

/** The real transport over fake AuthKit, MCP and door; \`signedIn: false\`
 * has no sign-in to mint passes with. */
async function door({ agentctl = () => ({ ok: true }), signedIn = true, offline = new Set(), sign } = {}) {
  const authkit = fakeAuthKit();
  const mcp = fakeMcp(authkit);
  const box = fakeDoor(mcp, agentctl);
  const net = https({ authkit, mcp, door: box, offline });
  const store = memoryStore();
  const session = createSession({ request: net.request, store });
  if (signedIn) { await store.save(authkit.issue().refresh_token); await session.restore(); }
  const client = createMcp({ request: net.request, session });
  const minted = [];
  const realSign = async (input) => {
    const answer = readAnswer(await client.request("tools/call", { name: "sign_hardware_request", arguments: input }));
    minted.push(answer.pass);
    return answer;
  };
  const ask = doorTransport({ request: net.request, sign: sign ? sign(realSign) : realSign });
  return { ask, mcp, box, net, minted };
}

test("door: every request gets its own pass, bound to the hash of its exact body", async () => {
  const d = await door({ agentctl: (request) => ({ ok: true, echo: request.instructions ?? null }) });
  const instructions = "Café ☕ — 日本語 and \"quotes\"\n";
  const reply = await askMachine(d.ask, "commerce", { op: "instructions.set", pubkey: PUBKEY, instructions });
  assert.equal(reply.echo, instructions, "non-ASCII arrives intact");
  await askMachine(d.ask, "commerce", { op: "list" });
  assert.equal(d.minted.length, 2);
  assert.notEqual(d.minted[0], d.minted[1], "a new pass for each request");
  const body = JSON.stringify({ op: "instructions.set", pubkey: PUBKEY, instructions });
  assert.deepEqual(d.mcp.signed[0], { machine: "commerce", op: "instructions.set", bodySha256: sha256url(body) });
  assert.equal(await bodySha256(body), sha256url(body), "base64url SHA-256 of the UTF-8 bytes, no padding");
  assert.doesNotMatch(await bodySha256(body), /[=+/]/);
  assert.deepEqual(d.box.seen.map((request) => request.op), ["instructions.set", "list"]);
  const posted = d.net.requests.filter((entry) => entry.origin === DOOR);
  assert.ok(posted.every((entry) => /^Black4-Hardware pass-/.test(entry.headers.authorization) && entry.headers["content-type"] === "application/json"));
});

test("door: a reused pass is refused, and the error says the door refused it", async () => {
  let first;
  const d = await door({ sign: (real) => async (input) => (first ??= await real(input)) });
  await askMachine(d.ask, "commerce", { op: "list" });
  await assert.rejects(askMachine(d.ask, "commerce", { op: "list" }), /^Error: Could not reach the Commerce Mac: its door refused the pass \(pass already used\)\.$/);
});

test("door: a pass for another body is refused", async () => {
  const d = await door({ sign: (real) => (input) => real({ ...input, bodySha256: sha256url("{}") }) });
  await assert.rejects(askMachine(d.ask, "commerce", { op: "list" }), /its door refused the pass \(pass does not match this request\)/);
  assert.equal(d.box.seen.length, 0);
});

test("door: a failed sign-in and an unreachable door say which one failed", async () => {
  const signedOut = await door({ signedIn: false });
  await assert.rejects(askMachine(signedOut.ask, "commerce", { op: "list" }), /^Error: Could not reach the Commerce Mac: your Black 4 sign-in could not get a pass \(Sign in to Black 4 first\.\)\.$/);
  assert.equal(signedOut.net.requests.filter((entry) => entry.origin === DOOR).length, 0, "nothing sent to the door without a pass");
  const down = await door({ offline: new Set([DOOR]) });
  await assert.rejects(askMachine(down.ask, "commerce", { op: "list" }), /^Error: Could not reach the Commerce Mac: its door did not answer \(error sending request: connection refused\)\.$/);
});

test("door: agentctl's own refusal comes through as its sentence", async () => {
  const d = await door({ agentctl: () => ({ ok: false, error: "no such agent on this machine" }) });
  await assert.rejects(askMachine(d.ask, "commerce", { op: "status", pubkey: PUBKEY }), /^Error: no such agent on this machine$/);
});

test("door: a door that is overloaded or broken says so with its own words", async () => {
  const d = await door();
  d.box.handle = async () => ({ status: 503, headers: {}, body: JSON.stringify({ error: "too many requests in flight" }) });
  await assert.rejects(askMachine(d.ask, "commerce", { op: "list" }), /^Error: Could not reach the Commerce Mac: its door answered HTTP 503 \(too many requests in flight\)\.$/);
});
