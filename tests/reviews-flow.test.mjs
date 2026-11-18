// Reviews end to end: the plugin as Buzz starts it, over fake AuthKit and a
// fake Black 4 MCP that serves the review card's tokens, previews, conflicts
// and answers that never come. A decision reaches decide_review_item only
// after a person's click and its Undo window, once, with its own token.
import assert from "node:assert/strict";
import test from "node:test";
import { fakeAuthKit, fakeMcp, fakeReviews, https, freshPlugin, settle } from "./fakes.mjs";

const LINK = "https://app.black4.ai/r/rv_bakery?v=1&item=hero"; // no business: as agents post them

async function app(t, options = {}) {
  const { apply, signInStore } = await freshPlugin();
  const reviews = fakeReviews(options.reviews);
  const authkit = fakeAuthKit();
  const mcp = fakeMcp(authkit, { answer: reviews.answer((message) => message.params?.name === "whoami"
    ? { result: { content: [{ type: "text", text: '{"kind":"staff","email":"operator@example.test"}' }] } } : { result: {} }) });
  const net = https({ authkit, mcp });
  await signInStore.save(authkit.issue().refresh_token);
  const registered = {};
  const tools = new Map();
  const cleanups = [];
  const effects = [];
  const h = (type, props, ...children) => { const kids = children.flat(); return { type, props: { ...(props ?? {}), children: kids }, children: kids }; };
  // Effects run as each render happens; their cleanups at the end.
  const React = { createElement: h, Fragment: "fragment", Component: class { constructor(props) { this.props = props; } }, useState: (v) => [typeof v === "function" ? v() : v, () => {}], useRef: (v) => ({ current: v }), useId: () => "id",
    useLayoutEffect: () => {}, useEffect: (fn) => { const off = fn(); if (typeof off === "function") effects.push(off); } };
  apply({
    react: React,
    agents: { snapshot: () => ({ running: [] }), addTool: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name); }, register() {} },
    settingsCards: { register() {} }, pages: { register: (value) => { if (value.id === "reviews") registered.page = value; } }, panels: { register: (value) => { registered.panel = value; } },
    conversation: { registerLink() {}, registerAccessory: (value) => { registered.accessory = value; } },
    browser: { available: false },
    effect: (fn) => { const off = fn(); if (off) cleanups.push(off); },
    host: { request: net.request },
  });
  // Real timers back first, so stopping the plugin clears its real poll.
  t.after(() => { t.mock.timers.reset(); for (const off of effects.splice(0)) { try { off(); } catch {} } for (const off of cleanups.reverse()) off(); });
  await settle();
  const expand = (node) => {
    if (!node || typeof node !== "object") return node;
    if (typeof node.type === "function" && node.type.prototype?.render) { const instance = new node.type(node.props); instance.state ??= {}; return expand(instance.render()); }
    if (typeof node.type === "function") return expand(node.type(node.props));
    return { ...node, children: (node.children ?? []).map(expand) };
  };
  const find = (node, test) => {
    if (!node || typeof node !== "object") return null;
    if (test(node)) return node;
    for (const child of node.children ?? []) { const found = find(child, test); if (found) return found; }
    return null;
  };
  const text = (node) => typeof node === "string" ? node : !node || typeof node !== "object" ? "" : (node.children ?? []).map(text).join(" ");
  const label = (node) => text(node).replace(/\s+/g, " ").trim();
  const panel = (target = LINK) => expand(registered.panel.component({ target }));
  const page = () => expand({ type: registered.page.component, props: {}, children: [] });
  const button = (view, words) => find(view, (node) => node.type === "button" && label(node) === words);
  /** The panel once its review is read (the first render asks; the next shows it). */
  const shown = async (target) => { panel(target); await settle(); return panel(target); };
  return { reviews, mcp, tools, registered, panel, page, shown, button, find, label, text, expand };
}
const decided = (a) => a.reviews.calls.filter((call) => call.name === "decide_review_item");

test("initialize declares the MCP Apps extension, so Black 4 may issue decision tokens", async (t) => {
  const a = await app(t);
  const init = a.mcp.calls.find((call) => call.method === "initialize");
  assert.ok(init.params.capabilities.extensions["io.modelcontextprotocol/ui"], "MCP Apps declared");
  assert.equal(a.tools.has("black4_decide_review_item"), false, "the app-only tool is never offered to agents");
  assert.ok(a.tools.has("black4_open_review"));
});

test("a link without its business opens natively; Approve waits 8 s for Undo, then sends once with its own token", async (t) => {
  const a = await app(t);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
  let view = await a.shown();
  // The badge's own queue read already placed this review: no lookup needed.
  assert.equal(a.reviews.calls.find((call) => call.name === "open_review").args.businessId, "business-crumb");
  assert.match(a.label(view), /Change the hero\?/);
  assert.doesNotMatch(JSON.stringify(view), /b4rd_|grant-secret/, "no token or grant on screen");
  a.button(view, "Approve").props.onClick();
  view = a.panel();
  assert.match(a.label(view), /Approving in 8 s/);
  assert.ok(a.button(view, "Undo"));
  t.mock.timers.tick(7900); await settle();
  assert.equal(decided(a).length, 0, "nothing before the Undo window ends");
  t.mock.timers.tick(200); await settle(); await settle();
  assert.equal(decided(a).length, 1, "sent once");
  const sent = decided(a)[0].args;
  assert.deepEqual({ ...sent, decisionToken: "…" }, { businessId: "business-crumb", assetId: "rv_bakery", version: 1, itemKey: "hero", verdict: "approved", decisionToken: "…" });
  assert.match(sent.decisionToken, /^b4rd_/);
  assert.match(a.label(a.panel()), /Approved by Sam Rivera · waiting to run/, "a receipt, and approval is not completion");
  t.mock.timers.tick(20000); await settle();
  assert.equal(decided(a).length, 1, "never twice");
});

test("Undo sends nothing, and Ask for changes needs words before it can be sent", async (t) => {
  const a = await app(t);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
  const view = await a.shown();
  a.button(view, "Approve").props.onClick();
  a.button(a.panel(), "Undo").props.onClick();
  t.mock.timers.tick(10000); await settle();
  assert.equal(decided(a).length, 0, "Undo sent nothing");
  assert.ok(a.button(a.panel(), "Approve"), "back to the choice");
});

test("a conflict reads the review again and offers the new version; a hung answer is unknown until read again", async (t) => {
  const stale = await app(t, { reviews: { decide: ["stale_review"] } });
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
  stale.button(await stale.shown(), "Approve").props.onClick();
  t.mock.timers.tick(8100); await settle(); await settle();
  assert.match(stale.label(stale.panel()), /A newer version arrived/);
  assert.ok(stale.button(stale.panel(), "Load the new version"));
  t.mock.timers.reset();

  const hung = await app(t, { reviews: { decide: ["hang"] } });
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
  hung.button(await hung.shown(), "Approve").props.onClick();
  t.mock.timers.tick(8100); await settle();
  assert.match(hung.label(hung.panel()), /Saving/);
  t.mock.timers.tick(30100); await settle(); await settle(); await settle();
  // The server did record it: read again, the item's own decision settles the receipt.
  assert.match(hung.label(hung.panel()), /Approved by Sam Rivera/);
  assert.equal(decided(hung).length, 1, "not sent a second time");
});

test("without tokens on this connection: one quiet line and Retry, never the website", async (t) => {
  const a = await app(t, { reviews: { cardClient: false } });
  const view = await a.shown();
  assert.match(a.label(view), /Deciding isn't available on this connection yet\./);
  assert.ok(a.button(view, "Retry"));
  assert.equal(a.button(view, "Approve"), null);
  assert.doesNotMatch(JSON.stringify(view), /browser-view|app\.black4\.ai\/reviews|text-danger/);
});

test("the Goal filter: drawn only when a review serves a goal; what it shows is what next, previous and the counts step through", async (t) => {
  const plain = await app(t);
  plain.page(); await settle();
  assert.equal(plain.find(plain.page(), (node) => node.props?.role === "combobox"), null, "today's queue: no goals, no filter, no empty dropdown");

  const SPRING = { path: "goals/spring-orders.md", title: "More spring orders" };
  const a = await app(t, { reviews: { goals: { hero: [SPRING], price: [] } } });
  a.page(); await settle(); await settle();
  let view = a.page();
  const picker = a.find(view, (node) => node.props?.role === "combobox");
  assert.ok(picker, "the Goal filter");
  assert.equal(picker.props["aria-label"], "Goal");
  const options = [];
  (function walk(node) { if (!node || typeof node !== "object") return; if (node.props?.role === "option") options.push(node); for (const child of node.children ?? []) walk(child); })(view);
  assert.deepEqual(options.map((option) => a.label(option)), ["All goals", "More spring orders · 1", "No goal · 1"]);
  assert.match(a.label(view), /1 of 2/, "all goals: both decisions");
  options.find((option) => option.props["data-value"] === SPRING.path).props.onClick();
  await settle();
  view = a.page();
  assert.match(a.label(view), /1 of 1/, "the count is the filtered count");
  assert.match(a.label(view), /Change the hero\?/);
  assert.doesNotMatch(a.label(a.find(view, (node) => node.props?.role === "region")), /Change (the )?price/, "the list shows only that goal");
  const next = a.find(view, (node) => node.type === "button" && node.props["aria-label"] === "Next decision (J)");
  assert.ok(next.props.disabled || next.props["data-disabled"] !== undefined, "nothing after it within the goal: J has nowhere to go");
  options.find((option) => option.props["data-value"] === "none").props.onClick();
  await settle();
  assert.match(a.label(a.page()), /Change the price\?/, "No goal: the other one, opened at once");
});

test("the message card: one card for every review link in a message, each with its question and live state", async (t) => {
  const a = await app(t);
  const message = { content: `Two for you: ${LINK} and https://app.black4.ai/r/rv_bakery?v=1&item=price, plus https://example.test/r/x.` };
  a.expand(a.registered.accessory.component({ message, open: () => true }));
  await settle();
  const card = a.expand(a.registered.accessory.component({ message, open: () => true }));
  assert.match(a.label(card), /Change the hero\?.*Crumb & Co · copy-bot · Mira · Asked by Weekly refresh · Waiting for you.*Change the price\?/, "question, business, who made it and what set it off, live state");
  assert.equal(a.expand(a.registered.accessory.component({ message: { content: "no links here" }, open: () => true })), null);
});

test("the queue the badge polls carries each review's capture into the queue rows, from _meta", async (t) => {
  const a = await app(t);
  const queueView = () => a.expand(a.registered.panel.component({ target: "https://app.black4.ai/reviews" }));
  queueView();
  await settle(); await settle();
  const view = queueView();
  const picture = a.find(view, (node) => node.type === "img" && /^data:image\/png;base64,|^https:\/\//.test(String(node.props.src)));
  assert.ok(picture, "a row shows the review's capture");
  assert.ok(a.reviews.calls.some((call) => call.name === "get_review_file" && call.args.path === "_captures/menu-1440.jpg"), "read through the MCP");
  assert.match(String(picture.props.src), /^data:image\//, "the MCP read it, so the grant link itself is not what the row shows");
});
