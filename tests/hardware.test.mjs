// The hardware provider against a process double: no SSH, no machine.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ask, provider, defaults, MACHINES, machineOf, statusReader, harnessOptions, signInState, ready,
  createLogin, agentDirectory, summaryOf,
} from "../plugins/hardware/plugin.js";

/** A spawn double: records each request and answers with `reply(request)`.
 * `undefined` means the machine cannot be reached; a promise is a slow
 * machine; `banner` is printed before the reply, as an SSH login might. */
function machine(reply, { banner = "" } = {}) {
  const seen = [];
  const spawn = async (id, { onStdout, onStderr }) => {
    let input = "";
    let done;
    const exited = new Promise((resolve) => { done = resolve; });
    return {
      write: async (text) => { input += text; },
      end: async () => {
        const request = JSON.parse(input);
        seen.push({ id, request });
        Promise.resolve(reply(request)).then((answer) => {
          if (answer === undefined) onStderr("ssh: connect to host commerce: Operation timed out\n");
          else onStdout(`${banner}${JSON.stringify(answer)}\n`);
          done(0);
        });
      },
      kill: async () => done(1),
      exited,
    };
  };
  return { spawn, seen, ops: () => seen.map((entry) => entry.request.op) };
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
  assert.deepEqual(await ask(ok.spawn, "commerce", { op: "list" }), { ok: true, agents: [] });
  assert.equal(ok.seen[0].id, "commerce");
  const refused = machine(() => ({ ok: false, error: "no such agent on this machine" }));
  await assert.rejects(ask(refused.spawn, "commerce", { op: "status", pubkey: PUBKEY }), /no such agent/);
});

test("ask takes the last line, so an SSH banner before the reply is ignored", async () => {
  const chatty = machine(() => ({ ok: true, running: true }), { banner: "Welcome to the machine\n{not json\n" });
  assert.deepEqual(await ask(chatty.spawn, "commerce", { op: "status" }), { ok: true, running: true });
});

test("ask says so when the machine cannot be reached or is too slow", async () => {
  const down = machine(() => undefined);
  await assert.rejects(ask(down.spawn, "commerce", { op: "list" }), /Could not reach the Commerce Mac: ssh: connect/);
  await assert.rejects(ask(undefined, "commerce", { op: "list" }), /cannot start processes/);
  const slow = machine(() => new Promise(() => {}));
  await assert.rejects(ask(slow.spawn, "commerce", { op: "machine.status" }, { timeoutMs: 20 }), /did not answer in time/);
});

test("machines: a config or id names one, and anything else is the default", () => {
  assert.equal(machineOf("commerce").label, "Commerce Mac");
  assert.equal(machineOf({ machine: "commerce" }).id, "commerce");
  assert.equal(machineOf({ harness: "claude" }).id, "commerce", "a config from before machines");
  assert.equal(machineOf(undefined).id, "commerce");
  assert.equal(machineOf("gone").id, "commerce");
  assert.equal(defaults().machine, "commerce");
  for (const entry of MACHINES) assert.ok(entry.id && entry.label && entry.process);
});

test("a retried creation asks for the same agent, and activation carries the attestation", async () => {
  const box = machine((request) => (request.op === "provision" ? { ok: true, pubkey: PUBKEY } : { ok: true }));
  let ids = 0;
  const remote = provider(box.spawn, () => `request-${++ids}`);
  const input = { name: "Paid Media", community: "wss://example.communities.buzz.xyz", config: { harness: "codex" } };
  assert.deepEqual(await remote.provision(input), { pubkey: PUBKEY });
  await remote.provision(input);
  assert.equal(box.seen[0].request.requestId, "request-1");
  assert.equal(box.seen[1].request.requestId, "request-1");
  assert.deepEqual(box.seen[0].request.config, { ...defaults(), harness: "codex", machine: "commerce" });

  await remote.activate({ pubkey: PUBKEY, name: "Paid Media", community: input.community, auth: AUTH });
  assert.deepEqual(box.seen[2].request, { op: "activate", pubkey: PUBKEY, community: input.community, auth: AUTH });
  await remote.provision(input);
  assert.equal(box.seen[3].request.requestId, "request-2");
});

test("every step goes to the agent's machine, and a legacy agent goes to commerce", async () => {
  const box = machine((request) => (request.op === "instructions.get" ? { ok: true, instructions: "Be brief." } : { ok: true }));
  const remote = provider(box.spawn);
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
  const extra = { id: "lab", label: "Lab Mac", process: "lab" };
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
    const spawn = (id, options) => (id === "lab" ? listing.spawn(id, options) : box.spawn(id, options));
    const directory = agentDirectory(spawn);
    const remote = provider(spawn, () => "r", directory);
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
  const reader = statusReader(box.spawn, { now: () => clock, ttlMs: 1000 });
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

  assert.deepEqual(await statusReader(machine(() => UNKNOWN).spawn).read("commerce"), { kind: "unsupported" });
  const down = await statusReader(machine(() => undefined).spawn).read("commerce");
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
    [ok, "goose", "unknown", true],
    [ok, "grok", "not-installed", false],
  ];
  for (const [status, harness, kind, isReady] of cases) {
    const state = signInState(status, harness);
    assert.equal(state.kind, kind, `${harness} ${kind}`);
    assert.equal(ready(state), isReady, `${harness} ${kind} ready`);
  }
  assert.equal(signInState(ok, "codex").account, "ops@example.com");
  assert.equal(signInState({ kind: "ok", harnesses: harnesses({ signedIn: true, account: null }) }, "claude").account, null);
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

test("sign-in: start, a wrong code keeps the link, the right code finishes and re-reads status", async () => {
  let signedIn = false;
  const box = machine((request) => {
    if (request.op === "login.start") return { ok: true, loginId: "L1", url: "https://example.com/oauth?x=1", needsCode: true };
    if (request.op === "login.finish") {
      if (request.code !== CODE) return { ok: false, error: "That code did not work. Try again." };
      signedIn = true;
      return { ok: true, signedIn: true, account: "ops@example.com" };
    }
    if (request.op === "machine.status") return { ok: true, harnesses: harnesses({ signedIn, account: signedIn ? "ops@example.com" : null }) };
    return { ok: true };
  });
  const reader = statusReader(box.spawn);
  const states = [];
  const said = await console_(async () => {
    const login = createLogin(box.spawn, "commerce", "claude", {
      onChange: (state) => states.push(state),
      onSignedIn: () => reader.read("commerce", { force: true }),
    });
    const first = login.start();
    const second = login.start();
    assert.equal(first, second, "a second click joins the first");
    await first;
    assert.deepEqual(login.state, { step: "waiting", url: "https://example.com/oauth?x=1", needsCode: true });

    await login.finish("wrong-code-000");
    assert.equal(login.state.step, "waiting");
    assert.equal(login.state.url, "https://example.com/oauth?x=1");
    assert.equal(login.state.error, "That code did not work. Try again.");

    await login.finish(`  ${CODE}\n`);
    assert.deepEqual(login.state, { step: "idle" });
  });
  assert.deepEqual(box.ops(), ["login.start", "login.finish", "login.finish", "machine.status"]);
  assert.equal(box.seen[2].request.code, CODE, "the pasted code is trimmed and sent");
  assert.equal(signInState(reader.peek("commerce"), "claude").account, "ops@example.com");
  assert.ok(states.some((state) => state.step === "finishing"));
  assert.ok(states.some((state) => state.step === "done" && state.account === "ops@example.com"));
  assert.ok(!JSON.stringify(states).includes(CODE), "the code is never kept in state");
  assert.ok(!said.join("\n").includes(CODE), "the code is never logged");
});

test("sign-in: an error that echoes the code does not show it", async () => {
  const box = machine((request) => (request.op === "login.start"
    ? { ok: true, loginId: "L1", url: "https://example.com/a", needsCode: true }
    : { ok: false, error: `Rejected code ${CODE}.` }));
  const login = createLogin(box.spawn, "commerce", "claude");
  await login.start();
  await login.finish(CODE);
  assert.equal(login.state.error, "Rejected code ….");
});

test("sign-in: an empty code is not sent", async () => {
  const box = machine(() => ({ ok: true, loginId: "L1", url: "https://example.com/a", needsCode: true }));
  const login = createLogin(box.spawn, "commerce", "claude");
  await login.start();
  await login.finish("   ");
  assert.equal(login.state.error, "Paste the code first.");
  assert.deepEqual(box.ops(), ["login.start"]);
});

test("sign-in: Cancel cancels on the machine, also when it lands mid-start", async () => {
  const box = machine((request) => (request.op === "login.start"
    ? { ok: true, loginId: "L1", url: "https://example.com/a", needsCode: true } : { ok: true }));
  const login = createLogin(box.spawn, "commerce", "claude");
  await login.start();
  await login.cancel();
  assert.deepEqual(login.state, { step: "idle" });
  assert.deepEqual(box.seen.at(-1).request, { op: "login.cancel", loginId: "L1" });

  let answer;
  const slow = machine((request) => (request.op === "login.start"
    ? new Promise((resolve) => { answer = () => resolve({ ok: true, loginId: "L2", url: "https://example.com/b", needsCode: true }); })
    : { ok: true }));
  const late = createLogin(slow.spawn, "commerce", "claude");
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
  const login = createLogin(box.spawn, "commerce", "claude");
  await login.start();
  await login.dispose();
  assert.deepEqual(box.ops(), ["login.start", "login.cancel"]);
  const idle = createLogin(box.spawn, "commerce", "claude");
  await idle.dispose();
  assert.equal(box.seen.length, 2, "nothing to cancel, nothing sent");
});

test("sign-in: an unreachable machine or a missing link is a plain error", async () => {
  const down = createLogin(machine(() => undefined).spawn, "commerce", "claude");
  await down.start();
  assert.equal(down.state.step, "idle");
  assert.match(down.state.error, /Could not reach the Commerce Mac/);
  const old = createLogin(machine(() => UNKNOWN).spawn, "commerce", "claude");
  await old.start();
  assert.equal(old.state.error, "unknown op");
  const linkless = machine((request) => (request.op === "login.start" ? { ok: true, loginId: "L4", url: "javascript:alert(1)" } : { ok: true }));
  const bad = createLogin(linkless.spawn, "commerce", "claude");
  await bad.start();
  assert.equal(bad.state.error, "The machine did not return a sign-in link.");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(linkless.ops(), ["login.start", "login.cancel"]);
});

test("the plugin source never logs", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../plugins/hardware/plugin.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /console\./);
});
