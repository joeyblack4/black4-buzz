// Reviews' data: reading reviews by locator, keeping decision tokens to
// itself, and every decision's life from Undo to its receipt. Fake MCP
// answers and a hand-turned clock; fictional businesses only.
import assert from "node:assert/strict";
import test from "node:test";
import { freshPlugin, settle } from "./fakes.mjs";

const { reviewData, reviewLocator, reviewLink, reviewOrder, reviewGroups, reviewState, wordDiff, REVIEW_UNDO_MS } = await freshPlugin();

const token = (n) => `b4rd_${String(n).padEnd(43, "x")}`;
const tool = (data, meta) => ({ structuredContent: { data }, content: [{ type: "text", text: JSON.stringify({ data }) }], ...(meta ? { _meta: { "ai.black4/review-card": meta } } : {}) });
const refusal = (code, message = code) => ({ isError: true, structuredContent: { error: { code, message } }, content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }] });

/** A fictional review: a bakery's menu change with two items. */
function bakery({ version = 1, decided = {}, decideIn = "card" } = {}) {
  const item = (key) => ({
    key, version, title: `Change ${key}`, workType: "storefront_content", action: "Update the menu.", status: decided[key] ? "decided" : "awaiting_decision",
    decidable: !decided[key], decision: decided[key] ?? null, reviewUrl: `https://app.black4.ai/r/rv_bakery?v=${version}&item=${key}`,
    card: { question: `Change the ${key}?`, stake: { kind: "customers", text: "Shown to 1,200 visitors a week." }, facts: ["Reversible"],
      show: { type: "text", label: "Menu line", before: "Fresh rye bread daily", after: "Fresh sourdough bread daily" } },
    brief: { why: "Asked for", expectedResult: "More orders", before: "rye", after: "sourdough" },
  });
  return { kind: "black4_review", audience: "staff", businessId: "business-crumb", businessName: "Crumb & Co", assetId: "rv_bakery", title: "Menu", version,
    reviewUrl: `https://app.black4.ai/r/rv_bakery?v=${version}`, focusItemKey: "hero", items: [item("hero"), item("price")], decideIn, decide: "People decide." };
}
const QUEUE = { kind: "black4_review_queue", total: 3, listed: 3, reviews: [
  { businessId: "business-crumb", businessName: "Crumb & Co", assetId: "rv_bakery", title: "Menu", items: [{ key: "hero", version: 1, title: "Change hero", age: "2h" }, { key: "price", version: 1, title: "Change price", age: "2h" }] },
  { businessId: "business-tide", businessName: "Tide Surf", assetId: "rv_surf", title: "Ad", items: [{ key: "ad", version: 3, title: "Pause the ad", age: "1d" }] },
] };

/** reviewData over a scripted `call`, on a manual clock. */
function data(script = {}) {
  let clock = 1_000_000;
  const timers = new Map();
  let serial = 0;
  const calls = [];
  let minted = 0;
  const call = async (name, args) => {
    calls.push({ name, args });
    if (script[name]) return script[name](args, calls);
    if (name === "open_review") {
      const value = script.review?.() ?? bakery();
      const tokens = Object.fromEntries(value.items.filter((item) => item.decidable).map((item) => [item.key, { token: token(++minted), version: item.version, expiresAt: new Date(clock + 15 * 60 * 1000).toISOString() }]));
      return tool(value, value.decideIn === "card" ? { decisionTokens: tokens, previews: {}, beforePreviews: {} } : { decisionTokens: {}, previews: {}, beforePreviews: {} });
    }
    if (name === "review_queue") return tool(QUEUE);
    if (name === "decide_review_item") return tool({ decision: { id: "d1", itemKey: args.itemKey, verdict: args.verdict, reviewer: "Pat", executionStatus: args.verdict === "approved" ? "pending" : "not_applicable", decidedAt: "2026-11-17T00:00:00Z" }, next: "ok" });
    throw new Error(`unexpected ${name}`);
  };
  const store = reviewData(call, {
    now: () => clock,
    setTimer: (fn, ms) => { const id = ++serial; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
  });
  const advance = async (ms) => {
    clock += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); }
    await settle();
  };
  return { store, calls, advance, timers, setClock: (value) => { clock = value; } };
}
const decideCalls = (calls) => calls.filter((entry) => entry.name === "decide_review_item");

test("review links are locators: business, item and version, and nothing else", () => {
  assert.deepEqual(reviewLocator("https://app.black4.ai/r/rv_bakery?v=2&item=hero"), { kind: "review", assetId: "rv_bakery", itemKey: "hero", version: 2 });
  assert.deepEqual(reviewLocator("https://app.black4.ai/r/rv_bakery?business=business-crumb"), { kind: "review", assetId: "rv_bakery", businessId: "business-crumb" });
  assert.deepEqual(reviewLocator("https://app.black4.ai/reviews?business=business-crumb"), { kind: "queue", businessId: "business-crumb" });
  assert.equal(reviewLocator("https://example.test/r/rv_bakery"), null);
  assert.equal(reviewLink({ assetId: "rv_bakery", businessId: "business-crumb", itemKey: "hero", version: 2 }), "https://app.black4.ai/r/rv_bakery?v=2&item=hero&business=business-crumb");
  assert.deepEqual(reviewOrder(QUEUE).map((entry) => entry.key), ["hero", "price", "ad"]);
  assert.deepEqual(reviewGroups(QUEUE).map((group) => [group.businessName, group.items.length]), [["Crumb & Co", 2], ["Tide Surf", 1]]);
});

test("a link without its business opens through open_review without one, else the queue, and an unknown one is not a fault", async () => {
  // Today's server needs businessId: one refusal, then the queue, and never again.
  const old = data({ open_review: (args) => args.businessId ? tool(bakery(), { decisionTokens: {} }) : Promise.reject(Object.assign(new Error("MCP error -32602: businessId required"), { code: "rpc" })) });
  const review = await old.store.open(reviewLocator("https://app.black4.ai/r/rv_bakery?item=hero"));
  assert.equal(review.businessName, "Crumb & Co");
  assert.deepEqual(old.calls.map((entry) => [entry.name, entry.args.businessId]), [["open_review", undefined], ["review_queue", undefined], ["open_review", "business-crumb"]]);
  await assert.rejects(old.store.open(reviewLocator("https://app.black4.ai/r/rv_elsewhere")), (error) => error.code === "elsewhere");
  assert.equal(old.calls.filter((entry) => entry.name === "open_review" && !entry.args.businessId).length, 1, "a server that needs businessId is asked by business from then on");
  // A newer server answers without businessId.
  const fresh = data();
  await fresh.store.open(reviewLocator("https://app.black4.ai/r/rv_bakery"));
  assert.deepEqual(fresh.calls.map((entry) => entry.name), ["open_review"]);
});

test("open_review's tokens stay inside: the data it returns has no _meta, no token anywhere", async () => {
  const { store } = data();
  const review = await store.open({ assetId: "rv_bakery", businessId: "business-crumb" });
  assert.doesNotMatch(JSON.stringify(review), /b4rd_|_meta|decisionTokens/);
  assert.equal(store.canDecide(review, review.items[0]), true);
  assert.doesNotMatch(JSON.stringify(store.receipts()), /b4rd_/);
});

test("a decision waits for Undo; Undo sends nothing; then it is sent once with its own token", async () => {
  const { store, calls, advance } = data();
  const review = await store.open({ assetId: "rv_bakery", businessId: "business-crumb" });
  const [hero] = review.items;
  assert.equal(REVIEW_UNDO_MS, 8000);
  let receipt = store.propose({ review, item: hero, verdict: "approved" });
  assert.equal(receipt.state, "pending");
  await advance(7000);
  assert.equal(decideCalls(calls).length, 0, "nothing reaches the server before the Undo window ends");
  assert.equal(store.undo(receipt.id), true);
  await advance(5000);
  assert.equal(decideCalls(calls).length, 0, "Undo sent nothing");
  receipt = store.propose({ review, item: hero, verdict: "approved" });
  await advance(8000);
  assert.equal(decideCalls(calls).length, 1);
  const sent = decideCalls(calls)[0].args;
  assert.deepEqual({ ...sent, decisionToken: undefined }, { businessId: "business-crumb", assetId: "rv_bakery", version: 1, itemKey: "hero", verdict: "approved", decisionToken: undefined });
  assert.match(sent.decisionToken, /^b4rd_/);
  assert.equal(store.receipt(receipt.id).state, "saved");
  assert.deepEqual(reviewState(hero, store.receipt(receipt.id)), { tone: "approved", text: "Approved by Pat · waiting to run" }, "approval is not completion");
  assert.equal(store.propose({ review, item: hero, verdict: "approved" }).state, "saved", "a saved item is not sent again");
  await advance(9000);
  assert.equal(decideCalls(calls).length, 1);
});

test("Ask for changes and Reject need feedback; disposing cancels a waiting decision", async () => {
  const { store, calls, advance } = data();
  const review = await store.open({ assetId: "rv_bakery", businessId: "business-crumb" });
  assert.equal(store.propose({ review, item: review.items[0], verdict: "changes_requested" }), null);
  assert.equal(store.propose({ review, item: review.items[0], verdict: "rejected", feedback: "   " }), null);
  assert.equal(store.propose({ review, item: review.items[0], verdict: "maybe" }), null);
  const receipt = store.propose({ review, item: review.items[0], verdict: "changes_requested", feedback: "Keep rye too." });
  assert.equal(receipt.state, "pending");
  store.dispose();
  await advance(20000);
  assert.equal(decideCalls(calls).length, 0, "nothing is sent after Reviews stops");
});

test("bulk approval: each item its own call and token and receipt, and a partial failure shows per item", async () => {
  const { store, calls, advance } = data({ decide_review_item: (args) => args.itemKey === "price" ? refusal("access_changed", "Your Black 4 access changed.")
    : tool({ decision: { id: "d", itemKey: args.itemKey, verdict: "approved", reviewer: "Pat", executionStatus: "pending" } }) });
  const review = await store.open({ assetId: "rv_bakery", businessId: "business-crumb" });
  const receipts = review.items.map((item) => store.propose({ review, item, verdict: "approved" }));
  await advance(8000);
  const sent = decideCalls(calls).map((entry) => entry.args);
  assert.deepEqual(sent.map((args) => args.itemKey), ["hero", "price"]);
  assert.notEqual(sent[0].decisionToken, sent[1].decisionToken, "each item has its own token");
  assert.deepEqual(receipts.map((receipt) => store.receipt(receipt.id).state), ["saved", "failed"]);
  assert.match(store.receipt(receipts[1].id).message, /access changed/);
});

test("a conflict reads the review again and offers its new state; a token near expiry is renewed first", async () => {
  let version = 1;
  const { store, calls, advance, setClock } = data({ review: () => bakery({ version }), decide_review_item: () => refusal("stale_review", "A newer version exists.") });
  const review = await store.open({ assetId: "rv_bakery", businessId: "business-crumb" });
  const receipt = store.propose({ review, item: review.items[0], verdict: "approved" });
  version = 2;
  await advance(8000);
  assert.equal(store.receipt(receipt.id).state, "conflict");
  assert.equal(store.receipt(receipt.id).code, "stale_review");
  // A renewed token naming a version the person has not seen sends nothing.
  const second = data({ review: () => bakery({ version }) });
  version = 1;
  const seen = await second.store.open({ assetId: "rv_bakery", businessId: "business-crumb" });
  const pending = second.store.propose({ review: seen, item: seen.items[0], verdict: "approved" });
  version = 2;
  second.setClock(1_000_000 + 15 * 60 * 1000 - 10_000); // the token is about to lapse
  await second.advance(8000);
  assert.equal(decideCalls(second.calls).length, 0);
  assert.equal(second.store.receipt(pending.id).state, "conflict");
  void setClock; void calls;
});

test("an answer that never comes is unknown until the review is read again", async () => {
  let decidedOnServer = false;
  const { store, advance } = data({
    review: () => bakery({ decided: decidedOnServer ? { hero: { verdict: "approved", reviewer: "Pat", executionStatus: "in_progress" } } : {} }),
    decide_review_item: () => { decidedOnServer = true; return new Promise(() => {}); },
  });
  const review = await store.open({ assetId: "rv_bakery", businessId: "business-crumb" });
  const receipt = store.propose({ review, item: review.items[0], verdict: "approved" });
  await advance(8000);
  assert.equal(store.receipt(receipt.id).state, "sending");
  await advance(30000);
  assert.equal(store.receipt(receipt.id).state, "saved", "read again, the server's own decision settles it");
  assert.equal(reviewState(null, store.receipt(receipt.id)).text, "Approved by Pat · running");
});

test("without tokens (decideIn reviews) nothing can be decided here", async () => {
  const { store } = data({ review: () => bakery({ decideIn: "reviews" }) });
  const review = await store.open({ assetId: "rv_bakery", businessId: "business-crumb" });
  assert.equal(store.canDecide(review, review.items[0]), false);
  assert.equal(store.propose({ review, item: review.items[0], verdict: "approved" }), null);
});

test("word diff keeps whole words", () => {
  assert.deepEqual(wordDiff("Fresh rye bread daily", "Fresh sourdough bread daily"),
    [{ kind: "same", text: "Fresh " }, { kind: "removed", text: "rye" }, { kind: "added", text: "sourdough" }, { kind: "same", text: " bread daily" }]);
});
