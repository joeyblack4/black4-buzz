// The one-click agent link in the Black 4 Settings card, and the Black 4
// hardware agent type it leads to (staff only, isolated): a process double for
// the bridge, fictional keys and people, no network.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../plugins/black4/plugin.js", import.meta.url), "utf8");
const { apply, readAnswer, linkLabel } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() { for (let i = 0; i < 16; i++) await tick(); }

const VIEWER = "a".repeat(64);
const OTHER = "b".repeat(64);
const ok = (data) => ({ structuredContent: { data }, content: [{ type: "text", text: JSON.stringify(data) }] });
const refusal = (code, message) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }] });
const link = (ownerKey, extra = {}) => ({
  linkId: `link-${ownerKey.slice(0, 4)}`, ownerKey, email: "person@example.test", label: "Buzz on Mac",
  linkedAt: "2026-11-14T12:00:00.000Z", linkedBy: "person@example.test", lastUsedAt: null, revokedAt: null, revokedBy: null, agents: [], ...extra,
});

/** A Black 4 server holding links for one person. `listed` is what tools/list shows. */
function server({ listed = ["whoami", "find_tools", "call_tool"], links = [], refuseLink, offline, kind = "staff", wire = false } = {}) {
  const calls = [];
  const tools = { // the non-core tools, reached directly when listed, else through call_tool
    list_agent_owner_keys: () => ok({ links: links.filter((entry) => !entry.revokedAt) }),
    link_agent_owner_key: ({ ownerKey, label }) => {
      if (refuseLink) return refusal(...refuseLink);
      let entry = links.find((value) => value.ownerKey === ownerKey && !value.revokedAt);
      const created = !entry;
      if (!entry) links.push(entry = link(ownerKey, { label }));
      return ok({ link: entry, created });
    },
    revoke_agent_access: ({ linkId }) => {
      const entry = links.find((value) => value.linkId === linkId);
      entry.revokedAt = "2026-11-14T13:00:00.000Z";
      return ok({ revoked: "link", id: linkId, changed: true });
    },
  };
  const self = { calls, links, kind };
  const answer = (message) => {
    if (message.method === "initialize") return { result: {} };
    if (message.method === "tools/list") return { result: { tools: listed.map((name) => ({ name, inputSchema: { type: "object" } })) } };
    let { name, arguments: args } = message.params;
    if (name === "whoami") {
      const who = { kind: self.kind, email: "person@example.test" };
      // `wire`: exactly what api.black4.ai/mcp sends, text only, wrapped in data.
      return { result: wire ? { content: [{ type: "text", text: JSON.stringify({ data: who }) }] } : ok(who) };
    }
    if (offline) return { error: { code: -32000, message: "fetch failed" } };
    if (name === "call_tool" && listed.includes("call_tool")) ({ name, arguments: args } = args);
    else if (!listed.includes(name)) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
    calls.push({ name, args, via: message.params.name });
    return tools[name] ? { result: tools[name](args ?? {}) } : { result: refusal("unknown_tool", `No tool ${name}`) };
  };
  return Object.assign(self, { answer });
}

/** `plugin: false` is a host without ctx.plugin; `register` replaces Buzz's
 * agents.register (to make it throw). `types` holds the registered agent types. */
function harness(t, black4, { viewer = VIEWER, plugin = true, register } = {}) {
  let card;
  const types = new Set();
  const tools = new Set();
  const addType = register ?? ((type) => { types.add(type); return () => types.delete(type); });
  const cleanups = [];
  const relayListeners = new Set();
  const relay = { viewer };
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children });
  const ctx = {
    react: { createElement: h, useState: (v) => [typeof v === "function" ? v() : v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }), Component: class { constructor(props) { this.props = props; } } },
    agents: { snapshot: () => ({ running: [] }), addTool: (tool) => { tools.add(tool.name); return () => tools.delete(tool.name); }, register: (type) => { addType(type); } },
    settingsCards: { register: (value) => { card = value; } },
    pages: { register() {} }, panels: { register() {} },
    conversation: { registerLink() {}, registerLinkPreview() {} },
    browser: { available: false },
    relay: {
      snapshot: () => ({ status: "ready", viewer: relay.viewer, session: {} }),
      subscribe: (listener) => { relayListeners.add(listener); return () => relayListeners.delete(listener); },
    },
    effect: (fn) => { const off = fn(); if (off) cleanups.push(off); },
    host: { spawn: async (_, callbacks) => {
      let exit;
      const child = {
        exited: new Promise((resolve) => { exit = resolve; }),
        kill: async () => exit(0),
        write: async (line) => {
          const message = JSON.parse(line);
          const answer = message.id == null ? null : black4.answer(message);
          if (!answer) return;
          const reply = JSON.stringify({ jsonrpc: "2.0", id: message.id, ...answer }) + "\n";
          queueMicrotask(() => callbacks.onStdout(reply));
        },
      };
      return child;
    } },
  };
  if (plugin) {
    // A child scope, as cordis gives one: its registrations end with it.
    ctx.plugin = ({ apply: start, inject }) => {
      assert.deepEqual(inject, ["react", "host", "agents"]);
      const ended = [];
      const child = Object.create(ctx);
      child.agents = { ...ctx.agents, register: (type) => { const off = addType(type); if (off) ended.push(off); } };
      start(child);
      return { dispose: () => { for (const off of ended) off(); } };
    };
  }
  apply(ctx);
  t.after(() => { for (const off of cleanups.reverse()) off(); });
  const view = () => section(expand(card.component()));
  const whole = () => expand(card.component());
  return {
    view,
    whole,
    types,
    tools,
    wholeText: () => texts(whole()).join(" "),
    clickAnywhere: async (label) => { const found = find(whole(), label); assert.ok(found, `no "${label}" button`); found.props.onClick(); await settle(); },
    text: () => texts(view()).join(" "),
    click: async (label) => { const found = find(view(), label); assert.ok(found, `no "${label}" button in: ${texts(view()).join(" ")}`); assert.ok(!found.props.disabled, `"${label}" is disabled`); found.props.onClick(); await settle(); },
    switchViewer: async (key) => { relay.viewer = key; for (const listener of relayListeners) listener(); await settle(); },
  };
}

// Mount every component element, the way a host would.
const expand = (node) => {
  if (!node || typeof node !== "object") return node;
  if (typeof node.type === "function") return expand(node.type.prototype?.render ? new node.type(node.props).render() : node.type(node.props));
  return { ...node, children: node.children.map(expand) };
};
const section = (node) => {
  if (!node || typeof node !== "object") return null;
  if (node.props?.["aria-label"] === "Agent access") return node;
  for (const child of node.children ?? []) { const found = section(child); if (found) return found; }
  return null;
};
const texts = (node) => (node == null || node === false ? [] : typeof node !== "object" ? [String(node)] : (node.children ?? []).flatMap(texts));
const find = (node, label) => {
  if (!node || typeof node !== "object") return null;
  if (node.type === "button" && texts(node).join("") === label) return node;
  for (const child of node.children ?? []) { const found = find(child, label); if (found) return found; }
  return null;
};

test("an unlinked key gets one prompt, and one click links it with the viewer's key", async (t) => {
  const black4 = server();
  const ui = harness(t, black4);
  await settle();
  assert.match(ui.text(), /need this to use Black 4 as you/);
  assert.deepEqual(black4.calls.map((call) => call.name), ["list_agent_owner_keys"], "checking never links");
  await ui.click("Link my agents");
  const linked = black4.calls.find((call) => call.name === "link_agent_owner_key");
  assert.equal(linked.args.ownerKey, VIEWER);
  assert.match(linked.args.label, /^Buzz/);
  assert.equal(linked.via, "call_tool", "a core tool list reaches it through call_tool");
  assert.match(ui.text(), /^Agent access Linked Nov 14, 2026 · No agents yet/);
  assert.ok(find(ui.view(), "Remove…"));
});

test("a key that is already linked shows when and how many agents used it", async (t) => {
  const black4 = server({ links: [link(VIEWER, { agents: [{ agentKey: "c".repeat(64) }, { agentKey: "d".repeat(64) }] }), link(OTHER)] });
  const ui = harness(t, black4);
  await settle();
  assert.match(ui.text(), /Linked Nov 14, 2026 · 2 agents used it/);
  assert.equal(find(ui.view(), "Link my agents"), null);
});

test("tools in the listed set are called directly", async (t) => {
  const black4 = server({ listed: ["whoami", "list_agent_owner_keys", "link_agent_owner_key", "revoke_agent_access"] });
  const ui = harness(t, black4);
  await settle();
  await ui.click("Link my agents");
  assert.deepEqual(black4.calls.map((call) => call.via), ["list_agent_owner_keys", "link_agent_owner_key"]);
});

test("removing asks once, revokes the link by id and offers the link again", async (t) => {
  const black4 = server({ links: [link(VIEWER)] });
  const ui = harness(t, black4);
  await settle();
  await ui.click("Remove…");
  assert.match(ui.text(), /lose Black 4 access/);
  assert.equal(black4.calls.some((call) => call.name === "revoke_agent_access"), false);
  await ui.click("Cancel");
  assert.match(ui.text(), /Linked/);
  await ui.click("Remove…");
  await ui.click("Remove access");
  assert.deepEqual(black4.calls.find((call) => call.name === "revoke_agent_access").args, { linkId: `link-${VIEWER.slice(0, 4)}` });
  assert.ok(black4.links[0].revokedAt);
  assert.ok(find(ui.view(), "Link my agents"));
});

test("the server's own sentence is shown when the key is someone else's or the person is not staff", async (t) => {
  for (const [code, message] of [
    ["owner_key_taken", "This owner key is linked to another person. A key acts for one person at a time."],
    ["forbidden", "Linking an agent owner key needs Black 4 staff access."],
  ]) {
    const black4 = server({ refuseLink: [code, message] });
    const ui = harness(t, black4);
    await settle();
    await ui.click("Link my agents");
    assert.equal(section(ui.view()).children[1].props.role, "alert");
    assert.match(ui.text(), new RegExp(message.replace(/\./g, "\\.")));
    assert.ok(find(ui.view(), "Try again"));
  }
});

test("a server without the link tools says so, without a button", async (t) => {
  const ui = harness(t, server({ listed: ["whoami"] }));
  await settle();
  assert.match(ui.text(), /can't link agents yet/);
  assert.equal(find(ui.view(), "Try again"), null);
  const viaGateway = harness(t, server({ listed: ["whoami", "call_tool"], links: [] }));
  await settle();
  assert.match(viaGateway.text(), /need this/);
});

test("offline is a retryable message, not a link state", async (t) => {
  const ui = harness(t, server({ offline: true }));
  await settle();
  assert.match(ui.text(), /Couldn't reach Black 4/);
  assert.ok(find(ui.view(), "Try again"));
});

test("no Buzz identity yet asks for a community, and a new viewer is checked again", async (t) => {
  const black4 = server({ links: [link(OTHER)] });
  const ui = harness(t, black4, { viewer: null });
  await settle();
  assert.match(ui.text(), /Open a community/);
  assert.equal(black4.calls.length, 0);
  await ui.switchViewer(OTHER);
  assert.match(ui.text(), /Linked/);
  await ui.switchViewer(VIEWER);
  assert.match(ui.text(), /need this/);
});

test("before the Black 4 sign-in finishes there is nothing to click", async (t) => {
  const black4 = server();
  black4.answer = () => null; // never answers initialize: still signing in
  const ui = harness(t, black4);
  await settle();
  assert.match(ui.text(), /Connect Black 4 first/);
  assert.equal(find(ui.view(), "Link my agents"), null);
});

test("readAnswer returns data and turns a refusal into the server's sentence", () => {
  assert.deepEqual(readAnswer(ok({ a: 1 })), { a: 1 });
  assert.deepEqual(readAnswer({ content: [{ type: "text", text: '{"b":2}' }] }), { b: 2 });
  assert.throws(() => readAnswer(refusal("x", "Exactly this.")), /^Error: Exactly this\.$/);
  assert.throws(() => readAnswer(refusal("unknown_tool", "No tool")), (error) => error.code === "unavailable");
  assert.equal(linkLabel("MacIntel"), "Buzz on Mac");
  assert.equal(linkLabel("Win32"), "Buzz on Windows");
  assert.equal(linkLabel(""), "Buzz");
});

// ---- Black 4 hardware: staff only, one product with Agent access, isolated ----

const hardwareType = (ui) => [...ui.types].find((type) => type.id === "hardware");

test("staff get the Black 4 hardware type once signed in, and linking points to it", async (t) => {
  const black4 = server();
  const ui = harness(t, black4);
  assert.equal(ui.types.size, 0, "not before the sign-in answers");
  await settle();
  const type = hardwareType(ui);
  assert.ok(type, "offered to staff");
  assert.equal(type.title, "Black 4 hardware");
  assert.deepEqual(Object.keys(type.remote).sort(), ["activate", "instructions", "profile", "provision", "remove"]);
  assert.doesNotMatch(ui.text(), /Next:/, "nothing to do next until linked");
  await ui.click("Link my agents");
  assert.match(ui.text(), /Linked Nov 14, 2026 · No agents yet Next: Agents → New agent → Black 4 hardware\./);
});

test("the hardware form offers the link in place while it is missing", async (t) => {
  const ui = harness(t, server());
  await settle();
  const Configuration = hardwareType(ui).CreateConfiguration;
  const form = expand({ type: Configuration, props: { config: {}, onChange() {}, disabled: false, onReadyChange() {} }, children: [] });
  assert.match(texts(form).join(" "), /Link your agents so it can use Black 4 as you\./);
  find(form, "Link my agents").props.onClick();
  await settle();
  const after = expand({ type: Configuration, props: { config: {}, onChange() {}, disabled: false, onReadyChange() {} }, children: [] });
  assert.equal(find(after, "Link my agents"), null, "gone once linked");
});

test("whoami's real answer ({ data: { kind } } as text) is read", async (t) => {
  const ui = harness(t, server({ wire: true }));
  await settle();
  assert.ok(hardwareType(ui));
  assert.match(ui.wholeText(), /person@example\.test \(staff\)/);
});

test("a non-staff account never gets the hardware type, and a switch to one takes it back", async (t) => {
  const member = harness(t, server({ kind: "customer" }));
  await settle();
  assert.equal(hardwareType(member), undefined);
  assert.ok(member.tools.size > 0, "the MCP tools are there all the same");

  const black4 = server();
  const ui = harness(t, black4);
  await settle();
  assert.ok(hardwareType(ui));
  black4.kind = "customer";
  await ui.clickAnywhere("Reconnect");
  assert.equal(hardwareType(ui), undefined, "withdrawn for a non-staff account");
  black4.kind = "staff";
  await ui.clickAnywhere("Reconnect");
  assert.ok(hardwareType(ui), "offered again");
});

test("if registering the hardware type throws, MCP tools, Reviews and Agent access still work and the card says so", async (t) => {
  for (const plugin of [true, false]) {
    const warn = t.mock.method(console, "warn", () => {});
    const black4 = server();
    const ui = harness(t, black4, { plugin, register: (type) => { if (type.id === "hardware") throw new Error("Agent types need an id, a title and defaults"); } });
    await settle();
    assert.ok(ui.tools.size > 0, "agent tools registered");
    assert.ok(ui.tools.has("black4_whoami"));
    assert.match(ui.wholeText(), /Status Connected/);
    assert.match(ui.wholeText(), /Black 4 hardware is unavailable in this Buzz: Agent types need an id, a title and defaults/);
    await ui.click("Link my agents");
    assert.match(ui.text(), /^Agent access Linked/);
    assert.doesNotMatch(ui.text(), /Next:/, "no pointer to a type that is not there");
    assert.ok(warn.mock.calls.length >= 1, "and it is logged, not swallowed");
    warn.mock.restore();
  }
});

test("a hardware component that throws while rendering shows one sentence and is reported", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const ui = harness(t, server());
  await settle();
  const Guarded = hardwareType(ui).CreateConfiguration;
  const boundary = new Guarded({ config: {} });
  boundary.state = Guarded.getDerivedStateFromError(new Error("x"));
  boundary.componentDidCatch(new Error("useSyncExternalStore is not a function"));
  assert.match(texts(boundary.render()).join(""), /Black 4 hardware could not show its form\. See Settings → Black 4\./);
  assert.match(ui.wholeText(), /Black 4 hardware is unavailable in this Buzz: useSyncExternalStore is not a function/);
  warn.mock.restore();
});
