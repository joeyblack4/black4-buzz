// Black 4 plugin for Buzz 1.0 (API v1: one self-contained ES module, no imports).
//
// It needs nothing outside Buzz. Settings → Black 4 → Sign in runs the WorkOS
// AuthKit device sign-in over `ctx.host.request`; the plugin then speaks the
// Black 4 MCP over HTTPS as that person, lists its core tools and offers each
// to every agent in this Buzz app as `black4_<tool>`. A call runs with the
// signed-in person's Black 4 authority: the same door, tools and Reviews as
// every other harness. `find_tools` and `call_tool` reach the rest.
//
// The plugin adds no authority of its own. It fills in the Buzz channel and
// community for `resolve_channel_business` when the agent leaves them out.
//
// The file, in order: sign-in, the MCP client and the hardware door's pass
// hashing; Reviews; the MCP tools, Agent access and the Settings card
// (`apply`); the member-mention relay; and, fenced at the end, Black 4
// hardware: a hosted agent type, offered to staff only, whose agents run on a
// Black 4 machine. Hardware is the least stable part of Buzz's plugin API, so
// it runs in its own scope and a failure there is shown in the Settings card
// instead of stopping the rest.

export const inject = ["react", "host", "agents", "settingsCards", "panels", "browser", "conversation", "pages", "relay"];

const PREFIX = "black4_";
const CALL_TIMEOUT_MS = 5 * 60 * 1000;
const START_TIMEOUT_MS = 10 * 60 * 1000; // a first browser sign-in can take a while
const RETRY_DELAYS_MS = [5000, 15000, 60000, 300000];
const QUEUE_POLL_MS = 60 * 1000; // the Reviews badge refreshes this often while connected
const QUEUE_TIMEOUT_MS = 30 * 1000;
const LINK_TIMEOUT_MS = 30 * 1000;
const LINK_UNAVAILABLE = "This Black 4 server can't link agents yet.";

// ---- sign-in, the Black 4 MCP and the hardware door, over HTTPS -------------
// Everything goes through `ctx.host.request` to the origins the manifest
// declares; nothing runs outside Buzz. Tokens live only in the closures below:
// never in UI state, logs, error text or anything an agent receives.

/** WorkOS AuthKit, device authorization (RFC 8628). Platform Control owns the
 * client ("Black 4 for Buzz": public, no secret). `params` go with every
 * request: the access token is for the Black 4 MCP resource. */
export const AUTHKIT = Object.freeze({
  origin: "https://overjoyed-tea-41.authkit.app",
  clientId: "client_01M7G889K5GQTA4Q38Q6PPJQSN",
  scope: "openid profile email offline_access",
  params: Object.freeze({ resource: "https://api.black4.ai/mcp" }),
});
export const MCP_URL = "https://api.black4.ai/mcp?tools=core";
const MCP_PROTOCOL = "2025-06-18";
const HOST_TIMEOUT_MAX_MS = 180 * 1000; // ctx.host.request's own ceiling
const REFRESH_EARLY_MS = 2 * 60 * 1000; // refresh this long before an access token ends
const DEVICE_INTERVAL_S = 5; // RFC 8628's default poll interval

const clampTimeout = (ms) => Math.max(1000, Math.min(HOST_TIMEOUT_MAX_MS, Math.round(ms)));
const headerOf = (response, name) => {
  for (const [key, value] of Object.entries(response?.headers ?? {})) if (key.toLowerCase() === name) return value;
  return undefined;
};
const plain = (text, max = 300) => String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
const jsonOf = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
const form = (fields) => Object.entries(fields).filter(([, value]) => value != null && value !== "")
  .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");

/** base64url (no padding) SHA-256 of a string's UTF-8 bytes: the body hash a
 * hardware pass is bound to. */
export async function bodySha256(text) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Where a refresh token is kept between sign-ins. The default keeps it in
 * this module, so it lasts while Buzz runs (a plugin reload or an off/on keeps
 * it) and is gone when Buzz quits: nothing is written to disk. */
export function memoryStore() {
  let value = null;
  return { load: async () => value, save: async (token) => { value = token; }, clear: async () => { value = null; } };
}
export const signInMemory = memoryStore(); // this Buzz run's sign-in (tests seed it)

/** One person's Black 4 sign-in. `request` is `ctx.host.request`. The state
 * it reports (`subscribe`/`snapshot`) never holds a token. */
export function createSession({ request, store = signInMemory, now = () => Date.now(), sleep, authkit = AUTHKIT } = {}) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let access = null; // { token, expiresAt }
  let refreshToken = null;
  let refreshing = null;
  let restored = null;
  let flow = 0; // the current device sign-in; a newer one or cancel retires it
  let view = Object.freeze({ status: "signed-out" }); // signed-out | starting | waiting | signed-in
  const listeners = new Set();
  const set = (next) => { view = Object.freeze(next); for (const listener of [...listeners]) listener(view); };

  const post = async (path, fields) => {
    let response;
    try {
      response = await request({
        url: `${authkit.origin}${path}`, method: "POST", timeoutMs: 30 * 1000,
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: form(fields),
      });
    } catch (error) {
      throw Object.assign(new Error(`Could not reach Black 4 sign-in (${plain(error?.message ?? error, 120)}).`), { code: "offline" });
    }
    return { status: response.status, body: jsonOf(response.body) ?? {} };
  };
  const reason = (body, fallback) => plain(body.error_description || body.error || fallback);

  const keep = async (body) => {
    if (typeof body.access_token !== "string" || !body.access_token) throw new Error("Black 4 sign-in returned no access token.");
    const seconds = Number(body.expires_in);
    access = { token: body.access_token, expiresAt: now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 300) * 1000 };
    // A rotated refresh token is saved before anything uses the new access.
    if (typeof body.refresh_token === "string" && body.refresh_token) {
      refreshToken = body.refresh_token;
      await store.save(refreshToken);
    }
  };
  const forget = async () => {
    access = null;
    refreshToken = null;
    try { await store.clear(); } catch {}
  };

  const exchange = async (token) => {
    const { status, body } = await post("/oauth2/token", { grant_type: "refresh_token", client_id: authkit.clientId, refresh_token: token, ...authkit.params });
    if (status === 200 && body.access_token) return { ok: true, body };
    return { ok: false, grant: body.error === "invalid_grant" || status === 400 || status === 401, message: reason(body, `HTTP ${status}`) };
  };

  /** Swaps the refresh token for a new access token. One at a time. On a
   * refused grant it reads the store once more (another window may have
   * rotated it) before it gives up and signs out. */
  const refresh = () => refreshing ??= (async () => {
    try {
      if (!refreshToken) throw Object.assign(new Error("Sign in to Black 4 first."), { code: "signed-out" });
      const used = refreshToken;
      let result = await exchange(used);
      if (!result.ok && result.grant) {
        const stored = await store.load().catch(() => null);
        if (stored && stored !== used) { refreshToken = stored; result = await exchange(stored); }
      }
      if (!result.ok) {
        if (result.grant) {
          await forget();
          set({ status: "signed-out", detail: "Your Black 4 sign-in ended. Sign in again." });
          throw Object.assign(new Error("Your Black 4 sign-in ended. Sign in again."), { code: "signed-out" });
        }
        throw Object.assign(new Error(`Black 4 sign-in could not refresh (${result.message}).`), { code: "offline" });
      }
      await keep(result.body);
      return access.token;
    } finally { refreshing = null; }
  })();

  return {
    snapshot: () => view,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get signedIn() { return view.status === "signed-in"; },

    /** A saved sign-in from earlier in this Buzz run, if there is one. */
    restore: () => restored ??= (async () => {
      try {
        const saved = await store.load();
        if (!saved) return false;
        refreshToken = saved;
        await refresh();
        set({ status: "signed-in" });
        return true;
      } catch { return false; } finally { restored = null; }
    })(),

    /** An access token that is good for a while yet; refreshes first when near its end. */
    async accessToken({ force = false } = {}) {
      if (!force && access && access.expiresAt - now() > REFRESH_EARLY_MS) return access.token;
      return refresh();
    },

    /** Starts a device sign-in. `onCode({ url, userCode, expiresAt })` hears
     * what to show; resolves once signed in, rejects with a sentence. */
    async signIn({ onCode } = {}) {
      const mine = ++flow;
      const live = () => mine === flow;
      set({ status: "starting" });
      try {
        const started = await post("/oauth2/device_authorization", { client_id: authkit.clientId, scope: authkit.scope, ...authkit.params });
        if (!live()) throw Object.assign(new Error("Cancelled."), { code: "cancelled" });
        const code = started.body;
        if (started.status !== 200 || typeof code.device_code !== "string") throw new Error(`Black 4 sign-in did not start (${reason(code, `HTTP ${started.status}`)}).`);
        // Only a link on the sign-in origin is ever shown.
        const link = [code.verification_uri_complete, code.verification_uri].find((value) => {
          try { const url = new URL(value); return url.origin === authkit.origin && !url.username && !url.password; } catch { return false; }
        });
        if (!link) throw new Error("Black 4 sign-in returned no link to open.");
        const userCode = typeof code.user_code === "string" ? plain(code.user_code, 32) : "";
        const expiresAt = now() + (Number(code.expires_in) > 0 ? Number(code.expires_in) : 600) * 1000;
        set({ status: "waiting", url: link, userCode, expiresAt });
        onCode?.({ url: link, userCode, expiresAt });
        let interval = Number(code.interval) > 0 ? Number(code.interval) : DEVICE_INTERVAL_S;
        for (;;) {
          await wait(interval * 1000);
          if (!live()) throw Object.assign(new Error("Cancelled."), { code: "cancelled" });
          if (now() > expiresAt) throw Object.assign(new Error("The sign-in code expired. Sign in again."), { code: "expired" });
          let polled;
          try {
            polled = await post("/oauth2/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: code.device_code, client_id: authkit.clientId, ...authkit.params });
          } catch (error) {
            if (error.code === "offline") continue; // a dropped poll is asked again
            throw error;
          }
          if (!live()) throw Object.assign(new Error("Cancelled."), { code: "cancelled" });
          if (polled.status === 200 && polled.body.access_token) { await keep(polled.body); break; }
          const error = polled.body.error;
          if (error === "authorization_pending") continue;
          if (error === "slow_down") { interval += 5; continue; }
          if (error === "expired_token") throw Object.assign(new Error("The sign-in code expired. Sign in again."), { code: "expired" });
          if (error === "access_denied") throw Object.assign(new Error("Sign-in was declined."), { code: "denied" });
          throw new Error(`Black 4 sign-in failed (${reason(polled.body, `HTTP ${polled.status}`)}).`);
        }
        set({ status: "signed-in" });
      } catch (error) {
        if (live()) set({ status: "signed-out", ...(error.code === "cancelled" ? {} : { detail: error.message }) });
        throw error;
      }
    },
    cancel() { flow += 1; if (view.status === "starting" || view.status === "waiting") set({ status: "signed-out" }); },
    async signOut() { flow += 1; await forget(); set({ status: "signed-out" }); },
  };
}

/** The Black 4 MCP over HTTPS (Streamable HTTP, one JSON or SSE reply per
 * POST), as the signed-in person. A 401 refreshes the sign-in and asks once
 * more; a lost MCP session is opened again. Errors carry `code`: "signin"
 * when the sign-in is the problem, "offline" when Black 4 could not be reached. */
export function createMcp({ request, session, url = MCP_URL, clientInfo = { name: "black4-buzz", version: "2.0.0" } } = {}) {
  let sessionId = null;
  let opening = null;
  let opened = null; // the initialize result
  let nextId = 1;

  const post = async (message, { timeoutMs = 60 * 1000, retried = false } = {}) => {
    let token;
    try { token = await session.accessToken({ force: retried }); } catch (error) {
      throw Object.assign(new Error(error.message), { code: "signin" });
    }
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": MCP_PROTOCOL,
    };
    if (sessionId && message.method !== "initialize") headers["mcp-session-id"] = sessionId;
    let response;
    try {
      response = await request({ url, method: "POST", headers, body: JSON.stringify(message), timeoutMs: clampTimeout(timeoutMs) });
    } catch (error) {
      throw Object.assign(new Error(`Could not reach Black 4 (${plain(error?.message ?? error, 120)}).`), { code: "offline" });
    }
    if (response.status === 401 && !retried) return post(message, { timeoutMs, retried: true });
    if (response.status === 401 || response.status === 403) {
      const body = jsonOf(response.body);
      const said = plain(body?.error_description ?? body?.error?.message ?? body?.error ?? "");
      throw Object.assign(new Error(`Black 4 refused your sign-in${said ? `: ${said}` : ""}.`), { code: "signin" });
    }
    const sid = headerOf(response, "mcp-session-id");
    if (sid) sessionId = sid;
    if (response.status === 404 && headers["mcp-session-id"] && message.method !== "initialize") {
      // The server forgot this MCP session: open a new one and ask again.
      sessionId = null;
      opened = null;
      await open();
      return post(message, { timeoutMs, retried });
    }
    if (response.status === 202 || response.status === 204) return undefined;
    if (response.status < 200 || response.status >= 300) {
      throw Object.assign(new Error(`Black 4 answered HTTP ${response.status}${response.body ? `: ${plain(response.body, 200)}` : ""}.`), { code: "http" });
    }
    const type = headerOf(response, "content-type") ?? "";
    const messages = [];
    if (type.includes("text/event-stream")) {
      for (const event of String(response.body ?? "").split(/\r?\n\r?\n/)) {
        const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        const parsed = data && jsonOf(data);
        if (parsed) messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      }
    } else {
      const parsed = jsonOf(response.body ?? "");
      if (parsed) messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }
    const reply = messages.find((entry) => entry?.id === message.id);
    if (!reply) throw Object.assign(new Error("Black 4 sent no answer."), { code: "http" });
    if (reply.error) throw Object.assign(new Error(plain(reply.error.message || "Black 4 MCP error")), { code: "rpc" });
    return reply.result;
  };

  const open = () => opening ??= (async () => {
    try {
      const result = await post({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo } });
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
      opened = result ?? {};
      return opened;
    } finally { opening = null; }
  })();

  return {
    /** Opens the MCP session (again, after `reset`) and resolves with initialize's result. */
    initialize: () => opened ? Promise.resolve(opened) : open(),
    async request(method, params, { timeoutMs } = {}) {
      if (!opened) await open();
      return post({ jsonrpc: "2.0", id: nextId++, method, params }, { timeoutMs });
    },
    reset() { sessionId = null; opened = null; },
  };
}

// A tool's answer as data, or its refusal as an Error carrying the server's
// own sentence. The MCP answers `{"error":{"code","message"}}` text on refusal.
export function readAnswer(result) {
  const text = (result?.content ?? []).filter((part) => part?.type === "text").map((part) => part.text).join("\n");
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  if (result?.isError) {
    const error = result.structuredContent?.error ?? body?.error;
    const message = typeof error === "string" ? error : error?.message;
    const code = typeof error === "object" ? error?.code : undefined;
    throw Object.assign(new Error(message || text || "Black 4 refused the request."), /^(unknown_tool|tool_not_found)$/.test(code ?? "") ? { code: "unavailable" } : { serverCode: code });
  }
  return result?.structuredContent?.data ?? body;
}

// The label Black 4 shows for this link: which kind of computer it came from.
export function linkLabel(platform = globalThis.navigator?.userAgentData?.platform ?? globalThis.navigator?.platform ?? "") {
  const name = /mac/i.test(platform) ? "Mac" : /win/i.test(platform) ? "Windows" : /linux/i.test(platform) ? "Linux" : "";
  return name ? `Buzz on ${name}` : "Buzz";
}

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
// `useConnection` returns the connection status string or `{ status, detail, connect }`.
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
    "signed-out": "Sign in to Black 4 in Settings → Black 4.",
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
    status: "starting", // starting | signed-out | signing-in | connected | stopped | failed
    detail: "",
    signIn: null, // { url, userCode } while a device sign-in waits for the person
    tools: 0,
    account: null,
    instructions: "",
    log: [],
    waiting: null, // decisions waiting on the connected account, or null when unknown
    // idle | no-key | checking | unlinked | linking | linked | removing | error | unavailable
    agentLink: { status: "idle" },
    hardware: "hidden", // hidden | offered: the Black 4 hardware agent type
    hardwareError: "", // one sentence when the hardware type failed
  };
  const listeners = new Set();
  const update = (patch) => {
    // Any status other than connected makes the count unknown: no stale badge
    // survives a disconnect, a failed refresh or a reconnect to another account.
    if (patch.status && patch.status !== "connected") patch = { ...patch, waiting: null, agentLink: { status: "idle" } };
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const note = (line) => {
    const log = state.log.concat(line.slice(0, 300)).slice(-12);
    update({ log });
  };

  // ---- the Black 4 sign-in and the MCP over HTTPS ------------------------
  const hostRequest = (input) => {
    if (typeof ctx.host?.request !== "function") throw new Error("This Buzz cannot make HTTPS requests for plugins.");
    return ctx.host.request(input);
  };
  const session = createSession({ request: hostRequest });
  const mcp = createMcp({ request: hostRequest, session });
  let retry = 0;
  let retryTimer = null;
  let stopped = false;
  let starting = false;
  let generation = 0;
  let linkOnConnect = false; // set by an interactive sign-in: link this Buzz's key once connected
  const registered = new Map(); // tool name -> disposer (if the host returns one)

  /** One MCP request. A reply that lands after a reconnect, sign-out or stop
   * (the generation moved on) is refused; `signal` stops waiting for it. */
  const request = (method, params, { timeoutMs = CALL_TIMEOUT_MS, signal } = {}) => {
    const attempt = generation;
    const call = mcp.request(method, params, { timeoutMs }).then((value) => {
      if (attempt !== generation) throw new Error("Black 4 reconnected; ask again.");
      return value;
    });
    if (!signal) return call;
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error("Stopped."));
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      call.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
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
          "Ask the owner to open Settings → Black 4 and choose Sign in.",
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
  // `review_queue.total` counts decisions waiting on the plugin's signed-in
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

  // ---- agent access: this Buzz's key, linked to the signed-in person ------
  // Agents that run elsewhere (Black 4 hardware) sign their own requests; the
  // MCP accepts them when their owner's Buzz key is linked to a staff person.
  // The link is a claim made from the person's own sign-in. It is made right
  // after an interactive Sign in, when this key is not linked yet (approved
  // 2026-11-15), and otherwise only with the Link my agents button: a plain
  // check never links, so Remove… stays removed until the person asks again.
  let listedNames = new Set();
  let linkTicket = 0;
  const viewerKey = () => {
    try {
      const viewer = ctx.relay?.snapshot?.()?.viewer;
      return /^[0-9a-f]{64}$/i.test(viewer ?? "") ? viewer.toLowerCase() : null;
    } catch {
      return null;
    }
  };
  const setLink = (agentLink) => update({ agentLink });
  const callBlack4 = async (name, args) => {
    let result;
    try {
      if (listedNames.has(name)) result = await request("tools/call", { name, arguments: args }, { timeoutMs: LINK_TIMEOUT_MS });
      else if (listedNames.has("call_tool")) result = await request("tools/call", { name: "call_tool", arguments: { name, arguments: args } }, { timeoutMs: LINK_TIMEOUT_MS });
      else throw Object.assign(new Error(LINK_UNAVAILABLE), { code: "unavailable" });
    } catch (error) {
      if (error.code === "unavailable" || error.code === "signin") throw error;
      if (/unknown tool|no tool|not found/i.test(error.message)) throw Object.assign(new Error(LINK_UNAVAILABLE), { code: "unavailable" });
      throw Object.assign(new Error("Couldn't reach Black 4. Check your connection and try again."), { code: "offline" });
    }
    return readAnswer(result);
  };
  const linkFailure = (error, key) => ({
    status: error.code === "unavailable" ? "unavailable" : "error",
    key,
    message: error.code === "unavailable" ? LINK_UNAVAILABLE : error.message,
  });
  // A check whose answer arrives after the connection, key or a newer check
  // replaced it is dropped.
  const linkStep = async (status, key, work) => {
    const ticket = ++linkTicket;
    const attempt = generation;
    const previous = state.agentLink;
    setLink({ ...previous, status, key, message: "", confirming: false });
    const current = () => ticket === linkTicket && attempt === generation && state.status === "connected" && viewerKey() === key;
    try {
      const next = await work(previous);
      if (current()) setLink(next);
    } catch (error) {
      if (current()) setLink(linkFailure(error, key));
    }
  };
  const makeLink = async (key) => {
    let data;
    try {
      data = await callBlack4("link_agent_owner_key", { ownerKey: key, label: linkLabel() });
    } catch (error) {
      // A refusal is the server's own sentence, such as a key already linked
      // to another person. Say it plainly; nothing retries it.
      if (!["offline", "signin", "unavailable"].includes(error.code)) throw new Error(`Your agents are not linked. ${error.message}`);
      throw error;
    }
    if (!data?.link || String(data.link.ownerKey).toLowerCase() !== key) throw new Error("Black 4 did not confirm the link.");
    return { status: "linked", key, link: data.link };
  };
  /** Checks this Buzz's key. `{ link: true }` (right after Sign in) also
   * links it when it is not linked yet. */
  const checkLink = (options) => {
    const autoLink = options?.link === true;
    const key = viewerKey();
    if (state.status !== "connected") return setLink({ status: "idle" });
    if (!key) return setLink({ status: "no-key" });
    return linkStep(autoLink ? "linking" : "checking", key, async () => {
      const data = await callBlack4("list_agent_owner_keys", {});
      const link = (data?.links ?? []).find((entry) => String(entry.ownerKey).toLowerCase() === key && !entry.revokedAt);
      if (link) return { status: "linked", key, link };
      return autoLink ? makeLink(key) : { status: "unlinked", key };
    });
  };
  const linkAgents = () => {
    const key = viewerKey();
    if (state.status !== "connected" || !key) return checkLink();
    return linkStep("linking", key, () => makeLink(key));
  };
  const removeLink = () => {
    const key = viewerKey();
    const linkId = state.agentLink?.link?.linkId;
    if (state.status !== "connected" || !key || !linkId) return checkLink();
    return linkStep("removing", key, async () => {
      await callBlack4("revoke_agent_access", { linkId });
      return { status: "unlinked", key };
    });
  };
  const confirmRemove = (confirming) => setLink({ ...state.agentLink, confirming });

  // ---- Black 4 hardware: offered to staff only -----------------------------
  // The type appears once whoami says the signed-in account is staff, and is
  // withdrawn when a connected account is not. A dropped connection changes
  // nothing, so a reconnect never hides a staff member's agents. Its failure
  // is one sentence in the Settings card; nothing else depends on it.
  const hardware = hardwareSlot(ctx, {
    report: (error) => {
      console.warn("[black4] Black 4 hardware failed:", error);
      update({ hardwareError: `Black 4 hardware is unavailable in this Buzz: ${String(error?.message ?? error).slice(0, 200)}` });
    },
    access: { use: () => useBridgeState().agentLink, link: () => linkAgents() },
    // One 60-second pass per door request, minted as the signed-in person.
    sign: async (input) => {
      const answer = await callBlack4("sign_hardware_request", input);
      return answer?.data ?? answer;
    },
  });
  const syncHardware = () => {
    if (state.status !== "connected" || !state.account) return;
    if (state.account.kind === "staff") hardware.offer();
    else hardware.withdraw();
    update({ hardware: hardware.offered ? "offered" : "hidden" });
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

  /** Connects the MCP as the signed-in person: lists and offers its tools,
   * reads whoami, then the Reviews count and Agent access. Without a sign-in
   * it waits for the person to choose Sign in. */
  const start = async () => {
    if (stopped || starting) return;
    starting = true;
    const attempt = ++generation;
    try {
      if (!session.signedIn) {
        update({ status: "starting", detail: "" });
        const restored = await session.restore();
        if (attempt !== generation || stopped) return;
        if (!restored) { update({ status: "signed-out", detail: session.snapshot().detail ?? "" }); return; }
      }
      update({ status: "starting", detail: "" });
      mcp.reset();
      const init = await mcp.initialize();
      if (attempt !== generation || stopped) return;
      const listed = await request("tools/list", {});
      if (attempt !== generation || stopped) return;
      listedNames = new Set((listed?.tools ?? []).map((tool) => tool.name));
      register(listed?.tools ?? [], init?.instructions ?? "");
      let account = null;
      try {
        // whoami answers { data: { kind, email, … } }; older servers answered the fields bare.
        const who = readAnswer(await request("tools/call", { name: "whoami", arguments: {} }));
        const me = who?.data ?? who;
        account = { kind: me?.kind, email: me?.email };
      } catch {}
      if (attempt !== generation || stopped) return;
      retry = 0;
      update({ status: "connected", detail: "", account, instructions: init?.instructions ?? "" });
      syncHardware();
      void pollQueue();
      const link = linkOnConnect;
      linkOnConnect = false;
      void checkLink({ link });
    } catch (error) {
      if (attempt !== generation || stopped) return;
      if (error?.code === "signin" || !session.signedIn) update({ status: "signed-out", detail: error?.message ?? "" });
      else scheduleRetry(error?.message ?? String(error));
    } finally {
      if (attempt === generation) starting = false;
    }
  };

  const reconnect = () => {
    clearTimeout(retryTimer);
    stopQueuePolling();
    retry = 0;
    generation += 1;
    starting = false;
    start();
  };

  /** Settings → Black 4 → Sign in: the device sign-in, then connect and link. */
  const signIn = async () => {
    if (stopped || state.status === "signing-in") return;
    clearTimeout(retryTimer);
    generation += 1;
    starting = false;
    update({ status: "signing-in", detail: "", signIn: null });
    try {
      await session.signIn({ onCode: (code) => update({ status: "signing-in", signIn: { url: code.url, userCode: code.userCode } }) });
    } catch (error) {
      if (!stopped && state.status === "signing-in") update({ status: "signed-out", signIn: null, detail: error?.code === "cancelled" ? "" : error?.message ?? String(error) });
      return;
    }
    if (stopped) return;
    update({ signIn: null });
    linkOnConnect = true;
    reconnect();
  };
  const cancelSignIn = () => {
    session.cancel();
    update({ status: "signed-out", signIn: null, detail: "" });
  };
  const signOut = async () => {
    generation += 1;
    starting = false;
    clearTimeout(retryTimer);
    stopQueuePolling();
    await session.signOut();
    hardware.withdraw();
    update({ status: "signed-out", detail: "", account: null, hardware: "hidden" });
  };

  // A refresh the sign-in server refused ends the session: say so in place.
  ctx.effect(() => session.subscribe((view) => {
    if (view.status === "signed-out" && state.status === "connected") {
      generation += 1;
      stopQueuePolling();
      update({ status: "signed-out", detail: view.detail ?? "" });
    }
  }));

  ctx.effect(() => {
    stopped = false;
    start();
    return () => {
      stopped = true;
      generation += 1;
      starting = false;
      clearTimeout(retryTimer);
      stopQueuePolling();
      session.cancel();
      for (const dispose of registered.values()) {
        try {
          dispose?.();
        } catch {}
      }
      registered.clear();
      hardware.withdraw();
      update({ status: "stopped", tools: 0, hardware: "hidden" });
    };
  });

  // The selected community can change who the viewer is (a debug build, an
  // identity switch): check again whenever the key changes.
  if (ctx.relay?.subscribe) {
    ctx.effect(() => ctx.relay.subscribe(() => {
      const key = viewerKey();
      if (state.status === "connected" && key !== (state.agentLink.key ?? null)) void checkLink();
    }));
  }

  // ---- Settings card ------------------------------------------------------
  const STATUS_TEXT = {
    starting: "Connecting…",
    "signed-out": "Not signed in",
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

  // One prompt, one button. The result stays where the button was.
  function AgentAccess({ link, connected, hardware }) {
    const busy = ["checking", "linking", "removing"].includes(link.status);
    React.useEffect(() => {
      if (connected && !busy) void checkLink();
    }, []);
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    const when = (iso) => {
      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    };
    const action = (text, onClick, options = {}) =>
      h("button", { type: "button", onClick, disabled: options.disabled, "aria-busy": options.busy || undefined, className: options.primary ? "b4-primary" : undefined }, text);
    let text;
    let actions = [];
    let role = "status";
    let next = "";
    if (!connected) text = "Sign in to Black 4 first.";
    else if (link.status === "no-key") text = "Open a community in Buzz first.";
    else if (link.status === "checking" || link.status === "idle") text = "Checking…";
    else if (link.status === "unlinked" || link.status === "linking") {
      text = "Agents you create on Black 4 hardware need this to use Black 4 as you.";
      actions = [action(link.status === "linking" ? "Linking…" : "Link my agents", linkAgents, { primary: true, disabled: link.status === "linking", busy: link.status === "linking" })];
    } else if ((link.status === "linked" || link.status === "removing") && link.link) {
      const used = (link.link.agents ?? []).length;
      text = [`Linked${when(link.link.linkedAt) ? ` ${when(link.link.linkedAt)}` : ""}`, used ? `${plural(used, "agent")} used it` : "No agents yet"].join(" · ");
      if (hardware && !used) next = "Next: Agents → New agent → Black 4 hardware.";
      if (link.status === "removing") actions = [action("Removing…", removeLink, { disabled: true, busy: true })];
      else if (link.confirming) {
        text = "Your agents on Black 4 hardware lose Black 4 access.";
        actions = [action("Remove access", removeLink, { primary: true }), action("Cancel", () => confirmRemove(false))];
      } else actions = [action("Remove…", () => confirmRemove(true))];
    } else if (link.status === "unavailable") text = link.message || LINK_UNAVAILABLE;
    else {
      role = "alert";
      text = link.message || "Black 4 could not check this link.";
      actions = [action("Try again", checkLink)];
    }
    return h(
      "section",
      { className: "ui-card", "aria-label": "Agent access", "aria-busy": busy || undefined, style: { padding: "var(--space-panel-inset)", display: "flex", flexDirection: "column", gap: "var(--space-2)" } },
      h("strong", null, "Agent access"),
      h("span", { role }, text),
      next && !link.confirming ? h("span", null, next) : null,
      actions.length ? h("div", { style: { display: "flex", gap: "var(--space-2)" } }, ...actions) : null,
    );
  }

  // Sign in, the code to approve while it waits, and what to do once in.
  // Not a <form>: nothing here submits anything of Buzz's.
  function SignInControls({ current }) {
    const [copied, setCopied] = React.useState(false);
    const button = (text, onClick, primary = false) => h("button", { type: "button", onClick, className: primary ? "b4-primary" : undefined }, text);
    const bar = (...children) => h("div", { style: { display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center" } }, ...children);
    if (current.status === "signing-in") {
      const code = current.signIn;
      if (!code) return bar(h("span", { role: "status" }, "Starting sign-in…"), button("Cancel", cancelSignIn));
      return h("div", { style: { display: "flex", flexDirection: "column", gap: "var(--space-2)" } },
        bar(
          h("a", { href: code.url, target: "_blank", rel: "noopener noreferrer" }, "Open Black 4 sign-in"),
          button(copied ? "Copied" : "Copy link", () => {
            Promise.resolve(globalThis.navigator?.clipboard?.writeText?.(code.url))
              .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
          })),
        code.userCode ? bar(h("span", null, "Check that the page shows this code:"), h("code", { style: { fontSize: "1.1em", letterSpacing: "0.08em" } }, code.userCode)) : null,
        bar(h("span", { role: "status" }, "Waiting for you to approve it in your browser…"), button("Cancel", cancelSignIn)));
    }
    if (current.status === "signed-out") return bar(button("Sign in", () => void signIn(), true));
    if (current.status === "stopped") return null;
    return bar(
      button(current.status === "connected" ? "Reconnect" : "Try again", reconnect),
      button("Sign out", () => void signOut()));
  }

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
        current.detail ? h("span", { role: current.status === "connected" ? "status" : "alert" }, current.detail) : null,
        current.account && current.status === "connected"
          ? row("Signed in as", `${current.account.email ?? "unknown"}${current.account.kind ? ` (${current.account.kind})` : ""}`)
          : null,
        current.status === "connected" ? row("Agent tools", String(current.tools)) : null,
        h(SignInControls, { current }),
      ),
      h(AgentAccess, { link: current.agentLink, connected: current.status === "connected", hardware: current.hardware === "offered" }),
      current.hardwareError ? h("p", { role: "alert" }, current.hardwareError) : null,
      current.log.length
        ? h(
            "details",
            null,
            h("summary", null, "Connection log"),
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

// =============================================================================
// ---- Black 4 hardware --------------------------------------------------------
// =============================================================================
// One hosted agent type, "Black 4 hardware", in Buzz's New agent dialog. An
// agent of this type is created and seen in the owner's Buzz like any other,
// but it runs on a Black 4 machine: that machine makes and keeps the agent's
// key, and runs it with Buzz's own headless harness, so it answers while this
// Buzz is closed.
//
// This part holds no key and no agent state. Each step is one request to the
// machine's `agentctl`, POSTed to the machine's public HTTPS door with a
// 60-second, single-use pass that Platform Control mints for the signed-in
// staff member and binds to that exact request body. Buzz signs the owner's
// attestation; the plugin only carries it. Harness sign-in belongs to the machine: once a
// harness is signed in there, every agent on that machine that runs it uses
// that sign-in. Nothing above this line depends on anything below it except
// `hardwareSlot`, which `apply` uses to offer the type to staff.

/** Black 4 machines. Adding one is one entry here plus its door's origin in
 * the manifest's `networkOrigins`. */
export const MACHINES = [
  { id: "commerce", label: "Commerce Mac", door: "https://black4-commerce-01.tail50b7f0.ts.net" },
];
const DEFAULT_MACHINE = "commerce";

const MACHINE_TIMEOUT_MS = 45 * 1000;
const STATUS_TIMEOUT_MS = 12 * 1000;
const STATUS_TTL_MS = 20 * 1000;
const UNREACHABLE_TTL_MS = 4 * 1000;
const LOGIN_TIMEOUT_MS = 120 * 1000; // the machine waits up to 90 s for a code, 85 s per wait for a device approval
/** Sign-in flows this plugin can show. "code": open a link, paste the code its
 * page shows. "device": open a link and approve the short code shown here;
 * the machine finishes by itself. A machine offers a device sign-in only to a
 * plugin that says it can show one. */
const SIGN_IN_FLOWS = ["code", "device"];

export const HARNESSES = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "grok", label: "Grok Build" },
  { id: "goose", label: "Goose" },
];
const ANSWERS = [
  { id: "anyone", label: "Everyone in the community" },
  { id: "owner-only", label: "Only me" },
];

export const hardwareDefaults = () => ({
  machine: DEFAULT_MACHINE, harness: "claude", model: "", respondTo: "anyone", instructions: "",
});

/** The machine an id or a config names. Unknown or missing (an agent made
 * before machines were a choice) resolves to the default machine. */
export function machineOf(value) {
  const id = typeof value === "string" ? value : value?.id ?? value?.machine;
  return MACHINES.find((entry) => entry.id === id) ?? MACHINES.find((entry) => entry.id === DEFAULT_MACHINE);
}

export const harnessLabel = (id) => HARNESSES.find((entry) => entry.id === id)?.label;

/** The door transport: one agentctl request to a machine, as `ask(machine,
 * request, { timeoutMs })` resolving agentctl's JSON reply. The body is
 * serialized once; its exact UTF-8 bytes are hashed for the pass and the same
 * string is POSTed. Every request gets its own new pass. `sign` is the MCP's
 * `sign_hardware_request`. A failure says whether the sign-in or the door
 * failed. */
export function doorTransport({ request, sign }) {
  return async (machine, payload, { timeoutMs = MACHINE_TIMEOUT_MS } = {}) => {
    const body = JSON.stringify(payload);
    const hash = await bodySha256(body);
    let pass;
    try {
      pass = (await sign({ machine: machine.id, op: payload.op, bodySha256: hash }))?.pass;
    } catch (error) {
      throw Object.assign(new Error(`Could not reach the ${machine.label}: your Black 4 sign-in could not get a pass (${plain(error?.message ?? error, 200)}).`), { code: "signin" });
    }
    if (typeof pass !== "string" || !pass) throw Object.assign(new Error(`Could not reach the ${machine.label}: your Black 4 sign-in got no pass.`), { code: "signin" });
    let response;
    try {
      response = await request({
        url: `${machine.door}/agentctl`, method: "POST", body, timeoutMs: clampTimeout(timeoutMs + 5000),
        headers: { authorization: `Black4-Hardware ${pass}`, "content-type": "application/json", accept: "application/json" },
      });
    } catch (error) {
      throw Object.assign(new Error(`Could not reach the ${machine.label}: its door did not answer (${plain(error?.message ?? error, 160)}).`), { code: "door" });
    }
    const reply = jsonOf(response.body ?? "");
    if (response.status === 401) {
      throw Object.assign(new Error(`Could not reach the ${machine.label}: its door refused the pass${reply?.error ? ` (${plain(reply.error, 160)})` : ""}.`), { code: "door" });
    }
    if (reply && typeof reply === "object" && typeof reply.ok === "boolean") return reply;
    const said = typeof reply?.error === "string" && reply.error ? ` (${plain(reply.error, 160)})` : "";
    throw Object.assign(new Error(`Could not reach the ${machine.label}: its door answered HTTP ${response.status}${said}.`), { code: "door" });
  };
}

/** One request to a machine's agentctl through `ask` (see `doorTransport`):
 * `machine` is a machine, its id or a config. Rejects with the machine's own
 * error text, or with what kept the request from reaching it. */
export async function askMachine(ask, machine, request, { signal, timeoutMs = MACHINE_TIMEOUT_MS } = {}) {
  const target = machineOf(machine);
  if (typeof ask !== "function") throw new Error(`Could not reach the ${target.label}: sign in to Black 4 first.`);
  signal?.throwIfAborted?.();
  let timer;
  let abort;
  const cut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The ${target.label} did not answer in time.`)), timeoutMs);
    abort = () => reject(new DOMException("Cancelled.", "AbortError"));
    signal?.addEventListener?.("abort", abort, { once: true });
  });
  const asked = Promise.resolve().then(() => ask(target, request, { timeoutMs }));
  asked.catch(() => {}); // a late failure after a timeout or Cancel is not unhandled
  let reply;
  try {
    reply = await Promise.race([asked, cut]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", abort);
  }
  if (!reply?.ok) throw new Error(reply?.error || "The machine refused the request.");
  return reply;
}

const unsupported = (error) => /unknown op/i.test(String(error?.message ?? error));

/** Shared, briefly cached `machine.status` per machine. `read` never rejects:
 * it resolves `{ kind: "ok", harnesses }`, `{ kind: "unsupported" }` (the
 * machine predates the op) or `{ kind: "unreachable", error }`. Concurrent
 * reads share one request. */
export function statusReader(ask, { ttlMs = STATUS_TTL_MS, timeoutMs = STATUS_TIMEOUT_MS, now = () => Date.now() } = {}) {
  const cache = new Map(); // machine id -> { at, status }
  const flight = new Map(); // machine id -> promise
  const listeners = new Set();
  const notify = (id) => { for (const listener of [...listeners]) listener(id); };
  const fresh = (id) => {
    const entry = cache.get(id);
    if (!entry) return undefined;
    const ttl = entry.status.kind === "unreachable" ? Math.min(ttlMs, UNREACHABLE_TTL_MS) : ttlMs;
    return now() - entry.at < ttl ? entry.status : undefined;
  };
  return {
    /** The cached status if still fresh; never calls the machine. */
    peek: (machine) => fresh(machineOf(machine).id),
    read(machine, { force = false } = {}) {
      const { id } = machineOf(machine);
      if (!force) {
        const hit = fresh(id);
        if (hit) return Promise.resolve(hit);
        if (flight.has(id)) return flight.get(id);
      }
      const request = askMachine(ask, id, { op: "machine.status" }, { timeoutMs })
        .then((reply) => ({ kind: "ok", harnesses: Array.isArray(reply.harnesses) ? reply.harnesses : [] }))
        .catch((error) => (unsupported(error) ? { kind: "unsupported" } : { kind: "unreachable", error: String(error?.message ?? error) }))
        .then((status) => {
          if (flight.get(id) === request) flight.delete(id);
          cache.set(id, { at: now(), status });
          notify(id);
          return status;
        });
      flight.set(id, request);
      return request;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

/** How Buzz signs this harness in on the machine: "code", "device", or null
 * with a one-sentence reason. A machine from before Codex and Grok sign-in
 * reports no `signIn`; there only Claude Code signs in from Buzz. */
export function signInOf(row) {
  if (!row) return { flow: null, reason: null };
  if ("signIn" in row) {
    if (SIGN_IN_FLOWS.includes(row.signIn)) return { flow: row.signIn, reason: null };
    return { flow: null, reason: typeof row.note === "string" && row.note ? row.note : `Buzz cannot sign in ${harnessLabel(row.id) ?? row.id} on this machine.` };
  }
  if (row.id === "claude") return { flow: "code", reason: null };
  return { flow: null, reason: `This machine's runner cannot sign in ${harnessLabel(row.id) ?? row.id} from Buzz yet.` };
}

/** Why the machine cannot run this harness now (its self-test: a version off
 * its pin, or buzz-acp's ACP handshake with the adapter failing), or null. An
 * older runner reports no `problem`. */
function problemOf(row) {
  return typeof row?.problem === "string" && row.problem ? `This machine cannot run it right now: ${row.problem}.` : null;
}

/** Harnesses to offer for a machine: those it reports installed once its
 * status has loaded, every harness otherwise. One the machine cannot run, or
 * one installed that Buzz cannot sign in and that is not signed in already, is
 * listed as unavailable, with
 * its reason. */
export function harnessOptions(status) {
  if (status?.kind !== "ok") return HARNESSES;
  return HARNESSES.flatMap((entry) => {
    const row = status.harnesses.find((candidate) => candidate?.id === entry.id);
    if (!row || row.installed === false) return [];
    const { flow, reason } = signInOf(row);
    const unavailable = problemOf(row) ?? (!flow && row.signedIn !== true ? reason : null);
    return [unavailable ? { ...entry, label: `${entry.label} (unavailable)`, unavailable } : entry];
  });
}

/** The sign-in state of one harness on a machine, from its status (or
 * `undefined` while loading). */
export function signInState(status, harness) {
  if (!status) return { kind: "loading" };
  if (status.kind === "unreachable") return { kind: "unreachable", error: status.error };
  if (status.kind === "unsupported") return { kind: "unsupported" };
  const row = status.harnesses.find((entry) => entry?.id === harness);
  if (!row || row.installed === false) return { kind: "not-installed" };
  if (problemOf(row)) return { kind: "unavailable", reason: problemOf(row) };
  if (row.signedIn === true) return { kind: "signed-in", account: typeof row.account === "string" && row.account ? row.account : null };
  const { flow, reason } = signInOf(row);
  if (!flow) return { kind: "unavailable", reason };
  if (row.signedIn === false) return { kind: "signed-out" };
  return { kind: "unknown" };
}

/** Whether the create dialog may go ahead with this sign-in state. */
export const readyToCreate = (state) => ["signed-in", "unknown", "unsupported"].includes(state?.kind);

/** One sign-in of a harness on a machine, as a small state machine the form
 * renders. The pasted code is passed straight to the machine and never kept
 * in state, logged or echoed back in an error. A second click while a step is
 * pending joins that step; a reply that lands after Cancel is cancelled too.
 * A device sign-in (needsCode false: Codex, Grok) shows the link and the
 * machine's short userCode, then waits by itself: login.finish with no code
 * waits on the machine for the approval and answers `pending` if it has not
 * come yet, and is asked again until it signs in, fails or is cancelled. */
export function createLogin(ask, machine, harness, { onChange, onSignedIn, timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  let state = Object.freeze({ step: "idle" });
  let loginId = null;
  let pending = null;
  let generation = 0;
  let disposed = false;
  const set = (next) => { if (disposed) return; state = Object.freeze(next); onChange?.(state); };
  const message = (error, code) => {
    let text = String(error?.message ?? error);
    if (code) text = text.split(code).join("…");
    return text;
  };
  const cancelRemote = (id) => (id
    ? askMachine(ask, machine, { op: "login.cancel", loginId: id }, { timeoutMs }).then(() => {}, () => {})
    : Promise.resolve());
  const track = (promise) => {
    const tracked = promise.finally(() => { if (pending === tracked) pending = null; });
    pending = tracked;
    return tracked;
  };
  /** Asks for a new sign-in and shows its link; a reply for a cancelled or
   * replaced attempt is cancelled on the machine instead. */
  const open = (mine, extra = {}) => askMachine(ask, machine, { op: "login.start", harness, flows: SIGN_IN_FLOWS }, { timeoutMs })
    .then((reply) => {
      const id = typeof reply.loginId === "string" ? reply.loginId : null;
      if (disposed || mine !== generation) return cancelRemote(id);
      const url = typeof reply.url === "string" && /^https:\/\//.test(reply.url) ? reply.url : null;
      if (!url || !id) {
        void cancelRemote(id);
        throw new Error("The machine did not return a sign-in link.");
      }
      loginId = id;
      const needsCode = reply.needsCode !== false;
      const userCode = !needsCode && typeof reply.userCode === "string" && /^[A-Za-z0-9-]{4,32}$/.test(reply.userCode) ? reply.userCode : null;
      set({ step: "waiting", url, needsCode, ...(userCode ? { userCode } : {}), ...extra });
      if (!needsCode) approval(mine, id).catch((error) => {
        if (disposed || mine !== generation) return;
        loginId = null;
        set({ step: "idle", error: message(error) });
      });
    });
  /** Waits for a device approval: one login.finish after another while the
   * machine answers pending. Stops when this attempt is cancelled or replaced. */
  const approval = async (mine, id) => {
    while (!disposed && mine === generation && loginId === id) {
      let reply;
      try {
        reply = await askMachine(ask, machine, { op: "login.finish", loginId: id }, { timeoutMs });
      } catch (error) {
        if (disposed || mine !== generation || loginId !== id) return;
        loginId = null;
        set({ step: "idle", error: message(error) });
        return;
      }
      if (disposed || mine !== generation || loginId !== id) return;
      if (reply.pending || reply.signedIn === false) continue;
      loginId = null;
      await signedIn(mine, reply);
      return;
    }
  };
  /** Signed in: show it, refresh the machine's status, then back to idle. A
   * status refresh that fails leaves the form idle, never stuck on "done". */
  const signedIn = async (mine, reply) => {
    set({ step: "done", account: typeof reply.account === "string" ? reply.account : null });
    try { await onSignedIn?.(); } catch { /* the next status read shows it */ }
    if (mine === generation) set({ step: "idle" });
  };
  return {
    get state() { return state; },
    start() {
      if (pending) return pending;
      if (state.step === "waiting") return Promise.resolve();
      const mine = ++generation;
      set({ step: "starting" });
      return track(open(mine).catch((error) => { if (mine === generation) set({ step: "idle", error: message(error) }); }));
    },
    finish(code) {
      const pasted = typeof code === "string" ? code.trim() : "";
      if (pending) return pending;
      if (state.step !== "waiting" || !loginId) return Promise.resolve();
      if (!state.needsCode) return Promise.resolve(); // a device sign-in finishes by itself
      if (state.needsCode && !pasted) { set({ ...state, error: "Paste the code first." }); return Promise.resolve(); }
      const mine = ++generation;
      const used = loginId;
      set({ step: "finishing", url: state.url, needsCode: state.needsCode, ...(state.renewed ? { renewed: true } : {}) });
      return track(askMachine(ask, machine, { op: "login.finish", loginId: used, ...(pasted ? { code: pasted } : {}) }, { timeoutMs })
        .then(async (reply) => {
          if (reply.signedIn === false) throw new Error("Sign-in did not finish.");
          if (loginId === used) loginId = null;
          if (mine !== generation) return;
          await signedIn(mine, reply);
        }, async (error) => {
          // A failed finish closes that sign-in on the machine: its link and
          // id are dead. Start one fresh sign-in (once, no loop) for a new link.
          if (loginId === used) loginId = null;
          if (mine !== generation) return;
          const reason = message(error, pasted);
          set({ step: "renewing", error: reason });
          try {
            await open(mine, { renewed: true, error: `${reason} Open the new link and paste its code.` });
          } catch (failure) {
            if (mine === generation) set({ step: "idle", error: `${reason} ${message(failure)}` });
          }
        }));
    },
    cancel() {
      generation++;
      const id = loginId;
      loginId = null;
      set({ step: "idle" });
      return cancelRemote(id);
    },
    /** The form went away: cancel a sign-in that is under way. */
    dispose() {
      if (disposed) return Promise.resolve();
      generation++;
      const id = loginId;
      loginId = null;
      disposed = true;
      return cancelRemote(id);
    },
  };
}

/** Which machine holds each agent. A hosted agent's config is gone once Buzz
 * has set it up, so later steps (which carry only the pubkey) find it here:
 * learned at creation, then from each machine's `list`, else the default. */
export function agentDirectory(ask) {
  const known = new Map(); // pubkey -> { machine, harness?, respondTo? }
  const listeners = new Set();
  let scan = null;
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const remember = (pubkey, row) => {
    if (!pubkey) return;
    known.set(pubkey, { ...(known.get(pubkey) ?? {}), ...row });
    notify();
  };
  const refresh = () => {
    scan ??= Promise.all(MACHINES.map((machine) =>
      askMachine(ask, machine, { op: "list" }, { timeoutMs: STATUS_TIMEOUT_MS })
        .then((reply) => {
          for (const row of reply.agents ?? []) {
            if (row?.pubkey) known.set(row.pubkey, { machine: machine.id, harness: row.harness, respondTo: row.respondTo });
          }
        })
        .catch(() => {})))
      .then(() => { notify(); })
      .finally(() => { scan = null; });
    return scan;
  };
  return {
    remember,
    peek: (pubkey) => known.get(pubkey),
    refresh,
    /** The machine holding `pubkey`. With one machine there is nothing to find. */
    async machine(pubkey) {
      if (known.has(pubkey)) return machineOf(known.get(pubkey).machine);
      if (MACHINES.length > 1) await refresh();
      return machineOf(known.get(pubkey)?.machine);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

/** One short line under the agent's name: "Claude Code · Commerce Mac". */
export function summaryOf(agent, directory) {
  const seen = directory?.peek?.(agent?.pubkey);
  const machine = machineOf(agent?.config?.machine ?? seen?.machine);
  const harness = harnessLabel(agent?.config?.harness ?? seen?.harness);
  return harness ? `${harness} · ${machine.label}` : machine.label;
}

/** The hosted steps Buzz calls, in terms of `askMachine`. Each is safe to repeat.
 * Creation goes to the machine the config names; later steps go to the
 * machine the directory says holds the agent. */
export function hardwareProvider(ask, requestId = () => crypto.randomUUID(), directory = agentDirectory(ask)) {
  const pending = new Map(); // name -> request id, so a retried creation gets the same agent
  const clean = (config) => {
    const value = { ...hardwareDefaults(), ...(config && typeof config === "object" ? config : {}) };
    return { ...value, machine: machineOf(value.machine).id };
  };
  return {
    async provision({ name, picture, community, config, signal }) {
      const settled = clean(config);
      if (!pending.has(name)) pending.set(name, requestId());
      const reply = await askMachine(ask, settled.machine, {
        op: "provision", name, community, requestId: pending.get(name),
        ...(picture ? { picture } : {}), config: settled,
      }, { signal });
      directory.remember(reply.pubkey, { machine: settled.machine, harness: settled.harness, respondTo: settled.respondTo });
      return { pubkey: reply.pubkey, ...(picture ? { picture } : {}) };
    },
    async activate({ pubkey, name, community, auth, config, signal }) {
      const machine = config === undefined ? await directory.machine(pubkey) : machineOf(clean(config).machine);
      await askMachine(ask, machine, {
        op: "activate", pubkey, community, auth: [...auth],
        ...(config === undefined ? {} : { config: clean(config) }),
      }, { signal });
      directory.remember(pubkey, { machine: machine.id });
      pending.delete(name);
    },
    async profile({ pubkey, name, picture, signal }) {
      await askMachine(ask, await directory.machine(pubkey), { op: "profile", pubkey, name, picture: picture ?? null }, { signal });
    },
    instructions: {
      async get({ pubkey, signal }) {
        return (await askMachine(ask, await directory.machine(pubkey), { op: "instructions.get", pubkey }, { signal })).instructions ?? "";
      },
      async set({ pubkey, instructions, signal }) {
        await askMachine(ask, await directory.machine(pubkey), { op: "instructions.set", pubkey, instructions }, { signal });
      },
    },
    async remove({ pubkey, signal }) {
      await askMachine(ask, await directory.machine(pubkey), { op: "remove", pubkey }, { signal });
    },
  };
}

/** Registers the "Black 4 hardware" agent type on `ctx`. `report(error)` hears
 * any failure of its components, so the plugin's Settings card can say so;
 * `sign` mints a door pass (the MCP's `sign_hardware_request`);
 * `access` is the Agent access link (`use()` reads it in a component, `link()`
 * asks for it), so the form can offer the one step it needs. */
export function applyHardware(ctx, { report = () => {}, access, sign } = {}) {
  const React = ctx.react;
  const h = React.createElement;
  const ask = sign && typeof ctx.host?.request === "function"
    ? doorTransport({ request: (input) => ctx.host.request(input), sign })
    : undefined;
  const statuses = statusReader(ask);
  const directory = agentDirectory(ask);
  const remote = hardwareProvider(ask, undefined, directory);

  // Learn each agent's machine and harness once, off the render path, so
  // summaries and later steps have them.
  if (ask) setTimeout(() => { void directory.refresh(); }, 0);

  const muted = { color: "var(--text-secondary, inherit)", opacity: 0.8 };
  const row = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };

  const Select = ({ label, value, options, onChange, disabled }) =>
    h("label", { style: { display: "grid", gap: 4 } }, label,
      h("select", { value, disabled, onChange: (event) => onChange(event.target.value) },
        ...options.map((option) => h("option", { key: option.id, value: option.id, disabled: !!option.unavailable && option.id !== value }, option.label))));

  /** The machine's status, read in an effect and shared across views. */
  const useStatus = (machineId) => {
    const [status, setStatus] = React.useState(() => statuses.peek(machineId));
    React.useEffect(() => {
      let live = true;
      setStatus(statuses.peek(machineId));
      const off = statuses.subscribe((id) => { if (live && id === machineOf(machineId).id) setStatus(statuses.peek(machineId)); });
      if (ask) void statuses.read(machineId).then((next) => { if (live) setStatus(next); });
      return () => { live = false; off(); };
    }, [machineId]);
    return status;
  };

  // Buzz's own spinner class (the app ships Tailwind's `animate-spin`).
  const Spinner = () => h("span", { "aria-hidden": true, className: "motion-safe:animate-spin",
    style: { display: "inline-block", width: 12, height: 12, borderRadius: "50%", border: "2px solid currentColor", borderRightColor: "transparent" } });

  /** Sign-in for one harness on one machine: the state, and the flow. */
  const SignIn = ({ machineId, harness, status, disabled }) => {
    const machine = machineOf(machineId);
    const state = signInState(status, harness);
    const [login, setLogin] = React.useState({ step: "idle" });
    const [code, setCode] = React.useState("");
    const [copied, setCopied] = React.useState(false);
    const flow = React.useRef(null);
    React.useEffect(() => {
      const current = createLogin(ask, machine.id, harness, {
        onChange: setLogin,
        onSignedIn: () => statuses.read(machine.id, { force: true }),
      });
      flow.current = current;
      setLogin(current.state);
      setCode("");
      return () => { if (flow.current === current) flow.current = null; void current.dispose(); };
    }, [machine.id, harness]);

    const label = harnessLabel(harness) ?? harness;
    if (state.kind === "loading") return h("div", { role: "status", style: { ...row, ...muted } }, h(Spinner), `Checking ${machine.label}…`);
    if (state.kind === "unreachable") return h("div", { role: "alert", style: { display: "grid", gap: 6 } },
      h("span", null, state.error || `Could not reach the ${machine.label}.`),
      h("div", null, h("button", { type: "button", disabled, onClick: () => void statuses.read(machine.id, { force: true }) }, "Try again")));
    if (state.kind === "unsupported") return h("div", { style: muted }, `The ${machine.label} cannot report sign-in yet.`);
    if (state.kind === "not-installed") return h("div", { role: "alert" }, `${label} is not installed on the ${machine.label}.`);
    if (state.kind === "unavailable") return h("div", { role: "alert" }, `${label} is unavailable: ${state.reason}`);
    if (state.kind === "signed-in" && !["waiting", "finishing", "renewing"].includes(login.step)) return h("div", { style: row },
      h("span", null, state.account ? `Signed in as ${state.account}` : `${label} is signed in`));
    if (state.kind === "unknown" && login.step === "idle") return h("div", { style: { display: "grid", gap: 6 } },
      h("div", { style: { ...row, ...muted } },
        h("span", null, "Sign-in status unknown"),
        h("button", { type: "button", disabled, onClick: () => void flow.current?.start() }, "Sign in")),
      login.error && h("span", { role: "alert" }, login.error));

    // Not signed in, or a sign-in under way.
    const busy = login.step === "starting" || login.step === "finishing" || login.step === "renewing";
    if (login.step === "renewing") return h("div", { style: { display: "grid", gap: 6 } },
      h("span", { role: "alert" }, login.error),
      h("div", { role: "status", style: { ...row, ...muted } }, h(Spinner), "Getting a new link…"));
    if (login.step === "idle" || login.step === "starting" || login.step === "done") return h("div", { style: { display: "grid", gap: 6 } },
      h("div", { style: row },
        h("span", null, login.step === "done" ? "Signed in. Checking…" : `${label} is not signed in`),
        login.step !== "done" && h("button", { type: "button", disabled: disabled || busy, "aria-busy": busy, onClick: () => void flow.current?.start() },
          busy ? h(Spinner) : "Sign in"),
        login.step === "starting" && h("button", { type: "button", onClick: () => void flow.current?.cancel() }, "Cancel")),
      login.error && h("span", { role: "alert" }, login.error));

    const submit = () => {
      const pasted = code;
      setCode("");
      void flow.current?.finish(pasted);
    };
    if (!login.needsCode) return h("div", { style: { display: "grid", gap: 8 } },
      h("div", { style: row },
        h("a", { href: login.url, target: "_blank", rel: "noopener noreferrer" }, `Open ${label} sign-in`),
        h("button", { type: "button", onClick: () => {
          Promise.resolve(globalThis.navigator?.clipboard?.writeText?.(login.url))
            .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
        } }, copied ? "Copied" : "Copy link")),
      login.userCode && h("div", { style: row },
        h("span", null, "Approve this code there:"),
        h("code", { style: { fontSize: "1.1em", letterSpacing: "0.08em" } }, login.userCode)),
      h("div", { role: "status", style: { ...row, ...muted } }, h(Spinner),
        login.step === "finishing" ? "Signing in…" : `Waiting for you to approve it. The ${machine.label} finishes by itself.`,
        h("button", { type: "button", onClick: () => void flow.current?.cancel() }, "Cancel")),
      login.error && h("span", { role: "alert" }, login.error));
    return h("div", { style: { display: "grid", gap: 8 } },
      h("div", { style: row },
        h("a", { href: login.url, target: "_blank", rel: "noopener noreferrer" }, login.renewed ? `Open new ${label} sign-in` : `Open ${label} sign-in`),
        h("button", { type: "button", onClick: () => {
          Promise.resolve(globalThis.navigator?.clipboard?.writeText?.(login.url))
            .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
        } }, copied ? "Copied" : "Copy link")),
      // Not a <form>: this sits inside Buzz's own Create agent form, and a
      // nested form's submit goes to the outer one, which abandons the dialog.
      h("div", { style: row },
          h("input", { type: "password", autoComplete: "off", spellCheck: false, placeholder: "Paste code", "aria-label": "Sign-in code",
            value: code, disabled: busy, onChange: (event) => setCode(event.target.value), style: { flex: 1, minWidth: 160 },
            onKeyDown: (event) => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); if (!busy && code.trim()) submit(); } } }),
          h("button", { type: "button", disabled: busy || !code.trim(), "aria-busy": busy, onClick: submit }, busy ? h(Spinner) : "Finish"),
          h("button", { type: "button", onClick: () => { setCode(""); void flow.current?.cancel(); } }, "Cancel")),
      login.error && h("span", { role: "alert" }, login.error));
  };

  /** The one step before an agent here can use Black 4 as its owner: the
   * Agent access link from Settings → Black 4, offered in place. */
  const LinkPrompt = () => {
    const link = access.use();
    if (link.status !== "unlinked" && link.status !== "linking") return null;
    const linking = link.status === "linking";
    return h("div", { style: row },
      h("span", null, "Link your agents so it can use Black 4 as you."),
      h("button", { type: "button", disabled: linking, "aria-busy": linking, onClick: () => void access.link() }, linking ? h(Spinner) : "Link my agents"));
  };

  const Configuration = ({ config, onChange, disabled, harnessControl, onReadyChange }) => {
    const value = { ...hardwareDefaults(), ...(config ?? {}) };
    const machine = machineOf(value.machine);
    const status = useStatus(machine.id);
    const options = harnessOptions(status);
    const offered = options.length ? options : HARNESSES;
    const state = ask ? signInState(status, value.harness) : { kind: "unreachable" };

    // A harness the machine does not have, or cannot sign in: suggest the
    // first one it can run.
    const usable = options.filter((entry) => !entry.unavailable);
    React.useEffect(() => {
      if (status?.kind === "ok" && usable.length && !usable.some((entry) => entry.id === value.harness))
        onChange({ ...value, harness: usable[0].id }, { suggested: true });
    }, [status, value.harness]);
    const isReady = readyToCreate(state) && (status?.kind !== "ok" || usable.some((entry) => entry.id === value.harness));
    React.useEffect(() => { onReadyChange?.(isReady); }, [onReadyChange, isReady]);
    React.useEffect(() => () => onReadyChange?.(false), [onReadyChange]);

    return h("div", { style: { display: "grid", gap: 12 } },
      harnessControl,
      access && h(LinkPrompt),
      h(Select, { label: "Runs on", value: machine.id, options: MACHINES, disabled, onChange: (id) => onChange({ ...value, machine: id }) }),
      h(Select, { label: "Runs", value: value.harness, options: status?.kind === "ok" && !options.length ? [] : offered, disabled: disabled || (status?.kind === "ok" && !options.length),
        onChange: (harness) => onChange({ ...value, harness }) }),
      status?.kind === "ok" && !options.length && h("span", { role: "alert" }, `No harness is installed on the ${machine.label}.`),
      h(Select, { label: "Answers", value: value.respondTo, options: ANSWERS, disabled, onChange: (respondTo) => onChange({ ...value, respondTo }) }),
      ask
        ? h(SignIn, { machineId: machine.id, harness: value.harness, status, disabled })
        : h("p", { role: "alert" }, "Sign in to Black 4 in Settings → Black 4 to reach Black 4 hardware."));
  };

  const Create = ({ config, onChange, disabled }) => {
    const value = { ...hardwareDefaults(), ...(config ?? {}) };
    return h("label", { style: { display: "grid", gap: 4 } }, "Instructions",
      h("textarea", { rows: 6, maxLength: 20000, value: value.instructions, disabled,
        onChange: (event) => onChange({ ...value, instructions: event.target.value }) }));
  };

  /** One labelled line of the Settings tab. */
  const Line = ({ title, children }) => h("div", { style: { display: "grid", gridTemplateColumns: "8rem 1fr", gap: 8, alignItems: "baseline" } },
    h("span", { style: muted }, title), h("div", null, children));

  const Settings = ({ agent, settingsHost, settingsContent }) => {
    const pubkey = agent.pubkey;
    const [seen, setSeen] = React.useState(() => directory.peek(pubkey));
    const [machineId, setMachineId] = React.useState(() => machineOf(seen?.machine).id);
    const [run, setRun] = React.useState({ loading: true });
    const [restarting, setRestarting] = React.useState(false);
    const [text, setText] = React.useState({ loading: true, base: "", draft: "" });
    const [saving, setSaving] = React.useState(false);
    const [revision, setRevision] = React.useState(0);

    React.useEffect(() => directory.subscribe(() => setSeen(directory.peek(pubkey))), [pubkey]);
    React.useEffect(() => {
      const controller = new AbortController();
      const { signal } = controller;
      setRun((prior) => ({ ...prior, loading: true, error: undefined }));
      void (async () => {
        const machine = await directory.machine(pubkey);
        if (signal.aborted) return;
        setMachineId(machine.id);
        const [status, instructions] = await Promise.allSettled([
          askMachine(ask, machine, { op: "status", pubkey }, { signal, timeoutMs: STATUS_TIMEOUT_MS }),
          remote.instructions.get({ pubkey, signal }),
        ]);
        if (signal.aborted) return;
        if (status.status === "fulfilled") {
          const reply = status.value;
          directory.remember(pubkey, { machine: machine.id, harness: reply.harness, respondTo: reply.respondTo });
          setRun({ loading: false, running: !!reply.running, activated: !!reply.activated, harness: reply.harness, respondTo: reply.respondTo });
        } else setRun({ loading: false, error: String(status.reason?.message ?? status.reason) });
        if (instructions.status === "fulfilled") setText({ loading: false, base: instructions.value, draft: instructions.value });
        else setText({ loading: false, base: "", draft: "", error: String(instructions.reason?.message ?? instructions.reason) });
      })().catch((error) => { if (!signal.aborted) setRun({ loading: false, error: String(error?.message ?? error) }); });
      return () => controller.abort();
    }, [pubkey, revision]);

    const machine = machineOf(machineId);
    const harness = run.harness ?? seen?.harness;
    const respondTo = run.respondTo ?? seen?.respondTo;
    const status = useStatus(machine.id);

    const restart = async () => {
      if (restarting) return;
      setRestarting(true);
      try {
        await askMachine(ask, machine, { op: "start", pubkey });
        setRevision((value) => value + 1);
      } catch (error) {
        setRun((prior) => ({ ...prior, error: String(error?.message ?? error) }));
      } finally { setRestarting(false); }
    };
    const save = async () => {
      if (saving) return;
      setSaving(true);
      try {
        // Read again first, so an edit saved elsewhere is not overwritten.
        const latest = await remote.instructions.get({ pubkey });
        if (latest !== text.base) {
          setText({ loading: false, base: latest, draft: text.draft, error: "Its instructions were changed elsewhere. Check the latest, then save again." });
          return;
        }
        await remote.instructions.set({ pubkey, instructions: text.draft });
        setText({ loading: false, base: text.draft, draft: text.draft });
      } catch (error) {
        setText((prior) => ({ ...prior, error: String(error?.message ?? error) }));
      } finally { setSaving(false); }
    };

    const running = run.loading ? h("span", { style: { ...row, ...muted } }, h(Spinner), "Checking…")
      : run.error ? h("span", { role: "alert" }, run.error)
        : h("span", null, run.running ? "Running" : run.activated === false ? "Not set up" : "Stopped");
    const dirty = text.draft !== text.base;
    return h("div", { style: { display: "grid", gap: 16 } },
      settingsHost?.typeControl?.(false),
      h("div", { style: { display: "grid", gap: 10 } },
        h(Line, { title: "Runs on" }, machine.label),
        h(Line, { title: "Runs" }, harnessLabel(harness) ?? (run.loading ? "…" : "Unknown")),
        h(Line, { title: "Answers" }, ANSWERS.find((entry) => entry.id === respondTo)?.label ?? (run.loading ? "…" : "Unknown")),
        h(Line, { title: "Status" }, h("div", { style: row }, running,
          h("button", { type: "button", disabled: restarting || run.loading, "aria-busy": restarting, onClick: () => void restart() }, restarting ? h(Spinner) : "Restart"))),
        harness && h(Line, { title: "Sign-in" }, h(SignIn, { machineId: machine.id, harness, status, disabled: false }))),
      h("label", { style: { display: "grid", gap: 4 } }, "Instructions",
        h("textarea", { rows: 8, maxLength: 20000, value: text.draft, disabled: text.loading || saving,
          placeholder: text.loading ? "Loading…" : "", onChange: (event) => setText({ ...text, draft: event.target.value, error: undefined }) })),
      (dirty || text.error) && h("div", { style: row },
        dirty && h("button", { type: "button", disabled: saving, "aria-busy": saving, onClick: () => void save() }, saving ? h(Spinner) : "Save"),
        dirty && h("button", { type: "button", disabled: saving, onClick: () => setText({ ...text, draft: text.base, error: undefined }) }, "Discard"),
        text.error && h("span", { role: "alert" }, text.error)),
      settingsContent);
  };

  // A component that throws shows one sentence in its place and is reported,
  // so the rest of Black 4 (and Buzz's own dialog around it) keeps working.
  const guarded = (Component, where) => class Guarded extends React.Component {
    constructor(props) { super(props); this.state = { failed: false }; }
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidCatch(error) { report(error); }
    render() {
      return this.state.failed
        ? h("p", { role: "alert" }, `Black 4 hardware could not show its ${where}. See Settings → Black 4.`)
        : h(Component, this.props);
    }
  };

  ctx.agents.register({
    id: "hardware",
    title: "Black 4 hardware",
    description: "Runs on a Black 4 machine, not this computer.",
    defaults: () => ({ config: hardwareDefaults() }),
    adopt: (carry, saved) => ({ ...saved, instructions: carry.instructions ?? saved.instructions }),
    summary: (agent) => {
      try { return summaryOf(agent, directory); } catch (error) { report(error); return "Black 4 hardware"; }
    },
    Create: guarded(Create, "instructions"),
    CreateConfiguration: guarded(Configuration, "form"),
    tabs: [{ id: "settings", title: "Settings", role: "settings", component: guarded(Settings, "settings") }],
    remote,
  });
}

/** Offers the hardware type and takes it back. Buzz has no call to remove a
 * registered agent type, but a registration lasts as long as the scope that
 * made it, so the type lives in its own child scope (`ctx.plugin`), disposed to
 * withdraw it. Whatever the registration throws goes to `report`, never up to
 * the plugin: the MCP tools, Reviews and Agent access do not depend on it. */
export function hardwareSlot(ctx, { report, access, sign, register = applyHardware }) {
  let scope = null;
  let failed = false;
  const fail = (error) => { failed = true; report(error); };
  return {
    get offered() { return !!scope && !failed; },
    offer() {
      if (scope || failed) return;
      try {
        if (typeof ctx.plugin !== "function") {
          // An older host: the type stays until the plugin stops.
          scope = { dispose() {} };
          register(ctx, { report, access, sign });
          return;
        }
        scope = ctx.plugin({
          name: "black4-hardware",
          inject: ["react", "host", "agents"],
          apply: (child) => {
            try { register(child, { report, access, sign }); } catch (error) { fail(error); }
          },
        });
      } catch (error) {
        fail(error);
      }
    },
    withdraw() {
      const current = scope;
      scope = null;
      try { Promise.resolve(current?.dispose?.()).catch(() => {}); } catch {}
    },
  };
}
