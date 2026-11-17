// The agent link in the Black 4 Settings card (made at sign-in, or with one
// click), and the Black 4 hardware agent type it leads to (staff only,
// isolated): fake AuthKit, MCP and door behind host.request, fictional keys
// and people, no network.
import assert from "node:assert/strict";
import test from "node:test";
import { fakeAuthKit, fakeMcp, fakeDoor, https, freshPlugin, settle, until, AUTHKIT } from "./fakes.mjs";

const { readAnswer, linkLabel } = await freshPlugin();

const VIEWER = "a".repeat(64);
const OTHER = "b".repeat(64);
const ok = (data) => ({ structuredContent: { data }, content: [{ type: "text", text: JSON.stringify(data) }] });
const refusal = (code, message) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }] });
const link = (ownerKey, extra = {}) => ({
  linkId: `link-${ownerKey.slice(0, 4)}`, ownerKey, email: "person@example.test", label: "Buzz on Mac",
  linkedAt: "2026-11-14T12:00:00.000Z", linkedBy: "person@example.test", lastUsedAt: null, revokedAt: null, revokedBy: null, agents: [], ...extra,
});

// Platform Control's refusal of a gated tool without a recent approval, in its real shape.
const APPROVAL_REFUSAL = ["signin_approval_required", "This needs a browser approval of this sign-in within the last 24 hours. Approve it with renew_signin, then try again."];

/** A Black 4 server holding links for one person. `listed` is what tools/list shows.
 * `approvalRequired` refuses link_agent_owner_key (and the other gated tools)
 * until renew_signin is approved; `renew.polls` scripts its answers. */
function server({ listed = ["whoami", "find_tools", "call_tool"], links = [], refuseLink, offline, kind = "staff", wire = false } = {}) {
  const calls = [];
  const tools = { // the non-core tools, reached directly when listed, else through call_tool
    list_agent_owner_keys: () => ok({ links: links.filter((entry) => !entry.revokedAt) }),
    link_agent_owner_key: ({ ownerKey, label }) => {
      if (self.approvalRequired) return refusal(...APPROVAL_REFUSAL);
      if (refuseLink) return refusal(...refuseLink);
      let entry = links.find((value) => value.ownerKey === ownerKey && !value.revokedAt);
      const created = !entry;
      if (!entry) links.push(entry = link(ownerKey, { label }));
      return ok({ link: entry, created });
    },
    invite_customer_admin: () => (self.approvalRequired ? refusal(...APPROVAL_REFUSAL) : ok({ invited: true })),
    revoke_agent_access: ({ linkId }) => {
      const entry = links.find((value) => value.linkId === linkId);
      entry.revokedAt = "2026-11-14T13:00:00.000Z";
      return ok({ revoked: "link", id: linkId, changed: true });
    },
  };
  const self = { calls, links, kind, approvalRequired: false, renew: { polls: ["pending", "approved"], calls: [] } };
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
    if (name === "renew_signin") { // called directly, as an idle sign-in may
      self.renew.calls.push(args ?? {});
      if (!args?.approvalId) return { result: ok({ state: "pending", approvalId: `ssa_${"b".repeat(22)}`, userCode: "LINK-CODE", verificationUri: `${AUTHKIT}/device`, verificationUriComplete: `${AUTHKIT}/device?user_code=LINK-CODE`, expiresAt: new Date(Date.now() + 600_000).toISOString(), interval: 0.02 }) };
      const step = self.renew.polls.length > 1 ? self.renew.polls.shift() : self.renew.polls[0];
      if (step === "approved") self.approvalRequired = false;
      return { result: ok({ state: step, approvalId: args.approvalId, ...(step === "pending" ? { interval: 0.02 } : { approvedAt: new Date().toISOString() }) }) };
    }
    if (name === "call_tool" && listed.includes("call_tool")) ({ name, arguments: args } = args);
    else if (!listed.includes(name)) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
    calls.push({ name, args, via: message.params.name });
    return tools[name] ? { result: tools[name](args ?? {}) } : { result: refusal("unknown_tool", `No tool ${name}`) };
  };
  return Object.assign(self, { answer });
}

/** `plugin: false` is a host without ctx.plugin; `register` replaces Buzz's
 * agents.register (to make it throw). `types` holds the registered agent types.
 * By default the person signed in earlier in this Buzz run (no automatic
 * link); `signedIn: false` starts signed out, to click Sign in. */
async function harness(t, black4, { viewer = VIEWER, plugin = true, register, signedIn = true, authkit = fakeAuthKit(), agentctl } = {}) {
  const { apply, signInStore } = await freshPlugin();
  const mcp = fakeMcp(authkit, { answer: (message) => black4.answer(message) });
  mcp.renew = null; // the server below answers renew_signin
  // One approval for the person, as on the server: passes are gated with links.
  Object.defineProperty(mcp, "approvalRequired", { get: () => black4.approvalRequired, set: (value) => { black4.approvalRequired = value; } });
  const door = fakeDoor(mcp, agentctl);
  const net = https({ authkit, mcp, door });
  if (signedIn) await signInStore.save(authkit.issue().refresh_token);
  let card;
  const types = new Set();
  const tools = new Set();
  const toolMap = new Map();
  const addType = register ?? ((type) => { types.add(type); return () => types.delete(type); });
  const cleanups = [];
  const relayListeners = new Set();
  const relay = { viewer };
  // Children sit in props as well, as React keeps them, for components that render their children.
  const h = (type, props, ...children) => { const kids = children.flat(); return { type, props: { ...(props ?? {}), children: kids }, children: kids }; };
  const ctx = {
    react: { createElement: h, useState: (v) => [typeof v === "function" ? v() : v, () => {}], useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }), useId: (() => { let n = 0; return () => `id-${++n}`; })(), Component: class { constructor(props) { this.props = props; } } },
    agents: { snapshot: () => ({ running: [] }), addTool: (tool) => { tools.add(tool.name); toolMap.set(tool.name, tool); return () => { tools.delete(tool.name); toolMap.delete(tool.name); }; }, register: (type) => { addType(type); } },
    settingsCards: { register: (value) => { card = value; } },
    pages: { register() {} }, panels: { register() {} },
    conversation: { registerLink() {}, registerLinkPreview() {} },
    browser: { available: false },
    relay: {
      snapshot: () => ({ status: "ready", viewer: relay.viewer, session: {} }),
      subscribe: (listener) => { relayListeners.add(listener); return () => relayListeners.delete(listener); },
    },
    effect: (fn) => { const off = fn(); if (off) cleanups.push(off); },
    host: { request: net.request },
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
    authkit,
    mcp,
    net,
    door,
    wholeText: () => texts(whole()).join(" "),
    agentTool: (name) => toolMap.get(name),
    clickAnywhere: async (label) => { const found = find(whole(), label); assert.ok(found, `no "${label}" button`); found.props.onClick(); await settle(); },
    text: () => texts(view()).join(" "),
    click: async (label) => { const found = find(view(), label); assert.ok(found, `no "${label}" button in: ${texts(view()).join(" ")}`); assert.ok(!found.props.disabled, `"${label}" is disabled`); found.props.onClick(); await settle(); },
    /** Settings → Black 4 → Sign in, until connected and Agent access settled. */
    signIn: async () => {
      const found = find(whole(), "Sign in to Black 4");
      assert.ok(found, "no Sign in button");
      found.props.onClick();
      await until(() => /Status Connected/.test(texts(whole()).join(" ")) && !/Checking…|Linking…/.test(texts(view()).join(" ")), { what: "the sign-in" });
    },
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
/** The role of the line that speaks the step's state (status or alert). */
const spoken = (node) => { if (!node || typeof node !== "object") return null; if (["status", "alert"].includes(node.props?.role)) return node.props.role; for (const child of node.children ?? []) { const found = spoken(child); if (found) return found; } return null; };
const texts = (node) => (node == null || node === false ? [] : typeof node !== "object" ? [String(node)] : (node.children ?? []).flatMap(texts));
const find = (node, label) => {
  if (!node || typeof node !== "object") return null;
  if (node.type === "button" && texts(node).join("") === label) return node;
  for (const child of node.children ?? []) { const found = find(child, label); if (found) return found; }
  return null;
};

test("an unlinked key gets one prompt, and one click links it with the viewer's key", async (t) => {
  const black4 = server();
  const ui = await harness(t, black4);
  await settle();
  assert.match(ui.text(), /need this to use Black 4 as you/);
  assert.deepEqual(black4.calls.map((call) => call.name), ["list_agent_owner_keys"], "checking never links");
  await ui.click("Link my agents");
  const linked = black4.calls.find((call) => call.name === "link_agent_owner_key");
  assert.equal(linked.args.ownerKey, VIEWER);
  assert.match(linked.args.label, /^Buzz/);
  assert.equal(linked.via, "call_tool", "a core tool list reaches it through call_tool");
  assert.match(ui.text(), /^Agent access Agents on Black 4 hardware Linked Nov 14, 2026 · No agents yet/);
  assert.ok(find(ui.view(), "Remove…"));
});

test("a key that is already linked shows when and how many agents used it", async (t) => {
  const black4 = server({ links: [link(VIEWER, { agents: [{ agentKey: "c".repeat(64) }, { agentKey: "d".repeat(64) }] }), link(OTHER)] });
  const ui = await harness(t, black4);
  await settle();
  assert.match(ui.text(), /Linked Nov 14, 2026 · 2 agents used it/);
  assert.equal(find(ui.view(), "Link my agents"), null);
});

test("tools in the listed set are called directly", async (t) => {
  const black4 = server({ listed: ["whoami", "list_agent_owner_keys", "link_agent_owner_key", "revoke_agent_access"] });
  const ui = await harness(t, black4);
  await settle();
  await ui.click("Link my agents");
  assert.deepEqual(black4.calls.map((call) => call.via), ["list_agent_owner_keys", "link_agent_owner_key"]);
});

test("removing asks once, revokes the link by id and offers the link again", async (t) => {
  const black4 = server({ links: [link(VIEWER)] });
  const ui = await harness(t, black4);
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
    const ui = await harness(t, black4);
    await settle();
    await ui.click("Link my agents");
    assert.equal(spoken(section(ui.view())), "alert");
    assert.match(ui.text(), new RegExp(message.replace(/\./g, "\\.")));
    assert.ok(find(ui.view(), "Try again"));
  }
});

test("a server without the link tools says so, without a button", async (t) => {
  const ui = await harness(t, server({ listed: ["whoami"] }));
  await settle();
  assert.match(ui.text(), /can't link agents yet/);
  assert.equal(find(ui.view(), "Try again"), null);
  const viaGateway = await harness(t, server({ listed: ["whoami", "call_tool"], links: [] }));
  await settle();
  assert.match(viaGateway.text(), /need this/);
});

test("offline is a retryable message, not a link state", async (t) => {
  const ui = await harness(t, server({ offline: true }));
  await settle();
  assert.match(ui.text(), /Couldn't reach Black 4/);
  assert.ok(find(ui.view(), "Try again"));
});

test("no Buzz identity yet asks for a community, and a new viewer is checked again", async (t) => {
  const black4 = server({ links: [link(OTHER)] });
  const ui = await harness(t, black4, { viewer: null });
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
  const ui = await harness(t, black4, { signedIn: false });
  await settle();
  assert.equal(ui.view(), null, "no Agent access step until signed in");
  assert.ok(find(ui.whole(), "Sign in to Black 4"), "the one thing to do is Sign in");
  assert.equal(find(ui.whole(), "Link my agents"), null);
  assert.equal(black4.calls.length, 0);
});

// ---- linking at sign-in (approved 2026-11-15) ----

test("signing in links this Buzz's key when it is not linked yet", async (t) => {
  const black4 = server();
  const ui = await harness(t, black4, { signedIn: false });
  await settle();
  await ui.signIn();
  assert.deepEqual(black4.calls.map((call) => call.name), ["list_agent_owner_keys", "link_agent_owner_key"]);
  assert.equal(black4.calls[1].args.ownerKey, VIEWER);
  assert.match(ui.text(), /^Agent access Agents on Black 4 hardware Linked/);
  assert.match(ui.wholeText(), /Signed in as person@example\.test \(staff\)/);
});

test("signing in with the key already linked to me changes nothing", async (t) => {
  const black4 = server({ links: [link(VIEWER)] });
  const ui = await harness(t, black4, { signedIn: false });
  await settle();
  await ui.signIn();
  assert.deepEqual(black4.calls.map((call) => call.name), ["list_agent_owner_keys"]);
  assert.match(ui.text(), /^Agent access Agents on Black 4 hardware Linked/);
});

test("signing in with the key linked to someone else says so plainly, once", async (t) => {
  const sentence = "This owner key is linked to another person. A key acts for one person at a time.";
  const black4 = server({ refuseLink: ["owner_key_taken", sentence] });
  const ui = await harness(t, black4, { signedIn: false });
  await settle();
  await ui.signIn();
  assert.equal(spoken(section(ui.view())), "alert");
  assert.match(ui.text(), /Your agents are not linked\. This owner key is linked to another person\./);
  assert.equal(black4.calls.filter((call) => call.name === "link_agent_owner_key").length, 1, "never retried on its own");
  await ui.click("Try again");
  assert.equal(black4.calls.filter((call) => call.name === "link_agent_owner_key").length, 1, "Try again checks; it does not link");
});

test("after Remove…, a reconnect or a fresh check does not link again", async (t) => {
  const black4 = server();
  const ui = await harness(t, black4, { signedIn: false });
  await settle();
  await ui.signIn();
  await ui.click("Remove…");
  await ui.click("Remove access");
  await ui.clickAnywhere("Reconnect");
  await settle();
  assert.equal(black4.calls.filter((call) => call.name === "link_agent_owner_key").length, 1);
  assert.ok(find(ui.view(), "Link my agents"));
});

test("a session restored from earlier in this run never links on its own", async (t) => {
  const black4 = server();
  const ui = await harness(t, black4);
  await settle();
  assert.deepEqual(black4.calls.map((call) => call.name), ["list_agent_owner_keys"]);
  assert.ok(find(ui.view(), "Link my agents"));
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
  const ui = await harness(t, black4);
  assert.equal(ui.types.size, 0, "not before the sign-in answers");
  await settle();
  const type = hardwareType(ui);
  assert.ok(type, "offered to staff");
  assert.equal(type.title, "Black 4 hardware");
  assert.deepEqual(Object.keys(type.remote).sort(), ["activate", "instructions", "profile", "provision", "remove"]);
  assert.doesNotMatch(ui.text(), /Next:/, "nothing to do next until linked");
  await ui.click("Link my agents");
  assert.match(ui.text(), /Linked Nov 14, 2026 · No agents yet Remove… Next: Agents → New agent → Black 4 hardware\./);
});

test("the hardware form offers the link in place while it is missing", async (t) => {
  const ui = await harness(t, server());
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
  const ui = await harness(t, server({ wire: true }));
  await settle();
  assert.ok(hardwareType(ui));
  assert.match(ui.wholeText(), /person@example\.test \(staff\)/);
});

test("a non-staff account never gets the hardware type, and a switch to one takes it back", async (t) => {
  const member = await harness(t, server({ kind: "customer" }));
  await settle();
  assert.equal(hardwareType(member), undefined);
  assert.ok(member.tools.size > 0, "the MCP tools are there all the same");

  const black4 = server();
  const ui = await harness(t, black4);
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
    const ui = await harness(t, black4, { plugin, register: (type) => { if (type.id === "hardware") throw new Error("Agent types need an id, a title and defaults"); } });
    await settle();
    assert.ok(ui.tools.size > 0, "agent tools registered");
    assert.ok(ui.tools.has("black4_whoami"));
    assert.match(ui.wholeText(), /Status Connected/);
    assert.match(ui.wholeText(), /Black 4 hardware is unavailable in this Buzz: Agent types need an id, a title and defaults/);
    await ui.click("Link my agents");
    assert.match(ui.text(), /^Agent access Agents on Black 4 hardware Linked/);
    assert.doesNotMatch(ui.text(), /Next:/, "no pointer to a type that is not there");
    assert.ok(warn.mock.calls.length >= 1, "and it is logged, not swallowed");
    warn.mock.restore();
  }
});

test("a hardware component that throws while rendering shows one sentence and is reported", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const ui = await harness(t, server());
  await settle();
  const Guarded = hardwareType(ui).CreateConfiguration;
  const boundary = new Guarded({ config: {} });
  boundary.state = Guarded.getDerivedStateFromError(new Error("x"));
  boundary.componentDidCatch(new Error("useSyncExternalStore is not a function"));
  assert.match(texts(boundary.render()).join(""), /Black 4 hardware could not show its form\. See Settings → Black 4\./);
  assert.match(ui.wholeText(), /Black 4 hardware is unavailable in this Buzz: useSyncExternalStore is not a function/);
  warn.mock.restore();
});

test("the hardware type reaches the Commerce Mac through its door, with a pass minted as the signed-in person", async (t) => {
  const AGENT = "e".repeat(64);
  const ui = await harness(t, server(), { agentctl: (request) => (request.op === "provision" ? { ok: true, pubkey: AGENT } : request.op === "list" ? { ok: true, agents: [] } : { ok: true }) });
  await settle();
  const { remote } = hardwareType(ui);
  const made = await remote.provision({ name: "Rock", community: "wss://example.test", config: { harness: "claude" }, signal: new AbortController().signal });
  assert.equal(made.pubkey, AGENT);
  assert.ok(ui.door.seen.some((request) => request.op === "provision" && request.name === "Rock"));
  const signed = ui.mcp.signed.find((entry) => entry.op === "provision");
  assert.equal(signed.machine, "commerce");
  assert.equal(signed.ownerKey, VIEWER, "the pass's owner is this Buzz identity");
  assert.match(signed.bodySha256, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(ui.door.refused.length, 0);
});

test("a pass refused because this Buzz's key is not linked says so and brings back the link step", async (t) => {
  const black4 = server({ links: [link(VIEWER)] });
  const ui = await harness(t, black4, { agentctl: () => ({ ok: true, agents: [] }) });
  await settle();
  assert.match(ui.text(), /^Agent access Agents on Black 4 hardware Linked/);
  black4.links[0].revokedAt = "2026-11-15T12:00:00.000Z"; // removed elsewhere
  ui.mcp.ownerKeys = [];
  const { remote } = hardwareType(ui);
  await assert.rejects(
    remote.provision({ name: "Rock", community: "wss://example.test", config: {}, signal: new AbortController().signal }),
    /^Error: Your agents are not linked to you on this Buzz identity, or the key is linked to someone else\. Choose Link my agents, then try again\.$/,
  );
  await settle();
  assert.ok(find(ui.view(), "Link my agents"), "the link step is back in Settings");
  assert.equal(ui.door.seen.filter((request) => request.op === "provision").length, 0, "the refused provision never reached the door");
  ui.mcp.ownerKeys = [VIEWER];
  await ui.click("Link my agents");
  const made = await remote.provision({ name: "Rock", community: "wss://example.test", config: {}, signal: new AbortController().signal }).catch((error) => error);
  assert.ok(ui.mcp.signed.some((entry) => entry.ownerKey === VIEWER && entry.op === "provision"), "after linking, the pass is minted");
  assert.ok(made);
});

// ---- a link that needs a recent approval (Platform Control's stored sign-in limits) ----

test("signing in with linking refused for want of a recent approval: Approve in place, then the link is made by itself", async (t) => {
  const black4 = server({ listed: ["whoami", "call_tool"] });
  black4.approvalRequired = true;
  const ui = await harness(t, black4, { signedIn: false });
  await settle();
  find(ui.whole(), "Sign in to Black 4").props.onClick();
  await until(() => /Linking waits for your approval/.test(ui.text()), { timeoutMs: 6000, what: "the approval step" });
  assert.match(ui.wholeText(), /Status Connected/, "signed in, not signed out");
  assert.doesNotMatch(ui.text(), /not linked|could not|Try again/i, "no failure shown");
  assert.equal(find(ui.whole(), "Sign in to Black 4"), null);
  const approveButtons = (node) => { let n = 0; const walk = (x) => { if (!x || typeof x !== "object") return; if (x.type === "button" && texts(x).join("") === "Approve in browser") n++; (x.children ?? []).forEach(walk); }; walk(node); return n; };
  assert.equal(approveButtons(ui.whole()), 1, "one Approve in Settings, in Agent access");
  find(ui.view(), "Approve in browser").props.onClick();
  await until(() => /^Agent access Agents on Black 4 hardware Linked/.test(ui.text()), { timeoutMs: 6000, what: "linked after approval" });
  assert.equal(black4.calls.filter((call) => call.name === "link_agent_owner_key").length, 2, `refused once, then made once by itself: ${JSON.stringify(black4.calls.map((call) => call.name))}`);
  assert.deepEqual(black4.renew.calls[0], {}, "renew_signin started with no input");
  assert.equal(black4.links.length, 1);
});

test("Link my agents refused for want of a recent approval: the same Approve, then linked; Cancel leaves it waiting", async (t) => {
  const black4 = server({ listed: ["whoami", "call_tool"] });
  const ui = await harness(t, black4);
  await settle();
  black4.approvalRequired = true;
  black4.renew.polls = ["pending"];
  await ui.click("Link my agents");
  assert.match(ui.text(), /Linking waits for your approval/);
  assert.match(find(ui.view(), "Approve in browser").props.title, /^Linking your agents asks for a recent approval/, "the tooltip fits the link");
  await ui.click("Approve in browser");
  await until(() => /LINK-CODE/.test(ui.text()), { timeoutMs: 6000, what: "the code" });
  await ui.click("Cancel");
  assert.match(ui.text(), /Linking waits for your approval/, "still waiting, nothing failed");
  assert.ok(find(ui.view(), "Approve in browser"));
  black4.renew.polls = ["approved"];
  await ui.click("Approve in browser");
  await until(() => /^Agent access Agents on Black 4 hardware Linked/.test(ui.text()), { timeoutMs: 6000, what: "linked" });
  assert.match(ui.wholeText(), /Status Connected/);
});

test("an agent's call refused for want of a recent approval tells the agent what the person does, and Settings offers Approve", async (t) => {
  const black4 = server({ listed: ["whoami", "call_tool", "invite_customer_admin"], links: [link(VIEWER)] });
  const ui = await harness(t, black4);
  await settle();
  black4.approvalRequired = true;
  const tool = ui.agentTool("black4_invite_customer_admin");
  await assert.rejects(tool.call({}, {}, { email: "new@example.test" }), /Approve in browser in Buzz/);
  assert.ok(find(ui.whole(), "Approve in browser"), "the person sees Approve in Settings");
  assert.match(find(ui.whole(), "Approve in browser").props.title, /^Black 4 asks for a recent approval/, "a neutral tooltip, not hardware's");
  find(ui.whole(), "Approve in browser").props.onClick();
  await until(() => !find(ui.whole(), "Approve in browser") && !/LINK-CODE|Approving/.test(ui.wholeText()), { timeoutMs: 6000, what: "approved" });
  assert.equal(await tool.call({}, {}, { email: "new@example.test" }), JSON.stringify({ invited: true }), "the agent's retry works");
});

test("a declined or expired approval at the link step: still waiting with Approve and why, never 'not linked', and no link retried", async (t) => {
  for (const [step, says] of [["denied", /declined/], ["expired", /expired/]]) {
    const black4 = server({ listed: ["whoami", "call_tool"] });
    const ui = await harness(t, black4);
    await settle();
    black4.approvalRequired = true;
    black4.renew.polls = [step];
    await ui.click("Link my agents");
    const links = () => black4.calls.filter((call) => call.name === "link_agent_owner_key").length;
    assert.equal(links(), 1);
    await ui.click("Approve in browser");
    await until(() => says.test(ui.text()) && find(ui.view(), "Approve in browser"), { timeoutMs: 6000, what: `${step} shown` });
    assert.match(ui.text(), /Linking waits for your approval/);
    assert.doesNotMatch(ui.text(), /not linked/i);
    assert.match(ui.wholeText(), /Status Connected/);
    assert.equal(links(), 1, `${step}: the link is not tried again`);
  }
});

test("coming back to the window after a declined approval does not try the link again", async (t) => {
  const listeners = new Map();
  const previous = { add: globalThis.addEventListener, remove: globalThis.removeEventListener };
  globalThis.addEventListener = (name, fn) => listeners.set(name, fn);
  globalThis.removeEventListener = (name) => listeners.delete(name);
  t.after(() => { globalThis.addEventListener = previous.add; globalThis.removeEventListener = previous.remove; });
  const black4 = server({ listed: ["whoami", "call_tool"] });
  const ui = await harness(t, black4);
  await settle();
  black4.approvalRequired = true;
  black4.renew.polls = ["denied"];
  await ui.click("Link my agents");
  await ui.click("Approve in browser");
  await until(() => /declined/.test(ui.text()), { timeoutMs: 6000, what: "declined" });
  const links = black4.calls.filter((call) => call.name === "link_agent_owner_key").length;
  listeners.get("focus")();
  await settle();
  assert.equal(black4.calls.filter((call) => call.name === "link_agent_owner_key").length, links, "no Linking… flicker");
  assert.match(ui.text(), /Linking waits for your approval/);
});

test("an agent's own link succeeding while the plugin's link waits: the prompt clears and Agent access links by itself", async (t) => {
  const black4 = server({ listed: ["whoami", "call_tool", "link_agent_owner_key"] });
  const ui = await harness(t, black4);
  await settle();
  black4.approvalRequired = true;
  await ui.click("Link my agents");
  assert.match(ui.text(), /Linking waits for your approval/);
  black4.approvalRequired = false; // approved elsewhere
  await ui.agentTool("black4_link_agent_owner_key").call({}, {}, { ownerKey: OTHER, label: "An agent's own" });
  await until(() => /^Agent access Agents on Black 4 hardware Linked/.test(ui.text()), { timeoutMs: 6000, what: "linked by itself" });
});
