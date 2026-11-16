// Signing in to Black 4 from wherever the person is: the one prompt Buzz opens
// (Settings → Black 4, via ctx.navigation.open), when it opens and when it
// never does, and what each surface shows signed out, signing in, signed in
// and after a sign-in ended. Real components, rendered with a stand-in React.
import assert from "node:assert/strict";
import test from "node:test";
import { fakeAuthKit, fakeMcp, https, freshPlugin, settle, until, AUTHKIT } from "./fakes.mjs";

const REVIEW = "https://app.black4.ai/r/rv_example?item=hero&v=3";
const QUEUE = "https://app.black4.ai/reviews";
const SECTION = "ai.black4/connection";

const whoami = (message) => message.method === "tools/list"
  ? { result: { tools: [{ name: "whoami", inputSchema: { type: "object" } }, { name: "review_queue", inputSchema: { type: "object" } }] } }
  : message.params?.name === "whoami" ? { result: { content: [{ type: "text", text: JSON.stringify({ data: { kind: "staff", email: "person@example.test" } }) }] } }
    : message.params?.name === "review_queue" ? { result: { content: [{ type: "text", text: JSON.stringify({ kind: "black4_review_queue", total: 0, reviews: [] }) }] } }
      : { result: { content: [{ type: "text", text: "{}" }] } };

/** The plugin on a test host. `module` reuses a plugin module (one Buzz run)
 * across harnesses; `opens` scripts what navigation.open answers. */
async function harness(t, { signedIn = false, polls = ["authorization_pending", "authorization_pending", "authorization_pending", "ok"], module, browser = true, opens = () => ({ status: "opened" }), owner, relay = true } = {}) {
  const plugin = module ?? await freshPlugin();
  const authkit = fakeAuthKit({ polls, interval: 0.02 });
  const mcp = fakeMcp(authkit, { answer: whoami });
  const net = https({ authkit, mcp });
  if (signedIn) await plugin.signInMemory.save(authkit.issue().refresh_token);
  const opened = [];
  const regs = {};
  const relayListeners = new Set();
  const cleanups = [];
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children });
  const ctx = {
    react: { createElement: h, useState: (v) => [typeof v === "function" ? v() : v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }), Component: class { constructor(props) { this.props = props; } } },
    agents: { snapshot: () => ({ running: [] }), addTool: () => () => {}, register: () => {} },
    settingsCards: { register: (value) => { regs.card = value; } },
    pages: { register: (value) => { regs.page = value; } },
    panels: { register: (value) => { regs.panel = value; } },
    conversation: { registerLink() {}, registerLinkPreview: (value) => { regs.preview = value; } },
    browser: { available: browser, View: "browser-view" },
    navigation: { open: async (target) => { opened.push(target); return opens(opened.length); } },
    effect: (fn) => { const off = fn(); if (off) cleanups.push(off); },
    host: { request: net.request },
    ...(owner ? { pluginOwner: { id: owner, revision: "test" } } : {}),
    ...(relay ? { relay: { snapshot: () => ({ status: "ready", viewer: null, session: {} }), subscribe: (listener) => { relayListeners.add(listener); return () => relayListeners.delete(listener); } } } : {}),
  };
  plugin.apply(ctx);
  t.after(() => { for (const off of cleanups.reverse()) off(); });
  const settings = () => expand(regs.card.component());
  return {
    plugin, authkit, mcp, opened, regs,
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
const button = (node, label) => find(node, (n) => n.type === "button" && texts(n).join("") === label);
const text = (node) => texts(node).join(" ");

// ---- the prompt: when Buzz opens Settings → Black 4 ----

test("installed and enabled while signed out: Buzz opens Settings → Black 4 once, at its Sign in", async (t) => {
  const app = await harness(t);
  await settle();
  assert.deepEqual(app.opened, [{ version: 1, kind: "settings", section: SECTION }]);
  const signIn = button(app.settings(), "Sign in to Black 4");
  assert.ok(signIn, "the card is the one action");
  assert.equal(signIn.props.autoFocus, true, "focused, so Return signs in");
  assert.equal(signIn.props.className, "b4-go", "the primary button");
  await app.communityChanged();
  assert.equal(app.opened.length, 1, "dismissed, it does not come back in this run");
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

test("an open that never showed (failed or superseded) is tried again on the next community change", async (t) => {
  for (const status of ["failed", "superseded"]) {
    const app = await harness(t, { opens: (n) => ({ status: n === 1 ? status : "opened" }) });
    await settle();
    assert.equal(app.opened.length, 1);
    await app.communityChanged();
    assert.equal(app.opened.length, 2, `${status}: tried again`);
    await app.communityChanged();
    assert.equal(app.opened.length, 2, "and once shown, not again");
  }
});

test("Sign out, Cancel, an expired code and a declined sign-in never open Settings", async (t) => {
  const app = await harness(t, { signedIn: true, polls: ["authorization_pending"] });
  await app.connected();
  app.click("Sign out");
  await settle();
  assert.deepEqual(app.opened, [], "Sign out is the person's own choice");
  app.click("Sign in to Black 4");
  await app.waitingForCode();
  app.click("Cancel");
  await settle();
  assert.deepEqual(app.opened, [], "Cancel");
  for (const poll of ["expired_token", "access_denied"]) {
    app.authkit.polls = [poll];
    app.click("Sign in to Black 4");
    await until(() => button(app.settings(), "Sign in to Black 4") && /expired|declined/.test(text(app.settings())), { what: poll });
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
  const code = find(view, (n) => n.props?.className === "b4-code");
  assert.deepEqual(code.children, ["WDJB-MJHT"]);
  assert.ok(button(view, "Copy"), "copy the code");
  const link = find(view, (n) => n.type === "a");
  assert.equal(link.props.href, `${AUTHKIT}/device?user_code=WDJB-MJHT`, "the page can be opened again");
  assert.equal(link.props.target, "_blank");
  assert.match(text(view), /Confirm it in your browser/);
  assert.ok(button(view, "Cancel"));
  assert.equal(find(view, (n) => n.type === "form"), null, "never a form");
  await app.connected();
  assert.equal(find(app.settings(), (n) => n.props?.className === "b4-code"), null, "the card turns signed in by itself");
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
  assert.equal(find(app.preview(), (n) => n.props?.className === "b4-code"), null, "no large code in a preview");
  assert.match(text(app.settings()), /WDJB-MJHT/, "the same sign-in shows in Settings");
});

test("signed out with the embedded inbox: Sign in sits above it, and signing in keeps the inbox in place", async (t) => {
  const app = await harness(t);
  await settle();
  let view = app.workspace();
  assert.ok(button(view.children[0], "Sign in to Black 4"), "a bar above the inbox");
  assert.equal(view.children[1].children[0].type, "browser-view");
  app.click("Sign in to Black 4", view);
  await app.waitingForCode();
  assert.match(text(app.workspace().children[0]), /Confirm\s+WDJB-MJHT\s+in your browser/);
  await app.connected();
  view = app.workspace();
  assert.equal(view.children[0], null, "signed in: the bar is gone");
  assert.equal(view.children[1].children[0].type, "browser-view", "the inbox kept its place");
});

test("the Reviews dock entry carries a dot while signed out, and the count once signed in", async (t) => {
  const app = await harness(t);
  await settle();
  const dot = app.badge();
  assert.equal(dot.props["aria-label"], "Sign in to Black 4");
  assert.equal(dot.props.title, "Sign in to Black 4");
  assert.deepEqual(dot.children, []);
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
  }
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
    useEffect(effect, deps) {
      const key = `${path}:${index++}`;
      const before = slots.get(key);
      if (!before || !deps || deps.some((dep, i) => dep !== before[i])) { slots.set(key, deps ?? []); effects.push(effect); }
    },
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
  for (const step of ["signing-in", "connected"]) {
    status = step;
    tree = await settleTree(form);
  }
  assert.equal(has(tree, isPrompt), false, "signed in: the form is back");
  assert.match(treeText(tree), /Runs on/);
  assert.ok(asked.includes("machine.status"), "and reads the machine at once");
  assert.equal(ready.at(-1), true);

  status = "signed-out";
  const settingsTab = React.createElement(type.tabs[0].component, { agent: { pubkey: "a".repeat(64) }, settingsHost: { typeControl: () => null }, settingsContent: null });
  tree = await settleTree(settingsTab);
  assert.ok(has(tree, isPrompt), "the agent's Settings shows Sign in");
  const before = asked.filter((op) => op === "status").length;
  status = "connected";
  tree = await settleTree(settingsTab);
  assert.equal(has(tree, isPrompt), false);
  assert.ok(asked.filter((op) => op === "status").length > before, "signed in again, it reads the agent again");
});
