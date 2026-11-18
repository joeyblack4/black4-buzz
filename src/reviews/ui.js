// ---- Reviews: the screens ------------------------------------------------------
// Drawn only with the Buzz UI kit. Work first: the question, the stake and
// facts as chips, then the change itself; the reasons sit in one closed
// disclosure. Deciding happens in place, in a bar at the bottom.

/** The screens over one reviewData store. `bridge`: { use, SignInPrompt,
 * browser, openThread? }. */
function reviewScreens(React, store, bridge) {
  const h = React.createElement;
  const ui = buzzUi(React);
  const { Button, IconButton, PanelHeader, Subview, PanelBody, EmptyState, Column, Actions, Stack, SectionTitle, Title, Caption, Strong, Lines, Line, Note, Status,
    Disclosure, Group, Row, Pre, Failure, TextField, CountBadge, Chip, ChipRow, DiffText, ChangeTable, MediaPair, DecisionBar, Skeleton, SelectRow, ListGroup, Split, Toolbar } = ui;

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
  /** "grok-bot · Grok Bot (SEO & AEO Desk)" → "Grok Bot". */
  const agentName = (madeBy) => {
    const text = String(madeBy ?? "").split(" · ").slice(-1)[0].replace(/\s*\[.*$/, "").replace(/\s+via\s+.*$/, "").replace(/\s*\(.*\)$/, "").trim();
    return text || "The agent";
  };
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

  // ---- the work itself -----------------------------------------------------------
  function Media({ review, item }) {
    const [images, setImages] = React.useState({ after: undefined, before: undefined });
    React.useEffect(() => {
      let live = true;
      for (const which of ["after", "before"]) {
        store.image(review.businessId, review.assetId, item.key, which).then((src) => { if (live) setImages((now) => ({ ...now, [which]: src })); });
      }
      return () => { live = false; };
    }, [review.assetId, item.key, item.version]);
    if (images.after === null && !images.before) return h(Page_, { review, item });
    return h(MediaPair, { before: images.before ?? null, after: images.after, loading: images.after === undefined, label: item.title });
  }
  /** The change, as the card's `show` says, else the brief's before and after. */
  function Work({ review, item }) {
    const show = item.card?.show;
    if (show?.type === "fields" && show.rows?.length) {
      return h(ChangeTable, { rows: show.rows.map((row) => ({ label: row.label, before: row.before ?? "", after: row.after ?? "", changed: (row.before ?? "") !== (row.after ?? "") })) });
    }
    if (show?.type === "text") return h(DiffText, { label: show.label, runs: wordDiff(show.before ?? "", show.after ?? "") });
    if (show?.type === "list" && show.rows?.length) {
      return h("div", null, show.label ? h(SectionTitle, { title: show.label }) : null,
        h(Group, null, ...show.rows.map((row, index) => h(Row, { key: `${index}`, title: row.label, description: row.detail }))));
    }
    if (show?.type === "media") return h(Media, { review, item });
    // No card: the finished page or file itself, when there is one (documents).
    if (store.preview(review.businessId, review.assetId, item.key)) return h(Page_, { review, item });
    const brief = item.brief ?? {};
    if (brief.before || brief.after) return h(ChangeTable, { rows: [{ label: "", before: brief.before ?? "", after: brief.after ?? "", changed: brief.before !== brief.after }] });
    return Note(item.action || "No change was attached.");
  }
  /** The finished work when it is a page or file: its own preview, shown in
   * place (never the review application around it). */
  function Page_({ review, item }) {
    const link = store.preview(review.businessId, review.assetId, item.key);
    if (!link || !bridge.browser) return Note(item.action || "The work has no preview here.");
    return h(ui.Frame, { label: item.title }, h(bridge.browser, { url: link, storage: "black4-review-work", label: `The work: ${item.title}` }));
  }

  /** Why, evidence, provenance and the pinned request: one closed disclosure. */
  function Details({ review, item }) {
    const card = item.card ?? {};
    const brief = item.brief ?? {};
    const change = item.change && !item.change.erased ? item.change : null;
    const origin = reviewOrigin(review, item);
    const row = (title, text) => (text ? h(Row, { key: title, title, description: text }) : null);
    return h(Disclosure, { title: "Details" },
      h(Stack, { gap: 4 },
        h(Group, null,
          row("Approving permits", item.action),
          row("If yes", card.ifYes || brief.expectedResult),
          row("If no", card.ifNo),
          row("Tradeoff", card.tradeoff),
          row("Why", brief.why),
          !card.show ? row("Before", brief.before) : null,
          !card.show ? row("After", brief.after) : null,
          row("Success looks like", brief.successMeasure),
          row("Evidence", brief.baselineSource ? `${brief.baselineSource}${brief.baselineObservedAt ? ` · ${brief.baselineObservedAt}` : ""}` : ""),
          row("Made by", item.madeBy),
          row("Asked by", item.requestedBy),
          row("Job", origin.jobName || origin.jobId),
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
    return h(DecisionBar, null,
      h(Button, { key: "approve", variant: "prominent", autoFocus, "aria-keyshortcuts": "A", onClick: () => store.propose({ review, item, verdict: "approved" }) }, "Approve"),
      h(Button, { key: "changes", variant: "outline", "aria-keyshortcuts": "C", onClick: () => setCompose("changes_requested") }, "Ask for changes"),
      h(Button, { key: "reject", variant: "ghost", onClick: () => setCompose("rejected") }, "Reject"));
  }

  // ---- one item --------------------------------------------------------------------
  /** One review item, work first, with the decision bar. `entry`: a locator
   * `{ businessId?, assetId, itemKey? }`. `step`: { position, total, next,
   * previous } from the queue; `onBack`: to the queue. `onCommand` receives
   * this item's key commands while it is shown (shortcuts). */
  function ReviewItem({ entry, step, onBack, onCommand, onSaved, frame = true }) {
    const link = useConnection();
    useStore();
    const [state, setState] = React.useState({ review: null, error: null });
    const [revision, setRevision] = React.useState(0);
    const [compose, setCompose] = React.useState(null);
    const key = `${entry?.businessId ?? ""}/${entry?.assetId ?? ""}`;
    React.useEffect(() => setCompose(null), [key, entry?.itemKey]);
    React.useEffect(() => {
      let live = true;
      if (link.status !== "connected" || !entry?.assetId) return () => { live = false; };
      const cached = entry.businessId ? store.cachedReview(entry.businessId, entry.assetId) : null;
      setState({ review: cached, error: null });
      store.open(entry, { fresh: revision > 0 }).then((review) => { if (live) setState({ review, error: null }); }, (error) => { if (live) setState({ review: null, error }); });
      return () => { live = false; };
    }, [key, link.status, revision]);
    const shown = state.review && entry?.assetId === state.review.assetId ? state.review : store.peek(entry);
    const review = shown ? (store.cachedReview(shown.businessId, shown.assetId) ?? shown) : null;
    // The next item is read while this one is on screen, so stepping is instant.
    const upcoming = step?.upcoming;
    React.useEffect(() => {
      if (link.status === "connected" && upcoming?.assetId && upcoming.assetId !== review?.assetId) store.open(upcoming).catch(() => {});
    }, [upcoming?.assetId, review?.assetId, link.status]);
    const item = review ? (review.items.find((candidate) => candidate.key === entry.itemKey) ?? review.items.find((candidate) => candidate.key === review.focusItemKey) ?? review.items[0]) : null;
    const id = review && item ? reviewItemId(review.businessId, review.assetId, item.key) : null;
    const receipt = id ? store.receipt(id) : null;
    // A saved decision moves on to the next waiting item by itself.
    const savedRef = React.useRef(receipt?.state === "saved");
    React.useEffect(() => {
      const saved = receipt?.state === "saved";
      if (saved && !savedRef.current && step?.next) {
        const timer = setTimeout(() => { onSaved?.(id); step.next(); }, 900);
        savedRef.current = saved;
        return () => clearTimeout(timer);
      }
      savedRef.current = saved;
      return undefined;
    }, [receipt?.state, id]);
    // Key commands for this item (the surface's shortcuts call them).
    React.useEffect(() => {
      if (!onCommand) return undefined;
      return onCommand({
        approve: review && item && !receipt && !compose && store.canDecide(review, item) ? () => store.propose({ review, item, verdict: "approved" }) : null,
        changes: review && item && !receipt && store.canDecide(review, item) ? () => setCompose("changes_requested") : null,
        reject: review && item && !receipt && store.canDecide(review, item) ? () => setCompose("rejected") : null,
        undo: receipt?.state === "pending" ? () => store.undo(id) : null,
      });
    }, [id, receipt?.state, review?.decideIn, compose, store.revision]);

    const header = (title) => h(PanelHeader, { title,
      navigation: onBack ? h(IconButton, { label: "Back to the queue", glyph: "back", large: true, onClick: onBack }) : null,
      actions: [
        step && step.position ? Caption(`${step.position} of ${step.total}`) : null,
        step ? h(IconButton, { key: "prev", label: "Previous decision (K)", glyph: "up", large: true, disabled: !step.previous, onClick: () => step.previous?.() }) : null,
        step ? h(IconButton, { key: "next", label: "Next decision (J)", glyph: "down", large: true, disabled: !step.next, onClick: () => step.next?.() }) : null,
        h(IconButton, { key: "refresh", label: "Refresh", glyph: "refresh", large: true, onClick: () => setRevision((n) => n + 1) }),
      ].filter(Boolean) });
    const wrap = (title, body, bar = null) => frame
      ? h(Subview, { header: header(title), footer: bar }, h(PanelBody, null, body))
      : h(Stack, { gap: 4 }, body, bar);

    if (link.status !== "connected") return wrap("Reviews", h(NotConnected, { link }));
    if (state.error) {
      const elsewhere = state.error.code === "elsewhere";
      return wrap("Reviews", elsewhere
        ? Line("This review isn't waiting for you.")
        : h(Failure, { message: plain(state.error.message, 300), retry: () => setRevision((n) => n + 1), retryLabel: "Try again" }));
    }
    if (!review) return wrap("Reviews", h(Skeleton, { layout: "item" }));
    if (!item) return wrap(review.businessName, Line("Nothing in this review is shown to you."));
    const card = item.card ?? {};
    const origin = reviewOrigin(review, item);
    const facts = [
      card.stake?.text ? h(Chip, { key: "stake", glyph: STAKE_GLYPH[card.stake.kind] ?? null, label: card.stake.text, emphasis: card.stake.kind !== "none" }) : null,
      ...(card.facts ?? []).map((fact, index) => h(Chip, { key: `f${index}`, label: fact })),
    ].filter(Boolean);
    const recommendation = card.recommend?.answer
      ? `${agentName(item.madeBy)} recommends ${String(card.recommend.answer).toLowerCase()}${card.recommend.why ? `: ${card.recommend.why}` : ""}`
      : "";
    const body = h(Stack, { key: id, as: "article", gap: 4 },
      h(Stack, { gap: 2 },
        Caption([review.businessName, review.items.length > 1 ? `Item ${review.items.indexOf(item) + 1} of ${review.items.length}` : null, item.title !== card.question ? item.title : null].filter(Boolean).join(" · ")),
        Title(card.question || item.title),
        facts.length ? h(ChipRow, null, ...facts) : null),
      h(Work, { review, item }),
      recommendation ? Line(recommendation) : null,
      origin.threadId && bridge.openThread ? h(Actions, null, h(Button, { size: "sm", variant: "outline", onClick: () => bridge.openThread(origin) }, "Open thread")) : null,
      h(Details, { review, item }));
    return wrap(review.businessName, body, h(Decide, { review, item, compose, setCompose, onReload: () => setRevision((n) => n + 1) }));
  }

  // ---- the queue -----------------------------------------------------------------
  /** A row's line: the question, else the title. */
  const questionOf = (entry) => {
    const cached = store.cachedReview(entry.businessId, entry.assetId)?.items?.find((item) => item.key === entry.key);
    return { question: cached?.card?.question || entry.question || entry.title, stake: cached?.card?.stake?.text || entry.stake?.text || entry.brief || "" };
  };
  const receiptWords = (receipt) => receipt ? reviewState(null, receipt).text + (receipt.state === "failed" ? " · didn't save" : receipt.state === "unknown" ? " · unconfirmed" : receipt.state === "conflict" ? " · changed" : "") : "";

  /** The list: approved work that needs a push (quiet, at the top), then
   * every waiting item grouped by business. Selection is explicit. */
  function QueueList({ queue, selectedId, onOpen, picked, onPick, filter, onFilter, notes }) {
    useStore();
    const groups = reviewGroups(queue).filter((group) => !filter || group.businessId === filter);
    const attention = [...(queue.stalled ?? []).map((entry) => ({ ...entry, why: `Not started · ${entry.waitingOn ? `waiting on ${entry.waitingOn}` : "nobody has picked it up"}` })),
      ...(queue.blocked ?? []).map((entry) => ({ ...entry, why: entry.note ? `Blocked · ${entry.note}` : "Blocked" }))]
      .filter((entry) => !filter || entry.businessId === filter);
    const filterName = filter ? (groups[0]?.businessName ?? attention[0]?.businessName ?? "this business") : "";
    return h(Stack, { gap: 4 },
      filter ? h(Actions, null, Caption(`Only ${filterName}`), h(Button, { size: "sm", variant: "link", onClick: () => onFilter(null) }, "Show all")) : null,
      attention.length ? h(ListGroup, { label: "Approved, not finished", count: attention.length },
        ...attention.map((entry) => h(SelectRow, { key: `a${entry.decisionId}`, title: entry.title, subtitle: entry.why, meta: entry.age, quiet: true,
          selected: selectedId === reviewItemId(entry.businessId, entry.assetId, entry.key),
          onOpen: () => onOpen({ businessId: entry.businessId, assetId: entry.assetId, itemKey: entry.key }) }))) : null,
      ...groups.map((group) => h(ListGroup, { key: group.businessId, label: group.businessName, count: group.items.length },
        ...group.items.map((entry) => {
          const { question, stake } = questionOf(entry);
          const receipt = store.receipt(entry.id);
          return h(SelectRow, { key: entry.id, title: question, subtitle: notes?.get(entry.id) || receiptWords(receipt) || stake, meta: entry.age,
            selected: selectedId === entry.id,
            picked: onPick ? picked?.has(entry.id) : undefined, pickLabel: `Select ${question}`,
            onPick: onPick ? (value) => onPick(entry.id, value) : undefined,
            onOpen: () => onOpen({ businessId: entry.businessId, assetId: entry.assetId, itemKey: entry.key }) });
        }))),
      !groups.length && !attention.length ? h(EmptyState, { glyph: "inbox", title: filter ? `Nothing waiting for ${filterName}` : "Nothing is waiting for you", frame: "none" }) : null,
      queue.truncated ? Note(`Showing ${queue.listed} of ${queue.total}. Decide some to see the rest.`) : null);
  }

  /** Approves the picked items together: each its own call, token and receipt. */
  // First every review is read (for its tokens), then every approval starts
  // at once, so one Undo stops them all and nothing starts after it.
  const approveTogether = async (ids, order) => {
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
      if (store.propose({ review, item, verdict: "approved" })) proposed.push(entry.id); else refused.push(entry.id);
    }
    return { proposed, refused };
  };

  return { useStore, useConnection, NotConnected, ReviewItem, QueueList, Work, Decide, approveTogether, questionOf, receiptWords, agentName };
}
