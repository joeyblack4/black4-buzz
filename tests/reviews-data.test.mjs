// Reviews' data: reading reviews by locator, keeping decision tokens to
// itself, and every decision's life from Undo to its receipt. Fake MCP
// answers and a hand-turned clock; fictional businesses only.
import assert from "node:assert/strict";
import test from "node:test";
import { freshPlugin, settle } from "./fakes.mjs";

const { reviewData, reviewLocator, reviewLink, reviewOrder, reviewGroups, reviewState, wordDiff, REVIEW_UNDO_MS,
  reviewGoalChoices, reviewGoalNow, reviewShown, REVIEW_ALL_GOALS, REVIEW_NO_GOAL } = await freshPlugin();

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

test("signing out or switching account forgets everything: queue, reviews, tokens, and a decision still in its Undo window", async () => {
  const { store, calls, advance } = data();
  store.noteQueue(QUEUE);
  const review = await store.open({ assetId: "rv_bakery", businessId: "business-crumb" });
  const receipt = store.propose({ review, item: review.items[0], verdict: "approved" });
  store.reset();
  assert.equal(store.queue, null);
  assert.equal(store.cachedReview("business-crumb", "rv_bakery"), null);
  assert.equal(store.receipt(receipt.id), null);
  assert.equal(store.canDecide(review, review.items[0]), false, "no token survives");
  await advance(20000);
  assert.equal(decideCalls(calls).length, 0, "the waiting decision was never sent");
});

test("the byline: who made it and what set it off; a signed agent only when Black 4 verified its key", async () => {
  const { reviewByline } = await freshPlugin();
  // Older servers: madeBy whole, origin from job / requestedBy.
  assert.deepEqual(reviewByline(null, { madeBy: "copy-bot · Mira", requestedBy: "proactive" }),
    { maker: { name: "copy-bot · Mira", agent: false, signed: false }, origin: { kind: "proactive", text: "On the agent's own initiative" } });
  assert.deepEqual(reviewByline(null, { madeBy: "x", requestedBy: "Pat Lee", threadId: "root-1" }).origin, { kind: "request", text: "Asked by Pat Lee", threadId: "root-1" });
  assert.deepEqual(reviewByline(null, { madeBy: "x", job: { jobId: "j1", jobName: "Competitor watch" } }).origin, { kind: "job", text: "Scheduled job Competitor watch" });
  // Platform Control's producer and origin (review-artifact slice A).
  const key = "ab".repeat(32);
  const signed = reviewByline(null, { madeBy: "ignored", producer: { agent: "Mira", agentKey: key, model: "Fable 5.2", effort: "high", app: "Claude Code", person: "pat@example.test", verified: { person: true, agentKey: true } },
    origin: { kind: "job", job: { jobId: "j1", jobName: "Competitor watch", runId: "r1", startedAt: null } } });
  assert.deepEqual(signed, { maker: { name: "Mira", agent: true, signed: true, pubkey: key, app: "Fable 5.2 via Claude Code", person: "pat@example.test", personVerified: true },
    origin: { kind: "job", text: "Scheduled job Competitor watch" } });
  const reported = reviewByline(null, { producer: { agent: "Mira", agentKey: key, model: null, effort: null, app: "Codex", person: null, verified: { person: false, agentKey: false } }, origin: { kind: "unknown" } });
  assert.equal(reported.maker.signed, false, "a key the request did not sign is not shown as the agent's identity");
  assert.equal(reported.maker.pubkey, undefined);
  assert.deepEqual(reported.origin, { kind: "unknown", text: "What started it was not recorded" });
  assert.deepEqual(reviewByline(null, { producer: { agent: null, verified: {} }, origin: { kind: "request", requestedBy: "Sam", threadId: "t9" } }).origin, { kind: "request", text: "Asked by Sam", threadId: "t9" });
});

test("too many at once (HTTP 429): the same call is sent again with the same token, and saves once", async () => {
  let refusals = 1;
  const { store, calls, advance } = data({ decide_review_item: (args) => refusals-- > 0
    ? Promise.reject(Object.assign(new Error("Black 4 answered HTTP 429: slow down."), { code: "http" }))
    : tool({ decision: { id: "d1", itemKey: args.itemKey, verdict: args.verdict, reviewer: "Pat", executionStatus: "pending" } }) });
  const review = await store.open({ assetId: "rv_bakery", businessId: "business-crumb" });
  const receipt = store.propose({ review, item: review.items[0], verdict: "approved" });
  await advance(8000);
  await advance(1500);
  const sent = decideCalls(calls);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].args.decisionToken, sent[1].args.decisionToken, "the same token, safe to repeat");
  assert.equal(store.receipt(receipt.id).state, "saved");
});

test("captures: the page's picture (and its before) from _meta, through get_review_file or else its own link; the queue's capture too", async () => {
  const CAPTURE = "https://content.example.test/v/grant-c/_captures/hero-1440.jpg";
  const { store, calls } = data({
    open_review: () => tool(bakery(), { decisionTokens: {}, previews: { hero: { url: "https://content.example.test/v/g/index.html", contentType: "text/html" } }, beforePreviews: {},
      captures: { hero: { desktop: { url: CAPTURE, expiresAt: "2099-01-01T00:00:00Z", contentType: "image/jpeg" }, phone: { url: "https://content.example.test/v/g/p.jpg", contentType: "image/jpeg" } } },
      beforeCaptures: { hero: { desktop: { url: "https://content.example.test/v/g/before.jpg", contentType: "image/jpeg" } } } }),
    get_review_file: (args) => args.path === "before.jpg" ? { content: [{ type: "image", data: "aGk=", mimeType: "image/jpeg" }] } : refusal("review_file_not_found"),
  });
  const review = await store.open({ assetId: "rv_bakery", businessId: "business-crumb" });
  assert.equal(store.preview(review.businessId, review.assetId, "hero"), "https://content.example.test/v/g/index.html", "the live page");
  assert.equal(store.pictureKind(review.businessId, review.assetId, "hero"), "capture");
  assert.equal(store.hasBeforeCapture(review.businessId, review.assetId, "hero"), true);
  assert.equal(await store.image(review.businessId, review.assetId, "hero", "capture"), CAPTURE, "not a review file: shown from its own exact-file link");
  assert.equal(await store.image(review.businessId, review.assetId, "hero", "beforeCapture"), "data:image/jpeg;base64,aGk=", "a review file: read through the MCP");
  assert.deepEqual(calls.filter((call) => call.name === "get_review_file").map((call) => call.args.path), ["_captures/hero-1440.jpg", "before.jpg"]);
  // The queue's own capture link, when the platform sends one.
  const entry = { businessId: "business-crumb", assetId: "rv_bakery", version: 1, capture: { url: CAPTURE, contentType: "image/jpeg" } };
  assert.equal(store.queuePicture(entry), null, "asked for, not yet read");
  await settle();
  assert.equal(store.queuePicture(entry), CAPTURE);
  assert.equal(store.queuePicture({ businessId: "b", assetId: "a" }), null, "an older queue sends none");
});

test("the queue's captures come from _meta by assetId, onto the review they picture, for the plugin's own screens", async () => {
  const { reviewQueueOf } = await freshPlugin();
  const link = { url: "https://content.example.test/v/g/_captures/menu.jpg", expiresAt: "2099-01-01T00:00:00Z", contentType: "image/jpeg" };
  const result = tool(QUEUE, { captures: { rv_bakery: { desktop: link }, rv_unknown: { desktop: link } } });
  const queue = reviewQueueOf(result);
  assert.deepEqual(queue.reviews.find((review) => review.assetId === "rv_bakery").capture, { desktop: link });
  assert.equal(queue.reviews.find((review) => review.assetId === "rv_surf").capture, undefined, "no capture yet: none");
  assert.equal(QUEUE.reviews[0].capture, undefined, "the answer itself is not changed");
  assert.deepEqual(reviewQueueOf(tool(QUEUE)), QUEUE, "an older server: the queue as it was");
  assert.deepEqual(reviewQueueOf(tool(QUEUE, { captures: { rv_bakery: { desktop: { url: "javascript:alert(1)" } } } })).reviews[0].capture, undefined, "only https links");
  // Read by the store, it reaches queue rows.
  const { store } = data({ review_queue: () => result });
  await store.readQueue();
  const entry = reviewOrder(store.queue).find((candidate) => candidate.assetId === "rv_bakery");
  assert.deepEqual(entry.capture, { desktop: link });
});

// ---- the Goal filter ---------------------------------------------------------------
// The queue is capped, so the server filters by goal and counts: the plugin draws
// its menu from the answer's top-level goals and noGoal, never from counting rows.
const SPRING = { path: "goals/spring-orders.md", title: "More spring orders" };
const LOYAL = { path: "goals/repeat-buyers.md", title: "More repeat buyers" };
const review = (assetId, goals, keys = ["a"]) => ({ businessId: "business-crumb", businessName: "Crumb & Co", assetId, title: assetId, goals,
  items: keys.map((key) => ({ key, version: 1, title: `${assetId} ${key}` })) });
/** A fictional server's review_queue: filtered by goal, counted over everything waiting (here more than it lists). */
function goalServer(args = {}) {
  const all = [review("rv_menu", [SPRING], ["a", "b"]), review("rv_mail", [SPRING, LOYAL]), review("rv_hours", [])];
  const shown = !args.goal ? all : all.filter((entry) => args.goal === "none" ? !entry.goals.length : entry.goals.some((goal) => goal.path === args.goal));
  return { kind: "black4_review_queue", total: shown.reduce((n, entry) => n + entry.items.length, 0) + 40, listed: 4, truncated: true, blocked: [], stalled: [],
    ...(args.goal ? { goal: args.goal } : {}), reviews: shown,
    goals: [{ ...LOYAL, reviews: 7 }, { ...SPRING, reviews: 31 }, { path: "goals/empty.md", title: "Nothing waits", reviews: 0 }, { path: "", title: "no path", reviews: 2 }], noGoal: 12 };
}

test("goal choices are the server's counts for the whole queue, not a count of the rows it listed", () => {
  assert.deepEqual(reviewGoalChoices(goalServer()), { goals: [
    { path: LOYAL.path, title: LOYAL.title, count: 7 }, { path: SPRING.path, title: SPRING.title, count: 31 },
  ], noGoal: 12 }, "a goal with nothing waiting, or without a path, is left out");
  assert.deepEqual(reviewGoalChoices(goalServer({ goal: SPRING.path })).goals.map((goal) => goal.count), [7, 31], "they ignore the goal asked for");
});

test("an older server, or a queue where no review serves a goal: no filter at all, whatever was chosen", () => {
  for (const queue of [{ kind: "black4_review_queue", reviews: [review("rv_menu", undefined)] }, { ...goalServer(), goals: [], noGoal: 3 }, null]) {
    const choices = reviewGoalChoices(queue);
    assert.deepEqual(choices.goals, [], "nothing to offer, so the menu is not drawn");
    for (const chosen of [SPRING.path, REVIEW_NO_GOAL, undefined]) assert.equal(reviewGoalNow(choices, chosen), REVIEW_ALL_GOALS);
  }
  const choices = reviewGoalChoices(goalServer());
  assert.equal(reviewGoalNow(choices, LOYAL.path), LOYAL.path);
  assert.equal(reviewGoalNow(choices, REVIEW_NO_GOAL), REVIEW_NO_GOAL);
  assert.equal(reviewGoalNow(choices, "goals/decided-away.md"), REVIEW_ALL_GOALS, "its last review was decided: back to all goals");
  assert.equal(reviewGoalNow({ ...choices, noGoal: 0 }, REVIEW_NO_GOAL), REVIEW_ALL_GOALS);
});

test("a goal is asked of the server; its answer is kept beside the whole queue, follows the poll, and loses decided items", async () => {
  const { store, calls } = data({ review_queue: (args) => tool(goalServer(args)) });
  await store.readQueue();
  assert.equal(store.queue.total, 44, "the whole queue: what the badge counts");
  await store.readScoped({ goal: SPRING.path });
  assert.deepEqual(calls.filter((call) => call.name === "review_queue").map((call) => call.args), [{}, { goal: SPRING.path }]);
  const spring = store.scopedQueue({ goal: SPRING.path });
  assert.equal(spring.goal, SPRING.path);
  assert.deepEqual(reviewShown(spring).map((entry) => entry.id), ["business-crumb/rv_menu/a", "business-crumb/rv_menu/b", "business-crumb/rv_mail/a"]);
  assert.equal(store.queue.total, 44, "the whole queue is not narrowed");
  await store.readScoped({ businessId: "business-crumb", goal: REVIEW_NO_GOAL });
  assert.deepEqual(calls.at(-1).args, { businessId: "business-crumb", goal: "none" });
  assert.equal(store.scopedQueue({ goal: LOYAL.path }), null, "not asked for: not read");
  // The badge's poll brings the narrower answers along.
  store.noteQueue(goalServer());
  await settle();
  assert.deepEqual(calls.slice(-2).map((call) => call.args), [{ goal: SPRING.path }, { businessId: "business-crumb", goal: "none" }]);
  store.reset();
  assert.equal(store.scopedQueue({ goal: SPRING.path }), null, "a new connection forgets them");
});

test("reviewShown narrows a loaded queue by business and by each review's own goals", () => {
  const ids = (entries) => entries.map((entry) => `${entry.assetId}:${entry.key}`).join(" ");
  assert.equal(ids(reviewShown(goalServer(), { goal: LOYAL.path })), "rv_mail:a");
  assert.equal(ids(reviewShown(goalServer(), { goal: REVIEW_NO_GOAL })), "rv_hours:a");
  assert.equal(ids(reviewShown(goalServer(), { businessId: "business-surf" })), "");
});
