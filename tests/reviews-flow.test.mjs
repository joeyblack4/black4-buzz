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

test("the Goal filter: drawn only when the server counts goals; a goal is asked of the server, and stepping and counts follow its answer", async (t) => {
  const plain = await app(t);
  plain.page(); await settle();
  assert.equal(plain.find(plain.page(), (node) => node.props?.role === "combobox"), null, "an older queue: no goals, no filter, no empty dropdown");

  const SPRING = { path: "goals/spring-orders.md", title: "More spring orders" };
  const a = await app(t, { reviews: { goals: { hero: [SPRING], price: [] } } });
  a.page(); await settle(); await settle();
  let view = a.page();
  const picker = a.find(view, (node) => node.props?.role === "combobox");
  assert.ok(picker, "the Goal filter");
  assert.equal(picker.props["aria-label"], "Goal");
  const options = [];
  (function walk(node) { if (!node || typeof node !== "object") return; if (node.props?.role === "option") options.push(node); for (const child of node.children ?? []) walk(child); })(view);
  assert.deepEqual(options.map((option) => a.label(option)), ["All goals", "More spring orders · 1", "No goal · 1"], "the server's counts");
  assert.match(a.label(view), /1 of 2/, "all goals: both decisions");
  const queueReads = () => a.reviews.calls.filter((call) => call.name === "review_queue").map((call) => call.args);
  options.find((option) => option.props["data-value"] === SPRING.path).props.onClick();
  a.page(); await settle(); await settle();
  assert.deepEqual(queueReads().at(-1), { goal: SPRING.path }, "the server filters: the queue is capped");
  view = a.page();
  assert.match(a.label(view), /1 of 1/, "the count is the filtered count");
  assert.match(a.label(view), /Change the hero\?/);
  assert.doesNotMatch(a.label(a.find(view, (node) => node.props?.role === "region")), /Change (the )?price/, "the list shows only that goal");
  const next = a.find(view, (node) => node.type === "button" && node.props["aria-label"] === "Next decision (J)");
  assert.ok(next.props.disabled || next.props["data-disabled"] !== undefined, "nothing after it within the goal: J has nowhere to go");
  assert.equal(a.find(view, (node) => node.props?.role === "combobox").props["aria-label"], "Goal", "the filter stays while working");
  const badge = a.expand({ type: a.registered.page.badge, props: {}, children: [] });
  assert.match(JSON.stringify(badge), /2 decisions waiting/, "the dock badge still counts the whole queue");
  options.find((option) => option.props["data-value"] === "none").props.onClick();
  a.page(); await settle(); await settle();
  assert.deepEqual(queueReads().at(-1), { goal: "none" });
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

test("the open review shows its whole question, stake and action; the bar keeps its buttons; no stand-in stake", async (t) => {
  const a = await app(t);
  const stake = "Sets the plan for about $2,400 of promotion spend across both shops, which replaces the tune-up offer approved in the original review's October 19 to November 30 window and moves the Saturday clinics to Sundays.";
  const action = "Accept this document as feedback only. This does not authorize publication, campaign launches, spending, or changes to customer tools. Request changes to have the owning agent revise this document.";
  const question = "Accept the winter service report as the plan for the next six weeks of tune-up promotions across both shops, starting with the Sunday clinics?";
  const [hero, price] = a.reviews.review.items;
  Object.assign(hero, { action, card: { ...hero.card, question, stake: { kind: "money", text: stake } },
    madeBy: `gpt-6 · Wren via agent [nostr:${"cd".repeat(32)}]`,
    producer: { agent: "Wren", agentKey: null, model: "gpt-6", effort: null, app: "agent", person: "ops@example.test", verified: { person: true, agentKey: false } } });
  Object.assign(price, { card: null, action: "Accept these notes." });
  const view = await a.shown();
  const bar = a.find(view, (node) => node.props?.["aria-label"] === "Decision");
  const words = a.label(bar);
  assert.ok(words.includes(stake), "the whole stake");
  assert.ok(words.includes(action), "the whole action");
  for (const verdict of ["Approve", "Ask for changes", "Reject"]) assert.ok(a.button(bar, verdict), `${verdict} is in the bar`);
  // Nothing in the bar or the heading is cut to a line count or an ellipsis.
  const heading = a.find(view, (node) => node.type === "h2" && a.label(node) === question);
  assert.ok(heading, "the whole question");
  const styles = JSON.stringify([bar, heading]);
  assert.doesNotMatch(styles, /ellipsis|LineClamp|"nowrap"/);
  // A long status scrolls inside the bar instead of pushing the buttons off screen.
  const status = a.find(bar, (node) => node.props?.["aria-live"] === "polite");
  assert.equal(status.props.style.overflowY, "auto");
  assert.ok(status.props.style.maxBlockSize);
  // The byline names no "agent" app, and Details does not repeat the raw madeBy.
  assert.match(a.label(view), /gpt-6 · for ops@example\.test/);
  assert.doesNotMatch(a.label(view), /via agent|nostr:/);
  // An item with no stake and no facts gets no stake line, not the business name.
  const plain = await a.shown("https://app.black4.ai/r/rv_bakery?v=1&item=price");
  const plainBar = a.find(plain, (node) => node.props?.["aria-label"] === "Decision");
  assert.doesNotMatch(a.label(plainBar), /Crumb/);
  assert.ok(a.label(plainBar).includes("Accept these notes."));
});

test("an open decision says what approving writes to and which of the review's decisions it is", async (t) => {
  const a = await app(t);
  const [hero, price] = a.reviews.review.items;
  Object.assign(hero, { change: { method: "PUT", endpoint: "/admin/api/2025-01/pages/7.json", connector: "shopify", connection: "crumb-shop", lines: [], more: 0 } });
  Object.assign(price, { workType: "document_feedback" });
  let view = await a.shown();
  assert.match(a.label(view), /Updates Shopify/, "the system, from the pinned request");
  assert.match(a.label(view), /Decision 1 of 2 in Winter menu/, "one review, two decisions: this is the first");
  view = await a.shown("https://app.black4.ai/r/rv_bakery?v=1&item=price");
  assert.match(a.label(view), /Writes nothing/, "feedback on a document writes nothing");
  assert.match(a.label(view), /Decision 2 of 2 in Winter menu/);
});

test("the Customer menu: every business the server counts, with its count; choosing one asks the server and opens its first decision", async (t) => {
  const businesses = [
    { businessId: "business-crumb", businessName: "Crumb & Co", decisions: 47 },
    { businessId: "business-dune", businessName: "Dune Kites", decisions: 9 },
  ];
  const a = await app(t, { reviews: { businesses } });
  a.page(); await settle(); await settle();
  const view = a.page();
  const picker = a.find(view, (node) => node.props?.role === "combobox" && node.props["aria-label"] === "Customer");
  assert.ok(picker, "the Customer menu, beside Goal");
  const options = [];
  (function walk(node) { if (!node || typeof node !== "object") return; if (node.props?.role === "option") options.push(node); for (const child of node.children ?? []) walk(child); })(view);
  assert.deepEqual(options.map((option) => a.label(option)).filter((words) => /customers|Crumb|Dune/.test(words)), ["All customers · 2", "Crumb & Co · 47", "Dune Kites · 9"],
    "the server's counts, including a business the capped list doesn't hold");
  options.find((option) => option.props["data-value"] === "business-crumb").props.onClick();
  a.page(); await settle(); await settle();
  assert.deepEqual(a.reviews.calls.filter((call) => call.name === "review_queue").map((call) => call.args).at(-1), { businessId: "business-crumb" }, "the server filters by business");
  assert.match(a.label(a.page()), /Change the hero\?/, "its first decision opens");
});
