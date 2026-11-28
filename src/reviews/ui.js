// ---- Reviews: the screens ------------------------------------------------------
// Drawn only with the Buzz UI kit. The work is the hero: the agent's artifact,
// live, filling a canvas, under one line with who made it and the question.
// A thin strip at the bottom says what approving permits and decides; every
// reason, the evidence and the exact request sit in one closed disclosure.

/** The screens over one reviewData store. `bridge`: { use, SignInPrompt,
 * browser, openThread? }. */
function reviewScreens(React, store, bridge) {
  const h = React.createElement;
  const ui = buzzUi(React);
  const { Button, IconButton, PanelHeader, Subview, PanelBody, EmptyState, Column, Actions, Stack, SectionTitle, Title, Caption, Strong, Lines, Line, Note, Status,
    Disclosure, Group, Row, Pre, Failure, TextField, CountBadge, Chip, ChipRow, DiffText, ChangeTable, MediaPair, DecisionBar, Skeleton, SelectRow, ListGroup, Split, Toolbar,
    Avatar, Byline: BylineLine, Canvas, CanvasImage, QuietLine, Question, Tabs } = ui;

  const CONNECTION_TEXT = {
    starting: "Connecting to Black 4…",
    "signing-in": "Waiting for you to sign in to Black 4.",
    "signed-out": "Not signed in to Black 4.",
    stopped: "Black 4 is stopped.",
    failed: "Black 4 is not connected.",
  };
  const VERDICT_WORDS = { approved: "Approve", changes_requested: "Ask for changes", rejected: "Reject" };
  const COMPOSE = {
    changes_requested: { label: "What should change?", send: "Ask for changes" },
    rejected: { label: "Why reject it?", send: "Reject" },
  };

  /** Re-renders when the store changes. */
  const useStore = () => {
    const [, setTick] = React.useState(0);
    React.useEffect(() => store.subscribe(() => setTick((n) => n + 1)), []);
    return store.revision;
  };
  const useConnection = () => {
    const raw = bridge.use();
    return typeof raw === "string" ? { status: raw } : raw ?? { status: "failed" };
  };
  /** A clock that ticks while `active` (Undo countdowns). */
  const useTicking = (active) => {
    const [, setTick] = React.useState(0);
    React.useEffect(() => {
      if (!active) return undefined;
      const timer = setInterval(() => setTick((n) => n + 1), 250);
      return () => clearInterval(timer);
    }, [active]);
  };
  /** The Customer menu's value for every business. */
  const REVIEW_ALL_CUSTOMERS = "all";
  const capital = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);
  const STAKE_GLYPH = { money: "money", customers: "people", risk: "alert", none: null };

  /** Where Black 4 stands, while not connected: Sign in, or a line. */
  function NotConnected({ link, compact = false }) {
    if (bridge.SignInPrompt && ["signed-out", "signing-in", "idle"].includes(link.status)) return h(bridge.SignInPrompt, { compact });
    return h(Column, { gap: 2 },
      Line(CONNECTION_TEXT[link.status] ?? `Black 4: ${link.status}.`, { role: "status" }),
      link.detail ? Line(link.detail) : null,
      link.connect && (link.status === "failed" || link.status === "stopped") ? h(Button, { variant: "prominent", size: compact ? "sm" : "md", onClick: link.connect }, "Connect Black 4") : null);
  }

  // ---- who made it -----------------------------------------------------------------
  const ORIGIN_GLYPH = { job: "clock", request: "message", proactive: "sparkles", unknown: null };
  /** The maker (a Buzz identity when the review names an agent key) and what
   * set it off. `size`: the avatar's. */
  function Byline({ review, item, size = "small" }) {
    const { maker, origin } = reviewByline(review, item);
    const profile = maker.pubkey ? bridge.profile?.(maker.pubkey) : null;
    const name = profile?.name || maker.name;
    const canOpen = origin.threadId && bridge.openThread;
    return h(BylineLine, {
      avatar: h(Avatar, { name, picture: profile?.picture, size, shape: maker.agent ? "squircle" : "circle" }),
      name, badge: maker.signed ? "Signed" : undefined,
      detail: [maker.app, maker.person ? `for ${maker.person}` : null].filter(Boolean).join(" · ") || undefined,
      origin: origin.text, originGlyph: ORIGIN_GLYPH[origin.kind],
      onOrigin: canOpen ? () => bridge.openThread(origin) : undefined,
    });
  }
  /** The same, as one line of words (queue rows, message cards). */
  const bylineWords = (review, item) => { const { maker, origin } = reviewByline(review, item); return `${maker.name}${maker.signed ? " (signed)" : ""} · ${origin.text}`; };

  // ---- the work itself: a canvas, by kind of work -------------------------------------
  /** An image of the work (or the platform's capture of a page), loaded through the MCP. */
  function usePicture(review, item, which) {
    const [src, setSrc] = React.useState(() => (which ? store.picture(review.businessId, review.assetId, item.key, which) : null));
    React.useEffect(() => {
      let live = true;
      if (!which) return undefined;
      setSrc(store.picture(review.businessId, review.assetId, item.key, which));
      store.image(review.businessId, review.assetId, item.key, which).then((value) => { if (live) setSrc(value); });
      return () => { live = false; };
    }, [review.assetId, item.key, item.version, which]);
    return src ?? store.picture(review.businessId, review.assetId, item.key, which ?? "after");
  }
  /** Canvas renderers, by kind: the artifact page; an image (Now / After); else
   * the plain fallback for reviews that carry no work to show. */
  const CANVAS = {
    /** The agent's artifact, live: the review's own preview of the work (never
     * the review application), with the platform's capture behind it while it loads. */
    page({ review, item, link }) {
      const hasBefore = store.hasBeforeCapture(review.businessId, review.assetId, item.key);
      const [which, setWhich] = React.useState("after");
      const shown = hasBefore ? which : "after";
      const capture = usePicture(review, item, store.pictureKind(review.businessId, review.assetId, item.key) === "capture" ? "capture" : null);
      const before = usePicture(review, item, hasBefore && shown === "before" ? "beforeCapture" : null);
      const toolbar = hasBefore ? [Caption(item.title), h(Tabs, { key: "toggle", variant: "segmented", label: "Show", value: shown, onChange: setWhich,
        items: [{ value: "before", label: "Now" }, { value: "after", label: "After" }] })] : null;
      if (shown === "before") return h(Canvas, { label: `The page now: ${item.title}`, toolbar, fit: !!bridge.browser }, h(CanvasImage, { src: before, alt: `${item.title}: now` }));
      // The live page over its capture: the capture shows until the page paints.
      return h(Canvas, { label: `The work: ${item.title}`, toolbar, fit: !!bridge.browser },
        bridge.browser
          ? h(ui.Layers, { key: link }, capture ? h(CanvasImage, { src: capture, alt: item.title }) : null,
              h(bridge.browser, { url: link, storage: "black4-review-work", label: `The work: ${item.title}` }))
          : capture ? h(CanvasImage, { src: capture, alt: item.title })
            : Note(item.capture === "pending" ? "Preparing a preview of the page." : "This page can't be shown here."));
    },
    /** An image, large, with Now / After when there is a before. */
    media({ review, item }) {
      const before = store.hasBefore(review.businessId, review.assetId, item.key);
      const [which, setWhich] = React.useState("after");
      const shown = before ? which : "after";
      const src = usePicture(review, item, shown);
      return h(Canvas, { label: `The work: ${item.title}`,
        toolbar: before ? [Caption(item.card?.show?.label ?? item.title), h(Tabs, { key: "toggle", variant: "segmented", label: "Show", value: shown, onChange: setWhich,
          items: [{ value: "before", label: "Now" }, { value: "after", label: "After" }] })] : null },
        h(CanvasImage, { src, alt: `${item.title}: ${shown === "before" ? "now" : "after"}` }));
    },
    /** Older reviews with no work to show: plain and quiet. */
    fallback({ item }) {
      const show = item.card?.show;
      const brief = item.brief ?? {};
      let change = null;
      if (show?.type === "fields" && show.rows?.length) {
        change = h(ChangeTable, { rows: show.rows.map((row) => ({ label: row.label, before: row.before ?? "", after: row.after ?? "", changed: (row.before ?? "") !== (row.after ?? "") })) });
      } else if (show?.type === "text") change = h(DiffText, { label: show.label, runs: wordDiff(show.before ?? "", show.after ?? "") });
      else if (show?.type === "list" && show.rows?.length) {
        change = h("div", null, show.label ? h(SectionTitle, { title: show.label }) : null,
          h(Group, null, ...show.rows.map((row, index) => h(Row, { key: `${index}`, title: row.label, description: row.detail }))));
      } else if (brief.before || brief.after) change = h(ChangeTable, { rows: [{ label: "", before: brief.before ?? "", after: brief.after ?? "", changed: brief.before !== brief.after }] });
      return change ?? Note(item.action || "No change was attached.");
    },
  };
  /** Which canvas a review item gets: its artifact page, its image, else the fallback. */
  function Work({ review, item, link }) {
    if (link) return h(CANVAS.page, { review, item, link });
    if (store.pictureKind(review.businessId, review.assetId, item.key) || item.card?.show?.type === "media") return h(CANVAS.media, { review, item });
    return h(CANVAS.fallback, { item });
  }

  /** Why, evidence, provenance and the pinned request: one closed disclosure. */
  function Details({ review, item }) {
    const card = item.card ?? {};
    const brief = item.brief ?? {};
    const change = item.change && !item.change.erased ? item.change : null;
    const origin = reviewOrigin(review, item);
    const row = (title, text) => (text ? h(Row, { key: title, title, description: text }) : null);
    // The goals it serves: the review's own, else as the queue lists them.
    const own = reviewGoalsOf(item.goals ?? review.goals);
    const goals = own.length ? own : reviewListed(store.queue).find((entry) => entry.assetId === review.assetId && entry.key === item.key)?.goals ?? [];
    return h(Disclosure, { title: "Details" },
      h(Stack, { gap: 4 },
        h(Group, null,
          row("Recommendation", card.recommend?.answer ? `${capital(String(card.recommend.answer))}${card.recommend.why ? `: ${card.recommend.why}` : ""}` : ""),
          row("Stake", card.stake?.text),
          row("Facts", (card.facts ?? []).join(" · ")),
          row("If yes", card.ifYes || brief.expectedResult),
          row("If no", card.ifNo),
          row("Tradeoff", card.tradeoff),
          row("Why", brief.why),
          row("Before", brief.before),
          row("After", brief.after),
          row("Success looks like", brief.successMeasure),
          row("Evidence", brief.baselineSource ? `${brief.baselineSource}${brief.baselineObservedAt ? ` · ${brief.baselineObservedAt}` : ""}` : ""),
          // The byline already names the maker when Black 4 sends `producer`.
          row("Made by", item.producer ?? review.producer ? "" : reviewMadeBy(item.madeBy ?? review.madeBy)),
          row("Asked by", item.requestedBy),
          row("Job", origin.jobName || origin.jobId),
          row("Goal", goals.map((goal) => goal.title).join(" · ")),
          row("Version", `${item.version}${review.title ? ` of ${review.title}` : ""}`)),
        change ? h("div", null, h(SectionTitle, { title: "Pinned request" }),
          h(Stack, { gap: 2 },
            Caption(`${change.method} ${change.endpoint} · ${change.connector}${change.connection ? ` (${change.connection})` : ""}${change.records != null ? ` · ${change.records} records` : ""}`),
            Pre(change.lines.map((line) => `${line.label}: ${line.value}`).join("\n") + (change.more ? `\n… ${change.more} more` : "")))) : null));
  }

  // ---- deciding --------------------------------------------------------------------
  /** The bar at the bottom: Approve, Ask for changes, Reject; then Undo; then the receipt. */
  function Decide({ review, item, onReload, autoFocus, compose, setCompose }) {
    useStore();
    const id = reviewItemId(review.businessId, review.assetId, item.key);
    const receipt = store.receipt(id);
    const [feedback, setFeedback] = React.useState("");
    React.useEffect(() => { setFeedback(""); }, [id, item.version, compose]);
    useTicking(receipt?.state === "pending");
    if (receipt?.state === "pending") {
      const left = Math.max(1, Math.ceil((receipt.deadline - Date.now()) / 1000));
      const words = { approved: "Approving", changes_requested: "Asking for changes", rejected: "Rejecting" }[receipt.verdict];
      return h(DecisionBar, { status: Status(`${words} in ${left} s`) },
        h(Button, { key: "undo", variant: "outline", autoFocus: true, onClick: () => store.undo(id) }, "Undo"));
    }
    if (receipt?.state === "sending") return h(DecisionBar, { status: Status("Saving…") });
    if (receipt?.state === "unknown") {
      return h(DecisionBar, { status: Line(receipt.message || "Couldn't confirm it saved.") },
        h(Button, { key: "check", onClick: () => void store.recheck(id) }, "Check again"));
    }
    if (receipt?.state === "conflict") {
      return h(DecisionBar, { status: Line(receipt.message || "This item changed.") },
        h(Button, { key: "load", variant: "prominent", onClick: () => { store.clear(id); onReload(); } }, "Load the new version"));
    }
    if (receipt?.state === "failed") {
      return h(DecisionBar, { status: Line(`${receipt.message || "It didn't save."}`, { danger: true, role: "alert" }) },
        h(Button, { key: "retry", variant: "prominent", onClick: () => store.retry(id) }, `Try ${VERDICT_WORDS[receipt.verdict].toLowerCase()} again`),
        h(Button, { key: "cancel", variant: "outline", onClick: () => store.clear(id) }, "Cancel"));
    }
    const decision = receipt?.decision ?? item.decision;
    if (decision || !item.decidable) {
      return h(DecisionBar, { status: Strong(reviewState(item, receipt).text) },
        decision?.feedback ? Caption(decision.feedback) : null);
    }
    if (!store.canDecide(review, item)) {
      // This connection got no decision token: say so quietly; never the website.
      return h(DecisionBar, { status: Line("Deciding isn't available on this connection yet.") },
        h(Button, { key: "retry", variant: "outline", onClick: onReload }, "Retry"));
    }
    if (compose) {
      const words = COMPOSE[compose];
      const send = () => { if (store.propose({ review, item, verdict: compose, feedback })) { setCompose(null); setFeedback(""); } };
      return h(DecisionBar, { stacked: true },
        h(TextField, { key: "feedback", label: words.label, value: feedback, onChange: setFeedback, rows: 3, maxLength: 8000, autoFocus: true,
          onKeyDown: (event) => { if (event.key === "Escape") { event.stopPropagation(); setCompose(null); } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send(); } }),
        h(Actions, { key: "actions" },
          h(Button, { key: "send", variant: compose === "rejected" ? "destructive" : "prominent", disabled: !feedback.trim(), onClick: send }, words.send),
          h(Button, { key: "cancel", variant: "outline", onClick: () => setCompose(null) }, "Cancel")));
    }
    const card = item.card ?? {};
    return h(DecisionBar, { status: h(Stack, { gap: 2 },
        // No stake and no facts: no line (the header already names the business).
        card.stake?.text || card.facts?.length ? h(QuietLine, { glyph: STAKE_GLYPH[card.stake?.kind] ?? null }, card.stake?.text || card.facts.join(" · ")) : null,
        item.action ? ui.Permits(item.action) : null) },
      h(Button, { key: "approve", variant: "prominent", autoFocus, "aria-keyshortcuts": "A", onClick: () => store.propose({ review, item, verdict: "approved" }) }, "Approve"),
      h(Button, { key: "changes", variant: "outline", "aria-keyshortcuts": "C", onClick: () => setCompose("changes_requested") }, "Ask for changes"),
      h(Button, { key: "reject", variant: "ghost", onClick: () => setCompose("rejected") }, "Reject"));
  }

  // ---- one item --------------------------------------------------------------------
  /** One review item, work first, with the decision bar. `entry`: a locator
   * `{ businessId?, assetId, itemKey? }`. `step`: { position, total, next,
   * previous } from the queue; `onBack`: to the queue. `onCommand` receives
   * this item's key commands while it is shown (shortcuts). */
  /** `accountActions`: what the surface adds to the item's header (the side panel: Sign out). */
  function ReviewItem({ entry, step, onBack, onCommand, onSaved, bar = null, accountActions = [] }) {
    const link = useConnection();
    useStore();
    const [state, setState] = React.useState({ review: null, error: null });
    const [revision, setRevision] = React.useState(0);
    const [compose, setCompose] = React.useState(null);
    const key = `${entry?.businessId ?? ""}/${entry?.assetId ?? ""}`;
    React.useEffect(() => setCompose(null), [key, entry?.itemKey]);
    // The store forgets a review when a newer version of one of its items is
    // listed: then it is read again, never left showing the old version.
    const held = !!(entry?.businessId && store.cachedReview(entry.businessId, entry.assetId));
    React.useEffect(() => {
      let live = true;
      if (link.status !== "connected" || !entry?.assetId) return () => { live = false; };
      const cached = entry.businessId ? store.cachedReview(entry.businessId, entry.assetId) : null;
      setState({ review: cached, error: null });
      store.open(entry, { fresh: revision > 0 }).then((review) => { if (live) setState({ review, error: null }); }, (error) => { if (live) setState({ review: null, error }); });
      return () => { live = false; };
    }, [key, link.status, revision, held]);
    const shown = state.review && entry?.assetId === state.review.assetId ? state.review : store.peek(entry);
    const review = shown ? (store.cachedReview(shown.businessId, shown.assetId) ?? shown) : null;
    // The next item is read while this one is on screen, so stepping is instant.
    const upcoming = step?.upcoming;
    React.useEffect(() => {
      // Its review, and the picture of its work, so the canvas swaps at once.
      if (link.status === "connected" && upcoming?.assetId && upcoming.assetId !== review?.assetId) {
        store.open(upcoming).then((next) => {
          const key = upcoming.itemKey ?? next.focusItemKey ?? next.items?.[0]?.key;
          const kind = key ? store.pictureKind(next.businessId, next.assetId, key) : null;
          if (kind) store.image(next.businessId, next.assetId, key, kind);
        }, () => {});
      }
    }, [upcoming?.assetId, review?.assetId, link.status]);
    const item = review ? (review.items.find((candidate) => candidate.key === entry.itemKey) ?? review.items.find((candidate) => candidate.key === review.focusItemKey) ?? review.items[0]) : null;
    const id = review && item ? reviewItemId(review.businessId, review.assetId, item.key) : null;
    const receipt = id ? store.receipt(id) : null;
    // A saved decision moves on to the next waiting item by itself: only when
    // this item's own decision saves while it is shown, never on arriving at an
    // item already decided.
    const shownAs = item ? `${id}@${item.version}` : null;
    const savedRef = React.useRef({ shownAs, saved: receipt?.state === "saved" });
    React.useEffect(() => {
      const saved = receipt?.state === "saved";
      const was = savedRef.current;
      savedRef.current = { shownAs, saved };
      if (saved && was.shownAs === shownAs && !was.saved && step?.next) {
        const timer = setTimeout(() => { onSaved?.(id); step.next(); }, 900);
        return () => clearTimeout(timer);
      }
      return undefined;
    }, [receipt?.state, shownAs]);
    // Key commands for this item (the surface's shortcuts call them).
    React.useEffect(() => {
      if (!onCommand) return undefined;
      return onCommand({
        // While picked items' bar stands in for this one, its keys don't decide this item.
        approve: !bar && review && item && !receipt && !compose && store.canDecide(review, item) ? () => store.propose({ review, item, verdict: "approved" }) : null,
        changes: !bar && review && item && !receipt && store.canDecide(review, item) ? () => setCompose("changes_requested") : null,
        reject: !bar && review && item && !receipt && store.canDecide(review, item) ? () => setCompose("rejected") : null,
        undo: receipt?.state === "pending" ? () => store.undo(id) : null,
      });
    }, [id, receipt?.state, review?.decideIn, compose, store.revision, !!bar]);

    // What approving writes to, from the pinned request: top right, beside the position.
    const destination = item ? reviewDestination(item) : null;
    const header = (title) => h(PanelHeader, { title,
      navigation: onBack ? h(IconButton, { label: "Back to the queue", glyph: "back", large: true, onClick: onBack }) : null,
      actions: [
        destination ? h(Chip, { key: "writes", label: destination.name, picture: destination.logo ?? undefined,
          title: destination.state === "known" ? `Approving changes ${destination.system}` : destination.name }) : null,
        step && step.position ? Caption(`${step.position} of ${step.total}`) : null,
        step ? h(IconButton, { key: "prev", label: "Previous decision (K)", glyph: "up", large: true, disabled: !step.previous, onClick: () => step.previous?.() }) : null,
        step ? h(IconButton, { key: "next", label: "Next decision (J)", glyph: "down", large: true, disabled: !step.next, onClick: () => step.next?.() }) : null,
        h(IconButton, { key: "refresh", label: "Refresh", glyph: "refresh", large: true, onClick: () => setRevision((n) => n + 1) }),
        ...accountActions,
      ].filter(Boolean) });
    const wrap = (title, body, bar = null, fit = false) =>
      h(Subview, { header: header(title), footer: bar }, h(PanelBody, { fit }, body));

    if (link.status !== "connected") return wrap("Reviews", h(NotConnected, { link }));
    if (state.error) {
      const elsewhere = state.error.code === "elsewhere";
      return wrap("Reviews", elsewhere
        ? Line("This review isn't waiting for you.")
        : h(Failure, { message: plain(state.error.message, 300), retry: () => setRevision((n) => n + 1), retryLabel: "Try again" }));
    }
    // While the next item loads, the strip keeps its place under a placeholder.
    if (!review) return wrap("Reviews", h(Skeleton, { layout: "item" }), h(DecisionBar, { status: Caption("Loading…") }));
    if (!item) return wrap(review.businessName, Line("Nothing in this review is shown to you."));
    const card = item.card ?? {};
    const headline = reviewHeadline({ question: card.question, title: item.title, reviewTitle: review.title });
    // One review can hold several decisions over one page of work: say which one this is.
    const at = review.items.indexOf(item);
    const among = review.items.length > 1 ? Caption(`Decision ${at + 1} of ${review.items.length}${review.title ? ` in ${review.title}` : ""}`) : null;
    // Older cards keep their original renderer when the review marks them as not work-first.
    const older = item.workFirst === false && card.show && card.show.type !== "media";
    const preview = older ? null : store.preview(review.businessId, review.assetId, item.key);
    const fit = !!(preview && bridge.browser);
    // Keyed by version too: a new version is a new card, with nothing carried over.
    const body = h(ui.Article, { key: `${id}@${item.version}`, label: headline, fit,
      heading: h(Stack, { gap: 2 }, h(Byline, { review, item }), reviewReplaces(review) ? Caption(reviewReplaces(review)) : null, among, Question(headline)),
      details: h(Details, { review, item }) },
      h(Work, { review, item, link: preview }));
    return wrap(review.businessName, body, bar ?? h(Decide, { review, item, compose, setCompose, onReload: () => setRevision((n) => n + 1) }), fit);
  }

  // ---- the queue -----------------------------------------------------------------
  /** A row's line: the question, else the title. */
  const questionOf = (entry) => {
    const cached = store.cachedReview(entry.businessId, entry.assetId)?.items?.find((item) => item.key === entry.key);
    return { question: reviewHeadline({ question: cached?.card?.question || entry.question, title: entry.title, reviewTitle: entry.reviewTitle }), stake: cached?.card?.stake?.text || entry.stake?.text || entry.brief || "" };
  };
  const receiptWords = (receipt) => receipt ? reviewState(null, receipt).text + (receipt.state === "failed" ? " · didn't save" : receipt.state === "unknown" ? " · unconfirmed" : receipt.state === "conflict" ? " · changed" : "") : "";

  /** The Customer and Goal menus over a queue, and the names of what they chose. */
  function queueMenus({ queue, filter, onFilter, goal = REVIEW_ALL_GOALS, goals, onGoal, attention = [] }) {
    const filterName = filter ? (reviewBusinessCounts(store.queue).find((business) => business.businessId === filter)?.businessName
      ?? reviewGroups(queue).find((group) => group.businessId === filter)?.businessName ?? attention[0]?.businessName ?? "this business") : "";
    // The Goal filter, only when some review here serves a goal.
    const goalPicker = goals?.goals?.length && onGoal ? h(ui.Pill, { key: "goal", label: "Goal", value: goal, onChange: onGoal, title: "Work the decisions behind one goal first",
      options: [{ id: REVIEW_ALL_GOALS, label: "All goals" },
        ...goals.goals.map((option) => ({ id: option.path, label: `${option.title} · ${option.count}` })),
        ...(goals.noGoal ? [{ id: REVIEW_NO_GOAL, label: `No goal · ${goals.noGoal}` }] : [])] }) : null;
    const goalName = goal === REVIEW_NO_GOAL ? "no goal" : goals?.goals?.find((option) => option.path === goal)?.title;
    // The Customer menu: every business with decisions waiting, as the server
    // counts them (the list itself is capped), and the one chosen even when
    // its last decision has just gone.
    const businesses = reviewBusinessCounts(store.queue);
    const customerOptions = [{ id: REVIEW_ALL_CUSTOMERS, label: Number.isInteger(store.queue?.total) ? `All customers · ${store.queue.total}` : "All customers" },
      ...businesses.map((business) => ({ id: business.businessId, label: `${business.businessName} · ${business.count}` })),
      ...(filter && !businesses.some((business) => business.businessId === filter) ? [{ id: filter, label: `${filterName} · 0` }] : [])];
    const customerPicker = onFilter && (businesses.length > 1 || filter) ? h(ui.Pill, { key: "customer", label: "Customer", value: filter ?? REVIEW_ALL_CUSTOMERS,
      onChange: (value) => onFilter(value === REVIEW_ALL_CUSTOMERS ? null : value), title: "Work one customer's decisions", options: customerOptions }) : null;
    return { filterName, goalName, customerPicker, goalPicker };
  }

  /** The list: approved work that needs a push (quiet, at the top), then
   * every waiting item grouped by business. Selection is explicit. */
  function QueueList({ queue, selectedId, onOpen, picked, onPick, filter, onFilter, notes, goal = REVIEW_ALL_GOALS, goals, onGoal, filters = true }) {
    useStore();
    const groups = reviewGroups(queue).filter((group) => !filter || group.businessId === filter)
      .map((group) => ({ ...group, items: group.items.filter((entry) => reviewServes(entry, goal)) })).filter((group) => group.items.length);
    const attention = [...(queue.stalled ?? []).map((entry) => ({ ...entry, why: `Not started · ${entry.waitingOn ? `waiting on ${entry.waitingOn}` : "nobody has picked it up"}` })),
      ...(queue.blocked ?? []).map((entry) => ({ ...entry, why: entry.note ? `Blocked · ${entry.note}` : "Blocked" }))]
      .filter((entry) => (!filter || entry.businessId === filter) && (goal === REVIEW_ALL_GOALS || reviewServes({ goals: reviewGoalsOf(entry.goals) }, goal)));
    const { filterName, goalName, customerPicker, goalPicker } = queueMenus({ queue, filter, onFilter, goal, goals, onGoal, attention });
    return h(Stack, { gap: 4 },
      filters && (customerPicker || goalPicker) ? h(Actions, null, customerPicker, goalPicker) : null,
      attention.length ? h(ListGroup, { label: "Approved, not finished", count: attention.length },
        ...attention.map((entry) => h(SelectRow, { key: `a${entry.decisionId}`, title: entry.title, subtitle: entry.why, meta: entry.age, quiet: true,
          selected: selectedId === reviewItemId(entry.businessId, entry.assetId, entry.key),
          onOpen: () => onOpen({ businessId: entry.businessId, assetId: entry.assetId, itemKey: entry.key }) }))) : null,
      ...groups.map((group) => h(ListGroup, { key: group.businessId, label: group.businessName, count: group.items.length },
        ...group.items.map((entry) => {
          const { question, stake } = questionOf(entry);
          const receipt = store.receipt(entry.id);
          const { maker } = reviewByline(null, entry);
          const profile = maker.pubkey ? bridge.profile?.(maker.pubkey) : null;
          const kind = store.pictureKind(entry.businessId, entry.assetId, entry.key);
          return h(SelectRow, { key: entry.id, title: question, subtitle: notes?.get(entry.id) || receiptWords(receipt) || `${bylineWords(null, entry)}${stake ? ` · ${stake}` : ""}`, meta: entry.age,
            avatar: h(Avatar, { name: profile?.name || maker.name, picture: profile?.picture, size: "small", shape: maker.agent ? "squircle" : "circle" }),
            thumbnail: store.queuePicture(entry) ?? (kind ? store.picture(entry.businessId, entry.assetId, entry.key, kind) : null),
            selected: selectedId === entry.id,
            picked: onPick ? picked?.has(entry.id) : undefined, pickLabel: `Select ${question}`,
            onPick: onPick ? (value) => onPick(entry.id, value) : undefined,
            onOpen: () => onOpen({ businessId: entry.businessId, assetId: entry.assetId, itemKey: entry.key }) });
        }))),
      !groups.length && !attention.length ? h(EmptyState, { glyph: "inbox", title: goalName ? `Nothing waiting for ${goalName}` : filter ? `Nothing waiting for ${filterName}` : "Nothing is waiting for you", frame: "none" }) : null,
      queue.truncated ? Note(`Showing ${queue.listed} of ${queue.total}. Decide some to see the rest.`) : null);
  }

  /** The Customer and Goal menus alone, for a page that keeps them above its scrolling list. */
  function QueueFilters({ queue, filter, onFilter, goal, goals, onGoal }) {
    useStore();
    const { customerPicker, goalPicker } = queueMenus({ queue, filter, onFilter, goal, goals, onGoal });
    return customerPicker || goalPicker ? h(Actions, null, customerPicker, goalPicker) : null;
  }

  /** Decides the picked items together (approve, or reject with one reason
   * for all): each is its own decision, call, token and receipt. */
  // First every review is read (for its tokens), then every approval starts
  // at once, so one Undo stops them all and nothing starts after it.
  const decideTogether = async (ids, order, verdict = "approved", feedback = "") => {
    const entries = order.filter((entry) => ids.has(entry.id));
    const ready = [];
    const refused = [];
    await Promise.all(entries.map(async (entry) => {
      try {
        const review = await store.open({ businessId: entry.businessId, assetId: entry.assetId });
        const item = review.items.find((candidate) => candidate.key === entry.key);
        if (item && store.canDecide(review, item)) ready.push({ entry, review, item });
        else refused.push(entry.id);
      } catch { refused.push(entry.id); }
    }));
    const proposed = [];
    for (const { entry, review, item } of entries.map((entry) => ready.find((candidate) => candidate.entry === entry)).filter(Boolean)) {
      if (store.propose({ review, item, verdict, feedback })) proposed.push(entry.id); else refused.push(entry.id);
    }
    return { proposed, refused };
  };

  return { useStore, useConnection, NotConnected, ReviewItem, QueueList, QueueFilters, Work, Decide, Byline, bylineWords, decideTogether, approveTogether: (ids, order) => decideTogether(ids, order, "approved"), questionOf, receiptWords };
}
