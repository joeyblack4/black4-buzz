// ---- Reviews: what it gives Buzz -----------------------------------------------
// The dock page (Activity's list and preview), the side panel, the message
// card, the Team sidebar's Decisions section, key commands and OS
// notifications. Started in its own scope (reviewsSlot), so a fault here is
// reported in Settings and never stops the MCP connection or the agent tools.

/** Services Reviews needs. The rest (navigation, shortcuts, notifications,
 * sidebarSections) it reads with ctx.reflect.get and uses when Buzz has them:
 * Buzz has no optional inject. */
const REVIEWS_INJECT = Object.freeze(["react", "pages", "panels", "conversation"]);
const REVIEWS_PAGE = "reviews";
/** The page's route: { business?, asset?, item? } (a sidebar row, a notification). */
const REVIEWS_ROUTE = Object.freeze({ version: 1, validate: (params) => !!params && typeof params === "object" && !Array.isArray(params)
  && Object.entries(params).every(([key, value]) => ["business", "asset", "item"].includes(key) && typeof value === "string" && value.length <= 200) });
/** Review links in a message's text, in order, once each. */
function reviewLinksIn(text) {
  const out = [];
  for (const match of String(text ?? "").matchAll(/https:\/\/app\.black4\.ai\/r\/[A-Za-z0-9_-]+(?:\?[^\s<>()\[\]"'`]*)?/g)) {
    const url = reviewUrl(match[0].replace(/[.,;:!?]+$/, ""));
    if (url && !out.includes(url) && out.length < 12) out.push(url);
  }
  return out;
}

/** Where the next and previous item are, in queue order, from `entry`. */
function reviewStep(order, entry, remembered = 0) {
  const at = order.findIndex((candidate) => candidate.assetId === entry?.assetId && (!entry?.itemKey || candidate.key === entry.itemKey)
    && (!entry?.businessId || candidate.businessId === entry.businessId));
  // A decided item leaves the queue: the item that followed it now sits in its place.
  const index = at >= 0 ? at : Math.min(remembered, order.length);
  return {
    index: at >= 0 ? at : index,
    found: at >= 0,
    next: at >= 0 ? order[at + 1] ?? null : order[index] ?? null,
    previous: at >= 0 ? order[at - 1] ?? null : order[index - 1] ?? null,
  };
}

/** New things worth an OS notification, against what was seen before. */
function reviewNews(queue, seen) {
  const waiting = reviewOrder(queue).filter((entry) => !seen.waiting.has(entry.id));
  const blocked = (queue?.blocked ?? []).filter((entry) => !seen.blocked.has(entry.decisionId));
  return { waiting, blocked };
}

function reviewsPart(ctx, bridge) {
  const React = ctx.react;
  const h = React.createElement;
  const ui = buzzUi(React);
  const store = reviewData(bridge.call, bridge.timing ?? {});
  /** A service Buzz may not have: undefined when it is missing. */
  const optional = (name) => { try { return ctx.reflect?.get?.(name) ?? undefined; } catch { return undefined; } };
  const pluginId = ctx.pluginOwner?.id ?? "ai.black4";
  const pageTarget = (params) => ({ version: 1, kind: "page", pluginId, pageId: REVIEWS_PAGE, ...(params && Object.keys(params).length ? { route: { version: 1, params } } : {}) });
  const screens = reviewScreens(React, store, { use: bridge.use, SignInPrompt: bridge.SignInPrompt, browser: bridge.browser, openThread: bridge.openThread, profile: bridge.profile });
  const { ReviewItem, QueueList, useStore, useConnection, NotConnected, approveTogether } = screens;
  const disposers = [];
  const own = (dispose) => { if (typeof dispose === "function") disposers.push(dispose); else if (dispose?.dispose) disposers.push(() => dispose.dispose()); };

  // ---- what the page shows: shared with the sidebar and notifications ----------
  let view = { filter: null, entry: null };
  const viewListeners = new Set();
  const setView = (patch) => { view = { ...view, ...patch }; for (const listener of [...viewListeners]) listener(); };
  const useView = () => {
    const [, setTick] = React.useState(0);
    React.useEffect(() => { const listener = () => setTick((n) => n + 1); viewListeners.add(listener); return () => viewListeners.delete(listener); }, []);
    return view;
  };

  // ---- key commands: only while a Reviews surface is shown and focused ---------
  let commands = null; // the item on screen: { approve, undo }
  let surface = null; // { next, previous, changes } of the focused surface
  let surfaceFocused = false;
  const focusIn = () => { surfaceFocused = true; };
  const focusOut = (event) => { if (!event?.currentTarget?.contains?.(event.relatedTarget)) surfaceFocused = false; };
  const onCommand = (value) => { commands = value; return () => { if (commands === value) commands = null; }; };
  const typing = () => {
    const active = globalThis.document?.activeElement;
    return !!active && (/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) || active.isContentEditable);
  };

  /** Next, previous and the position in the queue for `entry`. */
  function useStepping(entry, setEntry) {
    useStore();
    const order = reviewOrder(store.queue);
    const remembered = React.useRef(0);
    const step = reviewStep(order, entry, remembered.current);
    if (step.found) remembered.current = step.index;
    const go = (target) => target ? () => setEntry({ businessId: target.businessId, assetId: target.assetId, itemKey: target.key }) : null;
    const upcoming = step.next ? { businessId: step.next.businessId, assetId: step.next.assetId, itemKey: step.next.key } : null;
    return { position: step.found ? step.index + 1 : 0, total: order.length, next: go(step.next), previous: go(step.previous), upcoming };
  }

  /** A queue read on demand, for surfaces opened before the badge's first read. */
  function useQueue() {
    useStore();
    const link = useConnection();
    const [error, setError] = React.useState(null);
    React.useEffect(() => {
      if (link.status !== "connected" || store.queue) return;
      store.readQueue().then(() => setError(null), (reason) => setError(reason));
    }, [link.status]);
    return { link, queue: link.status === "connected" ? store.queue : null, error, retry: () => store.readQueue().then(() => setError(null), setError) };
  }

  // ---- the dock page: the list beside the item, as Activity -------------------
  function ReviewsPage({ navigation: pageNavigation } = {}) {
    const { link, queue, error, retry } = useQueue();
    const current = useView();
    // Opened from a sidebar row or a notification: its business, or its item.
    const params = pageNavigation?.target?.route?.params;
    React.useEffect(() => {
      if (!params || typeof params !== "object") return;
      setView({ filter: params.business ?? null, entry: params.asset ? { businessId: params.business, assetId: params.asset, itemKey: params.item } : view.entry });
    }, [pageNavigation?.entryId]);
    const [picked, setPicked] = React.useState(() => new Set());
    // { ids, refused, preparing } for the last Approve N: its countdown and what it couldn't do.
    const [bulk, setBulk] = React.useState(null);
    const setEntry = (entry) => setView({ entry });
    // The first waiting item is open from the start: one less click per session.
    const first = reviewOrder(queue)[0];
    React.useEffect(() => {
      if (!view.entry && first && !view.filter) setView({ entry: { businessId: first.businessId, assetId: first.assetId, itemKey: first.key } });
    }, [first?.id]);
    const step = useStepping(current.entry, setEntry);
    surface = { next: step.next, previous: step.previous };
    React.useEffect(() => () => { surface = null; surfaceFocused = false; }, []);
    const order = reviewOrder(queue);
    // Picks that left the queue (decided) drop out of the selection.
    const live = new Set([...picked].filter((id) => order.some((entry) => entry.id === id)));
    const pick = (id, value) => setPicked((now) => { const next = new Set(now); if (value) next.add(id); else next.delete(id); return next; });
    const pending = (bulk?.ids ?? []).map((id) => store.receipt(id)).filter((receipt) => receipt?.state === "pending");
    const [, tick] = React.useState(0);
    React.useEffect(() => {
      if (!pending.length) return undefined;
      const timer = setInterval(() => tick((n) => n + 1), 250);
      return () => clearInterval(timer);
    }, [pending.length > 0]);
    const approve = async () => {
      const ids = new Set(live);
      setBulk({ ids: [], refused: [], preparing: true });
      const { proposed, refused } = await approveTogether(ids, order);
      setPicked(new Set());
      setBulk({ ids: proposed, refused, preparing: false });
    };
    const undoAll = () => { for (const receipt of pending) store.undo(receipt.id); };
    const notes = new Map((bulk?.refused ?? []).map((id) => [id, "Can't be approved here: open it to see why"]));
    let toolbar = null;
    if (pending.length) {
      toolbar = h(ui.Toolbar, { key: "bulk" }, ui.Status(`Approving ${pending.length} in ${Math.max(1, Math.ceil((Math.min(...pending.map((receipt) => receipt.deadline)) - Date.now()) / 1000))} s`),
        h(ui.Button, { size: "sm", variant: "outline", onClick: undoAll }, "Undo"));
    } else if (bulk?.refused?.length && !live.size) {
      toolbar = h(ui.Toolbar, { key: "bulk" }, ui.Line(`${bulk.refused.length} couldn't be approved here.`),
        h(ui.Button, { size: "sm", variant: "ghost", onClick: () => setBulk(null) }, "Dismiss"));
    } else if (live.size) {
      toolbar = h(ui.Toolbar, { key: "bulk" }, ui.Strong(`${live.size} selected`),
        h(ui.Button, { size: "sm", variant: "prominent", loading: !!bulk?.preparing, onClick: () => void approve() }, `Approve ${live.size}`),
        h(ui.Button, { size: "sm", variant: "ghost", onClick: () => setPicked(new Set()) }, "Clear"));
    }
    let list;
    if (link.status !== "connected") list = h(NotConnected, { link });
    else if (error && !queue) list = h(ui.Failure, { message: plain(error.message, 300), retry, retryLabel: "Try again" });
    else if (!queue) list = h(ui.Skeleton, { layout: "list" });
    else list = h(QueueList, { queue, selectedId: current.entry ? order[reviewStep(order, current.entry).index]?.id : null, onOpen: setEntry,
      picked: live, onPick: pick, notes, filter: current.filter, onFilter: (filter) => setView({ filter }) });
    const detail = current.entry
      ? h(ReviewItem, { key: "item", entry: current.entry, step, onCommand, frame: true })
      : link.status === "connected" && queue ? h(ui.EmptyState, { glyph: "decisions", title: order.length ? "Choose a decision" : "Nothing to decide", frame: "none" }) : null;
    return h(ui.Page, { label: "Reviews", fill: true, header: h(ui.PanelHeader, { title: "Reviews", actions: [h(ui.IconButton, { key: "refresh", label: "Refresh", glyph: "refresh", large: true, onClick: () => bridge.queue.refresh() })] }),
      onFocus: focusIn, onBlur: focusOut },
      toolbar,
      h(ui.Split, { key: "split", label: "Decisions waiting", list, detail }));
  }

  // ---- the side panel: one item, stepping through the queue -------------------
  function ReviewPanel({ target }) {
    const locator = reviewLocator(target);
    const [entry, setEntry] = React.useState(locator?.kind === "review" ? locator : null);
    const [filter, setFilter] = React.useState(locator?.kind === "queue" ? locator.businessId ?? null : null);
    React.useEffect(() => {
      const next = reviewLocator(target);
      setEntry(next?.kind === "review" ? next : null);
      if (next?.kind === "queue") setFilter(next.businessId ?? null);
    }, [target]);
    const step = useStepping(entry, setEntry);
    const { link, queue, error, retry } = useQueue();
    let body;
    if (entry) body = h(ReviewItem, { entry, step, onBack: () => setEntry(null), onCommand });
    else {
      let list;
      if (link.status !== "connected") list = h(NotConnected, { link });
      else if (error && !queue) list = h(ui.Failure, { message: plain(error.message, 300), retry, retryLabel: "Try again" });
      else if (!queue) list = h(ui.Skeleton, { layout: "list" });
      else list = h(QueueList, { queue, onOpen: setEntry, filter, onFilter: setFilter });
      body = h(ui.Subview, { header: h(ui.PanelHeader, { title: queue?.total ? `${queue.total} waiting` : "Reviews",
        actions: [h(ui.IconButton, { key: "refresh", label: "Refresh", glyph: "refresh", large: true, onClick: () => bridge.queue.refresh() })] }) }, h(ui.PanelBody, null, list));
    }
    surface = { next: step.next, previous: step.previous };
    React.useEffect(() => () => { surface = null; surfaceFocused = false; }, []);
    return h(ui.Surface, { label: "Black 4 Reviews", onFocus: focusIn, onBlur: focusOut }, body);
  }

  // ---- the dock badge ---------------------------------------------------------
  function ReviewsBadge() {
    const current = useConnection();
    if (current.status === "idle") return ui.Dot({ label: "Approve your Black 4 sign-in in your browser" });
    if (current.status === "signed-out") return ui.Dot({ label: current.detail ? `Sign in to Black 4. ${current.detail}` : "Sign in to Black 4" });
    if (current.status !== "connected" || !current.waiting) return null;
    return ui.CountBadge({ count: current.waiting, label: `${current.waiting} decisions waiting for the connected Black 4 account` });
  }

  ctx.pages.register({ id: REVIEWS_PAGE, title: "Reviews", primary: true, placement: "dock", layout: "workspace", route: REVIEWS_ROUTE, badge: ReviewsBadge, component: ReviewsPage });
  ctx.panels.register({
    id: "reviews", title: "Black 4 Reviews", order: 0,
    matches: (target) => Boolean(reviewUrl(target)),
    component: ReviewPanel,
    channelPlacement: "side",
    channelLauncher: function ReviewsLauncher({ available, toggle, pressed }) {
      if (!available()) return null;
      return ui.IconButton({ label: "Open your Black 4 review queue", glyph: "decisions", "aria-expanded": pressed, "data-channel-panel-toggle": "",
        onClick: (event) => { event?.currentTarget?.focus?.(); toggle(REVIEWS_HOME); } });
    },
  });

  // ---- in the conversation ----------------------------------------------------
  // The host owns the anchor and its click; the chip draws no control of its own.
  ctx.conversation.registerLink?.({
    id: "review-link", title: "Black 4 review", order: 0,
    matches: (url) => Boolean(reviewUrl(url)),
    component: function ReviewLink() { return h(ui.LinkChip, { label: "Black 4 review" }); },
  });
  /** One row per review link: the question and its live state. */
  function LinkRow({ url, open }) {
    useStore();
    const link = useConnection();
    const locator = reviewLocator(url);
    const [failed, setFailed] = React.useState(null);
    const [opened, setOpened] = React.useState(null); // { businessId, assetId } once read
    React.useEffect(() => {
      if (link.status !== "connected" || !locator?.assetId) return;
      store.open(locator).then((review) => { setFailed(null); setOpened({ businessId: review.businessId, assetId: review.assetId }); }, (error) => setFailed(error));
    }, [url, link.status]);
    const businessId = opened?.businessId ?? locator?.businessId ?? reviewOrder(store.queue).find((entry) => entry.assetId === locator?.assetId)?.businessId;
    const review = locator?.assetId && businessId ? store.cachedReview(businessId, locator.assetId) : null;
    const item = review ? (review.items.find((candidate) => candidate.key === locator.itemKey) ?? review.items[0]) : null;
    const receipt = review && item ? store.receipt(reviewItemId(review.businessId, review.assetId, item.key)) : null;
    const state = item ? reviewState(item, receipt) : null;
    const title = item ? (item.card?.question || item.title) : failed?.code === "elsewhere" ? "A Black 4 review" : failed ? "A Black 4 review" : "Loading the review…";
    const { maker } = item ? reviewByline(review, item) : { maker: null };
    const profile = maker?.pubkey ? bridge.profile?.(maker.pubkey) : null;
    const kind = item ? store.pictureKind(review.businessId, review.assetId, item.key) : null;
    React.useEffect(() => { if (kind) store.image(review.businessId, review.assetId, item.key, kind); }, [kind, item?.key]);
    return h(ui.MessageRow, { title,
      subtitle: state ? `${review.businessName} · ${screens.bylineWords(review, item)} · ${state.text}` : failed ? (failed.code === "elsewhere" ? "Not in your queue" : "Couldn't read it") : "",
      avatar: maker ? h(ui.Avatar, { name: profile?.name || maker.name, picture: profile?.picture, size: "small", shape: maker.agent ? "squircle" : "circle" }) : null,
      thumbnail: kind ? store.picture(review.businessId, review.assetId, item.key, kind) : null,
      loading: !item && !failed && link.status === "connected", onOpen: open, openLabel: "Open" });
  }
  function ReviewPreview({ url, open }) {
    const link = useConnection();
    if (link.status !== "connected") return h(ui.MessageCard, { label: "Black 4 review" }, h(NotConnected, { link, compact: true }));
    return h(ui.MessageCard, { label: "Black 4 review" }, h(LinkRow, { url, open }));
  }
  /** One card per message for every review link in it, under the message. */
  function ReviewMessageCard({ message, open }) {
    const link = useConnection();
    const urls = reviewLinksIn(message?.content);
    if (!urls.length) return null;
    const label = urls.length === 1 ? "Black 4 decision" : `${urls.length} Black 4 decisions`;
    if (link.status !== "connected") return h(ui.MessageCard, { label }, h(NotConnected, { link, compact: true }));
    return h(ui.MessageCard, { label }, ...urls.map((url) => h(LinkRow, { key: url, url, open: () => open?.(url) })));
  }
  if (typeof ctx.conversation.registerAccessory === "function") {
    ctx.conversation.registerAccessory({ id: "review-decisions", title: "Black 4 decisions", order: -10, placement: "message", component: ReviewMessageCard });
  } else {
    // An older Buzz: one compact card per link.
    ctx.conversation.registerLinkPreview?.({
      id: "review-preview", title: "Black 4 decision", order: -10,
      matches: (url) => Boolean(reviewUrl(url)) && /\/r\//.test(new URL(url).pathname),
      component: ReviewPreview,
    });
  }

  // ---- the Team sidebar: Decisions, one row per business --------------------------
  let sidebarRows = [];
  let sidebarRevision = -1;
  const rowsNow = () => {
    if (sidebarRevision !== store.revision) {
      sidebarRevision = store.revision;
      const next = reviewGroups(store.queue).map((group) => ({ id: group.businessId, label: group.businessName, count: group.items.length }));
      if (JSON.stringify(next) !== JSON.stringify(sidebarRows)) sidebarRows = next;
    }
    return sidebarRows;
  };
  try {
    optional("sidebarSections")?.register?.({
      version: 1, id: "decisions", title: "Decisions", icon: h(ui.Glyph, { name: "decisions" }),
      rows: { snapshot: rowsNow, subscribe: (listener) => store.subscribe(listener) },
      select: (row) => pageTarget({ business: row.id }),
    });
  } catch (error) { bridge.report?.(error); }

  // ---- key commands: J/K or arrows to move, A approve, C ask for changes ----------
  const navigationService = optional("navigation");
  const onReviewsPage = () => {
    try { const target = navigationService?.snapshot?.()?.entry?.target; return target?.kind === "page" && target.pluginId === pluginId && target.pageId === REVIEWS_PAGE; } catch { return false; }
  };
  const live = () => (surfaceFocused || onReviewsPage()) && !typing();
  const keys = optional("shortcuts");
  const shortcut = (id, title, binding, run, ready = () => true) => {
    try { keys?.register?.({ id: `reviews.${id}`, title, binding, run, when: () => live() && ready() }); } catch (error) { bridge.report?.(error); }
  };
  shortcut("next", "Next decision", [{ key: "j" }, { key: "ArrowDown" }], () => surface?.next?.(), () => !!surface?.next);
  shortcut("previous", "Previous decision", [{ key: "k" }, { key: "ArrowUp" }], () => surface?.previous?.(), () => !!surface?.previous);
  shortcut("approve", "Approve this decision", { key: "a" }, () => commands?.approve?.(), () => !!commands?.approve);
  shortcut("changes", "Ask for changes", { key: "c" }, () => commands?.changes?.(), () => !!commands?.changes);
  shortcut("reject", "Reject", { key: "r" }, () => commands?.reject?.(), () => !!commands?.reject);
  shortcut("undo", "Undo the decision", { key: "z", mod: true }, () => commands?.undo?.(), () => !!commands?.undo);

  // ---- the queue the badge already polls: notifications --------------------------
  const seen = { started: false, waiting: new Set(), blocked: new Set() };
  const notify = (queue) => {
    const news = reviewNews(queue, seen);
    for (const entry of reviewOrder(queue)) seen.waiting.add(entry.id);
    for (const entry of queue?.blocked ?? []) seen.blocked.add(entry.decisionId);
    if (!seen.started) { seen.started = true; return; } // the first read is what was already there
    const post = (category, input) => { try { Promise.resolve(category?.submit?.(input)).catch(() => {}); } catch {} };
    if (news.waiting.length) {
      const first = news.waiting[0];
      post(waitingNotes, { sourceKey: `waiting:${news.waiting.map((entry) => entry.id).join(",")}`.slice(0, 1024),
        title: news.waiting.length === 1 ? "A decision is waiting" : `${news.waiting.length} decisions are waiting`,
        body: news.waiting.length === 1 ? `${first.businessName}: ${first.question || first.title}` : [...new Set(news.waiting.map((entry) => entry.businessName))].join(", "),
        target: pageTarget(news.waiting.length === 1 ? { business: first.businessId, asset: first.assetId, item: first.key } : {}) });
    }
    for (const entry of news.blocked.slice(0, 3)) {
      post(blockedNotes, { sourceKey: `blocked:${entry.decisionId}`, title: "Approved work is blocked",
        body: `${entry.businessName}: ${entry.title}${entry.note ? `. ${plain(entry.note, 160)}` : ""}`,
        target: pageTarget({ business: entry.businessId, asset: entry.assetId, item: entry.key }) });
    }
  };
  // Two switches in Settings → Notifications, driven by the badge's own poll.
  let waitingNotes = null;
  let blockedNotes = null;
  try {
    const notifications = optional("notifications");
    waitingNotes = notifications?.register?.({ id: "decisions", label: "Black 4 decisions waiting" }) ?? null;
    blockedNotes = notifications?.register?.({ id: "decisions-blocked", label: "Black 4 approved work blocked" }) ?? null;
  } catch (error) { bridge.report?.(error); }
  own(bridge.queue.subscribe((queue) => { store.noteQueue(queue); notify(queue); }));
  // Signed out, reconnecting or another account: nothing of the last one stays.
  let lastStatus = null;
  own(bridge.status?.subscribe?.((status) => {
    if (status !== "connected" && lastStatus === "connected") {
      store.reset();
      seen.started = false; seen.waiting.clear(); seen.blocked.clear();
      setView({ entry: null, filter: null });
    }
    lastStatus = status;
  }));

  return {
    store,
    dispose() {
      for (const dispose of disposers.splice(0)) { try { dispose(); } catch {} }
      store.dispose();
      viewListeners.clear();
    },
    // For tests and the Settings card: what is on screen and the commands.
    get commands() { return commands; },
    get surface() { return surface; },
    get live() { return live(); },
    setView,
  };
}

/** Starts Reviews in its own child scope. Whatever it throws goes to
 * `bridge.report`, never up to the plugin. */
function reviewsSlot(ctx, bridge) {
  let scope = null;
  let part = null;
  const start = (child) => {
    try { part = reviewsPart(child, bridge); } catch (error) { bridge.report?.(error); }
  };
  try {
    if (typeof ctx.plugin === "function") {
      scope = ctx.plugin({
        name: "black4-reviews",
        inject: REVIEWS_INJECT,
        apply: (child) => {
          start(child);
          child.effect?.(() => () => { try { part?.dispose(); } catch {} part = null; });
        },
      });
    } else start(ctx); // an older host, and the tests
  } catch (error) {
    bridge.report?.(error);
  }
  return {
    get part() { return part; },
    dispose() {
      try { part?.dispose(); } catch {}
      part = null;
      const current = scope;
      scope = null;
      try { Promise.resolve(current?.dispose?.()).catch(() => {}); } catch {}
    },
  };
}
