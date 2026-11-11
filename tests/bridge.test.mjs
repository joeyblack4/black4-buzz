import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(process.env.BLACK4_TEST_PLUGIN ?? new URL("../plugins/black4/plugin.js", import.meta.url), "utf8");
const { apply, reviewUrl, reviewReader, reviewSurface } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }
const tools = ["whoami", "resolve_channel_business", "open_review"].map((name) => ({
  name, description: name, inputSchema: { type: "object", required: ["channelId"] },
}));

function harness(t, options = {}) {
  const registered = new Map();
  const processes = [];
  let cleanup;
  let card;
  let panel;
  let page;
  let link;
  let preview;
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children });
  const ctx = {
    react: { createElement: h, useState: (v) => [v, () => {}], useEffect: () => {} },
    agents: {
      snapshot: () => ({ running: [{ key: "agent", relay: "wss://example.test" }] }),
      addTool: (tool) => { registered.set(tool.name, tool); return () => registered.delete(tool.name); },
    },
    settingsCards: { register: (value) => { card = value; } },
    pages: { register: value => { page = value; } },
    panels: { register: (value) => { panel = value; } },
    conversation: { registerLink: (value) => { link = value; }, registerLinkPreview: (value) => { preview = value; } },
    browser: { available: options.browserAvailable ?? true, View: "browser-view" },
    effect: (fn) => { cleanup = fn(); },
    host: { spawn: async (_, callbacks) => {
      let exit;
      const child = {
        callbacks, calls: [], killed: false,
        exited: new Promise((resolve) => { exit = resolve; }),
        kill: async () => { child.killed = true; exit(0); },
        write: async (line) => {
          const message = JSON.parse(line);
          child.calls.push(message);
          if (options.writeError) throw new Error("native write refused");
          if (message.id == null || options.holdCalls && message.method === "tools/call" && message.params.name !== "whoami") return;
          const result = message.method === "initialize" ? { instructions: "People decide." }
            : message.method === "tools/list" ? { tools }
            : message.params.name === "whoami" ? { content: [{ type: "text", text: '{"kind":"staff","email":"operator@example.test"}' }] }
            : message.params.name === "review_queue" && options.queue ? (typeof options.queue === "function" ? options.queue() : options.queue)
            : { content: [{ type: "text", text: "readable result" }], _meta: { decisionToken: "hidden-token" } };
          const answer = JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n";
          queueMicrotask(() => { callbacks.onStdout(answer.slice(0, 7)); callbacks.onStdout(answer.slice(7)); });
        },
      };
      processes.push(child);
      await options.beforeSpawn?.(child);
      return child;
    } },
  };
  apply(ctx);
  t.after(() => cleanup());
  return { registered, processes, page, panel, link, preview, stop: () => cleanup(), reconnect: () => button(card.component()).props.onClick() };
}

const queueText = (queue) => ({ content: [{ type: "text", text: JSON.stringify({ kind: "black4_review_queue", reviews: [], ...queue }) }] });
function button(node, text) {
  if (!node || typeof node !== "object") return;
  if (node.type === "button" && (text === undefined || node.children.includes(text))) return node;
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

test("native reviews register a panel and message preview without submitting a decision", async (t) => {
  const h = harness(t);
  await settle();
  const calls = h.processes[0].calls.length;
  const url = "https://app.black4.ai/r/rv_example?item=hero&v=3";
  assert.equal(h.panel.matches(url), true);
  const view = h.panel.component({ target: url });
  assert.equal(typeof view.type, "function");
  assert.equal(view.props.target, url);
  assert.equal(h.preview.matches(url), true);
  assert.equal(h.preview.component({ url, open() {} }).props.compact, true);
  assert.equal(h.processes[0].calls.length, calls);
  assert.equal(h.link.matches(url), true);
  let opened;
  const launcher = h.panel.channelLauncher({ available: () => true, pressed: false, toggle: (target) => { opened = target; } });
  launcher.props.onClick();
  assert.equal(opened, "https://app.black4.ai/reviews");
  assert.equal(h.panel.channelLauncher({ available: () => false }), null);
});

test("native review inspection remains available without an embedded browser", (t) => {
  const h = harness(t, { browserAvailable: false });
  assert.equal(h.panel.matches("https://app.black4.ai/reviews"), true);
  assert.equal(h.panel.channelLauncher({ available: () => true }).type, "button");
});

test("awaits the native process, initializes MCP and registers every listed tool", async (t) => {
  const h = harness(t);
  await settle();
  assert.deepEqual([...h.registered.keys()], tools.map((tool) => `black4_${tool.name}`));
  assert.deepEqual(h.processes[0].calls.slice(0, 3).map((call) => call.method), ["initialize", "notifications/initialized", "tools/list"]);
  assert.match(h.registered.get("black4_whoami").description, /People decide/);
});

test("defaults channel binding to the calling agent's channel and relay", async (t) => {
  const h = harness(t);
  await settle();
  const tool = h.registered.get("black4_resolve_channel_business");
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, []);
  const controller = new AbortController();
  await tool.call({ key: "agent", signal: controller.signal }, { channel: "channel-a" }, {});
  assert.deepEqual(h.processes[0].calls.at(-1).params.arguments, { channelId: "channel-a", communityId: "relay:wss://example.test/" });
});

test("keeps private MCP metadata out of agent results and removes abort listeners", async (t) => {
  const h = harness(t);
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

test("handles an asynchronous write rejection and closes the failed process", async (t) => {
  const h = harness(t, { writeError: true });
  await settle();
  assert.equal(h.registered.size, 0);
  assert.equal(h.processes[0].killed, true);
});

test("kills a process whose spawn completes after disable", async (t) => {
  let release;
  const h = harness(t, { beforeSpawn: () => new Promise((resolve) => { release = resolve; }) });
  h.stop();
  release();
  await settle();
  assert.equal(h.processes[0].killed, true);
  assert.equal(h.processes[0].calls.length, 0);
  assert.equal(h.registered.size, 0);
});

test("reconnect supersedes a pending spawn without creating a stale session", async (t) => {
  let release;
  let spawns = 0;
  const h = harness(t, { beforeSpawn: () => ++spawns === 1 ? new Promise((resolve) => { release = resolve; }) : undefined });
  h.reconnect();
  await settle();
  release();
  await settle();
  assert.equal(h.processes[0].killed, true);
  assert.equal(h.processes[0].calls.length, 0);
  assert.equal(h.registered.size, 3);
});

test("cancels an in-flight call and removes the signal listener", async (t) => {
  const h = harness(t, { holdCalls: true });
  await settle();
  const controller = new AbortController();
  const call = h.registered.get("black4_open_review").call({ signal: controller.signal }, {}, {});
  controller.abort();
  await assert.rejects(call, /Stopped/);
  assert.equal(h.processes[0].calls.at(-1).method, "notifications/cancelled");
});


test("review reader resolves business from the authorized queue and never calls a mutation", async () => {
  const calls = [];
  const read = reviewReader(async (name, args) => {
    calls.push({ name, args });
    if (name === "review_queue") return { reviews: [{ assetId: "rv_a", businessId: "business-sample" }] };
    return { kind: "black4_review", assetId: "rv_a", businessId: "business-sample", version: 2, items: [{ key: "copy", version: 2 }] };
  });
  await read("https://app.black4.ai/r/rv_a?v=2&item=copy");
  assert.deepEqual(calls, [
    { name: "review_queue", args: {} },
    { name: "open_review", args: { assetId: "rv_a", businessId: "business-sample", itemKey: "copy" } },
  ]);
  await assert.rejects(read("https://app.black4.ai/r/rv_a?v=1&item=copy"), /older version/);
  await assert.rejects(read("https://app.black4.ai/r/rv_missing"), /outside the loaded queue/);
});

test("review reader refuses mismatched identities and retries failed reads", async () => {
  let attempts = 0;
  const read = reviewReader(async (name) => {
    attempts++;
    if (attempts === 1) throw new Error("session expired");
    if (name === "review_queue") return { reviews: [{ assetId: "rv_a", businessId: "sample" }] };
    return { kind: "black4_review", assetId: "rv_a", businessId: "another-business", version: 1 };
  });
  await assert.rejects(read("https://app.black4.ai/r/rv_a"), /session expired/);
  await assert.rejects(read("https://app.black4.ai/r/rv_a"), /did not match/);
  assert.equal(attempts, 3);
});

test("a decided review can refresh after leaving the pending queue", async () => {
  let queueReads = 0;
  let reviewReads = 0;
  const read = reviewReader(async name => {
    if (name === "review_queue") {
      queueReads++;
      return { reviews: queueReads === 1 ? [{ assetId: "rv_a", businessId: "sample" }] : [] };
    }
    reviewReads++;
    return { kind: "black4_review", assetId: "rv_a", businessId: "sample", version: 1, items: [{ key: "copy", version: 1, status: reviewReads > 1 ? "decided" : "awaiting_decision" }] };
  });
  await read("https://app.black4.ai/r/rv_a?v=1");
  assert.equal((await read("https://app.black4.ai/r/rv_a?v=1")).items[0].status, "decided");
  assert.equal(queueReads, 1);
  assert.equal(reviewReads, 2);
});

test("Reviews registers a host workspace in the dock without replacing MCP tools", async t => {
  const app = harness(t); await settle();
  assert.equal(app.page.id, "reviews");
  assert.equal(app.page.placement, "dock");
  assert.equal(app.page.primary, true);
  assert.equal(app.page.layout, "workspace");
  assert.equal(typeof app.page.component, "function");
  assert.equal(typeof app.page.badge, "function");
  assert.equal(app.registered.size, tools.length);
  const view = app.page.component();
  assert.equal(view.children[0].type, "browser-view");
  assert.equal(view.children[0].props.url, "https://app.black4.ai/reviews?experience=buzz");
  assert.equal(view.children[0].props.storage, "black4-reviews");
});

test("without an embedded browser the Reviews page is the native queue, with the review brief one step away", async t => {
  const app = harness(t, { browserAvailable: false, queue: queueText({ total: 1, reviews: [{ assetId: "rv_a", businessId: "b", businessName: "Sample", title: "Copy", reviewUrl: "https://app.black4.ai/r/rv_a", items: [{ age: "2h" }] }] }) });
  await settle();
  const page = app.page.component();
  assert.notEqual(page.children[0].type, "browser-view");
  const panel = render(page.children[0]);
  assert.equal(panel.props.target, "https://app.black4.ai/reviews");
  assert.equal(typeof panel.props.open, "function");
  assert.equal(panel.type, app.panel.component({ target: "https://app.black4.ai/reviews" }).type, "the page and the panel mount the same native composition");
  assert.equal(page.children[0].type, app.panel.component, "the page is the review panel pointed at the queue");
});

test("the Reviews badge shows the connected account's waiting count and clears on disconnect", async t => {
  let total = 3;
  const app = harness(t, { queue: () => queueText({ total }) });
  await settle();
  assert.deepEqual(app.page.badge().children, ["3"]);
  assert.match(app.page.badge().props["aria-label"], /3 decisions waiting for the connected Black 4 account/);
  assert.match(app.page.badge().props.style.background, /CanvasText\)$/, "the badge fallback contrasts with its Canvas text");
  assert.equal(app.processes[0].calls.filter((call) => call.params?.name === "review_queue").length, 1, "one queue read per refresh");
  app.reconnect();
  assert.equal(app.page.badge(), null, "a reconnect clears the count before the new account answers");
  total = 7;
  await settle();
  assert.deepEqual(app.page.badge().children, ["7"]);
  app.stop();
  assert.equal(app.page.badge(), null);
});

test("the Reviews badge hides after a failed refresh and ignores an answer from a replaced connection", async t => {
  const app = harness(t, { holdCalls: true });
  await settle();
  assert.equal(app.page.badge(), null);
  const stale = app.processes[0].calls.find((call) => call.params?.name === "review_queue");
  assert.ok(stale, "the badge asks the queue once connected");
  app.reconnect();
  app.processes[0].callbacks.onStdout(JSON.stringify({ jsonrpc: "2.0", id: stale.id, result: queueText({ total: 42 }) }) + "\n");
  await settle();
  assert.equal(app.page.badge(), null, "the old connection's answer never reaches the badge");
  const failing = harness(t, { queue: { isError: true, content: [{ type: "text", text: "queue unavailable" }] } });
  await settle();
  assert.equal(failing.page.badge(), null);
  assert.equal(failing.registered.size, tools.length, "a failed queue read does not disturb the agent tools");
});

test("a native review offers Connect in place only when nothing is already in progress", async t => {
  let spawns = 0;
  const app = harness(t, { beforeSpawn: () => { if (++spawns === 1) throw new Error("black4-mcp-bridge is not installed"); } });
  await settle();
  const failed = render(render(app.panel.component({ target: "https://app.black4.ai/reviews" })));
  const connect = button(failed, "Connect Black 4");
  assert.ok(connect, "a failed connection shows Connect where the person is");
  assert.match(JSON.stringify(failed), /not installed/, "the failure detail is shown");
  connect.props.onClick();
  const starting = render(render(app.panel.component({ target: "https://app.black4.ai/reviews" })));
  assert.equal(button(starting, "Connect Black 4"), undefined, "no second Connect while a connection is in progress");
  await settle();
  assert.equal(spawns, 2);
  assert.equal(app.registered.size, tools.length);
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), useState: (v) => [v, () => {}], useEffect: () => {} };
  let connects = 0;
  const signingIn = reviewSurface(React, async () => ({}), null, () => ({ status: "signing-in", detail: "Finish signing in to Black 4 in your browser.", connect: () => connects++ }))({ target: "https://app.black4.ai/reviews" });
  assert.equal(button(signingIn, "Connect Black 4"), undefined, "an active browser sign-in is never restarted from the brief");
  assert.match(JSON.stringify(signingIn), /Finish signing in/);
  const stopped = reviewSurface(React, async () => ({}), null, () => "stopped")({ target: "https://app.black4.ai/reviews" });
  assert.equal(button(stopped, "Connect Black 4"), undefined, "a plain status string still renders without a connect action");
  assert.equal(connects, 0);
});

test("the native composition uses host tokens, not hard-coded colors", () => {
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), useState: (v) => [v, () => {}], useEffect: () => {} };
  const view = reviewSurface(React, async () => ({}), null)({ target: "https://app.black4.ai/reviews" });
  const css = view.children[0].children[0];
  assert.equal(view.children[0].type, "style");
  assert.equal(typeof css, "string");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|\bwhite(?!-space)\b|\bblack\b|\brgba?\(/i, "no hard-coded colors");
  assert.doesNotMatch(css, /font-size:\s*\d+px/, "type scales with the host's interface size");
  assert.match(css, /var\(--affordance-prominent/);
  assert.match(css, /var\(--border-focus/);
  assert.doesNotMatch(css, /background:var\([^)]*,currentColor\)|color-mix\(in srgb,currentColor [0-9]+%,transparent\)\)}[^}]*color:var\([^)]*,Canvas\)/, "a prominent fill never falls back to currentColor beside Canvas text");
  assert.match(css, /\.b4-primary\{background:var\(--affordance-prominent,CanvasText\);color:var\(--text-on-prominent,Canvas\)/, "the primary fallback is a contrasting system-color pair");
  assert.match(css, /\.b4-primary:hover\{background:var\(--affordance-prominent-hover,color-mix\(in srgb,CanvasText 85%,Canvas\)\)/);
});
