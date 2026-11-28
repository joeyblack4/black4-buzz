// Signing in to Black 4 from wherever the person is: the one prompt Buzz opens
// (Settings → Black 4, via ctx.navigation.open), when it opens and when it
// never does, and what each surface shows signed out, signing in, signed in
// and after a sign-in ended. Real components, rendered with a stand-in React.
import assert from "node:assert/strict";
import test from "node:test";
import { fakeAuthKit, fakeMcp, fakeDoor, https, freshPlugin, settle, until, AUTHKIT } from "./fakes.mjs";

const REVIEW = "https://app.black4.ai/r/rv_example?item=hero&v=3";
const QUEUE = "https://app.black4.ai/reviews";
const SECTION = "ai.black4/connection";

const whoami = (message) => message.method === "tools/list"
  ? { result: { tools: [{ name: "whoami", inputSchema: { type: "object" } }, { name: "review_queue", inputSchema: { type: "object" } }, { name: "call_tool", inputSchema: { type: "object" } }, { name: "renew_signin", inputSchema: { type: "object" } }] } }
  : message.params?.name === "whoami" ? { result: { content: [{ type: "text", text: JSON.stringify({ data: { kind: "staff", email: "person@example.test" } }) }] } }
    : message.params?.name === "review_queue" ? { result: { content: [{ type: "text", text: JSON.stringify({ kind: "black4_review_queue", total: 0, reviews: [] }) }] } }
      : { result: { content: [{ type: "text", text: "{}" }] } };

/** The plugin on a test host. `module` reuses a plugin module (one Buzz run)
 * across harnesses; `opens` scripts what navigation.open answers. */
async function harness(t, { signedIn = false, polls = ["authorization_pending", "authorization_pending", "authorization_pending", "ok"], module, browser = true, opens = () => ({ status: "opened" }), owner, revision = "test", relay = true, navigation, authkit: sharedAuthkit } = {}) {
  if (!globalThis.__b4device) deviceStorage(t);
  const plugin = module ?? await freshPlugin();
  const opened = [];
  const authkit = sharedAuthkit ?? fakeAuthKit({ polls, interval: 0.02 });
  const mcp = fakeMcp(authkit, { answer: whoami });
  const door = fakeDoor(mcp, (request) => request.op === "instructions.get" ? { ok: true, instructions: "Be brief." } : { ok: true, agents: [] });
  const net = https({ authkit, mcp, door });
  const nav = navigation === undefined ? { open: async (target) => { opened.push(target); return opens(opened.length); } } : navigation;
  if (signedIn) await plugin.signInStore.save(authkit.issue().refresh_token);
  const regs = {};
  const tools = new Map();
  const relayListeners = new Set();
  const cleanups = [];
  // Children sit in props as well, as React keeps them, for components that render their children.
  const h = (type, props, ...children) => { const kids = children.flat(); return { type, props: { ...(props ?? {}), children: kids }, children: kids }; };
  const ctx = {
    react: { createElement: h, useState: (v) => [typeof v === "function" ? v() : v, () => {}], useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }), useId: (() => { let n = 0; return () => `id-${++n}`; })(), Component: class { constructor(props) { this.props = props; } } },
    agents: { snapshot: () => ({ running: [] }), addTool: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name); }, register: (type) => { regs.hardware = type; } },
    settingsCards: { register: (value) => { regs.card = value; } },
    pages: { register: (value) => { regs.pages = { ...(regs.pages ?? {}), [value.id]: value }; if (value.id === "reviews") regs.page = value; } },
    panels: { register: (value) => { regs.panel = value; } },
    conversation: { registerLink() {}, registerLinkPreview: (value) => { regs.preview = value; } },
    browser: { available: browser, View: "browser-view" },
    reflect: { get: (name) => (name === "navigation" ? nav ?? undefined : undefined) },
    effect: (fn) => { const off = fn(); if (off) cleanups.push(off); },
    host: { request: net.request },
    ...(owner || revision ? { pluginOwner: { id: owner ?? "ai.black4", ...(revision ? { revision } : {}) } } : {}),
    ...(relay ? { relay: { snapshot: () => ({ status: "ready", viewer: null, session: {} }), subscribe: (listener) => { relayListeners.add(listener); return () => relayListeners.delete(listener); } } } : {}),
  };
  plugin.apply(ctx);
  t.after(() => { for (const off of cleanups.reverse()) off(); });
  const settings = () => expand(regs.card.component());
  return {
    plugin, authkit, mcp, door, net, opened, regs, tools,
    settings,
    panel: (target = QUEUE) => expand(regs.panel.component({ target })),
    preview: () => expand(regs.preview.component({ url: REVIEW, open() {} })),
    workspace: () => expand(regs.page.component()),
    badge: () => regs.page.badge(),
    click: (label, where = settings()) => { const found = button(where, label); assert.ok(found, `no "${label}" in: ${texts(where).join(" ")}`); found.props.onClick(); },
    communityChanged: async () => { for (const listener of relayListeners) listener(); await settle(); },
    connected: () => until(() => /Status Connected/.test(texts(settings()).join(" ")), { what: "Connected" }),
    waitingForCode: () => until(() => /WDJB-MJHT/.test(texts(settings()).join(" ")), { what: "the code" }),
  };
}

const expand = (node) => {
  if (!node || typeof node !== "object") return node;
  if (typeof node.type === "function") return expand(node.type.prototype?.render ? new node.type(node.props).render() : node.type(node.props));
  return { ...node, children: (node.children ?? []).map(expand) };
};
const texts = (node) => (node == null || node === false ? [] : typeof node !== "object" ? [String(node)] : node.type === "style" ? [] : (node.children ?? []).flatMap(texts));
const find = (node, test) => {
  if (!node || typeof node !== "object") return null;
  if (test(node)) return node;
  for (const child of node.children ?? []) { const found = find(child, test); if (found) return found; }
  return null;
};
/** The one-time code, drawn large as Buzz's Pairing draws its code. */
const isCode = (n) => typeof n.props?.className === "string" && n.props.className.includes("tracking-widest");
const button = (node, label) => find(node, (n) => n.type === "button" && texts(n).join("") === label);
const text = (node) => texts(node).join(" ");

// ---- the prompt: when Buzz opens Settings → Black 4 ----

/** A device's localStorage, as the webview keeps it across launches. */
function deviceStorage(t, { broken = false } = {}) {
  const values = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = {
    getItem: (key) => { if (broken) throw new Error("SecurityError"); return values.has(key) ? values.get(key) : null; },
    setItem: (key, value) => { if (broken) throw new Error("SecurityError"); values.set(key, String(value)); },
    removeItem: (key) => { if (broken) throw new Error("SecurityError"); values.delete(key); },
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  globalThis.__b4device = values;
  t.after(() => { delete globalThis.__b4device; if (previous) Object.defineProperty(globalThis, "localStorage", previous); else delete globalThis.localStorage; });
  return values;
}

test("installed and enabled while signed out: Buzz opens Settings → Black 4 once, at its Sign in", async (t) => {
  const app = await harness(t);
  await settle();
  assert.deepEqual(app.opened, [{ version: 1, kind: "settings", section: SECTION }]);
  const signIn = button(app.settings(), "Sign in to Black 4");
  assert.ok(signIn, "the card is the one action");
  assert.equal(signIn.props.autoFocus, true, "focused, so Return signs in");
  assert.deepEqual([signIn.props.className, signIn.props["data-variant"]], ["buzz-button", "prominent"], "Buzz's primary button");
  await app.communityChanged();
  assert.equal(app.opened.length, 1, "dismissed, it does not come back in this run");
});

test("an ordinary launch opens nothing: Sign in waits in place on every surface, with the dock dot", async (t) => {
  const device = deviceStorage(t);
  const install = await harness(t, { revision: "rev-1" });
  await settle();
  assert.equal(install.opened.length, 1, "the first activation of a revision opens Settings");
  assert.equal(device.get("ai.black4.signin-prompted"), "rev-1", "only the revision is remembered");
  // Quit and launch again: a new module (memory gone), the same device.
  const launch = await harness(t, { revision: "rev-1", browser: false });
  await settle();
  await launch.communityChanged();
  assert.deepEqual(launch.opened, [], "no Settings takeover on a launch");
  for (const view of [launch.settings(), launch.panel(), launch.preview(), launch.workspace()]) assert.ok(button(view, "Sign in to Black 4"));
  assert.equal(launch.badge().props["aria-label"], "Sign in to Black 4");
  // Signing in, then losing it while Buzz runs, still prompts once.
  launch.click("Sign in to Black 4");
  await launch.connected();
  launch.authkit.refresh.clear();
  launch.authkit.access.clear();
  launch.click("Reconnect");
  await until(() => button(launch.settings(), "Sign in to Black 4"), { what: "signed out" });
  assert.equal(launch.opened.length, 1, "a sign-in that ended while running opens Settings");
});

test("an update (a new revision) opens Sign in once again", async (t) => {
  const device = deviceStorage(t);
  device.set("ai.black4.signin-prompted", "rev-1");
  const updated = await harness(t, { revision: "rev-2" });
  await settle();
  assert.equal(updated.opened.length, 1);
  assert.equal(device.get("ai.black4.signin-prompted"), "rev-2");
  const again = await harness(t, { revision: "rev-2" });
  await settle();
  assert.equal(again.opened.length, 0, "already shown for this revision");
});

test("what cannot be remembered never prompts by itself: blocked storage, or no revision; Sign in waits in place", async (t) => {
  deviceStorage(t, { broken: true });
  const blocked = await harness(t, { revision: "rev-1" });
  await settle();
  assert.deepEqual(blocked.opened, [], "blocked storage: no prompt on every launch");
  assert.ok(button(blocked.settings(), "Sign in to Black 4"));
  assert.equal(blocked.badge().props["aria-label"], "Sign in to Black 4");
  const unknown = await harness(t, { revision: null });
  await settle();
  assert.deepEqual(unknown.opened, [], "no revision: updates cannot be told apart, so no install prompt");
  unknown.click("Sign in to Black 4");
  await unknown.connected();
  unknown.authkit.refresh.clear();
  unknown.authkit.access.clear();
  unknown.click("Reconnect");
  await until(() => button(unknown.settings(), "Sign in to Black 4"), { what: "signed out" });
  assert.equal(unknown.opened.length, 1, "a sign-in that ended still prompts");
});

test("an open Buzz could not show is not remembered, so the next launch tries again; one the person moved past is", async (t) => {
  const device = deviceStorage(t);
  const failed = await harness(t, { revision: "rev-1", opens: () => ({ status: "failed", reason: "unavailable" }) });
  await settle();
  assert.equal(device.has("ai.black4.signin-prompted"), false);
  const superseded = await harness(t, { revision: "rev-1", opens: () => ({ status: "superseded" }) });
  await settle();
  assert.equal(superseded.opened.length, 1);
  assert.equal(device.get("ai.black4.signin-prompted"), "rev-1", "superseded is the person's own navigation");
});

test("the section follows the installed plugin's id", async (t) => {
  const app = await harness(t, { owner: "ai.black4-dev" });
  await settle();
  assert.equal(app.opened[0].section, "ai.black4-dev/connection");
});

test("a sign-in that is still good (earlier in this Buzz run) opens nothing", async (t) => {
  const app = await harness(t, { signedIn: true });
  await app.connected();
  assert.deepEqual(app.opened, []);
});

test("turned off and on again in the same run: no second prompt", async (t) => {
  const first = await harness(t);
  await settle();
  const again = await harness(t, { module: first.plugin });
  await settle();
  assert.equal(first.opened.length, 1);
  assert.equal(again.opened.length, 0);
});

test("an open that did not show is never retried later, in the middle of other work", async (t) => {
  for (const [i, result] of [{ status: "superseded" }, { status: "failed", reason: "timeout" }, { status: "failed", reason: "unavailable", presented: true }].entries()) {
    const app = await harness(t, { opens: () => result, revision: `rev-${i}` });
    await settle();
    assert.equal(app.opened.length, 1);
    for (let i = 0; i < 3; i++) await app.communityChanged();
    assert.equal(app.opened.length, 1, `${result.status}: not opened again`);
    assert.ok(button(app.settings(), "Sign in to Black 4"), "Sign in stays in place");
  }
});

test("navigation is optional: without it, or when it throws or rejects, the plugin still runs and offers Sign in", async (t) => {
  for (const navigation of [null, { open() { throw new Error("boom"); } }, { open: async () => { throw new Error("boom"); } }]) {
    const app = await harness(t, { navigation });
    await settle();
    assert.ok(button(app.settings(), "Sign in to Black 4"));
    app.click("Sign in to Black 4");
    await app.connected();
    app.click("Sign out"); // the sign-in is kept on this device: leave none for the next
    await settle();
  }
  const { inject } = await freshPlugin();
  assert.equal(inject.includes("navigation"), false, "never a required service: a host without it still starts the plugin");
});

test("signed in, a dropped network is offline (retrying), never Sign in or a prompt", async (t) => {
  const app = await harness(t, { signedIn: true });
  await app.connected();
  // The access token is no longer accepted and the sign-in server is unreachable.
  app.net.offline.add(AUTHKIT);
  app.authkit.access.clear();
  app.click("Reconnect");
  await until(() => /Not connected/.test(text(app.settings())), { what: "offline" });
  assert.equal(button(app.settings(), "Sign in to Black 4"), null, "not signed out");
  assert.match(text(app.settings()), /Could not reach Black 4 sign-in/);
  assert.match(text(app.settings()), /Retrying in/);
  assert.deepEqual(app.opened, [], "no Settings over the person's work");
  assert.equal(app.badge(), null, "no Sign in dot");
  assert.equal(button(app.panel(), "Sign in to Black 4"), null);
  app.net.offline.clear();
  app.click("Try again");
  await app.connected();
  assert.deepEqual(app.opened, []);
});

test("Sign out, Cancel, an expired code and a declined sign-in never open Settings", async (t) => {
  const app = await harness(t, { signedIn: true, polls: ["authorization_pending"] });
  await app.connected();
  app.click("Sign out");
  await settle();
  await app.communityChanged();
  assert.deepEqual(app.opened, [], "Sign out is the person's own choice, also after a community change");
  app.click("Sign in to Black 4");
  await app.waitingForCode();
  app.click("Cancel");
  await settle();
  await app.communityChanged();
  assert.deepEqual(app.opened, [], "Cancel");
  for (const poll of ["expired_token", "access_denied"]) {
    app.authkit.polls = [poll];
    app.click("Sign in to Black 4");
    await until(() => button(app.settings(), "Sign in to Black 4") && /expired|declined/.test(text(app.settings())), { what: poll });
    await app.communityChanged();
    assert.deepEqual(app.opened, [], poll);
  }
});

test("a sign-in that ends later (refresh refused) opens Settings once, showing why", async (t) => {
  const app = await harness(t);
  await settle();
  assert.equal(app.opened.length, 1, "the activation prompt");
  app.click("Sign in to Black 4");
  await app.connected();
  // Revoked: every token stops working.
  app.authkit.refresh.clear();
  app.authkit.access.clear();
  app.click("Reconnect");
  await until(() => button(app.settings(), "Sign in to Black 4"), { what: "signed out" });
  assert.equal(app.opened.length, 2, "the same prompt, once more");
  assert.match(text(app.settings()), /sign-in ended/i);
  await app.communityChanged();
  assert.equal(app.opened.length, 2, "and only once");
});

test("a sign-in that ends while idle (an agent's call finds it revoked) opens Settings once", async (t) => {
  const app = await harness(t, { signedIn: true });
  await app.connected();
  assert.deepEqual(app.opened, []);
  app.authkit.refresh.clear();
  app.authkit.access.clear();
  await assert.rejects(app.tools.get("black4_whoami").call({}, {}, {}));
  await until(() => button(app.settings(), "Sign in to Black 4"), { what: "signed out" });
  assert.deepEqual(app.opened, [{ version: 1, kind: "settings", section: SECTION }]);
  assert.match(text(app.settings()), /sign-in ended/i);
  await app.communityChanged();
  assert.equal(app.opened.length, 1);
});

// ---- Sign in itself ----

test("Sign in opens the browser at the link that carries the code, once, and shows the code large and copyable", async (t) => {
  const clicks = [];
  const body = { appendChild: (node) => { node.parent = body; }, };
  const previous = globalThis.document;
  globalThis.document = {
    body,
    createElement: (tag) => ({ tag, style: {}, click() { clicks.push({ tag, href: this.href, target: this.target, rel: this.rel, attached: this.parent === body }); }, remove() { this.parent = null; } }),
  };
  t.after(() => { globalThis.document = previous; });
  const app = await harness(t);
  await settle();
  app.click("Sign in to Black 4");
  await app.waitingForCode();
  // Every surface is mounted at once; the browser still opens once.
  app.settings(); app.panel(); app.preview(); app.workspace();
  assert.deepEqual(clicks, [{ tag: "a", href: `${AUTHKIT}/device?user_code=WDJB-MJHT`, target: "_blank", rel: "noopener noreferrer", attached: true }]);
  const view = app.settings();
  const code = find(view, isCode);
  assert.deepEqual(code.children, ["WDJB-MJHT"]);
  assert.ok(button(view, "Copy code"), "copy the code");
  const link = find(view, (n) => n.type === "a");
  assert.equal(link.props.href, `${AUTHKIT}/device?user_code=WDJB-MJHT`, "the page can be opened again");
  assert.equal(link.props.target, "_blank");
  assert.match(text(view), /Confirm it in your browser/);
  // WorkOS asks someone in several companies to pick one; whichever they pick, they get every company.
  assert.match(text(view), /choose any one: you get every company you belong to/);
  assert.ok(button(view, "Cancel"));
  assert.equal(find(view, (n) => n.type === "form"), null, "never a form");
  await app.connected();
  assert.equal(find(app.settings(), isCode), null, "the card turns signed in by itself");
});

// ---- every surface, in every state ----

test("signed out: every surface offers the same one Sign in, never a sentence pointing at Settings", async (t) => {
  const app = await harness(t, { browser: false });
  await settle();
  const surfaces = { settings: app.settings(), panel: app.panel(), preview: app.preview(), queue: app.workspace() };
  for (const [name, view] of Object.entries(surfaces)) {
    assert.ok(button(view, "Sign in to Black 4"), `${name}: Sign in`);
    assert.doesNotMatch(text(view), /Settings →/, `${name}: no directions`);
  }
  assert.equal(find(app.settings(), (n) => n.props?.["aria-label"] === "Agent access"), null, "no step that cannot be taken yet");
  assert.equal(button(app.preview(), "Sign in to Black 4").props.autoFocus, undefined, "a message preview never takes focus");
  app.click("Sign in to Black 4", app.preview());
  await until(() => /WDJB-MJHT/.test(text(app.preview())), { what: "the code in the preview" });
  assert.match(text(app.preview()), /Confirm\s+WDJB-MJHT\s+in your browser/, "compact: one line with the code");
  assert.equal(find(app.preview(), isCode), null, "no large code in a preview");
  assert.match(text(app.settings()), /WDJB-MJHT/, "the same sign-in shows in Settings");
});

test("signed out, the native Reviews page offers Sign in where the queue goes, and never embeds the website", async (t) => {
  const app = await harness(t);
  await settle();
  let view = app.workspace();
  assert.ok(button(view, "Sign in to Black 4"), "Sign in in place of the queue");
  assert.equal(find(view, (n) => n.type === "browser-view"), null, "no embedded website");
  app.click("Sign in to Black 4", view);
  await app.waitingForCode();
  assert.match(text(app.workspace()), /WDJB-MJHT[\s\S]*Confirm it in your browser/);
  await app.connected();
  view = app.workspace();
  assert.equal(button(view, "Sign in to Black 4"), null, "signed in: Sign in is gone");
  assert.equal(find(view, (n) => n.type === "browser-view"), null, "still no embedded website");
});

test("the Reviews dock entry carries a dot while signed out, and the count once signed in", async (t) => {
  const app = await harness(t);
  await settle();
  const dot = app.badge();
  assert.equal(dot.props["aria-label"], "Sign in to Black 4");
  assert.equal(dot.props.title, "Sign in to Black 4");
  assert.equal(text(dot), "", "a dot, no words");
  app.click("Sign in to Black 4");
  await app.waitingForCode();
  assert.equal(app.badge(), null, "signing in: no dot");
  await app.connected();
  assert.equal(app.badge(), null, "signed in with nothing waiting: nothing");
});

test("signed in: no Sign in anywhere; ended: Sign in comes back everywhere with the reason", async (t) => {
  const app = await harness(t, { signedIn: true, browser: false });
  await app.connected();
  for (const view of [app.settings(), app.panel(), app.preview(), app.workspace()]) assert.equal(button(view, "Sign in to Black 4"), null);
  assert.ok(button(app.settings(), "Sign out"));
  app.authkit.refresh.clear();
  app.authkit.access.clear();
  app.click("Reconnect");
  await until(() => button(app.settings(), "Sign in to Black 4"), { what: "signed out" });
  for (const view of [app.settings(), app.panel(), app.preview()]) {
    assert.ok(button(view, "Sign in to Black 4"));
    assert.match(text(view), /sign-in ended/i);
    assert.equal(find(view, (n) => n.props?.role === "alert"), null, "no surface announces it on its own");
  }
  // Announced once: Settings (which opens) focuses Sign in, described by why.
  const signIn = button(app.settings(), "Sign in to Black 4");
  const reason = find(app.settings(), (n) => n.props?.id === signIn.props["aria-describedby"]);
  assert.ok(reason, "the focused button is described by the reason");
  assert.match(text(reason), /sign-in ended/i);
  assert.equal(button(app.panel(), "Sign in to Black 4").props["aria-describedby"], undefined);
  assert.match(app.badge().props["aria-label"], /^Sign in to Black 4\. .*sign-in ended/i, "the dock dot's label says why");
});

// ---- Black 4 hardware (Create agent and the agent's Settings) ----

/** A stand-in React with hook state and effects, like tests/hardware.test.mjs. */
function testReact() {
  const slots = new Map();
  let effects = [];
  let path = "";
  let index = 0;
  const slot = (make) => { const key = `${path}:${index++}`; if (!slots.has(key)) slots.set(key, make()); return key; };
  const React = {
    Fragment: "fragment",
    Component: class { constructor(props) { this.props = props; this.state = {}; } },
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat() } }),
    useState(init) { const key = slot(() => (typeof init === "function" ? init() : init)); return [slots.get(key), (next) => slots.set(key, typeof next === "function" ? next(slots.get(key)) : next)]; },
    useRef(value) { return slots.get(slot(() => ({ current: value }))); },
    useId() { return slots.get(slot(() => `id-${slots.size}`)); },
    useEffect(effect, deps) {
      const key = `${path}:${index++}`;
      const before = slots.get(key);
      if (!before || !deps || deps.some((dep, i) => dep !== before[i])) { slots.set(key, deps ?? []); effects.push(effect); }
    },
  };
  React.useLayoutEffect = React.useEffect;
  const render = (node, at = "r") => {
    if (!node || typeof node !== "object") return node;
    if (typeof node.type === "function") {
      if (node.type.prototype?.render) return render(new node.type(node.props).render(), `${at}c`);
      path = at; index = 0;
      return render(node.type(node.props), `${at}/`);
    }
    return { ...node, props: { ...node.props, children: node.props.children.map((child, i) => render(child, `${at}.${i}`)) } };
  };
  const settleTree = async (element) => {
    let tree;
    for (let pass = 0; pass < 6; pass++) {
      tree = render(element);
      const run = effects; effects = [];
      for (const effect of run) effect();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return tree;
  };
  return { React, settle: settleTree };
}
const treeText = (tree) => (!tree || typeof tree !== "object" ? (typeof tree === "string" ? tree : "") : (tree.props?.children ?? []).map(treeText).join(" "));
const isPrompt = (n) => n.type === "button" && treeText(n).trim() === "Sign in to Black 4";
const has = (tree, test) => !!tree && typeof tree === "object" && (test(tree) || (tree.props?.children ?? []).some((child) => has(child, test)));

test("Black 4 hardware: while a fresh approval is needed the form offers it and Create stays off; once approved it reads the machine again", async () => {
  const { applyHardware, hardwareDefaults } = await freshPlugin();
  const { React, settle: settleTree } = testReact();
  const asked = [];
  const approval = { needed: false, epoch: 0 };
  const Approve = () => React.createElement("button", { type: "button" }, "Approve in browser");
  let type;
  applyHardware({
    react: React,
    host: { request: async ({ body }) => {
      const request = JSON.parse(body);
      asked.push(request.op);
      if (request.op === "machine.status") return { status: 200, body: JSON.stringify({ ok: true, machine: "commerce", harnesses: [{ id: "claude", label: "Claude Code", installed: true, signedIn: true, account: "a@example.test" }] }) };
      return { status: 200, body: JSON.stringify({ ok: true }) };
    } },
    agents: { register: (value) => { type = value; } },
  }, {
    sign: async () => ({ pass: "p" }),
    access: { use: () => ({ status: "linked" }), link() {}, signIn: { use: () => "connected", Prompt: () => null }, approval: { use: () => approval, Prompt: Approve } },
  });
  const ready = [];
  const form = React.createElement(type.CreateConfiguration, { config: hardwareDefaults(), onChange() {}, onReadyChange: (value) => ready.push(value) });
  let tree = await settleTree(form);
  assert.equal(ready.at(-1), true);
  const reads = () => asked.filter((op) => op === "machine.status").length;
  const before = reads();
  approval.needed = true;
  tree = await settleTree(form);
  assert.ok(has(tree, (n) => n.type === "button" && treeText(n).trim() === "Approve in browser"), "offered in place");
  assert.equal(ready.at(-1), false, "Create stays off");
  approval.needed = false;
  approval.epoch = 1;
  tree = await settleTree(form);
  assert.ok(reads() > before, "approved: the machine is read again, past the cache");
  assert.equal(ready.at(-1), true);
});

test("Black 4 hardware: a sign-in that ended shows Sign in in the form (not ready) and in the agent's Settings, then reads the machine again", async () => {
  const { applyHardware, hardwareDefaults } = await freshPlugin();
  const { React, settle: settleTree } = testReact();
  const asked = [];
  let status = "signed-out";
  const Prompt = () => React.createElement("button", { type: "button" }, "Sign in to Black 4");
  let type;
  applyHardware({
    react: React,
    host: { request: async ({ body }) => {
      const request = JSON.parse(body);
      asked.push(request.op);
      if (request.op === "machine.status") return { status: 200, body: JSON.stringify({ ok: true, machine: "commerce", harnesses: [{ id: "claude", label: "Claude Code", installed: true, signedIn: true, account: "a@example.test" }] }) };
      if (request.op === "status") return { status: 200, body: JSON.stringify({ ok: true, running: true, activated: true, harness: "claude", respondTo: "anyone" }) };
      return { status: 200, body: JSON.stringify({ ok: true }) };
    } },
    agents: { register: (value) => { type = value; } },
  }, {
    sign: async () => { if (status !== "connected") throw new Error("Sign in to Black 4 first."); return { pass: "p" }; },
    access: { use: () => ({ status: "linked" }), link() {}, signIn: { use: () => status, Prompt } },
  });
  const ready = [];
  const form = React.createElement(type.CreateConfiguration, { config: hardwareDefaults(), onChange() {}, onReadyChange: (value) => ready.push(value), harnessControl: "type-picker" });
  let tree = await settleTree(form);
  assert.ok(has(tree, isPrompt), "the form shows Sign in");
  assert.match(treeText(tree), /type-picker/, "Buzz's own type picker stays");
  assert.doesNotMatch(treeText(tree), /Runs on|Could not reach/, "no machine controls that cannot work");
  assert.equal(ready.at(-1), false, "Create stays off");
  assert.deepEqual(asked, [], "nothing is asked of the machine while signed out");
  // The real sequence: signing in, then connecting, then connected.
  for (const step of ["signing-in", "starting"]) {
    status = step;
    tree = await settleTree(form);
    assert.deepEqual(asked, [], `${step}: the machine is not asked before Black 4 is connected`);
  }
  status = "connected";
  tree = await settleTree(form);
  assert.equal(has(tree, isPrompt), false, "signed in: the form is back");
  assert.match(treeText(tree), /Runs on/);
  assert.ok(asked.includes("machine.status"), "and reads the machine at once");
  assert.equal(ready.at(-1), true);

  status = "signed-out";
  const settingsTab = React.createElement(type.tabs[0].component, { agent: { pubkey: "a".repeat(64) }, settingsHost: { typeControl: () => null }, settingsContent: null });
  const before = asked.filter((op) => op === "status").length;
  tree = await settleTree(settingsTab);
  assert.ok(has(tree, isPrompt), "the agent's Settings shows Sign in");
  assert.doesNotMatch(treeText(tree), /Restart|Instructions|Checking/, "and nothing that needs the machine");
  assert.equal(asked.filter((op) => op === "status").length, before, "nothing is asked of the machine while signed out");
  status = "starting";
  tree = await settleTree(settingsTab);
  assert.equal(asked.filter((op) => op === "status").length, before, "nor while Black 4 is still connecting");
  status = "connected";
  tree = await settleTree(settingsTab);
  assert.equal(has(tree, isPrompt), false);
  assert.ok(asked.filter((op) => op === "status").length > before, "signed in again, it reads the agent again");
});

// ---- the sign-in kept on this computer ----

const KEY = "ai.black4.signin.v1:overjoyed-tea-41.authkit.app";
const tokenText = /access-\d|refresh-\d|device-code/;

test("a launch with a kept sign-in comes up signed in: no Sign in, no prompt, even on a new revision's first start", async (t) => {
  const device = deviceStorage(t);
  const first = await harness(t, { revision: "rev-1" });
  await settle();
  first.click("Sign in to Black 4");
  await first.connected();
  assert.match(JSON.parse(device.get(KEY)).refresh, /^refresh-\d+$/, "kept on this device");
  for (const revision of ["rev-1", "rev-2"]) {
    const launch = await harness(t, { revision, authkit: first.authkit });
    await launch.connected();
    assert.deepEqual(launch.opened, [], `${revision}: no Settings takeover`);
    assert.equal(button(launch.settings(), "Sign in to Black 4"), null);
    assert.equal(launch.authkit.calls.filter((call) => call.path === "/oauth2/device_authorization").length, 1, "no browser after the first sign-in");
  }
});

test("Sign out removes it from this device; the next launch is signed out", async (t) => {
  const device = deviceStorage(t);
  const app = await harness(t, { signedIn: true });
  await app.connected();
  assert.ok(device.has(KEY));
  app.click("Sign out");
  await settle();
  assert.equal(device.has(KEY), false);
  const launch = await harness(t);
  await settle();
  assert.ok(button(launch.settings(), "Sign in to Black 4"));
});

test("a kept sign-in that cannot be refreshed at launch (offline) stays kept and shows Not connected, not Sign in", async (t) => {
  const device = deviceStorage(t);
  const app = await harness(t, { signedIn: true, revision: "rev-9" });
  app.net.offline.add(AUTHKIT);
  await until(() => /Not connected/.test(text(app.settings())), { what: "offline" });
  assert.equal(button(app.settings(), "Sign in to Black 4"), null);
  assert.deepEqual(app.opened, [], "no prompt");
  assert.equal(app.badge(), null, "no Sign in dot");
  assert.ok(device.has(KEY), "kept");
  app.net.offline.clear();
  app.click("Try again");
  await app.connected();
});

test("a kept sign-in refused at launch is removed and shown in place with its reason; no Settings takeover", async (t) => {
  const device = deviceStorage(t);
  device.set(KEY, JSON.stringify({ v: 1, refresh: "refresh-revoked" }));
  const app = await harness(t, { revision: "rev-1" });
  await until(() => button(app.settings(), "Sign in to Black 4"), { what: "signed out" });
  assert.equal(device.has(KEY), false);
  assert.deepEqual(app.opened, [], "a launch never opens Settings for it");
  assert.match(text(app.settings()), /sign-in ended/i);
  assert.match(app.badge().props["aria-label"], /sign-in ended/i);
});

test("Sign in uses a sign-in another window kept meanwhile, with no browser", async (t) => {
  const device = deviceStorage(t);
  const app = await harness(t);
  await settle();
  device.set(KEY, JSON.stringify({ v: 1, refresh: app.authkit.issue().refresh_token })); // another window signed in
  app.click("Sign in to Black 4");
  await app.connected();
  assert.equal(app.authkit.calls.filter((call) => call.path === "/oauth2/device_authorization").length, 0, "no device sign-in");
});

// ---- approving the sign-in again (renew_signin): Platform Control's limits ----

const PUBKEY = "a".repeat(64);
const hardwareForm = (app) => expand({ type: app.regs.hardware.CreateConfiguration, props: { config: {}, onChange() {}, harnessControl: "type-picker" }, children: [] });
const renewCalls = (app) => app.mcp.renew.calls;

test("hardware: signin_approval_required (directly or through call_tool) offers Approve in place; renew_signin approves and the read works again", async (t) => {
  const device = deviceStorage(t);
  const app = await harness(t, { signedIn: true });
  await app.connected();
  await until(() => app.regs.hardware, { timeoutMs: 6000, what: "the hardware type (staff)" });
  const hardware = app.regs.hardware;
  assert.equal(button(hardwareForm(app), "Approve in browser"), null, "nothing to approve until Black 4 asks");
  assert.equal(await hardware.remote.instructions.get({ pubkey: PUBKEY }), "Be brief.", "passes work as before");
  assert.ok(app.mcp.calls.some((call) => call.params?.name === "call_tool" && call.params.arguments?.name === "sign_hardware_request"), "the pass went through call_tool, the server's error shape included");

  app.mcp.approvalRequired = true;
  const kept = device.get(KEY);
  await assert.rejects(hardware.remote.instructions.get({ pubkey: PUBKEY }), /needs your approval in your browser/);
  assert.match(text(app.settings()), /Status Connected/, "not signed out");
  assert.deepEqual(app.opened, [], "no Settings takeover");
  assert.ok(button(hardwareForm(app), "Approve in browser"));
  assert.equal(button(app.panel(), "Approve in browser"), null, "a hardware approval shows only where hardware is");

  app.click("Approve in browser", hardwareForm(app));
  await until(() => /RNEW-CODE/.test(text(hardwareForm(app))), { timeoutMs: 6000, what: "the approval code" });
  assert.deepEqual(renewCalls(app)[0], {}, "renew_signin started with no input");
  const big = find(hardwareForm(app), isCode);
  assert.deepEqual(big.children, ["RNEW-CODE"], "the code, large");
  assert.ok(button(hardwareForm(app), "Copy code"));
  assert.equal(find(hardwareForm(app), (n) => n.type === "a").props.href, `${AUTHKIT}/device?user_code=RNEW-CODE`);
  await until(() => /Runs on/.test(text(hardwareForm(app))), { timeoutMs: 6000, what: "approved: the form is back" });
  assert.match(renewCalls(app)[1].approvalId, /^ssa_/, "polled with its approvalId");
  assert.equal(device.get(KEY), kept, "the kept sign-in is untouched");
  assert.equal(app.authkit.calls.filter((call) => call.path === "/oauth2/device_authorization").length, 0, "no device sign-in: renew_signin does it");
  assert.equal(await hardware.remote.instructions.get({ pubkey: PUBKEY }), "Be brief.", "retried, it works");
});

test("idle (HTTP 403 signin_idle): signed in still, every surface offers Approve; approving reconnects; the kept sign-in stays", async (t) => {
  const device = deviceStorage(t);
  const app = await harness(t, { signedIn: true, browser: false });
  await app.connected();
  const kept = device.get(KEY);
  app.mcp.idle = true;
  app.click("Reconnect");
  await until(() => button(app.settings(), "Approve in browser"), { timeoutMs: 6000, what: "idle" });
  for (const view of [app.settings(), app.panel(), app.preview(), app.workspace()]) {
    assert.ok(button(view, "Approve in browser"), "the same action everywhere");
    assert.equal(button(view, "Sign in to Black 4"), null, "not signed out");
  }
  assert.ok(button(app.settings(), "Sign out"), "Sign out stays possible");
  assert.match(app.badge().props["aria-label"], /Approve your Black 4 sign-in/);
  assert.equal(device.get(KEY), kept, "kept");
  assert.deepEqual(app.opened, []);
  await assert.rejects(app.tools.get("black4_whoami").call({}, {}, {}), /Approve in browser/, "agents are told what the person does");

  app.click("Approve in browser", app.preview());
  await until(() => /RNEW-CODE/.test(text(app.preview())), { timeoutMs: 6000, what: "the code in the preview" });
  assert.match(text(app.preview()), /Confirm\s+RNEW-CODE\s+in your browser/, "compact: one line");
  assert.match(text(app.settings()), /RNEW-CODE/, "the same approval in Settings");
  await app.connected();
  assert.equal(button(app.settings(), "Approve in browser"), null);
  assert.equal(device.get(KEY), kept);
  assert.ok(renewCalls(app).length >= 2);
});

test("an idle sign-in at launch comes up waiting for approval, not signed out", async (t) => {
  const device = deviceStorage(t);
  const authkit = fakeAuthKit({ interval: 0.02 });
  device.set(KEY, JSON.stringify({ v: 1, refresh: authkit.issue().refresh_token }));
  const app = await harness(t, { authkit, revision: "rev-1" });
  app.mcp.idle = true;
  await until(() => button(app.settings(), "Approve in browser"), { timeoutMs: 6000, what: "idle at launch" });
  assert.match(text(app.settings()), /Approve in browser/);
  assert.ok(device.has(KEY));
  assert.deepEqual(app.opened, [], "no first-start prompt");
});

test("renew_signin's endings: declined, expired, someone else, unavailable (retried), not needed; Cancel; each leaves the person signed in", async (t) => {
  deviceStorage(t);
  const cases = [
    { polls: ["denied"], says: /declined/ },
    { polls: ["expired"], says: /expired/ },
    { polls: ["signin_approval_mismatch"], says: /different account/ },
    { polls: ["signin_approval_unavailable", "approved"], done: true },
    { start: "signin_approval_not_needed", done: true },
    { start: "signin_approval_unavailable", says: /Try again|try again/i },
  ];
  for (const [i, { polls, start, says, done }] of cases.entries()) {
    const app = await harness(t, { signedIn: true, revision: `r${i}` });
    await app.connected();
    await until(() => app.regs.hardware, { timeoutMs: 6000, what: "hardware" });
    app.mcp.approvalRequired = true;
    Object.assign(app.mcp.renew, polls ? { polls } : {}, start ? { start } : {});
    await assert.rejects(app.regs.hardware.remote.instructions.get({ pubkey: PUBKEY }));
    app.click("Approve in browser", hardwareForm(app));
    if (done) await until(() => !button(hardwareForm(app), "Approve in browser") && !/Approving|RNEW-CODE/.test(text(hardwareForm(app))), { timeoutMs: 6000, what: `case ${i} done` });
    else await until(() => button(hardwareForm(app), "Approve in browser") && says.test(text(hardwareForm(app))), { timeoutMs: 6000, what: `case ${i}: ${says}` });
    assert.match(text(app.settings()), /Status Connected/, `case ${i}: still signed in`);
    app.click("Sign out");
    await settle();
  }
  const app = await harness(t, { signedIn: true, revision: "cancel" });
  await app.connected();
  await until(() => app.regs.hardware, { timeoutMs: 6000, what: "hardware" });
  app.mcp.approvalRequired = true;
  app.mcp.renew.polls = ["pending"];
  await assert.rejects(app.regs.hardware.remote.instructions.get({ pubkey: PUBKEY }));
  app.click("Approve in browser", hardwareForm(app));
  await until(() => /RNEW-CODE/.test(text(hardwareForm(app))), { timeoutMs: 6000, what: "waiting" });
  app.click("Cancel", hardwareForm(app));
  await settle();
  assert.ok(button(hardwareForm(app), "Approve in browser"), "Cancel brings back Approve");
  const asked = renewCalls(app).length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(renewCalls(app).length, asked, "and stops asking");
});

test("today's server, without renew_signin: nothing changes until it is needed, and then it says so plainly", async (t) => {
  deviceStorage(t);
  const app = await harness(t, { signedIn: true });
  app.mcp.renew.supported = false;
  await app.connected();
  await until(() => app.regs.hardware, { timeoutMs: 6000, what: "hardware" });
  assert.equal(await app.regs.hardware.remote.instructions.get({ pubkey: PUBKEY }), "Be brief.");
  assert.deepEqual(renewCalls(app), [], "never asked unprompted");
  app.mcp.approvalRequired = true; // only a server with the limits sends this; tolerate one anyway
  await assert.rejects(app.regs.hardware.remote.instructions.get({ pubkey: PUBKEY }));
  app.click("Approve in browser", hardwareForm(app));
  await until(() => /can't approve sign-ins yet/.test(text(hardwareForm(app))), { timeoutMs: 6000, what: "unsupported" });
  assert.match(text(app.settings()), /Status Connected/);
});

test("the approval error keeps its code and its own sentence through the door", async (t) => {
  deviceStorage(t);
  const app = await harness(t, { signedIn: true });
  await app.connected();
  await until(() => app.regs.hardware, { timeoutMs: 6000, what: "hardware" });
  app.mcp.approvalRequired = true;
  const error = await app.regs.hardware.remote.instructions.get({ pubkey: PUBKEY }).then(() => null, (failure) => failure);
  assert.match(error.message, /^Black 4 hardware needs your approval in your browser\.$/, "not wrapped as 'could not get a pass'");
  const { doorTransport } = app.plugin;
  const ask = doorTransport({ request: async () => { throw new Error("never reached"); }, sign: async () => { throw Object.assign(new Error("Black 4 hardware needs your approval in your browser."), { code: "approval" }); } });
  await assert.rejects(ask({ id: "commerce", label: "Commerce Mac", door: "https://door.example.test" }, { op: "status" }), (failure) => failure.code === "approval" && !/could not get a pass/.test(failure.message));
});

test("idle, then signed out elsewhere or refused during Approve: Approve becomes Sign in, never offered forever", async (t) => {
  const device = deviceStorage(t);
  const app = await harness(t, { signedIn: true });
  await app.connected();
  app.mcp.idle = true;
  app.click("Reconnect");
  await until(() => button(app.settings(), "Approve in browser"), { timeoutMs: 6000, what: "idle" });
  // Another window signs out: the disk is emptied, and the grant is gone.
  device.delete(KEY);
  app.authkit.refresh.clear();
  app.authkit.access.clear();
  app.click("Approve in browser");
  await until(() => button(app.settings(), "Sign in to Black 4"), { timeoutMs: 6000, what: "Sign in" });
  assert.equal(button(app.settings(), "Approve in browser"), null);
  assert.deepEqual(app.opened, [], "signed out elsewhere: no prompt");
});

test("Cancel, then Approve again resumes the same approval (no second browser approval); approved after Cancel still counts", async (t) => {
  deviceStorage(t);
  const app = await harness(t, { signedIn: true });
  await app.connected();
  await until(() => app.regs.hardware, { timeoutMs: 6000, what: "hardware" });
  app.mcp.approvalRequired = true;
  app.mcp.renew.polls = ["pending"];
  await assert.rejects(app.regs.hardware.remote.instructions.get({ pubkey: PUBKEY }));
  app.click("Approve in browser", hardwareForm(app));
  await until(() => /RNEW-CODE/.test(text(hardwareForm(app))), { timeoutMs: 6000, what: "waiting" });
  app.click("Cancel", hardwareForm(app));
  await settle();
  const starts = () => renewCalls(app).filter((call) => !call.approvalId).length;
  assert.equal(starts(), 1);
  app.click("Approve in browser", hardwareForm(app));
  await until(() => /RNEW-CODE/.test(text(hardwareForm(app))), { timeoutMs: 6000, what: "resumed" });
  assert.equal(starts(), 1, "resumed: the same approval, not a new one");
  app.click("Cancel", hardwareForm(app));
  // The person approves in the browser right after Cancel.
  app.mcp.renew.polls = ["approved"];
  app.click("Approve in browser", hardwareForm(app));
  await until(() => /Runs on/.test(text(hardwareForm(app))), { timeoutMs: 6000, what: "accepted" });
  assert.equal(starts(), 1, "the earlier approval counted");
});

test("an in-flight answer of approved that arrives after Cancel is accepted", async (t) => {
  deviceStorage(t);
  const app = await harness(t, { signedIn: true });
  await app.connected();
  await until(() => app.regs.hardware, { timeoutMs: 6000, what: "hardware" });
  app.mcp.approvalRequired = true;
  await assert.rejects(app.regs.hardware.remote.instructions.get({ pubkey: PUBKEY }));
  app.mcp.renew.polls = ["approved"];
  app.mcp.renew.interval = 0.15;
  const handle = app.mcp.handle;
  let hold;
  app.mcp.handle = async (input) => {
    const body = JSON.parse(input.body);
    if (body.params?.name === "renew_signin" && body.params.arguments?.approvalId) await new Promise((resolve) => { hold = resolve; });
    return handle(input);
  };
  app.click("Approve in browser", hardwareForm(app));
  await until(() => typeof hold === "function", { timeoutMs: 6000, what: "a poll in flight" });
  app.click("Cancel", hardwareForm(app));
  hold();
  await until(() => /Runs on/.test(text(hardwareForm(app))), { timeoutMs: 6000, what: "accepted after Cancel" });
});

test("idle approved in another window: pressing Approve notices with one request and reconnects, no browser", async (t) => {
  deviceStorage(t);
  const app = await harness(t, { signedIn: true });
  await app.connected();
  app.mcp.idle = true;
  app.click("Reconnect");
  await until(() => button(app.settings(), "Approve in browser"), { timeoutMs: 6000, what: "idle" });
  app.mcp.idle = false; // approved elsewhere
  app.click("Approve in browser");
  await app.connected();
  assert.deepEqual(renewCalls(app), [], "no new approval started");
});

test("coming back to the window looks again: idle approved elsewhere reconnects; a hardware approval re-reads", async (t) => {
  deviceStorage(t);
  const listeners = new Map();
  const previous = { add: globalThis.addEventListener, remove: globalThis.removeEventListener };
  globalThis.addEventListener = (name, fn) => listeners.set(name, fn);
  globalThis.removeEventListener = (name) => listeners.delete(name);
  t.after(() => { globalThis.addEventListener = previous.add; globalThis.removeEventListener = previous.remove; });
  const app = await harness(t, { signedIn: true });
  await app.connected();
  app.mcp.idle = true;
  app.click("Reconnect");
  await until(() => button(app.settings(), "Approve in browser"), { timeoutMs: 6000, what: "idle" });
  app.mcp.idle = false;
  listeners.get("focus")();
  await app.connected();
  assert.deepEqual(renewCalls(app), []);
});

test("agents never see or call renew_signin, directly or through call_tool", async (t) => {
  deviceStorage(t);
  const app = await harness(t, { signedIn: true });
  await app.connected();
  assert.equal(app.tools.has("black4_renew_signin"), false);
  await assert.rejects(app.tools.get("black4_call_tool").call({}, {}, { name: "renew_signin", arguments: {} }), /Agents cannot renew/);
  assert.deepEqual(renewCalls(app), []);
});

test("nothing token-like reaches the state, the rendered surfaces or the hardware form", async (t) => {
  deviceStorage(t);
  const app = await harness(t, { signedIn: true });
  await app.connected();
  await until(() => app.regs.hardware, { what: "the hardware type" });
  const views = [app.settings(), app.panel(), app.preview(), app.workspace(), app.badge(), expand({ type: app.regs.hardware.CreateConfiguration, props: { config: {}, onChange() {} }, children: [] })];
  for (const view of views) assert.doesNotMatch(JSON.stringify(view ?? null), tokenText);
  app.mcp.approvalRequired = true;
  await assert.rejects(app.regs.hardware.remote.instructions.get({ pubkey: "a".repeat(64) }));
  assert.doesNotMatch(JSON.stringify(expand({ type: app.regs.hardware.CreateConfiguration, props: { config: {}, onChange() {} }, children: [] })), tokenText);
});
