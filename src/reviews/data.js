// ---- Reviews: what the person reads and decides --------------------------------
// Reads go through the Black 4 MCP as the signed-in person. Decisions go
// through `decide_review_item`, an app-only tool, with the single-use decision
// token `open_review` hands this module in its result's `_meta`. The tokens
// live only in this closure: never logged, stored, put in a URL, rendered, or
// handed to anything else. A decision is sent only after `propose` (called by
// a person's click or key press) and its Undo window; disposing the module
// cancels every decision still waiting, so nothing is sent after that.

/** The Black 4 review card's private part of a tool result (Platform Control
 * REVIEW_CARD_META_KEY). */
const REVIEW_CARD_META = "ai.black4/review-card";
/** A decision waits this long for Undo before it is sent (the web's buffer). */
const REVIEW_UNDO_MS = 8 * 1000;
/** How long a decision may take before its outcome is unknown and read again. */
const REVIEW_DECIDE_TIMEOUT_MS = 30 * 1000;
/** A token this close to expiry is renewed (open_review again) before use. */
const REVIEW_TOKEN_RENEW_MS = 20 * 1000;
/** A review read this recently is shown again without asking. */
const REVIEW_FRESH_MS = 60 * 1000;
/** Refusals after which the review is read again for its new state. */
const REVIEW_CONFLICTS = Object.freeze(["stale_review", "decision_exists"]);
const REVIEW_TOKEN_CODES = Object.freeze(["decision_token_expired", "decision_token_used", "decision_token_invalid", "decision_token_required"]);
/** Decisions sent at once at most (Platform Control answers 429 past 4 for a customer). */
const REVIEW_PARALLEL = 3;
const REVIEW_VERDICTS = Object.freeze(["approved", "changes_requested", "rejected"]);
const REVIEWS_HOME = "https://app.black4.ai/reviews";

/** A review link as a locator, never an authority: `{ kind: "queue",
 * businessId? }` or `{ kind: "review", assetId, businessId?, itemKey?,
 * version? }`, or null for anything but the Black 4 review surface. */
function reviewLocator(target) {
  const safe = reviewUrl(target);
  if (!safe) return null;
  const url = new URL(safe);
  const businessId = url.searchParams.get("business") || undefined;
  const assetId = url.pathname.match(/^\/r\/([a-zA-Z0-9_-]+)/)?.[1];
  if (!assetId) return { kind: "queue", ...(businessId ? { businessId } : {}) };
  const version = Number(url.searchParams.get("v"));
  return { kind: "review", assetId, ...(businessId ? { businessId } : {}),
    ...(url.searchParams.get("item") ? { itemKey: url.searchParams.get("item") } : {}),
    ...(Number.isInteger(version) && version > 0 ? { version } : {}) };
}

/** The link for one item, with its business so it opens without a lookup. */
function reviewLink({ assetId, businessId, itemKey, version } = {}) {
  if (!assetId) return businessId ? `${REVIEWS_HOME}?business=${encodeURIComponent(businessId)}` : REVIEWS_HOME;
  const url = new URL(`https://app.black4.ai/r/${encodeURIComponent(assetId)}`);
  if (version) url.searchParams.set("v", String(version));
  if (itemKey) url.searchParams.set("item", itemKey);
  if (businessId) url.searchParams.set("business", businessId);
  return url.href;
}

const reviewItemId = (businessId, assetId, key) => `${businessId}/${assetId}/${key}`;
const reviewAssetKey = (businessId, assetId) => `${businessId}/${assetId}`;

/** review_queue's answer as the plugin's own screens read it: its data, and
 * each review's capture (the desktop picture of the page its first listed item
 * opens on) from `_meta["ai.black4/review-card"].captures[assetId]`, which the
 * server keeps out of what a model reads. Never handed to an agent. */
function reviewQueueOf(result) {
  const value = readAnswer(result);
  const queue = value?.data && !value.kind ? value.data : value;
  const captures = result?._meta?.[REVIEW_CARD_META]?.captures;
  if (queue?.kind !== "black4_review_queue" || !captures || typeof captures !== "object") return queue;
  return { ...queue, reviews: (queue.reviews ?? []).map((review) => {
    const link = captures[review.assetId]?.desktop;
    return typeof link?.url === "string" && /^https:\/\//.test(link.url) ? { ...review, capture: { desktop: link } } : review;
  }) };
}

/** Everything waiting, in queue order, one entry per item: what next and
 * previous step through. Approved work that is blocked or stalled is not here. */
function reviewOrder(queue) {
  return reviewGroups(queue).flatMap((group) => group.items);
}
/** Every waiting item in the order the server listed them. */
function reviewListed(queue) {
  const out = [];
  for (const review of queue?.reviews ?? []) {
    for (const item of review.items ?? []) {
      out.push({ id: reviewItemId(review.businessId, review.assetId, item.key), businessId: review.businessId, businessName: review.businessName,
        assetId: review.assetId, reviewTitle: review.title, key: item.key, version: item.version, title: item.title, question: item.question,
        stake: item.stake, age: item.age, brief: item.brief, workType: item.workType, threadId: item.threadId ?? review.threadId ?? null,
        madeBy: item.madeBy ?? review.madeBy ?? null, requestedBy: item.requestedBy ?? review.requestedBy ?? null, job: item.job ?? review.job ?? null,
        producer: item.producer ?? review.producer ?? null, origin: item.origin ?? review.origin ?? null,
        capture: item.capture && typeof item.capture === "object" ? item.capture : review.capture && typeof review.capture === "object" ? review.capture : null,
        goals: reviewGoalsOf(item.goals ?? review.goals) });
    }
  }
  return out;
}

// ---- goals: work the reviews behind one goal first ----------------------------------
/** The Goal filter's values beside a goal's path (paths start with goals/). */
const REVIEW_ALL_GOALS = "all";
const REVIEW_NO_GOAL = "none";
/** The goals a review serves, as the queue lists them: `[{ path, title }]`. */
function reviewGoalsOf(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const goal of value) {
    const path = typeof goal?.path === "string" ? goal.path.trim().slice(0, 300) : "";
    if (!path || path === REVIEW_ALL_GOALS || path === REVIEW_NO_GOAL || out.some((known) => known.path === path)) continue;
    out.push({ path, title: plain(goal.title, 120) || path.replace(/^goals\//, "").replace(/\.md$/, "") });
  }
  return out;
}
/** The Goal filter's choices for these entries, as the web desk counts them:
 * reviews (not items) per goal, a review with two goals under each, one path
 * once (under its first title), in path order; and how many serve none. */
function reviewGoalChoices(entries) {
  const goals = new Map();
  const none = new Set();
  for (const entry of entries ?? []) {
    const review = `${entry.businessId}/${entry.assetId}`;
    if (!entry.goals?.length) { none.add(review); continue; }
    for (const goal of entry.goals) {
      if (!goals.has(goal.path)) goals.set(goal.path, { path: goal.path, title: goal.title, reviews: new Set() });
      goals.get(goal.path).reviews.add(review);
    }
  }
  return { goals: [...goals.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((goal) => ({ path: goal.path, title: goal.title, count: goal.reviews.size })),
    noGoal: none.size };
}
/** The goal in force: the one chosen, while the queue still has it; else all.
 * With no goal anywhere in these entries there is no filter at all. */
function reviewGoalNow(choices, chosen) {
  if (!choices.goals.length || !chosen || chosen === REVIEW_ALL_GOALS) return REVIEW_ALL_GOALS;
  if (chosen === REVIEW_NO_GOAL) return choices.noGoal ? REVIEW_NO_GOAL : REVIEW_ALL_GOALS;
  return choices.goals.some((goal) => goal.path === chosen) ? chosen : REVIEW_ALL_GOALS;
}
/** Whether an entry serves `goal` (a path, "none" or "all"). */
function reviewServes(entry, goal) {
  if (!goal || goal === REVIEW_ALL_GOALS) return true;
  if (goal === REVIEW_NO_GOAL) return !entry.goals?.length;
  return !!entry.goals?.some((candidate) => candidate.path === goal);
}
/** What a person works through, in queue order: one business (or all), one
 * goal (or all). Next, previous, bulk approve and the counts use this. */
function reviewShown(queue, { businessId = null, goal = REVIEW_ALL_GOALS } = {}) {
  return reviewOrder(queue).filter((entry) => (!businessId || entry.businessId === businessId) && reviewServes(entry, goal));
}

/** The queue grouped by business, in the order businesses first appear. */
function reviewGroups(queue) {
  const groups = new Map();
  for (const entry of reviewListed(queue)) {
    if (!groups.has(entry.businessId)) groups.set(entry.businessId, { businessId: entry.businessId, businessName: entry.businessName, items: [] });
    groups.get(entry.businessId).items.push(entry);
  }
  // Similar work side by side: within a business, items of one work type
  // together, in the order each type first waits.
  for (const group of groups.values()) {
    const first = new Map();
    group.items.forEach((entry, index) => { if (!first.has(entry.workType)) first.set(entry.workType, index); });
    group.items = group.items.map((entry, index) => ({ entry, index })).sort((a, b) => first.get(a.entry.workType) - first.get(b.entry.workType) || a.index - b.index).map(({ entry }) => entry);
  }
  return [...groups.values()];
}

/** Where a review came from, when the server says (staff only): the Buzz
 * thread and the job run that made it. Flat fields: `threadId`, and `job`
 * { jobId, jobName, runId, startedAt }. */
function reviewOrigin(review, item) {
  const text = (value) => (typeof value === "string" && value.trim() ? plain(value, 200) : undefined);
  const job = item?.job ?? review?.job ?? null;
  const out = {
    threadId: text(item?.threadId ?? review?.threadId),
    jobId: text(job?.jobId),
    jobName: text(job?.jobName),
    runId: text(job?.runId),
  };
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value));
}

/** Who made a review item and what set it off, for its byline:
 * `{ maker: { name, pubkey?, signed, app?, person?, personVerified, agent },
 * origin: { kind: job | request | proactive | unknown, text, threadId? } }`.
 * Reads Platform Control's `producer` and `origin` (review-artifact slice A):
 * `pubkey` only when the agent's request was signed (`verified.agentKey`), and
 * `signed` only then; everything else is as the agent reported it. Without
 * them, `madeBy` is shown whole (nothing is parsed out of it), with `job`,
 * `requestedBy` and `threadId`. */
function reviewByline(review, item) {
  const text = (value, max = 160) => (typeof value === "string" && value.trim() ? plain(value, max) : undefined);
  const key = (value) => (/^[0-9a-f]{64}$/i.test(String(value ?? "")) ? String(value).toLowerCase() : undefined);
  const producer = item?.producer ?? review?.producer;
  const said = item?.origin ?? review?.origin;
  const job = item?.job ?? review?.job;
  const threadId = text(said?.threadId ?? item?.threadId ?? review?.threadId, 200);
  const requestedBy = text(item?.requestedBy ?? review?.requestedBy, 120);
  let maker;
  if (producer && typeof producer === "object") {
    const verified = producer.verified ?? {};
    const pubkey = verified.agentKey === true ? key(producer.agentKey) : undefined;
    const model = text(producer.model, 60);
    const app = text(producer.app, 60);
    maker = { name: text(producer.agent, 80) ?? text(item?.madeBy ?? review?.madeBy, 160) ?? "An agent", agent: true, signed: !!pubkey,
      ...(pubkey ? { pubkey } : {}),
      ...(model || app ? { app: model && app ? `${model} via ${app}` : model ?? app } : {}),
      ...(text(producer.person, 120) ? { person: text(producer.person, 120), personVerified: verified.person === true } : {}) };
  } else maker = { name: text(item?.madeBy ?? review?.madeBy, 160) ?? "Unknown maker", agent: false, signed: false };
  let origin;
  const kind = said && typeof said === "object" ? said.kind : undefined;
  if (kind === "job" || (!kind && job && (job.jobName || job.jobId))) {
    const run = kind === "job" ? said.job : job;
    origin = { kind: "job", text: `Scheduled job ${text(run?.jobName, 80) ?? text(run?.jobId, 80) ?? ""}`.trim() };
  } else if (kind === "request" || (!kind && requestedBy && !/^proactive$/i.test(requestedBy))) {
    origin = { kind: "request", text: `Asked by ${text(kind === "request" ? said.requestedBy : requestedBy, 120) ?? "someone"}` };
  } else if (kind === "unknown") origin = { kind: "unknown", text: "What started it was not recorded" };
  else origin = { kind: "proactive", text: "On the agent's own initiative" };
  if (threadId) origin.threadId = threadId;
  return { maker, origin };
}

/** An item's state in words, from its own decision fields: approval is never
 * shown as completion. */
function reviewState(item, receipt) {
  if (receipt && receipt.state !== "saved") {
    if (receipt.state === "pending") return { tone: "pending", text: receipt.verdict === "approved" ? "Approving" : receipt.verdict === "rejected" ? "Rejecting" : "Asking for changes" };
    if (receipt.state === "sending") return { tone: "pending", text: "Saving" };
  }
  const decision = receipt?.decision ?? item?.decision;
  if (!decision) {
    if (!item || item.status === "awaiting_decision" || item.decidable) return { tone: "waiting", text: "Waiting for you" };
    const not = { decided: "Decided", newer_version: "A newer version is coming", customer_approver: "The customer's approver decides",
      another_approver: "Another approver decides", administrator_only: "An administrator decides", view_only: "View only" };
    return { tone: "quiet", text: not[item.status] ?? "Not yours to decide" };
  }
  const by = decision.reviewer ? ` by ${plain(decision.reviewer, 80)}` : "";
  if (decision.verdict === "changes_requested") return { tone: "done", text: `Changes asked${by}` };
  if (decision.verdict === "rejected") return { tone: "done", text: `Rejected${by}` };
  const run = { pending: "waiting to run", in_progress: "running", completed: decision.releaseOutcome === "did_not_go_live" ? "done, not live" : "done",
    blocked: "blocked", not_applicable: "nothing to run" }[decision.executionStatus] ?? "waiting to run";
  return { tone: decision.executionStatus === "completed" ? "done" : "approved", text: `Approved${by} · ${run}` };
}

/** The Reviews data: reads, the decision tokens and every decision's receipt.
 * `call(name, args, { timeoutMs })` answers the raw MCP tools/call result. */
function reviewData(call, { now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
  undoMs = REVIEW_UNDO_MS, timeoutMs = REVIEW_DECIDE_TIMEOUT_MS } = {}) {
  const tokens = new Map(); // item id -> { token, version, expiresAt }: this closure only
  const previews = new Map(); // item id -> { after, before }: { url, contentType }
  const captures = new Map(); // item id -> { capture?, beforeCapture? }: the platform's pictures of the page (desktop size)
  const reviews = new Map(); // asset key -> { data, readAt }
  const flights = new Map(); // asset key -> a read in flight
  const businesses = new Map(); // assetId -> businessId (locators only)
  const receipts = new Map(); // item id -> receipt
  const timers = new Map(); // item id -> undo timer
  const images = new Map(); // `${id}/${which}` -> Promise<data URL | null>
  const pictures = new Map(); // `${id}/${which}` -> data URL, once read
  const listeners = new Set();
  let queue = null;
  let queueFlight = null;
  let serverNeedsBusiness = false;
  let revision = 0;
  let epoch = 0; // moves on at reset: answers to an older connection go nowhere
  let disposed = false;

  const changed = () => { revision += 1; for (const listener of [...listeners]) { try { listener(); } catch {} } };
  const remember = (assetId, businessId) => {
    if (!assetId || !businessId) return;
    if (businesses.size >= 500) businesses.delete(businesses.keys().next().value);
    businesses.set(assetId, businessId);
  };
  /** The answer's data, its private part kept apart. */
  const answer = (result) => {
    const meta = result?._meta?.[REVIEW_CARD_META];
    const bare = result && typeof result === "object" ? { ...result } : result;
    if (bare && typeof bare === "object") delete bare._meta;
    const data = readAnswer(bare);
    return { data: data?.data && data.kind === undefined ? data.data : data, meta };
  };

  const noteQueue = (value) => {
    if (!value || value.kind !== "black4_review_queue") return;
    queue = value;
    for (const review of value.reviews ?? []) remember(review.assetId, review.businessId);
    for (const entry of [...(value.blocked ?? []), ...(value.stalled ?? [])]) remember(entry.assetId, entry.businessId);
    changed();
  };
  const readQueue = () => queueFlight ??= (async () => {
    try {
      const data = reviewQueueOf(await call("review_queue", {}));
      if (data?.kind !== "black4_review_queue") throw new Error("Black 4 answered with something Reviews cannot show.");
      noteQueue(data);
      return data;
    } finally { queueFlight = null; }
  })();

  /** Keeps a review's tokens and previews here and returns its data. */
  const keep = (data, meta) => {
    const key = reviewAssetKey(data.businessId, data.assetId);
    remember(data.assetId, data.businessId);
    for (const item of data.items ?? []) {
      const id = reviewItemId(data.businessId, data.assetId, item.key);
      const minted = meta?.decisionTokens?.[item.key];
      if (data.decideIn === "card" && item.decidable && typeof minted?.token === "string" && Number.isInteger(minted.version)) {
        tokens.set(id, { token: minted.token, version: minted.version, expiresAt: Date.parse(minted.expiresAt) || now() + 15 * 60 * 1000 });
      } else tokens.delete(id);
      const after = meta?.previews?.[item.key];
      const before = meta?.beforePreviews?.[item.key];
      if (after || before) previews.set(id, { after, before });
      // Captures of the item's page (and of its before page), desktop width.
      const shot = (entry) => { const link = entry?.desktop ?? entry?.phone; return typeof link?.url === "string" && /^https:\/\//.test(link.url) ? { url: link.url, contentType: link.contentType ?? "image/jpeg" } : null; };
      const capture = shot(meta?.captures?.[item.key]);
      const beforeCapture = shot(meta?.beforeCaptures?.[item.key]);
      if (capture || beforeCapture) captures.set(id, { capture, beforeCapture });
      // A decision the server now shows replaces a receipt still unsure of it.
      const receipt = receipts.get(id);
      if (receipt && item.decision && ["unknown", "conflict"].includes(receipt.state)) receipts.set(id, { ...receipt, state: "saved", decision: item.decision });
    }
    reviews.set(key, { data, readAt: now() });
    changed();
    return data;
  };

  const ask = async (args) => {
    const { data, meta } = answer(await call("open_review", args));
    if (data?.kind !== "black4_review" || data.assetId !== args.assetId || (args.businessId && data.businessId !== args.businessId)) {
      throw new Error("The review Black 4 sent does not match this link.");
    }
    return keep(data, meta);
  };
  /** Which business a review belongs to, without asking when it is known. */
  const businessOf = (locator) => locator.businessId || businesses.get(locator.assetId)
    || queue?.reviews?.find((review) => review.assetId === locator.assetId)?.businessId;

  /** One review, read again unless a fresh copy is here. Resolves the
   * business from the link, then what is known, then open_review without it,
   * then the queue (older servers). Rejects with `code: "elsewhere"` (not a
   * fault) when this account's queue does not hold it. */
  const open = async (locator, { fresh = false } = {}) => {
    if (!locator?.assetId) throw new Error("This is not a Black 4 review link.");
    let businessId = businessOf(locator);
    if (businessId) {
      const cached = reviews.get(reviewAssetKey(businessId, locator.assetId));
      if (!fresh && cached && now() - cached.readAt < REVIEW_FRESH_MS) return cached.data;
    }
    const flightKey = `${businessId ?? "?"}/${locator.assetId}`;
    if (flights.has(flightKey)) return flights.get(flightKey);
    const flight = (async () => {
      if (!businessId && !serverNeedsBusiness) {
        try { return await ask({ assetId: locator.assetId, ...(locator.itemKey ? { itemKey: locator.itemKey } : {}) }); } catch (error) {
          // A server that needs businessId refuses the input; it is asked by business from now on.
          if (error?.serverCode === "review_not_found") throw Object.assign(new Error("This review isn't waiting in your queue."), { code: "elsewhere" });
          if (error?.code === "rpc" || /businessId|required|invalid/i.test(String(error?.message))) serverNeedsBusiness = true;
          else throw error;
        }
      }
      if (!businessId) businessId = businessOf(locator) ?? (await readQueue(), businessOf(locator));
      if (!businessId) throw Object.assign(new Error("This review isn't waiting in your queue."), { code: "elsewhere" });
      return ask({ businessId, assetId: locator.assetId });
    })().finally(() => flights.delete(flightKey));
    flights.set(flightKey, flight);
    return flight;
  };

  const cachedReview = (businessId, assetId) => reviews.get(reviewAssetKey(businessId, assetId))?.data ?? null;
  /** A review already read for this locator, its business found from what is known. */
  const peek = (locator) => { const businessId = locator?.assetId ? businessOf(locator) : null; return businessId ? cachedReview(businessId, locator.assetId) : null; };
  const canDecide = (review, item) => !!review && !!item && review.decideIn === "card" && item.decidable === true
    && tokens.has(reviewItemId(review.businessId, review.assetId, item.key));

  /** An image of the item's work as a data URL, read through get_review_file
   * (the MCP origin only): `which` is "after" (the preview) or "before". */
  /** A picture behind a link the server shared: read through get_review_file
   * (the MCP origin; an image part) when its path is a review file; a capture,
   * which may not be, is shown from its own exact-file link if that read fails. */
  const pictureFrom = (businessId, assetId, version, link, cacheKey, { direct = false } = {}) => {
    if (images.has(cacheKey)) return images.get(cacheKey);
    const read = (async () => {
      if (!link?.url || !/^image\//.test(String(link.contentType ?? ""))) return null;
      const match = String(link.url).match(/^https:\/\/[^/]+\/v\/[^/]+\/(.+)$/);
      if (match) {
        const path = match[1].split(/[?#]/)[0].split("/").map((part) => { try { return decodeURIComponent(part); } catch { return part; } }).join("/");
        try {
          const result = await call("get_review_file", { businessId, assetId, path, ...(version ? { version } : {}) });
          const part = !result?.isError && (result?.content ?? []).find((entry) => entry?.type === "image" && typeof entry.data === "string");
          if (part && /^image\/(png|jpeg|gif|webp|avif)$/.test(String(part.mimeType))) return `data:${part.mimeType};base64,${part.data}`;
        } catch {}
      }
      return direct && /^https:\/\//.test(link.url) ? link.url : null;
    })().catch(() => null);
    if (images.size >= 80) images.delete(images.keys().next().value);
    images.set(cacheKey, read);
    read.then((src) => { if (src) { if (pictures.size >= 80) pictures.delete(pictures.keys().next().value); pictures.set(cacheKey, src); changed(); } });
    return read;
  };
  /** An image of the item's work as a data URL (or a capture's own link):
   * `which` is "after" (the preview), "before", "capture" or "beforeCapture". */
  const image = (businessId, assetId, key, which = "after") => {
    const id = reviewItemId(businessId, assetId, key);
    const shots = captures.get(id);
    const link = which === "capture" ? shots?.capture : which === "beforeCapture" ? shots?.beforeCapture : previews.get(id)?.[which];
    const version = cachedReview(businessId, assetId)?.items?.find((entry) => entry.key === key)?.version;
    return pictureFrom(businessId, assetId, version, link, `${id}/${which}`, { direct: which === "capture" || which === "beforeCapture" });
  };
  /** The capture the queue lists for a review (a later platform slice), once read. */
  const queuePicture = (entry) => {
    const link = entry?.capture?.desktop ?? entry?.capture?.phone ?? entry?.capture;
    if (typeof link?.url !== "string") return null;
    const cacheKey = `${entry.businessId}/${entry.assetId}/queue-capture`;
    const ready = pictures.get(cacheKey);
    if (!ready) void pictureFrom(entry.businessId, entry.assetId, entry.version, { url: link.url, contentType: link.contentType ?? "image/jpeg" }, cacheKey, { direct: true });
    return ready ?? null;
  };

  // ---- deciding ----------------------------------------------------------------
  const setReceipt = (id, receipt) => {
    if (receipt) receipts.set(id, receipt); else receipts.delete(id);
    changed();
  };
  /** Marks the cached item decided with the server's own decision. */
  const decided = (receipt, decision) => {
    const cached = reviews.get(reviewAssetKey(receipt.businessId, receipt.assetId));
    if (cached) {
      cached.data = { ...cached.data, items: (cached.data.items ?? []).map((item) => item.key !== receipt.key ? item
        : { ...item, decidable: false, status: "decided", decision: { ...(item.decision ?? {}), ...decision } }) };
    }
    if (queue?.reviews) {
      queue = { ...queue, total: Math.max(0, (queue.total ?? 1) - 1), reviews: queue.reviews
        .map((review) => review.assetId !== receipt.assetId || review.businessId !== receipt.businessId ? review
          : { ...review, items: (review.items ?? []).filter((item) => item.key !== receipt.key) })
        .filter((review) => review.items.length) };
    }
  };
  /** Reads the review again and settles a receipt from the item's own decision. */
  const settle = async (id, fallback) => {
    const receipt = receipts.get(id);
    if (!receipt) return;
    let item;
    try {
      const data = await open({ assetId: receipt.assetId, businessId: receipt.businessId }, { fresh: true });
      item = data.items?.find((entry) => entry.key === receipt.key);
    } catch {}
    if (disposed || !receipts.get(id)) return; // undone or cleared meanwhile
    if (item?.decision) {
      const mine = item.decision.verdict === receipt.verdict;
      setReceipt(id, { ...receipt, state: mine ? "saved" : "conflict", decision: item.decision,
        message: mine ? "" : "Someone else decided this item first." });
      if (mine) decided(receipt, item.decision);
      return;
    }
    if (item && item.version !== receipt.version) {
      setReceipt(id, { ...receipt, state: "conflict", code: "stale_review", message: "A newer version arrived. Read it, then decide again." });
      return;
    }
    setReceipt(id, { ...receipt, ...fallback });
  };

  const send = async (id) => {
    const receipt = receipts.get(id);
    if (!receipt || disposed) return;
    const mine = epoch;
    const stale = () => mine !== epoch || disposed;
    setReceipt(id, { ...receipt, state: "sending", message: "" });
    let token = tokens.get(id);
    try {
      if (!token || token.expiresAt - now() < REVIEW_TOKEN_RENEW_MS) {
        await open({ assetId: receipt.assetId, businessId: receipt.businessId }, { fresh: true });
        if (stale()) return;
        token = tokens.get(id);
        const item = cachedReview(receipt.businessId, receipt.assetId)?.items?.find((entry) => entry.key === receipt.key);
        if (item?.decision) return settle(id);
        if (!token) {
          setReceipt(id, { ...receipt, state: "conflict", code: "not_decidable", message: "This item can't be decided here any more." });
          return;
        }
      }
      // A renewed token can name a version the person has not seen: nothing is sent.
      if (token.version !== receipt.version) {
        setReceipt(id, { ...receipt, state: "conflict", code: "stale_review", message: "A newer version arrived. Read it, then decide again." });
        return;
      }
    } catch (error) {
      setReceipt(id, { ...receipt, state: "failed", message: plain(error?.message ?? error, 200) || "Couldn't reach Black 4." });
      return;
    }
    tokens.delete(id); // single use, whatever the answer
    let result;
    try {
      let timer;
      const late = new Promise((_, reject) => { timer = setTimer(() => reject(Object.assign(new Error("No answer in time."), { code: "timeout" })), timeoutMs); });
      const ask = () => call("decide_review_item", {
        businessId: receipt.businessId, assetId: receipt.assetId, version: receipt.version, itemKey: receipt.key,
        verdict: receipt.verdict, decisionToken: token.token, ...(receipt.feedback ? { feedback: receipt.feedback } : {}),
      }, { timeoutMs });
      // Too many at once (HTTP 429): the same call with the same token is safe
      // to repeat (Platform Control returns the saved decision), after a pause.
      const attempt = async (left) => {
        try { return await ask(); } catch (error) {
          if (left > 0 && /HTTP 429/.test(String(error?.message)) && !stale()) {
            await new Promise((resolve) => setTimer(resolve, 1500));
            return attempt(left - 1);
          }
          throw error;
        }
      };
      try {
        result = await Promise.race([attempt(3), late]);
      } finally { clearTimer(timer); }
    } catch (error) {
      if (stale()) return;
      // It may or may not have arrived: read before claiming anything.
      if (["timeout", "offline", "http"].includes(error?.code) || !error?.code) {
        setReceipt(id, { ...receipt, state: "unknown", message: "Checking whether it saved…" });
        return settle(id, { state: "unknown", message: "Couldn't confirm it saved." });
      }
      setReceipt(id, { ...receipt, state: "failed", message: plain(error?.message ?? error, 200) });
      return;
    }
    if (stale()) return;
    let data;
    try { data = answer(result).data; } catch (error) {
      const code = error?.serverCode;
      if (REVIEW_CONFLICTS.includes(code)) {
        setReceipt(id, { ...receipt, state: "conflict", code, message: code === "decision_exists" ? "This item was already decided." : "A newer version arrived. Read it, then decide again." });
        return settle(id, { state: "conflict", code, message: receipts.get(id)?.message });
      }
      if (REVIEW_TOKEN_CODES.includes(code)) return settle(id, { state: "failed", code, message: "That decision link lapsed. Try again." });
      setReceipt(id, { ...receipt, state: "failed", code, message: plain(error?.message ?? error, 200) || "Black 4 refused the decision." });
      return;
    }
    const decision = data?.decision;
    if (!decision || decision.itemKey !== receipt.key || decision.verdict !== receipt.verdict) {
      setReceipt(id, { ...receipt, state: "unknown", message: "Checking whether it saved…" });
      return settle(id, { state: "unknown", message: "Couldn't confirm it saved." });
    }
    decided(receipt, decision);
    setReceipt(id, { ...receipt, state: "saved", decision, message: "" });
  };

  // At most REVIEW_PARALLEL decisions in flight (bulk approvals): the server
  // limits a customer's parallel calls.
  const waiting = [];
  let inFlight = 0;
  const enqueue = (id) => { waiting.push(id); pump(); };
  const pump = () => {
    while (inFlight < REVIEW_PARALLEL && waiting.length && !disposed) {
      const id = waiting.shift();
      inFlight += 1;
      send(id).finally(() => { inFlight -= 1; pump(); });
    }
  };
  /** A person chose a verdict: it waits `undoMs` for Undo, then is sent.
   * Ask for changes and Reject need feedback. Returns the receipt, or null. */
  const propose = ({ review, item, verdict, feedback = "" }) => {
    if (disposed || !review || !item || !REVIEW_VERDICTS.includes(verdict)) return null;
    const id = reviewItemId(review.businessId, review.assetId, item.key);
    if (["pending", "sending", "saved"].includes(receipts.get(id)?.state)) return receipts.get(id);
    if (!canDecide(review, item)) return null;
    const note = String(feedback ?? "").trim().slice(0, 8000);
    if (verdict !== "approved" && !note) return null;
    const receipt = { id, state: "pending", verdict, feedback: note, businessId: review.businessId, businessName: review.businessName, assetId: review.assetId,
      key: item.key, version: item.version, title: item.card?.question || item.title, deadline: now() + undoMs, message: "" };
    clearTimer(timers.get(id));
    timers.set(id, setTimer(() => { timers.delete(id); enqueue(id); }, undoMs));
    setReceipt(id, receipt);
    return receipt;
  };
  /** Stops a decision still in its Undo window: nothing was sent. */
  const undo = (id) => {
    if (receipts.get(id)?.state !== "pending") return false;
    clearTimer(timers.get(id));
    timers.delete(id);
    setReceipt(id, null);
    return true;
  };
  /** The same intent again, now (a person's click). */
  const retry = (id) => {
    const receipt = receipts.get(id);
    if (!receipt || receipt.state !== "failed") return;
    enqueue(id);
  };
  /** Reads an unsure receipt's item again. */
  const recheck = (id) => {
    const receipt = receipts.get(id);
    if (!receipt || !["unknown", "conflict"].includes(receipt.state)) return Promise.resolve();
    return settle(id, { state: receipt.state, message: receipt.message });
  };
  /** Forgets a conflict once the person loads the new version. */
  const clear = (id) => { if (["conflict", "failed", "unknown"].includes(receipts.get(id)?.state)) setReceipt(id, null); };

  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get revision() { return revision; },
    get queue() { return queue; },
    noteQueue, readQueue, open, cachedReview, peek, canDecide, image,
    /** An image of the work already read (`after`, `before` or `capture`), or null. */
    picture: (businessId, assetId, key, which = "after") => pictures.get(`${reviewItemId(businessId, assetId, key)}/${which}`) ?? null,
    /** Which picture of the work there is to show: the platform's capture, else an image preview. */
    pictureKind: (businessId, assetId, key) => {
      const id = reviewItemId(businessId, assetId, key);
      if (captures.get(id)?.capture) return "capture";
      return /^image\//.test(String(previews.get(id)?.after?.contentType ?? "")) ? "after" : null;
    },
    hasBefore: (businessId, assetId, key) => /^image\//.test(String(previews.get(reviewItemId(businessId, assetId, key))?.before?.contentType ?? "")),
    hasBeforeCapture: (businessId, assetId, key) => !!captures.get(reviewItemId(businessId, assetId, key))?.beforeCapture,
    queuePicture,
    /** The work's own preview link (a page or file the server shared for
     * showing the work), or null. Never a decision token. */
    preview: (businessId, assetId, key) => {
      const link = previews.get(reviewItemId(businessId, assetId, key))?.after;
      return typeof link?.url === "string" && /^https:\/\//.test(link.url) && !/^image\//.test(String(link.contentType ?? "")) ? link.url : null;
    },
    receipt: (id) => receipts.get(id) ?? null,
    /** Forgets everything of the last connection: cancels any decision still in
     * its Undo window (nothing is sent) and drops tokens, reviews and receipts. */
    reset() {
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
      waiting.length = 0;
      for (const map of [tokens, previews, captures, reviews, flights, businesses, receipts, images, pictures]) map.clear();
      queue = null;
      queueFlight = null;
      serverNeedsBusiness = false;
      epoch += 1;
      changed();
    },
    receipts: () => [...receipts.values()],
    propose, undo, retry, recheck, clear,
    dispose() {
      disposed = true;
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
      tokens.clear();
      listeners.clear();
    },
  };
}

/** A word diff of two texts, as runs `{ kind: "same" | "added" | "removed", text }`.
 * Whole words and their spaces; long texts fall back to one removed and one added run. */
function wordDiff(before, after) {
  const split = (text) => String(text ?? "").match(/\s+|[^\s]+/g) ?? [];
  const a = split(before), b = split(after);
  if (a.length * b.length > 250000) return [...(a.length ? [{ kind: "removed", text: a.join("") }] : []), ...(b.length ? [{ kind: "added", text: b.join("") }] : [])];
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const runs = [];
  const push = (kind, text) => { const last = runs[runs.length - 1]; if (last?.kind === kind) last.text += text; else runs.push({ kind, text }); };
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push("same", a[i]); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) push("removed", a[i++]);
    else push("added", b[j++]);
  }
  while (i < a.length) push("removed", a[i++]);
  while (j < b.length) push("added", b[j++]);
  return runs;
}
