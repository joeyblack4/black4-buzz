// Black 4 hardware (the hosted agent type in plugins/black4) against a door
// double, then the real door transport against fake MCP and door servers:
// no machine, no network.
import test from "node:test";
import assert from "node:assert/strict";
import {
  askMachine, hardwareProvider, hardwareDefaults, HEARTBEAT_MINUTES, HEARTBEAT_CHOICES, heartbeatChoices, beatFrom, heartbeatRemote, MACHINES, machineOf, statusReader, harnessOptions, signInState, readyToCreate, takesKey, defaultPays, PAYS,
  createLogin, agentDirectory, summaryOf, signInOf, doorTransport, bodySha256, createSession, createMcp, readAnswer, memoryStore,
  modelsReader, modelChoices, applyPick, setModel, applyHardware, COMPACT_OPTIONS, buzzUi, CONVERSATION_ROWS, controlOptions, controlValue,
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

test("the heartbeat interval is a choice from 5 minutes to a day, keeping one set some other way", () => {
  assert.ok(HEARTBEAT_CHOICES.includes(HEARTBEAT_MINUTES));
  assert.ok(HEARTBEAT_CHOICES.every((m) => m >= 5 && m <= 1440), "agentctl takes 5 to 1440 minutes");
  assert.deepEqual(heartbeatChoices(15).map((c) => c.label).slice(0, 5),
    ["every 5 minutes", "every 10 minutes", "every 15 minutes", "every 30 minutes", "every hour"]);
  assert.equal(heartbeatChoices(15).at(-1).label, "every 24 hours");
  const odd = heartbeatChoices(45);
  assert.deepEqual(odd.map((c) => c.value).slice(3, 6), [30, 45, 60]);
  assert.equal(odd.find((c) => c.value === 45).label, "every 45 minutes");
  assert.equal(heartbeatChoices(90).find((c) => c.value === 90).label, "every 90 minutes");
  assert.equal(heartbeatChoices(0).length, HEARTBEAT_CHOICES.length);
});

test("the heartbeat is read and set on the agent's machine, sending only what changed", async () => {
  const box = machine((request) => (request.op === "heartbeat.get"
    ? { ok: true, heartbeat: 0, prompt: "Standard", custom: false, defaultPrompt: "Standard" }
    : { ok: true, heartbeat: request.minutes ?? 15, prompt: request.prompt || "Standard", custom: !!request.prompt, defaultPrompt: "Standard" }));
  const remote = heartbeatRemote(box.ask);
  assert.deepEqual(beatFrom(await remote.get({ pubkey: PUBKEY })), { loading: false, minutes: 0, base: "Standard", draft: "Standard", custom: false, defaultPrompt: "Standard" });
  await remote.set({ pubkey: PUBKEY, minutes: HEARTBEAT_MINUTES });
  const mine = beatFrom(await remote.set({ pubkey: PUBKEY, prompt: "Watch the campaign." }));
  assert.equal(mine.custom, true);
  assert.deepEqual(box.seen.map((entry) => entry.request), [
    { op: "heartbeat.get", pubkey: PUBKEY },
    { op: "heartbeat.set", pubkey: PUBKEY, minutes: 15 },
    { op: "heartbeat.set", pubkey: PUBKEY, prompt: "Watch the campaign." },
  ]);
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

// What agentctl's `models` answers (shape of the Commerce Mac's listing).
const MODELS = {
  ok: true,
  harnesses: [
    { id: "claude", label: "Claude Code", checked: true, model: "claude-fable-5-2", effort: "high", models: [
      { id: "claude-fable-5-2", label: "Fable 5.2", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "opus", label: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"] },
    ] },
    { id: "grok", label: "Grok Build", checked: true, model: "grok-4.7", effort: "high", models: [
      { id: "grok-4.7", label: "Grok 4.7", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "grok-4.5", label: "Grok 4.5", efforts: ["low", "medium"] },
    ] },
    { id: "codex", label: "Codex", checked: false, model: "gpt-6-astra", effort: "high", models: [] },
  ],
};
const listed = { kind: "ok", harnesses: MODELS.harnesses };

test("models are read with their own op, once, and an older machine is unsupported", async () => {
  const box = machine(() => MODELS);
  const reader = modelsReader(box.ask);
  const [a, b] = await Promise.all([reader.read("commerce"), reader.read("commerce")]);
  assert.equal(a.kind, "ok");
  assert.equal(a, b);
  assert.deepEqual(box.ops(), ["models"]);
  await reader.read("commerce");
  assert.deepEqual(box.ops(), ["models"], "cached");
  assert.deepEqual(await modelsReader(machine(() => UNKNOWN).ask).read("commerce"), { kind: "unsupported" });
  // What the runner released before `models` really answers it (it takes an
  // op it does not know, carrying no pubkey, for a one-agent op).
  const released = machine(() => ({ ok: false, error: "pubkey must be 64 hex characters" }));
  assert.deepEqual(await modelsReader(released.ask).read("commerce"), { kind: "unsupported" });
});

test("models are asked again soon while the machine is still listing a harness", async () => {
  let clock = 0;
  let checked = false;
  const box = machine(() => ({ ok: true, harnesses: [{ id: "claude", checked, models: [], model: "claude-fable-5-2", effort: "high" }] }));
  const reader = modelsReader(box.ask, { now: () => clock });
  await reader.read("commerce");
  clock += 20 * 1000;
  checked = true;
  await reader.read("commerce");
  assert.equal(box.ops().length, 2, "unchecked: read again after 15 s");
  clock += 60 * 1000;
  await reader.read("commerce");
  assert.equal(box.ops().length, 2, "checked: kept for minutes");
});

test("Model and Effort start at the machine's defaults and follow the chosen model", () => {
  const fresh = modelChoices(listed, "claude", { model: "", effort: "" });
  assert.equal(fresh.model, "claude-fable-5-2");
  assert.equal(fresh.effort, "high");
  assert.deepEqual(fresh.models.map((entry) => entry.label), ["Fable 5.2", "Opus 5.5"]);
  assert.deepEqual(fresh.efforts.map((entry) => entry.label), ["Low", "Medium", "High", "Extra high", "Max"]);
  const older = modelChoices(listed, "grok", { model: "grok-4.5", effort: "" });
  assert.equal(older.effort, "medium", "Grok 4.5 has no high: the highest below it");
  assert.deepEqual(older.efforts.map((entry) => entry.id), ["low", "medium"]);
  assert.equal(modelChoices(listed, "codex", {}), null, "nothing listed yet: no selects, the machine's default applies");
  assert.equal(modelChoices(listed, "goose", {}), null);
  assert.equal(modelChoices({ kind: "unsupported" }, "claude", {}), null, "an older machine: no selects");
  const gone = modelChoices(listed, "claude", { model: "claude-gone-1", effort: "max" });
  assert.deepEqual(gone.models[0], { id: "claude-gone-1", label: "claude-gone-1 (unavailable)", unavailable: true });
  assert.equal(gone.model, "claude-gone-1", "the agent's real setting stays shown");
  const started = modelChoices(listed, "claude", { model: "", effort: "", shown: "opus", shownEffort: "medium" });
  assert.deepEqual([started.model, started.effort], ["opus", "medium"], "no choice: what it was started with, not today's default");
  assert.deepEqual(applyPick(listed, "claude", { model: "", effort: "", shown: "opus", shownEffort: "medium" }, { effort: "max" }),
    { model: "", effort: "max" }, "a pick stores the choice, never what was shown");
  assert.equal(modelChoices(listed, "grok", { model: "grok-4.7", effort: "turbo" }).efforts.at(-1).label, "turbo (unavailable)");
});

test("a pick stores '' for the machine's default, and an effort the new model lacks goes back to its default", () => {
  assert.deepEqual(applyPick(listed, "claude", { model: "", effort: "" }, { model: "opus" }), { model: "opus", effort: "" });
  assert.deepEqual(applyPick(listed, "claude", { model: "opus", effort: "" }, { effort: "max" }), { model: "opus", effort: "max" });
  assert.deepEqual(applyPick(listed, "claude", { model: "opus", effort: "max" }, { model: "claude-fable-5-2" }), { model: "", effort: "max" });
  assert.deepEqual(applyPick(listed, "claude", { model: "", effort: "max" }, { effort: "high" }), { model: "", effort: "" });
  assert.deepEqual(applyPick(listed, "grok", { model: "", effort: "xhigh" }, { model: "grok-4.5" }), { model: "grok-4.5", effort: "" });
  assert.deepEqual(applyPick({ kind: "unsupported" }, "grok", { model: "", effort: "" }, { model: "x" }), { model: "x", effort: "" });
});

test("creation carries the model and effort; a change goes to the agent's machine as settings.set", async () => {
  const box = machine((request) => (request.op === "provision" ? { ok: true, pubkey: PUBKEY } : { ok: true, model: "opus", effort: "max" }));
  const directory = agentDirectory(box.ask);
  const remote = hardwareProvider(box.ask, () => "request-1", directory);
  await remote.provision({ name: "Picked", community: "wss://example.communities.buzz.xyz", config: { harness: "claude", model: "opus", effort: "max" } });
  assert.deepEqual([box.seen[0].request.config.model, box.seen[0].request.config.effort], ["opus", "max"]);
  assert.equal(hardwareDefaults().effort, "", "the machine's default unless one is picked");
  await setModel(box.ask, directory, { pubkey: PUBKEY, model: "opus", effort: "max" });
  assert.deepEqual(box.seen[1], { id: "commerce", request: { op: "settings.set", pubkey: PUBKEY, model: "opus", effort: "max" } });
  const refused = machine(() => ({ ok: false, error: "Claude Code does not offer the model x on this machine. Choose another model for this agent." }));
  await assert.rejects(setModel(refused.ask, agentDirectory(refused.ask), { pubkey: PUBKEY, model: "x", effort: "" }), /does not offer the model x/);
});

/** Just enough React to render the hardware forms in a test: elements as
 * plain objects, hook state kept per position across renders, effects run
 * after each render. `settle` renders until the machine's answers are in. */
function testReact() {
  const slots = new Map();
  let effects = [];
  let path = "";
  let index = 0;
  const slot = (make) => { const key = `${path}:${index++}`; if (!slots.has(key)) slots.set(key, make()); return key; };
  const useEffect = (effect, deps) => {
    const key = `${path}:${index++}`;
    const before = slots.get(key);
    if (!before || !deps || deps.some((dep, i) => dep !== before[i])) { slots.set(key, deps ?? []); effects.push(effect); }
  };
  const React = {
    Fragment: "fragment",
    Component: class { constructor(props) { this.props = props; this.state = {}; } },
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat() } }),
    useState(init) {
      const key = slot(() => (typeof init === "function" ? init() : init));
      return [slots.get(key), (next) => slots.set(key, typeof next === "function" ? next(slots.get(key)) : next)];
    },
    useRef(value) { return slots.get(slot(() => ({ current: value }))); },
    useId() { return slots.get(slot(() => `id-${slots.size}`)); },
    useEffect,
    useLayoutEffect: useEffect,
  };
  const render = (node, at = "r") => {
    if (!node || typeof node !== "object") return node;
    if (typeof node.type === "function") {
      if (node.type.prototype?.render) return render(new node.type(node.props).render(), `${at}c`);
      path = at; index = 0;
      return render(node.type(node.props), `${at}/`);
    }
    return { ...node, props: { ...node.props, children: node.props.children.map((child, i) => render(child, `${at}.${i}`)) } };
  };
  const cleanups = [];
  const settle = async (element) => {
    let tree;
    for (let pass = 0; pass < 6; pass++) {
      tree = render(element);
      const run = effects; effects = [];
      for (const effect of run) { const off = effect(); if (typeof off === "function") cleanups.push(off); }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return tree;
  };
  /** As Buzz leaving a tab: effects clean up, and hook state is gone. */
  const unmount = () => { for (const off of cleanups.splice(0)) off(); slots.clear(); };
  return { React, settle, unmount };
}

const textIn = (tree) => (!tree || typeof tree !== "object" ? (typeof tree === "string" ? tree : "") : (tree.props?.children ?? []).map(textIn).join(" "));
const has = (node, className) => typeof node?.props?.className === "string" && node.props.className.split(" ").includes(className);
const find = (node, test) => {
  if (!node || typeof node !== "object") return null;
  if (test(node)) return node;
  for (const child of node.props?.children ?? []) { const hit = find(child, test); if (hit) return hit; }
  return null;
};
const all = (node, test, out = []) => {
  if (!node || typeof node !== "object") return out;
  if (test(node)) out.push(node);
  for (const child of node.props?.children ?? []) all(child, test, out);
  return out;
};

/** Every row of every card in a rendered tree, as Buzz draws them: its title,
 * and its dropdown ({ value, options, pick }) or switch when it has one. */
function rowsIn(tree) {
  return all(tree, (node) => has(node, "buzz-preference-row")).map((row) => {
    const title = textIn(find(row, (node) => has(node, "buzz-preference-row-label"))).trim();
    const select = find(row, (node) => has(node, "buzz-select"));
    const options = select ? all(select, (node) => node.props.role === "option") : [];
    const toggle = find(row, (node) => node.props.role === "switch");
    return { title, description: textIn(find(row, (node) => has(node, "buzz-preference-row-description"))).trim(),
      ...(select ? { label: textIn(find(select, (node) => has(node, "sr-only"))).trim(), value: options.find((option) => option.props["aria-selected"])?.props["data-value"],
        options: options.map((option) => option.props["data-value"]), pick: (id) => options.find((option) => option.props["data-value"] === id).props.onClick() } : {}),
      ...(toggle ? { checked: toggle.props["aria-checked"], toggle: () => toggle.props.onClick() } : {}) };
  });
}
/** The dropdown rows: [title, value]. */
const pillsIn = (tree) => rowsIn(tree).filter((row) => row.options);
/** The buttons in a tree, by label. */
const buttonsIn = (tree) => all(tree, (node) => has(node, "buzz-button")).map((button) => ({ label: textIn(button).trim(), disabled: button.props.disabled, click: () => button.props.onClick?.({ preventDefault() {} }) }));

/** The hardware type registered on a test host whose machine answers `reply`. */
function hardwareOn(reply) {
  const { React, settle, unmount } = testReact();
  const asked = [];
  let type;
  const ctx = {
    react: React,
    host: { request: async ({ body }) => { const request = JSON.parse(body); asked.push(request); return { status: 200, body: JSON.stringify(await reply(request)) }; } },
    agents: { register: (registered) => { type = registered; } },
  };
  applyHardware(ctx, { sign: async () => ({ pass: "test-pass" }) });
  return { type, React, settle, unmount, asked };
}

const CONTROLS = { agents: { min: 1, max: 8, default: 1 }, sessionPolicy: { values: ["channel", "thread"], default: "channel" },
  multipleEventHandling: { values: ["steer", "queue", "interrupt", "owner-interrupt"], default: "steer" },
  maxTurnsPerSession: { min: 0, max: 10000, default: 0 }, maxTurnDuration: { min: 60, max: 86400, default: 7200 }, contextMessageLimit: { min: 0, max: 100, default: 12 } };

const fleet = (request) => {
  if (request.op === "machine.status") return { ok: true, machine: "commerce", harnesses: harnesses({ signedIn: true }) };
  if (request.op === "models") return MODELS;
  if (request.op === "list") return { ok: true, agents: [] };
  if (request.op === "status") return { ok: true, running: true, activated: true, harness: "claude", respondTo: "anyone",
    model: "opus", effort: "max", modelChosen: true, effortChosen: true };
  if (request.op === "instructions.get") return { ok: true, instructions: "Be brief." };
  return { ok: true };
};

test("buzzUi draws Buzz's primitives: its classes, data attributes and structure", () => {
  const { React } = testReact();
  const ui = buzzUi(React);
  const h = React.createElement;
  const row = h(ui.Row, { title: "Mode", description: "Light or dark.", trailing: h(ui.Button, { variant: "prominent", size: "sm" }, "Save") });
  const tree = (function render(node) {
    if (!node || typeof node !== "object") return node;
    if (typeof node.type === "function") return render(node.type(node.props));
    return { ...node, props: { ...node.props, children: node.props.children.map(render) } };
  })(h(ui.Group, null, row, h(ui.SwitchRow, { label: "Heartbeat", checked: true, onCheckedChange: () => {} }),
    h(ui.Row, { title: "Model", trailing: h(ui.Pill, { label: "Model", value: "b", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C", unavailable: true }], onChange: () => {} }) })));
  assert.equal(tree.props.className, "buzz-settings-group");
  assert.deepEqual([tree.props["data-buzz-ui"], tree.props["data-layout"]], ["", "rows"]);
  const [first, second, third] = tree.props.children;
  assert.deepEqual([first.props.className, first.props["data-buzz-ui"], first.props["data-variant"]], ["buzz-preference-row", "", "default"]);
  const [content, trailing] = first.props.children.filter(Boolean);
  assert.deepEqual(content.props.children.map((node) => [node.type, node.props.className]), [["div", "buzz-preference-row-label"], ["span", "buzz-preference-row-description"]]);
  const button = trailing.props.children[0];
  assert.deepEqual([button.type, button.props.className, button.props["data-variant"], button.props["data-size"], button.props["data-button-shape"], button.props.type],
    ["button", "buzz-button", "prominent", "sm", "capsule", "button"]);
  assert.equal(button.props.children[0].props.className, "buzz-button-label");
  const label = find(second, (node) => has(node, "buzz-preference-row-label"));
  const toggle = find(second, (node) => node.props.role === "switch");
  assert.equal(label.type, "label", "a switch row's title labels the switch");
  assert.equal(label.props.htmlFor, toggle.props.id);
  assert.deepEqual([toggle.props.className, toggle.props["data-checked"], toggle.props["aria-checked"], toggle.props.children[0].props.className], ["buzz-switch-control", "", true, "buzz-switch-thumb"]);
  const select = find(third, (node) => has(node, "buzz-select"));
  assert.deepEqual([select.props["data-variant"], select.props["data-appearance"]], ["compact", "outlined"]);
  const trigger = find(select, (node) => has(node, "buzz-button"));
  assert.deepEqual([trigger.props["data-variant"], trigger.props["data-size"], trigger.props.role, trigger.props["aria-haspopup"], trigger.props["aria-expanded"]], ["outline", "sm", "combobox", "listbox", false]);
  assert.equal(textIn(find(trigger, (node) => has(node, "buzz-select-value"))).trim(), "B");
  assert.equal(find(trigger, (node) => has(node, "buzz-dropdown-chevron")).props.children[0].props.d, "M6 9l6 6l6 -6", "Tabler chevron-down, as Buzz's CaretDownIcon");
  const popup = find(select, (node) => has(node, "buzz-select-popup"));
  assert.deepEqual([popup.props.role, popup.props.popover, popup.props["data-variant"]], ["listbox", "manual", "compact"]);
  const options = popup.props.children;
  assert.deepEqual(options.map((option) => [option.props.className, option.props["aria-selected"], option.props["data-disabled"]]),
    [["buzz-select-option", false, undefined], ["buzz-select-option", true, undefined], ["buzz-select-option", false, ""]]);
  assert.equal(find(options[1], (node) => has(node, "buzz-select-indicator")).props["data-selected"], "", "the check shows on the chosen one only");
  const loading = (function render(node) { return typeof node.type === "function" ? render(node.type(node.props)) : node; })(h(ui.Button, { loading: true }, "Save"));
  assert.deepEqual([loading.props["data-loading"], loading.props.disabled, loading.props.children[1].props.className], [true, true, "buzz-button-spinner"]);
  const native = (function render(node) { return typeof node.type === "function" ? render(node.type(node.props)) : node; })(
    h(buzzUi(React, { nativeSelect: true }).Pill, { label: "Model", value: "a", options: [{ id: "a", label: "A" }], onChange: () => {} }));
  assert.ok(find(native, (node) => node.type === "select"), "the fallback keeps a native select under the same pill");
});

test("conversation levers: the machine's bounds pick the presets, the default is named, and a heartbeat agent runs at least two", () => {
  const [agents, sessions, events, turns, duration, context] = CONVERSATION_ROWS;
  assert.deepEqual(controlOptions(agents, CONTROLS.agents, null).options.map((option) => option.label), ["Default (1)", "1", "2", "3", "4", "5", "6", "7", "8"]);
  const beating = controlOptions(agents, CONTROLS.agents, 3, { heartbeat: true });
  assert.deepEqual([beating.value, beating.options[0].label, beating.options[1].unavailable], ["3", "Default (2)", true]);
  assert.deepEqual(controlOptions(sessions, CONTROLS.sessionPolicy, "thread"), { value: "thread", numeric: false,
    options: [{ id: "", label: "Default (Channel)" }, { id: "channel", label: "Channel" }, { id: "thread", label: "Thread" }] });
  assert.deepEqual(controlOptions(events, CONTROLS.multipleEventHandling, null).options.map((option) => option.label), ["Default (Weave it in)", "Weave it in", "Wait", "Replace the task", "Replace only for me"]);
  assert.deepEqual(controlOptions(turns, CONTROLS.maxTurnsPerSession, 42).options.map((option) => option.label), ["Default (Never)", "Never", "10 turns", "25 turns", "50 turns", "100 turns", "250 turns", "500 turns", "1000 turns", "42 turns"]);
  assert.deepEqual(controlOptions(duration, { min: 60, max: 3600, default: 3600 }, null).options.map((option) => option.label), ["Default (1 hour)", "5 minutes", "15 minutes", "30 minutes", "1 hour"], "presets stay within the machine's bounds");
  assert.deepEqual(controlOptions(context, CONTROLS.contextMessageLimit, 0).options.slice(0, 2).map((option) => option.label), ["Default (12 messages)", "None"]);
  assert.equal(controlOptions(context, undefined, 3), null, "an older machine lists no levers");
  assert.deepEqual([controlValue(agents, CONTROLS.agents, ""), controlValue(agents, CONTROLS.agents, "4"), controlValue(sessions, CONTROLS.sessionPolicy, "thread")], [null, 4, "thread"]);
});

test("render: the Create agent form is one card of rows, with Model and Thinking from the machine at its defaults", async () => {
  const { type, React, settle } = hardwareOn(fleet);
  const changes = [];
  const harnessControl = React.createElement("div", { className: "buzz-preference-row host", "data-buzz-ui": "" }, React.createElement("div", { className: "buzz-preference-row-label" }, "Harness"));
  const tree = await settle(React.createElement(type.CreateConfiguration, {
    config: { ...hardwareDefaults(), harness: "claude" }, onChange: (next) => changes.push(next), disabled: false, harnessControl }));
  const card = find(tree, (node) => has(node, "buzz-settings-group"));
  assert.ok(card, "a Buzz settings card");
  assert.ok(has(card.props.children.filter(Boolean)[0], "host"), "the host's Harness row comes first in the card");
  assert.deepEqual(rowsIn(tree).map((row) => row.title), ["Harness", "Runs on", "Runs", "Model", "Thinking", "Answers", "Sign-in", "Heartbeat"]);
  const pills = pillsIn(tree);
  assert.deepEqual(pills.map((entry) => [entry.title, entry.value]), [["Runs on", "commerce"], ["Runs", "claude"], ["Model", "claude-fable-5-2"], ["Thinking", "high"], ["Answers", "anyone"]]);
  assert.deepEqual(pills[2].options, ["claude-fable-5-2", "opus"]);
  assert.deepEqual(pills[3].options, ["low", "medium", "high", "xhigh", "max"]);
  pills[2].pick("opus");
  assert.deepEqual([changes.at(-1).model, changes.at(-1).effort], ["opus", ""], "a pick changes the config, as Buzz's selects apply on change");
  assert.match(rowsIn(tree).find((row) => row.title === "Sign-in").description, /Signed in as|is signed in/);
  assert.doesNotMatch(textIn(tree), /could not show/);
  assert.ok(!all(tree, (node) => ["select", "input", "button", "textarea"].includes(node.type) && !has(node, "buzz-button") && !has(node, "buzz-input") && !has(node, "buzz-switch-control") && !has(node, "buzz-textarea")).length,
    "every control is a Buzz primitive");
  const older = hardwareOn((request) => (request.op === "models" ? UNKNOWN : fleet(request)));
  const plain = await older.settle(older.React.createElement(older.type.CreateConfiguration, { config: hardwareDefaults(), onChange: () => {} }));
  assert.deepEqual(pillsIn(plain).map((entry) => entry.title), ["Runs on", "Runs", "Answers"], "an older machine: no Model or Thinking, no Conversations");
  assert.deepEqual(all(plain, (node) => has(node, "buzz-content-header-title")).map((node) => textIn(node).trim()), ["Heartbeat"]);
});

test("render: the Create form's Heartbeat card sets how often the new agent wakes, which creation carries to activate", async () => {
  const { type, React, settle } = hardwareOn((request) => (request.op === "models" ? { ...MODELS, controls: CONTROLS } : fleet(request)));
  const changes = [];
  const tree = await settle(React.createElement(type.CreateConfiguration, { config: hardwareDefaults(), onChange: (next) => changes.push(next), disabled: false }));
  const beat = rowsIn(tree).find((row) => row.title === "Heartbeat");
  assert.equal(beat.checked, false, "off for a new agent");
  assert.equal(pillsIn(tree).find((entry) => entry.title === "Parallel work").options.find((option) => option === "1") !== undefined, true);
  beat.toggle();
  assert.equal(changes.at(-1).heartbeat, HEARTBEAT_MINUTES);
  const on = await settle(React.createElement(type.CreateConfiguration, { config: { ...hardwareDefaults(), heartbeat: 15 }, onChange: (next) => changes.push(next), disabled: false }));
  const interval = pillsIn(on).find((entry) => entry.label === "Heartbeat interval");
  assert.deepEqual([interval.value, interval.options], ["15", HEARTBEAT_CHOICES.map(String)]);
  interval.pick("60");
  assert.equal(changes.at(-1).heartbeat, 60);
  const prompt = find(on, (node) => has(node, "buzz-textarea") && find(on, (label) => has(label, "buzz-field-label") && label.props.htmlFor === node.props.id && /On each heartbeat/.test(textIn(label))));
  assert.ok(prompt, "on: what each heartbeat does can be written");
  prompt.props.onChange({ target: { value: "Check the Paid media board." } });
  assert.equal(changes.at(-1).heartbeatPrompt, "Check the Paid media board.");
  assert.equal(find(tree, (node) => /On each heartbeat/.test(typeof node === "string" ? node : "") ), null);
  assert.doesNotMatch(textIn(tree), /On each heartbeat/, "off: nothing to write");
  const parallel = rowsIn(on).find((row) => row.title === "Parallel work");
  assert.equal(parallel.description, "At least 2 while its heartbeat is on.");
  rowsIn(on).find((row) => row.title === "Heartbeat").toggle();
  assert.equal(changes.at(-1).heartbeat, 0);
  const box = machine((request) => (request.op === "provision" ? { ok: true, pubkey: PUBKEY } : { ok: true }));
  const remote = hardwareProvider(box.ask, () => "request-1", agentDirectory(box.ask));
  await remote.provision({ name: "Beats", community: "wss://example.communities.buzz.xyz", config: { ...hardwareDefaults(), heartbeat: 60 } });
  await remote.activate({ pubkey: PUBKEY, name: "Beats", community: "wss://example.communities.buzz.xyz", auth: AUTH, config: { ...hardwareDefaults(), heartbeat: 60, heartbeatPrompt: "Check the board." } });
  assert.deepEqual(box.ops(), ["provision", "activate"], "no extra step: activate takes the heartbeat in the config");
  assert.deepEqual([box.seen[1].request.config.heartbeat, box.seen[1].request.config.heartbeatPrompt], [60, "Check the board."]);
});

test("render: the Create form's Conversations card carries buzz-acp's levers into the config, and creation sends them after provision", async () => {
  const { type, React, settle } = hardwareOn((request) => (request.op === "models" ? { ...MODELS, controls: CONTROLS } : fleet(request)));
  const changes = [];
  const tree = await settle(React.createElement(type.CreateConfiguration, { config: hardwareDefaults(), onChange: (next) => changes.push(next), disabled: false }));
  assert.deepEqual(all(tree, (node) => has(node, "buzz-content-header-title")).map((node) => textIn(node).trim()), ["Heartbeat", "Conversations"]);
  const pills = pillsIn(tree);
  assert.deepEqual(pills.slice(-6).map((entry) => [entry.title, entry.value]), [["Parallel work", ""], ["Session per", ""], ["New message while working", ""], ["Fresh session after", ""], ["Max turn length", ""], ["Context for replies", ""]]);
  pills.find((entry) => entry.title === "Parallel work").pick("3");
  assert.deepEqual(changes.at(-1).controls, { agents: 3 });
  const again = await settle(React.createElement(type.CreateConfiguration, { config: { ...hardwareDefaults(), controls: { agents: 3 } }, onChange: (next) => changes.push(next), disabled: false }));
  pillsIn(again).find((entry) => entry.title === "New message while working").pick("queue");
  assert.deepEqual(changes.at(-1).controls, { agents: 3, multipleEventHandling: "queue" });
  pillsIn(again).find((entry) => entry.title === "Parallel work").pick("");
  assert.deepEqual(changes.at(-1).controls, { agents: null }, "back to buzz-acp's default");

  const box = machine((request) => (request.op === "provision" ? { ok: true, pubkey: PUBKEY } : { ok: true }));
  const remote = hardwareProvider(box.ask, () => "request-1", agentDirectory(box.ask));
  await remote.provision({ name: "Talks", community: "wss://example.communities.buzz.xyz", config: { ...hardwareDefaults(), controls: { agents: 3, multipleEventHandling: "queue", maxTurnDuration: null } } });
  assert.deepEqual(box.ops(), ["provision", "settings.set"]);
  assert.deepEqual(box.seen[1].request, { op: "settings.set", pubkey: PUBKEY, agents: 3, multipleEventHandling: "queue" }, "only the levers chosen; defaults are not sent");
  const plain = machine((request) => (request.op === "provision" ? { ok: true, pubkey: PUBKEY } : { ok: true }));
  await hardwareProvider(plain.ask, () => "request-1", agentDirectory(plain.ask)).provision({ name: "Quiet", community: "wss://example.communities.buzz.xyz", config: hardwareDefaults() });
  assert.deepEqual(plain.ops(), ["provision"]);
});

const qwenFleet = (request) => {
  if (request.op === "machine.status") return { ok: true, machine: "commerce", harnesses: deviceRows({ qwen: true, qwenKey: true }) };
  if (request.op === "models") return { ok: true, harnesses: [
    { id: "qwen", label: "Qwen Code", checked: true, model: "qwen4-max", effort: null, models: [{ id: "qwen4-max", label: "qwen4-max", efforts: [] }, { id: "qwen3.8-max", label: "qwen3.8-max", efforts: [] }],
      compact: { supported: true, min: 20000, max: 2000000, default: 150000 },
      key: { checked: true, model: "qwen4-max", effort: null, models: [{ id: "qwen4-max", label: "qwen4-max", efforts: [] }, { id: "qwen3.7-plus", label: "qwen3.7-plus", efforts: [] }],
        compact: { supported: true, min: 20000, max: 2000000, default: 150000 } } },
  ], controls: CONTROLS };
  if (request.op === "list") return { ok: true, agents: [] };
  if (request.op === "status") return { ok: true, running: true, activated: true, harness: "qwen", pays: "key", respondTo: "anyone",
    model: "qwen3.7-plus", effort: null, modelChosen: true, effortChosen: false, compactAt: 250000,
    controls: { agents: null, sessionPolicy: "thread", multipleEventHandling: null, maxTurnsPerSession: null, maxTurnDuration: null, contextMessageLimit: 20 } };
  if (request.op === "instructions.get") return { ok: true, instructions: "" };
  return { ok: true };
};

test("render: a harness that takes an API key gets Pays with, and the model list follows it", async () => {
  const { type, React, settle } = hardwareOn(qwenFleet);
  const changes = [];
  const tree = await settle(React.createElement(type.CreateConfiguration, {
    config: { ...hardwareDefaults(), harness: "qwen" }, onChange: (next) => changes.push(next), disabled: false }));
  const pills = pillsIn(tree);
  assert.deepEqual(pills.slice(0, 6).map((entry) => entry.title), ["Runs on", "Runs", "Pays with", "Model", "Compact at", "Answers"]);
  assert.deepEqual([pills[2].value, pills[2].options], ["subscription", ["subscription", "key"]]);
  assert.deepEqual(pills[3].options, ["qwen4-max", "qwen3.8-max"]);
  assert.deepEqual([pills[4].value, pills[4].options], ["150000", ["", "50000", "100000", "150000", "250000", "500000"]]);
  pills[4].pick("");
  assert.equal(changes.at(-1).compactAt, null, "Harness default is sent as null");
  pills[4].pick("500000");
  assert.equal(changes.at(-1).compactAt, 500000);
  const byKey = await settle(React.createElement(type.CreateConfiguration, {
    config: { ...hardwareDefaults(), harness: "qwen", pays: "key" }, onChange: () => {}, disabled: false }));
  assert.deepEqual(pillsIn(byKey)[3].options, ["qwen4-max", "qwen3.7-plus"], "the key's listing");
  assert.match(rowsIn(byKey).find((row) => row.title === "API key").description, /has an API key|Signed in/);
  const claude = await settle(React.createElement(type.CreateConfiguration, {
    config: { ...hardwareDefaults(), harness: "claude" }, onChange: () => {}, disabled: false }));
  assert.ok(pillsIn(claude).some((entry) => entry.title === "Pays with"), "every harness that reports a key gets the choice");
  const before = hardwareOn((request) => (request.op === "machine.status" ? { ok: true, machine: "commerce", harnesses: harnesses({ signedIn: true }) } : qwenFleet(request)));
  const old = await before.settle(before.React.createElement(before.type.CreateConfiguration, {
    config: { ...hardwareDefaults(), harness: "claude" }, onChange: () => {}, disabled: false }));
  assert.ok(!pillsIn(old).some((entry) => entry.title === "Pays with"), "a machine from before keys: no choice");
});

test("render: Settings splits into Identity and Settings, each a titled card of rows", async () => {
  const { type, React, settle } = hardwareOn(qwenFleet);
  const [tab] = type.tabs;
  assert.deepEqual([tab.role, tab.splitSettings], ["settings", true]);
  const host = { typeControl: () => React.createElement("div", { className: "buzz-preference-row host", "data-buzz-ui": "" }, React.createElement("div", { className: "buzz-preference-row-label" }, "Harness")) };
  const identity = await settle(React.createElement(tab.component, { agent: { pubkey: PUBKEY }, settingsHost: host, settingsSection: "identity", settingsContent: "HOST" }));
  assert.deepEqual(rowsIn(identity).map((row) => row.title), ["Harness", "Model", "Compact at"]);
  assert.ok(has(find(identity, (node) => has(node, "buzz-settings-group")).props.children.filter(Boolean)[0], "host"), "the host's Harness row comes first");
  assert.equal(find(identity, (node) => has(node, "buzz-textarea")).props.id, find(identity, (node) => has(node, "buzz-field-label")).props.htmlFor, "Instructions is a Buzz field");
  assert.doesNotMatch(textIn(identity), /HOST/, "the host's own settings show on the Settings tab only");
  const runtime = await settle(React.createElement(tab.component, { agent: { pubkey: PUBKEY }, settingsHost: host, settingsSection: "runtime", settingsContent: "HOST" }));
  assert.deepEqual(all(runtime, (node) => has(node, "buzz-content-header-title")).map((node) => textIn(node).trim()), ["Machine", "Heartbeat", "Conversations"]);
  assert.deepEqual(rowsIn(runtime).map((row) => row.title), ["Runs on", "Runs", "Pays with", "API key", "Status", "Answers", "Heartbeat",
    "Parallel work", "Session per", "New message while working", "Fresh session after", "Max turn length", "Context for replies"]);
  assert.match(textIn(runtime), /HOST$/);
  assert.equal(rowsIn(runtime).find((row) => row.title === "Runs on").description, "");
  const both = await settle(React.createElement(tab.component, { agent: { pubkey: PUBKEY }, settingsHost: host }));
  assert.equal(rowsIn(both).length, 3 + 13, "no section named: both halves");
});

test("render: Settings shows how the agent pays and its levers, and a change goes to its machine as settings.set", async () => {
  const { type, React, settle, asked } = hardwareOn(qwenFleet);
  const tree = await settle(React.createElement(type.tabs[0].component, { agent: { pubkey: PUBKEY } }));
  const pills = pillsIn(tree);
  assert.deepEqual(pills.map((entry) => [entry.title, entry.value]), [["Model", "qwen3.7-plus"], ["Compact at", "250000"], ["Pays with", "key"], ["Answers", "anyone"],
    ["Parallel work", ""], ["Session per", "thread"], ["New message while working", ""], ["Fresh session after", ""], ["Max turn length", ""], ["Context for replies", "20"]]);
  assert.deepEqual(pills[0].options, ["qwen4-max", "qwen3.7-plus"], "the key's listing");
  const sent = async () => { await new Promise((resolve) => setTimeout(resolve, 10)); const request = asked.find((entry) => entry.op === "settings.set"); asked.length = 0; return request; };
  pills[1].pick("100000");
  assert.deepEqual(await sent(), { op: "settings.set", pubkey: PUBKEY, compactAt: 100000 }, "the model and effort stay as they are");
  pills[2].pick("subscription");
  assert.deepEqual(await sent(), { op: "settings.set", pubkey: PUBKEY, model: "", effort: "", pays: "subscription" });
  const later = await settle(React.createElement(type.tabs[0].component, { agent: { pubkey: PUBKEY } }));
  pillsIn(later).find((entry) => entry.title === "Session per").pick("channel");
  assert.deepEqual(await sent(), { op: "settings.set", pubkey: PUBKEY, sessionPolicy: "channel" });
  const again = await settle(React.createElement(type.tabs[0].component, { agent: { pubkey: PUBKEY } }));
  pillsIn(again).find((entry) => entry.title === "Context for replies").pick("");
  assert.deepEqual(await sent(), { op: "settings.set", pubkey: PUBKEY, contextMessageLimit: null }, "back to buzz-acp's default");
  const more = await settle(React.createElement(type.tabs[0].component, { agent: { pubkey: PUBKEY } }));
  pillsIn(more).find((entry) => entry.title === "Max turn length").pick("3600");
  assert.deepEqual(await sent(), { op: "settings.set", pubkey: PUBKEY, maxTurnDuration: 3600 });
  const answers = await settle(React.createElement(type.tabs[0].component, { agent: { pubkey: PUBKEY } }));
  const pill = pillsIn(answers).find((entry) => entry.title === "Answers");
  assert.deepEqual(pill.options, ["anyone", "owner-only"]);
  pill.pick("owner-only");
  assert.deepEqual(await sent(), { op: "settings.set", pubkey: PUBKEY, respondTo: "owner-only" }, "whom it answers is a setting too");
});

test("render: a lever the machine refuses says so under its card, on the tab where it was picked", async () => {
  const { type, React, settle } = hardwareOn((request) => (request.op === "settings.set"
    ? { ok: false, error: "agents is a whole number from 1 to 8, or null for buzz-acp's default" } : qwenFleet(request)));
  const element = React.createElement(type.tabs[0].component, { agent: { pubkey: PUBKEY }, settingsSection: "runtime" });
  const tree = await settle(element);
  pillsIn(tree).find((entry) => entry.title === "Parallel work").pick("8");
  const after = await settle(element);
  const errors = all(after, (node) => has(node, "buzz-field-error")).map((node) => textIn(node).trim());
  assert.deepEqual(errors, ["agents is a whole number from 1 to 8, or null for buzz-acp's default"]);
  const conversations = find(after, (node) => has(node, "buzz-content-header-title") && textIn(node).includes("Conversations"));
  assert.ok(conversations, "the Conversations card is on this tab");
  pillsIn(after).find((entry) => entry.title === "Pays with").pick("subscription");
  const again = await settle(element);
  assert.equal(all(again, (node) => has(node, "buzz-field-error")).length, 1, "one line: the latest pick's");
});

test("render: an unsaved edit outlives Buzz mounting the Identity tab anew", async () => {
  const { type, React, settle, unmount } = hardwareOn(fleet);
  const identity = React.createElement(type.tabs[0].component, { agent: { pubkey: PUBKEY }, settingsSection: "identity" });
  const tree = await settle(identity);
  find(tree, (node) => has(node, "buzz-textarea")).props.onChange({ target: { value: "Be brief. Be kind." } });
  const edited = await settle(identity);
  assert.deepEqual(buttonsIn(edited).map((button) => button.label), ["Opus 5.5", "Max", "Discard", "Save"], "dirty: Discard and Save");
  unmount();
  const back = await settle(identity);
  assert.equal(find(back, (node) => has(node, "buzz-textarea")).props.value, "Be brief. Be kind.", "the draft is back");
  buttonsIn(back).find((button) => button.label === "Discard").click();
  await settle(identity);
  unmount();
  const clean = await settle(identity);
  assert.equal(find(clean, (node) => has(node, "buzz-textarea")).props.value, "Be brief.", "discarded: nothing kept");
});

test("render: Settings shows what an agent with no choice was started with, and its problem", async () => {
  const { type, React, settle } = hardwareOn((request) => (request.op === "status"
    ? { ok: true, running: false, activated: true, harness: "claude", respondTo: "anyone", model: "opus", effort: "medium",
      modelChosen: false, effortChosen: false, modelProblem: "Claude Code does not offer the model x on this machine. Choose another model for this agent." }
    : fleet(request)));
  const tree = await settle(React.createElement(type.tabs[0].component, { agent: { pubkey: PUBKEY } }));
  assert.deepEqual(pillsIn(tree).map((entry) => [entry.title, entry.value]), [["Model", "opus"], ["Thinking", "medium"], ["Answers", "anyone"]]);
  assert.match(textIn(find(tree, (node) => has(node, "buzz-field-error"))), /does not offer the model x on this machine/);
  assert.deepEqual(rowsIn(tree).find((row) => row.title === "Status") && textIn(find(tree, (node) => node.props.children?.includes?.("Stopped"))).trim(), "Stopped");
});

test("render: Settings shows the agent's own model and effort, and a change is sent to its machine", async () => {
  const { type, React, settle, asked } = hardwareOn(fleet);
  const tree = await settle(React.createElement(type.tabs[0].component, { agent: { pubkey: PUBKEY } }));
  const pills = pillsIn(tree);
  assert.deepEqual(pills.map((entry) => [entry.title, entry.value]), [["Model", "opus"], ["Thinking", "max"], ["Answers", "anyone"]]);
  pills[0].pick("claude-fable-5-2");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(asked.find((request) => request.op === "settings.set"), { op: "settings.set", pubkey: PUBKEY, model: "", effort: "max" });
  assert.equal(pillsIn(tree).length, 3, "Model, Thinking, Answers; no Conversations card: this machine lists no levers");
  assert.deepEqual(buttonsIn(tree).map((button) => button.label), ["Opus 5.5", "Max", "Restart", "Everyone in the community"], "the pills (showing their value), and Restart; Save shows once the instructions change");
});

test("render: the heartbeat is a switch row, its interval a choice, and a change is sent to its machine", async () => {
  let minutes = 15;
  const { type, React, settle, asked } = hardwareOn((request) => (request.op === "heartbeat.get"
    ? { ok: true, heartbeat: minutes, prompt: "Standard", custom: false, defaultPrompt: "Standard" }
    : request.op === "heartbeat.set" ? { ok: true, heartbeat: (minutes = request.minutes), prompt: "Standard", custom: false, defaultPrompt: "Standard" }
    : fleet(request)));
  const tree = await settle(React.createElement(type.tabs[0].component, { agent: { pubkey: PUBKEY } }));
  const beat = rowsIn(tree).find((row) => row.title === "Heartbeat");
  assert.equal(beat.checked, true, "a switch, on");
  const interval = pillsIn(tree).find((entry) => entry.label === "Heartbeat interval");
  assert.ok(interval, "a heartbeat that is on shows its interval as a choice");
  assert.equal(interval.value, "15");
  assert.deepEqual(interval.options, HEARTBEAT_CHOICES.map(String));
  interval.pick("60");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(asked.find((request) => request.op === "heartbeat.set"), { op: "heartbeat.set", pubkey: PUBKEY, minutes: 60 });
  asked.length = 0;
  beat.toggle();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(asked.find((request) => request.op === "heartbeat.set"), { op: "heartbeat.set", pubkey: PUBKEY, minutes: 0 });
  const off = await settle(React.createElement(type.tabs[0].component, { agent: { pubkey: PUBKEY } }));
  assert.equal(pillsIn(off).find((entry) => entry.label === "Heartbeat interval"), undefined, "off: no interval row");
  assert.equal(find(off, (node) => has(node, "buzz-field-label") && textIn(node).includes("On each heartbeat")) !== null, true, "the prompt stays editable while off");
});

test("render: a sign-in under way is rows of the same card, with Buzz's input and buttons", async () => {
  const pending = { step: "idle" };
  const { type, React, settle } = hardwareOn((request) => {
    if (request.op === "machine.status") return { ok: true, machine: "commerce", harnesses: harnesses({ signedIn: false, signIn: "code" }) };
    if (request.op === "login.start") return { ok: true, loginId: "login-1", url: "https://example.com/sign-in", needsCode: true, flow: "code" };
    return fleet(request);
  });
  const tree = await settle(React.createElement(type.CreateConfiguration, { config: { ...hardwareDefaults(), harness: "claude" }, onChange: () => {}, disabled: false }));
  const signIn = rowsIn(tree).find((row) => row.title === "Sign-in");
  assert.equal(signIn.description, "Claude Code is not signed in");
  buttonsIn(tree).find((button) => button.label === "Sign in").click();
  const flow = await settle(React.createElement(type.CreateConfiguration, { config: { ...hardwareDefaults(), harness: "claude" }, onChange: () => {}, disabled: false }));
  assert.deepEqual(rowsIn(flow).map((row) => row.title).filter((title) => /sign-in|code/i.test(title)), ["Sign-in", "Open Claude Code sign-in", "Paste the code"]);
  const input = find(flow, (node) => has(node, "buzz-input"));
  assert.deepEqual([input.props.type, input.props["data-size"], input.props.placeholder], ["password", "sm", "Code"]);
  assert.equal(find(flow, (node) => has(node, "buzz-preference-row-label") && node.type === "label").props.htmlFor, input.props.id, "the row's title labels the code field");
  assert.deepEqual(buttonsIn(flow).map((button) => button.label).slice(-4), ["Cancel", "Open", "Copy link", "Finish"]);
  assert.equal(find(flow, (node) => node.type === "a" && has(node, "buzz-button")).props.href, "https://example.com/sign-in", "Open is Buzz's button as a link");
  void pending;
});

test("harness choices follow what the machine has installed", () => {
  const ok = { kind: "ok", harnesses: harnesses() };
  assert.deepEqual(harnessOptions(ok).map((entry) => entry.id), ["claude", "codex", "goose"]);
  assert.deepEqual(harnessOptions(undefined).map((entry) => entry.id), ["claude", "codex", "grok", "qwen", "goose"], "loading");
  assert.equal(harnessOptions({ kind: "unsupported" }).length, 5);
  assert.equal(harnessOptions({ kind: "unreachable", error: "x" }).length, 5);
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

// What a runner with Codex, Grok and Qwen Code sign-in reports (machine/agentctl machine.status).
const noKey = { signIn: "key", signedIn: false, account: null, plan: null };
const deviceRows = ({ codex = false, grok = false, qwen = false, qwenKey = false } = {}) => [
  { id: "claude", label: "Claude Code", installed: true, signedIn: true, account: null, signIn: "code", key: noKey },
  { id: "codex", label: "Codex", installed: true, signedIn: codex, account: codex ? "owner@example.com" : null, signIn: "device", key: noKey },
  { id: "grok", label: "Grok Build", installed: true, signedIn: grok, account: null, signIn: "device", key: noKey },
  { id: "qwen", label: "Qwen Code", installed: true, signedIn: qwen, account: qwen ? "owner@example.com" : null, signIn: "device",
    key: { signIn: "key", signedIn: qwenKey, account: null, plan: qwenKey ? "pay-as-you-go" : null } },
  { id: "goose", label: "Goose", installed: true, signedIn: null, account: null, signIn: null,
    note: "Goose takes its model settings from the machine itself; Buzz cannot sign it in." },
];

test("Codex and Grok sign in from Buzz; an installed harness Buzz cannot sign in is shown unavailable", () => {
  const ok = { kind: "ok", harnesses: deviceRows() };
  const options = harnessOptions(ok);
  assert.deepEqual(options.map((entry) => entry.id), ["claude", "codex", "grok", "qwen", "goose"]);
  assert.equal(options.find((entry) => entry.id === "goose").label, "Goose (unavailable)");
  assert.match(options.find((entry) => entry.id === "goose").unavailable, /cannot sign it in/);
  assert.ok(!options.find((entry) => entry.id === "codex").unavailable);
  for (const harness of ["codex", "grok", "qwen"]) {
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
  assert.deepEqual(box.seen[0].request, { op: "login.start", harness: "codex", pays: "subscription", flows: ["code", "device", "key"] });
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

test("a harness pays by subscription or by API key: each has its own sign-in state, and the machine's rule picks the default", () => {
  const none = { kind: "ok", harnesses: deviceRows() };
  assert.equal(takesKey(none, "qwen"), true);
  assert.equal(takesKey(none, "codex"), true);
  const older = { kind: "ok", harnesses: harnesses() };
  assert.equal(takesKey(older, "codex"), false, "a machine from before keys");
  assert.equal(takesKey(undefined, "qwen"), false);
  assert.deepEqual(signInState(none, "qwen"), { kind: "signed-out" });
  assert.deepEqual(signInState(none, "qwen", "key"), { kind: "signed-out" });
  assert.deepEqual(signInState(older, "codex", "key"), { kind: "unavailable", reason: "Codex takes no API key on this machine." });
  assert.equal(defaultPays(none, "qwen"), "subscription", "nothing signed in: by subscription");
  const keyOnly = { kind: "ok", harnesses: deviceRows({ qwenKey: true }) };
  assert.deepEqual(signInState(keyOnly, "qwen", "key"), { kind: "signed-in", account: null });
  assert.equal(readyToCreate(signInState(keyOnly, "qwen", "key")), true);
  assert.equal(readyToCreate(signInState(keyOnly, "qwen")), false);
  assert.equal(defaultPays(keyOnly, "qwen"), "key", "only the key works: by key");
  const both = { kind: "ok", harnesses: deviceRows({ qwen: true, qwenKey: true }) };
  assert.equal(defaultPays(both, "qwen"), "subscription");
  assert.deepEqual(signInState(both, "qwen"), { kind: "signed-in", account: "owner@example.com" });
  assert.deepEqual(PAYS.map((entry) => entry.id), ["subscription", "key"]);
  assert.equal(hardwareDefaults().pays, "", "the machine settles it unless one is picked");
});

test("compact at: a choice where the machine takes it, greyed with its reason where not, nothing on an older machine", async () => {
  const taking = { kind: "ok", harnesses: [{ id: "qwen", label: "Qwen Code", checked: true, model: "qwen4-max", effort: null,
    models: [{ id: "qwen4-max", label: "qwen4-max", efforts: [] }], compact: { supported: true, min: 20000, max: 2000000, default: 150000 } }] };
  const fresh = modelChoices(taking, "qwen", { model: "", effort: "" });
  assert.equal(fresh.compact.value, "150000", "a new agent shows the machine's default for one");
  assert.deepEqual(fresh.compact.options.map((entry) => entry.id), ["", ...COMPACT_OPTIONS.map(String)]);
  assert.equal(fresh.compact.options[0].label, "Harness default");
  assert.equal(modelChoices(taking, "qwen", { model: "", effort: "", compactAt: null }).compact.value, "", "the harness's default, chosen");
  assert.equal(modelChoices(taking, "qwen", { model: "", effort: "", compactAt: 50000 }).compact.value, "50000");
  const claude = { kind: "ok", harnesses: [{ id: "claude", label: "Claude Code", checked: true, model: "opus", effort: "high",
    models: [{ id: "opus", label: "Opus", efforts: ["high"] }], compact: { supported: true, min: 100000, max: 1000000, default: 150000 } }] };
  assert.deepEqual(modelChoices(claude, "claude", { model: "", effort: "" }).compact.options.map((entry) => entry.id), ["", "100000", "150000", "250000", "500000"], "below Claude Code's floor is not offered");
  const grok = { kind: "ok", harnesses: [{ id: "grok", label: "Grok Build", checked: true, model: "grok-4.7", effort: "high",
    models: [{ id: "grok-4.7", label: "Grok 4.7", efforts: ["high"] }], compact: { supported: false, note: "The machine does not know grok-4.7's context window yet; Grok Build lists it after its first run." } }] };
  const greyed = modelChoices(grok, "grok", { model: "", effort: "" }).compact;
  assert.equal(greyed.supported, false);
  assert.match(greyed.note, /context window/);
  assert.equal(modelChoices({ kind: "ok", harnesses: MODELS.harnesses }, "claude", { model: "", effort: "" }).compact, null, "an older machine: no choice");
  const box = machine(() => ({ ok: true }));
  const directory = agentDirectory(box.ask);
  await setModel(box.ask, directory, { pubkey: PUBKEY, model: "", effort: "", compactAt: 250000 });
  await setModel(box.ask, directory, { pubkey: PUBKEY, model: "", effort: "", compactAt: "" });
  await setModel(box.ask, directory, { pubkey: PUBKEY, model: "opus", effort: "" });
  assert.deepEqual(box.seen.map((entry) => entry.request.compactAt), [250000, null, undefined]);
});

test("an agent paying by key picks from the key's model listing", () => {
  const listed = { kind: "ok", harnesses: [
    { id: "qwen", label: "Qwen Code", checked: true, model: "qwen4-max", effort: null, models: [
      { id: "qwen4-max", label: "qwen4-max", efforts: [] }, { id: "qwen3.8-max", label: "qwen3.8-max", efforts: [] }],
      key: { checked: true, model: "qwen4-max", effort: null, models: [
        { id: "qwen4-max", label: "qwen4-max", efforts: [] }, { id: "qwen3.7-plus", label: "qwen3.7-plus", efforts: [] }] } },
  ] };
  assert.deepEqual(modelChoices(listed, "qwen", { model: "", effort: "" }).models.map((entry) => entry.id), ["qwen4-max", "qwen3.8-max"]);
  assert.deepEqual(modelChoices(listed, "qwen", { model: "", effort: "", pays: "key" }).models.map((entry) => entry.id), ["qwen4-max", "qwen3.7-plus"]);
  assert.equal(modelChoices(listed, "qwen", { model: "", effort: "", pays: "key" }).efforts.length, 0, "no effort lever");
  assert.deepEqual(modelChoices(listed, "qwen", { model: "", effort: "", pays: "subscription" }).models.map((entry) => entry.id), ["qwen4-max", "qwen3.8-max"]);
});

const KEY_URL = "https://docs.qwencloud.com/developer-guides/administration/api-keys";
const FAKE_KEY = "sk-fictional-qwencloud-key-0000000000000000";

test("sign-in: a key sign-in shows the key page, takes the key once, and signs in", async () => {
  let saved = false;
  const box = machine((request) => {
    if (request.op === "login.start") return { ok: true, loginId: "K1", url: KEY_URL, needsCode: true, flow: "key", expiresAt: 1 };
    if (request.op === "login.finish") { saved = request.code === FAKE_KEY; return saved ? { ok: true, signedIn: true, account: null } : { ok: false, error: "QwenCloud did not accept that key. Check it and paste it again." }; }
    if (request.op === "machine.status") return { ok: true, harnesses: deviceRows({ qwenKey: saved }) };
    return { ok: true };
  });
  const reader = statusReader(box.ask);
  const states = [];
  const said = await console_(async () => {
    const login = createLogin(box.ask, "commerce", "qwen", {
      pays: "key",
      onChange: (state) => states.push(state),
      onSignedIn: () => reader.read("commerce", { force: true }),
    });
    await login.start();
    assert.deepEqual(login.state, { step: "waiting", url: KEY_URL, needsCode: true, flow: "key" });
    assert.deepEqual(box.seen[0].request, { op: "login.start", harness: "qwen", pays: "key", flows: ["code", "device", "key"] });
    await login.finish("   ");
    assert.equal(login.state.error, "Paste the API key first.");
    await login.finish(`  ${FAKE_KEY}\n`);
    assert.deepEqual(login.state, { step: "idle" });
  });
  assert.deepEqual(box.ops(), ["login.start", "login.finish", "machine.status"], "an empty paste is not sent");
  assert.equal(box.seen[1].request.code, FAKE_KEY, "the key is trimmed and sent as the code");
  assert.deepEqual(signInState(reader.peek("commerce"), "qwen", "key"), { kind: "signed-in", account: null });
  assert.deepEqual(signInState(reader.peek("commerce"), "qwen"), { kind: "signed-out" }, "the membership is another sign-in");
  assert.ok(states.some((state) => state.step === "finishing" && state.flow === "key"));
  assert.ok(!JSON.stringify(states).includes(FAKE_KEY), "the key is never kept in state");
  assert.ok(!said.join("\n").includes(FAKE_KEY), "the key is never logged");
});

test("sign-in: a refused key keeps the same sign-in open to paste again, with no new link", async () => {
  let finishes = 0;
  const box = machine((request) => {
    if (request.op === "login.start") return { ok: true, loginId: "K1", url: KEY_URL, needsCode: true, flow: "key" };
    if (request.op === "login.finish") return ++finishes === 1
      ? { ok: false, error: "QwenCloud did not accept that key. Check it and paste it again." }
      : { ok: true, signedIn: true, account: null };
    return { ok: true };
  });
  const login = createLogin(box.ask, "commerce", "qwen", { pays: "key" });
  await login.start();
  await login.finish("sk-wrong-key-00000000000000000000");
  assert.deepEqual(login.state, { step: "waiting", url: KEY_URL, needsCode: true, flow: "key", error: "QwenCloud did not accept that key. Check it and paste it again." });
  assert.ok(!JSON.stringify(login.state).includes("sk-wrong-key"), "the refused key is not echoed");
  await login.finish(FAKE_KEY);
  assert.deepEqual(login.state, { step: "idle" });
  assert.deepEqual(box.ops(), ["login.start", "login.finish", "login.finish"], "no automatic new sign-in for a key");
  assert.ok(box.seen.slice(1).every((entry) => entry.request.loginId === "K1"), "the same sign-in takes the second paste");
});

test("sign-in: an expired key sign-in goes back to Sign in, and Cancel cancels it on the machine", async () => {
  const box = machine((request) => {
    if (request.op === "login.start") return { ok: true, loginId: "K2", url: KEY_URL, needsCode: true, flow: "key" };
    if (request.op === "login.finish") return { ok: false, error: "This sign-in has expired or was cancelled. Start the sign-in again." };
    return { ok: true };
  });
  const login = createLogin(box.ask, "commerce", "qwen", { pays: "key" });
  await login.start();
  await login.finish(FAKE_KEY);
  assert.deepEqual(login.state, { step: "idle", error: "This sign-in has expired or was cancelled. Start the sign-in again." });
  assert.deepEqual(box.ops(), ["login.start", "login.finish"], "a dead key sign-in is not restarted by itself");
  await login.start();
  await login.cancel();
  assert.deepEqual(box.seen.at(-1).request, { op: "login.cancel", loginId: "K2" });
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
