// Black 4 plugin for Buzz 1.0 (API v1: one self-contained ES module, no imports).
//
// It starts the black4-mcp-bridge process (mcp-remote in front of the Black 4
// MCP, holding the person's WorkOS sign-in), lists the MCP's core tools and
// offers each to every agent in this Buzz app as `black4_<tool>`. A call runs
// on the bridge's MCP session, so the agent acts with the signed-in person's
// Black 4 authority: the same door, tools and Reviews as every other harness.
// `find_tools` and `call_tool` in the core list reach the rest of the tools.
//
// The plugin adds no authority of its own. It fills in the Buzz channel and
// community for `resolve_channel_business` when the agent leaves them out.

export const inject = ["react", "host", "agents", "settingsCards", "panels", "browser", "conversation", "pages", "relay"];

const PREFIX = "black4_";
const CALL_TIMEOUT_MS = 5 * 60 * 1000;
const START_TIMEOUT_MS = 10 * 60 * 1000; // a first browser sign-in can take a while
const RETRY_DELAYS_MS = [5000, 15000, 60000, 300000];
const QUEUE_POLL_MS = 60 * 1000; // the Reviews badge refreshes this often while connected
const QUEUE_TIMEOUT_MS = 30 * 1000;

// Match only the authenticated human surface. Review file grants and MCP
// tokens never belong in a conversation renderer or a generic agent tool.
export function reviewUrl(target) {
  if (typeof target !== "string" || target.length > 2048) return null;
  try {
    const url = new URL(target);
    if (url.origin !== "https://app.black4.ai" || url.username || url.password) return null;
    if (!/^\/(?:reviews\/?|r\/[a-zA-Z0-9_-]+\/?)$/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

// Reads only. The host's human website session remains the decision boundary.
// No capability from MCP _meta is cached or exposed to conversation content.
export function reviewReader(call) {
  let queueFlight;
  // Locators only, never review content or authority; every read is authorized
  // again. Retains routing after a decision removes the review from the queue.
  const businesses = new Map();
  const queue = () => queueFlight ??= call("review_queue", {}).finally(() => { queueFlight = null; });
  return async (target) => {
    const safe = reviewUrl(target);
    if (!safe) throw new Error("This is not a Black 4 review link.");
    const url = new URL(safe);
    const assetId = url.pathname.match(/^\/r\/([^/]+)/)?.[1];
    if (!assetId) return queue();
    // The URL is a locator, never an authority grant. The server checks reads.
    let businessId = url.searchParams.get("business") || businesses.get(assetId);
    if (!businessId) {
      const list = await queue();
      businessId = list.reviews?.find(review => review.assetId === assetId)?.businessId;
    }
    if (!businessId) throw new Error("This review is outside the loaded queue. Open the original review to inspect its history.");
    const result = await call("open_review", { businessId, assetId, ...(url.searchParams.get("item") ? { itemKey: url.searchParams.get("item") } : {}) });
    if (result.kind !== "black4_review" || result.assetId !== assetId || result.businessId !== businessId) throw new Error("The review response did not match this link.");
    if (businesses.size >= 200) businesses.delete(businesses.keys().next().value);
    businesses.set(assetId, businessId);
    const item = result.items?.find(item => item.key === url.searchParams.get("item"));
    const version = url.searchParams.get("v");
    if (version && Number(version) !== (item?.version ?? result.version)) throw new Error("This link names an older version. Open the original review to compare versions before deciding.");
    return result;
  };
}

// Native React composition, also mounted with synthetic data in the UI harness.
// It is the review panel, the message preview and, without an embedded browser,
// the Reviews page. Every color is a host token with a system-color fallback
// (prominent fills pair CanvasText with Canvas text, never currentColor, which
// would resolve against the element's own text color), and sizes are em-based,
// so light, dark and interface size all hold.
// `useConnection` returns the bridge status string or `{ status, detail, connect }`.
const HOST_BORDER = "var(--border-standard,color-mix(in srgb,currentColor 14%,transparent))";
const HOST_ACCENT = "var(--border-accent,var(--border-focus,currentColor))";
export function reviewSurface(React, read, HumanView, useConnection = () => "connected") {
  const h = React.createElement;
  const styles = [
    `.b4-review{color:var(--text-standard,var(--color-text-primary,inherit));font:inherit;line-height:1.5;overflow-wrap:anywhere;width:100%;min-width:0}`,
    `.b4-review *{box-sizing:border-box}`,
    `.b4-review h2{font-size:1.5em;line-height:1.22;letter-spacing:-.035em;margin:.6em 0 .75em}`,
    `.b4-review h3{font-size:1em;margin:0 0 .5em}`,
    `.b4-review p{margin:.4em 0 1em}`,
    `.b4-review small,.b4-review .b4-muted{color:var(--text-subtle,color-mix(in srgb,currentColor 65%,transparent));font-size:.75em}`,
    `.b4-review button,.b4-review a{font:inherit}`,
    `.b4-review a{color:var(--text-link,var(--text-accent,inherit))}`,
    `.b4-review button{cursor:pointer;min-height:2.5em;padding:.5em .75em;border:1px solid ${HOST_BORDER};border-radius:var(--radius-control,.5em);background:transparent;color:inherit;text-align:left}`,
    `.b4-review button:hover{background:var(--affordance-subtle-hover,color-mix(in srgb,currentColor 7%,transparent))}`,
    `.b4-review button:focus-visible,.b4-review a:focus-visible{outline:2px solid var(--border-focus,currentColor);outline-offset:3px}`,
    `.b4-review .b4-primary{background:var(--affordance-prominent,CanvasText);color:var(--text-on-prominent,Canvas);border-color:transparent}`,
    `.b4-review .b4-primary:hover{background:var(--affordance-prominent-hover,color-mix(in srgb,CanvasText 85%,Canvas))}`,
    `.b4-review .b4-toolbar{display:flex;align-items:center;gap:.5em;flex-wrap:wrap}`,
    `.b4-review .b4-section{padding:1.25em 0;border-top:1px solid ${HOST_BORDER}}`,
    `.b4-review .b4-compare{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1.5em}`,
    `.b4-review .b4-proposed{border-left:2px solid ${HOST_ACCENT};padding-left:1.125em}`,
    `.b4-review .b4-row{display:block;width:100%;border:0;border-bottom:1px solid ${HOST_BORDER};border-radius:0;padding:1em 0}`,
    `.b4-review .b4-row strong{display:block;margin:.3em 0}`,
    `.b4-review .b4-tabs{display:flex;gap:.5em;overflow-x:auto;padding:.5em 0}`,
    `.b4-review .b4-tabs button{flex-shrink:0}`,
    `.b4-review [aria-pressed=true]{border-color:${HOST_ACCENT};color:var(--text-accent,inherit);background:var(--affordance-selected,color-mix(in srgb,currentColor 7%,transparent))}`,
    `.b4-review details summary{cursor:pointer;padding:.6em 0}`,
    `.b4-review pre{font:.75em/1.5 monospace;white-space:pre-wrap;max-height:300px;overflow:auto}`,
    `.b4-review .b4-sticky{position:sticky;bottom:0;background:var(--surface-panel,Canvas);padding:1em 0 .25em;border-top:1px solid ${HOST_BORDER}}`,
    `.b4-review .b4-enter{animation:b4-enter .16s ease-out}@keyframes b4-enter{from{opacity:.5;transform:translateY(4px)}to{opacity:1;transform:none}}`,
    `@media(prefers-reduced-motion:reduce){.b4-review .b4-enter{animation:none}}`,
    `@container(max-width:480px){.b4-review .b4-compare{grid-template-columns:1fr;gap:.5em}}`,
  ].join("");
  const CONNECTION_TEXT = {
    starting: "Connecting to Black 4…",
    "signing-in": "Waiting for you to sign in to Black 4.",
    stopped: "Black 4 is stopped.",
    failed: "Black 4 is not connected.",
  };
  const label = value => String(value ?? "Not recorded").replaceAll("_", " ");
  const section = (title, content) => h("section", { className: "b4-section" }, h("h3", null, title), content);
  function Surface({ target, compact = false, open }) {
    const bridge = useConnection();
    const link = typeof bridge === "string" ? { status: bridge } : bridge ?? { status: "failed" };
    const connection = link.status;
    const [result, setResult] = React.useState(null);
    const [error, setError] = React.useState("");
    const [revision, refresh] = React.useState(0);
    const [selected, select] = React.useState(null);
    const [human, showHuman] = React.useState(null);
    const [loaded, setLoaded] = React.useState(null);
    React.useEffect(() => select(null), [target]);
    React.useEffect(() => {
      let active = true;
      setResult(null); setError(""); showHuman(null);
      if (connection !== "connected") return () => { active = false; };
      read(target).then(value => { if (active) { setResult(value); setLoaded(new Date()); } }, reason => { if (active) setError(reason.message); });
      return () => { active = false; };
    }, [target, revision, connection]);
    const button = (text, onClick, primary = false) => h("button", { type: "button", className: primary ? "b4-primary" : undefined, onClick }, text);
    const web = (url, text = "Open original review") => HumanView
      ? button(text, () => showHuman(url))
      : h("a", { href: reviewUrl(url), target: "_blank", rel: "noopener noreferrer" }, text);
    const wrap = (...children) => h("div", { className: "b4-review", style: { padding: compact ? "1em 0" : "var(--space-panel-inset, 1.5rem)", containerType: "inline-size" } }, h("style", null, styles), ...children);
    if (human) return h("div", { className: "b4-review", style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, height: "100%" } }, h("style", null, styles), button("← Back to brief · refresh status", () => { showHuman(null); refresh(v => v + 1); }), h(HumanView, { url: human }));
    // Recovery happens where the person is. Connect only shows once nothing is
    // in progress, so a click never restarts a sign-in the browser is holding.
    if (connection !== "connected") return wrap(
      h("p", { role: "status" }, CONNECTION_TEXT[connection] ?? `Black 4: ${connection}.`),
      link.detail ? h("p", { className: "b4-muted" }, link.detail) : null,
      link.connect && (connection === "failed" || connection === "stopped")
        ? h("div", { className: "b4-toolbar" }, button("Connect Black 4", link.connect, true))
        : null);
    if (error) return wrap(h("p", { role: "alert" }, error), h("div", { className: "b4-toolbar" }, button("Try again", () => refresh(v => v + 1)), compact && open ? button("Inspect review", open) : web(target)));
    if (!result) return wrap(h("p", { role: "status" }, "Loading your review…"));
    if (result.kind === "black4_review_queue") return wrap(
      h("small", null, "BLACK 4 / YOUR DECISIONS"), h("h2", null, result.total ? `${result.total} decisions waiting` : "Nothing waiting for your decision"),
      result.stalledTotal ? section("Approved work needs follow-through", h("p", null, `${result.stalledTotal} approved items have no execution after 10 minutes. Approval is not completion.`)) : null,
      h("div", { className: "b4-toolbar" }, button("Refresh", () => refresh(v => v + 1)), web(target, "Full queue & history")),
      result.note ? h("p", null, result.note) : null,
      ...(result.reviews ?? []).map(review => h("button", { key: review.assetId, type: "button", className: "b4-row", onClick: () => {
        const url = new URL(review.reviewUrl); url.searchParams.set("business", review.businessId); open?.(url.href);
      } }, h("small", null, review.businessName), h("strong", null, review.title), h("span", { className: "b4-muted" }, `${review.items.length} shown · ${review.items[0]?.age ?? "age unknown"} · Inspect →`))),
      result.truncated ? h("p", { className: "b4-muted" }, `Showing ${result.listed} pending items. The full queue includes the rest.`) : null);
    const items = result.items ?? [];
    const item = items.find(item => item.key === selected) ?? items.find(item => item.key === result.focusItemKey) ?? items[0];
    if (!item) return wrap(h("p", null, "No visible items in this review."), web(target));
    const card = item.card ?? {};
    const brief = item.brief ?? {};
    const status = item.decision ? `${label(item.decision.verdict)} · ${label(item.decision.executionStatus)}` : label(item.status);
    if (compact) return wrap(h("small", null, `${result.businessName} / ${status} / v${item.version}`), h("h3", null, card.question || item.title), h("p", null, item.action), button(`Inspect ${items.length > 1 ? `${items.length} items` : "review"} →`, open, true));
    return wrap(
      h("div", { className: "b4-toolbar" }, button("← Queue", () => open?.("https://app.black4.ai/reviews")), h("small", null, result.businessName), button("Refresh", () => refresh(v => v + 1))),
      items.length > 1 ? h("nav", { className: "b4-tabs", "aria-label": "Review items" }, ...items.map((entry, index) => h("button", { key: entry.key, type: "button", title: entry.title, "aria-pressed": entry.key === item.key, onClick: () => select(entry.key) }, `${index + 1}. ${entry.title}`))) : null,
      h("article", { key: item.key, className: "b4-enter" },
        h("small", null, `${status} · Version ${item.version}`), h("h2", null, card.question || item.title),
        h("p", null, item.action),
        card.recommend ? h("p", { className: "b4-proposed" }, h("strong", null, `Recommendation: ${label(card.recommend.answer)}. `), card.recommend.why) : null,
        section("What changes", h("div", { className: "b4-compare" }, h("div", null, h("small", null, "CURRENT"), h("p", null, brief.before || "Current state not supplied.")), h("div", { className: "b4-proposed" }, h("small", null, "PROPOSED"), h("p", null, brief.after || "Proposed state not supplied.")))),
        card.ifYes || card.ifNo ? section("The choice", h("div", { className: "b4-compare" }, h("div", null, h("h3", null, "If approved"), h("p", null, card.ifYes || brief.expectedResult || "Impact not supplied.")), h("div", null, h("h3", null, "If left as is"), h("p", null, card.ifNo || "Impact not supplied.")))) : null,
        card.tradeoff ? section("Tradeoff", h("p", null, card.tradeoff)) : null,
        section("Why this work", h("div", null, h("p", null, brief.why || "Rationale not supplied."), brief.successMeasure ? h("p", null, h("strong", null, "Success looks like: "), brief.successMeasure) : null)),
        item.decision ? section("Decision & follow-through", h("div", null, h("p", null, status), item.decision.feedback ? h("blockquote", null, item.decision.feedback) : null, h("small", null, `Decided ${item.decision.decidedAt ?? "date unknown"} · Completed ${item.decision.completedAt ?? "not recorded"}`))) : null,
        h("details", { className: "b4-section" }, h("summary", null, "Evidence, provenance & exact request"), h("p", null, `Made by ${item.madeBy || "not recorded"}. Requested by ${item.requestedBy || "not recorded"}.`),
          brief.baselineSource ? h("p", null, `${brief.baselineSource} · ${brief.baselineObservedAt || "date not recorded"}`) : null,
          ...(card.facts ?? []).map((fact, index) => h("p", { key: index }, fact)), item.change ? h("pre", null, JSON.stringify(item.change, null, 2)) : h("p", null, "No provider request is pinned to this item.")),
        h("footer", { className: "b4-sticky" }, h("div", { className: "b4-toolbar" }, web(item.reviewUrl, item.decidable ? "View work & decide →" : "View work & decision history →")), h("small", null, `Read ${loaded?.toLocaleTimeString() ?? "just now"}. Decisions save in your signed-in review. Return here to refresh.`))));
  }
  return Surface;
}

export function apply(ctx) {
  const React = ctx.react;

  // ---- state shared with the Settings card -------------------------------
  let state = {
    status: "starting", // starting | signing-in | connected | stopped | failed
    detail: "",
    tools: 0,
    account: null,
    instructions: "",
    log: [],
    waiting: null, // decisions waiting on the connected account, or null when unknown
  };
  const listeners = new Set();
  const update = (patch) => {
    // Any status other than connected makes the count unknown: no stale badge
    // survives a disconnect, a failed refresh or a reconnect to another account.
    if (patch.status && patch.status !== "connected") patch = { ...patch, waiting: null };
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const note = (line) => {
    const log = state.log.concat(line.slice(0, 300)).slice(-12);
    update({ log });
  };

  // ---- the bridge process and its JSON-RPC session -----------------------
  let proc = null;
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  let retry = 0;
  let retryTimer = null;
  let stopped = false;
  let starting = false;
  let generation = 0;
  const registered = new Map(); // tool name -> disposer (if the host returns one)

  const rejectAll = (message) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(message));
    }
    pending.clear();
  };

  const send = async (message) => {
    if (!proc) throw new Error("The Black 4 bridge is not running.");
    await proc.write(JSON.stringify(message) + "\n");
  };

  const request = (method, params, { timeoutMs = CALL_TIMEOUT_MS, signal } = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      let abort;
      const finish = (callback, value) => {
        if (!pending.has(id)) return;
        clearTimeout(timer);
        pending.delete(id);
        if (abort) signal.removeEventListener("abort", abort);
        callback(value);
      };
      const timer = setTimeout(() => {
        finish(reject, new Error(`Black 4 MCP did not answer ${method} in ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
        timer,
      });
      if (signal) {
        abort = () => {
          if (!pending.has(id)) return;
          finish(reject, new Error("Stopped."));
          void send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Stopped in Buzz" } }).catch(() => {});
        };
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
      }
      void send({ jsonrpc: "2.0", id, method, params }).catch((error) => finish(reject, error));
    });

  const onStdout = (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id == null || !pending.has(message.id)) continue;
      const { resolve, reject } = pending.get(message.id);
      if (message.error) reject(new Error(message.error.message || "Black 4 MCP error"));
      else resolve(message.result);
    }
  };

  const onStderr = (chunk) => {
    for (const raw of chunk.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (/authorize this client|Waiting for authorization|Browser opened/i.test(line)) {
        update({ status: "signing-in", detail: "Finish signing in to Black 4 in your browser." });
      }
      // mcp-remote prints the sign-in URL; keep it out of the log (it carries a PKCE challenge).
      if (/https?:\/\/\S*authorize/i.test(line)) continue;
      if (/error|connected|refresh|exit/i.test(line)) note(line);
    }
  };

  // ---- agent tools --------------------------------------------------------
  const relayFor = (client) => {
    try {
      return ctx.agents.snapshot?.().running?.find((agent) => agent.key === client.key)?.relay;
    } catch {
      return undefined;
    }
  };

  const textOf = (result) =>
    (result?.content ?? [])
      .map((part) => (part.type === "text" ? part.text : JSON.stringify(part)))
      .join("\n");

  const toolCall = (name) => async (client, context, args) => {
    if (state.status !== "connected") {
      throw new Error(
        `Black 4 is not connected in Buzz (${state.status}${state.detail ? `: ${state.detail}` : ""}). ` +
          "Ask the owner to open Settings → Black 4 and choose Reconnect.",
      );
    }
    let input = args ?? {};
    if (name === "resolve_channel_business" && context?.channel) {
      const relay = relayFor(client);
      input = {
        channelId: context.channel,
        ...(relay ? { communityId: `relay:${relay.endsWith("/") ? relay : `${relay}/`}` } : {}),
        ...input,
      };
    }
    client.signal?.throwIfAborted?.();
    const result = await request("tools/call", { name, arguments: input }, { signal: client.signal });
    const text = textOf(result) || "(no content)";
    if (result?.isError) throw new Error(text);
    return text;
  };

  const register = (tools, instructions) => {
    for (const tool of tools) {
      const name = PREFIX + tool.name;
      if (registered.has(name)) continue;
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) {
        note(`Skipped a tool whose name Buzz refuses: ${tool.name}`);
        continue;
      }
      let description = `Black 4: ${tool.description ?? tool.title ?? tool.name}`;
      if (tool.name === "whoami" && instructions) description = `${description}\n\n${instructions}`;
      if (tool.name === "resolve_channel_business") {
        description +=
          "\n\nIn Buzz, channelId and communityId default to the channel you are working in.";
      }
      const inputSchema =
        tool.inputSchema && tool.inputSchema.type === "object" ? tool.inputSchema : { type: "object", properties: {} };
      const schema =
        tool.name === "resolve_channel_business"
          ? { ...inputSchema, required: (inputSchema.required ?? []).filter((key) => key !== "channelId") }
          : inputSchema;
      try {
        const handle = ctx.agents.addTool({
          name,
          description: description.slice(0, 8000),
          inputSchema: schema,
          call: toolCall(tool.name),
        });
        registered.set(name, typeof handle === "function" ? handle : handle?.dispose?.bind(handle) ?? null);
      } catch (error) {
        note(`Buzz refused ${name}: ${error?.message ?? error}`);
      }
    }
    update({ tools: registered.size });
  };

  // ---- waiting count for the Reviews badge --------------------------------
  // `review_queue.total` counts decisions waiting on the bridge's signed-in
  // account (the MCP principal), which can differ from the embedded website's
  // own sign-in. One call in flight at a time; an answer that arrives after
  // the connection it was asked on has been replaced is ignored.
  let queueTimer = null;
  let queueFlight = null;
  const stopQueuePolling = () => {
    clearTimeout(queueTimer);
    queueTimer = null;
    queueFlight = null;
  };
  const noteQueue = (queue) => {
    const total = Number(queue?.total);
    update({ waiting: Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : null });
  };
  const pollQueue = async () => {
    if (stopped || state.status !== "connected" || queueFlight) return;
    const attempt = generation;
    const flight = queueFlight = request("tools/call", { name: "review_queue", arguments: {} }, { timeoutMs: QUEUE_TIMEOUT_MS });
    let queue = null;
    try {
      const result = await flight;
      if (!result?.isError) queue = JSON.parse(textOf(result));
    } catch {}
    if (queueFlight === flight) queueFlight = null;
    if (attempt !== generation || stopped || state.status !== "connected") return;
    noteQueue(queue);
    clearTimeout(queueTimer);
    queueTimer = setTimeout(pollQueue, QUEUE_POLL_MS);
  };

  // ---- lifecycle ----------------------------------------------------------
  const scheduleRetry = (why) => {
    stopQueuePolling();
    if (stopped) return;
    const delay = RETRY_DELAYS_MS[Math.min(retry, RETRY_DELAYS_MS.length - 1)];
    retry += 1;
    update({ status: "failed", detail: `${why} Retrying in ${Math.round(delay / 1000)}s.` });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(start, delay);
  };

  const kill = (child) => {
    try { Promise.resolve(child?.kill?.()).catch(() => {}); } catch {}
  };

  const start = async () => {
    if (stopped || proc || starting) return;
    starting = true;
    const attempt = ++generation;
    buffer = "";
    update({ status: "starting", detail: "" });
    let child;
    try {
      child = await ctx.host.spawn("bridge", {
        cwd: "~/.black4/mcp-bridge",
        onStdout: (chunk) => { if (attempt === generation && !stopped) onStdout(chunk); },
        onStderr: (chunk) => { if (attempt === generation && !stopped) onStderr(chunk); },
      });
    } catch (error) {
      if (attempt !== generation || stopped) return;
      starting = false;
      scheduleRetry(`Could not start black4-mcp-bridge (${error?.message ?? error}). Is it installed?`);
      return;
    }
    if (attempt !== generation || stopped) { kill(child); return; }
    starting = false;
    proc = child;
    child.exited?.then?.((code) => {
      if (proc !== child) return;
      generation += 1;
      proc = null;
      rejectAll("The Black 4 bridge stopped.");
      if (!stopped) scheduleRetry(`The bridge exited (${JSON.stringify(code ?? null)}).`);
    });
    try {
      const init = await request(
        "initialize",
        { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "black4-buzz", version: "1.0.0" } },
        { timeoutMs: START_TIMEOUT_MS },
      );
      if (attempt !== generation || stopped) return;
      await send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const listed = await request("tools/list", {});
      if (attempt !== generation || stopped) return;
      register(listed?.tools ?? [], init?.instructions ?? "");
      let account = null;
      try {
        const who = JSON.parse(textOf(await request("tools/call", { name: "whoami", arguments: {} })));
        account = { kind: who.kind, email: who.email };
      } catch {}
      if (attempt !== generation || stopped) return;
      retry = 0;
      update({ status: "connected", detail: "", account, instructions: init?.instructions ?? "" });
      void pollQueue();
    } catch (error) {
      if (attempt !== generation || stopped) return;
      rejectAll("The Black 4 connection failed.");
      if (proc === child) {
        proc = null;
        kill(child);
      }
      scheduleRetry(error?.message ?? String(error));
    }
  };

  const reconnect = () => {
    clearTimeout(retryTimer);
    stopQueuePolling();
    retry = 0;
    generation += 1;
    starting = false;
    const child = proc;
    proc = null;
    rejectAll("Reconnecting.");
    kill(child);
    start();
  };

  ctx.effect(() => {
    stopped = false;
    start();
    return () => {
      stopped = true;
      generation += 1;
      starting = false;
      clearTimeout(retryTimer);
      stopQueuePolling();
      const child = proc;
      proc = null;
      rejectAll("The Black 4 plugin stopped.");
      kill(child);
      for (const dispose of registered.values()) {
        try {
          dispose?.();
        } catch {}
      }
      registered.clear();
      update({ status: "stopped", tools: 0 });
    };
  });

  // ---- Settings card ------------------------------------------------------
  const STATUS_TEXT = {
    starting: "Connecting…",
    "signing-in": "Waiting for you to sign in",
    connected: "Connected",
    stopped: "Stopped",
    failed: "Not connected",
  };

  function useBridgeState() {
    const [, setTick] = React.useState(0);
    React.useEffect(() => {
      const listener = () => setTick((tick) => tick + 1);
      listeners.add(listener);
      return () => listeners.delete(listener);
    }, []);
    return state;
  }

  const h = React.createElement;

  const readReview = reviewReader(async (name, args) => {
    if (state.status !== "connected") throw new Error("Black 4 is reconnecting. Try again once connected.");
    const attempt = generation;
    const result = await request("tools/call", { name, arguments: args });
    if (result?.isError) throw new Error(textOf(result));
    const value = JSON.parse(textOf(result));
    // A queue the person just read is the freshest count the badge can show.
    if (name === "review_queue" && attempt === generation && state.status === "connected") noteQueue(value);
    return value;
  });
  const NativeReview = reviewSurface(React, readReview,
    ctx.browser.available ? function HumanReview({ url }) {
      return h(ctx.browser.View, { url, storage: "black4-reviews", label: "Black 4: view work and decide" });
    } : null,
    () => { const current = useBridgeState(); return { status: current.status, detail: current.detail, connect: reconnect }; });

  // Queue → exact review → back, inside one native composition.
  function ReviewPanel({ target }) {
    const [current, setCurrent] = React.useState(target);
    React.useEffect(() => setCurrent(target), [target]);
    return h(NativeReview, { target: current, open: (url) => setCurrent(url) });
  }

  // The full inbox uses the same authenticated human session as the website.
  // MCP remains the agent transport and never receives decision capabilities.
  // Without an embedded browser the page is the native queue and brief; its
  // "View work & decide" link opens the website in the default browser.
  function ReviewsWorkspace() {
    return ctx.browser.available
      ? h("div", { style: { height: "100%", minHeight: 0, display: "flex" } },
          h(ctx.browser.View, { url: "https://app.black4.ai/reviews?experience=buzz", storage: "black4-reviews", label: "Black 4 decision inbox" }))
      : h("div", { style: { height: "100%", minHeight: 0, overflow: "auto", boxSizing: "border-box" } },
          h(ReviewPanel, { target: "https://app.black4.ai/reviews" }));
  }

  // Shown beside the dock entry: decisions waiting on the connected account.
  function ReviewsBadge() {
    const current = useBridgeState();
    if (current.status !== "connected" || !current.waiting) return null;
    const count = current.waiting > 99 ? "99+" : String(current.waiting);
    return h("span", {
      "aria-label": `${current.waiting} decisions waiting for the connected Black 4 account`,
      title: `${current.waiting} decisions waiting for the connected Black 4 account`,
      style: {
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        minWidth: "1.25em", padding: "0 .4em", borderRadius: "var(--radius-pill, 999px)",
        fontSize: ".75em", fontWeight: 600, lineHeight: 1.5, fontVariantNumeric: "tabular-nums",
        background: "var(--affordance-prominent, CanvasText)", color: "var(--text-on-prominent, Canvas)",
      },
    }, count);
  }

  ctx.pages.register({ id: "reviews", title: "Reviews", primary: true, placement: "dock", layout: "workspace", badge: ReviewsBadge, component: ReviewsWorkspace });

  ctx.panels.register({
    id: "reviews",
    title: "Black 4 Reviews",
    order: 0,
    matches: (target) => Boolean(reviewUrl(target)),
    component: ReviewPanel,
    channelPlacement: "side",
    channelLauncher: function ReviewsLauncher({ available, toggle, pressed }) {
      if (!available()) return null;
      return h("button", {
        type: "button", "aria-pressed": pressed,
        title: "Open your Black 4 review queue",
        onClick: () => toggle("https://app.black4.ai/reviews"),
      }, "Reviews");
    },
  });

  // The host owns the anchor, click routing and modifier/new-window behavior.
  // Inline content must not introduce a nested button or its own navigation.
  ctx.conversation.registerLink?.({
    id: "review-link", title: "Black 4 review", order: 0,
    matches: (url) => Boolean(reviewUrl(url)),
    component: function ReviewLink() {
      return h("span", { style: { display: "inline-flex", alignItems: "center", gap: "var(--space-2)" } },
        h("span", { "aria-hidden": true }, "◇"), "Black 4 review");
    },
  });

  ctx.conversation.registerLinkPreview?.({
    id: "review-preview", title: "Black 4 decision brief", order: -10,
    matches: (url) => Boolean(reviewUrl(url)) && /\/r\//.test(new URL(url).pathname),
    component: function ReviewPreview({ url, open }) {
      return h(NativeReview, { target: url, compact: true, open });
    },
  });

  function Black4Settings() {
    const current = useBridgeState();
    const row = (label, value) =>
      h(
        "div",
        { style: { display: "flex", gap: "var(--space-2)", flexWrap: "wrap" } },
        h("strong", { style: { minWidth: "9em" } }, label),
        h("span", null, value),
      );
    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "var(--space-2)", width: "100%" } },
      h(
        "p",
        null,
        "Every agent in this Buzz app gets the Black 4 MCP as black4_* tools, signed in as you. " +
          "People decide material changes in Black 4 Reviews; agents never approve.",
      ),
      h(
        "section",
        { className: "ui-card", style: { padding: "var(--space-panel-inset)", display: "flex", flexDirection: "column", gap: "var(--space-2)" } },
        row("Status", STATUS_TEXT[current.status] ?? current.status),
        current.detail ? row("", current.detail) : null,
        row("Signed in as", current.account ? `${current.account.email ?? "unknown"} (${current.account.kind ?? "unknown"})` : "unknown"),
        row("Agent tools", String(current.tools)),
        row("Server", "https://api.black4.ai/mcp?tools=core"),
        h(
          "div",
          null,
          h("button", { type: "button", onClick: reconnect }, current.status === "connected" ? "Reconnect" : "Connect"),
        ),
      ),
      current.log.length
        ? h(
            "details",
            null,
            h("summary", null, "Bridge log"),
            h("pre", { style: { whiteSpace: "pre-wrap", fontSize: "0.85em" } }, current.log.join("\n")),
          )
        : null,
    );
  }

  ctx.settingsCards.register({ id: "connection", title: "Black 4", component: Black4Settings });
  if (ctx.relay) relayMemberMentions(ctx);
}

// ---- member mentions ---------------------------------------------------------
// Buzz 1.0 starts a turn for an @mention only when the owner (or the owner's
// own agent) wrote it, and never shows an @mention to the agent's Attention
// watches. Black 4 wants every person in a channel to reach the agents in it.
// So this plugin, which the owner installs, watches for new messages from
// people that @mention one of the owner's agents running here and wakes that
// agent in the message's thread with `ctx.agents.wake`. The owner's own
// messages and every agent's (which carry a NIP-OA `auth` tag) are left to
// Buzz, so nothing is woken twice and agents cannot wake each other in loops.

const QUOTE_LIMIT = 4000;

/** The thread an event belongs to: its NIP-10 root, else the event itself. */
export function threadRoot(event) {
  const tags = event.tags ?? [];
  const root = tags.find((tag) => tag[0] === "e" && tag[3] === "root")?.[1]
    ?? tags.find((tag) => tag[0] === "e" && tag[3] === "reply")?.[1];
  return /^[0-9a-f]{64}$/i.test(root ?? "") ? root.toLowerCase() : event.id;
}

/** The wakes one event calls for: one per agent of `owner` it @mentions, when
 * a person other than the owner wrote it in a channel. Pure, for tests. */
export function memberMentionWakes(event, agents, owner, name = (pubkey) => pubkey.slice(0, 8)) {
  if (!event || event.kind !== 9 || !owner || event.pubkey === owner) return [];
  const tags = event.tags ?? [];
  if (tags.some((tag) => tag[0] === "auth")) return [];
  if (agents.some((agent) => agent.pubkey === event.pubkey)) return [];
  const homes = tags.filter((tag) => tag[0] === "h");
  const channel = homes.length === 1 ? homes[0][1] : undefined;
  if (!channel || !/^[0-9a-f]{64}$/i.test(event.id ?? "")) return [];
  const mentioned = new Set(tags.filter((tag) => tag[0] === "p").map((tag) => tag[1]));
  const author = name(event.pubkey);
  const content = String(event.content ?? "").slice(0, QUOTE_LIMIT);
  return agents
    .filter((agent) => agent.owner === owner && mentioned.has(agent.pubkey))
    .map((agent) => ({
      key: agent.key,
      channel,
      root: threadRoot(event),
      text: [
        `${author} (nostr:${event.pubkey}), a member of this channel, @mentioned you in this thread (message ${event.id}).`,
        "Your owner installed the Black 4 plugin so that you answer every person in your channels, not only your owner.",
        "Answer them in this thread the way you would answer your owner, within this channel's business.",
        `Their message:\n${content}`,
      ].join("\n"),
    }));
}

export function relayMemberMentions(ctx) {
  const seen = new Set();
  let view;
  let stopView = () => {};
  let watching = "";
  const startedAt = Math.floor(Date.now() / 1000);

  const close = () => {
    stopView();
    stopView = () => {};
    view?.dispose?.();
    view = undefined;
    watching = "";
  };

  const sync = () => {
    let connection;
    let running = [];
    try {
      connection = ctx.relay.snapshot();
      running = ctx.agents.snapshot?.().running ?? [];
    } catch {
      return close();
    }
    if (connection?.status !== "ready" || !connection.session?.observe || !connection.viewer) return close();
    const owner = connection.viewer;
    const host = (url) => { try { return new URL(url).host; } catch { return ""; } };
    const here = host(connection.origin);
    const agents = running.filter((agent) => agent.owner === owner && (!agent.relay || !here || host(agent.relay) === here));
    const pubkeys = [...new Set(agents.map((agent) => agent.pubkey))].sort();
    const key = `${connection.scope}:${connection.generation}:${pubkeys.join(",")}`;
    if (key === watching) return;
    close();
    if (!pubkeys.length) return;
    watching = key;
    const session = connection.session;
    const name = (pubkey) => {
      try {
        return session.profiles?.snapshot?.().get(pubkey)?.name || pubkey.slice(0, 8);
      } catch {
        return pubkey.slice(0, 8);
      }
    };
    view = session.observe([{ kinds: [9], "#p": pubkeys, since: startedAt, limit: 50 }]);
    const deliver = () => {
      const events = view?.snapshot?.().events ?? [];
      for (const event of events) {
        if (!event?.id || seen.has(event.id) || (event.created_at ?? 0) < startedAt) continue;
        // A local copy still being sent is not yet the relay's event.
        if (event.delivery === "sending" || event.delivery === "failed") continue;
        seen.add(event.id);
        void session.profiles?.ensure?.([event.pubkey]).catch?.(() => {});
        for (const wake of memberMentionWakes(event, agents, owner, name)) {
          try {
            ctx.agents.wake(wake.key, { channel: wake.channel, root: wake.root, text: wake.text });
          } catch (error) {
            console.warn(`[black4] could not wake ${wake.key.slice(0, 8)} for a member mention: ${error?.message ?? error}`);
          }
        }
      }
    };
    stopView = view.subscribe(deliver);
    deliver();
    void view.refresh?.();
  };

  ctx.effect(() => {
    sync();
    const offRelay = ctx.relay.subscribe(sync);
    const offAgents = ctx.agents.subscribe?.(sync) ?? (() => {});
    return () => {
      offRelay();
      offAgents();
      close();
    };
  });
}
