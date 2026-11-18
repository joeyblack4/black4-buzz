// The Black 4 MCP tools, Reviews and the connection lifecycle, over fake
// AuthKit and MCP servers behind host.request: no process, no network.
import assert from "node:assert/strict";
import test from "node:test";
import { fakeAuthKit, fakeMcp, https, freshPlugin, settle, MCP } from "./fakes.mjs";

const { reviewUrl } = await freshPlugin();
const tools = ["whoami", "resolve_channel_business", "open_review"].map((name) => ({
  name, description: name, inputSchema: { type: "object", required: ["channelId"] },
}));

/** A deferred answer: `hold()` returns a promise the test releases later. */
function gate() {
  const held = [];
  return { held, hold: (value) => new Promise((resolve) => held.push({ resolve, value })), release: (value) => { for (const entry of held.splice(0)) entry.resolve(value ?? entry.value); } };
}

async function harness(t, options = {}) {
  const { apply, signInStore } = await freshPlugin();
  const registered = new Map();
  const authkit = fakeAuthKit();
  const held = gate();
  const mcp = fakeMcp(authkit, {
    answer: (message) => {
      if (message.method === "tools/list") return { result: { tools: options.tools ?? tools } };
      const name = message.params?.name;
      if (name === "whoami") return { result: { content: [{ type: "text", text: '{"kind":"staff","email":"operator@example.test"}' }] } };
      if (options.holdCalls && message.method === "tools/call") return held.hold({ result: { content: [{ type: "text", text: "late" }] } });
      if (name === "review_queue" && options.queue) return { result: typeof options.queue === "function" ? options.queue() : options.queue };
      return { result: { content: [{ type: "text", text: "readable result" }], _meta: { decisionToken: "hidden-token" } } };
    },
  });
  const net = https({ authkit, mcp, offline: options.offline ?? new Set() });
  const request = async (input) => { await options.beforeRequest?.(input); return net.request(input); };
  if (options.signedIn !== false) await signInStore.save(authkit.issue().refresh_token);
  let cleanup;
  let card;
  let panel;
  let page;
  let link;
  let preview;
  // Children sit in props as well, as React keeps them, for components that render their children.
  const h = (type, props, ...children) => { const kids = children.flat(); return { type, props: { ...(props ?? {}), children: kids }, children: kids }; };
  const ctx = {
    react: { createElement: h, useState: (v) => [typeof v === "function" ? v() : v, () => {}], useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }), useId: (() => { let n = 0; return () => `id-${++n}`; })(), Component: class {} },
    agents: {
      snapshot: () => ({ running: [{ key: "agent", relay: "wss://example.test" }] }),
      addTool: (tool) => { registered.set(tool.name, tool); return () => registered.delete(tool.name); },
      register: () => {},
    },
    settingsCards: { register: (value) => { card = value; } },
    pages: { register: value => { page = value; } },
    panels: { register: (value) => { panel = value; } },
    conversation: { registerLink: (value) => { link = value; }, registerLinkPreview: (value) => { preview = value; } },
    browser: { available: options.browserAvailable ?? true, View: "browser-view" },
    effect: (fn) => { const off = fn(); if (off) cleanup = cleanup ? ((a, b) => () => { b(); a(); })(cleanup, off) : off; },
    host: { request },
  };
  apply(ctx);
  let stopped = false;
  const stop = () => { if (!stopped) { stopped = true; cleanup?.(); } };
  t.after(stop);
  const settings = () => expandAll(card.component());
  return {
    registered, mcp, authkit, net, held, page, panel, link, preview, stop, settings,
    reconnect: () => button(settings(), "Reconnect").props.onClick(),
  };
}

// Mount every component element, the way a host would.
const expandAll = (node) => {
  if (!node || typeof node !== "object") return node;
  if (typeof node.type === "function") return expandAll(node.type.prototype?.render ? new node.type(node.props).render() : node.type(node.props));
  return { ...node, children: (node.children ?? []).map(expandAll) };
};
const calls = (mcp, method) => mcp.calls.filter((call) => call.method === method);
const h_queue = (app) => app.mcp.calls.filter((call) => call.params?.name === "review_queue");

const queueText = (queue) => ({ content: [{ type: "text", text: JSON.stringify({ kind: "black4_review_queue", reviews: [], ...queue }) }] });
/** All the text inside a node (a Buzz button keeps its label in a span). */
const textOf = (node) => typeof node === "string" ? node : !node || typeof node !== "object" ? "" : (node.children ?? node.props?.children ?? []).map(textOf).join("");
function button(node, text) {
  if (!node || typeof node !== "object") return;
  if (node.type === "button" && (text === undefined || textOf(node) === text)) return node;
  for (const child of node.children ?? []) { const found = button(child, text); if (found) return found; }
}
// Mount an element whose type is a component, the way a React host would, one level deep.
const render = (element) => (typeof element?.type === "function" ? element.type(element.props) : element);

test("review links preserve exact item/version and refuse unrelated or deceptive destinations", () => {
  const url = "https://app.black4.ai/r/rv_example?item=hero&v=3";
  assert.equal(reviewUrl(url), url);
  assert.equal(reviewUrl("https://app.black4.ai/reviews?business=example"), "https://app.black4.ai/reviews?business=example");
  for (const bad of ["http://app.black4.ai/r/a", "https://app.black4.ai.evil.test/r/a", "https://app.black4.ai@evil.test/r/a", "https://person@app.black4.ai/r/a", "https://review.black4.ai/v/grant/a", "https://app.black4.ai/settings", "https://app.black4.ai:444/r/a", "https://app.black4.ai/r/a/other", null]) assert.equal(reviewUrl(bad), null);
});

test("signed in, it initializes the MCP over HTTPS with the bearer and registers every listed tool", async (t) => {
  const h = await harness(t);
  await settle();
  assert.deepEqual([...h.registered.keys()], tools.map((tool) => `black4_${tool.name}`));
  assert.deepEqual(h.mcp.calls.slice(0, 3).map((call) => call.method), ["initialize", "notifications/initialized", "tools/list"]);
  assert.match(h.registered.get("black4_whoami").description, /People decide/);
  assert.ok(h.mcp.tokens.every((token) => /^access-/.test(token)), "every MCP request carries the access token");
  assert.ok(h.net.requests.every((entry) => [MCP, "https://overjoyed-tea-41.authkit.app"].includes(entry.origin)));
});

test("a forgotten MCP session is opened again and the call still answers", async (t) => {
  const h = await harness(t);
  await settle();
  h.mcp.sessions.clear(); // the server restarted
  const value = await h.registered.get("black4_open_review").call({}, {}, {});
  assert.equal(value, "readable result");
  assert.equal(calls(h.mcp, "initialize").length, 2);
});

test("signed out, nothing reaches the MCP and the card offers Sign in", async (t) => {
  const h = await harness(t, { signedIn: false });
  await settle();
  assert.equal(h.mcp.calls.length, 0);
  assert.equal(h.registered.size, 0);
  assert.ok(button(h.settings(), "Sign in to Black 4"));
});

test("defaults channel binding to the calling agent's channel and relay", async (t) => {
  const h = await harness(t);
  await settle();
  const tool = h.registered.get("black4_resolve_channel_business");
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, []);
  const controller = new AbortController();
  await tool.call({ key: "agent", signal: controller.signal }, { channel: "channel-a" }, {});
  assert.deepEqual(h.mcp.calls.at(-1).params.arguments, { channelId: "channel-a", communityId: "relay:wss://example.test/" });
});

test("keeps private MCP metadata out of agent results and removes abort listeners", async (t) => {
  const h = await harness(t);
  await settle();
  const controller = new AbortController();
  let listeners = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { listeners++; return add(...args); };
  controller.signal.removeEventListener = (...args) => { listeners--; return remove(...args); };
  const value = await h.registered.get("black4_open_review").call({ signal: controller.signal }, {}, {});
  assert.equal(value, "readable result");
  assert.equal(listeners, 0);
});

test("agents can never mint a hardware pass: not offered, and refused directly or through call_tool", async (t) => {
  const listed = [...tools, ...["call_tool", "sign_hardware_request"].map((name) => ({ name, description: name, inputSchema: { type: "object" } }))];
  const h = await harness(t, { tools: listed });
  await settle();
  assert.ok(h.registered.has("black4_call_tool"));
  assert.equal(h.registered.has("black4_sign_hardware_request"), false, "never offered to agents");
  const input = { machine: "commerce", op: "list", bodySha256: "x".repeat(43) };
  for (const args of [
    { name: "sign_hardware_request", arguments: input },
    { name: " Sign_Hardware_Request ", arguments: input },
    { name: "call_tool", arguments: { name: "sign_hardware_request", arguments: input } },
  ]) {
    await assert.rejects(h.registered.get("black4_call_tool").call({ key: "agent" }, {}, args), /Agents cannot mint Black 4 hardware passes/);
  }
  // (The plugin's own hardware provider may mint passes for its requests; none for the agent's.)
  assert.equal(h.mcp.calls.filter((call) => JSON.stringify(call).includes(input.bodySha256)).length, 0, "nothing the agent asked for reached Black 4");
  assert.equal(h.mcp.signed.filter((entry) => entry.bodySha256 === input.bodySha256).length, 0);
  assert.equal(await h.registered.get("black4_call_tool").call({ key: "agent" }, {}, { name: "open_review", arguments: {} }), "readable result", "other tools still pass");
});

test("Black 4 out of reach is a retry with the reason, and no tools", async (t) => {
  const h = await harness(t, { offline: new Set([MCP]) });
  await settle();
  assert.equal(h.registered.size, 0);
  const text = JSON.stringify(h.settings());
  assert.match(text, /Not connected/);
  assert.match(text, /Could not reach Black 4 \(error sending request: connection refused\)\. Retrying in 5s\./);
  assert.doesNotMatch(text, /access-|refresh-/, "no token in anything shown");
});

test("turning the plugin off while it connects leaves no tools behind", async (t) => {
  let release;
  const h = await harness(t, { beforeRequest: (input) => input.url.startsWith(MCP) && !release ? new Promise((resolve) => { release = resolve; }) : undefined });
  await settle();
  h.stop();
  release();
  await settle();
  assert.equal(h.registered.size, 0);
});

test("Try again supersedes a connection still starting, without a stale session", async (t) => {
  let release;
  const h = await harness(t, { beforeRequest: (input) => input.url.startsWith(MCP) && !release ? new Promise((resolve) => { release = resolve; }) : undefined });
  await settle();
  button(h.settings(), "Try again").props.onClick();
  await settle();
  release();
  await settle();
  assert.equal(h.registered.size, 3);
  assert.equal(calls(h.mcp, "tools/list").length, 1, "the superseded start never listed tools");
});

test("Stop ends an in-flight call for the agent, and its late answer goes nowhere", async (t) => {
  const h = await harness(t, { holdCalls: true });
  await settle();
  const controller = new AbortController();
  const call = h.registered.get("black4_open_review").call({ signal: controller.signal }, {}, {});
  await settle();
  controller.abort();
  await assert.rejects(call, /Stopped/);
  h.held.release();
  await settle();
});

test("the Reviews badge shows the connected account's waiting count and clears on disconnect", async t => {
  let total = 3;
  const app = await harness(t, { queue: () => queueText({ total }) });
  await settle();
  assert.deepEqual(app.page.badge().children, ["3"]);
  assert.match(app.page.badge().props["aria-label"], /3 decisions waiting for the connected Black 4 account/);
  assert.equal(app.page.badge().props.className, "buzz-count-badge", "Buzz's count badge");
  assert.equal(h_queue(app).length, 1, "one queue read per refresh");
  app.reconnect();
  assert.equal(app.page.badge(), null, "a reconnect clears the count before the new account answers");
  total = 7;
  await settle();
  assert.deepEqual(app.page.badge().children, ["7"]);
  app.stop();
  assert.equal(app.page.badge(), null);
});

test("the Reviews badge hides after a failed refresh and ignores an answer from a replaced connection", async t => {
  const app = await harness(t, { holdCalls: true });
  await settle();
  assert.equal(app.page.badge(), null);
  assert.ok(h_queue(app).length, "the badge asks the queue once connected");
  app.reconnect();
  app.held.release({ result: queueText({ total: 42 }) });
  await settle();
  assert.equal(app.page.badge(), null, "the old connection's answer never reaches the badge");
  const failing = await harness(t, { queue: { isError: true, content: [{ type: "text", text: "queue unavailable" }] } });
  await settle();
  assert.equal(failing.page.badge(), null);
  assert.equal(failing.registered.size, tools.length, "a failed queue read does not disturb the agent tools");
});


test("Reviews registers its panel, link chip and message card without reading or deciding anything", async (t) => {
  const h = await harness(t);
  await settle();
  const before = h.mcp.calls.length;
  const url = "https://app.black4.ai/r/rv_example?item=hero&v=3";
  assert.equal(h.panel.matches(url), true);
  assert.equal(h.panel.matches("https://app.black4.ai/reviews"), true);
  assert.equal(typeof h.panel.component({ target: url }).type, "function");
  assert.equal(h.preview.matches(url), true, "an older Buzz without accessories: one card per link");
  assert.equal(h.link.matches(url), true);
  assert.equal(h.mcp.calls.length, before, "registering read nothing");
  let opened;
  const launcher = h.panel.channelLauncher({ available: () => true, pressed: false, toggle: (target) => { opened = target; } });
  launcher.props.onClick();
  assert.equal(opened, "https://app.black4.ai/reviews");
  assert.equal(h.panel.channelLauncher({ available: () => false }), null);
  assert.equal(h.mcp.calls.filter((call) => call.params?.name === "decide_review_item").length, 0);
});

test("the Reviews page is native: the queue beside the item, never the embedded website", async (t) => {
  for (const browserAvailable of [true, false]) {
    const app = await harness(t, { browserAvailable, queue: queueText({ total: 1, reviews: [{ assetId: "rv_a", businessId: "b", businessName: "Sample Bakery", title: "Copy", items: [{ key: "k", version: 1, title: "Change the menu", age: "2h" }] }] }) });
    await settle();
    assert.equal(app.page.id, "reviews");
    assert.equal(app.page.placement, "dock");
    assert.equal(app.page.layout, "workspace");
    assert.equal(typeof app.page.route?.validate, "function", "a sidebar row or notification can open it on a business or item");
    assert.equal(app.page.route.validate({ business: "b", asset: "rv_a", item: "k" }), true);
    assert.equal(app.page.route.validate({ url: "https://evil.test" }), false);
    const text = JSON.stringify(expandAll(app.page.component({})));
    assert.doesNotMatch(text, /browser-view|app\.black4\.ai\/reviews\?experience/);
    assert.match(text, /Sample Bakery/);
    assert.match(text, /Change the menu/);
    assert.equal(app.registered.size, tools.length, "Reviews adds no agent tools");
  }
});

test("a native review offers Connect in place only when nothing is already in progress", async t => {
  const offline = new Set([MCP]);
  const app = await harness(t, { offline });
  await settle();
  const failed = expandAll(app.panel.component({ target: "https://app.black4.ai/reviews" }));
  const connect = button(failed, "Connect Black 4");
  assert.ok(connect, "a failed connection shows Connect where the person is");
  assert.match(JSON.stringify(failed), /connection refused/, "the failure detail is shown");
  offline.clear();
  connect.props.onClick();
  const starting = expandAll(app.panel.component({ target: "https://app.black4.ai/reviews" }));
  assert.equal(button(starting, "Connect Black 4"), undefined, "no second Connect while a connection is in progress");
  await settle();
  assert.equal(app.registered.size, tools.length);
});

test("the native screens draw in Buzz's own parts: no stylesheet or colours of their own, red only for broken", async t => {
  const app = await harness(t);
  await settle();
  const text = JSON.stringify(expandAll(app.panel.component({ target: "https://app.black4.ai/r/rv_a?business=b" })));
  assert.doesNotMatch(text, /"type":"style"/, "no <style> of its own");
  assert.doesNotMatch(text, /#[0-9a-f]{3,8}\b|\brgba?\(|CanvasText/i, "no colours of its own");
  assert.doesNotMatch(text, /text-danger/, "loading is not a fault");
  assert.match(text, /aria-busy/, "a skeleton in the real layout while it loads");
});
