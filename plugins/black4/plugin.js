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
/** When Black 4 lists more than AGENT_DIRECT_LIMIT agent-eligible tools,
 * register only AGENT_DIRECT_TOOLS directly in Buzz plus `black4_find_tools`
 * and `black4_call_tool`. Keeps Buzz's total MCP tool count well under host
 * caps (e.g. Antigravity / OpenAI 128-tool limits) so core Buzz tools like
 * `send` and `read` are never crowded out, while keeping every Black 4 tool
 * reachable through the gateway. */
export const AGENT_DIRECT_LIMIT = 16;
export const AGENT_DIRECT_TOOLS = Object.freeze([
  "whoami",
  "list_businesses",
  "get_business",
  "get_business_context",
  "get_goals_and_jobs",
  "resolve_channel_business",
  "list_skills",
  "get_skill",
]);
const CALL_TIMEOUT_MS = 5 * 60 * 1000;
const START_TIMEOUT_MS = 10 * 60 * 1000; // a first browser sign-in can take a while
const RETRY_DELAYS_MS = [5000, 15000, 60000, 300000];
const QUEUE_POLL_MS = 60 * 1000; // the Reviews badge refreshes this often while connected
const QUEUE_TIMEOUT_MS = 30 * 1000;
const LINK_TIMEOUT_MS = 30 * 1000;
const LINK_UNAVAILABLE = "This Black 4 server can't link agents yet.";
const PASS_TOOL = "sign_hardware_request";
/** Limits Platform Control keeps on a sign-in kept on disk (black4-mcp-
 * stored-signins.ts in Platform Control). Both are renewed only through the
 * MCP tool `renew_signin`, a browser approval Platform Control runs itself;
 * signing in again on the device renews nothing.
 * - APPROVAL_CODE: `sign_hardware_request`'s tool error when no approval was
 *   seen in the last 24 hours.
 * - IDLE_CODE: HTTP 403 `{"error":"signin_idle","message"}` on every MCP
 *   message but initialize, ping, tools/list, notifications and a direct
 *   `tools/call renew_signin`, after 14 unused days. */
export const APPROVAL_CODE = "signin_approval_required";
export const IDLE_CODE = "signin_idle";
export const RENEW_TOOL = "renew_signin";
const APPROVAL_TEXT = "Black 4 hardware needs your approval in your browser.";
/** The tools Platform Control refuses with APPROVAL_CODE without a recent
 * approval. A success from one proves the approval is there. */
export const APPROVAL_GATED = Object.freeze(["sign_hardware_request", "link_agent_owner_key", "invite_customer_admin", "set_customer_role"]);
const AGENT_APPROVAL_TEXT = "This needs the person to approve their Black 4 sign-in again. Ask them to choose Approve in browser in Buzz (Settings → Black 4), then try again.";
const PASS_REFUSED = "Agents cannot mint Black 4 hardware passes. Only the Black 4 plugin's hardware agent type does, for its own requests.";
/** Whether a tool call (directly, or through call_tool, however nested) asks
 * for a hardware pass. */
/** Whether a tool call (directly or through call_tool) asks to renew the
 * person's sign-in. Only the person does that, from this plugin's Approve. */
export function renews(name, args, depth = 0) {
  const tool = String(name ?? "").trim().toLowerCase();
  if (tool === RENEW_TOOL) return true;
  if (tool === "call_tool" && depth < 4 && args && typeof args === "object") return renews(args.name, args.arguments, depth + 1);
  return false;
}
const RENEW_REFUSED = "Agents cannot renew the person's Black 4 sign-in. The person approves it in Buzz (Settings → Black 4).";
export function mintsPass(name, args, depth = 0) {
  const tool = String(name ?? "").trim().toLowerCase();
  if (tool === PASS_TOOL) return true;
  if (tool === "call_tool" && depth < 4 && args && typeof args === "object") return mintsPass(args.name, args.arguments, depth + 1);
  return false;
}
/** Tools only a person's own click may reach: the Black 4 review card's
 * decisions and voids. Platform Control marks them app-only (MCP Apps
 * `_meta.ui.visibility: ["app"]`); these names are refused even if a server
 * ever forgot the mark. People decide; agents never do. */
export const APP_ONLY_TOOLS = Object.freeze(["decide_review_item", "void_review", "restore_review"]);
const DECIDE_REFUSED = "Agents cannot decide, void or restore Black 4 reviews. The person decides each item in Buzz (Reviews) or in Black 4 Reviews.";
/** Whether a listed tool is for the app only, never the model (MCP Apps
 * visibility without "model"), or is one of APP_ONLY_TOOLS. */
export function appOnly(tool) {
  const name = String(tool?.name ?? "").trim().toLowerCase();
  if (APP_ONLY_TOOLS.includes(name)) return true;
  const visibility = tool?._meta?.ui?.visibility;
  if (typeof visibility === "string") return visibility.trim().toLowerCase() !== "model";
  if (Array.isArray(visibility)) return !visibility.some((entry) => String(entry).trim().toLowerCase() === "model");
  return false;
}
/** Whether a tool call (directly, or through call_tool however nested) asks
 * for an app-only tool: one of APP_ONLY_TOOLS or one listed as app-only. */
export function decides(name, args, listed = new Set(), depth = 0) {
  const tool = String(name ?? "").trim().toLowerCase();
  if (APP_ONLY_TOOLS.includes(tool) || listed.has(tool)) return true;
  if (tool === "call_tool" && depth < 4 && args) {
    let inner = args;
    if (typeof inner === "string") { try { inner = JSON.parse(inner); } catch { return false; } }
    if (inner && typeof inner === "object") {
      let nested = inner.arguments;
      if (typeof nested === "string") { try { nested = JSON.parse(nested); } catch {} }
      return decides(inner.name, nested, listed, depth + 1);
    }
  }
  return false;
}
/** A tool result as the text an agent reads: never its `_meta` (decision
 * tokens, preview grants), at any depth of any part. */
export function agentText(result) {
  const bare = (value, depth = 0) => {
    if (Array.isArray(value)) return value.map((entry) => bare(entry, depth + 1));
    if (!value || typeof value !== "object" || depth > 32) return value;
    const out = {};
    for (const [key, entry] of Object.entries(value)) if (key !== "_meta") out[key] = bare(entry, depth + 1);
    return out;
  };
  return (Array.isArray(result?.content) ? result.content : [])
    .map((part) => (part?.type === "text" ? String(part.text ?? "") : JSON.stringify(bare(part))))
    .join("\n");
}

// ---- sign-in, the Black 4 MCP and the hardware door, over HTTPS -------------
// Everything goes through `ctx.host.request` to the origins the manifest
// declares; nothing runs outside Buzz. Tokens live only in the closures below
// and, for the refresh token alone, in one localStorage key (`diskStore`):
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
// The same Black 4 MCP every agent uses, listing every tool: Buzz gets no
// connection of its own (Joey, 2026-11-16).
export const MCP_URL = "https://api.black4.ai/mcp";
const MCP_PROTOCOL = "2025-06-18";
const HOST_TIMEOUT_MAX_MS = 180 * 1000; // ctx.host.request's own ceiling
const REFRESH_EARLY_MS = 2 * 60 * 1000; // refresh this long before an access token ends
const DEVICE_INTERVAL_S = 5; // RFC 8628's default poll interval
const ROTATION_LOOKS = 3; // a refused refresh reads the shared store this many more times…
const ROTATION_WAIT_MS = 500; // …this far apart, for a rotation another window is still saving

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

/** A refresh token kept in this module only: gone when Buzz quits. The
 * fallback when the disk store cannot be used, and what tests use. */
export function memoryStore() {
  let value = null;
  return { load: async () => value, save: async (token) => { value = token; }, clear: async () => { value = null; } };
}

/** Where the person's sign-in is kept on this computer: one localStorage key,
 * namespaced to the plugin and the sign-in server. Only the refresh token is
 * stored (as `{"v":1,"refresh":"…"}`), never the access token. */
export const SIGNIN_KEY = `ai.black4.signin.v1:${new URL(AUTHKIT.origin).host}`;

/** The refresh token on disk (the webview's localStorage), so each person
 * signs in once per computer. When localStorage is missing, blocked or
 * throws, it keeps the token in module memory instead, for this run only.
 * `load` answers null only when the disk says there is none (no key, or the
 * empty record a failed delete leaves). A store that cannot be read, and a
 * value under the key that is not this plugin's record (corrupt, or another
 * version's), answer what this module last kept: nothing at launch, and
 * never a sign-out of other windows. Nothing is deleted on a failed write or
 * an unreadable value: only Sign out, a refused grant, or a successful save
 * replaces what is there. */
export function diskStore({ storage = () => globalThis.localStorage, key = SIGNIN_KEY } = {}) {
  let kept = null; // what this module last saved or read: the fallback
  let broken = false; // a write failed: the disk may hold an older value
  const disk = () => { if (broken) return null; try { return storage() ?? null; } catch { return null; } };
  return {
    async load() {
      const store = disk();
      if (!store) return kept;
      try {
        const raw = store.getItem(key);
        if (raw == null) { kept = null; return null; }
        const record = jsonOf(raw);
        if (record?.v === 1 && record.refresh === null) { kept = null; return null; } // deleted
        if (record?.v !== 1 || typeof record.refresh !== "string" || !record.refresh) return kept; // not ours: unread, untouched
        kept = record.refresh;
        return kept;
      } catch { return kept; }
    },
    async save(token) {
      kept = token;
      const store = disk();
      if (!store) return;
      try { store.setItem(key, JSON.stringify({ v: 1, refresh: token })); } catch {
        // This window carries on from memory; what is on disk stays as it
        // was, so other windows are not signed out by a failed write.
        broken = true;
      }
    },
    async clear() {
      kept = null;
      broken = false;
      const store = disk();
      if (!store) return;
      try { store.removeItem(key); } catch {
        try { store.setItem(key, JSON.stringify({ v: 1, refresh: null })); } catch {} // read as none
      }
    },
  };
}
export const signInStore = diskStore(); // the person's sign-in on this computer
/** Whether the plugin may still open Settings → Black 4 by itself in this Buzz
 * run: once, until a sign-in succeeds (module memory, like the sign-in). */
export const signInPrompt = { due: true, connected: false };
/** Remembers, on this device, which installed revision already opened its
 * Sign in by itself: one revision opens Settings once, on its first
 * activation, never on every launch. Not a secret: a revision string only.
 * Module memory backs it within a run; without working storage nothing can
 * be remembered across launches, so the install prompt is not shown at all. */
export const PROMPTED_KEY = "ai.black4.signin-prompted";
const shownThisRun = new Set();
const promptedRevision = {
  /** true: already shown; false: not yet; null: cannot be remembered. */
  seen(revision) {
    if (shownThisRun.has(revision)) return true;
    try {
      const storage = globalThis.localStorage;
      if (!storage) return null;
      return storage.getItem(PROMPTED_KEY) === revision;
    } catch { return null; }
  },
  remember(revision) {
    shownThisRun.add(revision);
    try { globalThis.localStorage?.setItem(PROMPTED_KEY, revision); } catch {}
  },
};

/** One person's Black 4 sign-in. `request` is `ctx.host.request`. The state
 * it reports (`subscribe`/`snapshot`) never holds a token. */
export function createSession({ request, store = signInStore, now = () => Date.now(), sleep, authkit = AUTHKIT } = {}) {
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
  /** Drops this sign-in. `unless`: the refresh token this window last used;
   * when the store already holds a different one (another window or a
   * reload rotated it, or signed in again), that one is left alone. */
  const forget = async ({ unless } = {}) => {
    access = null;
    refreshToken = null;
    if (unless) {
      const stored = await store.load().catch(() => null);
      if (stored && stored !== unless) return stored;
    }
    try { await store.clear(); } catch {}
    return null;
  };

  const exchange = async (token) => {
    const { status, body } = await post("/oauth2/token", { grant_type: "refresh_token", client_id: authkit.clientId, refresh_token: token, ...authkit.params });
    if (status === 200 && body.access_token) return { ok: true, body };
    // Only invalid_grant means this refresh token is dead (expired, revoked,
    // or superseded by a rotation: RFC 6749 §5.2, WorkOS Connect). Anything
    // else (invalid_client, invalid_request, a 5xx) is a failure that keeps
    // the kept sign-in, so a server misconfiguration never deletes it.
    return { ok: false, grant: body.error === "invalid_grant", message: reason(body, `HTTP ${status}`) };
  };

  /** Swaps the refresh token for a new access token. One at a time in this
   * window. The store is shared with other Buzz windows and with the next
   * launch, so it is read first: a token another window rotated is used
   * instead of this window's older one, and a store emptied elsewhere (Sign
   * out in another window) signs this window out too. On a refused grant it
   * reads the store again for a moment (a rotation may still be landing)
   * before it gives up, and then clears the store only if it still holds the
   * refused token. A network failure never clears anything. */
  const refresh = () => refreshing ??= (async () => {
    try {
      const stored = await store.load().catch(() => refreshToken);
      if (!stored && refreshToken) {
        access = null;
        refreshToken = null;
        set({ status: "signed-out" }); // signed out elsewhere: not an ended sign-in
        throw Object.assign(new Error("Sign in to Black 4 first."), { code: "signed-out" });
      }
      if (stored) refreshToken = stored;
      if (!refreshToken) throw Object.assign(new Error("Sign in to Black 4 first."), { code: "signed-out" });
      let used = refreshToken;
      let result = await exchange(used);
      for (let look = 0; !result.ok && result.grant && look < ROTATION_LOOKS; look++) {
        const latest = await store.load().catch(() => null);
        if (latest && latest !== used) { used = latest; refreshToken = latest; result = await exchange(latest); continue; }
        await wait(ROTATION_WAIT_MS);
      }
      // A newer token can still land while this window gives up: use it.
      for (let adopt = 0; !result.ok && result.grant && adopt < 2; adopt++) {
        const newer = await forget({ unless: used });
        if (!newer) break;
        used = newer;
        refreshToken = newer;
        result = await exchange(newer);
      }
      if (!result.ok) {
        if (result.grant) {
          if (refreshToken) await forget({ unless: used }); // a refused adopted token is cleared too, the same way
          set({ status: "signed-out", ended: true, detail: "Your Black 4 sign-in ended. Sign in again." });
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

    /** The sign-in kept on this computer, if there is one: true once it is
     * good again, false when there is none or it was refused. Rejects with
     * `code: "offline"` when the sign-in server could not be reached: the
     * sign-in is kept, and asking again later may still restore it. */
    restore: () => restored ??= (async () => {
      try {
        const saved = await store.load().catch(() => null);
        if (!saved) return false;
        refreshToken = saved;
        try { await refresh(); } catch (error) { if (error?.code === "offline") throw error; return false; }
        set({ status: "signed-in" });
        return true;
      } finally { restored = null; }
    })(),

    /** An access token that is good for a while yet; refreshes first when near its end. */
    async accessToken({ force = false } = {}) {
      if (!force && access && access.expiresAt - now() > REFRESH_EARLY_MS) return access.token;
      return refresh();
    },

    /** Starts a device sign-in. `onCode({ url, userCode, expiresAt })` hears
     * what to show; resolves once signed in, rejects with a sentence. Once
     * approved, the new sign-in replaces any kept on this computer; until then
     * the store is left alone (another window may be using it). */
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
/** What this client declares at initialize: MCP Apps (the review card's
 * extension), so Black 4 may hand Reviews its decision tokens in `_meta`.
 * The plugin keeps `_meta` from every agent (agentText), as MCP Apps hosts must. */
export const CLIENT_CAPABILITIES = Object.freeze({ extensions: Object.freeze({ "io.modelcontextprotocol/ui": Object.freeze({ mimeTypes: Object.freeze(["text/html;profile=mcp-app"]) }) }) });

export function createMcp({ request, session, url = MCP_URL, clientInfo = { name: "black4-buzz", version: "2.0.0" } } = {}) {
  let sessionId = null;
  let opening = null;
  let opened = null; // the initialize result
  let nextId = 1;

  const post = async (message, { timeoutMs = 60 * 1000, retried = false, reopened = false } = {}) => {
    let token;
    try { token = await session.accessToken({ force: retried }); } catch (error) {
      // A refresh that could not reach the sign-in server is offline, not signed out.
      throw Object.assign(new Error(error.message), { code: error?.code === "offline" ? "offline" : "signin" });
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
    if (response.status === 401 && !retried) return post(message, { timeoutMs, retried: true, reopened });
    if (response.status === 403 && jsonOf(response.body)?.error === IDLE_CODE) {
      // Unused too long: the sign-in is still good, but Black 4 wants it
      // approved again (renew_signin). Refreshing would not help.
      const said = plain(jsonOf(response.body)?.message ?? "");
      throw Object.assign(new Error(said || "Approve your Black 4 sign-in again in your browser."), { code: "idle" });
    }
    if (response.status === 401 || response.status === 403) {
      const body = jsonOf(response.body);
      const said = plain(body?.error_description ?? body?.error?.message ?? body?.error ?? "");
      throw Object.assign(new Error(`Black 4 refused your sign-in${said ? `: ${said}` : ""}.`), { code: "signin" });
    }
    const sid = headerOf(response, "mcp-session-id");
    if (sid) sessionId = sid;
    // (Never for a notification: initialized is sent from inside open itself.)
    if (response.status === 404 && headers["mcp-session-id"] && message.id != null && message.method !== "initialize" && !reopened) {
      // The server forgot this MCP session: open a new one and ask again, once.
      sessionId = null;
      opened = null;
      await open();
      return post(message, { timeoutMs, retried, reopened: true });
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
      const result = await post({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: { protocolVersion: MCP_PROTOCOL, capabilities: CLIENT_CAPABILITIES, clientInfo } });
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

// ---- updates: stamped from src/updates/ by `npm run build`; edit it there ----
// ---- Updates nobody can miss ---------------------------------------------------
// Everyone works on the released plugin (Joey, 2026-11-28: "We can't have
// people operating on some of them on the latest plugin and some of them
// not."). Buzz finds the update on `stable` by itself and shows a toast once;
// "Later" hides it until Buzz restarts. This watch serves it again: a notice
// with Update now, back an hour after it is closed (every 15 minutes once the
// update is overdue), and on every launch. Buzz still installs only what the
// person approves, so the strongest step left is refusal: a day after the
// update first showed on this device, Black 4's agent tools answer "update
// first" until it is installed. The clock is kept on the device, by installed
// revision, so a restart neither resets it nor forgives it.

export const UPDATE_SEEN_KEY = "ai.black4.update-seen";
/** How often the watch asks Buzz to look for a new release itself. */
export const UPDATE_CHECK_MS = 30 * 60 * 1000;
/** A closed reminder comes back after this; sooner once the update is overdue. */
export const UPDATE_REMIND_MS = 60 * 60 * 1000;
export const UPDATE_OVERDUE_REMIND_MS = 15 * 60 * 1000;
/** From the first sight of an update on this device to agent tools refusing. */
export const UPDATE_GRACE_MS = 24 * 60 * 60 * 1000;
export const UPDATE_REQUIRED_TEXT =
  "The Black 4 plugin in this Buzz is out of date, so Black 4's tools are paused here until it is updated. " +
  "Ask the person to update it in Buzz: choose Update now on the \"Update Black 4 now\" notice or in Settings → Black 4, " +
  "or Update next to Black 4 in Settings → Plugins. Buzz installs it in a few seconds; then try again.";

/**
 * The update watch for one activation. `updates` is Buzz's
 * pluginInstaller.updates for this plugin, `notices` its notices service;
 * either may be missing on an older Buzz, and then the watch does nothing.
 * `storage` is the device's localStorage.
 */
export function createUpdateWatch({ pluginId, updates, notices, storage, now = () => Date.now(), timers = globalThis, onChange = () => {} }) {
  let pending = null; // { token, installed, candidate, since }
  let showing = null; // AbortController of the notice on screen
  let closedAt = null;
  let remindTimer = null;
  let graceTimer = null; // fires when the day is up, so the screen flips as the tools pause
  let checkTimer = null;
  let stopped = false;

  const readSeen = () => {
    try {
      const value = JSON.parse(storage?.getItem(UPDATE_SEEN_KEY) ?? "null");
      return value && typeof value.installed === "string" && Number.isFinite(value.since) ? value : null;
    } catch { return null; }
  };
  const writeSeen = (value) => { try { storage?.setItem(UPDATE_SEEN_KEY, JSON.stringify(value)); } catch {} };

  const overdue = () => Boolean(pending) && now() - pending.since >= UPDATE_GRACE_MS;

  /** Reads Buzz's update snapshot. Only a candidate for this plugin counts:
   * its absence is not proof of being current, so the clock is kept. */
  const read = () => {
    let snapshot;
    try { snapshot = updates?.getSnapshot?.(); } catch { return; }
    const candidate = snapshot?.candidates?.find?.((entry) => entry?.id === pluginId);
    if (!candidate) {
      if (pending) { pending = null; hide(); disarmGrace(); onChange(); }
      return;
    }
    const seen = readSeen();
    // Out of date since the first update seen for this installed revision: a
    // newer release on top of an ignored one does not restart the clock.
    const since = seen && seen.installed === candidate.installedRevision ? seen.since : now();
    if (!seen || seen.installed !== candidate.installedRevision) writeSeen({ installed: candidate.installedRevision, since });
    const changed = !pending || pending.candidate !== candidate.candidateRevision || pending.token !== candidate.token;
    pending = { token: candidate.token, installed: candidate.installedRevision, candidate: candidate.candidateRevision, since };
    if (changed) onChange();
    armGrace();
    schedule();
  };

  /** The moment the tools pause is the moment the screen says so: when the
   * day runs out while Buzz is open, Settings flips to "Update required" and
   * the notice on screen is replaced by the one that says the tools are
   * paused, without a restart. Timed in hops of at most an hour, so a laptop
   * asleep past the deadline catches up on its first hop. */
  const disarmGrace = () => { if (graceTimer) { timers.clearTimeout(graceTimer); graceTimer = null; } };
  const armGrace = () => {
    disarmGrace();
    if (stopped || !pending || overdue()) return;
    const wait = pending.since + UPDATE_GRACE_MS - now();
    graceTimer = timers.setTimeout(() => {
      graceTimer = null;
      if (stopped || !pending) return;
      if (!overdue()) return armGrace();
      onChange();
      if (showing) { hide(); schedule(); }
    }, Math.max(0, Math.min(wait, UPDATE_REMIND_MS)));
  };

  /** Opens Buzz's Update review for this plugin; a stale token is refreshed once. */
  const install = async () => {
    if (!pending || typeof updates?.queueUpdates !== "function") return false;
    try {
      if (updates.queueUpdates([pending.token])) return true;
      await updates.refresh?.();
      read();
      return Boolean(pending && updates.queueUpdates([pending.token]));
    } catch { return false; }
  };

  const hide = () => { showing?.abort(); showing = null; };

  const show = () => {
    if (stopped || showing || !pending || typeof notices?.show !== "function") return;
    const late = overdue();
    const controller = new AbortController();
    showing = controller;
    let shown;
    try {
      shown = notices.show({
        title: late ? "Update Black 4 now" : "Update Black 4",
        description: late
          ? "This Buzz is on an old version of Black 4, so Black 4's tools are paused here until you update. It takes a few seconds."
          : "A new version of Black 4 is ready. Update now so you and your team work on the same version. Black 4's tools pause on old versions after a day.",
        actions: [{ id: "update", label: "Update now", prominent: true }, { id: "later", label: "Later" }],
      }, { signal: controller.signal });
    } catch { showing = null; return; }
    Promise.resolve(shown).then((picked) => {
      if (showing === controller) showing = null;
      if (controller.signal.aborted || stopped) return;
      closedAt = now();
      if (picked === "update") void install();
      schedule();
    }, () => { if (showing === controller) showing = null; });
  };

  /** Shows the notice now when it is due, else when it will be. */
  const schedule = () => {
    if (stopped || !pending) return;
    if (remindTimer) { timers.clearTimeout(remindTimer); remindTimer = null; }
    if (showing) return;
    const wait = closedAt === null ? 0 : closedAt + (overdue() ? UPDATE_OVERDUE_REMIND_MS : UPDATE_REMIND_MS) - now();
    if (wait <= 0) return show();
    remindTimer = timers.setTimeout(() => { remindTimer = null; show(); }, Math.min(wait, UPDATE_REMIND_MS));
  };

  const check = () => {
    if (stopped) return;
    try { Promise.resolve(updates?.refresh?.()).then(read, () => {}); } catch {}
  };

  let unsubscribe = () => {};
  const start = () => {
    if (!updates) return;
    try { unsubscribe = updates.subscribe?.(read) ?? unsubscribe; } catch {}
    read();
    check();
    checkTimer = timers.setInterval(check, UPDATE_CHECK_MS);
  };

  return {
    start,
    stop() {
      stopped = true;
      hide();
      unsubscribe();
      if (remindTimer) timers.clearTimeout(remindTimer);
      disarmGrace();
      if (checkTimer) timers.clearInterval(checkTimer);
    },
    /** null when current (or unknown); else the update and whether it is overdue. */
    status: () => (pending ? { since: pending.since, overdue: overdue() } : null),
    /** The refusal agent tools answer with once the update is overdue. */
    refusal: () => (overdue() ? UPDATE_REQUIRED_TEXT : null),
    install,
  };
}
// ---- end updates ----

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
    reviewsError: "", // one sentence when Reviews failed to start
    // Black 4 asked for this sign-in to be approved again in a browser
    // (renew_signin): "idle" (unused too long; status is "idle" too) or
    // "hardware" (a pass needs a recent approval).
    // null | { reason, status: "needed" | "starting" | "waiting", code?, detail? }
    renewal: null,
    approvals: 0, // approvals given: hardware views read again on each
    updateNeeded: null, // { since, overdue } while a newer Black 4 waits to be installed here
  };
  const listeners = new Set();
  const update = (patch) => {
    // Any status other than connected makes the count unknown: no stale badge
    // survives a disconnect, a failed refresh or a reconnect to another account.
    if (patch.status && patch.status !== "connected") patch = { ...patch, waiting: null, agentLink: { status: "idle" }, renewal: patch.renewal ?? null };
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
  // The running revision, so Black 4 can tell which plugin build called it.
  const mcp = createMcp({ request: hostRequest, session, clientInfo: { name: "black4-buzz", version: `2.0.0+${String(ctx.pluginOwner?.revision ?? "unknown").slice(0, 12)}` } });

  // ---- updates nobody can miss (src/updates/watch.js) ----------------------
  // Buzz's own update check finds the new release; the watch keeps serving it
  // until it is installed, and pauses the agent tools once it is overdue.
  const reflected = (name) => { try { return ctx.reflect?.get?.(name) ?? undefined; } catch { return undefined; } };
  const updateWatch = createUpdateWatch({
    pluginId: ctx.pluginOwner?.id ?? "ai.black4",
    updates: (() => { try { return reflected("pluginInstaller")?.updates; } catch { return undefined; } })(),
    notices: reflected("notices"),
    storage: (() => { try { return globalThis.localStorage; } catch { return undefined; } })(),
    onChange: () => update({ updateNeeded: updateWatch.status() }),
  });
  ctx.effect(() => { updateWatch.start(); return () => updateWatch.stop(); });
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
    }, (error) => {
      if (error?.code === "idle") becomeIdle(error.message);
      throw error;
    });
    if (!signal) return call;
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error("Stopped."));
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      call.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  };
  // ---- the sign-in prompt -------------------------------------------------
  // Nothing works until the person signs in, so the plugin opens Settings →
  // Black 4, its Sign in button focused, by itself in two cases only:
  // - "installed": the first activation of an installed revision (a fresh
  //   install, or an update, which also starts signed out), once per device;
  //   skipped when the revision is unknown or cannot be remembered;
  // - "ended": a sign-in that worked in this Buzz run was refused later.
  // An ordinary launch opens nothing: every surface shows Sign in in place
  // and the Reviews dock entry carries a dot. Once per Buzz run; a successful
  // sign-in arms it again. Sign out, Cancel, a declined or expired code and a
  // dropped network never prompt. It is never retried later: an open that did
  // not show (the person was busy elsewhere) is left to the in-place Sign in.
  // Navigation is optional: a host without it still activates.
  const settingsSection = `${ctx.pluginOwner?.id ?? "ai.black4"}/connection`;
  const revision = typeof ctx.pluginOwner?.revision === "string" && ctx.pluginOwner.revision ? ctx.pluginOwner.revision : null;
  const navigation = () => {
    try { return ctx.reflect?.get?.("navigation") ?? undefined; } catch { return undefined; }
  };
  const promptSignIn = (reason) => {
    if (reason === "installed" && (!revision || promptedRevision.seen(revision) !== false)) return;
    const nav = navigation();
    if (!signInPrompt.due || stopped || typeof nav?.open !== "function") return;
    signInPrompt.due = false;
    const shown = (result) => {
      if (reason === "installed" && !(result?.status === "failed" && !result.presented)) promptedRevision.remember(revision);
    };
    try {
      Promise.resolve(nav.open({ version: 1, kind: "settings", section: settingsSection })).then(shown, () => {});
    } catch {}
  };
  const signedOutWhy = () => (signInPrompt.connected ? "ended" : "installed");
  /** Opens a sign-in link in the default browser, as a click on it would:
   * Buzz sends a link with target _blank to the system browser. */
  const openInBrowser = (url) => {
    try {
      const doc = globalThis.document;
      if (!doc?.body?.appendChild) return;
      const anchor = doc.createElement("a");
      anchor.href = url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.style.display = "none";
      doc.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch {}
  };

  // ---- agent tools --------------------------------------------------------
  const relayFor = (client) => {
    try {
      return ctx.agents.snapshot?.().running?.find((agent) => agent.key === client.key)?.relay;
    } catch {
      return undefined;
    }
  };

  // What an agent reads of a result: its text, never its `_meta`.
  const textOf = agentText;
  /** Tools the server listed as app-only: never offered, refused by name. */
  let appOnlyNames = new Set();
  /** Agent-eligible tools omitted from direct Buzz registration when the
   * server catalog exceeds AGENT_DIRECT_LIMIT; searched by black4_find_tools
   * and invoked by black4_call_tool. */
  let deferredTools = new Map();

  const toolCall = (name) => async (client, context, args) => {
    // Everyone on the released plugin: an overdue update pauses the tools here.
    const outdated = updateWatch.refusal();
    if (outdated) throw new Error(outdated);
    // Only this plugin's own hardware provider mints door passes. An agent's
    // call carries the person's sign-in, so Black 4 cannot tell it apart.
    if (mintsPass(name, args)) throw new Error(PASS_REFUSED);
    if (renews(name, args)) throw new Error(RENEW_REFUSED);
    if (decides(name, args, appOnlyNames)) throw new Error(DECIDE_REFUSED);
    if (state.status !== "connected") {
      throw new Error(
        `Black 4 is not connected in Buzz (${state.status}${state.detail ? `: ${state.detail}` : ""}). ` +
          (state.status === "idle"
            ? "Ask the owner to choose Approve in browser in Settings → Black 4."
            : "Ask the owner to open Settings → Black 4 and choose Sign in."),
      );
    }
    let input = args ?? {};
    // Only staff reviews can link back to a Buzz conversation. Customers may
    // still publish in their company, so omit thread routing even when an
    // agent picked it up from older instructions.
    const wrappedReview = name === "call_tool" && String(input?.name ?? "").trim().toLowerCase() === "start_review";
    const review = name === "start_review" ? input : wrappedReview ? input.arguments : undefined;
    if (review && typeof review === "object") {
      const reviewThread = context?.root ?? context?.channel;
      let reviewInput = review;
      if (state.account?.kind === "customer" && Object.hasOwn(review, "threadId")) {
        reviewInput = { ...review };
        delete reviewInput.threadId;
      } else if (state.account?.kind === "staff" && typeof reviewThread === "string" && reviewThread && review.threadId == null) {
        reviewInput = { ...review, threadId: reviewThread };
      }
      input = wrappedReview ? { ...input, arguments: reviewInput } : reviewInput;
    }
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
    const called = name === "call_tool" ? String(input?.name ?? "") : name;
    if (result?.isError) {
      let code;
      try { readAnswer(result); } catch (error) { code = error.serverCode; }
      if (code === APPROVAL_CODE) {
        // The person approves in Buzz; the agent is told so, not to call renew_signin.
        needApproval(called === PASS_TOOL ? "hardware" : called === "link_agent_owner_key" ? "link" : "approval");
        throw new Error(AGENT_APPROVAL_TEXT);
      }
      throw new Error(text);
    }
    approvalSeen(called);
    return text;
  };

  const registerOne = (tool, instructions, { compact = false } = {}) => {
    const name = PREFIX + tool.name;
    if (registered.has(name)) return;
    let description = `Black 4: ${tool.description ?? tool.title ?? tool.name}`;
    if (tool.name === "whoami") {
      if (instructions) description = `${description}\n\n${instructions}`;
      if (compact) description += "\n\nUse black4_find_tools and black4_call_tool to discover and run any other Black 4 tool.";
    }
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
  };

  const registerGateway = () => {
    const findName = PREFIX + "find_tools";
    if (!registered.has(findName)) {
      try {
        const handle = ctx.agents.addTool({
          name: findName,
          description: "Black 4: Search the rest of Black 4's tools by keyword (query) and return their descriptions and input schemas, then invoke any of them with black4_call_tool.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Keywords to search tool names and descriptions (omit to list tools)." },
              limit: { type: "integer", description: "Maximum tools to return (default 15, max 50)." },
            },
          },
          call: async (client, context, args) => {
            const rawQuery = String(args?.query ?? "").toLowerCase();
            const words = rawQuery.split(/\W+/).filter((word) => word.length > 1);
            const limit = Math.max(1, Math.min(50, Math.trunc(Number(args?.limit) || 15)));
            const scoreTool = (tool) => {
              if (!words.length) return 1;
              const n = String(tool.name ?? "").replace(/_/g, " ").toLowerCase();
              const t = `${tool.title ?? ""} ${tool.description ?? ""}`.toLowerCase();
              return words.reduce((sum, word) => sum + (n.includes(word) ? 3 : 0) + (t.includes(word) ? 1 : 0), 0);
            };
            const matched = [...deferredTools.values()]
              .map((tool) => ({ tool, score: scoreTool(tool) }))
              .filter((entry) => entry.score > 0)
              .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
            const out = matched.slice(0, limit).map(({ tool }) => ({
              name: tool.name,
              description: tool.description ?? tool.title ?? tool.name,
              readOnly: tool.annotations?.readOnlyHint === true,
              inputSchema: tool.inputSchema && tool.inputSchema.type === "object" ? tool.inputSchema : { type: "object", properties: {} },
            }));
            return JSON.stringify({
              tools: out,
              total: matched.length,
              hint: "Run any tool with black4_call_tool({ name, arguments }).",
            });
          },
        });
        registered.set(findName, typeof handle === "function" ? handle : handle?.dispose?.bind(handle) ?? null);
      } catch (error) {
        note(`Buzz refused ${findName}: ${error?.message ?? error}`);
      }
    }
    const callName = PREFIX + "call_tool";
    if (!registered.has(callName)) {
      try {
        const handle = ctx.agents.addTool({
          name: callName,
          description: "Black 4: Run any Black 4 tool discovered with black4_find_tools by its name and arguments.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Tool name from black4_find_tools (with or without the black4_ prefix)." },
              arguments: { type: "object", description: "Arguments matching the tool's inputSchema." },
            },
            required: ["name"],
          },
          call: async (client, context, args) => {
            const raw = String(args?.name ?? "").trim();
            const target = raw.toLowerCase().startsWith(PREFIX) ? raw.slice(PREFIX.length) : raw;
            const targetArgs = args?.arguments && typeof args.arguments === "object" ? args.arguments : {};
            if (!target) throw new Error("black4_call_tool requires a tool name. Use black4_find_tools to search available tools.");
            if (mintsPass(target, targetArgs)) throw new Error(PASS_REFUSED);
            if (renews(target, targetArgs)) throw new Error(RENEW_REFUSED);
            if (decides(target, targetArgs, appOnlyNames)) throw new Error(DECIDE_REFUSED);
            if (listedNames.has(target)) return toolCall(target)(client, context, targetArgs);
            if (listedNames.has("call_tool")) return toolCall("call_tool")(client, context, { name: target, arguments: targetArgs });
            throw new Error(`Unknown Black 4 tool: ${target}. Use black4_find_tools to search available tools.`);
          },
        });
        registered.set(callName, typeof handle === "function" ? handle : handle?.dispose?.bind(handle) ?? null);
      } catch (error) {
        note(`Buzz refused ${callName}: ${error?.message ?? error}`);
      }
    }
  };

  const register = (tools, instructions) => {
    const eligible = [];
    for (const tool of tools) {
      if (mintsPass(tool.name) || renews(tool.name)) continue; // never offered to agents
      if (appOnly(tool)) { appOnlyNames.add(String(tool.name).trim().toLowerCase()); continue; } // the person's click only
      const name = PREFIX + tool.name;
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) {
        note(`Skipped a tool whose name Buzz refuses: ${tool.name}`);
        continue;
      }
      eligible.push(tool);
    }
    deferredTools = new Map();
    const compact = eligible.length > AGENT_DIRECT_LIMIT;
    if (!compact) {
      for (const tool of eligible) registerOne(tool, instructions);
      update({ tools: registered.size });
      return;
    }
    const direct = new Set(AGENT_DIRECT_TOOLS);
    for (const tool of eligible) {
      if (tool.name === "find_tools" || tool.name === "call_tool") continue;
      if (direct.has(tool.name)) registerOne(tool, instructions, { compact: true });
      else deferredTools.set(tool.name, tool);
    }
    registerGateway();
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
  /** Reviews hears every queue the badge reads (no polling of its own). */
  let onQueue = () => {};
  const noteQueue = (queue) => {
    const total = Number(queue?.total);
    update({ waiting: Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : null });
    if (queue?.kind === "black4_review_queue") onQueue(queue);
  };
  const pollQueue = async () => {
    if (stopped || state.status !== "connected" || queueFlight) return;
    const attempt = generation;
    const flight = queueFlight = request("tools/call", { name: "review_queue", arguments: {} }, { timeoutMs: QUEUE_TIMEOUT_MS });
    let queue = null;
    try {
      const result = await flight;
      // { data: queue } today; older servers answered the queue bare.
      if (!result?.isError) queue = reviewQueueOf(result);
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
  /** A Black 4 tool by name, directly when listed, else through call_tool.
   * `unavailable` is the sentence for a server that does not have it. */
  const callBlack4 = async (name, args, { unavailable = LINK_UNAVAILABLE } = {}) => {
    let result;
    try {
      if (listedNames.has(name)) result = await request("tools/call", { name, arguments: args }, { timeoutMs: LINK_TIMEOUT_MS });
      else if (listedNames.has("call_tool")) result = await request("tools/call", { name: "call_tool", arguments: { name, arguments: args } }, { timeoutMs: LINK_TIMEOUT_MS });
      else throw Object.assign(new Error(unavailable), { code: "unavailable" });
    } catch (error) {
      if (error.code === "unavailable" || error.code === "signin") throw error;
      if (/unknown tool|no tool|not found/i.test(error.message)) throw Object.assign(new Error(unavailable), { code: "unavailable" });
      throw Object.assign(new Error("Couldn't reach Black 4. Check your connection and try again."), { code: "offline" });
    }
    let answer;
    try {
      answer = readAnswer(result);
    } catch (error) {
      if (error.code === "unavailable") throw Object.assign(new Error(unavailable), { code: "unavailable" });
      if (error.serverCode === APPROVAL_CODE) {
        // Not a sign-out: offer Approve in place (renew_signin).
        needApproval(name === PASS_TOOL ? "hardware" : name === "link_agent_owner_key" ? "link" : "approval");
        throw Object.assign(new Error(error.message), { code: "approval", serverCode: error.serverCode });
      }
      throw error;
    }
    approvalSeen(name, { ownLink: name === "link_agent_owner_key" });
    return answer;
  };
  /** Black 4 asked for a recent approval: one Approve, wherever it is shown. */
  const needApproval = (reason) => { if (!state.renewal) update({ renewal: { reason, status: "needed" } }); };
  /** A gated tool worked: the approval is there (given here or elsewhere). */
  // `ownLink`: the plugin's own link call (its answer sets Agent access
  // itself); any other gated call, an agent's link included, retries the
  // link that waited.
  const approvalSeen = (name, { ownLink = false } = {}) => {
    if (!APPROVAL_GATED.includes(name) || !state.renewal || state.renewal.reason === "idle" || state.renewal.status !== "needed") return;
    update({ renewal: null });
    if (!ownLink && state.agentLink?.status === "approval") void linkAgents();
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
      // A recent approval is needed: Approve in place, then the link is made
      // again by itself (renewDone).
      if (error.code === "approval") return { status: "approval", key };
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
    access: {
      use: () => useBridgeState().agentLink,
      link: () => linkAgents(),
      // While signed out, the form and Settings show the same Sign in.
      signIn: { use: () => useBridgeState().status, Prompt: SignInPrompt },
      approval: { use: () => { const current = useBridgeState(); return { needed: !!current.renewal, epoch: current.approvals }; }, Prompt: ApprovalPrompt },
    },
    // The businesses an agent can answer (its Audience), as the signed-in person sees them.
    businesses: () => callBlack4("list_businesses", {}),
    // One 60-second pass per door request, minted as the signed-in person.
    // ownerKey: this Buzz identity's key, which becomes the pass's owner, so an
    // activate matches the attestation this Buzz signs.
    // A key that is not one of the person's live links (never linked,
    // removed, or someone else's) is refused as owner_key_not_linked: say so
    // and bring back the link step, in the form and in Settings.
    sign: async (input) => {
      const ownerKey = viewerKey();
      let answer;
      try {
        answer = await callBlack4(PASS_TOOL, { ...input, ...(ownerKey ? { ownerKey } : {}) }, { unavailable: "This Black 4 server can't sign hardware requests yet." });
      } catch (error) {
        // Approve is offered in place (callBlack4); hardware views read again once given.
        if (error?.code === "approval") throw Object.assign(new Error(APPROVAL_TEXT), { code: "approval" });
        if (error?.serverCode === "owner_key_not_linked" || /owner_key_not_linked/.test(String(error?.message))) {
          void checkLink();
          throw Object.assign(new Error("Your agents are not linked to you on this Buzz identity, or the key is linked to someone else. Choose Link my agents, then try again."), { code: "unlinked" });
        }
        throw error;
      }
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
        // No sign-in kept on this computer, or the kept one was refused (shown
        // in place with its reason; a launch never opens Settings for it).
        if (!restored) { update({ status: "signed-out", detail: session.snapshot().detail ?? "" }); if (!session.snapshot().ended) promptSignIn("installed"); return; }
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
      signInPrompt.connected = true; // from here, signed out means a sign-in ended
      update({ status: "connected", detail: "", account, instructions: init?.instructions ?? "" });
      syncHardware();
      void pollQueue();
      const link = linkOnConnect;
      linkOnConnect = false;
      void checkLink({ link });
    } catch (error) {
      if (attempt !== generation || stopped) return;
      // Signed out only when the sign-in server refused the grant (the session
      // says so); anything else, a dropped network included, is retried.
      if (error?.code !== "offline" && session.snapshot().status === "signed-out") {
        update({ status: "signed-out", detail: session.snapshot().detail ?? error?.message ?? "" });
        if (session.snapshot().ended) promptSignIn(signedOutWhy());
      }
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
  // Each Sign in is its own attempt: a cancelled one that ends later (its
  // poll was asleep) never touches the one that replaced it.
  let signInTicket = 0;
  const signIn = async () => {
    if (stopped || state.status === "signing-in") return;
    const mine = ++signInTicket;
    clearTimeout(retryTimer);
    generation += 1;
    starting = false;
    update({ status: "signing-in", detail: "", signIn: null });
    // Another Buzz window may have signed in since: use that, no browser.
    let restored = false;
    try { restored = await session.restore(); } catch {}
    if (stopped || mine !== signInTicket) return;
    if (restored) {
      signInPrompt.due = true;
      update({ signIn: null });
      reconnect();
      return;
    }
    try {
      await session.signIn({ onCode: (code) => {
        if (mine !== signInTicket) return;
        update({ status: "signing-in", signIn: { url: code.url, userCode: code.userCode } });
        openInBrowser(code.url); // the link carries the code: the person only confirms it
      } });
    } catch (error) {
      if (!stopped && mine === signInTicket && state.status === "signing-in") update({ status: "signed-out", signIn: null, detail: error?.code === "cancelled" ? "" : error?.message ?? String(error) });
      return;
    }
    if (stopped || mine !== signInTicket) return;
    signInPrompt.due = true; // a sign-in that ends later may prompt once more
    update({ signIn: null });
    linkOnConnect = true;
    reconnect();
  };
  // ---- approving the sign-in again (renew_signin) --------------------------
  // Platform Control asks for it after 14 unused days (idle: every request
  // but renew_signin is refused) and before a hardware pass when no approval
  // was seen in 24 hours. Platform Control runs the browser approval itself:
  // renew_signin with {} answers a code and link; asked again with the
  // approvalId every `interval` seconds it says pending, approved, denied or
  // expired. The person stays signed in throughout and the kept sign-in is
  // never cleared for either; the plugin only shows the code, as at sign-in.

  /** Idle: the sign-in is good, but Black 4 refuses it until approved again. */
  const becomeIdle = (message) => {
    if (stopped || state.status === "idle" || state.status === "signed-out" || state.status === "signing-in") return;
    generation += 1; // in-flight answers and any connect under way stop here
    starting = false;
    clearTimeout(retryTimer);
    stopQueuePolling();
    update({ status: "idle", detail: plain(message, 300), renewal: { reason: "idle", status: "needed" } });
  };

  let renewTicket = 0;
  const RENEW_ENDED = {
    denied: "The approval was declined.",
    expired: "The approval code expired. Approve again.",
    signin_approval_mismatch: "That approval came from a different account. Approve again as yourself.",
    signin_approval_not_found: "That approval is no longer known to Black 4. Approve again.",
    signin_approval_unavailable: "Black 4 couldn't start the approval just now. Try again shortly.",
  };
  const askRenew = async (args) => {
    let result;
    try {
      // Directly, never through call_tool: an idle sign-in may call only it.
      result = await mcp.request("tools/call", { name: RENEW_TOOL, arguments: args }, { timeoutMs: LINK_TIMEOUT_MS });
    } catch (error) {
      // A server without renew_signin (before Platform Control's stored
      // sign-in limits) answers a JSON-RPC error for an unknown tool.
      if (error?.code === "rpc") throw Object.assign(new Error("This Black 4 server can't approve sign-ins yet."), { code: "unsupported" });
      // The sign-in itself was refused: not something to ask again.
      if (error?.code === "signin") throw error;
      throw Object.assign(new Error("Couldn't reach Black 4. Try again."), { code: "retry" });
    }
    try { return readAnswer(result); } catch (error) {
      if (error.code === "unavailable") throw Object.assign(new Error("This Black 4 server can't approve sign-ins yet."), { code: "unsupported" });
      if (error.serverCode === "signin_approval_unavailable") throw Object.assign(new Error(error.message), { code: "retry", serverCode: error.serverCode });
      throw error;
    }
  };
  // The approval this window last started: kept after Cancel, so pressing
  // Approve again resumes it (same code) and an approval given just after
  // Cancel still counts.
  let lastApproval = null; // { id, code: { url, userCode }, ends, interval }
  const renewDone = () => {
    lastApproval = null;
    const idle = state.status === "idle";
    const relink = state.agentLink?.status === "approval";
    update({ renewal: null, approvals: state.approvals + 1 });
    if (idle) reconnect();
    else if (relink) void linkAgents(); // the link that waited for the approval
  };
  /** One cheap look before a new browser approval: this window's own last
   * approval (approved after Cancel?), and, while idle, one ordinary request
   * (approved in another window?). True when no approval is needed now. */
  const recheck = async () => {
    if (lastApproval && Date.now() < lastApproval.ends) {
      try {
        const answer = await askRenew({ approvalId: lastApproval.id });
        if (answer?.state === "approved") return true;
        if (answer?.state !== "pending") lastApproval = null;
      } catch (error) {
        if (error?.serverCode === "signin_approval_not_needed") return true;
        if (error?.code !== "retry") lastApproval = null;
      }
    } else lastApproval = null;
    if (state.status === "idle") {
      try { await mcp.request("tools/call", { name: "whoami", arguments: {} }, { timeoutMs: LINK_TIMEOUT_MS }); return true; } catch {}
    }
    return false;
  };
  /** Approve in browser: the renewal, shown in place on every surface. */
  const approve = async () => {
    if (stopped || !state.renewal || state.renewal.status !== "needed") return;
    const mine = ++renewTicket;
    const live = () => mine === renewTicket && !stopped && !!state.renewal;
    const reason = state.renewal.reason;
    const setRenewal = (patch) => { if (live()) update({ renewal: { reason, ...patch } }); };
    setRenewal({ status: "starting" });
    try {
      if (await recheck()) { if (live()) renewDone(); return; }
      if (!live()) return;
      if (!lastApproval) {
        const started = await askRenew({});
        if (!live()) return;
        if (started?.state === "approved") return renewDone();
        const approvalId = typeof started?.approvalId === "string" ? started.approvalId : "";
        // Only a link on the sign-in origin is ever shown or opened.
        const link = [started?.verificationUriComplete, started?.verificationUri].find((value) => {
          try { const url = new URL(value); return url.origin === AUTHKIT.origin && !url.username && !url.password; } catch { return false; }
        });
        if (started?.state !== "pending" || !approvalId || !link) throw new Error("Black 4 could not start the approval. Try again.");
        lastApproval = {
          id: approvalId,
          code: { url: link, userCode: typeof started.userCode === "string" ? plain(started.userCode, 32) : "" },
          ends: Date.parse(started.expiresAt) || Date.now() + 10 * 60 * 1000,
          interval: Number(started.interval) > 0 ? Number(started.interval) : DEVICE_INTERVAL_S,
        };
      }
      const approval = lastApproval;
      setRenewal({ status: "waiting", code: approval.code });
      openInBrowser(approval.code.url);
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, approval.interval * 1000));
        if (!live()) return;
        if (Date.now() > approval.ends) { lastApproval = null; throw new Error(RENEW_ENDED.expired); }
        let polled;
        try { polled = await askRenew({ approvalId: approval.id }); } catch (error) {
          if (error.code === "retry") continue; // asked again next time
          throw error;
        }
        // Approved just as the person pressed Cancel: it still counts.
        if (polled?.state === "approved") { if (!stopped && state.renewal) renewDone(); return; }
        if (!live()) return;
        if (polled?.state === "pending") { if (Number(polled.interval) > 0) approval.interval = Number(polled.interval); continue; }
        lastApproval = null;
        throw new Error(RENEW_ENDED[polled?.state] ?? "Black 4 could not finish the approval. Try again.");
      }
    } catch (error) {
      if (error?.serverCode === "signin_approval_not_needed") { if (live()) renewDone(); return; }
      if (error?.serverCode && error.serverCode !== "signin_approval_unavailable") lastApproval = null;
      setRenewal({ status: "needed", detail: RENEW_ENDED[error?.serverCode] ?? plain(error?.message ?? error, 200) });
    }
  };
  const cancelApproval = () => {
    renewTicket += 1;
    if (state.renewal) update({ renewal: { reason: state.renewal.reason, status: "needed" } });
  };
  // Back in this window (focus): approved elsewhere, or after Cancel? One
  // cheap look; for hardware, its views read again (a pass that works ends
  // the prompt). At most every 10 seconds, and never mid-approval.
  let lookedAt = 0;
  const lookAgain = async () => {
    if (stopped || state.renewal?.status !== "needed" || Date.now() - lookedAt < 10 * 1000) return;
    lookedAt = Date.now();
    const ticket = renewTicket;
    let done = false;
    try { done = await recheck(); } catch {}
    if (ticket !== renewTicket || state.renewal?.status !== "needed") return;
    if (done) renewDone();
    else if (state.renewal.reason === "hardware") update({ approvals: state.approvals + 1 });
  };
  if (typeof globalThis.addEventListener === "function") {
    ctx.effect(() => {
      const onFocus = () => { void lookAgain(); };
      const remove = globalThis.removeEventListener;
      globalThis.addEventListener("focus", onFocus);
      return () => { try { remove?.call(globalThis, "focus", onFocus); } catch {} };
    });
  }

  const cancelSignIn = () => {
    signInTicket += 1;
    session.cancel();
    update({ status: "signed-out", signIn: null, detail: "" });
  };
  let signingOut = false; // the person's own Sign out: never a prompt
  const signOut = async () => {
    signInTicket += 1;
    generation += 1;
    starting = false;
    clearTimeout(retryTimer);
    stopQueuePolling();
    signingOut = true;
    try { await session.signOut(); } finally { signingOut = false; }
    hardware.withdraw();
    update({ status: "signed-out", detail: "", account: null, hardware: "hidden" });
  };

  // A refresh the sign-in server refused ends the session: say so in place.
  ctx.effect(() => session.subscribe((view) => {
    // Also while idle: a refusal during Approve, or Sign out in another
    // window, turns Approve into Sign in.
    if (view.status === "signed-out" && (state.status === "connected" || state.status === "idle") && !signingOut) {
      generation += 1;
      stopQueuePolling();
      update({ status: "signed-out", detail: view.detail ?? "" });
      if (view.ended) promptSignIn("ended"); // signed out in another window: no prompt
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
    idle: "Waiting for your approval",
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

  // Every Black 4 screen draws in Buzz's own parts.
  const ui = buzzUi(React);

  // ---- Reviews: its own scope, so a fault there never stops the MCP --------
  // The bridge is all Reviews gets: the connection, raw reads and the one
  // decision tool (their `_meta` stays inside Reviews), the queue the badge
  // poll already reads, and the shared Sign in. Agents never reach `call`.
  const queueListeners = new Set();
  onQueue = (queue) => { for (const listener of [...queueListeners]) { try { listener(queue); } catch {} } };
  const reviews = reviewsSlot(ctx, {
    use: () => { const current = useBridgeState(); return { status: current.status, detail: current.detail, waiting: current.waiting, connect: reconnect,
      account: current.account?.email ? { email: String(current.account.email) } : null }; },
    // The person's own Sign out, the same one Settings → Black 4 runs: on every Reviews surface, not only there.
    signOut: () => void signOut(),
    call: async (name, args, { timeoutMs = LINK_TIMEOUT_MS } = {}) => {
      if (state.status !== "connected") throw Object.assign(new Error("Black 4 is reconnecting. Try again once connected."), { code: "offline" });
      const attempt = generation;
      const result = await request("tools/call", { name, arguments: args }, { timeoutMs });
      // A queue the person just read is the freshest count the badge can show:
      // the whole queue only, never one narrowed to a business or a goal.
      if (name === "review_queue" && !args?.businessId && !args?.goal && attempt === generation && state.status === "connected" && !result?.isError) {
        try { noteQueue(reviewQueueOf(result)); } catch {}
      }
      return result;
    },
    queue: { subscribe: (listener) => { queueListeners.add(listener); return () => queueListeners.delete(listener); }, refresh: () => { clearTimeout(queueTimer); void pollQueue(); } },
    // Every status change: Reviews forgets the last connection's data when it ends.
    status: { subscribe: (listener) => { const each = () => listener(state.status); listeners.add(each); each(); return () => listeners.delete(each); } },
    SignInPrompt,
    browser: ctx.browser?.available ? ctx.browser.View : null,
    // A maker's name and picture from the community's profiles, as Buzz shows a member.
    profile: (pubkey) => {
      try {
        const profiles = ctx.relay?.snapshot?.()?.session?.profiles;
        const found = profiles?.snapshot?.().get(pubkey);
        if (!found) void profiles?.ensure?.([pubkey])?.catch?.(() => {});
        return found ? { name: found.name, picture: found.picture } : null;
      } catch { return null; }
    },
    report: (error) => {
      console.warn("[black4] Reviews failed:", error);
      update({ reviewsError: `Reviews is unavailable in this Buzz: ${String(error?.message ?? error).slice(0, 200)}` });
    },
  });
  ctx.effect(() => () => reviews.dispose());

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
      h(ui.Button, { key: text, size: "sm", variant: options.primary ? "prominent" : "subtle", onClick, disabled: options.disabled, loading: options.busy }, text);
    let text;
    let actions = [];
    let role = "status";
    let next = "";
    let approval = false;
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
    } else if (link.status === "approval") {
      // Black 4 wants a recent approval before it links: Approve here, and
      // the link is made by itself once approved.
      text = "Linking waits for your approval.";
      approval = true;
    } else if (link.status === "unavailable") text = link.message || LINK_UNAVAILABLE;
    else {
      role = "alert";
      text = link.message || "Black 4 could not check this link.";
      actions = [action("Try again", checkLink)];
    }
    return h("section", { "aria-label": "Agent access", "aria-busy": busy || undefined },
      h(ui.SectionTitle, { title: "Agent access" }),
      h(ui.Stack, { gap: 2 },
        h(ui.Group, null, h(ui.Row, { title: "Agents on Black 4 hardware",
          description: role === "alert" ? ui.Alert(text) : h("span", { role }, text),
          trailing: actions.length ? h(ui.Actions, null, ...actions) : null })),
        approval ? h(SignInPrompt, { key: "approve", renewal: true }) : null,
        next && !link.confirming ? ui.Note(next) : null));
  }

  // ---- Sign in: one action, the same on every surface -----------------------
  // Signed out: one button, as Buzz's own sign-ins (Builderlab). Signing in:
  // the code, as Pairing shows its code, with Copy, while the browser (opened
  // by Sign in) asks the person to confirm it; the surface turns signed-in by
  // itself once they do. `compact` is one line, for link previews and the bar
  // above the inbox. Not a <form>: it sits inside Buzz's own forms.
  // One component for every "approve in your browser" moment: signing in,
  // and approving the sign-in again (renew_signin), so both look the same.
  // `renewal`: also show a hardware renewal (the hardware views); an idle
  // sign-in shows its renewal everywhere.
  function SignInPrompt({ compact = false, focus = false, renewal = false }) {
    const current = useBridgeState();
    const [copied, setCopied] = React.useState(false);
    const size = compact ? "sm" : "md";
    const cancel = (onClick) => h(ui.Button, { key: "cancel", size, variant: "outline", onClick }, "Cancel");
    const busy = (text, onCancel) => compact
      ? h(ui.Actions, null, ui.Status(text), cancel(onCancel))
      : h(ui.Actions, null, h(ui.Button, { key: "busy", variant: "prominent", loading: true }, text), cancel(onCancel));
    // The code to confirm while the browser asks, with Copy; or one line.
    // `signingIn`: a device sign-in, where WorkOS may ask for a company; never an approval renewal.
    const waiting = (code, onCancel, signingIn = false) => {
      const open = h(ui.Button, { key: "open", size, variant: compact ? "subtle" : "outline", href: code.url }, "Open sign-in page");
      const words = code.userCode ? (compact ? `Confirm ${code.userCode} in your browser` : "Confirm it in your browser") : "Approve it in your browser";
      if (compact) return h(ui.Actions, null, ui.Status(words), open, cancel(onCancel));
      return h(ui.Column, null,
        code.userCode ? h(ui.CodeColumn, null,
          h(ui.OneTimeCode, { code: code.userCode, label: "Sign-in code" }),
          h(ui.Button, { onClick: () => {
            Promise.resolve(globalThis.navigator?.clipboard?.writeText?.(code.userCode))
              .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
          } }, copied ? "Copied" : "Copy code")) : null,
        ui.Status(words),
        // WorkOS asks someone in several companies to choose one; Black 4 gives them all of theirs whichever they pick.
        signingIn ? ui.Line("If the page asks you to choose a company, choose any one: you get every company you belong to.") : null,
        h(ui.Actions, null, open, cancel(onCancel)));
    };
    const renewing = current.status === "idle" || (renewal && current.status === "connected") ? current.renewal : null;
    if (renewing) {
      if (renewing.status === "starting" || (renewing.status === "waiting" && !renewing.code)) return busy("Approving…", cancelApproval);
      if (renewing.status === "waiting") return waiting(renewing.code, cancelApproval);
      return h(ui.Column, { gap: compact ? 2 : 4 },
        renewing.detail ? ui.Line(renewing.detail) : null,
        h(ui.Button, { variant: "prominent", size, autoFocus: focus || undefined, onClick: () => void approve(),
          title: renewing.reason === "idle"
            ? "Black 4 asks you to approve this sign-in again after a while unused. You stay signed in."
            : renewing.reason === "hardware" ? "Black 4 hardware asks for a recent approval of this sign-in. You stay signed in."
              : renewing.reason === "link" ? "Linking your agents asks for a recent approval of this sign-in. You stay signed in."
                : "Black 4 asks for a recent approval of this sign-in. You stay signed in." }, "Approve in browser"));
    }
    if (current.status === "signing-in") return current.signIn ? waiting(current.signIn, cancelSignIn, true) : busy("Signing in…", cancelSignIn);
    if (current.status !== "signed-out") return null;
    // Why the last sign-in ended is announced once, from Settings (which a
    // sign-in that ended opens, its button focused and described by it), not
    // as an alert from every surface showing Sign in.
    const described = focus && current.detail ? "b4-signin-detail" : undefined;
    return h(ui.Column, { gap: compact ? 2 : 4 },
      current.detail ? ui.Line(current.detail, { id: described }) : null,
      h(ui.Button, { variant: "prominent", size, autoFocus: focus || undefined, "aria-describedby": described,
        title: "Gives every agent in Buzz the Black 4 tools, as you", onClick: () => void signIn() }, "Sign in to Black 4"));
  }
  /** The hardware views' prompt: also shows a hardware renewal. */
  function ApprovalPrompt(props) { return h(SignInPrompt, { ...props, renewal: true }); }

  // A newer Black 4 waits to be installed: first on the card, one click to update.
  function UpdateRow() {
    const status = updateWatch.status();
    if (!status) return null;
    return h(ui.Group, null,
      h(ui.Row, { title: status.overdue ? "Update required" : "Update ready",
        description: status.overdue
          ? ui.Alert("This Buzz is on an old version of Black 4, so Black 4's tools are paused here until you update.")
          : "A new version of Black 4 is ready. Update so you and your team work on the same version.",
        trailing: h(ui.Button, { size: "sm", onClick: () => void updateWatch.install() }, "Update now") }));
  }

  // The Settings card, as Buzz's own (GitHub, Claude): a title and subtitle,
  // then sections of cards.
  function Black4Settings() {
    const current = useBridgeState();
    const out = ["signed-out", "signing-in", "idle"].includes(current.status);
    const connected = current.status === "connected";
    return h("section", { "aria-labelledby": "b4-settings-title" },
      h(ui.Header, { id: "b4-settings-title", title: "Black 4", subtitle: "Gives every agent in Buzz the Black 4 tools, as you." }),
      h(ui.Stack, { gap: "section" },
        current.updateNeeded ? h(UpdateRow, null) : null,
        out
          // Signed out, the card is the one thing to do; Buzz opens it here.
          ? h(ui.Column, null, h(SignInPrompt, { focus: true }),
            current.status === "idle" ? h(ui.Button, { variant: "outline", onClick: () => void signOut() }, "Sign out") : null)
          : h("div", null,
            h(ui.SectionTitle, { title: "Connection" }),
            h(ui.Stack, { gap: 2 },
              h(ui.Group, null,
                h(ui.Row, { title: "Status",
                  description: current.detail ? (connected ? h("span", { role: "status" }, current.detail) : ui.Alert(current.detail)) : undefined,
                  trailing: h(ui.Actions, null, ui.Value(STATUS_TEXT[current.status] ?? current.status),
                    current.status === "stopped" ? null : h(ui.Button, { size: "sm", onClick: reconnect }, connected ? "Reconnect" : "Try again")) }),
                h(ui.Row, { title: "Signed in as",
                  description: current.account && connected ? `${current.account.email ?? "unknown"}${current.account.kind ? ` (${current.account.kind})` : ""}` : undefined,
                  trailing: current.status === "stopped" ? null : h(ui.Button, { size: "sm", variant: "outline", onClick: () => void signOut() }, "Sign out") }),
                connected ? h(ui.Row, { title: "Agent tools", trailing: ui.Value(String(current.tools)) }) : null),
              // Black 4 asked for a recent approval (an agent's call, or hardware):
              // Approve here too. The link step shows its own.
              connected && current.renewal && current.agentLink?.status !== "approval" ? h(SignInPrompt, { renewal: true }) : null)),
        connected ? h(AgentAccess, { link: current.agentLink, connected: true, hardware: current.hardware === "offered" }) : null,
        current.hardwareError ? ui.ErrorLine(current.hardwareError) : null,
        current.reviewsError ? ui.ErrorLine(current.reviewsError) : null,
        current.log.length ? h(ui.Disclosure, { title: "Connection log" }, ui.Pre(current.log.join("\n"))) : null));
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
/** Black 4's mark, byte for byte from black4.ai's brand files (black4-mark-white.svg). */
export const BLACK4_MARK = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNDgiIGhlaWdodD0iMTQ1IiB2aWV3Qm94PSIwIDAgMTQ4IDE0NSIgZmlsbD0ibm9uZSI+PHBhdGggZD0iTTczLjg4NTcgMC41QzExNC40MjQgMC41MDAyMDYgMTQ3LjI3IDMyLjc0NDUgMTQ3LjI3MSA3Mi41QzE0Ny4yNzEgMTEyLjI1NiAxMTQuNDI0IDE0NC41IDczLjg4NTcgMTQ0LjVDMzMuMzQ3MiAxNDQuNSAwLjUgMTEyLjI1NiAwLjUgNzIuNUMwLjUwMDAxMyAzMi43NDQ0IDMzLjM0NzIgMC41IDczLjg4NTcgMC41WiIgZmlsbD0iI0ZCRkJGQiIgc3Ryb2tlPSIjMkQ3QTU4Ii8+PGcgZGF0YS1icmFuZC1yaW5nPSIzOCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMkQ3QTU4IiBzdHJva2Utd2lkdGg9IjEuNSIgc3Ryb2tlLWxpbmVjYXA9ImJ1dHQiPjxwYXRoIGQ9Ik0gNzEuMTU3ODEyIDYuOTEzMDMxIEEgNjYuNTQ2OTUwIDY1LjYyNDUwMCAwIDAgMSA3NS42ODgyODggNi45MTMwMzEiLz48cGF0aCBkPSJNIDgyLjEzNTYyNyA3LjQzOTg2NyBBIDY2LjU0Njk1MCA2NS42MjQ1MDAgMCAwIDEgODYuNjA0MzEzIDguMTc1MjIyIi8+PHBhdGggZD0iTSA5Mi44NzU3ODYgOS43NDEzNjAgQSA2Ni41NDY5NTAgNjUuNjI0NTAwIDAgMCAxIDk3LjE2MDc4OCAxMS4xOTIwMTIiLz48cGF0aCBkPSJNIDEwMy4wODUzMjUgMTMuNzU0NzMyIEEgNjYuNTQ2OTUwIDY1LjYyNDUwMCAwIDAgMSAxMDcuMDY5NzYwIDE1Ljg4MTExMSIvPjxwYXRoIGQ9Ik0gMTEyLjQ4NTc1NCAxOS4zNzA1MDggQSA2Ni41NDY5NTAgNjUuNjI0NTAwIDAgMCAxIDExNi4wNjA5MzYgMjIuMTE0NjEyIi8+PHBhdGggZD0iTSAxMjAuODIwNjU1IDI2LjQzNTUwNSBBIDY2LjU0Njk1MCA2NS42MjQ1MDAgMCAwIDEgMTIzLjg4OTA2MyAyOS43MjI0ODEiLz48cGF0aCBkPSJNIDEyNy44NjI2NzMgMzQuNzU3MDA3IEEgNjYuNTQ2OTUwIDY1LjYyNDUwMCAwIDAgMSAxMzAuMzQwNjA4IDM4LjQ5NzE5NiIvPjxwYXRoIGQ9Ik0gMTMzLjQxOTcxOSA0NC4xMDgwMjYgQSA2Ni41NDY5NTAgNjUuNjI0NTAwIDAgMCAxIDEzNS4yMzk1OTEgNDguMTk5NDA1Ii8+PHBhdGggZD0iTSAxMzcuMzQwMjEzIDU0LjIzMzQ5MCBBIDY2LjU0Njk1MCA2NS42MjQ1MDAgMCAwIDEgMTM4LjQ1MjM3OSA1OC41NjQ0NTciLz48cGF0aCBkPSJNIDEzOS41MTcyMTMgNjQuODU3MjA0IEEgNjYuNTQ2OTUwIDY1LjYyNDUwMCAwIDAgMSAxMzkuODkxMzM3IDY5LjMwOTYyMSIvPjxwYXRoIGQ9Ik0gMTM5Ljg5MTMzNyA3NS42ODkzNzkgQSA2Ni41NDY5NTAgNjUuNjI0NTAwIDAgMCAxIDEzOS41MTcyMTMgODAuMTQxNzk2Ii8+PHBhdGggZD0iTSAxMzguNDUyMzc5IDg2LjQzNDU0MyBBIDY2LjU0Njk1MCA2NS42MjQ1MDAgMCAwIDEgMTM3LjM0MDIxMyA5MC43NjU1MTAiLz48cGF0aCBkPSJNIDEzNS4yMzk1OTEgOTYuNzk5NTk1IEEgNjYuNTQ2OTUwIDY1LjYyNDUwMCAwIDAgMSAxMzMuNDE5NzE5IDEwMC44OTA5NzQiLz48cGF0aCBkPSJNIDEzMC4zNDA2MDggMTA2LjUwMTgwNCBBIDY2LjU0Njk1MCA2NS42MjQ1MDAgMCAwIDEgMTI3Ljg2MjY3MyAxMTAuMjQxOTkzIi8+PHBhdGggZD0iTSAxMjMuODg5MDYzIDExNS4yNzY1MTkgQSA2Ni41NDY5NTAgNjUuNjI0NTAwIDAgMCAxIDEyMC44MjA2NTUgMTE4LjU2MzQ5NSIvPjxwYXRoIGQ9Ik0gMTE2LjA2MDkzNiAxMjIuODg0Mzg4IEEgNjYuNTQ2OTUwIDY1LjYyNDUwMCAwIDAgMSAxMTIuNDg1NzU0IDEyNS42Mjg0OTIiLz48cGF0aCBkPSJNIDEwNy4wNjk3NjAgMTI5LjExNzg4OSBBIDY2LjU0Njk1MCA2NS42MjQ1MDAgMCAwIDEgMTAzLjA4NTMyNSAxMzEuMjQ0MjY4Ii8+PHBhdGggZD0iTSA5Ny4xNjA3ODggMTMzLjgwNjk4OCBBIDY2LjU0Njk1MCA2NS42MjQ1MDAgMCAwIDEgOTIuODc1Nzg2IDEzNS4yNTc2NDAiLz48cGF0aCBkPSJNIDg2LjYwNDMxMyAxMzYuODIzNzc4IEEgNjYuNTQ2OTUwIDY1LjYyNDUwMCAwIDAgMSA4Mi4xMzU2MjcgMTM3LjU1OTEzMyIvPjxwYXRoIGQ9Ik0gNzUuNjg4Mjg4IDEzOC4wODU5NjkgQSA2Ni41NDY5NTAgNjUuNjI0NTAwIDAgMCAxIDcxLjE1NzgxMiAxMzguMDg1OTY5Ii8+PHBhdGggZD0iTSA2NC43MTA0NzMgMTM3LjU1OTEzMyBBIDY2LjU0Njk1MCA2NS42MjQ1MDAgMCAwIDEgNjAuMjQxNzg3IDEzNi44MjM3NzgiLz48cGF0aCBkPSJNIDUzLjk3MDMxNCAxMzUuMjU3NjQwIEEgNjYuNTQ2OTUwIDY1LjYyNDUwMCAwIDAgMSA0OS42ODUzMTIgMTMzLjgwNjk4OCIvPjxwYXRoIGQ9Ik0gNDMuNzYwNzc1IDEzMS4yNDQyNjggQSA2Ni41NDY5NTAgNjUuNjI0NTAwIDAgMCAxIDM5Ljc3NjM0MCAxMjkuMTE3ODg5Ii8+PHBhdGggZD0iTSAzNC4zNjAzNDYgMTI1LjYyODQ5MiBBIDY2LjU0Njk1MCA2NS42MjQ1MDAgMCAwIDEgMzAuNzg1MTY0IDEyMi44ODQzODgiLz48cGF0aCBkPSJNIDI2LjAyNTQ0NSAxMTguNTYzNDk1IEEgNjYuNTQ2OTUwIDY1LjYyNDUwMCAwIDAgMSAyMi45NTcwMzcgMTE1LjI3NjUxOSIvPjxwYXRoIGQ9Ik0gMTguOTgzNDI3IDExMC4yNDE5OTMgQSA2Ni41NDY5NTAgNjUuNjI0NTAwIDAgMCAxIDE2LjUwNTQ5MiAxMDYuNTAxODA0Ii8+PHBhdGggZD0iTSAxMy40MjYzODEgMTAwLjg5MDk3NCBBIDY2LjU0Njk1MCA2NS42MjQ1MDAgMCAwIDEgMTEuNjA2NTA5IDk2Ljc5OTU5NSIvPjxwYXRoIGQ9Ik0gOS41MDU4ODcgOTAuNzY1NTEwIEEgNjYuNTQ2OTUwIDY1LjYyNDUwMCAwIDAgMSA4LjM5MzcyMSA4Ni40MzQ1NDMiLz48cGF0aCBkPSJNIDcuMzI4ODg3IDgwLjE0MTc5NiBBIDY2LjU0Njk1MCA2NS42MjQ1MDAgMCAwIDEgNi45NTQ3NjMgNzUuNjg5Mzc5Ii8+PHBhdGggZD0iTSA2Ljk1NDc2MyA2OS4zMDk2MjEgQSA2Ni41NDY5NTAgNjUuNjI0NTAwIDAgMCAxIDcuMzI4ODg3IDY0Ljg1NzIwNCIvPjxwYXRoIGQ9Ik0gOC4zOTM3MjEgNTguNTY0NDU3IEEgNjYuNTQ2OTUwIDY1LjYyNDUwMCAwIDAgMSA5LjUwNTg4NyA1NC4yMzM0OTAiLz48cGF0aCBkPSJNIDExLjYwNjUwOSA0OC4xOTk0MDUgQSA2Ni41NDY5NTAgNjUuNjI0NTAwIDAgMCAxIDEzLjQyNjM4MSA0NC4xMDgwMjYiLz48cGF0aCBkPSJNIDE2LjUwNTQ5MiAzOC40OTcxOTYgQSA2Ni41NDY5NTAgNjUuNjI0NTAwIDAgMCAxIDE4Ljk4MzQyNyAzNC43NTcwMDciLz48cGF0aCBkPSJNIDIyLjk1NzAzNyAyOS43MjI0ODEgQSA2Ni41NDY5NTAgNjUuNjI0NTAwIDAgMCAxIDI2LjAyNTQ0NSAyNi40MzU1MDUiLz48cGF0aCBkPSJNIDMwLjc4NTE2NCAyMi4xMTQ2MTIgQSA2Ni41NDY5NTAgNjUuNjI0NTAwIDAgMCAxIDM0LjM2MDM0NiAxOS4zNzA1MDgiLz48cGF0aCBkPSJNIDM5Ljc3NjM0MCAxNS44ODExMTEgQSA2Ni41NDY5NTAgNjUuNjI0NTAwIDAgMCAxIDQzLjc2MDc3NSAxMy43NTQ3MzIiLz48cGF0aCBkPSJNIDQ5LjY4NTMxMiAxMS4xOTIwMTIgQSA2Ni41NDY5NTAgNjUuNjI0NTAwIDAgMCAxIDUzLjk3MDMxNCA5Ljc0MTM2MCIvPjxwYXRoIGQ9Ik0gNjAuMjQxNzg3IDguMTc1MjIyIEEgNjYuNTQ2OTUwIDY1LjYyNDUwMCAwIDAgMSA2NC43MTA0NzMgNy40Mzk4NjciLz48L2c+PHBhdGggZD0iTTg1LjE3NjQgMTIyVjEwMi40MjVINDEuMzAxNFY3Ny45OUw3OS4yMzY0IDIzLjQ1SDk4LjEzNjRMNTcuNTAxNCA4Mi40NDVWODcuNTc1SDg1LjE3NjRWNjUuM0gxMDIuMDUxVjEyMkg4NS4xNzY0WiIgZmlsbD0iIzBEMEQwRCIvPjwvc3ZnPg==";
/** Black 4's brand blue (black4.ai's --brand), for what marks Black 4's own. */
export const BLACK4_BLUE = "#2F6FD0";

export const MACHINES = [
  { id: "commerce", label: "Commerce Mac", door: "https://black4-commerce-01.tail50b7f0.ts.net" },
];
const DEFAULT_MACHINE = "commerce";

const MACHINE_TIMEOUT_MS = 45 * 1000;
const STATUS_TIMEOUT_MS = 12 * 1000;
const STATUS_TTL_MS = 20 * 1000;
const UNREACHABLE_TTL_MS = 4 * 1000;
// The first `models` after a new Claude sign-in lists its models and proves the
// default answers, which takes the machine some seconds; then it is cached.
const MODELS_TIMEOUT_MS = 30 * 1000;
const MODELS_TTL_MS = 5 * 60 * 1000;
const MODELS_RECHECK_MS = 15 * 1000;
const LOGIN_TIMEOUT_MS = 120 * 1000; // the machine waits up to 90 s for a code, 85 s per wait for a device approval
/** Sign-in flows this plugin can show. "code": open a link, paste the code its
 * page shows. "device": open a link and approve the short code shown here;
 * the machine finishes by itself. "key": open a link to where an API key is
 * made, paste the key. A machine offers a device or key sign-in only to a
 * plugin that says it can show one. */
const SIGN_IN_FLOWS = ["code", "device", "key"];

export const HARNESSES = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "grok", label: "Grok Build" },
  { id: "qwen", label: "Qwen Code" },
  { id: "antigravity", label: "Antigravity" },
  { id: "goose", label: "Goose" },
];
/** Whom an agent answers (its Audience), as one choice: "staff", the
 * Black 4 staff (every new agent's); "business:<businessId>", staff and that
 * customer business's people (an account manager); and in Settings only,
 * "owner-only" and "anyone". The machine asks Platform Control for each
 * audience's keys (machine/agentctl, "whom an agent answers"). */
export const audienceValue = (respondTo, businessId) =>
  (respondTo === "business" && businessId ? `business:${businessId}` : typeof respondTo === "string" ? respondTo : "");

/** One line for the owner about the mentions an agent's gate dropped in the
 * last day (status's audience.unheard: { count, lastAt, lastServed,
 * waiting }), or "" when there were none. Someone it serves who was dropped
 * since its last start is heard after its next restart; anyone else is not
 * someone it answers, and the machine tells them nothing. */
export function unheardText(unheard, { time = (seconds) => new Date(seconds * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) } = {}) {
  const count = Number.isInteger(unheard?.count) && unheard.count > 0 ? unheard.count : 0;
  if (!count) return "";
  const last = Number.isFinite(unheard.lastAt) && unheard.lastAt > 0 ? `, last at ${time(unheard.lastAt)}` : "";
  const waiting = Number.isInteger(unheard.waiting) && unheard.waiting > 0 ? unheard.waiting : 0;
  return `${count} dropped in the last day${last}.${waiting ? ` ${waiting} heard after its restart.` : ""}`;
}

/** What the machine takes for an Audience choice: { respondTo, businessId,
 * access }. An agent that answers a business is customer-facing: access
 * "platform", with only the Black 4 tools; every other agent is full access. */
export function audienceSettings(value) {
  const text = String(value ?? "");
  return text.startsWith("business:")
    ? { respondTo: "business", businessId: text.slice("business:".length), access: "platform" }
    : { respondTo: text || "staff", businessId: "", access: "full" };
}

/** The businesses in a `list_businesses` answer, as { id, name }. */
export function businessesOf(answer) {
  const rows = answer?.data?.businesses ?? answer?.businesses;
  return Array.isArray(rows)
    ? rows.filter((row) => typeof row?.businessId === "string" && row.status !== "retired")
      .map((row) => ({ id: row.businessId, name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : row.businessId }))
    : [];
}

/** The Audience pill's options: Staff, then one per business; Settings adds
 * Only me and Everyone. A current choice the list lacks still shows. */
export function audienceOptions(businesses, { settings = false, current } = {}) {
  const options = [{ id: "staff", label: "Staff" }, ...(businesses ?? []).map((row) => ({ id: `business:${row.id}`, label: row.name }))];
  if (settings) options.push({ id: "owner-only", label: "Only me" }, { id: "anyone", label: "Everyone", detail: "Only for an agent that holds no business data" });
  if (current && !options.some((option) => option.id === current)) {
    options.push({ id: current, label: current.startsWith("business:") ? current.slice("business:".length) : current });
  }
  return options;
}

/** How an agent pays: "subscription" (the harness's subscription sign-in on
 * the machine) or "key" (an API key kept there). "" lets the machine settle it
 * when the agent is made: the subscription when that is signed in, else the key. */
export const PAYS = [
  { id: "subscription", label: "Subscription" },
  { id: "key", label: "API key" },
];
/** Where a device sign-in's link goes, when the harness's name would not say. */
const SIGN_IN_SITE = { qwen: "chat.qwen.ai" };

export const hardwareDefaults = () => ({
  machine: DEFAULT_MACHINE, harness: "claude", pays: "", model: "", effort: "", respondTo: "staff", businessId: "", access: "full", instructions: "", heartbeatPrompt: "",
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
      if (error?.code === "unlinked" || error?.code === "approval") throw error;
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

/** A machine that predates an op: agentctl answers "unknown op", or, for an
 * op it does not know that carries no pubkey (such as `models` on the runner
 * released before it), takes it for a one-agent op and asks for the pubkey. */
const unsupported = (error) => /unknown op|^pubkey must be 64 hex characters$/i.test(String(error?.message ?? error));

/** Shared, briefly cached `machine.status` (or another op answering
 * `harnesses`, such as `models`) per machine. `read` never rejects:
 * it resolves `{ kind: "ok", harnesses }`, `{ kind: "unsupported" }` (the
 * machine predates the op) or `{ kind: "unreachable", error }`. Concurrent
 * reads share one request. */
export function statusReader(ask, { op = "machine.status", ttlMs = STATUS_TTL_MS, ttlFor, timeoutMs = STATUS_TIMEOUT_MS, now = () => Date.now() } = {}) {
  const cache = new Map(); // machine id -> { at, status }
  const flight = new Map(); // machine id -> promise
  const listeners = new Set();
  const notify = (id) => { for (const listener of [...listeners]) listener(id); };
  const fresh = (id) => {
    const entry = cache.get(id);
    if (!entry) return undefined;
    const ttl = entry.status.kind === "unreachable" ? Math.min(ttlMs, UNREACHABLE_TTL_MS) : (ttlFor?.(entry.status) ?? ttlMs);
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
      const request = askMachine(ask, id, { op }, { timeoutMs })
        // The models reply also lists buzz-acp's conversation levers (`controls`); an older machine lists none.
        .then((reply) => ({ kind: "ok", harnesses: Array.isArray(reply.harnesses) ? reply.harnesses : [],
          ...(reply.controls && typeof reply.controls === "object" ? { controls: reply.controls } : {}) }))
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

/** How Buzz signs this harness in on the machine: "code", "device", "key", or
 * null with a one-sentence reason. A machine from before Codex and Grok
 * sign-in reports no `signIn`; there only Claude Code signs in from Buzz. */
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
 * `undefined` while loading): its subscription, or with pays "key" its API key
 * (a machine reports one under `key`; an older machine has none). */
export function signInState(status, harness, pays = "subscription") {
  if (!status) return { kind: "loading" };
  if (status.kind === "unreachable") return { kind: "unreachable", error: status.error };
  if (status.kind === "unsupported") return { kind: "unsupported" };
  const row = status.harnesses.find((entry) => entry?.id === harness);
  if (!row || row.installed === false) return { kind: "not-installed" };
  if (problemOf(row)) return { kind: "unavailable", reason: problemOf(row) };
  if (pays === "key") {
    const key = row.key && typeof row.key === "object" ? row.key : null;
    if (!key) return { kind: "unavailable", reason: `${harnessLabel(harness) ?? harness} takes no API key on this machine.` };
    if (key.signedIn === true) return { kind: "signed-in", account: typeof key.account === "string" && key.account ? key.account : null };
    return { kind: key.signedIn === false ? "signed-out" : "unknown" };
  }
  if (row.signedIn === true) return { kind: "signed-in", account: typeof row.account === "string" && row.account ? row.account : null };
  const { flow, reason } = signInOf(row);
  if (!flow) return { kind: "unavailable", reason };
  if (row.signedIn === false) return { kind: "signed-out" };
  return { kind: "unknown" };
}

/** Whether the create dialog may go ahead with this sign-in state. */
export const readyToCreate = (state) => ["signed-in", "unknown", "unsupported"].includes(state?.kind);

/** Whether this machine takes an API key for the harness (its status row has `key`). */
export const takesKey = (status, harness) => status?.kind === "ok" && !!status.harnesses.find((entry) => entry?.id === harness)?.key;

/** How a new agent would pay when nobody chooses: the machine's own rule. */
export function defaultPays(status, harness) {
  if (status?.kind !== "ok") return "subscription";
  const row = status.harnesses.find((entry) => entry?.id === harness);
  if (row?.signedIn === true) return "subscription";
  return row?.key?.signedIn === true ? "key" : "subscription";
}

/** Each machine's `models`: per harness, the models it offers ({ id, label,
 * efforts }, efforts least to most) and the default model and effort there. */
export const modelsReader = (ask, options = {}) => statusReader(ask, {
  op: "models", ttlMs: MODELS_TTL_MS, timeoutMs: MODELS_TIMEOUT_MS,
  // While the machine is still listing a harness's models, ask again soon.
  ttlFor: (status) => (status.kind === "ok" && status.harnesses.some((row) => row?.checked === false) ? MODELS_RECHECK_MS : undefined),
  ...options,
});

const EFFORT_LABELS = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" };
/** When an agent compacts its context, in tokens; "" is the harness's own default. */
export const COMPACT_OPTIONS = [50000, 100000, 150000, 250000, 500000];
const compactLabel = (tokens) => `${Math.round(tokens / 1000)}k`;

/** The effort a model runs at when none is chosen: the machine's default
 * effort if the model takes it, else the highest it takes below that. */
function defaultEffort(efforts, preferred) {
  if (efforts.includes(preferred)) return preferred;
  const order = Object.keys(EFFORT_LABELS);
  const below = efforts.filter((effort) => order.indexOf(effort) >= 0 && order.indexOf(effort) < order.indexOf(preferred));
  return below.length ? below[below.length - 1] : null;
}

/** The Model and Effort selects for one harness, or null when the machine
 * lists no models for it (an older runner, Goose, or not known yet).
 * `value.model` and `value.effort` are what the agent chose; "" is the
 * machine's default. `value.shown` and `value.shownEffort` (what a running
 * agent was started with) are shown in place of today's default for an agent
 * that chose none. A choice the machine no longer offers stays shown, as
 * unavailable, so the agent's real setting is never hidden. */
export function modelChoices(models, harness, value = {}) {
  if (models?.kind !== "ok") return null;
  const entry = models.harnesses.find((candidate) => candidate?.id === harness);
  // An agent paying by key runs on the key's listing (under `key`); the top level is the subscription's.
  const row = value.pays === "key" && entry?.key && typeof entry.key === "object" ? entry.key : entry;
  const list = (Array.isArray(row?.models) ? row.models : []).filter((entry) => typeof entry?.id === "string" && entry.id);
  if (!list.length) return null;
  const options = list.map((entry) => ({ id: entry.id, label: typeof entry.label === "string" && entry.label ? entry.label : entry.id,
    efforts: (Array.isArray(entry.efforts) ? entry.efforts : []).filter((effort) => typeof effort === "string") }));
  const defaultModel = options.some((entry) => entry.id === row.model) ? row.model : options[0].id;
  const shown = (id) => (id && options.some((entry) => entry.id === id) ? id : null);
  let model = value.model || shown(value.shown) || defaultModel;
  if (!options.some((entry) => entry.id === model)) options.unshift({ id: model, label: `${model} (unavailable)`, unavailable: true, efforts: [] });
  const efforts = options.find((entry) => entry.id === model).efforts;
  const fallback = defaultEffort(efforts, row.effort);
  let effort = value.effort || (!value.effort && value.shownEffort && efforts.includes(value.shownEffort) && model === (value.model || value.shown) ? value.shownEffort : null) || fallback;
  const effortOptions = efforts.map((id) => ({ id, label: EFFORT_LABELS[id] ?? id }));
  if (effort && !efforts.includes(effort)) effortOptions.push({ id: effort, label: `${EFFORT_LABELS[effort] ?? effort} (unavailable)`, unavailable: true });
  // Compact at: the machine says whether the harness takes it here (an older
  // machine says nothing: no choice). null is the harness's default; a new
  // agent (compactAt undefined) shows the machine's default for one.
  let compact = null;
  if (row.compact && typeof row.compact === "object") {
    const { supported, note, min = 0, max = Infinity, default: standard } = row.compact;
    const chosen = value.compactAt === null ? "" : typeof value.compactAt === "number" ? String(value.compactAt) : standard ? String(standard) : "";
    const compactOptions = [{ id: "", label: "Harness default" }, ...COMPACT_OPTIONS.filter((tokens) => tokens >= min && tokens <= max).map((tokens) => ({ id: String(tokens), label: compactLabel(tokens) }))];
    if (chosen && !compactOptions.some((entry) => entry.id === chosen)) compactOptions.push({ id: chosen, label: `${compactLabel(Number(chosen))} (unavailable)`, unavailable: true });
    compact = { value: chosen, options: compactOptions, supported: supported !== false, note: typeof note === "string" ? note : null };
  }
  return { model, effort, models: options.map(({ efforts: _, ...rest }) => rest), efforts: effortOptions, defaultModel, defaultEffort: fallback, compact };
}

/** The model and effort to store after the person picks one (`change` is
 * `{ model }` or `{ effort }`): "" for the machine's default, so the agent
 * keeps following it; an effort the new model does not take goes back to
 * that model's default. */
export function applyPick(models, harness, value, change) {
  const next = { model: value?.model ?? "", effort: value?.effort ?? "", ...change }; // what is stored, never what is shown
  const before = modelChoices(models, harness, next);
  if (!before) return { model: next.model, effort: next.effort };
  if ("model" in change && next.effort && !before.efforts.some((entry) => entry.id === next.effort && !entry.unavailable)) next.effort = "";
  const after = modelChoices(models, harness, next);
  return {
    model: after.model === after.defaultModel ? "" : after.model,
    effort: !next.effort || next.effort === after.defaultEffort ? "" : next.effort,
  };
}

/** One sign-in of a harness on a machine, as a small state machine the form
 * renders. The pasted code is passed straight to the machine and never kept
 * in state, logged or echoed back in an error. A second click while a step is
 * pending joins that step; a reply that lands after Cancel is cancelled too.
 * A device sign-in (needsCode false: Codex, Grok) shows the link and the
 * machine's short userCode, then waits by itself: login.finish with no code
 * waits on the machine for the approval and answers `pending` if it has not
 * come yet, and is asked again until it signs in, fails or is cancelled.
 * A key sign-in (flow "key": Qwen Code) shows the link to where a key is made
 * and takes the key in place of a code; a key the machine refuses leaves the
 * same sign-in open to paste again (state `flow: "key"`, no new link). */
export function createLogin(ask, machine, harness, { pays = "subscription", onChange, onSignedIn, timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
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
  const open = (mine, extra = {}) => askMachine(ask, machine, { op: "login.start", harness, pays, flows: SIGN_IN_FLOWS }, { timeoutMs })
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
      const key = needsCode && reply.flow === "key";
      set({ step: "waiting", url, needsCode, ...(key ? { flow: "key" } : {}), ...(userCode ? { userCode } : {}), ...extra });
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
      const key = state.flow === "key";
      if (state.needsCode && !pasted) { set({ ...state, error: key ? "Paste the API key first." : "Paste the code first." }); return Promise.resolve(); }
      const mine = ++generation;
      const used = loginId;
      const url = state.url;
      set({ step: "finishing", url, needsCode: state.needsCode, ...(key ? { flow: "key" } : {}), ...(state.renewed ? { renewed: true } : {}) });
      return track(askMachine(ask, machine, { op: "login.finish", loginId: used, ...(pasted ? { code: pasted } : {}) }, { timeoutMs })
        .then(async (reply) => {
          if (reply.signedIn === false) throw new Error("Sign-in did not finish.");
          if (loginId === used) loginId = null;
          if (mine !== generation) return;
          await signedIn(mine, reply);
        }, async (error) => {
          const reason = message(error, pasted);
          if (key && !/expired|cancelled/i.test(reason)) {
            // The machine keeps a key sign-in open after a refused or unchecked
            // key: the same link and id take the next paste.
            if (mine === generation) set({ step: "waiting", url, needsCode: true, flow: "key", error: reason });
            return;
          }
          // A failed finish closes that sign-in on the machine: its link and
          // id are dead. Start one fresh sign-in (once, no loop) for a new link.
          if (loginId === used) loginId = null;
          if (mine !== generation) return;
          if (key) { set({ step: "idle", error: reason }); return; }
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
            if (row?.pubkey) known.set(row.pubkey, { machine: machine.id, harness: row.harness, respondTo: audienceValue(row.respondTo, row.audience?.businessId) });
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
      directory.remember(reply.pubkey, { machine: settled.machine, harness: settled.harness, respondTo: audienceValue(settled.respondTo, settled.businessId) });
      // Conversation levers chosen in the form: provision does not take them,
      // so they follow as settings.set, which only writes before activation.
      const controls = Object.fromEntries(Object.entries(settled.controls && typeof settled.controls === "object" ? settled.controls : {})
        .filter(([, value]) => value !== null && value !== undefined && value !== ""));
      if (Object.keys(controls).length) await askMachine(ask, settled.machine, { op: "settings.set", pubkey: reply.pubkey, ...controls }, { signal });
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

/** The heartbeat: whether a hardware agent wakes on its own to run the standing
 * jobs due in Black 4, and what it does each time (agentctl heartbeat.get/.set).
 * Kept apart from hardwareProvider, whose shape is the agent type Buzz knows. */
export function heartbeatRemote(ask, directory = agentDirectory(ask)) {
  return {
    async get({ pubkey, signal }) {
      return askMachine(ask, await directory.machine(pubkey), { op: "heartbeat.get", pubkey }, { signal });
    },
    async set({ pubkey, minutes, prompt, signal }) {
      return askMachine(ask, await directory.machine(pubkey), {
        op: "heartbeat.set", pubkey, ...(minutes === undefined ? {} : { minutes }), ...(prompt === undefined ? {} : { prompt }),
      }, { signal });
    },
  };
}

/** How often a hardware agent wakes when its heartbeat is turned on. */
export const HEARTBEAT_MINUTES = 15;
/** The intervals the heartbeat select offers, in minutes (agentctl takes 5 to 1440). */
export const HEARTBEAT_CHOICES = [5, 10, 15, 30, 60, 120, 240, 480, 720, 1440];

const beatLabel = (minutes) => minutes < 60 ? `${minutes} minutes`
  : minutes === 60 ? "hour" : minutes % 60 === 0 ? `${minutes / 60} hours` : `${minutes} minutes`;

/** The heartbeat select's options for an agent waking every `current` minutes:
 * the standard intervals, plus `current` when it is set to another one. */
export function heartbeatChoices(current) {
  const minutes = Number(current) > 0 ? [...new Set([...HEARTBEAT_CHOICES, Number(current)])].sort((a, b) => a - b) : HEARTBEAT_CHOICES;
  return minutes.map((value) => ({ value, label: `every ${beatLabel(value)}` }));
}

/** The agent form's heartbeat state from agentctl's heartbeat.get or .set reply. */
export function beatFrom(reply) {
  const prompt = String(reply?.prompt ?? "");
  return { loading: false, minutes: Number(reply?.heartbeat ?? 0), base: prompt, draft: prompt,
    custom: !!reply?.custom, defaultPrompt: String(reply?.defaultPrompt ?? "") };
}

/** Sets an agent's model and effort ("" for the machine's default), how it
 * pays, when it compacts, whom it answers or a conversation lever
 * (`controls`: { name: value or null }, sent as given); the machine refuses
 * what it does not offer, and restarts a running agent on it. */
export async function setModel(ask, directory, { pubkey, model, effort, pays, compactAt, controls, signal }) {
  return askMachine(ask, await directory.machine(pubkey), { op: "settings.set", pubkey, model, effort, ...(pays ? { pays } : {}),
    ...(compactAt !== undefined ? { compactAt: compactAt === "" ? null : compactAt } : {}), ...(controls ?? {}) }, { signal });
}

/** Draw the dropdowns as the same pill over a transparent native <select> (the
 * OS menu opens) instead of Buzz's own popup. Off: the popup is Buzz's. */
export const NATIVE_SELECT = false;

// ---- buzz-ui kit: stamped from kit/buzz-ui.js by `npm run kit`; edit it there ----
// Black 4's Buzz UI kit: Buzz's own design-system primitives (Buzz 1.0.4,
// block/buzz-app `src/shared/design-system/ui`) drawn as plain elements with
// Buzz's classes, data attributes and structure, so Buzz's stylesheet paints
// them and a plugin screen looks like Buzz's own.
//
// The one place a Black 4 plugin draws a control. `npm run kit` stamps this
// file, unchanged, into every plugin that carries the kit markers (Buzz runs
// no build, so each plugin.js holds its own copy); `npm run check` refuses a
// stale copy. What it uses of Buzz is listed in kit/uses.json, which the Buzz
// canary checks every day. Rules: kit/README.md.
//
// It must run at a module's top level and inside a plugin's apply(), so it
// declares one function and nothing else.

/** Each part takes what Buzz's component takes, in Buzz's names.
 * `nativeSelect`: draw dropdowns as the pill over a native <select> (the OS
 * menu opens) instead of Buzz's popup. */
function buzzUi(React, { nativeSelect = false } = {}) {
  // Tabler icons 3.46 (chevron-down, check, loader-2): Buzz's CaretDownIcon, CheckIcon and CircleNotchIcon.
  // Tabler icons 3.46 (Buzz draws the same shapes with its own icon set).
  const ICON = { chevron: "M6 9l6 6l6 -6", check: "M5 12l5 5l10 -10", loader: "M12 3a9 9 0 1 0 9 9",
    back: ["M5 12l14 0", "M5 12l6 6", "M5 12l6 -6"],
    refresh: ["M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4", "M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"],
    decisions: ["M3.5 5.5l1.5 1.5l2.5 -2.5", "M3.5 11.5l1.5 1.5l2.5 -2.5", "M3.5 17.5l1.5 1.5l2.5 -2.5", "M11 6l9 0", "M11 12l9 0", "M11 18l9 0"],
    inbox: ["M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z", "M4 13h3l3 3h4l3 -3h3"],
    dots: ["M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0", "M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0", "M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"],
    x: ["M18 6l-12 12", "M6 6l12 12"],
    robot: ["M6 6a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2l0 -4", "M12 2v2", "M9 12v9", "M15 12v9", "M5 16l4 -2", "M15 14l4 2", "M9 18h6", "M10 8v.01", "M14 8v.01"],
    link: ["M9 15l6 -6", "M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464", "M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463"],
    // chevron-up, chevron-down, currency-dollar, users, alert-triangle, minus
    up: "M6 15l6 -6l6 6", down: "M6 9l6 6l6 -6",
    money: ["M16.7 8a3 3 0 0 0 -2.7 -2h-4a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6h-4a3 3 0 0 1 -2.7 -2", "M12 3v3m0 12v3"],
    people: ["M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0", "M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2", "M16 3.13a4 4 0 0 1 0 7.75", "M21 21v-2a4 4 0 0 0 -3 -3.85"],
    alert: ["M12 9v4", "M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z", "M12 16h.01"],
    minus: "M5 12l14 0",
    // clock (a scheduled job), message (asked in a conversation), sparkles (on its own)
    clock: ["M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0", "M12 7v5l3 3"],
    message: ["M8 9h8", "M8 13h6", "M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z"],
    sparkles: ["M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z"] };
  const h = React.createElement;
  const Fragment = React.Fragment;
  /** The variants each part takes, all ones Buzz styles (kit/uses.json
   * lists the same; the canary checks them). Anything else draws the first. */
  const VARIANTS = {
    Group: { layout: ["rows"] },
    Button: { variant: ["subtle", "prominent", "outline", "destructive", "ghost", "link"], size: ["md", "sm", "text"], shape: ["capsule", "control"] },
    Header: { level: [2, 3, 4] },
    Input: { controlSize: ["md", "sm"] },
    Stack: { gap: [4, 2, "section"] },
    Column: { gap: [4, 2] },
    Tabs: { variant: ["panel", "segmented"] },
    Avatar: { size: ["small", "compact", "tiny"] },
  };
  const one = (list, value) => (list.includes(value) ? value : list[0]);
  const icon = (path, size, props = {}) => h("svg", { xmlns: "http://www.w3.org/2000/svg", width: `${size / 16}rem`, height: `${size / 16}rem`,
    viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, ...props },
    ...(Array.isArray(path) ? path : [path]).map((d) => h("path", { key: d, d })));

  /** Header.tsx `InlineHeader`: a section's title above its card. */
  const SectionTitle = ({ title, subtitle, id }) =>
    h("div", { "data-buzz-ui": "", className: "buzz-content-header", "data-inline": "" },
      h("div", { className: "buzz-content-header-copy" },
        h("h3", { id, className: "buzz-content-header-title" }, title),
        subtitle ? h("p", { className: "buzz-content-header-subtitle" }, subtitle) : null));

  /** SettingsGroup.tsx: the rounded card. Every direct child is a row. */
  const Group = ({ layout, children }) =>
    h("div", { "data-buzz-ui": "", className: "buzz-settings-group", "data-layout": one(VARIANTS.Group.layout, layout) }, children);

  /** PreferenceRow.tsx: title and muted description left, `trailing` right
   * (an element, or a function of the aria props that name the control).
   * `controlId` makes the title a <label>, as SwitchPreferenceRow does. */
  const Row = ({ id, title, description, trailing, controlId, accessibleTitle, disabled = false, icon: leading }) => {
    const base = React.useId();
    const titleId = `${base}-title`;
    const descriptionId = description ? `${base}-description` : undefined;
    const Title = controlId ? "label" : "div";
    return h("div", { id, "data-buzz-ui": "", className: "buzz-preference-row", "data-variant": "default",
        "data-disabled": disabled || undefined, "data-has-icon": leading ? "" : undefined },
      leading ? h("span", { className: "buzz-preference-row-icon", "aria-hidden": true }, leading) : null,
      h("div", { className: "buzz-preference-row-content" },
        h(Title, { id: titleId, className: "buzz-preference-row-label", htmlFor: controlId, "aria-label": accessibleTitle }, title),
        description ? h("span", { id: descriptionId, className: "buzz-preference-row-description" }, description) : null),
      trailing == null ? null : h("div", { className: "buzz-preference-row-trailing" },
        typeof trailing === "function" ? trailing({ "aria-labelledby": titleId, "aria-describedby": descriptionId }) : trailing));
  };

  /** Button.tsx: variant prominent | subtle | outline | destructive; size sm | md;
   * shape capsule | control. `loading` hides the label under Buzz's spinner.
   * With `href` it is a link that looks the same (Buzz renders links through Button too). */
  const Button = ({ variant, size, shape, type = "button", loading = false, disabled, onClick, href, children, ...props }) => {
    const shared = { ...props, "aria-busy": loading || props["aria-busy"],
      "data-buzz-ui": "", className: "buzz-button", "data-variant": one(VARIANTS.Button.variant, variant),
      "data-size": one(VARIANTS.Button.size, size), "data-button-shape": one(VARIANTS.Button.shape, shape),
      "data-disabled": disabled || loading ? "" : undefined, "data-loading": loading || undefined };
    const body = [
      h("span", { key: "label", className: "buzz-button-label" }, children),
      loading ? icon(ICON.loader, 18, { key: "spinner", className: "buzz-button-spinner" }) : null,
    ];
    if (href) return h("a", { ...shared, href, target: "_blank", rel: "noopener noreferrer", onClick }, ...body);
    return h("button", { ...shared, type, disabled: disabled || loading,
      onClick: (event) => { if (loading || disabled) { event.preventDefault(); return; } onClick?.(event); } }, ...body);
  };

  /** Input.tsx: one line of text. `width` fixes its width (a CSS length). */
  const Input = ({ controlSize, width, ...props }) =>
    h("input", { type: "text", ...props, ...(width ? { style: { width } } : {}), "data-buzz-ui": "", "data-size": one(VARIANTS.Input.controlSize, controlSize), className: "buzz-input" });

  /** Switch.tsx without its own label: the row names it. */
  const Switch = ({ id, checked, disabled, onCheckedChange, ...aria }) =>
    h("button", { type: "button", role: "switch", id, "aria-checked": checked, ...aria, disabled,
        "data-buzz-ui": "", className: "buzz-switch-control",
        "data-checked": checked ? "" : undefined, "data-disabled": disabled ? "" : undefined,
        onClick: () => { if (!disabled) onCheckedChange(!checked); } },
      h("span", { className: "buzz-switch-thumb" }));

  /** SwitchPreferenceRow.tsx. */
  const SwitchRow = ({ id, label, description, checked, disabled, onCheckedChange }) => {
    const generated = React.useId();
    const controlId = id ?? generated;
    return h(Row, { title: label, description, controlId, disabled,
      trailing: (aria) => h(Switch, { ...aria, id: controlId, "aria-label": label, checked, disabled, onCheckedChange }) });
  };

  const chevron = () => h("span", { "aria-hidden": true }, icon(ICON.chevron, 14, { className: "buzz-dropdown-chevron" }));
  const shown = (current, placeholder) => h("span", { className: "buzz-select-value-content" },
    h("span", { className: "buzz-select-value-text" },
      h("span", { className: "buzz-select-value", title: current?.label, "data-placeholder": current ? undefined : "" }, current?.label ?? placeholder)));

  /** Select.tsx variant "compact" (shape "control": variant "preference"):
   * the closed pill is Buzz's outline sm Button inside `.buzz-select`; the open
   * menu is a listbox in Buzz's popup classes, shown through the native
   * popover attribute (the top layer, so no scroller clips it), placed under
   * the pill. Arrow keys move, Enter picks, Escape and a click outside close.
   * Options: { id, label, detail?, unavailable? } (unavailable: shown, not
   * pickable, unless it is the current one). */
  const Popup = ({ label, value, options, onChange, disabled, shape = "capsule", title, placeholder = "Choose", describedBy }) => {
    const id = React.useId();
    const [open, setOpen] = React.useState(false);
    const trigger = React.useRef(null);
    const popup = React.useRef(null);
    const current = options.find((option) => option.id === value);
    React.useLayoutEffect(() => {
      const list = popup.current;
      const at = trigger.current;
      if (!list || !at || typeof document === "undefined") return undefined;
      if (!open) { try { list.hidePopover?.(); } catch {} return undefined; }
      const gap = 4;
      list.setAttribute("data-starting-style", "");
      Object.assign(list.style, { position: "fixed", margin: "0", inset: "auto", top: "0px", left: "0px" });
      try { list.showPopover?.(); } catch {}
      // Under the pill (above it when there is more room there), within the window.
      const place = () => {
        const box = at.getBoundingClientRect();
        list.style.setProperty("--anchor-width", `${box.width}px`);
        list.style.setProperty("--available-width", `${window.innerWidth - 16}px`);
        const below = window.innerHeight - box.bottom - gap - 8;
        const above = box.top - gap - 8;
        const side = list.offsetHeight > below && above > below ? "top" : "bottom";
        list.setAttribute("data-side", side);
        list.style.setProperty("--available-height", `${Math.max(120, side === "top" ? above : below)}px`);
        list.style.setProperty("--transform-origin", side === "top" ? "bottom left" : "top left");
        const left = Math.max(8, Math.min(box.left, window.innerWidth - 8 - list.offsetWidth));
        const top = side === "top" ? Math.max(8, box.top - gap - list.offsetHeight) : box.bottom + gap;
        Object.assign(list.style, { top: `${top}px`, left: `${left}px` });
      };
      place();
      const frame = requestAnimationFrame(() => list.removeAttribute("data-starting-style"));
      (list.querySelector('[role="option"][aria-selected="true"]') ?? list.querySelector('[role="option"]:not([data-disabled])'))?.focus({ preventScroll: true });
      const away = (event) => { if (!list.contains(event.target) && !at.contains(event.target)) setOpen(false); };
      const keys = (event) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); at.focus(); } };
      document.addEventListener("pointerdown", away, true);
      document.addEventListener("keydown", keys, true);
      window.addEventListener("resize", place);
      document.addEventListener("scroll", place, true);
      return () => {
        cancelAnimationFrame(frame);
        document.removeEventListener("pointerdown", away, true);
        document.removeEventListener("keydown", keys, true);
        window.removeEventListener("resize", place);
        document.removeEventListener("scroll", place, true);
      };
    }, [open]);
    const pick = (option) => {
      if (!option || (option.unavailable && option.id !== value)) return;
      setOpen(false);
      trigger.current?.focus?.();
      if (option.id !== value) onChange(option.id);
    };
    return h("div", { "data-buzz-ui": "", className: "buzz-select text-body", "data-variant": "compact", "data-appearance": "outlined" },
      h("span", { id: `${id}-label`, className: "sr-only" }, label),
      h(Button, { ref: trigger, variant: "outline", size: "sm", shape, disabled, title,
          role: "combobox", "aria-haspopup": "listbox", "aria-expanded": open, "aria-controls": `${id}-list`, "aria-label": label,
          "aria-describedby": describedBy, "data-popup-open": open ? "" : undefined,
          onClick: () => setOpen((value) => !value),
          onKeyDown: (event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } } },
        shown(current, placeholder), chevron()),
      h("div", { ref: popup, id: `${id}-list`, role: "listbox", popover: "manual", "aria-labelledby": `${id}-label`,
          "data-buzz-ui": "", className: "buzz-select-popup text-body", "data-variant": "compact",
          onKeyDown: (event) => {
            const items = [...event.currentTarget.querySelectorAll('[role="option"]:not([data-disabled])')];
            const index = items.indexOf(document.activeElement);
            if (event.key === "ArrowDown") { event.preventDefault(); items[Math.min(index + 1, items.length - 1)]?.focus(); }
            else if (event.key === "ArrowUp") { event.preventDefault(); items[Math.max(index - 1, 0)]?.focus(); }
            else if (event.key === "Home") { event.preventDefault(); items[0]?.focus(); }
            else if (event.key === "End") { event.preventDefault(); items[items.length - 1]?.focus(); }
            else if ((event.key === "Enter" || event.key === " ") && index >= 0) { event.preventDefault(); pick(options.find((option) => option.id === items[index].dataset.value)); }
            else if (event.key === "Tab") setOpen(false);
          } },
        ...options.map((option) => {
          const selected = option.id === value;
          const unavailable = !!option.unavailable && !selected;
          return h("div", { key: option.id, role: "option", tabIndex: -1, "data-value": option.id,
              "aria-selected": selected, "aria-disabled": unavailable || undefined, "data-disabled": unavailable ? "" : undefined,
              className: "buzz-select-option", "data-selected": selected ? "" : undefined,
              onPointerMove: (event) => { if (!unavailable && document.activeElement !== event.currentTarget) event.currentTarget.focus({ preventScroll: true }); },
              onFocus: (event) => event.currentTarget.setAttribute("data-highlighted", ""),
              onBlur: (event) => event.currentTarget.removeAttribute("data-highlighted"),
              onClick: () => pick(option) },
            h("span", { className: "buzz-select-option-main" },
              h("span", { className: "buzz-select-option-content" }, option.label,
                option.detail ? h("span", { className: "buzz-select-option-description text-body-sm text-subtle" }, option.detail) : null)),
            h("span", { className: "buzz-select-indicator", "data-selected": selected ? "" : undefined },
              icon(ICON.check, 14)));
        })));
  };

  /** The same closed pill over a transparent native <select>: the OS menu
   * opens. The pill shows no hover or open state (the select takes the pointer). */
  const Native = ({ label, value, options, onChange, disabled, shape = "capsule", title, placeholder = "Choose", describedBy }) => {
    const current = options.find((option) => option.id === value);
    return h("div", { "data-buzz-ui": "", className: "buzz-select text-body", "data-variant": "compact", "data-appearance": "outlined", style: { position: "relative" } },
      h(Button, { variant: "outline", size: "sm", shape, disabled, title, tabIndex: -1, "aria-hidden": true }, shown(current, placeholder), chevron()),
      h("select", { "aria-label": label, "aria-describedby": describedBy, value, disabled, onChange: (event) => onChange(event.target.value),
          style: { position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: disabled ? "not-allowed" : "pointer", font: "inherit" } },
        ...options.map((option) => h("option", { key: option.id, value: option.id, disabled: !!option.unavailable && option.id !== value }, option.label))));
  };
  const Pill = nativeSelect ? Native : Popup;

  /** Field.tsx around Textarea.tsx (AgentInstructions): label, the text, a
   * muted description or the error. */
  const TextField = ({ label, description, error, optional = false, value, onChange, rows = 8, maxLength, placeholder, disabled, autoFocus, onKeyDown }) => {
    const id = React.useId();
    return h("div", { "data-buzz-ui": "", className: "buzz-field" },
      h("label", { className: "buzz-field-label", htmlFor: id }, label,
        optional ? h(Fragment, null, " ", h("span", { className: "buzz-field-optional" }, "Optional")) : null),
      h("textarea", { id, rows, maxLength, placeholder, value, disabled, autoFocus, onKeyDown,
        "data-buzz-ui": "", className: "buzz-textarea", "data-variant": "text", "data-surface": "inset", "data-appearance": "outlined",
        "data-invalid": error ? "" : undefined, "aria-invalid": error ? "true" : undefined,
        onChange: (event) => onChange(event.target.value) }),
      description && !error ? h("p", { className: "buzz-field-description" }, description) : null,
      error ? h("div", { className: "buzz-field-error-track" }, h("div", { role: "alert", className: "buzz-field-error" }, error)) : null);
  };

  // Layout, in the spacing Buzz's Settings screens use (Tailwind utilities
  // Buzz itself uses, so its stylesheet has them).
  const GAPS = { 2: "grid gap-2", 4: "grid gap-4", section: "grid gap-section-gap" };
  const each = (children) => (Array.isArray(children) ? children : [children]);
  /** A column of sections, cards or fields. `as: "form"` makes it the form
   * (with `onSubmit`); gap 4 between sections, 2 within a field. */
  const Stack = ({ as = "div", gap, onSubmit, children }) =>
    h(as, { className: GAPS[one(VARIANTS.Stack.gap, gap)], onSubmit, style: { gridTemplateColumns: "minmax(0, 1fr)" } }, ...each(children));
  /** Builderlab's sign-in column: lines and a button, left-aligned. */
  const Column = ({ gap, children }) =>
    h("div", { "data-buzz-ui": "", className: one(VARIANTS.Column.gap, gap) === 2 ? "flex flex-col items-start gap-2" : "flex flex-col items-start gap-4" }, ...each(children));
  /** A row of buttons that wraps. */
  const Actions = ({ children }) => h("div", { className: "flex flex-wrap items-center gap-3" }, ...each(children));

  // ---- Cards, pages and panels ------------------------------------------------

  /** Header.tsx (not inline): a settings card's or page's title, with an
   * optional eyebrow, subtitle and actions. In Settings it reads as Buzz's own
   * card titles (GitHub, Claude). */
  const Header = ({ title, subtitle, eyebrow, actions, id, level }) =>
    h("div", { "data-buzz-ui": "", className: "buzz-content-header" },
      h("div", { className: "buzz-content-header-copy" },
        eyebrow ? h("p", { className: "buzz-content-header-eyebrow" }, eyebrow) : null,
        h(`h${one(VARIANTS.Header.level, level)}`, { id, className: "buzz-content-header-title" }, title),
        subtitle ? h("p", { className: "buzz-content-header-subtitle" }, subtitle) : null),
      actions ? h("div", { className: "buzz-content-header-actions" }, ...each(actions)) : null);

  /** IconButton.tsx: a ghost icon button. `glyph` is an ICON name; `large`
   * draws the 18px artwork Buzz uses in a panel header (16px elsewhere).
   * Name it with `label`. */
  const IconButton = ({ label, glyph, large = false, disabled, onClick, ...props }) =>
    h("button", { type: "button", ...props, "aria-label": label, title: props.title ?? label, disabled,
        "data-buzz-ui": "", className: "buzz-button", "data-variant": "ghost", "data-size": "sm", "data-button-shape": "capsule",
        "data-icon-variant": "ghost", "data-icon-size": "sm", "data-icon-shape": "control", "data-disabled": disabled ? "" : undefined,
        onClick: (event) => { if (!disabled) onClick?.(event); } },
      h("span", { className: "buzz-button-label" }, icon(ICON[glyph] ?? ICON.check, large ? 18 : 16)));

  /** PanelHeader.tsx: a page's or drill-in's bar: `navigation` (a back
   * IconButton) first, the title, then `actions`. `glyph`: a dock page's own
   * title, drawn as Buzz's pages draw theirs (PanelHeaderLabel: inset, with
   * its icon), so it doesn't sit in the panel's corner. */
  const PanelHeader = ({ title, navigation, actions, glyph }) =>
    h("header", { "data-buzz-ui": "", className: "panel-header", "data-variant": "default" },
      navigation ?? null,
      h("div", { className: "panel-header-title" }, glyph
        ? h("div", { className: "panel-header-label" },
            ICON[glyph] ? h("span", { className: "panel-header-label-icon", "aria-hidden": true }, icon(ICON[glyph], 16)) : null,
            h("h2", null, title))
        : h("h2", { className: "text-label text-primary" }, title)),
      actions ? h("div", { className: "panel-header-actions" }, ...each(actions)) : null);

  /** A dock page's surface (Panel.tsx, laid out as Shared notes' page):
   * `header` (a PanelHeader) above a scrolling body. `fill`: the body has no
   * inset (an embedded browser fills it). */
  const Page = ({ label, header, fill = false, onFocus, onBlur, children }) =>
    h("section", { className: "panel", "data-buzz-surface": "", "data-shape": "panel", "aria-label": label, onFocus, onBlur },
      h("div", { "data-buzz-ui": "", style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, containerType: "inline-size" } },
        header ?? null,
        h("div", { style: fill ? { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }
            : { overflow: "auto", padding: "var(--space-4)", display: "flex", flexDirection: "column", gap: "var(--space-4)", minHeight: 0, flex: 1 } },
          ...each(children))));

  /** A drill-in inside a panel (PanelSubview): its bar stays put while the body scrolls. */
  const Subview = ({ header, footer, children }) =>
    h("div", { "data-buzz-ui": "", style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } }, header, ...each(children), footer ?? null);
  /** A panel's whole surface (a Subview's frame), which knows when it has focus. */
  const Surface = ({ label, onFocus, onBlur, children }) =>
    h("div", { "data-buzz-ui": "", role: "region", "aria-label": label, onFocus, onBlur, style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } }, ...each(children));
  /** A side panel's body: Buzz leaves the inset to the panel (as GitHub's). */
  const PanelBody = ({ fit = false, children }) =>
    h("div", { "data-buzz-ui": "", style: { padding: "var(--space-panel-inset)", overflowY: fit ? "hidden" : "auto", minHeight: 0, flex: 1, display: "flex", flexDirection: "column", gap: "var(--space-4)", color: "var(--text-standard)" } },
      ...each(children));

  /** A child that fills the rest of a `fill` page (an embedded browser). */
  const Fill = ({ children }) => h("div", { style: { flex: 1, minHeight: 0, display: "flex" } }, ...each(children));
  /** A bar above a page's body (Activity's toolbar). */
  const Toolbar = ({ children }) =>
    h("div", { "data-buzz-ui": "", style: { display: "flex", flex: "0 0 auto", minHeight: "var(--size-panel-header)", flexWrap: "wrap", alignItems: "center",
      gap: "var(--space-2)", padding: "var(--space-2) calc(var(--space-1) + var(--space-2))", borderBottom: "1px solid var(--border-standard)" } }, ...each(children));

  /** EmptyState.tsx. `frame` "none" drops the card border. */
  const EmptyState = ({ glyph, title, description, action, frame }) =>
    h("div", { "data-buzz-ui": "", className: "buzz-empty-state", "data-frame": frame === "none" ? "none" : undefined },
      h("div", { className: "buzz-empty-state-content" },
        glyph ? h("span", { className: "buzz-empty-state-icon", "aria-hidden": true }, icon(ICON[glyph], 32)) : null,
        h("div", { className: "buzz-empty-state-copy" },
          h("h3", { className: "buzz-empty-state-title" }, title),
          description ? h("p", { className: "buzz-empty-state-description" }, description) : null),
        action ? h("div", { className: "buzz-empty-state-action" }, action) : null));

  /** NavigationItem.tsx (variant row): a list row that opens something.
   * `multiline` lets the label wrap. */
  const NavItem = ({ label, trailing, selected = false, multiline = false, onClick, ...props }) =>
    h("button", { type: "button", ...props, "data-buzz-ui": "", className: "navigation-item", "data-variant": "row",
        "data-selected": selected ? "" : undefined, "aria-current": selected ? "page" : undefined, "data-multiline": multiline ? "" : undefined, onClick },
      h("span", { className: "navigation-item-label" }, label),
      trailing == null ? null : h("span", { className: "navigation-item-trailing" }, trailing));

  /** Tabs.tsx, variant "panel" size "sm": pick one of a few items. The
   * indicator is measured from the selected tab, as Base UI does. */
  const Tabs = ({ label, value, items, onChange, variant = "panel" }) => {
    const list = React.useRef(null);
    const bar = React.useRef(null);
    React.useLayoutEffect(() => {
      const place = () => {
        const tab = list.current?.querySelector?.('[role="tab"][aria-selected="true"]');
        if (!tab || !bar.current) return;
        bar.current.style.setProperty("--active-tab-left", `${tab.offsetLeft}px`);
        bar.current.style.setProperty("--active-tab-width", `${tab.offsetWidth}px`);
        bar.current.hidden = false;
      };
      place();
      const watch = typeof ResizeObserver === "function" && list.current ? new ResizeObserver(place) : null;
      watch?.observe(list.current);
      return () => watch?.disconnect();
    }, [value, items.length]);
    const keys = (event) => {
      const at = items.findIndex((item) => item.value === value);
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step || at < 0) return;
      event.preventDefault();
      const next = items[(at + step + items.length) % items.length];
      onChange(next.value);
      requestAnimationFrame?.(() => list.current?.querySelector?.('[role="tab"][aria-selected="true"]')?.focus());
    };
    return h("div", { "data-buzz-ui": "", className: "buzz-tabs", "data-variant": one(VARIANTS.Tabs.variant, variant), "data-size": "sm", "data-orientation": "horizontal" },
      h("div", { ref: list, role: "tablist", "aria-label": label, "aria-orientation": "horizontal", className: "buzz-tabs-list", "data-orientation": "horizontal", onKeyDown: keys },
        h("span", { ref: bar, className: "buzz-tabs-indicator", hidden: true }),
        ...items.map((item) => {
          const selected = item.value === value;
          return h("span", { key: item.value, className: "buzz-tabs-item" },
            h("button", { type: "button", role: "tab", className: "buzz-tabs-tab", title: item.label, "aria-selected": selected, tabIndex: selected ? 0 : -1,
                "data-selected": selected ? "" : undefined, "data-orientation": "horizontal", "data-tab-value": item.value, onClick: () => onChange(item.value) },
              h("span", null, item.label)));
        })));
  };

  /** Accordion.tsx, variant "form", one item: a section that opens. */
  const Disclosure = ({ title, children, defaultOpen = false }) => {
    const id = React.useId();
    const [open, setOpen] = React.useState(defaultOpen);
    return h("div", { "data-buzz-ui": "", className: "buzz-accordion", "data-variant": "form" },
      h("div", { className: "buzz-accordion-item" },
        h("h3", { className: "buzz-accordion-heading" },
          h("button", { type: "button", id: `${id}-trigger`, className: "buzz-accordion-trigger text-body", "aria-expanded": open, "aria-controls": `${id}-panel`,
              onClick: () => setOpen(!open) },
            h("span", null, title), icon(ICON.chevron, 14))),
        h("div", { id: `${id}-panel`, role: "region", "aria-labelledby": `${id}-trigger`, className: "buzz-accordion-panel", hidden: !open },
          open ? children : null)));
  };

  /** CountBadge.tsx: a count (99+ above 99); nothing at 0. `label` says it in words. */
  const CountBadge = ({ count, label }) => count > 0
    ? h("span", { "data-buzz-ui": "", className: "buzz-count-badge", role: "img", "aria-label": label }, count > 99 ? "99+" : String(count))
    : null;
  /** The unread dot Buzz's rows use: something waits on you, without a count. */
  const Dot = ({ label }) =>
    h("span", { role: "img", "aria-label": label, title: label, style: { display: "grid", placeItems: "center", width: "var(--space-2)", height: "var(--space-2)" } },
      h("span", { style: { width: "var(--space-2)", height: "var(--space-2)", borderRadius: "var(--radius-pill)", background: "var(--text-navigation-unread)" } }));

  /** InlineChip.tsx, an inert link chip (what a link renderer shows in a message). */
  const LinkChip = ({ label }) =>
    h("span", { "data-buzz-ui": "", className: "inline-chip", "data-kind": "link", "data-state": "resolved", role: "img", "aria-label": `Link ${label}` },
      icon(ICON.link, 16, { className: "inline-chip-icon" }),
      h("span", { className: "inline-chip-label" }, label));

  /** A one-time code to confirm elsewhere, as Pairing shows its code. */
  const OneTimeCode = ({ code, label = "Code" }) =>
    h("fieldset", { className: "m-0 w-full whitespace-nowrap rounded-xl border border-shell-edge bg-surface px-4 py-4" },
      h("legend", { className: "sr-only" }, label),
      h("span", { className: "sr-only" }, String(code).split("").join(" ")),
      h("span", { "aria-hidden": true, className: "font-mono text-title font-semibold tracking-widest" }, code));
  /** Pairing's code column: the code above its buttons. */
  const CodeColumn = ({ children }) => h("div", { className: "flex w-64 max-w-full shrink-0 flex-col gap-3" }, ...each(children));

  /** A failure with its retry (relay-staff's Failure). */
  const Failure = ({ message, retry, retryLabel = "Retry" }) =>
    h("div", { className: "flex flex-wrap items-center gap-2" },
      h("p", { role: "alert", className: "text-body-sm text-danger" }, message),
      retry ? h(Button, { size: "sm", onClick: retry }, retryLabel) : null);
  /** `.notice`: something that needs a person, not broken (a warning). */
  const Notice = ({ title, children }) =>
    h("div", { role: "status", className: "notice" }, title ? h("h3", null, title) : null, ...each(children));

  // ---- Reviews: the work, the decision and the list ------------------------------

  /** ValueChip.tsx: a short read-only value (a stake, a fact). `glyph`: an
   * ICON name for its 12px mark; `emphasis`: the label in the standard weight
   * (the stake), else the chip's own. */
  const Chip = ({ label, glyph, picture, title }) =>
    h("span", { "data-buzz-ui": "", className: "buzz-value-chip" },
      // `picture`: a product's own mark (a data URL) in place of a glyph.
      picture ? h("span", { className: "buzz-value-chip-icon", "aria-hidden": true },
        h("img", { src: picture, alt: "", width: 14, height: 14, style: { display: "block", width: "14px", height: "14px", objectFit: "contain" } }))
        : glyph && ICON[glyph] ? h("span", { className: "buzz-value-chip-icon", "aria-hidden": true }, icon(ICON[glyph], 12)) : null,
      h("span", { className: "buzz-value-chip-text", title: title ?? (typeof label === "string" ? label : undefined) }, label));
  /** Chips in a row that wraps. */
  const ChipRow = ({ children }) => h("div", { className: "flex flex-wrap items-center gap-2", style: { minWidth: 0 } }, ...each(children));

  /** Diffs' card (bundled/diffs, Diffs.module.css `.card`/`.fileHeader`):
   * the frame around a change. */
  const card = { minWidth: 0, overflow: "hidden", border: "1px solid var(--border-standard)", borderRadius: "var(--radius-control)", background: "var(--surface-panel)", color: "var(--text-standard)" };
  const cardHeader = { display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "var(--space-2) var(--space-3)", background: "var(--surface-inset)" };
  /** Diffs' insert and delete fills (`--diff-code-insert/delete-background-color`):
   * a tint on the words, never red text (red means broken). */
  const RUN = { added: { background: "var(--affordance-success)", borderRadius: "var(--space-half)", textDecoration: "none" },
    removed: { background: "var(--affordance-danger)", borderRadius: "var(--space-half)", textDecoration: "line-through" } };
  /** A word diff as Diffs draws inserted and deleted code: `runs` of
   * { kind: same | added | removed, text }, under its `label`. */
  const DiffText = ({ label, runs }) =>
    h("figure", { style: { ...card, margin: 0 } },
      label ? h("figcaption", { className: "text-caption text-subtle", style: cardHeader }, label) : null,
      h("p", { className: "m-0 text-body", style: { padding: "var(--space-3)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" } },
        ...runs.map((run, index) => run.kind === "same" ? h(Fragment, { key: index }, run.text)
          : h(Fragment, { key: index },
              h(run.kind === "added" ? "ins" : "del", { style: { ...RUN[run.kind], color: "inherit" } },
                h("span", { className: "sr-only" }, run.kind === "added" ? "Added: " : "Removed: "), run.text),
              // A removed word and its replacement read as two words.
              run.kind === "removed" && runs[index + 1]?.kind === "added" ? " " : null))));

  /** Settings before and after, in Diffs' card: each row its label, Now and
   * After; a changed row's new value carries the insert tint, an unchanged
   * row reads once, quietly. */
  const ChangeTable = ({ rows, now = "Now", after = "After" }) =>
    h("div", { "data-buzz-ui": "", role: "table", "aria-label": "Changes", style: card },
      ...rows.map((row, index) => h("div", { key: index, role: "row", style: { display: "grid", gap: "var(--space-1)", padding: "var(--space-3)", borderTop: index ? "1px solid var(--border-standard)" : undefined } },
        row.label ? h("span", { role: "rowheader", className: "text-caption text-subtle" }, row.label) : null,
        row.changed
          ? h(Fragment, null,
              h("span", { role: "cell", className: "text-body-sm text-subtle", style: { display: "grid", gridTemplateColumns: "3.5rem minmax(0, 1fr)", gap: "var(--space-2)" } },
                h("span", { className: "text-caption" }, now), h("span", { style: { overflowWrap: "anywhere" } }, row.before || "None")),
              h("span", { role: "cell", className: "text-body text-standard", style: { display: "grid", gridTemplateColumns: "3.5rem minmax(0, 1fr)", gap: "var(--space-2)" } },
                h("span", { className: "text-caption text-subtle" }, after), h("span", { style: { overflowWrap: "anywhere" } }, h("mark", { style: { ...RUN.added, color: "inherit" } }, row.after || "None"))))
          : h("span", { role: "cell", className: "text-body-sm text-subtle", style: { overflowWrap: "anywhere" } }, `Unchanged: ${row.after || row.before || "None"}`))));

  /** Before and after images, side by side in Diffs' card. `before`/`after`:
   * data URLs; `loading`: the image is still coming. */
  const MediaPair = ({ before, after, loading = false, label = "The work" }) => {
    const figure = (src, caption) => h("figure", { key: caption, style: { margin: 0, display: "grid", gap: "var(--space-1)", minWidth: 0 } },
      src ? h("img", { src, alt: `${label}: ${caption}`, style: { display: "block", width: "100%", height: "auto", borderRadius: "var(--radius-control)", background: "var(--surface-inset)" } })
        : h("div", { role: "img", "aria-label": `${caption} loading`, style: { aspectRatio: "4 / 3", borderRadius: "var(--radius-control)", background: "var(--surface-inset)" } }),
      h("figcaption", { className: "text-caption text-subtle" }, caption));
    return h("div", { "data-buzz-ui": "", "aria-busy": loading || undefined, style: { ...card, display: "grid", gridTemplateColumns: before ? "repeat(2, minmax(0, 1fr))" : "minmax(0, 1fr)", gap: "var(--space-3)", padding: "var(--space-3)" } },
      before ? figure(before, "Now") : null, figure(loading ? null : after, before ? "After" : "The new version"));
  };

  /** The bar fixed under a panel's body (Activity's toolbar border, at the
   * bottom): a `status` line, then the actions. `stacked`: a field above.
   * A long status wraps in full and scrolls past a third of the window, so
   * the actions stay on screen. */
  const DecisionBar = ({ status, stacked = false, children }) =>
    h("div", { "data-buzz-ui": "", role: "group", "aria-label": "Decision", style: { flex: "0 0 auto", display: "flex", flexDirection: stacked ? "column" : "row", flexWrap: "wrap",
        alignItems: stacked ? "stretch" : "center", justifyContent: "space-between", gap: "var(--space-2) var(--space-3)",
        padding: "var(--space-3) var(--space-panel-inset)", borderTop: "1px solid var(--border-standard)", background: "var(--surface-panel)" } },
      status ? h("div", { "aria-live": "polite", style: { minWidth: 0, flex: stacked ? undefined : "1 1 12rem", maxBlockSize: "min(16rem, 34vh)", overflowY: "auto" } }, status) : null,
      ...(children == null ? [] : [stacked ? h("div", { key: "actions", className: "grid gap-2" }, ...each(children))
        : h("div", { key: "actions", className: "flex flex-wrap items-center gap-2" }, ...each(children))]));

  /** A placeholder in the real layout while it loads (Buzz has no skeleton:
   * inset bars in the place of the lines). `layout`: item | list. */
  const Skeleton = ({ layout = "item" }) => {
    const bar = (width, height = "var(--space-3)", key) => h("span", { key, style: { display: "block", width, height, borderRadius: "var(--space-1)", background: "var(--surface-inset)" } });
    const rows = layout === "list"
      ? [0, 1, 2, 3].map((n) => h("span", { key: n, style: { display: "grid", gap: "var(--space-2)", padding: "var(--space-2) var(--space-control-inset)" } }, bar("40%", "var(--space-3)", "a"), bar(n % 2 ? "70%" : "85%", "var(--space-4)", "b")))
      : [bar("30%", "var(--space-3)", "a"), bar("80%", "var(--space-6)", "b"), h("span", { key: "c", className: "flex flex-wrap items-center gap-2" }, bar("6rem", "var(--space-5)", "c1"), bar("4rem", "var(--space-5)", "c2"), bar("5rem", "var(--space-5)", "c3")), bar("100%", "8rem", "d")];
    return h("div", { "data-buzz-ui": "", "aria-busy": true, style: { display: "grid", gap: "var(--space-4)" } }, h("span", { className: "sr-only", role: "status" }, "Loading"), ...rows);
  };

  /** Checkbox.tsx (Base UI Checkbox.Root) without its label: the row names it. */
  const Checkbox = ({ checked, onCheckedChange, label, disabled, size = "md" }) =>
    h("button", { type: "button", role: "checkbox", "aria-checked": !!checked, "aria-label": label, disabled,
        "data-buzz-ui": "", className: "buzz-checkbox", "data-size": size === "sm" ? "sm" : "md",
        "data-checked": checked ? "" : undefined, "data-disabled": disabled ? "" : undefined,
        onClick: (event) => { event.stopPropagation(); if (!disabled) onCheckedChange(!checked); } },
      checked ? h("span", { "aria-hidden": true, style: { display: "flex" } }, icon(ICON.check, size === "sm" ? 12 : 14)) : null);

  /** Activity's row (MessageListRow, NavigationItem multiline) in a
   * NavigationCard, so a Checkbox can sit beside it without nesting controls:
   * `title` (the sender's place), `subtitle` (the preview's), `meta` (the
   * date's). `picked`/`onPick`: an explicit selection; `quiet`: muted. */
  const SelectRow = ({ title, subtitle, meta, avatar, thumbnail, selected = false, picked, onPick, pickLabel, onOpen, quiet = false }) =>
    h("li", { style: { minWidth: 0, listStyle: "none" } },
      h("div", { "data-buzz-ui": "", "data-navigation-card": "", "data-tone": "default", className: "navigation-card" },
        h("div", { className: "navigation-card-row" },
          h("button", { type: "button", "data-variant": "row", "data-multiline": "", "data-buzz-ui": "", className: "navigation-item",
              "data-selected": selected ? "" : undefined, "aria-current": selected ? "true" : undefined, onClick: onOpen },
            // MessageListRow's avatar slot (`.rowAvatar`): who made it.
            avatar ? h("span", { style: { display: "grid", flex: "none", width: "var(--space-8)", height: "var(--space-8)", placeItems: "center", alignSelf: "flex-start", marginBlockStart: "var(--space-row-gap)" } }, avatar) : null,
            h("span", { className: "navigation-item-label" },
              h("span", { style: { display: "flex", flexDirection: "column", gap: "var(--space-1)", minWidth: 0, whiteSpace: "normal", paddingBlock: "var(--space-row-gap)" } },
                h("span", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "var(--space-1) var(--space-control-inset)" } },
                  h("strong", { className: `text-label-sm ${quiet ? "text-subtle" : "text-standard"}`, style: { minWidth: 0, overflowWrap: "anywhere" } }, title),
                  meta ? h("span", { className: "text-caption text-subtle", style: { flex: "0 0 auto" } }, meta) : null),
                subtitle ? h("span", { className: "text-body-sm text-subtle", style: { maxInlineSize: "64ch", overflow: "hidden", overflowWrap: "anywhere", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" } }, subtitle) : null,
                thumbnail ? h("img", { src: thumbnail, alt: "", style: { display: "block", width: "100%", maxHeight: "5rem", objectFit: "cover", objectPosition: "top", borderRadius: "var(--radius-control)", border: "1px solid var(--border-standard)" } }) : null))),
          onPick ? h("span", { style: { order: -1, flex: "none", display: "grid", placeItems: "center", paddingBlock: "calc(var(--space-row-gap) + var(--space-half))", paddingInlineStart: "var(--space-control-inset)" } },
            h(Checkbox, { checked: !!picked, onCheckedChange: onPick, label: pickLabel ?? (typeof title === "string" ? `Select ${title}` : "Select") })) : null)));

  /** A titled list of rows (Activity's list): `label` and a quiet `count`. */
  const ListGroup = ({ label, count, children }) =>
    h("section", { "data-buzz-ui": "", style: { display: "grid", gap: "var(--space-1)", minWidth: 0 } },
      label ? h("h3", { className: "text-label-sm text-subtle", style: { margin: 0, padding: "0 var(--space-control-inset)", display: "flex", gap: "var(--space-2)" } },
        h("span", null, label), count ? h("span", { className: "tabular-nums" }, String(count)) : null) : null,
      h("ul", { role: "list", style: { margin: 0, padding: 0, display: "grid", gap: "1px" } }, ...each(children)));

  /** Activity's workspace: the list pane beside the preview (Inbox.module.css
   * `.workspace`, `.listPane`, `.scroll`). Too narrow for both, the preview
   * takes the space while it shows something. */
  const Split = ({ label, list, listHeader, detail, showing = false }) => {
    const box = React.useRef(null);
    const [narrow, setNarrow] = React.useState(false);
    React.useLayoutEffect(() => {
      const node = box.current;
      if (!node || typeof ResizeObserver !== "function") return undefined;
      const watch = new ResizeObserver(() => setNarrow(node.clientWidth < 720));
      watch.observe(node);
      return () => watch.disconnect();
    }, []);
    const pane = { display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 };
    return h("div", { ref: box, "data-buzz-ui": "", style: { display: "flex", flex: 1, minWidth: 0, minHeight: 0 } },
      narrow && showing ? null : h("div", { role: "region", "aria-label": label, style: { ...pane, flex: narrow ? 1 : "0 0 min(26rem, 42%)", borderRight: narrow ? undefined : "1px solid var(--border-standard)" } },
        // `listHeader` (the list's filters) stays put while the list scrolls under it.
        listHeader ? h("div", { style: { flex: "0 0 auto", padding: "var(--space-3) var(--space-row-gap) var(--space-2)", borderBottom: "1px solid var(--border-standard)" } }, listHeader) : null,
        h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: "var(--space-3) var(--space-row-gap) var(--space-panel-inset)" } }, list)),
      narrow && !showing ? null : h("div", { style: { ...pane, flex: 1 } }, detail));
  };

  /** Avatar.tsx at a row's size: a picture, or its name's first letter.
   * `shape` squircle for an agent, circle for a person. */
  const Avatar = ({ name, picture, size = "small", shape = "circle", label }) => {
    const [failed, setFailed] = React.useState(false);
    const letter = (Array.from(String(name ?? "").trim())[0] ?? "?").toUpperCase();
    const dim = one(VARIANTS.Avatar.size, size);
    return h("span", { className: "buzz-avatar-status", "data-size": dim, "data-shape": shape === "squircle" ? "squircle" : "circle" },
      h("span", { "data-buzz-ui": "", className: "buzz-avatar", "data-size": dim, "data-avatar-shape": shape === "squircle" ? "squircle" : "circle", "data-fallback-surface": "subtle",
          role: label ? "img" : undefined, "aria-label": label, "aria-hidden": label ? undefined : true },
        picture && !failed
          ? h("img", { src: picture, alt: "", loading: "lazy", decoding: "async", referrerPolicy: "no-referrer", "data-loaded": "true", onError: () => setFailed(true) })
          : h("span", { "data-avatar-fallback": "", "aria-hidden": true }, letter)));
  };
  /** Who made something and what set it off, as Buzz writes a message's
   * author line: the maker's Avatar and name (and the app they used), then
   * the origin with its mark. `onOrigin` makes the origin open its thread. */
  const Byline = ({ avatar, name, badge, detail, origin, originGlyph, onOrigin }) =>
    h("div", { "data-buzz-ui": "", style: { display: "grid", gap: "var(--space-1)", minWidth: 0 } },
      h("div", { className: "flex flex-wrap items-center gap-2", style: { minWidth: 0 } },
        avatar ?? null,
        h("span", { className: "text-label-sm text-standard", style: { minWidth: 0, overflowWrap: "anywhere" } }, name),
        // Badge.tsx (tone success): a fact Black 4 checked, not one the agent reported.
        badge ? h("span", { "data-buzz-ui": "", className: "buzz-badge", "data-size": "xs", "data-tone": "success" }, badge) : null,
        detail ? h("span", { className: "text-caption text-subtle", style: { minWidth: 0, overflowWrap: "anywhere" } }, detail) : null),
      origin ? (onOrigin
        ? h("span", null, h(Button, { variant: "link", size: "text", onClick: onOrigin }, h(Fragment, null, originGlyph && ICON[originGlyph] ? icon(ICON[originGlyph], 12, { style: { marginInlineEnd: "var(--space-1)", verticalAlign: "-1px" } }) : null, origin)))
        : h("span", { className: "flex items-center gap-1 text-caption text-subtle" }, originGlyph && ICON[originGlyph] ? icon(ICON[originGlyph], 12) : null, origin)) : null);
  /** The work, big: a frame that takes the panel's height (Diffs' card,
   * `.preview`), with its Now / After toggle at the top. The live work area is
   * sized by the article's grid. Buzz places the native browser using its
   * measured bounds, regardless of any DOM overflow clipping. */
  const Canvas = ({ label, toolbar, fit = false, children }) =>
    h("figure", { "aria-label": label, style: { ...card, margin: 0, position: "relative", display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: fit ? 0 : "min(34rem, 64vh)" } },
      toolbar ? h("div", { style: { ...cardHeader, justifyContent: "space-between" } }, ...each(toolbar)) : null,
      h("div", { style: { flex: 1, minHeight: 0, display: "flex", alignItems: "stretch", justifyContent: "center", overflow: "auto", background: "var(--surface-inset)" } }, ...each(children)));
  /** Layers in the canvas, each filling it, the last on top (a live page over its capture). */
  const Layers = ({ children }) =>
    h("div", { style: { position: "relative", flex: 1, display: "grid", minHeight: 0 } },
      ...each(children).filter(Boolean).map((child, index) => h("div", { key: index, style: { gridArea: "1 / 1", display: "flex", minHeight: 0, overflow: "hidden" } }, child)));
  /** A picture of the work filling the canvas (an image, or the platform's capture of a page). */
  const CanvasImage = ({ src, alt }) => src
    ? h("img", { src, alt, style: { display: "block", maxWidth: "100%", maxHeight: "100%", objectFit: "contain", margin: "auto" } })
    : h("div", { role: "img", "aria-label": `${alt} loading`, "aria-busy": true, style: { flex: 1, background: "var(--surface-inset)" } });
  /** A quiet line of short values (the stake, the facts), wrapped in full:
   * the mark stays beside its first line. */
  const QuietLine = ({ glyph, children }) =>
    h("p", { className: "m-0 text-caption text-subtle", style: { display: "flex", gap: "var(--space-1)", alignItems: "baseline", minWidth: 0 } },
      glyph && ICON[glyph] ? icon(ICON[glyph], 12, { style: { flex: "none", alignSelf: "flex-start", marginBlockStart: "0.125rem" } }) : null,
      h("span", { style: { minWidth: 0, overflowWrap: "anywhere" } }, children));
  /** What approving permits, in full. */
  const Permits = (text) => h("p", { className: "m-0 text-body-sm text-standard", style: { overflowWrap: "anywhere" } }, text);
  /** The heading and details scroll within their rows when live work fills
   * the panel. The browser itself scrolls within the space between them. */
  const Article = ({ label, heading, details, fit = false, children }) =>
    h("article", { "aria-label": label, style: fit
        ? { display: "grid", gridTemplateRows: "fit-content(25%) minmax(0, 1fr) fit-content(25%)", gap: "var(--space-3)", flex: 1, minHeight: 0 }
        : { display: "flex", flexDirection: "column", gap: "var(--space-3)", flex: "1 0 auto", minHeight: "100%" } },
      fit ? h("div", { style: { overflow: "auto" } }, heading) : heading, ...each(children),
      fit ? h("div", { style: { overflow: "auto" } }, details) : details);
  /** The question, in full, the heading of the item. */
  const Question = (text) => h("h2", { className: "m-0 text-label", style: { overflowWrap: "anywhere" } }, text);

  /** The finished work as a page, in Diffs' card (`.preview`: a bounded,
   * scrolling frame) with an embedded view inside. */
  const Frame = ({ label, children }) =>
    h("div", { "data-buzz-ui": "", role: "group", "aria-label": label, style: { ...card, display: "flex", height: "min(28rem, 60vh)", minHeight: "16rem" } }, ...each(children));
  /** A message's card (Diffs' DiffMessage card): a quiet frame around rows. */
  const MessageCard = ({ label, children }) =>
    h("div", { "data-buzz-ui": "", role: "group", "aria-label": label, style: { ...card, display: "grid" } }, ...each(children));
  /** One row in a message's card: the question, its live state, Open. */
  const MessageRow = ({ title, subtitle, avatar, thumbnail, loading = false, onOpen, openLabel = "Open" }) =>
    h("div", { style: { display: "flex", alignItems: "center", gap: "var(--space-3)", padding: "var(--space-2) var(--space-3)", minWidth: 0 } },
      thumbnail ? h("img", { src: thumbnail, alt: "", style: { width: "4.5rem", height: "3.25rem", objectFit: "cover", objectPosition: "top", flex: "none", borderRadius: "var(--radius-control)", border: "1px solid var(--border-standard)" } })
        : avatar ? h("span", { style: { flex: "none", display: "grid" } }, avatar) : null,
      h("span", { style: { display: "grid", gap: "var(--space-1)", minWidth: 0, flex: 1 } },
        h("span", { className: "text-label-sm text-standard", style: { overflowWrap: "anywhere" } }, title),
        loading ? h("span", { style: { display: "block", width: "40%", height: "var(--space-3)", borderRadius: "var(--space-1)", background: "var(--surface-inset)" } })
          : subtitle ? h("span", { className: "text-caption text-subtle" }, subtitle) : null),
      onOpen ? h(Button, { size: "sm", variant: "outline", onClick: onOpen }, openLabel) : null);

  // Text, in the roles Buzz's pages write.
  const Title = (text, props = {}) => h("h2", { ...props, className: "text-heading" }, text);
  const Heading = (text) => h("h3", { className: "text-label" }, text);
  const Paragraph = (text) => h("p", { className: "m-0 text-body" }, text);
  const Caption = (text) => h("span", { className: "text-caption text-subtle" }, text);
  /** A row's emphasised line (Activity's sender). */
  const Strong = (text) => h("span", { className: "text-label-sm text-standard" }, text);
  /** Lines stacked inside a row's label. */
  const Lines = (...lines) => h("span", { className: "grid gap-1" }, ...lines);
  /** A status or alert line, as Builderlab's sign-in writes it. */
  const Line = (text, { role, id, danger = false } = {}) => h("p", { role, id, className: danger ? "m-0 text-body-sm text-danger" : "m-0 text-body-sm text-secondary" }, text);
  /** Pre-formatted text (the file viewer's). */
  const Pre = (text) => h("pre", { style: { margin: 0, fontFamily: "var(--font-mono)", fontSize: "var(--text-mono)", lineHeight: "var(--text-mono--line-height)",
    whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "18rem", overflow: "auto" } }, text);

  // ---- Agents: Buzz's Agents page (src/bundled/agents), drawn with Buzz's own
  // rules copied under the kit's names (see kit/copy.mjs) ----
  // ---- copied from Buzz by kit/copy.mjs; the canary checks it; never edit it here ----
  const COPIED_FROM = "v1.0.5";
  const COPIED = [
   {
    "file": "src/bundled/agents/AgentCard.module.css",
    "prefix": "card",
    "rules": [
     ".grid {\n  display: grid;\n  grid-template-columns: repeat(auto-fill, minmax(min(100%, 12rem), 1fr));\n  gap: var(--space-2);\n  outline: none;\n  position: relative;\n}",
     ".slot {\n  display: grid;\n  min-width: 0;\n}",
     ".card {\n  position: relative;\n  isolation: isolate;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  justify-content: center;\n  gap: var(--space-3);\n  min-width: 0;\n  min-height: 15.25rem;\n  padding: var(--space-8) var(--space-3) var(--space-4);\n  border: 1px solid transparent;\n  border-radius: var(--radius-container);\n  \n  background: var(--interaction-fill);\n  text-align: center;\n  user-select: none;\n}",
     ".agentCard {\n  --profile-backdrop-mask: linear-gradient(to bottom, black, 25%, transparent);\n  --profile-backdrop-filter: blur(40px) saturate(4);\n  --profile-backdrop-scale: 2;\n  --profile-backdrop-opacity: 0.64;\n  \n  --profile-backdrop-duration: 0s;\n  gap: var(--space-6);\n  border: 0;\n  justify-content: flex-end;\n  padding: calc(var(--space-8) * 2 + var(--space-2)) var(--space-6)\n    var(--space-6);\n}",
     ".identity {\n  position: relative;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: var(--space-2);\n  min-width: 0;\n  max-width: 100%;\n}",
     ".card:is([role=\"option\"], [role=\"gridcell\"]) {\n  cursor: pointer;\n}",
     ".card:is([aria-selected=\"true\"], [data-selected=\"true\"]) {\n  border-color: var(--border-prominent);\n  box-shadow: var(--shadow-sm);\n}",
     ".agentCard:is([aria-selected=\"true\"], [data-selected=\"true\"]) {\n  --profile-backdrop-opacity: 0.76;\n  box-shadow:\n    inset 0 0 0 1px var(--border-prominent),\n    var(--shadow-sm);\n}",
     "@media (forced-colors: active) {\n.agentCard:is([aria-selected=\"true\"], [data-selected=\"true\"]) {\n    outline: 2px solid Highlight;\n    outline-offset: -2px;\n  }\n}",
     "html[data-keyboard-navigation] .card:focus-visible {\n  outline: 2px solid var(--border-focus);\n  outline-offset: 2px;\n}",
     ".portrait {\n  display: grid;\n  place-items: center;\n  flex-shrink: 0;\n  width: clamp(4rem, 16cqw, 8rem);\n  height: clamp(4rem, 16cqw, 8rem);\n}",
     ".portrait > [class~=\"buzz-avatar-status\"] {\n  width: 75%;\n  height: 75%;\n}",
     ".card[data-unavailable] .portrait {\n  opacity: 0.5;\n}",
     ".portrait > :is(img, video) {\n  width: 100%;\n  height: 100%;\n  object-fit: contain;\n}",
     ".name {\n  \n  margin-block: calc(-1 * var(--space-2)) var(--space-2);\n  max-width: 100%;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}",
     ".identity .name {\n  margin-block: 0;\n}",
     ".agentCard .portrait:has(> [class~=\"buzz-avatar-status\"]) {\n  width: clamp(3rem, 12cqw, 6rem);\n  height: clamp(3rem, 12cqw, 6rem);\n}",
     ".agentCard .portrait > [class~=\"buzz-avatar-status\"] {\n  width: 100%;\n  height: 100%;\n}",
     ".detail {\n  display: flex;\n  align-items: center;\n  gap: var(--space-1);\n  max-width: 100%;\n  color: var(--text-secondary);\n  font-size: var(--text-body-sm-size, 0.8125rem);\n}",
     ".agentCard .detail {\n  min-height: var(--space-6);\n}",
     ".detailText {\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}",
     ".actions {\n  --interaction-fill: var(--interaction-selected);\n  --interaction-hover: var(--interaction-pressed);\n  max-width: 100%;\n  display: flex;\n  flex-wrap: wrap;\n  justify-content: center;\n  gap: var(--space-2);\n}",
     "@media (max-width: 560px) {\n.grid {\n    grid-template-columns: repeat(2, minmax(0, 1fr));\n  }\n}",
     "@media (max-width: 360px) {\n.grid {\n    grid-template-columns: minmax(0, 1fr);\n  }\n}",
     ".menu {\n  position: absolute;\n  top: var(--space-2);\n  right: var(--space-2);\n}",
     ".bestie {\n  position: absolute;\n  top: var(--space-2);\n  left: var(--space-2);\n  pointer-events: none;\n}"
    ]
   },
   {
    "file": "src/bundled/agents/AgentsPage.module.css",
    "prefix": "page",
    "rules": [
     ".browse {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr);\n  height: 100%;\n  min-height: 0;\n}",
     ".browse[data-side] {\n  grid-template-columns: minmax(0, 1fr) minmax(\n      20rem,\n      var(--secondary-panel-width, 28rem)\n    );\n}",
     ".main {\n  container-type: inline-size;\n  min-width: 0;\n  min-height: 0;\n}",
     ".inventory {\n  height: 100%;\n  min-height: 0;\n  overflow: auto;\n}",
     ".side {\n  position: relative;\n  border-inline-start: 1px solid var(--border-standard);\n  min-height: 0;\n  min-width: 0;\n}",
     ".build {\n  position: relative;\n  display: flex;\n  flex-direction: column;\n  height: 100%;\n  min-height: 0;\n  min-width: 0;\n}",
     ".detailsScroll {\n  --profile-content-inset: var(--space-5);\n  --agent-footer-height: 0px;\n  flex: 1;\n  min-height: 0;\n  overflow: auto;\n  display: flex;\n  flex-direction: column;\n  gap: var(--space-4);\n  padding: var(--space-5) var(--profile-content-inset);\n  padding-block-end: calc(var(--space-5) + var(--agent-footer-height));\n  scroll-padding-block-end: calc(var(--space-5) + var(--agent-footer-height));\n}",
     "@media (max-width: 30rem) {\n.detailsScroll {\n    --profile-content-inset: var(--space-2);\n  }\n}",
     ".identityPortrait {\n  position: relative;\n  width: min(8rem, 100%);\n  aspect-ratio: 1;\n}",
     ".identityCard > :is([aria-hidden=\"true\"], .identityPortrait) {\n  filter: grayscale(var(--agent-artwork-grayscale, 0));\n}",
     ".identityCard > .identityPortrait {\n  filter: grayscale(var(--agent-artwork-grayscale, 0))\n    blur(var(--agent-artwork-blur, 0px));\n  \n  scale: var(--agent-artwork-scale, 1);\n  opacity: var(--agent-artwork-opacity, 1);\n}",
     ".work {\n  min-width: 0;\n}",
     "@media (max-width: 52rem) {\n.browse[data-side] {\n    grid-template-columns: minmax(0, 1fr);\n  }\n.side {\n    border-inline-start: 0;\n  }\n}",
     "@media (prefers-reduced-motion: reduce) {\n.side {\n    animation: none;\n  }\n}",
     ".content {\n  display: flex;\n  flex-direction: column;\n  gap: var(--space-6);\n  width: 100%;\n  max-width: 48rem;\n  margin-inline: auto;\n  padding: clamp(var(--space-4), 6vh, calc(var(--space-16) + var(--space-4)))\n    var(--space-6) var(--space-8);\n}",
     ".nameActions {\n  display: grid;\n  grid-template-columns: repeat(2, minmax(0, 1fr));\n  gap: var(--space-2);\n  width: 12rem;\n  max-width: 100%;\n}",
     ".identityName {\n  position: relative;\n  width: 100%;\n}",
     ".nameEditor {\n  position: absolute;\n  inset: 0;\n  display: flex;\n  align-items: center;\n  text-align: center;\n}"
    ]
   },
   {
    "file": "src/features/profiles/ProfileHero.module.css",
    "prefix": "hero",
    "rules": [
     ".hero {\n  --profile-backdrop-mask: linear-gradient(to bottom, black, 25%, transparent);\n  position: relative;\n  isolation: isolate;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: var(--space-4);\n  min-width: 0;\n  padding: calc(var(--space-8) + var(--space-4)) var(--space-4);\n  border-radius: var(--radius-container);\n  background: var(--surface-panel);\n}",
     ".actions {\n  --interaction-fill: var(--interaction-selected);\n  --interaction-hover: var(--interaction-pressed);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  flex-wrap: wrap;\n  gap: var(--space-2);\n}",
     ".avatarBackdrop {\n  position: absolute;\n  inset: 0;\n  z-index: -1;\n  overflow: hidden;\n  border-radius: inherit;\n  pointer-events: none;\n  mask-image: var(--profile-backdrop-mask, none);\n}",
     ".avatarBackdropImage {\n  width: 100%;\n  height: 100%;\n  background-size: cover;\n  background-position: center;\n  filter: var(\n    --profile-backdrop-filter,\n    blur(var(--profile-backdrop-blur, 40px))\n      saturate(var(--profile-backdrop-saturation, 4))\n  );\n  transform: scale(var(--profile-backdrop-scale, 2));\n  opacity: var(--profile-backdrop-opacity, 0.64);\n  transition:\n    opacity var(--profile-backdrop-duration, 0s) var(--easing-state),\n    transform var(--profile-backdrop-duration, 0s) var(--easing-enter);\n}",
     "@media (prefers-reduced-transparency: reduce), (forced-colors: active) {\n.avatarBackdrop {\n    display: none;\n  }\n}",
     ".panelHero {\n  margin-inline: calc(\n    var(--space-1) -\n    var(--profile-content-inset, var(--space-5))\n  );\n}",
     ".panelHero:first-child {\n  margin-top: calc(var(--space-1) - var(--space-5));\n}",
     ".hero :is(h2, h3) {\n  text-wrap: balance;\n}"
    ]
   },
   {
    "file": "src/features/panels/Panels.module.css",
    "prefix": "panels",
    "rules": [
     ".workspace {\n  background: var(--surface-panel);\n  display: flex;\n  flex-direction: column;\n  min-width: 0;\n  min-height: 0;\n  height: 100%;\n}",
     ".workspace > header {\n  flex-wrap: nowrap;\n  flex-shrink: 0;\n}",
     ".workspaceBody {\n  display: grid;\n  flex: 1;\n  min-height: 0;\n  min-width: 0;\n}",
     ".workspacePane {\n  display: grid;\n  grid-area: 1 / 1;\n  min-height: 0;\n  min-width: 0;\n}",
     ".workspaceBody {\n  --workspace-push-duration: 300ms;\n  --workspace-push-easing: cubic-bezier(0.2, 0, 0, 1);\n}"
    ]
   }
  ];
  const AVATARS = [{"id":"buzzies-1","label":"Buzzies 1","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-1.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-1.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-1.mp4"},
    {"id":"buzzies-2","label":"Buzzies 2","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-2.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-2.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-2.mp4"},
    {"id":"buzzies-3","label":"Buzzies 3","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-3.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-3.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-3.mp4"},
    {"id":"buzzies-4","label":"Buzzies 4","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-4.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-4.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-4.mp4"},
    {"id":"buzzies-5","label":"Buzzies 5","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-5.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-5.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-5.mp4"},
    {"id":"buzzies-6","label":"Buzzies 6","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-6.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-6.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-6.mp4"},
    {"id":"buzzies-7","label":"Buzzies 7","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-7.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-7.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-7.mp4"},
    {"id":"buzzies-8","label":"Buzzies 8","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-8.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-8.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-8.mp4"},
    {"id":"buzzies-9","label":"Buzzies 9","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-9.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-9.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-9.mp4"},
    {"id":"buzzies-10","label":"Buzzies 10","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-10.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-10.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-10.mp4"},
    {"id":"buzzies-11","label":"Buzzies 11","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-11.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-11.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-11.mp4"},
    {"id":"buzzies-12","label":"Buzzies 12","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-12.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-12.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-12.mp4"},
    {"id":"buzzies-13","label":"Buzzies 13","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-13.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-13.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-13.mp4"},
    {"id":"buzzies-14","label":"Buzzies 14","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-14.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-14.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-14.mp4"},
    {"id":"buzzies-15","label":"Buzzies 15","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-15.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-15.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-15.mp4"},
    {"id":"buzzies-16","label":"Buzzies 16","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-16.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-16.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-16.mp4"},
    {"id":"buzzies-17","label":"Buzzies 17","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-17.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-17.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-17.mp4"},
    {"id":"buzzies-18","label":"Buzzies 18","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-18.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-18.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-18.mp4"},
    {"id":"buzzies-19","label":"Buzzies 19","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-19.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-19.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-19.mp4"},
    {"id":"buzzies-20","label":"Buzzies 20","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-20.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-20.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-20.mp4"},
    {"id":"buzzies-21","label":"Buzzies 21","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-21.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-21.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-21.mp4"},
    {"id":"buzzies-22","label":"Buzzies 22","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-22.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-22.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-22.mp4"},
    {"id":"buzzies-23","label":"Buzzies 23","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-23.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-23.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-23.mp4"},
    {"id":"buzzies-24","label":"Buzzies 24","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-24.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-24.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-24.mp4"},
    {"id":"buzzies-25","label":"Buzzies 25","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-25.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-25.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-25.mp4"},
    {"id":"buzzies-26","label":"Buzzies 26","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-26.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-26.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-26.mp4"},
    {"id":"buzzies-27","label":"Buzzies 27","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-27.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-27.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-27.mp4"},
    {"id":"buzzies-28","label":"Buzzies 28","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-28.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-28.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-28.mp4"},
    {"id":"buzzies-32","label":"Buzzies 32","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-32.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-32.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-32.mp4"},
    {"id":"buzzies-33","label":"Buzzies 33","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-33.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-33.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-33.mp4"},
    {"id":"fuzzies-1","label":"Fuzzies 1","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-1.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-1.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-1.mp4"},
    {"id":"fuzzies-2","label":"Fuzzies 2","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-2.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-2.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-2.mp4"},
    {"id":"fuzzies-3","label":"Fuzzies 3","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-3.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-3.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-3.mp4"},
    {"id":"fuzzies-4","label":"Fuzzies 4","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-4.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-4.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-4.mp4"},
    {"id":"fuzzies-5","label":"Fuzzies 5","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-5.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-5.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-5.mp4"},
    {"id":"fuzzies-6","label":"Fuzzies 6","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-6.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-6.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-6.mp4"},
    {"id":"fuzzies-7","label":"Fuzzies 7","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-7.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-7.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-7.mp4"},
    {"id":"fuzzies-8","label":"Fuzzies 8","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-8.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-8.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-8.mp4"},
    {"id":"fuzzies-9","label":"Fuzzies 9","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-9.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-9.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-9.mp4"},
    {"id":"fuzzies-10","label":"Fuzzies 10","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-10.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-10.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-10.mp4"},
    {"id":"fuzzies-11","label":"Fuzzies 11","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-11.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-11.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-11.mp4"},
    {"id":"fuzzies-12","label":"Fuzzies 12","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-12.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-12.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-12.mp4"},
    {"id":"fuzzies-13","label":"Fuzzies 13","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-13.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-13.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-13.mp4"},
    {"id":"fuzzies-14","label":"Fuzzies 14","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-14.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-14.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-14.mp4"},
    {"id":"fuzzies-15","label":"Fuzzies 15","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-15.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-15.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-15.mp4"},
    {"id":"fuzzies-16","label":"Fuzzies 16","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-16.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-16.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-16.mp4"},
    {"id":"fuzzies-17","label":"Fuzzies 17","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-17.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-17.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-17.mp4"},
    {"id":"fuzzies-18","label":"Fuzzies 18","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-18.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-18.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-18.mp4"},
    {"id":"fuzzies-19","label":"Fuzzies 19","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-19.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-19.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-19.mp4"},
    {"id":"gloopies-1","label":"Gloopies 1","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-1.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-1.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-1.mp4"},
    {"id":"gloopies-2","label":"Gloopies 2","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-2.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-2.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-2.mp4"},
    {"id":"gloopies-3","label":"Gloopies 3","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-3.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-3.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-3.mp4"},
    {"id":"gloopies-4","label":"Gloopies 4","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-4.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-4.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-4.mp4"},
    {"id":"gloopies-5","label":"Gloopies 5","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-5.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-5.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-5.mp4"},
    {"id":"gloopies-6","label":"Gloopies 6","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-6.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-6.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-6.mp4"},
    {"id":"gloopies-7","label":"Gloopies 7","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-7.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-7.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-7.mp4"},
    {"id":"gloopies-8","label":"Gloopies 8","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-8.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-8.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-8.mp4"},
    {"id":"gloopies-9","label":"Gloopies 9","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-9.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-9.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-9.mp4"},
    {"id":"gloopies-10","label":"Gloopies 10","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-10.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-10.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-10.mp4"},
    {"id":"gloopies-11","label":"Gloopies 11","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-11.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-11.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-11.mp4"},
    {"id":"gloopies-12","label":"Gloopies 12","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-12.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-12.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-12.mp4"},
    {"id":"gloopies-13","label":"Gloopies 13","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-13.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-13.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-13.mp4"},
    {"id":"gloopies-14","label":"Gloopies 14","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-14.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-14.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-14.mp4"},
    {"id":"gloopies-15","label":"Gloopies 15","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-15.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-15.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-15.mp4"},
    {"id":"gloopies-16","label":"Gloopies 16","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-16.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-16.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-16.mp4"},
    {"id":"gloopies-17","label":"Gloopies 17","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-17.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-17.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-17.mp4"},
    {"id":"gloopies-18","label":"Gloopies 18","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-18.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-18.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-18.mp4"},
    {"id":"gloopies-19","label":"Gloopies 19","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-19.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-19.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-19.mp4"},
    {"id":"gloopies-20","label":"Gloopies 20","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-20.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-20.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-20.mp4"},
    {"id":"gloopies-21","label":"Gloopies 21","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-21.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-21.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-21.mp4"},
    {"id":"gloopies-22","label":"Gloopies 22","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-22.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-22.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-22.mp4"},
    {"id":"gloopies-23","label":"Gloopies 23","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-23.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-23.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-23.mp4"},
    {"id":"pollies-2","label":"Figgies 2","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/pollies/pollies-2.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/pollies/pollies-2.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/pollies/pollies-2.mp4"},
    {"id":"pollies-9","label":"Figgies 9","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/pollies/pollies-9.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/pollies/pollies-9.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/pollies/pollies-9.mp4"},
    {"id":"pollies-10","label":"Figgies 10","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/pollies/pollies-10.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/pollies/pollies-10.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/pollies/pollies-10.mp4"},
    {"id":"pollies-21","label":"Figgies 21","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/pollies/pollies-21.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/pollies/pollies-21.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/pollies/pollies-21.mp4"},
    {"id":"pollies-23","label":"Figgies 23","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/pollies/pollies-23.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/pollies/pollies-23.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/pollies/pollies-23.mp4"},
    {"id":"pollies-24","label":"Figgies 24","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/pollies/pollies-24.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/pollies/pollies-24.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/pollies/pollies-24.mp4"},
    {"id":"pollies-25","label":"Figgies 25","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/pollies/pollies-25.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/pollies/pollies-25.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/pollies/pollies-25.mp4"}];
  // ---- end copied from Buzz ----
  /** The kit's name for a copied Buzz class: `copied("card", "agentCard")`. */
  const copied = (prefix, ...names) => names.map((name) => `b4copy-${prefix}-${name}`).join(" ");
  const renameSelectors = (prefix, selectors) => selectors.replace(/\.([a-zA-Z][\w-]*)/g, (match, name) => (name.startsWith("buzz") ? match : `.${copied(prefix, name)}`));
  const renameRule = (prefix, rule) => (rule.startsWith("@")
    ? rule.replace(/^([^{]*\{)([\s\S]*)\}$/, (match, head, body) => head + body.replace(/(^|\})([^{}]+)\{/g, (inner, end, selectors) => end + renameSelectors(prefix, selectors) + "{") + "}")
    : rule.replace(/^[^{]+/, (selectors) => renameSelectors(prefix, selectors)));
  const COPIED_CSS = COPIED.map((file) => file.rules.map((rule) => renameRule(file.prefix, rule)).join("\n")).join("\n");
  /** The copied rules, once per page that draws agent parts. */
  const CopiedStyles = () => h("style", null, COPIED_CSS);

  const appleWebKit = () => typeof navigator !== "undefined" && /^(Mac|iPhone|iPad|iPod)/.test(navigator.platform ?? "")
    && /AppleWebKit/.test(navigator.userAgent ?? "") && !/Chrome|Chromium|Edg/.test(navigator.userAgent ?? "");
  const stillMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** Buzz's avatar pack for a picture (its poster URL), if it is one. */
  const packOf = (picture) => AVATARS.find((avatar) => avatar.url === String(picture ?? "").split("#", 1)[0]);

  /** Avatar.tsx, size "fill", squircle: a picture, or its name's first letter. */
  const AvatarImage = ({ name, picture }) => {
    const [failed, setFailed] = React.useState(false);
    const letter = (Array.from(String(name ?? "").trim())[0] ?? "?").toUpperCase();
    return h("span", { className: "buzz-avatar-status", "data-size": "fill", "data-shape": "squircle" },
      h("span", { "data-buzz-ui": "", className: "buzz-avatar", "data-size": "fill", "data-avatar-shape": "squircle", "data-fallback-surface": "subtle", "aria-hidden": true },
        picture && !failed
          ? h("img", { src: picture, alt: "", loading: "lazy", decoding: "async", referrerPolicy: "no-referrer", "data-loaded": "true", onError: () => setFailed(true) })
          : h("span", { "data-avatar-fallback": "", "aria-hidden": true }, letter)));
  };
  /** AgentPortrait: a pack avatar plays its animation (PackedAgentAvatar),
   * any other picture shows still. `cover` fills a backdrop. */
  const AgentPortrait = ({ name, picture, cover = false }) => {
    const pack = packOf(picture);
    if (!pack) return h(AvatarImage, { name, picture });
    const fit = { width: "100%", height: "100%", objectFit: cover ? "cover" : "contain" };
    if (!pack.webm || stillMotion()) return h("img", { src: pack.url, alt: cover ? "" : pack.label, style: fit });
    const sources = [h("source", { key: "webm", type: "video/webm", src: pack.webm })];
    if (pack.hevc) sources[appleWebKit() ? "unshift" : "push"](h("source", { key: "hevc", type: 'video/mp4; codecs="hvc1"', src: pack.hevc }));
    return h("video", { className: "agent-packed-video", loop: true, playsInline: true, autoPlay: true, preload: "auto", poster: pack.url,
      "aria-label": cover ? undefined : pack.label, style: fit,
      ref: (video) => { if (video) { video.muted = true; video.play?.()?.catch?.(() => {}); } } }, ...sources);
  };
  /** ProfileBackdrop: the picture, blurred, behind a card or the profile. */
  const Backdrop = ({ name, picture }) => {
    if (!picture) return null;
    const pack = packOf(picture);
    return h("div", { className: copied("hero", "avatarBackdrop"), "aria-hidden": true },
      pack && pack.webm && !stillMotion()
        ? h("div", { className: copied("hero", "avatarBackdropImage") }, h(AgentPortrait, { name, picture, cover: true }))
        : h("div", { className: copied("hero", "avatarBackdropImage"), style: { backgroundImage: `url("${pack ? pack.url : picture}")` } }));
  };

  /** A navigation tab in a panel header (Tabs variant "navigation"): the
   * page's own title (`main`), or a closable tab for what is open beside it. */
  const HeaderTab = ({ label, art, main = false, onClose }) =>
    h("div", { "data-buzz-ui": "", className: "buzz-tabs", "data-variant": "navigation", "data-size": "md", "data-orientation": "horizontal" },
      h("div", { role: "tablist", "aria-label": main ? `${label} header` : "Panel tabs", className: "buzz-tabs-list", "data-orientation": "horizontal" },
        h("span", { className: "buzz-tabs-item", "data-closable": onClose ? "" : undefined },
          h("button", { type: "button", role: "tab", "aria-selected": true, "data-selected": main ? undefined : "", title: label,
              "data-buzz-ui": "", className: "navigation-item", "data-variant": "row" },
            art ? h("span", { className: "buzz-tabs-icon", "aria-hidden": true }, art) : null,
            h("span", { className: "navigation-item-label" }, label)),
          onClose ? h("button", { type: "button", "aria-label": `Close ${label} tab`, title: `Close ${label} tab`, onClick: onClose,
              "data-buzz-ui": "", className: "buzz-button", "data-variant": "ghost", "data-size": "sm", "data-button-shape": "capsule",
              "data-icon-variant": "ghost", "data-icon-size": "xs", "data-icon-shape": "control" },
            h("span", { className: "buzz-button-label" }, icon(ICON.x, 16))) : null)));

  /** The Agents page (AgentsPage.tsx): the page's header tab, a centred
   * column with `tabs` (and `action` beside them) over the content, and
   * `side` (an AgentPanel) beside it when something is open. */
  const AgentBrowse = ({ label, art, tabs, action, side, children }) =>
    h("div", { className: "h-full min-h-0" },
      h(CopiedStyles),
      h("div", { className: copied("page", "browse"), "data-side": side ? "" : undefined },
        h("div", { className: copied("page", "main") },
          h("section", { className: "panel", "data-buzz-surface": "", "data-shape": "panel", "aria-label": label },
            h("div", { className: "flex h-full min-h-0 flex-col" },
              h("header", { "data-buzz-ui": "", className: "panel-header", "data-variant": "default" },
                h("div", { className: "panel-header-title" }, h(HeaderTab, { label, art, main: true }))),
              h("div", { className: "min-h-0 flex-1" },
                h("div", { className: copied("page", "inventory") },
                  h("div", { className: copied("page", "content") },
                    tabs || action ? h("div", { className: "flex flex-wrap items-center justify-between gap-3" }, tabs ?? null, action ?? null) : null,
                    ...each(children))))))),
        side ?? null));

  /** The card grid (role grid). */
  const AgentGrid = ({ label, busy = false, children }) =>
    h("div", { className: copied("card", "grid") },
      h("div", { role: "grid", "aria-label": label, "aria-busy": busy || undefined, className: "contents" }, ...each(children)));

  /** AgentCard.tsx: the portrait large, the name, one line about it
   * (`detail`, after `art`); `badge` top left (where Buzz marks a Bestie),
   * `menu` top right. */
  const AgentCard = ({ name, picture, detail, art, badge, menu, selected = false, unavailable = false, onSelect, onOpen }) =>
    h("div", { role: "row", className: copied("card", "slot") },
      h("div", { role: "gridcell", "aria-label": name, "aria-selected": selected, "data-selected": String(selected), tabIndex: 0,
          "data-unavailable": unavailable ? "" : undefined, className: copied("card", "card", "agentCard"),
          onClick: (event) => { if (!event.target.closest?.("[data-card-control], button, input")) onSelect?.(); },
          onDoubleClick: () => onOpen?.(),
          onKeyDown: (event) => { if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); (onOpen ?? onSelect)?.(); } } },
        h(Backdrop, { name, picture }),
        badge ? h("span", { className: copied("card", "bestie") }, badge) : null,
        menu ? h("div", { className: copied("card", "menu") }, menu) : null,
        h("span", { className: copied("card", "portrait"), "aria-hidden": true }, h(AgentPortrait, { name, picture })),
        h("span", { className: copied("card", "identity") },
          h("span", { className: `${copied("card", "name")} text-label` }, name),
          detail ? h("span", { className: copied("card", "detail") }, art ?? null, h("span", { className: copied("card", "detailText") }, detail)) : null)));

  /** A picture (a logo) at a glyph's size, for a tab icon or a card's mark. */
  const Picture = ({ src, size = 16 }) => h("img", { src, alt: "", width: size, height: size, style: { display: "block" } });
  /** One of the kit's ICONs at Buzz's glyph size. */
  const Glyph = ({ name, size = 16 }) => icon(ICON[name] ?? ICON.check, size);

  /** A mark on a card, drawn as Buzz draws its Bestie mark (a glass-clear
   * button shape): `art` (16px) and a word, in `color`. */
  const CardMark = ({ art, label, color }) =>
    h("span", { "data-buzz-ui": "", className: "buzz-button", "data-variant": "glass-clear", "data-size": "sm", "data-button-shape": "capsule", "aria-hidden": true },
      h("span", { className: "buzz-button-label", style: color ? { color } : undefined }, art ?? null, label));

  /** The open agent beside the grid: a Panel whose header is one closable
   * tab with the agent's portrait (PanelWorkspace). */
  const AgentPanel = ({ name, picture, onClose, children }) =>
    h("aside", { className: copied("page", "side"), onKeyDown: (event) => { if (event.key === "Escape" && !event.defaultPrevented) onClose?.(); } },
      h("section", { className: "panel", "data-buzz-surface": "", "data-shape": "panel", "aria-label": "Agent profile" },
        h("div", { className: copied("panels", "workspace") },
          h("header", { "data-buzz-ui": "", className: "panel-header", "data-variant": "default" },
            h("div", { className: "panel-header-title" },
              h(HeaderTab, { label: name, onClose, art: h("span", { className: "block h-full w-full" }, h(AgentPortrait, { name, picture })) }))),
          h("div", { className: copied("panels", "workspaceBody") },
            h("div", { role: "tabpanel", className: copied("panels", "workspacePane") }, ...each(children))))));

  /** AgentDetails.tsx: the hero (backdrop, portrait, name, `under` it,
   * `actions`), then the agent's sections. `editing` replaces the name with
   * its editor. */
  const AgentProfile = ({ name, picture, under, actions, editing, children }) =>
    h("div", { className: copied("page", "build") },
      h("div", { className: copied("page", "detailsScroll") },
        h("aside", { "aria-label": `${name} identity`, className: `${copied("hero", "hero", "panelHero")} ${copied("page", "identityCard")}` },
          h(Backdrop, { name, picture }),
          h("div", { className: copied("page", "identityPortrait") }, h(AgentPortrait, { name, picture })),
          h("div", { className: copied("page", "identityName") },
            h("h2", { className: "m-0 text-body-lg text-center break-words", style: editing ? { visibility: "hidden" } : undefined }, name),
            editing ? h("div", { className: copied("page", "nameEditor") }, editing) : null),
          under ?? null,
          actions ? h("div", { className: copied("hero", "actions") }, ...each(actions)) : null),
        h("section", { "aria-label": `${name} settings`, className: copied("page", "work") }, ...each(children))));
  /** The name's editor in the hero (Input appearance "heading"). */
  const NameInput = ({ value, onChange, onSubmit, onCancel, label = "Agent name", placeholder = "Name your agent", invalid }) =>
    h("input", { "data-buzz-ui": "", className: "buzz-input", "data-appearance": "heading", "aria-label": label, placeholder, value, autoFocus: true,
      "aria-invalid": invalid || undefined, onChange: (event) => onChange(event.target.value),
      onKeyDown: (event) => { if (event.key === "Enter") { event.preventDefault(); onSubmit?.(); } else if (event.key === "Escape") { event.preventDefault(); onCancel?.(); } } });
  /** Cancel and Save under the name while it is edited. */
  const NameActions = ({ children }) => h("div", { className: copied("page", "nameActions") }, ...each(children));

  /** Menu.tsx: a "…" button (IconButton, `variant` glass-ghost on a card,
   * glass or subtle in a hero) that opens Buzz's menu of `items`
   * ({ label, onSelect, tone: "danger" }). */
  const Menu = ({ label, items, variant = "glass-ghost" }) => {
    const [open, setOpen] = React.useState(false);
    const trigger = React.useRef(null);
    const popup = React.useRef(null);
    const kind = one(["glass-ghost", "glass", "subtle", "ghost"], variant);
    React.useLayoutEffect(() => {
      const list = popup.current, at = trigger.current;
      if (!list || !at || typeof document === "undefined") return undefined;
      if (!open) { try { list.hidePopover?.(); } catch {} return undefined; }
      Object.assign(list.style, { position: "fixed", margin: "0", inset: "auto", top: "0px", left: "0px" });
      try { list.showPopover?.(); } catch {}
      const box = at.getBoundingClientRect();
      list.style.setProperty("--available-width", `${window.innerWidth - 16}px`);
      list.style.setProperty("--available-height", `${Math.max(120, window.innerHeight - box.bottom - 12)}px`);
      Object.assign(list.style, { top: `${box.bottom + 4}px`, left: `${Math.max(8, box.right - list.offsetWidth)}px` });
      list.querySelector('[role="menuitem"]')?.focus({ preventScroll: true });
      const away = (event) => { if (!list.contains(event.target) && !at.contains(event.target)) setOpen(false); };
      const keys = (event) => { if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); setOpen(false); at.focus(); } };
      document.addEventListener("pointerdown", away, true);
      document.addEventListener("keydown", keys, true);
      return () => { document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", keys, true); };
    }, [open]);
    return h(Fragment, null,
      h("button", { ref: trigger, type: "button", "aria-label": label, title: label, "aria-haspopup": "menu", "aria-expanded": open,
          "data-buzz-ui": "", className: "buzz-button", "data-variant": kind, "data-size": "sm", "data-button-shape": "capsule",
          "data-icon-variant": kind, "data-icon-size": "sm", "data-icon-shape": "control", "data-popup-open": open ? "" : undefined,
          onClick: () => setOpen((value) => !value) },
        h("span", { className: "buzz-button-label" }, icon(ICON.dots, 16))),
      h("div", { ref: popup, popover: "manual", role: "menu", "aria-label": label, "data-buzz-ui": "", className: "buzz-menu-popup text-body-sm",
          onKeyDown: (event) => {
            const rows = [...event.currentTarget.querySelectorAll('[role="menuitem"]')];
            const at = rows.indexOf(document.activeElement);
            if (event.key === "ArrowDown") { event.preventDefault(); rows[Math.min(at + 1, rows.length - 1)]?.focus(); }
            else if (event.key === "ArrowUp") { event.preventDefault(); rows[Math.max(at - 1, 0)]?.focus(); }
            else if (event.key === "Tab") setOpen(false);
          } },
        ...items.map((item) => h("div", { key: item.label, role: "menuitem", tabIndex: -1, className: "buzz-menu-item", "data-tone": item.tone === "danger" ? "danger" : "default",
          onPointerMove: (event) => { if (document.activeElement !== event.currentTarget) event.currentTarget.focus({ preventScroll: true }); },
          onFocus: (event) => event.currentTarget.setAttribute("data-highlighted", ""),
          onBlur: (event) => event.currentTarget.removeAttribute("data-highlighted"),
          onClick: () => { setOpen(false); trigger.current?.focus?.(); item.onSelect?.(); },
          onKeyDown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(false); trigger.current?.focus?.(); item.onSelect?.(); } } },
          item.label))));
  };

  /** Buzz's avatar packs to pick from (the Change avatar dock's posters): `value` is the picture. */
  const AvatarChoices = ({ value, onChange, disabled }) =>
    h("fieldset", { "aria-label": "Agent avatars", disabled, className: "flex flex-wrap gap-2 p-0 m-0", style: { border: 0 } },
      ...AVATARS.map((avatar) => h("button", { key: avatar.id, type: "button", "aria-label": avatar.label, "aria-pressed": avatar.url === value,
          "data-buzz-ui": "", className: "buzz-surface-button", onClick: () => onChange(avatar.url),
          style: { width: "var(--size-control)", height: "var(--size-control)", padding: 0, border: 0, background: "transparent", cursor: "pointer",
            borderRadius: "var(--radius-control)", boxShadow: avatar.url === value ? "inset 0 0 0 2px var(--border-prominent)" : undefined } },
        h("img", { src: avatar.url, alt: "", loading: "lazy", draggable: false, style: { width: "100%", height: "100%", objectFit: "contain" } }))));

  // Lines Buzz writes around its cards.
  const Note = (text) => h("p", { className: "m-0 text-body-sm text-secondary" }, text);
  const ErrorLine = (text) => h("p", { role: "alert", className: "buzz-field-error" }, text);
  const Spinner = () => icon(ICON.loader, 16, { className: "motion-safe:animate-spin" });
  /** A line of progress: Buzz's spinner beside a few words. */
  const Status = (text) => h("span", { role: "status", className: "flex items-center gap-2 text-body-sm text-secondary" }, h(Spinner), text);
  /** A value a row shows but does not change. */
  const Value = (text) => h("span", { className: "text-body-sm" }, text);
  /** A line a row shows as broken (red only for broken). */
  const Alert = (text) => h("span", { role: "alert", className: "text-danger" }, text);
  const Code = (text) => h("code", { className: "text-body tabular-nums", style: { letterSpacing: "0.08em" } }, text);

  return { VARIANTS, SectionTitle, Group, Row, Button, Input, Switch, SwitchRow, Pill, Popup, Native, TextField, Stack, Column, Actions, Note, ErrorLine, Spinner, Status, Value, Alert, Code,
    Header, IconButton, PanelHeader, Page, Subview, Surface, PanelBody, Fill, Toolbar, EmptyState, NavItem, Tabs, Disclosure, CountBadge, Dot, LinkChip, OneTimeCode, CodeColumn, Failure, Notice,
    Frame, Avatar, Byline, Canvas, Layers, CanvasImage, QuietLine, Question, Permits, Article, Chip, ChipRow, DiffText, ChangeTable, MediaPair, DecisionBar, Skeleton, Checkbox, SelectRow, ListGroup, Split, MessageCard, MessageRow,
    Title, Heading, Paragraph, Caption, Strong, Lines, Line, Pre, ICON,
    AgentBrowse, AgentGrid, AgentCard, CardMark, AgentPortrait, AgentPanel, AgentProfile, NameInput, NameActions, Menu, AvatarChoices, HeaderTab, Picture, Glyph, COPIED, COPIED_FROM, AVATARS };
}
// ---- end buzz-ui kit ----
export { buzzUi };

// ---- reviews: stamped from src/reviews/ by `npm run build`; edit it there ----
// ---- Reviews: the marks of the systems a decision writes to ----------------------
// Platform Control's own bundled provider logos (joeyblack4/black4-retail-edge,
// apps/platform-control/web/public/provider-logos, where their sources are
// listed), copied byte for byte as data URLs so nothing is fetched from a third
// party. Brand marks remain the property of their respective owners.
/** By Platform Control's provider key (providerLogoKey). */
const REVIEW_PROVIDER_LOGOS = Object.freeze({
  "acumatica": "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNzAiIGhlaWdodD0iNzAiIHZpZXdCb3g9IjAgMCA3MCA3MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWx0ZXI9InVybCgjZmlsdGVyMF9kXzMxMjdfMTA3KSI+PHBhdGggZD0iTTU3LjAwMSAzNy4yMTI3VjUyLjk5ODNINDEuMjE1M0MzNi44NDkxIDUyLjk5ODMgMzIuOTMwNyA1MS4yMDcxIDMwLjA3NTggNDguMzUyMkMyNy4yMjEgNDUuNDk3NCAyNS40Mjk3IDQxLjUyMyAyNS40Mjk3IDM3LjIxMjdDMjUuNDI5NyAzNi41OTcgMjUuNDg1NyAzNS45ODEyIDI1LjU0MTYgMzUuMzY1NEMyOC40NTI1IDM5LjAwNCAzMi44NzQ3IDQxLjI5OTEgMzcuODU2NyA0MS4yOTkxSDQ1LjMwMTdWMzMuNzk4MUM0NS4zMDE3IDI4LjgxNjEgNDMuMDA2NiAyNC4zOTM5IDM5LjM2ODEgMjEuNDgzQzM5LjkyNzggMjEuNDI3MSA0MC41NDM2IDIxLjM3MTEgNDEuMTU5MyAyMS4zNzExQzQ5Ljg5MTggMjEuNDI3MSA1Ny4wMDEgMjguNDgwMiA1Ny4wMDEgMzcuMjEyN1oiIGZpbGw9InVybCgjcGFpbnQwX2xpbmVhcl8zMTI3XzEwNykiLz48cGF0aCBkPSJNMzAuMDE3MSA0OC4zNTIxQzMyLjg3MiA1MS4yMDcgMzYuODQ2NCA1Mi45OTgyIDQxLjE1NjYgNTIuOTk4MkgzNC45OTkxQzI4Ljk1MzYgNTIuOTk4MiAyMy40MTE4IDUwLjUzNTIgMTkuNDM3NCA0Ni41NjA4QzE1LjQ2MyA0Mi41ODY0IDEzIDM3LjEwMDcgMTMgMzAuOTk5MUMxMyAxOC44NTIgMjIuODUyIDkgMzQuOTk5MSA5QzM4LjU4MTcgOSA0MS45OTYzIDkuODk1NjQgNDUuMDE5MSAxMS40MDdDNDIuODkxOSAxMC4zNDM1IDQwLjM3MyA5LjcyNzcxIDM3Ljg1NCA5LjcyNzcxQzMzLjQ4NzcgOS43Mjc3MSAyOS41NjkzIDExLjUxOSAyNi43MTQ1IDE0LjM3MzhDMjMuODU5NiAxNy4yMjg3IDIyLjA2ODMgMjEuMjAzMSAyMi4wNjgzIDI1LjUxMzNDMjIuMDY4MyAyNy4zNjA2IDIyLjQwNDIgMjkuMTUxOSAyMi45NjQgMzAuODMxMkMyMy41Nzk3IDMyLjUxMDUgMjQuNDE5NCAzNC4wMjE5IDI1LjQ4MyAzNS4zNjU0QzI1LjQyNyAzNS45ODExIDI1LjM3MSAzNi41OTY5IDI1LjM3MSAzNy4yMTI2QzI1LjQyNyA0MS41Nzg5IDI3LjE2MjMgNDUuNDk3MyAzMC4wMTcxIDQ4LjM1MjFaIiBmaWxsPSJ1cmwoI3BhaW50MV9saW5lYXJfMzEyN18xMDcpIi8+PHBhdGggZD0iTTU2Ljk5ODkgMzAuOTk5OVYzNy4yMTM0QzU2Ljk5ODkgMjguNDgxIDQ5Ljk0NTggMjEuNDI3OCA0MS4yMTMzIDIxLjQyNzhDMzMuMDk2NiAyMS40Mjc4IDI2LjQzNTMgMjcuNTI5MyAyNS41Mzk2IDM1LjM2NjJDMjQuNDc2MSAzNC4wMjI3IDIzLjU4MDQgMzIuNTExMyAyMy4wMjA2IDMwLjgzMkMyMi40MDQ5IDI5LjE1MjcgMjIuMTI1IDI3LjQxNzQgMjIuMTI1IDI1LjUxNDFDMjIuMTI1IDIxLjE0NzkgMjMuOTE2MyAxNy4yMjk1IDI2Ljc3MTEgMTQuMzc0NkMyOS42MjYgMTEuNTE5OCAzMy42MDA0IDkuNzI4NTIgMzcuOTEwNiA5LjcyODUyQzQwLjQyOTYgOS43Mjg1MiA0Mi44OTI2IDEwLjM0NDMgNDUuMDc1NyAxMS40MDc4SDQ1LjEzMTdDNTIuMTI4OSAxNS4wNDY0IDU2Ljk5ODkgMjIuNDkxNCA1Ni45OTg5IDMwLjk5OTlaIiBmaWxsPSJ1cmwoI3BhaW50Ml9saW5lYXJfMzEyN18xMDcpIi8+PC9nPjxkZWZzPjxmaWx0ZXIgaWQ9ImZpbHRlcjBfZF8zMTI3XzEwNyIgeD0iMCIgeT0iMCIgd2lkdGg9IjcwIiBoZWlnaHQ9IjcwIiBmaWx0ZXJVbml0cz0idXNlclNwYWNlT25Vc2UiIGNvbG9yLWludGVycG9sYXRpb24tZmlsdGVycz0ic1JHQiI+PGZlRmxvb2QgZmxvb2Qtb3BhY2l0eT0iMCIgcmVzdWx0PSJCYWNrZ3JvdW5kSW1hZ2VGaXgiLz48ZmVDb2xvck1hdHJpeCBpbj0iU291cmNlQWxwaGEiIHR5cGU9Im1hdHJpeCIgdmFsdWVzPSIwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAxMjcgMCIgcmVzdWx0PSJoYXJkQWxwaGEiLz48ZmVPZmZzZXQgZHk9IjQiLz48ZmVHYXVzc2lhbkJsdXIgc3RkRGV2aWF0aW9uPSIyIi8+PGZlQ29tcG9zaXRlIGluMj0iaGFyZEFscGhhIiBvcGVyYXRvcj0ib3V0Ii8+PGZlQ29sb3JNYXRyaXggdHlwZT0ibWF0cml4IiB2YWx1ZXM9IjAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAuMjUgMCIvPjxmZUJsZW5kIG1vZGU9Im5vcm1hbCIgaW4yPSJCYWNrZ3JvdW5kSW1hZ2VGaXgiIHJlc3VsdD0iZWZmZWN0MV9kcm9wU2hhZG93XzMxMjdfMTA3Ii8+PGZlQmxlbmQgbW9kZT0ibm9ybWFsIiBpbj0iU291cmNlR3JhcGhpYyIgaW4yPSJlZmZlY3QxX2Ryb3BTaGFkb3dfMzEyN18xMDciIHJlc3VsdD0ic2hhcGUiLz48L2ZpbHRlcj48bGluZWFyR3JhZGllbnQgaWQ9InBhaW50MF9saW5lYXJfMzEyN18xMDciIHgxPSIyOS43NTg3IiB5MT0iNDguMzc0NyIgeDI9IjUzLjI0MjEiIHkyPSIzNC4yMDciIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj48c3RvcCBzdG9wLWNvbG9yPSIjMDA2NDlDIi8+PHN0b3Agb2Zmc2V0PSIwLjExIiBzdG9wLWNvbG9yPSIjMDg3NUFDIi8+PHN0b3Agb2Zmc2V0PSIwLjM3IiBzdG9wLWNvbG9yPSIjMUE5QUNGIi8+PHN0b3Agb2Zmc2V0PSIwLjYyIiBzdG9wLWNvbG9yPSIjMjhCNUU5Ii8+PHN0b3Agb2Zmc2V0PSIwLjgzIiBzdG9wLWNvbG9yPSIjMzBDNkY5Ii8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMzNDQ0ZGIi8+PC9saW5lYXJHcmFkaWVudD48bGluZWFyR3JhZGllbnQgaWQ9InBhaW50MV9saW5lYXJfMzEyN18xMDciIHgxPSIzNS4xMTkzIiB5MT0iNi45NzIwNSIgeDI9IjI0LjQ2MzMiIHkyPSI1MS43MjcxIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHN0b3Agc3RvcC1jb2xvcj0iIzAwNjQ5QyIvPjxzdG9wIG9mZnNldD0iMC4xMSIgc3RvcC1jb2xvcj0iIzA4NzVBQyIvPjxzdG9wIG9mZnNldD0iMC4zNyIgc3RvcC1jb2xvcj0iIzFBOUFDRiIvPjxzdG9wIG9mZnNldD0iMC42MiIgc3RvcC1jb2xvcj0iIzI4QjVFOSIvPjxzdG9wIG9mZnNldD0iMC44MyIgc3RvcC1jb2xvcj0iIzMwQzZGOSIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzMzQ0NGRiIvPjwvbGluZWFyR3JhZGllbnQ+PGxpbmVhckdyYWRpZW50IGlkPSJwYWludDJfbGluZWFyXzMxMjdfMTA3IiB4MT0iNTYuNTE2NyIgeTE9IjMwLjczMyIgeDI9IjIzLjc3MzkiIHkyPSIxOS4zMDIxIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHN0b3Agc3RvcC1jb2xvcj0iIzAwNjQ5QyIvPjxzdG9wIG9mZnNldD0iMC4xMSIgc3RvcC1jb2xvcj0iIzA4NzVBQyIvPjxzdG9wIG9mZnNldD0iMC4zNyIgc3RvcC1jb2xvcj0iIzFBOUFDRiIvPjxzdG9wIG9mZnNldD0iMC42MiIgc3RvcC1jb2xvcj0iIzI4QjVFOSIvPjxzdG9wIG9mZnNldD0iMC44MyIgc3RvcC1jb2xvcj0iIzMwQzZGOSIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzMzQ0NGRiIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjwvc3ZnPgo=",
  "ahrefs": "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjIiIGhlaWdodD0iNjIiIHZpZXdCb3g9IjAgMCA2MiA2MiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNMTYuNzYzMiAxOC41MzE1SDM4LjQ0NFYyNC42MzkzTDMwLjI5MDMgMjUuMjY3N0MxNy4xMjQ2IDI2LjI1MjcgMTMgMjkuNzUxMyAxMyAzOS41Mzg1VjQxLjUxNDJDMTMgNDguNjkyMiAxOC4wMTc1IDUzIDI1LjcyNDYgNTNDMzEuODE1OCA1MyAzNS4yOTIxIDUxLjU2MjIgMzkuNjEzMyA0Ny4xNDI3SDQwLjMwOTZWNTEuODEyNUg0OVY5SDE2Ljc2MzJWMTguNTMxNVpNMzguNDQ0IDM5LjE3NjVDMzUuNzg2MyA0MS44NzA5IDMxLjcyNTQgNDMuNjY1NCAyOC40MDg3IDQzLjY2NTRDMjQuODI2MyA0My42NjU0IDIzLjMwNiA0Mi4zMTgxIDIzLjM5MTIgMzkuMzU3NEMyMy40ODE2IDM1LjIyNTMgMjQuNzU3OSAzNC4yNDAyIDMxLjg5NTUgMzMuNjExOUwzOC40MzMyIDMyLjk4MzZMMzguNDQ0IDM5LjE3NjVaIiBmaWxsPSIjRkY4RDAwIi8+PC9zdmc+",
  "airtable": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MiIgaGVpZ2h0PSI2MiIgZmlsbD0ibm9uZSIgdmlld0JveD0iMCAwIDYyIDYyIj48ZyBjbGlwLXBhdGg9InVybCgjQSkiPjxwYXRoIGQ9Ik0yOC40MDEgMTMuNDU5bC0xNi4xOTggNi43MDNhMS4wOSAxLjA5IDAgMCAwIC4wMTUgMi4wMTJsMTYuMjY2IDYuNDVjMS40MjkuNTY3IDMuMDIxLjU2NyA0LjQ1IDBMNDkuMiAyMi4xNzNhMS4wOSAxLjA5IDAgMCAwIC4wMTUtMi4wMTFsLTE2LjE5OC02LjcwM2MtMS40NzgtLjYxMS0zLjEzOC0uNjExLTQuNjE2IDAiIGZpbGw9IiNmY2I0MDAiLz48cGF0aCBkPSJNMzIuMTUyIDMyLjE0NlY0OC4yNmMwIC43NjYuNzczIDEuMjkxIDEuNDg1IDEuMDA5bDE4LjEyNS03LjAzNWMuMjAyLS4wOC4zNzUtLjIxOS40OTgtLjM5OXMuMTg4LS4zOTIuMTg3LS42MVYyNS4xMTFjMC0uNzY2LS43NzMtMS4yOTEtMS40ODUtMS4wMDlsLTE4LjEyNSA3LjAzNWMtLjIwMi4wOC0uMzc1LjIxOS0uNDk4LjM5OXMtLjE4Ny4zOTItLjE4Ny42MDl6IiBmaWxsPSIjMThiZmZmIi8+PHBhdGggZD0iTTI3LjkxOSAzMi45NzdsLTUuMzc5IDIuNTk3LS41NDYuMjY0LTExLjM1NSA1LjQ0MWMtLjcyLjM0Ny0xLjYzOS0uMTc3LTEuNjM5LS45NzdWMjUuMTc4YzAtLjI4OS4xNDgtLjUzOS4zNDctLjcyNy4wODItLjA4MS4xNzQtLjE1MS4yNzUtLjIwNi4yNzEtLjE2My42NTgtLjIwNi45ODctLjA3NmwxNy4yMTkgNi44MjNjLjg3NS4zNDcuOTQ0IDEuNTczLjA5IDEuOTg2eiIgZmlsbD0iI2Y4MmI2MCIvPjxwYXRoIGQ9Ik0yNy45MTkgMzIuOTc3bC01LjM3OSAyLjU5N0w5LjM0NyAyNC40NTFjLjA4Mi0uMDgxLjE3NC0uMTUxLjI3NS0uMjA2LjI3MS0uMTYzLjY1OC0uMjA2Ljk4Ny0uMDc2bDE3LjIxOSA2LjgyM2MuODc1LjM0Ny45NDQgMS41NzMuMDkgMS45ODZ6IiBmaWxsPSIjMDAwIiBmaWxsLW9wYWNpdHk9Ii4yNSIvPjwvZz48ZGVmcz48Y2xpcFBhdGggaWQ9IkEiPjxwYXRoIGZpbGw9IiNmZmYiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDkgMTMpIiBkPSJNMCAwaDQ0djM2LjgzOEgweiIvPjwvY2xpcFBhdGg+PC9kZWZzPjwvc3ZnPg==",
  "asana": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MiIgaGVpZ2h0PSI2MiIgZmlsbD0ibm9uZSIgdmlld0JveD0iMCAwIDYyIDYyIj48ZyBjbGlwLXBhdGg9InVybCgjQSkiPjxwYXRoIGZpbGwtcnVsZT0iZXZlbm9kZCIgZD0iTTQzLjM3NyAzMi40OTdjLTUuMjc3IDAtOS41NTQgNC4yNzgtOS41NTQgOS41NTVzNC4yNzcgOS41NTQgOS41NTQgOS41NTQgOS41NTQtNC4yNzggOS41NTQtOS41NTQtNC4yNzctOS41NTUtOS41NTQtOS41NTV6bS0yNC44MjMuMDAxQzEzLjI3OCAzMi40OTggOSAzNi43NzUgOSA0Mi4wNTJzNC4yNzggOS41NTQgOS41NTQgOS41NTQgOS41NTUtNC4yNzggOS41NTUtOS41NTQtNC4yNzgtOS41NTQtOS41NTUtOS41NTR6TTQwLjUyIDIwLjU1NGMwIDUuMjc3LTQuMjc3IDkuNTU1LTkuNTU0IDkuNTU1cy05LjU1NC00LjI3OC05LjU1NC05LjU1NVMyNS42ODkgMTEgMzAuOTY2IDExczkuNTU0IDQuMjc4IDkuNTU0IDkuNTU0eiIgZmlsbD0iI2YwNmE2YSIvPjwvZz48ZGVmcz48Y2xpcFBhdGggaWQ9IkEiPjxwYXRoIGZpbGw9IiNmZmYiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDkgMTEpIiBkPSJNMCAwaDQ0djQwLjcxSDB6Ii8+PC9jbGlwUGF0aD48L2RlZnM+PC9zdmc+",
  "canva": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciICB2aWV3Qm94PSIwIDAgNDggNDgiIHdpZHRoPSI0OHB4IiBoZWlnaHQ9IjQ4cHgiIGZpbGwtcnVsZT0iZXZlbm9kZCIgY2xpcC1ydWxlPSJldmVub2RkIiBiYXNlUHJvZmlsZT0iYmFzaWMiPjxsaW5lYXJHcmFkaWVudCBpZD0iTjhhTUotalo0LWNmbGRacnNudmhkYSIgeDE9IjM4LjI2MyIgeDI9IjEwLjE1IiB5MT0iMTM3My42MiIgeTI9IjEzNDIuNjE1IiBncmFkaWVudFRyYW5zZm9ybT0idHJhbnNsYXRlKDAgLTEzMzMuODkpIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjODIzYWYzIi8+PHN0b3Agb2Zmc2V0PSIuMzYiIHN0b3AtY29sb3I9IiM0YjY2ZTEiLz48c3RvcCBvZmZzZXQ9Ii45MDYiIHN0b3AtY29sb3I9IiMwMWYxYzQiLz48L2xpbmVhckdyYWRpZW50PjxwYXRoIGZpbGw9InVybCgjTjhhTUotalo0LWNmbGRacnNudmhkYSkiIGZpbGwtcnVsZT0iZXZlbm9kZCIgZD0iTTQ0LDI0YzAsMTEuMDQ1LTguOTU1LDIwLTIwLDIwUzQsMzUuMDQ1LDQsMjQJUzEyLjk1NSw0LDI0LDRTNDQsMTIuOTU1LDQ0LDI0eiIgY2xpcC1ydWxlPSJldmVub2RkIi8+PHBhdGggZmlsbD0iI2ZmZiIgZmlsbC1ydWxlPSJldmVub2RkIiBkPSJNMjkuMTk0LDI2Ljk2MmMtMC44MzUsMC45MTUtMi4wMDcsMS4zNzgtMi41NTYsMS4zNzgJYy0wLjYzNSwwLTAuOTgyLTAuMzg5LTEuMDUzLTAuOTc0Yy0wLjAyNC0wLjIyNC0wLjAxNi0wLjQ1LDAuMDI0LTAuNjczYzAuMjEtMS4zMSwwLjY5Mi0yLjEyNCwwLjY2Mi0yLjM3MgljLTAuMDA5LTAuMDcxLTAuMDQ5LTAuMTA2LTAuMTAxLTAuMTA2Yy0wLjQwNiwwLTEuODMsMS40Ny0yLjA0NiwyLjQ0M2wtMC4xNjgsMC43NzljLTAuMTEsMC41NDktMC42NDgsMC45MDItMS4wMTgsMC45MDIJYy0wLjE3NywwLTAuMzExLTAuMDg4LTAuMzM0LTAuMjgzYy0wLjAwNy0wLjA4OSwwLTAuMTc4LDAuMDIxLTAuMjY2bDAuMDc5LTAuNDFjLTAuNzY4LDAuNTc0LTEuNTk2LDAuOTYyLTEuOTg0LDAuOTYyCWMtMC41MywwLTAuODI3LTAuMjgzLTAuOTMzLTAuNzA5Yy0wLjM1LDAuNDYxLTAuODEzLDAuNzA5LTEuMzA2LDAuNzA5Yy0wLjYzLDAtMS4yMzctMC40MTctMS41MjgtMS4wMzQJYy0wLjQxNSwwLjQ2Ni0wLjkwNywwLjkyMi0xLjQ5NiwxLjI5OWMtMC44NjksMC41NS0xLjgzNiwwLjk5Mi0yLjk4MiwwLjk5MmMtMS4wNTgsMC0xLjk1Ni0wLjU2Ni0yLjQ1My0xLjAyNgljLTAuNzM3LTAuNjktMS4xMjYtMS43MTgtMS4yNDEtMi42NTZjLTAuMzYyLTIuOTU3LDEuNDM4LTYuODM0LDQuMjI3LTguNTMzYzAuNjQtMC4zOSwxLjM1Ny0wLjU4NCwyLjAwOC0wLjU4NAljMS4zNCwwLDIuMzQsMC45NTgsMi40OCwyLjEwNGMwLjEyNiwxLjAzMi0wLjI4NiwxLjkyNC0xLjQzMSwyLjUwMWMtMC41ODQsMC4yOTYtMC44NzQsMC4yODItMC45NjUsMC4xNDEJYy0wLjA2MS0wLjA5NC0wLjAyNi0wLjI1NCwwLjA5MS0wLjM1MWMxLjA3Ni0wLjg5OSwxLjA5Ni0xLjYzNywwLjk3LTIuNjc3Yy0wLjA4Mi0wLjY2OS0wLjUyMi0xLjA5OC0xLjAxNi0xLjA5OAljLTIuMTE1LDAtNS4xNDksNC43NDUtNC43MjcsOC4xOTdjMC4xNjUsMS4zNDYsMC45OSwyLjkwNCwyLjY4MiwyLjkwNGMwLjU2NCwwLDEuMTYyLTAuMTU5LDEuNjk0LTAuNDI1CWMwLjkyOC0wLjQ3NCwxLjQ1My0wLjg1LDEuOTgtMS40NjRjLTAuMTMtMS41OTYsMS4yNC0zLjYsMy4yNzgtMy42YzAuODgyLDAsMS42MTIsMC4zNTQsMS42OTgsMS4wNjIJYzAuMTA4LDAuODg1LTAuNjQ2LDEuMDYyLTAuOTI4LDEuMDYyYy0wLjI0NywwLTAuNjQzLTAuMDcxLTAuNjcxLTAuMzAxYy0wLjAzLTAuMjQ4LDAuNTM0LTAuMTA2LDAuNDY0LTAuNjczCWMtMC4wNDMtMC4zNTQtMC40MTEtMC40NzgtMC43NjMtMC40NzhjLTEuMjY5LDAtMS45NywxLjc3LTEuODM1LDIuODY5YzAuMDYxLDAuNDk2LDAuMzE1LDAuOTkxLDAuNzc0LDAuOTkxCWMwLjM3LDAsMC45MDQtMC41MzEsMS4xMDktMS4zMWMwLjEzLTAuNTMxLDAuNjMyLTAuODg1LDEuMDAzLTAuODg1YzAuMTk0LDAsMC4zMjgsMC4wODgsMC4zNTIsMC4yODMJYzAuMDA4LDAuMDcxLDAuMDAyLDAuMTYtMC4wMjEsMC4yNjZjLTAuMDQyLDAuMjMtMC4yMTksMC45OTYtMC4yMSwxLjE1NGMwLjAwNiwwLjEzOCwwLjA4NiwwLjMyOCwwLjMyNiwwLjMyOAljMC4xOSwwLDAuODktMC4zNzgsMS41MzgtMC45NThjMC4yMDMtMS4wNTEsMC40NTQtMi4zNTEsMC40NzQtMi40NTRjMC4wNzktMC40MjYsMC4yMzItMC44NjUsMS4wOTYtMC44NjUJYzAuMTc3LDAsMC4zMTEsMC4wODgsMC4zMzcsMC4zMDFjMC4wMDgsMC4wNywwLjAwMiwwLjE2LTAuMDIxLDAuMjY2bC0wLjI0MiwxLjA5M2MwLjc1OC0xLjAxLDEuOTM2LTEuNzUyLDIuNjQyLTEuNzUyCWMwLjMsMCwwLjUzMSwwLjE1OCwwLjU3LDAuNDc4YzAuMDIyLDAuMTc4LTAuMDMsMC40NzgtMC4xNDcsMC44MTRjLTAuMjUxLDAuNjktMC41MzMsMS43MjctMC43MiwyLjYyCWMtMC4wNCwwLjE5LDAuMDI2LDAuNDc2LDAuMzczLDAuNDc2YzAuMjc3LDAsMS4xNjYtMC4zMzksMS44ODUtMS4yODhjLTAuMDA1LTAuMTM0LTAuMDA3LTAuMjctMC4wMDctMC40MDgJYzAtMC43NDQsMC4wNTMtMS4zNDYsMC4xOTQtMS43ODdjMC4xNDEtMC40NjEsMC43MjMtMC45MDIsMS4xMS0wLjkwMmMwLjE5NCwwLDAuMzM1LDAuMTA2LDAuMzM1LDAuMzE4CWMwLDAuMDcxLTAuMDE4LDAuMTYtMC4wNTMsMC4yNDhjLTAuMjY0LDAuNzc5LTAuNDA1LDEuNTA2LTAuNDA1LDIuMjMxYzAsMC40MDcsMC4wODgsMS4wNjIsMC4xNzcsMS4zOTgJYzAuMDE4LDAuMDcxLDAuMDM0LDAuMTQyLDAuMTA1LDAuMTQyYzAuMTIzLDAsMC45NTItMC44MTQsMS41NTEtMS44MDZjLTAuNTMtMC4zMzctMC44MjktMC45NTYtMC44MjktMS43MTgJYzAtMS4yNzQsMC43NTgtMS45MywxLjQ5OC0xLjkzYzAuNTgyLDAsMS4xMSwwLjQyNSwxLjExLDEuMjc0YzAsMC41MzItMC4yMTIsMS4xMzQtMC41MSwxLjcxOGMwLDAsMC4xMjMsMC4wMTgsMC4xNzYsMC4wMTgJYzAuNDU4LDAsMC44MTEtMC4yMTMsMS4wMDYtMC40NDNjMC4wODgtMC4xLDAuMTctMC4xNzgsMC4yNDgtMC4yMjRjMC41OS0wLjcxMywxLjQ1NS0xLjIyOCwyLjQ3LTEuMjI4CWMwLjg2NCwwLDEuNjEsMC4zMzcsMS42OTYsMS4wNDVjMC4xMSwwLjkwMi0wLjY2MSwxLjA4LTAuOTI2LDEuMDhjLTAuMjY0LDAtMC42NjEtMC4wNzEtMC42ODktMC4zMDFzMC41NTEtMC4xMDYsMC40ODQtMC42NTQJYy0wLjA0My0wLjM1NC0wLjQxMy0wLjQ5Ni0wLjc2Ni0wLjQ5NmMtMS4xODIsMC0xLjk5NCwxLjU3Ni0xLjgzOCwyLjg1YzAuMDYyLDAuNTE0LDAuMjk5LDEuMDEsMC43NTgsMS4wMQljMC4zNywwLDAuOTIzLTAuNTMyLDEuMTI3LTEuMzFjMC4xMzEtMC41MTQsMC42MzItMC44ODUsMS4wMDItMC44ODVjMC4xNzYsMCwwLjMyOCwwLjA4OCwwLjM1NCwwLjMwMQljMC4wMTMsMC4xMDYtMC4wMywwLjMzNy0wLjIyNywxLjE2OGMtMC4wODEsMC4zNTQtMC4wOTcsMC42NTUtMC4wNjYsMC45MDNjMC4wNjMsMC41MTQsMC4yOTgsMC44NSwwLjUxNiwxLjA0NQljMC4wNzksMC4wNywwLjEyNiwwLjE1OCwwLjEzMiwwLjIxM2MwLjAxNywwLjE0Mi0wLjA5MSwwLjI2Ni0wLjI2NywwLjI2NmMtMC4wNTMsMC0wLjEyMywwLTAuMTgxLTAuMDM1CWMtMC45MDgtMC4zNzItMS4yODUtMC45OTEtMS4zOTEtMS41NzZjLTAuMzUsMC40NDItMC44MTQsMC42OS0xLjI5LDAuNjljLTAuODExLDAtMS42MDMtMC43MDktMS43MTUtMS42MjkJYy0wLjA0Ni0wLjM3OC0wLjAwMS0wLjc4NSwwLjEyMy0xLjE4NGMtMC4zMjksMC4yMDMtMC42ODMsMC4zMTYtMS4wMDEsMC4zMTZjLTAuMTA2LDAtMC4xOTQsMC0wLjI5OS0wLjAxOAljLTAuNzkzLDEuMTUtMS42MjIsMS45NDctMi4yNTcsMi4zMDJjLTAuMjY0LDAuMTQyLTAuNTEsMC4yMTMtMC42ODcsMC4yMTNjLTAuMTQyLDAtMC4zLTAuMDM1LTAuMzctMC4xNTkJQzI5LjM2NywyNy45MSwyOS4yNTgsMjcuNDc0LDI5LjE5NCwyNi45NjJMMjkuMTk0LDI2Ljk2MnogTTMyLjA2NywyMy4xOTFjMCwwLjQ5NiwwLjI0NiwxLjAxLDAuNTY0LDEuMzQ2CWMwLjEyNC0wLjMzNywwLjE5NC0wLjY3MywwLjE5NC0xLjAxYzAtMC42MzgtMC4yNDctMC45MjEtMC40NDEtMC45MjFDMzIuMTU1LDIyLjYwNiwzMi4wNjcsMjIuOTI2LDMyLjA2NywyMy4xOTF6IiBjbGlwLXJ1bGU9ImV2ZW5vZGQiLz48L3N2Zz4=",
  "framer": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0Ij48cGF0aCBmaWxsPSIjMDAwIiBkPSJNNCAwaDE2djhoLTh6TTQgOGg4bDggOEg0ek00IDE2aDh2OHoiLz48L3N2Zz4K",
  "github": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MiIgaGVpZ2h0PSI2MiIgZmlsbD0ibm9uZSIgdmlld0JveD0iMCAwIDYyIDYyIj48cmVjdCB3aWR0aD0iNjIiIGhlaWdodD0iNjIiIHJ4PSIzMSIgZmlsbD0iI2ZmZiIvPjxnIGNsaXAtcGF0aD0idXJsKCNBKSI+PHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBkPSJNMzAuOTM0IDlDMTguODA1IDkgOSAxOC44NzggOSAzMS4wOTdjMCA5Ljc2OCA2LjI4MyAxOC4wMzYgMTQuOTk4IDIwLjk2MyAxLjA5LjIyIDEuNDg5LS40NzUgMS40ODktMS4wNmwtLjAzNi00LjA5OGMtNi4xMDIgMS4zMTctNy4zNzItMi42MzQtNy4zNzItMi42MzQtLjk4MS0yLjU2MS0yLjQzNC0zLjIxOS0yLjQzNC0zLjIxOS0xLjk5Ny0xLjM1NC4xNDYtMS4zNTQuMTQ2LTEuMzU0IDIuMjE1LjE0NiAzLjM3OCAyLjI2OCAzLjM3OCAyLjI2OCAxLjk2MSAzLjM2NSA1LjEyIDIuNDE1IDYuMzkxIDEuODI5LjE4MS0xLjQyNy43NjMtMi40MTUgMS4zOC0yLjk2My00Ljg2Ny0uNTEyLTkuOTg3LTIuNDE1LTkuOTg3LTEwLjkwMyAwLTIuNDE1Ljg3MS00LjM5IDIuMjUxLTUuOTI3LS4yMTgtLjU0OS0uOTgxLTIuODE3LjIxOC01Ljg1NCAwIDAgMS44NTItLjU4NSA2LjAyOCAyLjI2OCAxLjc4OC0uNDg0IDMuNjMyLS43MyA1LjQ4NC0uNzMyczMuNzQuMjU2IDUuNDgzLjczMmM0LjE3Ni0yLjg1NCA2LjAyOS0yLjI2OCA2LjAyOS0yLjI2OCAxLjE5OSAzLjAzNi40MzUgNS4zMDUuMjE4IDUuODU0IDEuNDE3IDEuNTM2IDIuMjUyIDMuNTEyIDIuMjUyIDUuOTI3IDAgOC40ODgtNS4xMiAxMC4zNTQtMTAuMDIzIDEwLjkwMy43OTkuNjk1IDEuNDg5IDIuMDEyIDEuNDg5IDQuMDk3bC0uMDM2IDYuMDczYzAgLjU4Ni40IDEuMjgxIDEuNDg5IDEuMDYxIDguNzE2LTIuOTI3IDE0Ljk5OC0xMS4xOTUgMTQuOTk4LTIwLjk2M0M1Mi44NjggMTguODc4IDQzLjAyNyA5IDMwLjkzNCA5eiIgZmlsbD0iIzI0MjkyZiIvPjwvZz48ZGVmcz48Y2xpcFBhdGggaWQ9IkEiPjxwYXRoIGZpbGw9IiNmZmYiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDkgOSkiIGQ9Ik0wIDBoNDR2NDMuMTAySDB6Ii8+PC9jbGlwUGF0aD48L2RlZnM+PC9zdmc+",
  "gitlab": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MiIgaGVpZ2h0PSI2MiIgZmlsbD0ibm9uZSIgdmlld0JveD0iMCAwIDYyIDYyIj48cGF0aCBkPSJNMzAuOTk5IDUxLjUyNmw4LjEwNi0yNC45MzNoLTE2LjJsOC4wOTQgMjQuOTM0eiIgZmlsbD0iI2UyNDMyOSIvPjxwYXRoIGQ9Ik0xMS41NTEgMjYuNTkzbC0yLjQ2OCA3LjU3NWExLjY4IDEuNjggMCAwIDAgLjYwNyAxLjg3NmwyMS4zMDkgMTUuNDgyLTE5LjQ0OC0yNC45MzN6IiBmaWxsPSIjZmNhMzI2Ii8+PHBhdGggZD0iTTExLjU1MSAyNi41OTNoMTEuMzU0bC00Ljg4Ni0xNS4wMTZjLS4yNS0uNzY4LTEuMzQtLjc2OC0xLjU5OSAwbC00Ljg2OCAxNS4wMTZ6IiBmaWxsPSIjZTI0MzI5Ii8+PHBhdGggZD0iTTUwLjQ1OCAyNi41OTNsMi40NiA3LjU3NWExLjY4IDEuNjggMCAwIDEtLjYwNyAxLjg3NkwzMC45OTkgNTEuNTI2bDE5LjQ2LTI0LjkzM3oiIGZpbGw9IiNmY2EzMjYiLz48cGF0aCBkPSJNNTAuNDU4IDI2LjU5M0gzOS4xMDVsNC44NzctMTUuMDE2Yy4yNS0uNzY4IDEuMzQtLjc2OCAxLjU5OSAwbDQuODc3IDE1LjAxNnoiIGZpbGw9IiNlMjQzMjkiLz48ZyBmaWxsPSIjZmM2ZDI2Ij48cGF0aCBkPSJNMzAuOTk5IDUxLjUyNmw4LjEwNi0yNC45MzNoMTEuMzU0bC0xOS40NiAyNC45MzR6Ii8+PHBhdGggZD0iTTMwLjk5OSA1MS41MjZMMTEuNTUxIDI2LjU5M2gxMS4zNTRsOC4wOTQgMjQuOTM0eiIvPjwvZz48L3N2Zz4=",
  "google": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MiIgaGVpZ2h0PSI2MiIgZmlsbD0ibm9uZSIgdmlld0JveD0iMCAwIDYyIDYyIj48ZyBjbGlwLXBhdGg9InVybCgjQSkiPjxwYXRoIGQ9Ik0zMSAyN3Y4LjUyaDExLjg0Yy0uNTIgMi43NC0yLjA4IDUuMDYtNC40MiA2LjYybDcuMTQgNS41NGM0LjE2LTMuODQgNi41Ni05LjQ4IDYuNTYtMTYuMThhMjUuMjggMjUuMjggMCAwIDAtLjQtNC41SDMxeiIgZmlsbD0iIzQyODVmNCIvPjxwYXRoIGQ9Ik0xOC42NyAzNS4xODhsLTEuNjEgMS4yMzMtNS43IDQuNDRDMTQuOTggNDguMDQgMjIuMzk5IDUzIDMwLjk5OSA1M2M1Ljk0IDAgMTAuOTItMS45NiAxNC41Ni01LjMybC03LjE0LTUuNTRjLTEuOTYgMS4zMi00LjQ2IDIuMTItNy40MiAyLjEyLTUuNzIgMC0xMC41OC0zLjg2LTEyLjMyLTkuMDZsLS4wMDktLjAxM3oiIGZpbGw9IiMzNGE4NTMiLz48cGF0aCBkPSJNMTEuMzYgMjEuMTRhMjEuNzMgMjEuNzMgMCAwIDAgMCAxOS43MmMwIC4wMiA3LjMyLTUuNjggNy4zMi01LjY4LS40NC0xLjMyLS43LTIuNzItLjctNC4xOHMuMjYtMi44Ni43LTQuMThsLTcuMzItNS42OHoiIGZpbGw9IiNmYmJjMDUiLz48cGF0aCBkPSJNMzEgMTcuNzZjMy4yNCAwIDYuMTIgMS4xMiA4LjQyIDMuMjhsNi4zLTYuM0M0MS45IDExLjE4IDM2Ljk0IDkgMzEgOWMtOC42IDAtMTYuMDIgNC45NC0xOS42NCAxMi4xNGw3LjMyIDUuNjhjMS43NC01LjIgNi42LTkuMDYgMTIuMzItOS4wNnoiIGZpbGw9IiNlYTQzMzUiLz48L2c+PGRlZnM+PGNsaXBQYXRoIGlkPSJBIj48cGF0aCBmaWxsPSIjZmZmIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSg5IDkpIiBkPSJNMCAwaDQ0djQ0SDB6Ii8+PC9jbGlwUGF0aD48L2RlZnM+PC9zdmc+",
  "google-ads": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIj48cmVjdCB4PSI1LjUiIHk9IjMiIHdpZHRoPSI2IiBoZWlnaHQ9IjE4IiByeD0iMyIgZmlsbD0iI0ZCQkMwNCIgdHJhbnNmb3JtPSJyb3RhdGUoMzAgOC41IDEyKSIvPjxyZWN0IHg9IjEyLjUiIHk9IjMiIHdpZHRoPSI2IiBoZWlnaHQ9IjE4IiByeD0iMyIgZmlsbD0iIzQyODVGNCIgdHJhbnNmb3JtPSJyb3RhdGUoLTMwIDE1LjUgMTIpIi8+PGNpcmNsZSBjeD0iNC41IiBjeT0iMTkiIHI9IjMiIGZpbGw9IiMzNEE4NTMiLz48L3N2Zz4K",
  "google-analytics": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIj48cmVjdCB4PSIxNiIgeT0iMiIgd2lkdGg9IjYiIGhlaWdodD0iMjAiIHJ4PSIzIiBmaWxsPSIjRjlBQjAwIi8+PHJlY3QgeD0iOSIgeT0iOSIgd2lkdGg9IjYiIGhlaWdodD0iMTMiIHJ4PSIzIiBmaWxsPSIjRTM3NDAwIi8+PGNpcmNsZSBjeD0iNSIgY3k9IjE5IiByPSIzIiBmaWxsPSIjRTM3NDAwIi8+PC9zdmc+Cg==",
  "google-tag-manager": "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0idXRmLTgiPz4KPHN2ZyB2ZXJzaW9uPSIxLjEiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeG1sbnM6eGxpbms9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiIHg9IjBweCIgeT0iMHB4IgoJIHdpZHRoPSIxOTJweCIgaGVpZ2h0PSIxOTJweCIgdmlld0JveD0iMCAwIDE5MiAxOTIiIGVuYWJsZS1iYWNrZ3JvdW5kPSJuZXcgMCAwIDE5MiAxOTIiIHhtbDpzcGFjZT0icHJlc2VydmUiPgo8cmVjdCBmaWxsPSJub25lIiB3aWR0aD0iMTkyIiBoZWlnaHQ9IjE5MiIvPgo8Zz4KCTxwb2x5Z29uIGZpbGw9IiM4QUI0RjgiIHBvaW50cz0iMTExLjMxLDE3Ni43OSA4MC43NiwxNDcgMTQ2LjM3LDgwIDE3OCwxMTEgCSIvPgoJPHBhdGggZmlsbD0iIzQyODVGNCIgZD0iTTExMS40NCw0NS4wOEw4MSwxNEwxNC40NCw3OS45M2MtOC41OCw4LjU4LTguNTgsMjIuNDksMCwzMS4wOEw4MCwxNzdsMzEtMjlMNjEuMDUsOTUuNDdMMTExLjQ0LDQ1LjA4eiIvPgoJPHBhdGggZmlsbD0iIzhBQjRGOCIgZD0iTTE3Ny41Niw4MC40NGwtNjYtNjZjLTguNTktOC41OS0yMi41Mi04LjU5LTMxLjExLDBjLTguNTksOC41OS04LjU5LDIyLjUyLDAsMzEuMTFsNjYsNjYKCQljOC41OSw4LjU5LDIyLjUyLDguNTksMzEuMTEsMEMxODYuMTUsMTAyLjk2LDE4Ni4xNSw4OS4wMywxNzcuNTYsODAuNDR6Ii8+Cgk8Y2lyY2xlIGZpbGw9IiMyNDZGREIiIGN4PSI5NS41IiBjeT0iMTYyLjUiIHI9IjIxLjUiLz4KPC9nPgo8L3N2Zz4K",
  "granola": "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGcgY2xpcC1wYXRoPSJ1cmwoI2NsaXAwXzE0NTNfMzI4NCkiPgo8cGF0aCBkPSJNMTUuODI1OCAzMS45MTM1QzE5LjEyNjUgMzEuOTEzNSAyMi41ODU4IDMxLjE4MjQgMjMuOTc5MiAzMC4xNjg0QzI0Ljg2OSAyOS41MzM3IDI1LjMxMDUgMjkuNTk1OCAyNi4xMDM3IDI4LjgzNzFDMjYuMzI0NSAyOC42MTYzIDI2LjQyMSAyOC41NTA4IDI2LjQ4MzEgMjguNDg4N0MyOS40OTc1IDI2LjAxMjQgMzEuMjQyNyAyMi44MDgzIDMxLjI0MjcgMTguNjUyM0MzMS4yNDI3IDExLjg5MjMgMjYuNDUyMSA3LjI5MTM3IDE5LjU5OSA3LjI5MTM3QzEzLjU3MDIgNy4yOTEzNyA4Ljk2OTI4IDExLjEzMDEgOC45NjkyOCAxNi4wNDgzQzguOTY5MjggMjAuNTIxNiAxMi40NTk2IDIzLjcyNTcgMTcuNDM5OSAyMy43MjU3QzE3LjcyNjIgMjMuNzI1NyAxNy44NTM4IDIzLjU2NyAxOC4xNzExIDIzLjU2N0MxOS4zNzgzIDIzLjU2NyAyMC4zNjEyIDIzLjIxODcgMjAuOTk1OCAyMi41NTNDMjEuMzEzMSAyMi4yMDQ3IDIxLjkxNjcgMjEuNTA0NiAyMS45Nzg4IDIxLjQ3MzVDMjIuMjY1IDIxLjIxODMgMjIuMzI3MSAyMC44Mzg5IDIyLjM5MjYgMjAuNjgwM0MyMi40NTQ3IDIwLjUyMTYgMjIuNTgyMyAyMC40MjUgMjIuNjQ3OSAyMC4yMDQzQzIyLjcxIDE5Ljk0OTEgMjIuNjE2OCAxOS42MzE4IDIyLjYxNjggMTkuMzQ5QzIyLjYxNjggMTguODQyIDIyLjgzNzYgMTguMzM1IDIyLjgzNzYgMTcuODU5QzIyLjgzNzYgMTYuNTI3NyAyMS4yNTEgMTUuMTkzIDE5LjgyMzIgMTUuMTkzQzE5LjY2NDUgMTUuMTkzIDE5LjY2NDUgMTUuMDY1MyAxOS41Njc5IDE1LjA2NTNDMTkuNDcxNCAxNS4wNjUzIDE5LjM3ODMgMTUuMTYxOSAxOS4yODE3IDE1LjE2MTlDMTkuMTg1MSAxNS4xNjE5IDE5LjA2MDkgMTUuMDAzMyAxOC45MzMzIDE1LjAwMzNDMTguODA1NyAxNS4wMDMzIDE4Ljc0MzYgMTUuMTMwOSAxOC41NTM5IDE1LjEzMDlDMTguMTQwMSAxNS4xMzA5IDE4LjEwOSAxNS4xOTMgMTcuNzkxNyAxNS4xOTNDMTcuNjk1MiAxNS4xOTMgMTcuNTM2NSAxNS4yMjQgMTcuNDc0NCAxNS4yNTVDMTcuMzQ2OCAxNS4zMTcxIDE3LjM0NjggMTUuNDEzNyAxNy4yMTkyIDE1LjQxMzdDMTcuMDQ5MSAxNS40MTM3IDE2Ljk2NCAxNS40NDU5IDE2Ljk2NCAxNS41MTAzQzE2Ljk2NCAxNS44NTg2IDE2Ljk5NSAxNS43OTY1IDE2LjgzNjQgMTUuNzk2NUMxNi42NjYyIDE1Ljc5NjUgMTYuNTYwNCAxNS44MDY5IDE2LjUxOTEgMTUuODI3NkMxNi4zOTE0IDE1Ljg4OTYgMTYuNDg4IDE2LjA0ODMgMTYuMzYwNCAxNi4xNDQ5QzE2LjIzMjggMTYuMjA2OSAxNi4yMDE4IDE2LjMwMzUgMTYuMTcwNyAxNi40OTMyQzE2LjEzOTcgMTYuNjgyOSAxNS45NSAxNi43NDg0IDE1Ljk1IDE2LjkzODFDMTUuOTUgMTcuMDM0NyAxNS45ODEgMTcuMDk2OCAxNS45ODEgMTcuMTU4OUMxNS45ODEgMTcuMzQ4NiAxNS42MDE2IDE3LjI4NjUgMTUuNjAxNiAxNy40NzYyQzE1LjYwMTYgMTcuNjAzOCAxNS42OTgyIDE3LjY5NjkgMTUuNjk4MiAxNy44MjQ1QzE1LjY5ODIgMTcuOTIxMSAxNS42MzYxIDE3Ljk4MzIgMTUuNjM2MSAxOC4wNzk3QzE1LjYzNjEgMTguMTc2MyAxNS42OTgyIDE4LjIzODQgMTUuNjk4MiAxOC4zMDA1QzE1LjY5ODIgMTguNDU5MSAxNS40Nzc1IDE4LjQ5MDIgMTUuNDc3NSAxOC42MTc4QzE1LjQ3NzUgMTguNzQ1NCAxNS42MDUxIDE4LjgzODUgMTUuNjA1MSAxOC45MzUxQzE1LjYwNTEgMTguOTk3MiAxNS41MDg1IDE5LjAzMTYgMTUuNTA4NSAxOS4xMjQ4QzE1LjUwODUgMTkuMjE3OSAxNS40Nzc1IDE5LjA2MjcgMTUuNjY3MiAxOS4zNDU1QzE1Ljc5NDggMTkuNTM1MiAxNS43OTQ4IDE5LjYzMTggMTUuNjY3MiAxOS43OTA0QzE1LjUzOTYgMTkuOTQ5MSAxNS4yODc4IDIwLjA0NTYgMTQuOTcwNSAyMC4wNDU2QzEzLjYzOTIgMjAuMDQ1NiAxMy40ODA1IDE4LjY3OTkgMTIuNzQ5MyAxOC40NTkxQzEyLjUyODYgMTguMzk3IDEyLjQ5NDEgMTguMzYyNiAxMi40OTQxIDE4LjI2OTRDMTIuNDk0MSAxOC4xNzYzIDEyLjQ5NDEgMTguMjA3MyAxMi42MjE3IDE4LjA3OTdDMTIuNzQ5MyAxNy45NTIxIDEyLjc4MDQgMTcuODU5IDEyLjc4MDQgMTcuNzYyNEMxMi43ODA0IDE3LjY2NTkgMTIuNzgwNCAxNy42MzQ4IDEyLjcxODMgMTcuNTcyN0MxMi40NjMxIDE3LjE1ODkgMTIuMzM4OSAxNi42NTE5IDEyLjMzODkgMTYuMDgyOEMxMi4zMzg5IDEzLjE2NSAxNS44OTEzIDEwLjcxOTYgMTkuMjU3NSAxMC43MTk2QzIwLjI3MTUgMTAuNzE5NiAyMC4xMTI5IDEwLjk3NDkgMjAuNzE2NSAxMC45NzQ5QzIwLjg3NTEgMTAuOTc0OSAyMC44MTMgMTAuOTc0OSAyMS4wMzM4IDEwLjk0MzhDMjEuNjA2MyAxMC44NDczIDIyLjY1MTMgMTEuMDcxNCAyMy40NzU2IDExLjQ4MTlDMjUuNzU4OCAxMi42MjM1IDI3LjI1MjIgMTUuMzIwNiAyNy4yNTIyIDE4LjQ2MjZDMjcuMjUyMiAyMy44MjU3IDIyLjQ5MjcgMjcuNzI2NSAxNi4xNDY2IDI3LjcyNjVDMTIuNjg3MyAyNy43MjY1IDEwLjMwNzUgMjYuNjQ3IDcuOTU4NzMgMjQuMDE1NEM3LjcwMzUxIDIzLjcyOTEgOC4wODYzNCAyNC4wNzc1IDcuNjcyNDcgMjMuMzQ5OEM3LjE2NTQ3IDIyLjQ1OTkgNy4yMjc1NSAyMy4wMzI0IDcuMjI3NTUgMjMuMDMyNEM3LjA2ODkgMjIuODQyOCA2Ljc4MjYzIDIyLjMwMTMgNi42MjM5OCAyMi4xMTE2QzYuNDM0MjkgMjEuODkwOCA2LjE3OTA3IDIxLjkyMTkgNi4wODU5NCAyMS43OTQzQzUuOTU4MzMgMjEuNjM1NiA2LjE0ODAzIDIxLjM0OTQgNi4wODU5NCAyMS4xOTA3QzYuMDIzODYgMjAuOTM1NSA1LjQ4MjM3IDIwLjU1NjEgNS40MjAyOSAyMC4zNjY0QzUuMzU4MjEgMjAuMTc2NyA1LjEzNDAzIDE4Ljk2OTYgNS4xMzQwMyAxOC43NDg4QzUuMTM0MDMgMTguNDkzNiA1LjMyMzcyIDE4LjQ2MjYgNS4zMjM3MiAxOC4zMDM5QzUuMzIzNzIgMTguMDgzMiA1LjAzNzQ2IDE4LjAxNzcgNC44Nzg4MSAxNy43MDAzQzQuNzIwMTUgMTcuMzgzIDQuNjIzNTggMTYuNjUxOSA0LjYyMzU4IDE1Ljg1ODZDNC42MjM1OCAxNS40NDQ3IDQuNjIzNTggMTUuMjg2MSA0Ljc1MTE5IDE0LjMzNDJDNC43ODIyNCAxNC4wMTY5IDUuMjU4MTkgMTQuMDE2OSA1LjI1ODE5IDEzLjY2ODVDNS4yNTgxOSAxMy41NDA5IDUuMTk2MTEgMTMuMzgyMiA1LjE5NjExIDEzLjI4OTFDNS4xOTYxMSAxMy4xNjE1IDUuMTk2MTEgMTMuMTMwNSA1LjIyNzE1IDEzLjAzMzlDNi41NTg0NSA3LjQ1MDAzIDEyLjUyNTIgMy4yOTQwMiAxOS4xNTc1IDMuMjk0MDJDMjEuNDQwNyAzLjI5NDAyIDIzLjE4NTkgMy43MDc5IDI1Ljg4MyA0Ljg0OTUxQzI2Ljc3MjggNS4yMjg4OSAyOC4wNzMxIDQuNTYzMjQgMjguMDczMSAzLjg2NjU1QzI4LjEzNTIgMy42NDU4MiAyOC4wMTEgMy41ODAyOSAyNy45NzY1IDMuNDUyNjhDMjcuOTQ1NSAzLjMyNTA2IDI3LjgxNzkgMy4xNjY0MSAyNy42OTAzIDMuMTM1MzdDMjcuNjI4MiAzLjEwNDMzIDI3LjU5MzcgMy4wMDc3NiAyNy41MzE2IDIuOTE0NjRDMjcuNDM1IDIuNzU1OTkgMjcuMzQxOSAyLjY5MzkgMjcuMDg2NyAyLjYyODM3QzI2Ljk1OTEgMi41OTczMyAyNi44OTcgMi41NjYyOSAyNi44MzE1IDIuNTAwNzZDMjYuNzM0OSAyLjM3MzE1IDI2LjY3MjggMi4zMTEwNyAyNi41NDUyIDIuMjQ1NTRDMjYuNDE3NiAyLjE4MzQ2IDI2LjMyNDUgMi4yNDU1NCAyNi4yNTg5IDIuMjE0NUMyNi4xOTY5IDIuMTgzNDYgMjYuMTYyNCAyLjExNzkzIDI2LjEwMDMgMi4wODY4OUMyNi4wNjkyIDIuMDU1ODUgMjYuMDAzNyAyLjA1NTg1IDI1LjkxMDYgMi4wNTU4NUMyMi43MSAwLjM0MTcxIDIwLjYxNjQgMC4wODY0ODY4IDE3LjgyNjIgMC4wODY0ODY4QzExLjc5NzQgMC4wODY0ODY4IDYuNDAzMjUgMi42OTA0NiAzLjA3MTU1IDcuMjI1ODRDMi43ODUyOCA3LjYwNTIzIDIuOTQzOTQgOC4yMzk4NCAyLjUzMzUxIDguNjIyNjdDMS43NDAyNSA5LjM1Mzg1IDAuNzU3Mjk0IDEzLjM1MTIgMC43NTcyOTQgMTUuODg5NkMwLjc1NzI5NCAxOC4wMTQyIDEuMjY0MjkgMjAuODM4OSAxLjkyOTk0IDIyLjM5NDRDMy4yMzAyIDI1LjQzOTggMi42NjExMiAyNC4xNzA2IDIuODUwODIgMjQuNDU2OUMzLjIzMDIgMjUuMDYwNCAzLjU0NzUxIDI1LjEyMjUgMy43MDYxNiAyNS4zMTIyQzMuNzA2MTYgMjUuMzEyMiAzLjgwMjczIDI1LjUwMTkgMy44MDI3MyAyNS42OTE2QzMuODAyNzMgMjUuODE5MiAzLjgwMjczIDI1Ljg1MDMgMy44MzM3NyAyNS45MTIzQzMuOTMwMzQgMjYuMTAyIDQuMzcxODEgMjYuNDE5MyA0LjQ5OTQyIDI2LjU0NjlDNC43ODU2OCAyNi44MzMyIDUuMDA2NDIgMjcuNDM2OCA1LjQ4MjM3IDI3LjkxMjdDNi4yMTM1NiAyOC42NDM5IDcuMjU4NTkgMjkuMjEzIDEwLjU5MDMgMzAuNzY4NUMxMS43NjI5IDMxLjMwNjUgMTEuMDk3MyAzMS4wMjM3IDExLjIyNDkgMzEuMDU0N0MxMS41MTEyIDMxLjE1MTMgMTEuODkwNiAzMS4xNTEzIDEyLjExNDcgMzEuMzFDMTIuMjQyMyAzMS40MDY1IDEyLjA4MzcgMzEuMzcyIDEyLjQzMiAzMS4zNzJDMTIuNDk0MSAzMS4zNzIgMTIuNDk0MSAzMS40MDMxIDEyLjU1OTcgMzEuNDM0MUMxMi42MjE3IDMxLjQ2NTIgMTIuNjg3MyAzMS41NjE3IDEyLjc4MDQgMzEuNTYxN0MxMi44NDI1IDMxLjU2MTcgMTIuODc3IDMxLjQ5OTcgMTIuOTcwMSAzMS41MzA3QzEzLjA2MzIgMzEuNTYxNyAxMy4yODc0IDMxLjcyMDQgMTMuNDc3MSAzMS44MTdDMTMuNjM1NyAzMS45MTM1IDEzLjY2NjggMzEuOTEzNSAxMy43MzIzIDMxLjg0OEMxMy45MjIgMzEuNzIwNCAxNC4wNDk2IDMxLjg3OSAxNC4yMzkzIDMxLjg3OUMxNC4zMDE0IDMxLjg3OSAxNC4zOTc5IDMxLjg0OCAxNC41ODc2IDMxLjg0OEMxNC44NDI5IDMxLjg0OCAxNC44NDI5IDMxLjkxMDEgMTUuODI1OCAzMS45MTAxIiBmaWxsPSIjMUUxRTFFIi8+CjwvZz4KPGRlZnM+CjxjbGlwUGF0aCBpZD0iY2xpcDBfMTQ1M18zMjg0Ij4KPHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiBmaWxsPSJ3aGl0ZSIvPgo8L2NsaXBQYXRoPgo8L2RlZnM+Cjwvc3ZnPgo=",
  "hubspot": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MiIgaGVpZ2h0PSI2MiIgZmlsbD0ibm9uZSIgdmlld0JveD0iMCAwIDYyIDYyIj48cGF0aCBkPSJNNDIuMjY5IDIzLjQ4N3YtNS4yNGE0LjAzIDQuMDMgMCAwIDAgMS42OTItMS40ODEgNC4wMiA0LjAyIDAgMCAwIC42MzUtMi4xNTZ2LS4xMmMwLTIuMjI4LTEuODA2LTQuMDM1LTQuMDM2LTQuMDM1aC0uMTE5Yy0xLjA3MSAwLTIuMDk3LjQyNS0yLjg1MyAxLjE4MnMtMS4xODIgMS43ODMtMS4xODIgMi44NTN2LjEyYTQuMDQgNC4wNCAwIDAgMCAuNjM1IDIuMTU2IDQuMDMgNC4wMyAwIDAgMCAxLjY5MiAxLjQ4MXY1LjI0YTExLjQzIDExLjQzIDAgMCAwLTUuNDM0IDIuMzkyTDE4LjkzIDE0LjY4N2E0LjQ0IDQuNDQgMCAwIDAgLjE2MS0xLjEzMiA0LjU0IDQuNTQgMCAwIDAtLjc2MS0yLjUyNyA0LjU1IDQuNTUgMCAwIDAtNC42NjQtMS45NDIgNC41NSA0LjU1IDAgMCAwLTIuMzMgMS4yNCA0LjU0IDQuNTQgMCAwIDAtMS4yNDcgMi4zMjYgNC41NSA0LjU1IDAgMCAwIC4yNTQgMi42MjcgNC41NiA0LjU2IDAgMCAwIDEuNjczIDIuMDQzIDQuNTQgNC41NCAwIDAgMCAyLjUyMy43N2MuNzg3LS4wMDQgMS41NTktLjIxNCAyLjIzOS0uNjA5bDE0LjE1IDExLjAxMWMtMS4yNzEgMS45Mi0xLjkzNCA0LjE3OS0xLjkwMSA2LjQ4MnMuNzU0IDQuNTQzIDIuMDc4IDYuNDI4bC00LjMwMyA0LjMwNWMtLjM0OS0uMTExLS43MTItLjE3LTEuMDc4LS4xNzUtLjczOC4wMDEtMS40NTkuMjItMi4wNzEuNjMxYTMuNzQgMy43NCAwIDAgMC0xLjM3NSAxLjY3NWMtLjI4Mi42ODItLjM1NCAxLjQzMi0uMjEyIDIuMTU3YTMuNzQgMy43NCAwIDAgMCAyLjkzMiAyLjkzMmMuNzI0LjE0NCAxLjQ3Ni4wNzEgMi4xNTctLjIxMWEzLjczIDMuNzMgMCAwIDAgMS42NzYtMS4zNzRjLjQxLS42MTQuNjMxLTEuMzM1LjYzMS0yLjA3M2EzLjY3IDMuNjcgMCAwIDAtLjE3Ny0xLjA3Nmw0LjI1OS00LjI1OWExMS40OCAxMS40OCAwIDAgMCA0LjcyIDIuMTU0YzEuNzE4LjM0OCAzLjQ5MS4yOTkgNS4xODgtLjE0NHMzLjI2NS0xLjI2OCA0LjU5Mi0yLjQxMyAyLjM3Ni0yLjU3NyAzLjA2My00LjE4OGExMS40NSAxMS40NSAwIDAgMCAuOTA1LTUuMTA5Yy0uMDkxLTEuNzUtLjU4Mi0zLjQ1NS0xLjQzNi00Ljk4NnMtMi4wNDMtMi44NDYtMy40ODQtMy44NDRhMTEuNDggMTEuNDggMCAwIDAtNC44MjItMS45MTh6TTQwLjUwNCA0MC43MmE1LjkgNS45IDAgMCAxLTIuMzA0LS40MDFjLS43MzMtLjI4Ni0xLjQwMS0uNzE2LTEuOTY0LTEuMjY1YTUuODkgNS44OSAwIDAgMS0xLjMxOS0xLjkzMSA1Ljg3IDUuODcgMCAwIDEgMC00LjU4M2MuMzA3LS43MjUuNzU0LTEuMzgyIDEuMzE5LTEuOTNzMS4yMzEtLjk3OSAxLjk2NC0xLjI2NSAxLjUxNy0uNDIyIDIuMzA0LS40MDFjMS41MjQuMDUzIDIuOTcuNjk3IDQuMDMxIDEuNzk0czEuNjUyIDIuNTY0IDEuNjU1IDQuMDktLjU5MSAyLjk5My0xLjY1IDQuMDkxLTIuNTA0IDEuNzQzLTQuMDI5IDEuNzk4IiBmaWxsPSIjZmY3YTU5Ii8+PC9zdmc+",
  "klaviyo": "data:image/svg+xml;base64,PHN2ZyB2ZXJzaW9uPSIxLjEiIGlkPSJMYXllcl8xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB4PSIwcHgiIHk9IjBweCIgdmlld0JveD0iMCAwIDY3LjggNDUuNCIgc3R5bGU9ImVuYWJsZS1iYWNrZ3JvdW5kOm5ldyAwIDAgNjcuOCA0NS40OyIgeG1sOnNwYWNlPSJwcmVzZXJ2ZSI+CiA8Zz4KICA8cGF0aCBkPSJNNjcuOCw0NS40SDBWMGg2Ny44TDUzLjYsMjIuN0w2Ny44LDQ1LjRMNjcuOCw0NS40eiI+CiAgPC9wYXRoPgogPC9nPgo8L3N2Zz4=",
  "linear": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MiIgaGVpZ2h0PSI2MiIgZmlsbD0ibm9uZSIgdmlld0JveD0iMCAwIDYyIDYyIj48ZyBjbGlwLXBhdGg9InVybCgjQSkiIGZpbGw9IiM1ZTZhZDIiPjxwYXRoIGQ9Ik00NS4zNDQgNDcuNzE5Yy40NC0uMzUyLjc5Mi0uNzA0IDEuMTQ0LTEuMTQ0YTIxLjk5IDIxLjk5IDAgMCAwIDAtMzEuMTUyIDIxLjk5IDIxLjk5IDAgMCAwLTMxLjE1MiAwbC0xLjA1NiAxLjIzMiAzMS4wNjQgMzEuMDY0em0tMi42NCAxLjkzNWwtMzAuMzYtMzAuMzZjLS42MTYuOTY4LTEuMTQ0IDEuOTM2LTEuNTg0IDIuOTkybDI4Ljk1MiAyOC45NTJjMS4wNTYtLjQ0IDIuMDI0LS45NjggMi45OTItMS41ODR6bS02LjMzNiAyLjcyOUw5LjYxNiAyNS42MzFjLS4zNTIgMS4zMi0uNTI4IDIuNjQtLjYxNiAzLjk2bDIzLjQwOCAyMy40MDhjMS4zMi0uMDg4IDIuNjQtLjI2NCAzLjk2LS42MTZ6bS04LjguNDQxTDkuMTc2IDM0LjQzMmMuNzA0IDQuNDg4IDIuNzI4IDguNzEyIDYuMTYgMTIuMjMyIDMuNTIgMy4zNDQgNy44MzIgNS40NTYgMTIuMjMyIDYuMTZ6Ii8+PC9nPjxkZWZzPjxjbGlwUGF0aCBpZD0iQSI+PHBhdGggZmlsbD0iI2ZmZiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoOSA5KSIgZD0iTTAgMGg0NHY0NEgweiIvPjwvY2xpcFBhdGg+PC9kZWZzPjwvc3ZnPg==",
  "linkedin": "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjU2IiBoZWlnaHQ9IjI1NiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiBwcmVzZXJ2ZUFzcGVjdFJhdGlvPSJ4TWlkWU1pZCIgdmlld0JveD0iMCAwIDI1NiAyNTYiPjxwYXRoIGQ9Ik0yMTguMTIzIDIxOC4xMjdoLTM3LjkzMXYtNTkuNDAzYzAtMTQuMTY1LS4yNTMtMzIuNC0xOS43MjgtMzIuNC0xOS43NTYgMC0yMi43NzkgMTUuNDM0LTIyLjc3OSAzMS4zNjl2NjAuNDNoLTM3LjkzVjk1Ljk2N2gzNi40MTN2MTYuNjk0aC41MWEzOS45MDcgMzkuOTA3IDAgMCAxIDM1LjkyOC0xOS43MzNjMzguNDQ1IDAgNDUuNTMzIDI1LjI4OCA0NS41MzMgNTguMTg2bC0uMDE2IDY3LjAxM1pNNTYuOTU1IDc5LjI3Yy0xMi4xNTcuMDAyLTIyLjAxNC05Ljg1Mi0yMi4wMTYtMjIuMDA5LS4wMDItMTIuMTU3IDkuODUxLTIyLjAxNCAyMi4wMDgtMjIuMDE2IDEyLjE1Ny0uMDAzIDIyLjAxNCA5Ljg1MSAyMi4wMTYgMjIuMDA4QTIyLjAxMyAyMi4wMTMgMCAwIDEgNTYuOTU1IDc5LjI3bTE4Ljk2NiAxMzguODU4SDM3Ljk1Vjk1Ljk2N2gzNy45N3YxMjIuMTZaTTIzNy4wMzMuMDE4SDE4Ljg5QzguNTgtLjA5OC4xMjUgOC4xNjEtLjAwMSAxOC40NzF2MjE5LjA1M2MuMTIyIDEwLjMxNSA4LjU3NiAxOC41ODIgMTguODkgMTguNDc0aDIxOC4xNDRjMTAuMzM2LjEyOCAxOC44MjMtOC4xMzkgMTguOTY2LTE4LjQ3NFYxOC40NTRjLS4xNDctMTAuMzMtOC42MzUtMTguNTg4LTE4Ljk2Ni0xOC40NTMiIGZpbGw9IiMwQTY2QzIiLz48L3N2Zz4K",
  "meta": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMTcxIiBwcmVzZXJ2ZUFzcGVjdFJhdGlvPSJ4TWlkWU1pZCIgdmlld0JveD0iMCAwIDI1NiAxNzEiPjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iYSIgeDE9IjEzLjg3OCUiIHgyPSI4OS4xNDQlIiB5MT0iNTUuOTM0JSIgeTI9IjU4LjY5NCUiPjxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiMwMDY0RTEiLz48c3RvcCBvZmZzZXQ9IjQwJSIgc3RvcC1jb2xvcj0iIzAwNjRFMSIvPjxzdG9wIG9mZnNldD0iODMlIiBzdG9wLWNvbG9yPSIjMDA3M0VFIi8+PHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjMDA4MkZCIi8+PC9saW5lYXJHcmFkaWVudD48bGluZWFyR3JhZGllbnQgaWQ9ImIiIHgxPSI1NC4zMTUlIiB4Mj0iNTQuMzE1JSIgeTE9IjgyLjc4MiUiIHkyPSIzOS4zMDclIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjMDA4MkZCIi8+PHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjMDA2NEUwIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHBhdGggZmlsbD0iIzAwODFGQiIgZD0iTTI3LjY1MSAxMTIuMTM2YzAgOS43NzUgMi4xNDYgMTcuMjggNC45NSAyMS44MiAzLjY3NyA1Ljk0NyA5LjE2IDguNDY2IDE0Ljc1MSA4LjQ2NiA3LjIxMSAwIDEzLjgwOC0xLjc5IDI2LjUyLTE5LjM3MiAxMC4xODUtMTQuMDkyIDIyLjE4Ni0zMy44NzQgMzAuMjYtNDYuMjc1bDEzLjY3NS0yMS4wMWM5LjQ5OS0xNC41OTEgMjAuNDkzLTMwLjgxMSAzMy4xLTQxLjgwNkMxNjEuMTk2IDQuOTg1IDE3Mi4yOTggMCAxODMuNDcgMGMxOC43NTggMCAzNi42MjUgMTAuODcgNTAuMyAzMS4yNTdDMjQ4LjczNSA1My41ODQgMjU2IDgxLjcwNyAyNTYgMTEwLjcyOWMwIDE3LjI1My0zLjQgMjkuOTMtOS4xODcgMzkuOTQ2LTUuNTkxIDkuNjg2LTE2LjQ4OCAxOS4zNjMtMzQuODE4IDE5LjM2M3YtMjcuNjE2YzE1LjY5NSAwIDE5LjYxMi0xNC40MjIgMTkuNjEyLTMwLjkyNyAwLTIzLjUyLTUuNDg0LTQ5LjYyMy0xNy41NjQtNjguMjczLTguNTc0LTEzLjIzLTE5LjY4NC0yMS4zMTMtMzEuOTA3LTIxLjMxMy0xMy4yMiAwLTIzLjg1OSA5Ljk3LTM1LjgxNSAyNy43NS02LjM1NiA5LjQ0NS0xMi44ODIgMjAuOTU2LTIwLjIwOCAzMy45NDRsLTguMDY2IDE0LjI4OWMtMTYuMjAzIDI4LjcyOC0yMC4zMDcgMzUuMjcxLTI4LjQwOCA0Ni4wNy0xNC4yIDE4LjkxLTI2LjMyNCAyNi4wNzYtNDIuMjg3IDI2LjA3Ni0xOC45MzUgMC0zMC45MS04LjItMzguMzI1LTIwLjU1NkMyLjk3MyAxMzkuNDEzIDAgMTI2LjIwMiAwIDExMS4xNDhsMjcuNjUxLjk4OFoiLz48cGF0aCBmaWxsPSJ1cmwoI2EpIiBkPSJNMjEuODAyIDMzLjIwNkMzNC40OCAxMy42NjYgNTIuNzc0IDAgNzMuNzU3IDAgODUuOTEgMCA5Ny45OSAzLjU5NyAxMTAuNjA1IDEzLjg5N2MxMy43OTggMTEuMjYxIDI4LjUwNSAyOS44MDUgNDYuODUzIDYwLjM2OGw2LjU4IDEwLjk2N2MxNS44ODEgMjYuNDU5IDI0LjkxNyA0MC4wNyAzMC4yMDUgNDYuNDkgNi44MDIgOC4yNDMgMTEuNTY1IDEwLjcgMTcuNzUyIDEwLjcgMTUuNjk1IDAgMTkuNjEyLTE0LjQyMiAxOS42MTItMzAuOTI3bDI0LjM5My0uNzY2YzAgMTcuMjUzLTMuNCAyOS45My05LjE4NyAzOS45NDYtNS41OTEgOS42ODYtMTYuNDg4IDE5LjM2My0zNC44MTggMTkuMzYzLTExLjM5NSAwLTIxLjQ5LTIuNDc1LTMyLjY1NC0xMy4wMDctOC41ODItOC4wODMtMTguNjE1LTIyLjQ0My0yNi4zMzQtMzUuMzUybC0yMi45Ni0zOC4zNTJDMTE4LjUyOCA2NC4wOCAxMDcuOTYgNDkuNzMgMTAxLjg0NSA0My4yM2MtNi41NzgtNi45ODgtMTUuMDM2LTE1LjQyOC0yOC41MzItMTUuNDI4LTEwLjkyMyAwLTIwLjIgNy42NjYtMjcuOTYzIDE5LjM5TDIxLjgwMiAzMy4yMDZaIi8+PHBhdGggZmlsbD0idXJsKCNiKSIgZD0iTTczLjMxMiAyNy44MDJjLTEwLjkyMyAwLTIwLjIgNy42NjYtMjcuOTYzIDE5LjM5LTEwLjk3NiAxNi41NjgtMTcuNjk4IDQxLjI0NS0xNy42OTggNjQuOTQ0IDAgOS43NzUgMi4xNDYgMTcuMjggNC45NSAyMS44Mkw5LjAyNyAxNDkuNDgyQzIuOTczIDEzOS40MTMgMCAxMjYuMjAyIDAgMTExLjE0OCAwIDgzLjc3MiA3LjUxNCA1NS4yNCAyMS44MDIgMzMuMjA2IDM0LjQ4IDEzLjY2NiA1Mi43NzQgMCA3My43NTcgMGwtLjQ0NSAyNy44MDJaIi8+PC9zdmc+",
  "microsoft": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MiIgaGVpZ2h0PSI2MiIgZmlsbD0ibm9uZSIgdmlld0JveD0iMCAwIDYyIDYyIj48cGF0aCBkPSJNMjkuODQyIDEyLjQ3NEw1MyA5djIwLjYxMUgyOS44NDJWMTIuNDc0eiIgZmlsbD0iIzkwYzMwMCIvPjxwYXRoIGQ9Ik05IDE1LjQ4NGwxNy43NTQtMi42MjV2MTYuOTgySDlWMTUuNDg0eiIgZmlsbD0iI2Y4NjcyYyIvPjxwYXRoIGQ9Ik0yOS44NDIgNDkuNTI2TDUzIDUzVjMyLjkzSDI5Ljg0MnYxNi41OTd6IiBmaWxsPSIjZmZjNDAwIi8+PHBhdGggZD0iTTkgNDYuNTE2bDE3Ljc1NCAyLjYyNVYzMi45M0g5djEzLjU4NnoiIGZpbGw9IiMwMGI0ZjIiLz48L3N2Zz4=",
  "notion": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MiIgaGVpZ2h0PSI2MiIgZmlsbD0ibm9uZSIgdmlld0JveD0iMCAwIDYyIDYyIj48cmVjdCB3aWR0aD0iNjIiIGhlaWdodD0iNjIiIHJ4PSIzMSIgZmlsbD0iI2ZmZiIvPjxwYXRoIGZpbGwtcnVsZT0iZXZlbm9kZCIgZD0iTTE3LjI0NSAxNi44MzJjMS4zNjEgMS4xMDYgMS44NzIgMS4wMjIgNC40MjkuODUxbDI0LjEwMy0xLjQ0N2MuNTExIDAgLjA4Ni0uNTEtLjA4NC0uNTk1bC00LjAwMy0yLjg5NGMtLjc2Ny0uNTk1LTEuNzg5LTEuMjc3LTMuNzQ3LTEuMTA3bC0yMy4zMzkgMS43MDJjLS44NTEuMDg0LTEuMDIxLjUxLS42ODIuODUxbDMuMzI0IDIuNjM4em0xLjQ0NyA1LjYxN3YyNS4zNmMwIDEuMzYzLjY4MSAxLjg3MyAyLjIxNCAxLjc4OWwyNi40ODktMS41MzNjMS41MzQtLjA4NCAxLjcwNS0xLjAyMiAxLjcwNS0yLjEyOXYtMjUuMTljMC0xLjEwNS0uNDI1LTEuNzAxLTEuMzY0LTEuNjE2bC0yNy42ODEgMS42MTZjLTEuMDIyLjA4Ni0xLjM2Mi41OTctMS4zNjIgMS43MDN6bTI2LjE1IDEuMzZjLjE3Ljc2NyAwIDEuNTMzLS43NjggMS42MTlsLTEuMjc2LjI1NHYxOC43MjNjLTEuMTA4LjU5Ni0yLjEzLjkzNi0yLjk4MS45MzYtMS4zNjMgMC0xLjcwNS0uNDI2LTIuNzI2LTEuNzAybC04LjM0OC0xMy4xMDZ2MTIuNjhsMi42NDIuNTk2czAgMS41MzEtMi4xMzEgMS41MzFsLTUuODc2LjM0MWMtLjE3MS0uMzQxIDAtMS4xOTEuNTk2LTEuMzYxbDEuNTMzLS40MjVWMjcuMTNsLTIuMTI5LS4xNzFjLS4xNzEtLjc2Ny4yNTUtMS44NzIgMS40NDgtMS45NThsNi4zMDMtLjQyNSA4LjY4OCAxMy4yNzZWMjYuMTA4bC0yLjIxNS0uMjU0Yy0uMTctLjkzNy41MS0xLjYxOCAxLjM2Mi0xLjcwMmw1Ljg3OS0uMzQyek0xMi42NDQgMTEuMDQ1TDM2LjkyIDkuMjU3YzIuOTgxLS4yNTYgMy43NDgtLjA4NCA1LjYyMiAxLjI3N2w3Ljc0OSA1LjQ0N2MxLjI3OS45MzcgMS43MDUgMS4xOTIgMS43MDUgMi4yMTJ2MjkuODcyYzAgMS44NzItLjY4MiAyLjk3OS0zLjA2NiAzLjE0OWwtMjguMTkyIDEuNzAyYy0xLjc5LjA4NS0yLjY0Mi0uMTctMy41NzktMS4zNjJsLTUuNzA3LTcuNDA0Yy0xLjAyMi0xLjM2My0xLjQ0OC0yLjM4My0xLjQ0OC0zLjU3NlYxNC4wMjJjMC0xLjUzMS42ODItMi44MDggMi42NC0yLjk3N3oiIGZpbGw9IiMwMDAiLz48L3N2Zz4=",
  "prismic": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiBmaWxsPSJub25lIiB2aWV3Qm94PSIwIDAgMjU2IDI1NiI+PHN0eWxlPi5maXB7ZmlsbDojMDAwfUBtZWRpYSAocHJlZmVycy1jb2xvci1zY2hlbWU6ZGFyayl7LmZpcHtmaWxsOiNmZmZ9fTwvc3R5bGU+PHBhdGggZD0ibTIzNC4zMzkgMTE0LjM0IDE4LjkyIDE4LjkyYTEuNjAzIDEuNjAzIDAgMCAwIDIuNzM5LTEuMTMxVjgyLjA0M2MwLTI4LjUyOC0yLjk3LTM4Ljg3My04LjU0OS00OS4zMDMtNS41NzctMTAuNDMtMTMuNzYyLTE4LjYxNC0yNC4xOTItMjQuMTkyQzIxMi44MjcgMi45NyAyMDIuNDgyIDAgMTczLjk1MyAwaC0xMC42MjljLTIuMTMgMC00LjE3Mi44NDUtNS42NzYgMi4zNWwtMTguOTIgMTguOTJhMS41OTggMS41OTggMCAwIDAgMS4xMzYgMi43M2gzMC42MDFjMjEuMzk2IDAgMjkuMTU1IDIuMjI3IDM2Ljk3OCA2LjQxIDcuODIxIDQuMTg0IDEzLjk2MSAxMC4zMjMgMTguMTQzIDE4LjE0NSA0LjE4NCA3LjgyMiA2LjQxMiAxNS41OCA2LjQxMiAzNi45Nzd2MjMuMTU3YzAgMi4xMTkuODQyIDQuMTUxIDIuMzQxIDUuNjUxWk0xNDEuNjUgMjM0LjM0OWwtMTguOTIgMTguOTIxYTEuNjAxIDEuNjAxIDAgMCAwIDEuMTM1IDIuNzNoNTAuMDljMjguNTI5IDAgMzguODczLTIuOTcxIDQ5LjMwMy04LjU0OCAxMC40My01LjU3OCAxOC42MTUtMTMuNzY0IDI0LjE5My0yNC4xOTMgNS41NzgtMTAuNDMgOC41NDgtMjAuNzc1IDguNTQ4LTQ5LjMwM3YtMTAuNjQ3YTcuOTkgNy45OSAwIDAgMC0yLjM0Mi01LjY1MWwtMTguOTE5LTE4LjkxOWExLjYwNCAxLjYwNCAwIDAgMC0yLjczOCAxLjEzdjMwLjU5OWMwIDIxLjM5NS0yLjIyOSAyOS4xNTQtNi40MTIgMzYuOTc2LTQuMTg0IDcuODIzLTEwLjMyMiAxMy45NjEtMTguMTQ1IDE4LjE0NS03LjgyMSA0LjE4My0xNS41OCA2LjQxLTM2Ljk3NiA2LjQxaC0yMy4xNDFjLTIuMTMgMC00LjE3Mi44NDYtNS42NzYgMi4zNVpNMi43MzggMTIyLjczOGwxOC45MiAxOC45MmE3Ljk5IDcuOTkgMCAwIDEgMi4zNDIgNS42NXYyMy4xNThjMCAyMS4zOTYgMi4yMjggMjkuMTU0IDYuNDExIDM2Ljk3NiA0LjE4MyA3LjgyMyAxMC4zMjIgMTMuOTYxIDE4LjE0NSAxOC4xNDUgNy44MjIgNC4xODQgMTUuNTggNi40MTIgMzYuOTc3IDYuNDEyaDMwLjYwMWExLjYgMS42IDAgMCAxIDEuMTM2IDIuNzI5bC0xOC45MjEgMTguOTIxYTguMDI2IDguMDI2IDAgMCAxLTUuNjc1IDIuMzQ5aC0xMC42M2MtMjguNTI4IDAtMzguODc0LTIuOTctNDkuMzAzLTguNTQ4LTEwLjQzLTUuNTc4LTE4LjYxNS0xMy43NjMtMjQuMTkzLTI0LjE5M0MyLjk3IDIxMi44MjggMCAyMDIuNDgyIDAgMTczLjk1NXYtNTAuMDg2YTEuNjAyIDEuNjAyIDAgMCAxIDIuNzM4LTEuMTMxWk0xMTQuMzQ4IDIxLjY1IDEzMy4yNyAyLjczQTEuNjAyIDEuNjAyIDAgMCAwIDEzMi4xMzQgMGgtNTAuMDlDNTMuNTE2IDAgNDMuMTcgMi45NyAzMi43NDEgOC41NDggMjIuMzEgMTQuMTI2IDE0LjEyNiAyMi4zMTEgOC41NDggMzIuNzQgMi45NyA0My4xNyAwIDUzLjUxNSAwIDgyLjA0M1Y5Mi42OWE3Ljk5IDcuOTkgMCAwIDAgMi4zNDIgNS42NTFsMTguOTIgMTguOTJBMS42MDIgMS42MDIgMCAwIDAgMjQgMTE2LjEzVjg1LjUzMmMwLTIxLjM5NiAyLjIyOC0yOS4xNTUgNi40MTEtMzYuOTc3IDQuMTgzLTcuODIyIDEwLjMyMi0xMy45NiAxOC4xNDUtMTguMTQ0QzU2LjM3OCAyNi4yMjcgNjQuMTM2IDI0IDg1LjUzMiAyNGgyMy4xNDFhOC4wMiA4LjAyIDAgMCAwIDUuNjc0LTIuMzVaIiBjbGFzcz0iZmlwIi8+PHBhdGggZD0ibTIxMy4yODggOTMuNDA0LTI1Ljc5OS0yNC42NTdhMTUuOTQgMTUuOTQgMCAwIDAtNS44My0zLjcyMSAxNS45NjUgMTUuOTY1IDAgMCAwLTUuNjU4LTEuMDNIOTkuODQ4YTEuNTk4IDEuNTk4IDAgMCAxLTEuMTM1LTIuNzNsMTguOTM5LTE4LjkyMmE4LjAyNyA4LjAyNyAwIDAgMSA1LjY3My0yLjM0N2g2MC42NzZjMTcuNjczIDAgMzIgMTQuMzI2IDMyIDMydjIwLjI1MWMwIC44ODQtLjcxOCAxLjYtMS42MDMgMS42YTEuNjEgMS42MSAwIDAgMS0xLjExLS40NDRabS0yNi4wNCA5NC4xLTI0LjY2NCAyNS44MDdhMS42MDIgMS42MDIgMCAwIDAgMS4xNiAyLjcwNWgyMC4yNTVjMTcuNjc0IDAgMzItMTQuMzI3IDMyLTMyLjAwMXYtNjAuNjkxYTcuOTkgNy45OSAwIDAgMC0yLjM0LTUuNjQ5bC0xOC45MjEtMTguOTM3YTEuNjAyIDEuNjAyIDAgMCAwLTIuNzM5IDEuMTN2NzYuMTQ4YzAgMS45OTEtLjM2NCAzLjg5OC0xLjAyOSA1LjY1N2ExNS45MzMgMTUuOTMzIDAgMCAxLTMuNzIyIDUuODMxWm0tMTQ0LjUzLTI0LjkxMSAyNS43OTkgMjQuNjU3YTE1Ljk1MiAxNS45NTIgMCAwIDAgNS44MyAzLjcyMUExNS45NjcgMTUuOTY3IDAgMCAwIDgwLjAwNSAxOTJoNzYuMTUyYy44ODYgMCAxLjYwNC43MTcgMS42MDQgMS42MDEgMCAuNDIzLS4xNjkuODI5LS40NjkgMS4xM2wtMTguOTM4IDE4LjkyMkE4LjAzIDguMDMgMCAwIDEgMTMyLjY4IDIxNkg3Mi4wMDVjLTE3LjY3MyAwLTMyLTE0LjMyNy0zMi0zMnYtMjAuMjUyYTEuNjA2IDEuNjA2IDAgMCAxIDIuNzEzLTEuMTU1Wm0yNi4wMzctOTQuMDg1TDkzLjQyIDQyLjcwMWExLjU5OCAxLjU5OCAwIDAgMC0xLjE2LTIuNzA0SDcyLjAwNWMtMTcuNjczIDAtMzIgMTQuMzI2LTMyIDMydjYwLjY5MmE3Ljk5IDcuOTkgMCAwIDAgMi4zNCA1LjY0OGwxOC45MiAxOC45MzdhMS42MDUgMS42MDUgMCAwIDAgMi43NC0xLjEyOVY3OS45OTZjMC0xLjk5Mi4zNjQtMy44OTkgMS4wMy01LjY1OGExNS45MzcgMTUuOTM3IDAgMCAxIDMuNzItNS44M1oiIGNsYXNzPSJmaXAiLz48L3N2Zz4=",
  "salesforce": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MiIgaGVpZ2h0PSI2MiIgZmlsbD0ibm9uZSIgdmlld0JveD0iMCAwIDYyIDYyIj48bWFzayBpZD0iQSIgbWFza1VuaXRzPSJ1c2VyU3BhY2VPblVzZSIgeD0iOSIgeT0iMTYiIHdpZHRoPSI0NCIgaGVpZ2h0PSIzMSI+PHBhdGggZD0iTTUzIDE2SDl2MzAuNzg0aDQ0VjE2eiIgZmlsbD0iI2ZmZiIvPjwvbWFzaz48ZyBtYXNrPSJ1cmwoI0EpIj48bWFzayBpZD0iQiIgbWFza1VuaXRzPSJ1c2VyU3BhY2VPblVzZSIgeD0iOSIgeT0iMTYiIHdpZHRoPSI0NCIgaGVpZ2h0PSIzMSI+PHBhdGggZD0iTTkuMDExIDE2LjA4MUg1Mi44NXYzMC42MjNIOS4wMTFWMTYuMDgxeiIgZmlsbD0iIzAwYTFlMCIvPjwvbWFzaz48ZyBtYXNrPSJ1cmwoI0IpIj48cGF0aCBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik0yNy4yMTIgMTkuNDMzYzEuNDE2LTEuNDczIDMuMzg0LTIuMzg1IDUuNTYxLTIuMzg1IDIuOTAxIDAgNS40MTQgMS42MTIgNi43NjggNC4wMTMgMS4yMDItLjUzNyAyLjUwNC0uODE0IDMuODE5LS44MTQgNS4yMjIgMCA5LjQ2MyA0LjI3MSA5LjQ2MyA5LjU0MXMtNC4yNCA5LjU0MS05LjQ2MyA5LjU0MWMtLjYzNyAwLTEuMjYtLjA2NC0xLjg3LS4xODUtMS4xODQgMi4xMTEtMy40NDggMy41NDUtNi4wMjcgMy41NDUtMS4wNS4wMDItMi4wODUtLjIzNi0zLjAyOS0uNjk1LTEuMjAyIDIuODIxLTMuOTk3IDQuODAyLTcuMjUzIDQuODAyLTMuNDAxIDAtNi4yODUtMi4xNDQtNy4zOTgtNS4xNTdhNy4xOSA3LjE5IDAgMCAxLTEuNTA1LjE1NWMtNC4wNDYgMC03LjMxOS0zLjMyLTcuMzE5LTcuMzk3YTcuNDMgNy40MyAwIDAgMSAzLjY2LTYuNDEzYy0uNDY1LTEuMDY4LS43MDItMi4yMjEtLjcwMi0zLjM4NSAwLTQuNzA2IDMuODE5LTguNTEgOC41MjYtOC41MWE4LjQ5IDguNDkgMCAwIDEgNi43NyAzLjM1MiIgZmlsbD0iIzAwYTFlMCIvPjwvZz48cGF0aCBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik0xNS4zNDkgMzIuMDA2Yy0uMDI3LjA3MS4wMTEuMDg2LjAxOC4wOTkuMDgyLjA2LjE2Ny4xMDIuMjUxLjE1Mi40NDguMjM2Ljg3MS4zMDUgMS4zMTIuMzA1LjkgMCAxLjQ2LS40NzkgMS40Ni0xLjI0OXYtLjAxNWMwLS43MTItLjYzMy0uOTcxLTEuMjIyLTEuMTU4bC0uMDc3LS4wMjRjLS40NDgtLjE0NS0uODMyLS4yNzEtLjgzMi0uNTY1di0uMDE1YzAtLjI1MS4yMjUtLjQzNy41NzQtLjQzN2EyLjYgMi42IDAgMCAxIDEuMTQxLjI5M3MuMDg4LjA1Ny4xMTktLjAyN2wuMTg1LS40OTRjLjAxNy0uMDQ4LS4wMTMtLjA4Mi0uMDQ0LS4xMDEtLjMzOC0uMjA3LS44MDctLjM0OC0xLjI5LS4zNDhoLS4wOWMtLjgyMyAwLTEuMzk5LjQ5OS0xLjM5OSAxLjIxMXYuMDE1YzAgLjc1Mi42MzUuOTk3IDEuMjI5IDEuMTY3bC4wOTUuMDI5Yy40MzIuMTMyLjgwNS4yNDcuODA1LjU1MXYuMDE1YzAgLjI4LS4yNDMuNDg3LS42MzMuNDg3LS4xNTIgMC0uNjM1LS4wMDItMS4xNTgtLjMzM2wtLjE1LS4wOTNjLS4wMjYtLjAxNy0uMDktLjA0NC0uMTE3LjA0bC0uMTc3LjQ5NnptMTMuMTY3LS4wMDJjLS4wMjcuMDcxLjAxMS4wODYuMDIuMDk5LjA4Mi4wNi4xNjYuMTA0LjI0OS4xNTIuNDQ4LjIzOC44NzEuMzA2IDEuMzEzLjMwNi44OTggMCAxLjQ1OC0uNDc3IDEuNDU4LTEuMjQ4di0uMDE2YzAtLjcxMi0uNjMxLS45NzEtMS4yMjItMS4xNTZsLS4wNzctLjAyNmMtLjQ0Ni0uMTQ0LS44MzItLjI3MS0uODMyLS41NjN2LS4wMTdjMC0uMjUxLjIyNy0uNDM1LjU3NC0uNDM1YTIuNjIgMi42MiAwIDAgMSAxLjE0My4yOTFzLjA4Ni4wNTcuMTE5LS4wMjdsLjE4MS0uNDk0Yy4wMTgtLjA0OC0uMDEzLS4wODItLjA0Mi0uMTAxLS4zMzgtLjIwNy0uODA3LS4zNDYtMS4yOS0uMzQ2aC0uMDljLS44MjUgMC0xLjM5OS40OTgtMS4zOTkgMS4yMDl2LjAxNmMwIC43NS42MzUuOTk1IDEuMjI3IDEuMTY1bC4wOTUuMDI5Yy40MzMuMTM0LjgwNy4yNDkuODA3LjU1MXYuMDE3YzAgLjI3OC0uMjQzLjQ4Ny0uNjMzLjQ4N2EyLjEyIDIuMTIgMCAwIDEtMS4xNi0uMzM1bC0uMTQ4LS4wOTNjLS4wMTYtLjAwOS0uMDkzLS4wNC0uMTE5LjA0MmwtLjE3OC40OTJtOC45OTQtMS41MDljMCAuNDM1LS4wODIuNzc5LS4yNCAxLjAyM3MtLjM5OS4zNTgtLjczMi4zNTgtLjU3My0uMTE3LS43My0uMzU3LS4yMzYtLjU4Ny0uMjM2LTEuMDIzLjA3OS0uNzc2LjIzNi0xLjAxNy4zOTMtLjM1My43My0uMzUzLjU3My4xMTcuNzMyLjM1M2MuMTU5LjI0MS4yNC41OC4yNCAxLjAxNXptLjc1LS44MDVhMS44MiAxLjgyIDAgMCAwLS4zNC0uNjUzYy0uMTU0LS4xODMtLjM0Ny0uMzMxLS41NzgtLjQzOXMtLjQ5OS0uMTYxLS44MDUtLjE2MS0uNTc2LjA1NS0uODA3LjE2MS0uNDI0LjI1Ni0uNTc2LjQzOS0uMjY5LjQwMi0uMzQyLjY1My0uMTEyLjUyLS4xMTIuODA3YTIuODYgMi44NiAwIDAgMCAuMTEyLjgwOCAxLjgxIDEuODEgMCAwIDAgLjM0Mi42NTMgMS42MSAxLjYxIDAgMCAwIC41NzYuNDM0Yy4yMy4xMDYuNTAxLjE1OS44MDcuMTU5cy41NzQtLjA1My44MDMtLjE1OWExLjYzIDEuNjMgMCAwIDAgLjU3OC0uNDM0IDEuODcgMS44NyAwIDAgMCAuMzQyLS42NTMgMi44NiAyLjg2IDAgMCAwIC4xMS0uODA4YzAtLjI4Ny0uMDM3LS41NTgtLjExLS44MDd6bTYuMTcyIDIuMDYzYy0uMDI0LS4wNzMtLjA5NS0uMDQ2LS4wOTUtLjA0Ni0uMTEuMDQyLS4yMjcuMDgxLS4zNDkuMDk5cy0uMjY1LjAzMS0uNDEyLjAzMWMtLjM2MiAwLS42NTMtLjExLS44Ni0uMzI0cy0uMzI0LS41NTgtLjMyMi0xLjAyNmMuMDAyLS40MjYuMTA0LS43NDQuMjg5LS45OXMuNDYzLS4zNjguODMyLS4zNjhjLjMwOSAwIC41NDcuMDM3Ljc5Ni4xMTMgMCAwIC4wNTguMDI2LjA4Ni0uMDUxbC4xODctLjUxMmMuMDE4LS4wNTgtLjAyOS0uMDgyLS4wNDgtLjA5LS4wOTctLjAzNy0uMzI3LS4wOTktLjUwMS0uMTI2YTMuOTQgMy45NCAwIDAgMC0uNTY1LS4wMzcgMi4wMyAyLjAzIDAgMCAwLS44MzYuMTYxIDEuNzMgMS43MyAwIDAgMC0uNjA0LjQzN2MtLjE2MS4xODUtLjI4NC40MDQtLjM2Ni42NTNzLS4xMjIuNTIxLS4xMjIuODA4YzAgLjYyMi4xNjYgMS4xMjcuNDk5IDEuNDk2cy44MzIuNTU4IDEuNDgzLjU1OGEzLjA2IDMuMDYgMCAwIDAgMS4wNjMtLjE5cy4wNTUtLjAyNi4wMzEtLjA5bC0uMTg3LS41MDh6bTEuMzE1LTEuNjc3Yy4wMzUtLjI0MS4xMDEtLjQ0My4yMDUtLjU5OC4xNTctLjI0LjM5My0uMzcuNzI4LS4zN3MuNTU0LjEzMi43MTIuMzdjLjEwNC4xNTcuMTUuMzY2LjE2OC41OThoLTEuODIyLjAwOXptMi41My0uNTNjLS4wNjQtLjI0MS0uMjIzLS40ODUtLjMyNi0uNTk2LS4xNjUtLjE3Ni0uMzI0LS4yOTgtLjQ4My0uMzY2LS4yMy0uMDk5LS40NzktLjE0OC0uNzMtLjE0OC0uMzE3IDAtLjYwNS4wNTMtLjg0LjE2M3MtLjQzLjI2LS41ODUuNDQ2YTEuODMgMS44MyAwIDAgMC0uMzQ0LjY2Yy0uMDc1LjI1MS0uMTEyLjUyMy0uMTEyLjgxIDAgLjI5NC4wMzguNTY3LjExNS44MTJhMS42NiAxLjY2IDAgMCAwIDEuMDA4IDEuMDdjLjI1OC4xMDEuNTY5LjE1Mi45MjQuMTUuNzM1LS4wMDIgMS4xMjMtLjE2NiAxLjI4MS0uMjU0LjAyNy0uMDE3LjA1NS0uMDQ0LjAyMi0uMTIzbC0uMTY2LS40NjVjLS4wMjYtLjA2OS0uMDk1LS4wNDQtLjA5NS0uMDQ0LS4xODMuMDY4LS40NDEuMTktMS4wNDUuMTg4LS4zOTUtLjAwMi0uNjg4LS4xMTctLjg3MS0uM3MtLjI4LS40NTktLjI5NS0uODQ3bDIuNTQ2LjAwMnMuMDY2IDAgLjA3My0uMDY2Yy4wMDQtLjAyNy4wODgtLjUyMS0uMDc1LTEuMDk0aC0uMDA0em0tMjIuODg3LjUzYy4wMzctLjI0MS4xMDItLjQ0My4yMDctLjU5OC4xNTUtLjI0LjM5My0uMzcuNzI4LS4zN3MuNTU0LjEzMi43MTIuMzdjLjEwNC4xNTcuMTUuMzY2LjE2OC41OThoLTEuODIyLjAwN3ptMi41MzItLjUzYy0uMDY0LS4yNDEtLjIyMy0uNDg1LS4zMjYtLjU5Ni0uMTY1LS4xNzYtLjMyNC0uMjk4LS40ODUtLjM2Ni0uMjMtLjA5OS0uNDc3LS4xNDgtLjcyOC0uMTQ4LS4zMTYgMC0uNjA1LjA1My0uODQuMTYzYTEuNjggMS42OCAwIDAgMC0uNTg1LjQ0NmMtLjE1NC4xODctLjI3MS40MDgtLjM0NC42NnMtLjExMi41MjMtLjExMi44MWMwIC4yOTQuMDM4LjU2Ny4xMTUuODEyYTEuNjggMS42OCAwIDAgMCAxLjAwOCAxLjA3Yy4yNTYuMTAxLjU2NS4xNTIuOTI0LjE1LjczNC0uMDAyIDEuMTIxLS4xNjYgMS4yNzktLjI1NC4wMjctLjAxNy4wNTUtLjA0NC4wMjItLjEyM2wtLjE2Ni0uNDY1Yy0uMDI2LS4wNjktLjA5NS0uMDQ0LS4wOTUtLjA0NC0uMTgzLjA2OC0uNDQxLjE5LTEuMDQ0LjE4OC0uMzkzLS4wMDItLjY4OC0uMTE3LS44NzEtLjNzLS4yOC0uNDU5LS4yOTUtLjg0N2wyLjU0Ni4wMDJzLjA2NiAwIC4wNzMtLjA2NmMuMDA0LS4wMjcuMDg4LS41MjEtLjA3NS0xLjA5NGgtLjAwMnptLTguMDI3IDIuMTkxYy0uMTAxLS4wODEtLjExMy0uMDk5LS4xNDYtLjE1Mi0uMDUxLS4wNzctLjA3Ny0uMTg5LS4wNzctLjMyOSAwLS4yMjMuMDc1LS4zODQuMjI3LS40OTItLjAwMiAwIC4yMi0uMTkuNzM5LS4xODNhNS4xNSA1LjE1IDAgMCAxIC42OS4wNTl2MS4xNTZzLS4zMjIuMDY4LS42ODYuMDljLS41MTguMDMxLS43NDYtLjE0OC0uNzQ1LS4xNDhoLS4wMDJ6bTEuMDEyLTEuNzg5bC0uMzk3LS4wMTFhMi4zOSAyLjM5IDAgMCAwLS42MjQuMDgxIDEuNjEgMS42MSAwIDAgMC0uNTMuMjQ1IDEuMjUgMS4yNSAwIDAgMC0uMzY5LjQxOWMtLjA5LjE2OC0uMTM1LjM2Ni0uMTM1LjU4NyAwIC4yMjcuMDM4LjQyMS4xMTUuNThhMS4wNSAxLjA1IDAgMCAwIC4zMzMuMzk5Yy4xNDEuMTAyLjMxNS4xNzkuNTE4LjIyM3MuNDI0LjA3LjY3My4wN2E0LjY5IDQuNjkgMCAwIDAgLjc3Mi0uMDY0bC42NC0uMTI0LjE3OS0uMDQ2Yy4wNjItLjAxNy4wNTctLjA4Mi4wNTctLjA4MmwtLjAwMi0yLjMyMWMwLS41MDktLjEzNS0uODg5LS40MDQtMS4xMjFzLS42NTktLjM1MS0xLjE2Ny0uMzUxYTQuMiA0LjIgMCAwIDAtLjY4LjA2MnMtLjU1NC4xMDgtLjc4NS4yODdjMCAwLS4wNDkuMDMxLS4wMjIuMTAxbC4xODEuNDgzYy4wMjIuMDY0LjA4Mi4wNDIuMDgyLjA0MnMuMDItLjAwNy4wNDItLjAyMmMuNDg4LS4yNjUgMS4xMDctLjI1OCAxLjEwNy0uMjU4LjI3NCAwIC40ODguMDU3LjYyOS4xNjVzLjIxLjI2OS4yMS42MDd2LjEwNmwtLjQxOS0uMDQ5LS4wMDQtLjAwNnptMjAuNDY5LTEuMzFjLjAwNC0uMDA5LjAwNS0uMDE4LjAwNS0uMDI3cy0uMDAyLS4wMTgtLjAwNS0uMDI3LS4wMDktLjAxNy0uMDE1LS4wMjItLjAxNS0uMDEzLS4wMjQtLjAxNWMtLjA0NC0uMDE3LS4yNi0uMDYyLS40MjQtLjA3My0uMzItLjAyLS40OTguMDMzLS42NTcuMTA2cy0uMzMzLjE4NS0uNDI4LjMxN2wtLjAwMi0uMzA5YzAtLjA0Mi0uMDI5LS4wNzctLjA3My0uMDc3aC0uNjQ5Yy0uMDQ0IDAtLjA3My4wMzUtLjA3My4wNzd2My43ODhjMCAuMDIuMDA3LjAzOC4wMjIuMDUzcy4wMzUuMDI0LjA1NS4wMjRoLjY2OGMuMDIgMCAuMDQtLjAwOS4wNTMtLjAyNHMuMDI0LS4wMzMuMDI0LS4wNTN2LTEuOTAyYzAtLjI1NC4wMjctLjUwOC4wODQtLjY2OHMuMTMtLjI4NC4yMjEtLjM3M2EuNzYuNzYgMCAwIDEgLjMxNS0uMTg4IDEuMjEgMS4yMSAwIDAgMSAuMzQyLS4wNDkgMS4zOSAxLjM5IDAgMCAxIC4yNzguMDM1Yy4wNDkuMDA2LjA3Ny0uMDI0LjA5My0uMDY5bC4xOTItLjUzMiIgZmlsbD0iI2ZmZmZmZSIvPjxwYXRoIGZpbGwtcnVsZT0iZXZlbm9kZCIgZD0iTTM1LjE0MiAyNi44ODhjLS4wODItLjAyNi0uMTY1LS4wNDYtLjI1MS0uMDZhMS45OSAxLjk5IDAgMCAwLS4zNDYtLjAyNmMtLjQ1OSAwLS44MjEuMTMtMS4wNzUuMzg2cy0uNDI2LjY0Mi0uNTEyIDEuMTUybC0uMDMxLjE3MmgtLjU3NnMtLjA3MS0uMDAyLS4wODYuMDc1bC0uMDk1LjUyOWMtLjAwNS4wNTEuMDE2LjA4Mi4wODQuMDgyaC41NjJsLS41NzEgMy4xODFjLS4wNDQuMjU2LS4wOTUuNDY4LS4xNTIuNjI3cy0uMTEuMjc2LS4xNzcuMzYtLjEyNi4xNDUtLjIzMi4xODFhLjk1Ljk1IDAgMCAxLS4zLjA0MiAxLjA4IDEuMDggMCAwIDEtLjIwMy0uMDIyYy0uMDYtLjAxMy0uMDkzLS4wMjYtLjEzNy0uMDQ0IDAgMC0uMDY2LS4wMjYtLjA5My4wNGwtLjE4OC41MThjLS4wMTYuMDQ5LjAwNy4wOS4wNC4xMDFhMS43MyAxLjczIDAgMCAwIC4yMzIuMDY4Yy4xNDEuMDMzLjI2LjAzNS4zNzEuMDM1LjIzNCAwIC40NDgtLjAzMy42MjYtLjA5NXMuMzMxLS4xNzguNDY4LS4zMjljLjE0OC0uMTYzLjI0Mi0uMzM1LjMzMS0uNTY5cy4xNjMtLjUxOC4yMjMtLjg1NGwuNTczLTMuMjRoLjgzOHMuMDcxLjAwMi4wODYtLjA3NWwuMDkzLS41MjljLjAwNy0uMDQ5LS4wMTUtLjA4Mi0uMDgyLS4wODJoLS44MTJjLjAwNC0uMDE4LjA0LS4zMDQuMTMzLS41NzJhLjcyLjcyIDAgMCAxIC4xNzktLjI3MS41NC41NCAwIDAgMSAuMjEyLS4xMzRjLjA4OC0uMDI3LjE4MS0uMDQuMjczLS4wMzguMDc3IDAgLjE1Mi4wMDkuMjA5LjAybC4xMy4wMzNjLjA4NC4wMjQuMDk1IDAgLjExMi0uMDRsLjE5NC0uNTM0Yy4wMi0uMDU3LS4wMjktLjA4MS0uMDQ4LS4wODh6bS0xMS4zNTggNS40OTljMCAuMDQyLS4wMzEuMDc3LS4wNzMuMDc3aC0uNjczYy0uMDQ0IDAtLjA3My0uMDM1LS4wNzMtLjA3N3YtNS40MjdjMC0uMDQyLjAyOS0uMDc3LjA3My0uMDc3aC42NzNjLjA0MiAwIC4wNzMuMDM1LjA3My4wNzd2NS40Mjd6IiBmaWxsPSIjZmZmZmZlIi8+PC9nPjwvc3ZnPg==",
  "search-console": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIj48Y2lyY2xlIGN4PSIxMCIgY3k9IjEwIiByPSI2LjUiIHN0cm9rZT0iIzQyODVGNCIgc3Ryb2tlLXdpZHRoPSIzIi8+PGNpcmNsZSBjeD0iMTAiIGN5PSIxMCIgcj0iMi4yNSIgZmlsbD0iIzQyODVGNCIvPjxwYXRoIGQ9Ik0xNSAxNWw1LjUgNS41IiBzdHJva2U9IiMxQTczRTgiIHN0cm9rZS13aWR0aD0iMy41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48L3N2Zz4K",
  "shopify": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MiIgaGVpZ2h0PSI2MiIgZmlsbD0ibm9uZSIgdmlld0JveD0iMCAwIDYyIDYyIj48cGF0aCBkPSJNNDUuMTY3IDE3LjQ3MmMtLjAyOS0uMjIyLS4yMTItLjM0NS0uMzY2LS4zNTlzLTMuMTEyLS4wNjEtMy4xMTItLjA2MWwtMi43MjQtMi44MDNjLS4yNDYtLjI1OS0uNzIzLS4xODEtLjkwOC0uMTIybC0xLjI0Ni40MDhhOS41MSA5LjUxIDAgMCAwLS41OTUtMS41NDhjLS44ODItMS43OC0yLjE3My0yLjcyMS0zLjczNS0yLjcyNGgtLjAwNmMtLjEwOCAwLS4yMTYuMDExLS4zMjQuMDIxbC0uMTQxLS4xNzJjLS42OC0uNzY5LTEuNTUtMS4xNDQtMi41OTYtMS4xMTEtMi4wMTYuMDYxLTQuMDI0IDEuNi01LjY1MSA0LjMzNS0xLjE0NiAxLjkyNC0yLjAxOCA0LjM0MS0yLjI2NiA2LjIxMmwtMy45NjkgMS4zYy0xLjE2Ny4zODgtMS4yMDUuNDI2LTEuMzU4IDEuNTkxTDEzIDQ4LjMxNWwyNS42MjEgNC42ODUgMTEuMTA0LTIuOTE5LTQuNTU5LTMyLjYwOHptLTkuNjM4LTIuNTE3bC0xLjk4OS42NTFjLS4wMTQtMS4wNzktLjEzNi0yLjU4MS0uNjExLTMuODc4IDEuNTMxLjMwNiAyLjI4MyAyLjEzNiAyLjYgMy4yMjd6bS0zLjMyOSAxLjA5bC00LjI3OCAxLjRjLjQxNS0xLjY3NCAxLjE5OS0zLjM0IDIuMTYyLTQuNDMyLjM1OC0uNDA3Ljg1OS0uODU5IDEuNDUyLTEuMTE4LjU1OCAxLjIzLjY3OCAyLjk3Mi42NjQgNC4xNXptLTIuNzQ3LTUuNjI1Yy40NzQtLjAxMS44NzIuMDk5IDEuMjEyLjMzNS0uNTQ0LjI5OS0xLjA3MS43MjktMS41NjQgMS4yODktMS4yODEgMS40NTMtMi4yNjIgMy43MDctMi42NTUgNS44ODNsLTMuNTEzIDEuMTVjLjY5NC0zLjQyNCAzLjQwOS04LjU2MiA2LjUyLTguNjU3eiIgZmlsbD0iIzk1YmY0NyIvPjxwYXRoIGQ9Ik00NC44MDEgMTcuMTE2Yy0uMTUxLS4wMTMtMy4xMTQtLjA2MS0zLjExNC0uMDYxbC0yLjcyMi0yLjgwM2EuNTkuNTkgMCAwIDAtLjM0NC0uMTY3VjUzbDExLjEwNC0yLjkxOS00LjU1OS0zMi42MDdjLS4wMjktLjIyMi0uMjE0LS4zNDUtLjM2NS0uMzU5eiIgZmlsbD0iIzVlOGUzZSIvPjxwYXRoIGQ9Ik0zMi40NjcgMjMuMTUxbC0xLjI4OSA1LjEwMXMtMS40NC0uNjkyLTMuMTQ0LS41NzhjLTIuNTAxLjE2Ni0yLjUyOSAxLjgzNC0yLjUwMyAyLjI1Mi4xMzcgMi4yODEgNS44MTQgMi43OCA2LjEzMyA4LjEyNS4yNSA0LjIwMy0yLjExIDcuMDgtNS41MSA3LjMwNy00LjA4MS4yNzItNi4zMjktMi4yNzMtNi4zMjktMi4yNzNsLjg2NS0zLjg4OXMyLjI2NCAxLjgwMyA0LjA3MyAxLjY4M2MxLjE4My0uMDc5IDEuNjA1LTEuMDk3IDEuNTYyLTEuODE2LS4xNzktMi45NzUtNC44LTIuOC01LjA5My03LjY5MS0uMjQ2LTQuMTEzIDIuMzExLTguMjg0IDcuOTUtOC42NiAyLjE3My0uMTQ4IDMuMjg1LjQzOCAzLjI4NS40Mzh6IiBmaWxsPSIjZmZmIi8+PC9zdmc+",
  "slack": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MiIgaGVpZ2h0PSI2MiIgZmlsbD0ibm9uZSIgdmlld0JveD0iMCAwIDYyIDYyIj48cGF0aCBkPSJNMTguMjc0IDM2Ljc5NWMwIDIuNTU2LTIuMDY1IDQuNjIxLTQuNjIxIDQuNjIxYTQuNjIgNC42MiAwIDEgMSAwLTkuMjQyaDQuNjIxdjQuNjIxem0yLjMxIDBhNC42MiA0LjYyIDAgMSAxIDkuMjQyIDB2MTEuNTUyYzAgMi41NTYtMi4wNjUgNC42MjEtNC42MjEgNC42MjFzLTQuNjIxLTIuMDY1LTQuNjIxLTQuNjIxVjM2Ljc5NXoiIGZpbGw9IiNlMDFlNWEiLz48cGF0aCBkPSJNMjUuMjA4IDE4LjI0MmMtMi41NTYgMC00LjYyMS0yLjA2NS00LjYyMS00LjYyMWE0LjYyIDQuNjIgMCAxIDEgOS4yNDIgMHY0LjYyMWgtNC42MjF6bTAgMi4zNDVhNC42MiA0LjYyIDAgMSAxIDAgOS4yNDJIMTMuNjIxQzExLjA2NSAyOS44MjkgOSAyNy43NjQgOSAyNS4yMDhhNC42MiA0LjYyIDAgMCAxIDQuNjIxLTQuNjIxaDExLjU4N3oiIGZpbGw9IiMzNmM1ZjAiLz48cGF0aCBkPSJNNDMuNzI0IDI1LjIwOGE0LjYyIDQuNjIgMCAxIDEgOS4yNDIgMCA0LjYyIDQuNjIgMCAwIDEtNC42MjEgNC42MjFoLTQuNjIxdi00LjYyMXptLTIuMzEgMGE0LjYyIDQuNjIgMCAwIDEtNC42MjEgNC42MjFjLTIuNTU2IDAtNC42MjEtMi4wNjUtNC42MjEtNC42MjFWMTMuNjIxYTQuNjIgNC42MiAwIDEgMSA5LjI0MiAwdjExLjU4N3oiIGZpbGw9IiMyZWI2N2QiLz48cGF0aCBkPSJNMzYuNzkyIDQzLjcyNmE0LjYyIDQuNjIgMCAxIDEgMCA5LjI0MmMtMi41NTYgMC00LjYyMS0yLjA2NS00LjYyMS00LjYyMXYtNC42MjFoNC42MjF6bTAtMi4zMWMtMi41NTYgMC00LjYyMS0yLjA2NS00LjYyMS00LjYyMWE0LjYyIDQuNjIgMCAwIDEgNC42MjEtNC42MjFoMTEuNTg3YTQuNjIgNC42MiAwIDEgMSAwIDkuMjQySDM2Ljc5MnoiIGZpbGw9IiNlY2IyMmUiLz48L3N2Zz4=",
  "stripe": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MiIgaGVpZ2h0PSI2MiIgZmlsbD0ibm9uZSIgdmlld0JveD0iMCAwIDYyIDYyIj48ZyBjbGlwLXBhdGg9InVybCgjQSkiPjxwYXRoIGZpbGwtcnVsZT0iZXZlbm9kZCIgZD0iTTI4LjEgMjIuMjQ4YzAtMS44NjUgMS41My0yLjU4MyA0LjA2NS0yLjU4MyAzLjYzNSAwIDguMjI2IDEuMSAxMS44NjEgMy4wNjFWMTEuNDg3Yy0zLjk3LTEuNTc4LTcuODkxLTIuMi0xMS44NjEtMi4yQzIyLjQ1NyA5LjI4NyAxNiAxNC4zNTcgMTYgMjIuODIyYzAgMTMuMiAxOC4xNzQgMTEuMDk2IDE4LjE3NCAxNi43ODcgMCAyLjItMS45MTMgMi45MTctNC41OTEgMi45MTctMy45NyAwLTkuMDM5LTEuNjI2LTEzLjA1Ni0zLjgyNnYxMS4zODNjNC40NDggMS45MTMgOC45NDQgMi43MjYgMTMuMDU3IDIuNzI2IDkuOTQ4IDAgMTYuNzg3LTQuOTI2IDE2Ljc4Ny0xMy40ODdDNDYuMzIyIDI1LjA3IDI4LjEgMjcuNjA1IDI4LjEgMjIuMjQ4eiIgZmlsbD0iIzYzNWJmZiIvPjwvZz48ZGVmcz48Y2xpcFBhdGggaWQ9IkEiPjxwYXRoIGZpbGw9IiNmZmYiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDE2IDkpIiBkPSJNMCAwaDMwLjYwOXY0NEgweiIvPjwvY2xpcFBhdGg+PC9kZWZzPjwvc3ZnPg==",
  "trello": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MiIgaGVpZ2h0PSI2MiIgZmlsbD0ibm9uZSIgdmlld0JveD0iMCAwIDYyIDYyIj48cGF0aCBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik00Ni45OTIgOS4xNzhIMTQuNDY4YTUuMDcgNS4wNyAwIDAgMC01LjA3MSA1LjA2NHYzMi40NzdhNS4wNyA1LjA3IDAgMCAwIDUuMDcxIDUuMDkyaDMyLjUyNWE1LjA3IDUuMDcgMCAwIDAgNS4wNjQtNS4wOTJWMTQuMjQyYTUuMDcgNS4wNyAwIDAgMC01LjA2NC01LjA2NHpNMjcuNzk1IDM5Ljg4NGMtLjAwMi40NTEtLjE4My44ODItLjUwNCAxLjE5OXMtLjc1NC40OTMtMS4yMDUuNDg5aC03LjEwOGExLjY5IDEuNjkgMCAwIDEtMS42ODEtMS42ODhWMTguNzMyYTEuNjkgMS42OSAwIDAgMSAxLjY4MS0xLjY4OGg3LjEwOGMuOTMxLjAwNCAxLjY4NC43NTcgMS42ODggMS42ODhsLjAyMSAyMS4xNTJ6bTE2LjQwMi05LjcxMmExLjY5IDEuNjkgMCAwIDEtMS43MDkgMS42ODhoLTcuMTA4Yy0uOTMxLS4wMDQtMS42ODQtLjc1OC0xLjY4OC0xLjY4OFYxOC43MzJjLjAwNC0uOTMxLjc1Ny0xLjY4NCAxLjY4OC0xLjY4OGg3LjEwOGExLjY5IDEuNjkgMCAwIDEgMS42ODEgMS42ODhsLjAyNyAxMS40NDF6IiBmaWxsPSJ1cmwoI0EpIi8+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJBIiB4MT0iMzAuNzQ3IiB5MT0iNTEuODEiIHgyPSIzMC43NDciIHkyPSI5LjE3OCIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPjxzdG9wIHN0b3AtY29sb3I9IiMwMDUyY2MiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiMyNjg0ZmYiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48L3N2Zz4=",
  "twitter": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MiIgaGVpZ2h0PSI2MiIgZmlsbD0ibm9uZSIgdmlld0JveD0iMCAwIDYyIDYyIj48bWFzayBpZD0iQSIgbWFza1VuaXRzPSJ1c2VyU3BhY2VPblVzZSIgeD0iOSIgeT0iMTMiIHdpZHRoPSI0NCIgaGVpZ2h0PSIzNyI+PHBhdGggZD0iTTUzIDEzSDl2MzYuMTk0aDQ0VjEzeiIgZmlsbD0iI2ZmZiIvPjwvbWFzaz48ZyBtYXNrPSJ1cmwoI0EpIj48cGF0aCBkPSJNNDguMzc2IDIyLjA5OWwuMDI2IDEuMTU5YzAgMTEuODM5LTkuMDE0IDI1LjQ5My0yNS40OTUgMjUuNDkzdi0uMDA3YTI1LjM2IDI1LjM2IDAgMCAxLTEzLjczMy00LjAxN2MuNzA3LjA4NSAxLjQyLjEyOCAyLjEzMi4xMjlhMTcuOTkgMTcuOTkgMCAwIDAgMTEuMTI5LTMuODQzIDguOTcgOC45NyAwIDAgMS04LjM3MS02LjIyMiA4LjkzIDguOTMgMCAwIDAgNC4wNDUtLjE1NCA4Ljk2IDguOTYgMCAwIDEtNy4xODctOC43ODJ2LS4xMTRhOC45IDguOSAwIDAgMCA0LjA2NyAxLjEyMWMtMy45MzctMi42MzEtNS4xNTEtNy44NjktMi43NzQtMTEuOTYzYTI1LjQzIDI1LjQzIDAgMCAwIDE4LjQ2NiA5LjM2Yy0uNzIyLTMuMTEyLjI2NC02LjM3MyAyLjU5Mi04LjU2YTguOTcgOC45NyAwIDAgMSAxMi42NzUuMzg5YzIuMDA3LS4zOTYgMy45My0xLjEzMiA1LjY5LTIuMTc1YTkgOSAwIDAgMS0zLjkzNyA0Ljk1NSAxNy44MSAxNy44MSAwIDAgMCA1LjE0NC0xLjQxIDE4LjE3IDE4LjE3IDAgMCAxLTQuNDcgNC42NDF6IiBmaWxsPSIjMWQ5YmYwIi8+PC9nPjwvc3ZnPg==",
  "woocommerce": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MiIgaGVpZ2h0PSI2MiIgZmlsbD0ibm9uZSIgdmlld0JveD0iMCAwIDYyIDYyIj48ZyBjbGlwLXBhdGg9InVybCgjQikiPjxtYXNrIGlkPSJBIiBtYXNrVW5pdHM9InVzZXJTcGFjZU9uVXNlIiB4PSI5IiB5PSI5IiB3aWR0aD0iNDQiIGhlaWdodD0iNDQiPjxwYXRoIGQ9Ik01MyA5SDlWNTNINTNWOVoiIGZpbGw9IiNmZmYiLz48L21hc2s+PGcgbWFzaz0idXJsKCNBKSI+PHBhdGggZD0iTTQ4LjA3NyA5SDEzLjg5M0MxMS4xOTEgOSA5IDExLjE5MSA5IDEzLjg5M3YzNC4xODVjMCAyLjcwMiAyLjE5MSA0Ljg5MyA0Ljg5MyA0Ljg5M2gzNC4xODVjMi43MDIgMCA0Ljg5My0yLjE5MSA0Ljg5My00Ljg5M1YxMy44OTNDNTIuOTcgMTEuMTkxIDUwLjc3OSA5IDQ4LjA3NyA5eiIgZmlsbD0iIzdmNTRiMyIvPjxwYXRoIGQ9Ik0xNS44NSAxOC40OTdjLjQyNS0uNTc2IDEuMDYyLS44NzkgMS45MTItLjk0IDEuNTQ5LS4xMjEgMi40MjkuNjA2IDIuNjQxIDIuMTgyLjk0MSA2LjMzNSAxLjk3MyAxMS43IDMuMDY2IDE2LjA5NWw2LjY0OS0xMi42MzljLjYwNy0xLjE1MiAxLjM2Ni0xLjc1OCAyLjI3Ny0xLjgxOSAxLjMzNi0uMDkxIDIuMTU1Ljc1OCAyLjQ4OSAyLjU0Ni43NTkgNC4wMzEgMS43MyA3LjQ1NiAyLjg4NCAxMC4zNjYuNzg5LTcuNjk5IDIuMTI1LTEzLjI0NSA0LjAwOC0xNi42Ny40NTUtLjg0OSAxLjEyMy0xLjI3MyAyLjAwMy0xLjMzNC42OTktLjA2IDEuMzM2LjE1MiAxLjkxMy42MDZzLjg4MSAxLjAzMS45NDEgMS43MjhjLjAzLjU0Ni0uMDYxIDEtLjMwNCAxLjQ1NS0xLjE4NCAyLjE4Mi0yLjE1NiA1Ljg1LTIuOTQ1IDEwLjk0Mi0uNzU5IDQuOTQxLTEuMDMyIDguNzktLjg1IDExLjU0OS4wNjEuNzU3LS4wNjEgMS40MjQtLjM2NCAyLS4zNjUuNjY3LS45MTEgMS4wMzEtMS42MDkgMS4wOTEtLjc4OS4wNjEtMS42MDktLjMwMy0yLjM5OC0xLjEyMS0yLjgyMy0yLjg4LTUuMDctNy4xODQtNi43MDktMTIuOTEzbC00LjM3MiA4LjcyOWMtMS43OTEgMy40MjUtMy4zMDkgNS4xODQtNC41ODQgNS4yNzQtLjgyLjA2MS0xLjUxOC0uNjM3LTIuMTI1LTIuMDkxLTEuNTQ4LTMuOTcxLTMuMjE4LTExLjYzOS01LjAwOS0yMy4wMDYtLjEyMi0uNzg4LjA2LTEuNDg1LjQ4Ni0yLjAzMXoiIGZpbGw9IiNmZmYiLz48L2c+PC9nPjxkZWZzPjxjbGlwUGF0aCBpZD0iQiI+PHBhdGggZmlsbD0iI2ZmZiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoOSA5KSIgZD0iTTAgMGg0NHY0NEgweiIvPjwvY2xpcFBhdGg+PC9kZWZzPjwvc3ZnPg==",
  "wordpress": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MiIgaGVpZ2h0PSI2MiIgZmlsbD0ibm9uZSIgdmlld0JveD0iMCAwIDYyIDYyIj48ZyBjbGlwLXBhdGg9InVybCgjQSkiPjxwYXRoIGQ9Ik0xMi4xMDggMzFjMCA3LjQ5NCA0LjMwNCAxMy45NDkgMTAuNTg4IDE2Ljk3OGwtOC45MTMtMjQuNjNjLTEuMDM1IDIuMzkxLTEuNjc1IDQuOTQzLTEuNjc1IDcuNjUyem0zMS42NDYtLjk1N2MwLTIuMzEtLjg3Ny0zLjk4OC0xLjU5NS01LjE4MS0uOTU3LTEuNTk1LTEuODMzLTIuODctMS44MzMtNC40NjMgMC0xLjc1MyAxLjM1Ni0zLjM0OCAzLjE5LTMuMzQ4aC4yMzljLTMuMzQ5LTMuMTA5LTcuODEzLTQuOTQzLTEyLjc1NC00Ljk0M2ExOS4xOCAxOS4xOCAwIDAgMC0xNS43ODIgOC41MjloMS4xOTZjMS45OTQgMCA1LjAyMi0uMjM5IDUuMDIyLS4yMzkgMS4wMzctLjA4IDEuMTE2IDEuNDM0LjE1OSAxLjU5NSAwIDAtMS4wMzcuMTYtMi4xNTIuMTZsNi44NTYgMjAuNDA1IDQuMTQ0LTEyLjM1Ni0yLjk0OS04LjA1MS0xLjk5NC0uMTU3Yy0xLjAzNy0uMDgtLjg3Ny0xLjU5NS4wOC0xLjU5NSAwIDAgMy4xMDguMjM5IDQuOTQyLjIzOSAxLjk5NCAwIDUuMDIyLS4yMzkgNS4wMjItLjIzOSAxLjAzNy0uMDggMS4xMTcgMS40MzQuMTYgMS41OTUgMCAwLTEuMDM3LjE1OS0yLjE1Mi4xNTlsNi44NTQgMjAuMzI4IDEuOTI1LTYuMjk3Yy43OTctMi42MyAxLjQzNC00LjQ2MyAxLjQzNC02LjEzOGwtLjAxMS0uMDAzem0tMTIuNDM0IDIuNjNMMjUuNjYgNDkuMDk1YzEuNjczLjQ3OSAzLjUwNi43OTcgNS4zNC43OTcgMi4yMzIgMCA0LjMwNC0uNDEzIDYuMjk3LTEuMDM3LS4wOC0uMDgtLjA4LS4xNi0uMTYtLjIzOWwtNS44MTktMTUuOTQzem0xNi4yNjEtMTAuNjhsLjE1OSAxLjkyNWMwIDEuOTI1LS4zMTkgNC4wNjYtMS40MzQgNi43NzZsLTUuNzM5IDE2LjY1OWM1LjU4LTMuMjY4IDkuNDA1LTkuMzI3IDkuNDA1LTE2LjM0LS4wOC0zLjI2OC0uOTU3LTYuMjk3LTIuMzkyLTkuMDA2bC4wMDEtLjAxNHpNMzEgOUMxOC44ODQgOSA5IDE4Ljg4NCA5IDMxczkuODg0IDIyIDIyIDIyIDIyLTkuODgzIDIyLTIyUzQzLjExNyA5IDMxIDl6bTAgNDMuMDQzYy0xMS41NTggMC0yMC45NjMtOS40MDUtMjAuOTYzLTIxLjA0My4wMDktNS41NTcgMi4yMi0xMC44ODQgNi4xNS0xNC44MTRzOS4yNTctNi4xNDEgMTQuODE0LTYuMTVjNS41NTcuMDA5IDEwLjg4NCAyLjIyIDE0LjgxNCA2LjE1czYuMTQxIDkuMjU3IDYuMTUgMTQuODE0YzAgMTEuNjM4LTkuNDA1IDIxLjA0My0yMC45NjMgMjEuMDQzeiIgZmlsbD0iIzAwNzQ5YSIvPjwvZz48ZGVmcz48Y2xpcFBhdGggaWQ9IkEiPjxwYXRoIGZpbGw9IiNmZmYiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDkgOSkiIGQ9Ik0wIDBoNDR2NDRIMHoiLz48L2NsaXBQYXRoPjwvZGVmcz48L3N2Zz4=",
  "x": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjAwIiBoZWlnaHQ9IjEyMjciIGZpbGw9Im5vbmUiIHZpZXdCb3g9IjAgMCAxMjAwIDEyMjciPjxwYXRoIGZpbGw9IiMwMDAiIGQ9Ik03MTQuMTYzIDUxOS4yODQgMTE2MC44OSAwaC0xMDUuODZMNjY3LjEzNyA0NTAuODg3IDM1Ny4zMjggMEgwbDQ2OC40OTIgNjgxLjgyMUwwIDEyMjYuMzdoMTA1Ljg2Nmw0MDkuNjI1LTQ3Ni4xNTIgMzI3LjE4MSA0NzYuMTUySDEyMDBMNzE0LjEzNyA1MTkuMjg0aC4wMjZaTTU2OS4xNjUgNjg3LjgyOGwtNDcuNDY4LTY3Ljg5NC0zNzcuNjg2LTU0MC4yNGgxNjIuNjA0bDMwNC43OTcgNDM1Ljk5MSA0Ny40NjggNjcuODk0IDM5Ni4yIDU2Ni43MjFIODkyLjQ3Nkw1NjkuMTY1IDY4Ny44NTR2LS4wMjZaIi8+PC9zdmc+",
  "zoho": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MiIgaGVpZ2h0PSI2MiIgZmlsbD0ibm9uZSIgdmlld0JveD0iMCAwIDYyIDYyIj48cGF0aCBkPSJNMjguNjQ5IDM4LjAzMmMtLjMzNiAwLS42NzUtLjA3LTEuMDAyLS4yMTRsLTYuOTczLTMuMTA4YTIuNDggMi40OCAwIDAgMS0xLjI1NS0zLjI2OWwzLjEwOC02Ljk3NGEyLjQ4IDIuNDggMCAwIDEgMy4yNjktMS4yNTVsNi45NzMgMy4xMDdhMi40OCAyLjQ4IDAgMCAxIDEuMjU1IDMuMjY5bC0zLjEwOCA2Ljk3M2MtLjQxNC45MjQtMS4zMjEgMS40NjktMi4yNjYgMS40Njl6bS0uNDIzLTEuNTIxYTEuMDUgMS4wNSAwIDAgMCAxLjM4Mi0uNTI3bDMuMTA4LTYuOTc0YTEuMDUgMS4wNSAwIDAgMC0uNTI3LTEuMzgybC02Ljk3OC0zLjEwOGExLjA1IDEuMDUgMCAwIDAtMS4zODIuNTI3bC0zLjEwOCA2Ljk3NGExLjA1IDEuMDUgMCAwIDAgLjUyNyAxLjM4Mmw2Ljk3OCAzLjEwN3oiIGZpbGw9IiMwODk5NDkiLz48cGF0aCBkPSJNNTAuNTI0IDM4LjAzNmgtNy42MzZhMi40OCAyLjQ4IDAgMCAxLTIuNDc2LTIuNDc2di03LjYzNmEyLjQ4IDIuNDggMCAwIDEgMi40NzYtMi40NzZoNy42MzZBMi40OCAyLjQ4IDAgMCAxIDUzIDI3LjkyNXY3LjYzNmEyLjQ4IDIuNDggMCAwIDEtMi40NzYgMi40NzZ6bS03LjYzNi0xMS4xNThhMS4wNSAxLjA1IDAgMCAwLTEuMDQ2IDEuMDQ2djcuNjM2YTEuMDUgMS4wNSAwIDAgMCAxLjA0NiAxLjA0Nmg3LjYzNmExLjA1IDEuMDUgMCAwIDAgMS4wNDYtMS4wNDZ2LTcuNjM2YTEuMDUgMS4wNSAwIDAgMC0xLjA0Ni0xLjA0NmgtNy42MzZ6IiBmaWxsPSIjZjliMjFkIi8+PHBhdGggZD0iTTIxLjkyOSAyOS4zMjNMMjAuOSAzMS42MjVsLS4wMzkuMDcuNDAxIDIuNDc2Yy4wOTEuNTcxLS4yOTYgMS4xMDctLjg2MyAxLjE5OGwtNy41NCAxLjIyYy0uMjc1LjA0NC0uNTUzLS4wMjItLjc4LS4xODNzLS4zNzUtLjQwNS0uNDE4LS42OGwtMS4yMi03LjU0Yy0uMDQ0LS4yNzUuMDIyLS41NTMuMTgzLS43OHMuNDA1LS4zNzUuNjgtLjQxOGw3LjU0LTEuMjJjLjA1Ny0uMDA5LjExMy0uMDEzLjE2Ni0uMDEzYTEuMDUgMS4wNSAwIDAgMSAxLjAzMy44OGwuNDA1IDIuNDkzIDEuMDY0LTIuMzg0LS4wNTctLjMzNmEyLjQ4IDIuNDggMCAwIDAtMi44MzctMi4wNDhsLTcuNTQgMS4yMmMtLjY0OS4xLTEuMjI1LjQ1My0xLjYwOC45ODlzLS41NCAxLjE5LS40MzYgMS44NDRsMS4yMiA3LjU0Yy4xMDUuNjU0LjQ1OCAxLjIyNS45OTQgMS42MTMuNDIzLjMwOS45MjQuNDY2IDEuNDQzLjQ2NmEyLjUyIDIuNTIgMCAwIDAgLjQwMS0uMDMxbDcuNTQtMS4yMmEyLjQ4IDIuNDggMCAwIDAgMi4wNDktMi44MzdsLS43NS00LjYyeiIgZmlsbD0iI2U0MjUyNyIvPjxwYXRoIGQ9Ik0zMC45NzIgMzIuOTI0bDEuMTA3LTIuNDgtLjMxNC0yLjMwNmMtLjAzOS0uMjc1LjAzNS0uNTQ5LjIwNS0uNzcxcy40MTQtLjM2Ni42OTMtLjQwMWw3LjU2Ni0xLjAyOS4xNDQtLjAwOWMuMjI3IDAgLjQ0NC4wNzQuNjMyLjIxMy4wMzUuMDI2LjA2NS4wNTcuMDk2LjA4My4zMzYtLjM1My43NzYtLjYwNiAxLjI2OC0uNzE1LS4xMzktLjE5Mi0uMzA1LS4zNjItLjUwMS0uNTEtLjUyNy0uNDAxLTEuMTc3LS41NzEtMS44MzEtLjQ4NGwtNy41NzUgMS4wMjljLS42NTQuMDg3LTEuMjM4LjQyNy0xLjYzNC45NTRzLS41NzEgMS4xNzctLjQ4NCAxLjgzMWwuNjI4IDQuNTk0em0xMi44NzUgMS4yNzdsLS45OTQtNy4zMjJjLS41NTguMDE3LTEuMDA3LjQ3OS0xLjAwNyAxLjA0MnYyLjE0OWwuNTg4IDQuMzI0Yy4wMzkuMjc1LS4wMzUuNTQ5LS4yMDUuNzcxcy0uNDE0LjM2Ni0uNjkzLjQwMWwtNy41NjYgMS4wMjljLS4yNzQuMDM5LS41NDktLjAzNS0uNzcxLS4yMDVzLS4zNjYtLjQxNC0uNDAxLS42OTNsLS4zNDktMi41NjctMS4xMDcgMi40OC4wMzkuMjc5Yy4wODcuNjU0LjQyNyAxLjIzOC45NTQgMS42MzRhMi40NiAyLjQ2IDAgMCAwIDEuNDk1LjUwNiAyLjk2IDIuOTYgMCAwIDAgLjM0LS4wMjJsNy41NTctMS4wMmEyLjQ0IDIuNDQgMCAwIDAgMS42MzUtLjk1NWMuNDAxLS41MjcuNTcxLTEuMTc3LjQ4NC0xLjgzMXoiIGZpbGw9IiMyMjZkYjQiLz48L3N2Zz4=",
});

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
        goals: reviewGoalsOf(item.goals ?? review.goals), replaces: reviewReplaces(review) });
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
/** The Goal filter's choices, as the server counts them for this queue
 * (Platform Control's top-level `goals` and `noGoal`, which ignore the goal
 * asked for): `{ goals: [{ path, title, count }], noGoal }`. The queue is
 * capped, so the plugin never counts for itself. An older server sends none. */
function reviewGoalChoices(queue) {
  const goals = [];
  for (const goal of Array.isArray(queue?.goals) ? queue.goals : []) {
    const [known] = reviewGoalsOf([goal]);
    const count = Number.isInteger(goal?.reviews) && goal.reviews > 0 ? goal.reviews : 0;
    if (known && count && !goals.some((other) => other.path === known.path) && goals.length < 100) goals.push({ ...known, count });
  }
  return { goals, noGoal: Number.isInteger(queue?.noGoal) && queue.noGoal > 0 ? queue.noGoal : 0 };
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

/** Every business with decisions waiting, with how many: `[{ businessId,
 * businessName, count }]`. The queue lists at most 50 items, so counting what
 * it lists shows too few and drops businesses: the server's own `businesses`
 * counts come first. An older server sends none; then what is listed is
 * counted, which is all there is. */
function reviewBusinessCounts(queue) {
  if (Array.isArray(queue?.businesses)) {
    const out = [];
    for (const business of queue.businesses) {
      const businessId = typeof business?.businessId === "string" ? business.businessId : "";
      const count = Number.isInteger(business?.decisions) && business.decisions > 0 ? business.decisions : 0;
      if (!businessId || !count || out.some((known) => known.businessId === businessId) || out.length >= 200) continue;
      out.push({ businessId, businessName: plain(business.businessName, 120) || businessId, count });
    }
    return out;
  }
  return reviewGroups(queue).map((group) => ({ businessId: group.businessId, businessName: group.businessName, count: group.items.length }));
}

/** A title that names no decision ("Review this document"): the review's own
 * title says more. */
const REVIEW_GENERIC_TITLE = /^(?:please\s+)?review\s+(?:this|the)\s+(?:document|report|draft|page|file|work|change)s?\.?$/i;
/** What a decision is called: its question, else its title; a generic one
 * gives way to the review's title. */
function reviewHeadline({ question, title, reviewTitle } = {}) {
  const own = String(question || title || "").trim();
  return own && REVIEW_GENERIC_TITLE.test(own) && reviewTitle ? String(reviewTitle) : own || String(reviewTitle || "");
}

/** The system approving writes to, named only from the pinned request (never
 * from the action sentence), as Platform Control's review screen names it:
 * `{ name, state: "known" | "erased" | "report" }`, or null when nothing is
 * pinned. `report`: a document's feedback, which writes nothing. */
const REVIEW_PROVIDER_NAMES = Object.freeze({
  "google-tag-manager": "Google Tag Manager", "google-ads": "Google Ads", "google-analytics": "Google Analytics", "search-console": "Google Search Console",
  "google-workspace": "Google Workspace", "google-marketing": "Google Marketing", "google-calendar": "Google Calendar", "google-drive": "Google Drive",
  "google-docs": "Google Docs", "google-sheets": "Google Sheets", "google-slides": "Google Slides", "microsoft-graph": "Microsoft 365",
  "zoho-crm": "Zoho CRM", "zoho-campaigns": "Zoho Campaigns",
  acumatica: "Acumatica", ahrefs: "Ahrefs", airtable: "Airtable", asana: "Asana", canva: "Canva", framer: "Framer",
  github: "GitHub", gitlab: "GitLab", google: "Google", granola: "Granola", hubspot: "HubSpot", klaviyo: "Klaviyo", linear: "Linear",
  meta: "Meta", microsoft: "Microsoft", notion: "Notion", prismic: "Prismic", salesforce: "Salesforce", shopify: "Shopify",
  slack: "Slack", stripe: "Stripe", trello: "Trello", twitter: "X", x: "X", woocommerce: "WooCommerce", wordpress: "WordPress",
  zoho: "Zoho", linkedin: "LinkedIn",
});
function reviewDestination(item) {
  if (item?.workType === "document_feedback") return { name: "Writes nothing", state: "report" };
  const change = item?.change;
  if (!change || typeof change !== "object") return null;
  if (change.erased) return { name: "Request erased · never runs", state: "erased" };
  const normalize = (value) => String(value).toLowerCase().trim().replace(/[\s_]+/g, "-");
  const recorded = String((change.connector === "treg" ? change.connection : change.connector) ?? "").trim();
  if (!recorded) return null;
  let key = normalize(recorded).replace(/^catalog-/, "");
  const endpoint = String(change.endpoint ?? "");
  if (change.connector === "treg") {
    // Treg connection keys often start with a customer's name: the pinned path names the service.
    const path = endpoint.toLowerCase().split("?")[0];
    const family = path.match(/^\/([^/]+)(?:\/|$)/)?.[1];
    if (/^\/tagmanager\/v2(?:\/|$)/.test(path)) key = "google-tag-manager";
    else if (/^\/crm\/v3\/(?:objects|properties|associations|schemas)(?:\/|$)/.test(path)) key = "hubspot";
    else if (/^\/admin\/api\//.test(path)) key = "shopify";
    else if (/^\/services\/data\/v[\d.]+\//.test(path)) key = "salesforce";
    else if (family && Object.hasOwn(REVIEW_PROVIDER_NAMES, family)) key = family;
  }
  if (/^google-ads(?:-|$)/.test(key)) key = "google-ads";
  else if (/^(?:ga4|google-analytics)(?:-|$)/.test(key)) key = "google-analytics";
  else if (/^google-search-console(?:-|$)/.test(key)) key = "search-console";
  else if (/^google-tag-manager(?:-|$)/.test(key)) key = "google-tag-manager";
  else if (key === "google-marketing") {
    // A hostname in the pinned request, not the agent's words.
    let host = "";
    try { host = new URL(endpoint).hostname; } catch {}
    if (host === "googleads.googleapis.com") key = "google-ads";
    else if (["analyticsdata.googleapis.com", "analyticsadmin.googleapis.com"].includes(host)) key = "google-analytics";
    else if (/^searchconsole\.googleapis\.com$/.test(host)) key = "search-console";
    else if (host === "tagmanager.googleapis.com") key = "google-tag-manager";
  }
  const family = key.split("-")[0];
  const name = REVIEW_PROVIDER_NAMES[key] ?? REVIEW_PROVIDER_NAMES[family] ?? plain(recorded, 60);
  // Its mark, chosen as Platform Control chooses it (providerLogoKey): the exact
  // provider key, or a key the recorded one starts with; any other Google product, Google's.
  // The longest match wins, so google-ads is Google Ads' mark, not Google's.
  const logoKey = Object.keys(REVIEW_PROVIDER_LOGOS).filter((candidate) => key === candidate || key.startsWith(`${candidate}-`))
    .sort((a, b) => b.length - a.length)[0] ?? (name.startsWith("Google ") ? "google" : null);
  return { name: `Updates ${name}`, system: name, logo: logoKey ? REVIEW_PROVIDER_LOGOS[logoKey] : null, state: "known" };
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

/** `madeBy` as words: the agent key Platform Control appends
 * (" [nostr:<hex>]") is left out; the key is shown as the agent's profile. */
function reviewMadeBy(value) {
  if (typeof value !== "string") return undefined;
  return plain(value.replace(/\s*\[nostr:[0-9a-f]{64}\]\s*$/i, ""), 160) || undefined;
}

/** Who made a review item and what set it off, for its byline:
 * `{ maker: { name, pubkey?, signed, app?, person?, personVerified, agent },
 * origin: { kind: job | request | unknown, text, threadId? } }`.
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
    // "agent" is Platform Control's word for a signed agent whose app it
    // could not name (black4McpHarness), not a harness: it is left out.
    const app = text(producer.app, 60)?.replace(/^agent$/i, "") || undefined;
    maker = { name: text(producer.agent, 80) ?? reviewMadeBy(item?.madeBy ?? review?.madeBy) ?? "An agent", agent: true, signed: !!pubkey,
      ...(pubkey ? { pubkey } : {}),
      ...(model || app ? { app: model && app ? `${model} via ${app}` : model ?? app } : {}),
      ...(text(producer.person, 120) ? { person: text(producer.person, 120), personVerified: verified.person === true } : {}) };
  } else maker = { name: reviewMadeBy(item?.madeBy ?? review?.madeBy) ?? "Unknown maker", agent: false, signed: false };
  let origin;
  const kind = said && typeof said === "object" ? said.kind : undefined;
  if (kind === "job" || (!kind && job && (job.jobName || job.jobId))) {
    const run = kind === "job" ? said.job : job;
    origin = { kind: "job", text: `Scheduled job ${text(run?.jobName, 80) ?? text(run?.jobId, 80) ?? ""}`.trim() };
  // An older item's requestedBy "proactive" said nobody asked (retired 2026-11-28): it names no one.
  } else if (kind === "request" || (!kind && requestedBy && !/^proactive$/i.test(requestedBy))) {
    origin = { kind: "request", text: `Asked by ${text(kind === "request" ? said.requestedBy : requestedBy, 120) ?? "someone"}` };
  } else origin = { kind: "unknown", text: "What started it was not recorded" };
  if (threadId) origin.threadId = threadId;
  return { maker, origin };
}

/** What a redo replaces, in words: Platform Control's `supersedes` on a
 * review (Reject is final, so redone work comes back as a new review naming
 * the rejected one). Null when it replaces nothing. */
function reviewReplaces(review) {
  const prior = review?.supersedes;
  if (!prior || typeof prior !== "object") return null;
  const title = plain(prior.title, 120) || "an earlier review";
  const why = plain(prior.rejectedFeedback, 240);
  return `Replaces “${title}”, which was rejected${why ? `: ${why}` : ""}`;
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
  // The queue as the server answers it for one business and/or one goal:
  // `${businessId}|${goal}` -> { queue, error, flight }. The whole queue stays `queue`.
  const scoped = new Map();
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

  /** A queue answer squared with the decisions made here. A newer version of
   * an item a person decided is new work, so the old version's receipt no
   * longer speaks for it and is dropped (Reject is final: redone work comes
   * back as a new review, and changes asked for come back as a new version).
   * An item still listed at the very version just decided is from an answer
   * read before the decision: it stays off the list. */
  const reviews_ = reviews; // the cache; `reviews` below is the answer's list
  const squared = (value) => {
    if (!value?.reviews) return value;
    let gone = 0;
    const reviews = value.reviews.map((review) => {
      // A review read before a newer version of one of its items arrived is
      // stale: forget it, so opening it reads the new version.
      const key = reviewAssetKey(review.businessId, review.assetId);
      const cached = reviews_.get(key)?.data;
      if (cached && (review.items ?? []).some((item) => Number.isInteger(item.version)
        && !(cached.items ?? []).some((known) => known.key === item.key && known.version >= item.version))) reviews_.delete(key);
      const items = (review.items ?? []).filter((item) => {
        const id = reviewItemId(review.businessId, review.assetId, item.key);
        const receipt = receipts.get(id);
        if (!receipt || !Number.isInteger(item.version)) return true;
        if (item.version > receipt.version) {
          if (receipt.state === "saved") receipts.delete(id);
          return true;
        }
        if (receipt.state === "saved" && item.version === receipt.version) { gone += 1; return false; }
        return true;
      });
      return items.length === (review.items ?? []).length ? review : { ...review, items };
    }).filter((review) => (review.items ?? []).length);
    return gone ? { ...value, total: Math.max(0, (value.total ?? gone) - gone), reviews } : { ...value, reviews };
  };

  const noteQueue = (value) => {
    if (!value || value.kind !== "black4_review_queue") return;
    value = squared(value);
    queue = value;
    for (const review of value.reviews ?? []) remember(review.assetId, review.businessId);
    for (const entry of [...(value.blocked ?? []), ...(value.stalled ?? [])]) remember(entry.assetId, entry.businessId);
    changed();
    // The narrower answers follow the whole queue's poll.
    for (const key of scoped.keys()) {
      const [businessId, goal] = key.split("|");
      readScoped({ businessId: businessId || null, goal: goal || REVIEW_ALL_GOALS }).catch(() => {});
    }
  };
  const scopeKey = ({ businessId, goal } = {}) => `${businessId ?? ""}|${goal && goal !== REVIEW_ALL_GOALS ? goal : ""}`;
  /** Reads the queue for one business and/or one goal (the server filters
   * and counts: the queue is capped). Neither: the whole queue. */
  const readScoped = ({ businessId = null, goal = REVIEW_ALL_GOALS } = {}) => {
    const key = scopeKey({ businessId, goal });
    if (key === "|") return readQueue();
    const known = scoped.get(key) ?? { queue: null, error: null, flight: null };
    if (known.flight) return known.flight;
    const at = epoch;
    known.flight = (async () => {
      try {
        const data = reviewQueueOf(await call("review_queue", { ...(businessId ? { businessId } : {}), ...(goal && goal !== REVIEW_ALL_GOALS ? { goal } : {}) }));
        if (data?.kind !== "black4_review_queue") throw new Error("Black 4 answered with something Reviews cannot show.");
        if (at === epoch) { known.queue = squared(data); known.error = null; }
        return data;
      } catch (error) { if (at === epoch) known.error = error; throw error; }
      finally { known.flight = null; if (at === epoch) changed(); }
    })();
    if (scoped.size >= 12 && !scoped.has(key)) scoped.delete(scoped.keys().next().value);
    scoped.set(key, known);
    return known.flight;
  };
  /** The last answer for one business and/or goal, or null before it is read. */
  const scopedQueue = (scope) => (scopeKey(scope) === "|" ? queue : scoped.get(scopeKey(scope))?.queue ?? null);
  const scopedError = (scope) => scoped.get(scopeKey(scope))?.error ?? null;
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
      if (after || before) previews.set(id, { after, before }); else previews.delete(id);
      // Captures of the item's page (and of its before page), desktop width.
      const shot = (entry) => { const link = entry?.desktop ?? entry?.phone; return typeof link?.url === "string" && /^https:\/\//.test(link.url) ? { url: link.url, contentType: link.contentType ?? "image/jpeg" } : null; };
      const capture = shot(meta?.captures?.[item.key]);
      const beforeCapture = shot(meta?.beforeCaptures?.[item.key]);
      if (capture || beforeCapture) captures.set(id, { capture, beforeCapture }); else captures.delete(id);
      // A decision the server now shows replaces a receipt still unsure of it.
      const receipt = receipts.get(id);
      // A newer version is new work: the old version's receipt no longer speaks for it.
      if (receipt?.state === "saved" && Number.isInteger(item.version) && item.version > receipt.version) receipts.delete(id);
      else if (receipt && item.decision && ["unknown", "conflict"].includes(receipt.state)) receipts.set(id, { ...receipt, state: "saved", decision: item.decision });
    }
    reviews.set(key, { data, readAt: now() });
    changed();
    return data;
  };

  /** True when a queue answer already lists one of this review's items at a
   * newer version than `data` holds: an answer that was in flight when the
   * newer version was listed. */
  const behindQueue = (data) => [queue, ...[...scoped.values()].map((known) => known.queue)].some((listed) =>
    (listed?.reviews ?? []).some((review) => review.assetId === data.assetId && review.businessId === data.businessId
      && (review.items ?? []).some((item) => Number.isInteger(item.version)
        && !(data.items ?? []).some((known) => known.key === item.key && known.version >= item.version))));
  const ask = async (args, again = true) => {
    const { data, meta } = answer(await call("open_review", args));
    if (data?.kind !== "black4_review" || data.assetId !== args.assetId || (args.businessId && data.businessId !== args.businessId)) {
      throw new Error("The review Black 4 sent does not match this link.");
    }
    // Never keep or show an answer older than what the queue already lists: read it
    // once more, and if that is behind too (the queue moved again meanwhile),
    // say so instead of showing it; trying again reads afresh.
    if (behindQueue(data)) {
      if (again) return ask(args, false);
      throw Object.assign(new Error("A newer version arrived while this was loading. Try again to read it."), { code: "newer_version" });
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
  /** The link the server gave now for one of the item's pictures. */
  const mediaLink = (id, which) => {
    const shots = captures.get(id);
    return which === "capture" ? shots?.capture : which === "beforeCapture" ? shots?.beforeCapture : previews.get(id)?.[which];
  };
  /** Pictures are kept by the exact link they were read from, so a new
   * version's work never shows an older version's picture, even one whose
   * read finishes late. */
  const mediaKey = (id, which, link) => `${id}/${which}/${link?.url ?? ""}`;
  const image = (businessId, assetId, key, which = "after") => {
    const id = reviewItemId(businessId, assetId, key);
    const link = mediaLink(id, which);
    const version = cachedReview(businessId, assetId)?.items?.find((entry) => entry.key === key)?.version;
    return pictureFrom(businessId, assetId, version, link, mediaKey(id, which, link), { direct: which === "capture" || which === "beforeCapture" });
  };
  /** The capture the queue lists for a review (a later platform slice), once read. */
  const queuePicture = (entry) => {
    const link = entry?.capture?.desktop ?? entry?.capture?.phone ?? entry?.capture;
    if (typeof link?.url !== "string") return null;
    const cacheKey = `${entry.businessId}/${entry.assetId}/queue-capture/${link.url}`;
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
    const without = (value) => {
      if (!value?.reviews?.some((review) => review.assetId === receipt.assetId && review.businessId === receipt.businessId
        && (review.items ?? []).some((item) => item.key === receipt.key))) return value;
      return { ...value, total: Math.max(0, (value.total ?? 1) - 1), reviews: value.reviews
        .map((review) => review.assetId !== receipt.assetId || review.businessId !== receipt.businessId ? review
          : { ...review, items: (review.items ?? []).filter((item) => item.key !== receipt.key) })
        .filter((review) => review.items.length) };
    };
    queue = without(queue);
    for (const known of scoped.values()) known.queue = without(known.queue);
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
    noteQueue, readQueue, readScoped, scopedQueue, scopedError, open, cachedReview, peek, canDecide, image,
    /** An image of the work already read (`after`, `before` or `capture`), or null. */
    picture: (businessId, assetId, key, which = "after") => {
      const id = reviewItemId(businessId, assetId, key);
      return pictures.get(mediaKey(id, which, mediaLink(id, which))) ?? null;
    },
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
      for (const map of [tokens, previews, captures, reviews, flights, businesses, receipts, images, pictures, scoped]) map.clear();
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
  const ORIGIN_GLYPH = { job: "clock", request: "message", unknown: null };
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
  const { ReviewItem, QueueList, QueueFilters, useStore, useConnection, NotConnected, decideTogether } = screens;
  const disposers = [];
  const own = (dispose) => { if (typeof dispose === "function") disposers.push(dispose); else if (dispose?.dispose) disposers.push(() => dispose.dispose()); };

  // ---- who is signed in, and Sign out, where Reviews shows ---------------------
  // Signing out lived only in Settings → Black 4 (Joey, 2026-11-28: "extremely hard to sign out of"):
  // every Reviews header names the account and carries Sign out. `wide`: the page, with room for the address.
  function accountActions(link, wide) {
    // Connected, or signed in but asked to approve again (idle): either way there is a sign-in to end.
    if (!bridge.signOut || (link.status !== "connected" && link.status !== "idle")) return [];
    const email = link.account?.email ?? "";
    return [
      wide && email ? h(React.Fragment, { key: "account" }, ui.Value(email)) : null,
      h(ui.Button, { key: "sign-out", size: "sm", variant: "outline", title: email ? `Sign out of Black 4 (${email})` : "Sign out of Black 4", onClick: () => bridge.signOut() }, "Sign out"),
    ].filter(Boolean);
  }

  // ---- what the page shows: shared with the sidebar and notifications ----------
  // `goals`: the goal chosen per business ("" for all of them), for the session.
  let view = { filter: null, entry: null, goals: {} };
  const viewListeners = new Set();
  const setView = (patch) => { view = { ...view, ...patch }; for (const listener of [...viewListeners]) listener(); };
  /** What a person works through with this business filter (null: every
   * business): the Goal filter's choices, the goal in force and the order of
   * what it shows. Next, previous, bulk approve and the counts all use it. */
  // The server filters and counts (the queue is capped): one answer for the
  // business, one for the goal. Until the goal's answer arrives, what is loaded
  // is narrowed by each review's own goals; the counts are always the server's.
  const worked = (businessId) => {
    const base = businessId ? store.scopedQueue({ businessId }) : store.queue;
    const choices = reviewGoalChoices(base);
    const goal = reviewGoalNow(choices, view.goals[businessId ?? ""]);
    const exact = goal === REVIEW_ALL_GOALS ? base : store.scopedQueue({ businessId, goal });
    const queue = exact ?? base ?? (businessId ? store.queue : null);
    return { choices, goal, queue, exact: !!exact, order: reviewShown(queue, { businessId, goal }) };
  };
  /** Asks for the answers `worked` reads, while a surface shows them. */
  const useWorked = (businessId, connected) => {
    const work = worked(businessId);
    React.useEffect(() => {
      if (!connected) return;
      if (businessId && !store.scopedQueue({ businessId })) store.readScoped({ businessId }).catch(() => {});
      if (work.goal !== REVIEW_ALL_GOALS) store.readScoped({ businessId, goal: work.goal }).catch(() => {});
    }, [businessId ?? "", work.goal, connected]);
    return work;
  };
  const chooseGoal = (businessId, goal) => setView({ goals: { ...view.goals, [businessId ?? ""]: goal } });
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

  /** Next, previous and the position for `entry`, in what the filters show. */
  function useStepping(entry, setEntry, businessId = null) {
    useStore();
    const { order } = worked(businessId);
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
    // { ids, refused, preparing, verdict } for the last Approve N or Reject N: its countdown and what it couldn't do.
    const [bulk, setBulk] = React.useState(null);
    // Reject N asks why first: one reason, sent with each.
    const [bulkReject, setBulkReject] = React.useState(null); // null, or the reason typed so far
    const setEntry = (entry) => setView({ entry });
    // The first waiting item is open from the start: one less click per session.
    const work = useWorked(current.filter, link.status === "connected");
    const first = work.order[0];
    React.useEffect(() => {
      // Nothing open, or a customer chosen whose decisions aren't the one open.
      const elsewhere = view.filter && view.entry && view.entry.businessId && view.entry.businessId !== view.filter;
      if (first && (!view.entry || elsewhere)) setView({ entry: { businessId: first.businessId, assetId: first.assetId, itemKey: first.key } });
    }, [first?.id, current.filter]);
    const step = useStepping(current.entry, setEntry, current.filter);
    surface = { next: step.next, previous: step.previous };
    React.useEffect(() => () => { surface = null; surfaceFocused = false; }, []);
    const order = work.order;
    // A new goal: its first decision opens, and picks from the old one drop.
    const onGoal = (goal) => {
      chooseGoal(current.filter, goal);
      setPicked(new Set());
      const next = worked(current.filter).order[0];
      setView({ entry: next ? { businessId: next.businessId, assetId: next.assetId, itemKey: next.key } : null });
    };
    const onFilter = (filter) => { setPicked(new Set()); setBulkReject(null); setView({ filter, entry: null }); };
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
    const decideAll = async (verdict, feedback = "") => {
      const ids = new Set(live);
      setBulk({ ids: [], refused: [], preparing: verdict, verdict });
      const { proposed, refused } = await decideTogether(ids, order, verdict, feedback);
      setPicked(new Set());
      setBulkReject(null);
      setBulk({ ids: proposed, refused, preparing: false, verdict });
    };
    const undoAll = () => { for (const receipt of pending) store.undo(receipt.id); };
    const words = bulk?.verdict === "rejected" ? { doing: "Rejecting", done: "rejected" } : { doing: "Approving", done: "approved" };
    const notes = new Map((bulk?.refused ?? []).map((id) => [id, `Can't be ${words.done} here: open it to see why`]));
    // Picked items take the one decision bar at the bottom, in place of the
    // open item's own: one Approve on screen, never two.
    let bulkBar = null;
    if (pending.length) {
      bulkBar = h(ui.DecisionBar, { status: ui.Status(`${words.doing} ${pending.length} in ${Math.max(1, Math.ceil((Math.min(...pending.map((receipt) => receipt.deadline)) - Date.now()) / 1000))} s`) },
        h(ui.Button, { key: "undo", variant: "outline", autoFocus: true, onClick: undoAll }, "Undo"));
    } else if (bulk?.refused?.length && !live.size) {
      bulkBar = h(ui.DecisionBar, { status: ui.Line(`${bulk.refused.length} couldn't be ${words.done} here.`) },
        h(ui.Button, { key: "dismiss", variant: "ghost", onClick: () => setBulk(null) }, "Dismiss"));
    } else if (live.size && bulkReject !== null) {
      const send = () => { if (bulkReject.trim()) void decideAll("rejected", bulkReject); };
      bulkBar = h(ui.DecisionBar, { stacked: true },
        h(ui.TextField, { key: "why", label: live.size === 1 ? "Why reject it?" : `Why reject these ${live.size}?`, value: bulkReject, onChange: setBulkReject, rows: 3, maxLength: 8000, autoFocus: true,
          onKeyDown: (event) => { if (event.key === "Escape") { event.stopPropagation(); setBulkReject(null); } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send(); } }),
        h(ui.Actions, { key: "actions" },
          h(ui.Button, { key: "send", variant: "destructive", disabled: !bulkReject.trim(), loading: bulk?.preparing === "rejected", onClick: send }, `Reject ${live.size}`),
          h(ui.Button, { key: "cancel", variant: "outline", onClick: () => setBulkReject(null) }, "Cancel")));
    } else if (live.size) {
      bulkBar = h(ui.DecisionBar, { status: ui.Strong(`${live.size} selected`) },
        h(ui.Button, { key: "approve", variant: "prominent", loading: bulk?.preparing === "approved", onClick: () => void decideAll("approved") }, `Approve ${live.size}`),
        h(ui.Button, { key: "reject", variant: "outline", onClick: () => setBulkReject("") }, `Reject ${live.size}`),
        h(ui.Button, { key: "clear", variant: "ghost", onClick: () => { setPicked(new Set()); setBulkReject(null); } }, "Clear"));
    }
    let list;
    if (link.status !== "connected") list = h(NotConnected, { link });
    else if (error && !queue) list = h(ui.Failure, { message: plain(error.message, 300), retry, retryLabel: "Try again" });
    else if (!queue) list = h(ui.Skeleton, { layout: "list" });
    else list = h(QueueList, { queue: work.queue ?? queue, selectedId: current.entry ? order[reviewStep(order, current.entry).index]?.id : null, onOpen: setEntry,
      picked: live, onPick: pick, notes, filter: current.filter, onFilter, goal: work.goal, goals: work.choices, onGoal, filters: false });
    // The Customer and Goal menus stay above the list while it scrolls.
    const listHeader = link.status === "connected" && queue
      ? h(QueueFilters, { queue: work.queue ?? queue, filter: current.filter, onFilter, goal: work.goal, goals: work.choices, onGoal }) : null;
    const empty = h(ui.EmptyState, { glyph: "decisions", title: order.length ? "Choose a decision" : "Nothing to decide", frame: "none" });
    const detail = current.entry
      ? h(ReviewItem, { key: "item", entry: current.entry, step, onCommand, bar: bulkBar })
      : link.status === "connected" && queue ? (bulkBar ? h(ui.Subview, { header: null, footer: bulkBar }, h(ui.PanelBody, null, empty)) : empty) : null;
    return h(ui.Page, { label: "Reviews", fill: true, header: h(ui.PanelHeader, { title: "Reviews", glyph: "decisions", actions: [...accountActions(link, true), h(ui.IconButton, { key: "refresh", label: "Refresh", glyph: "refresh", large: true, onClick: () => bridge.queue.refresh() })] }),
      onFocus: focusIn, onBlur: focusOut },
      h(ui.Split, { key: "split", label: "Decisions waiting", list, listHeader, detail }));
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
    useView();
    const step = useStepping(entry, setEntry, filter);
    const { link, queue, error, retry } = useQueue();
    const work = useWorked(filter, link.status === "connected");
    let body;
    if (entry) body = h(ReviewItem, { entry, step, onBack: () => setEntry(null), onCommand, accountActions: accountActions(link, false) });
    else {
      let list;
      if (link.status !== "connected") list = h(NotConnected, { link });
      else if (error && !queue) list = h(ui.Failure, { message: plain(error.message, 300), retry, retryLabel: "Try again" });
      else if (!queue) list = h(ui.Skeleton, { layout: "list" });
      else list = h(QueueList, { queue: work.queue ?? queue, onOpen: setEntry, filter, onFilter: setFilter, goal: work.goal, goals: work.choices, onGoal: (goal) => chooseGoal(filter, goal) });
      // The whole queue's total, else the server's total for what is shown.
      const waiting = work.exact ? work.queue?.total : work.order.length;
      body = h(ui.Subview, { header: h(ui.PanelHeader, { title: waiting ? `${waiting} waiting` : "Reviews",
        actions: [...accountActions(link, false), h(ui.IconButton, { key: "refresh", label: "Refresh", glyph: "refresh", large: true, onClick: () => bridge.queue.refresh() })] }) }, h(ui.PanelBody, null, list));
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
    const title = item ? reviewHeadline({ question: item.card?.question, title: item.title, reviewTitle: review.title }) : failed?.code === "elsewhere" ? "A Black 4 review" : failed ? "A Black 4 review" : "Loading the review…";
    const { maker } = item ? reviewByline(review, item) : { maker: null };
    const profile = maker?.pubkey ? bridge.profile?.(maker.pubkey) : null;
    const kind = item ? store.pictureKind(review.businessId, review.assetId, item.key) : null;
    const queued = item ? reviewOrder(store.queue).find((entry) => entry.assetId === review.assetId && entry.key === item.key) : null;
    React.useEffect(() => { if (kind) store.image(review.businessId, review.assetId, item.key, kind); }, [kind, item?.key]);
    return h(ui.MessageRow, { title,
      subtitle: state ? `${review.businessName} · ${screens.bylineWords(review, item)} · ${state.text}` : failed ? (failed.code === "elsewhere" ? "Not in your queue" : "Couldn't read it") : "",
      avatar: maker ? h(ui.Avatar, { name: profile?.name || maker.name, picture: profile?.picture, size: "small", shape: maker.agent ? "squircle" : "circle" }) : null,
      thumbnail: (queued ? store.queuePicture(queued) : null) ?? (kind ? store.picture(review.businessId, review.assetId, item.key, kind) : null),
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
      // The server's counts for every business, not what the capped list holds.
      const next = reviewBusinessCounts(store.queue).map((business) => ({ id: business.businessId, label: business.businessName, count: business.count }));
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
// ---- end reviews ----
export { reviewScreens, reviewReplaces, reviewByline, reviewQueueOf, reviewBusinessCounts, reviewHeadline, reviewDestination, reviewGoalChoices, reviewGoalNow, reviewShown, REVIEW_ALL_GOALS, REVIEW_NO_GOAL, reviewLocator, reviewLink, reviewOrder, reviewGroups, reviewState, reviewData, wordDiff, reviewsPart, reviewsSlot, REVIEW_UNDO_MS };

/** buzz-acp's own conversation levers, by the names the machine lists them
 * under (`controls` in its models reply: the bounds or values of each, and
 * buzz-acp's default), as rows. A number row offers a few presets within the
 * machine's bounds; "" is buzz-acp's default (sent as null). */
const durationLabel = (seconds) => seconds % 3600 === 0 ? (seconds === 3600 ? "1 hour" : `${seconds / 3600} hours`) : `${Math.round(seconds / 60)} minutes`;
export const CONVERSATION_ROWS = [
  { id: "agents", title: "Parallel work", description: "Conversations it works on at once.", presets: [1, 2, 3, 4, 5, 6, 7, 8], label: (n) => String(n) },
  { id: "sessionPolicy", title: "Session per", labels: { channel: "Channel", thread: "Thread" } },
  { id: "multipleEventHandling", title: "New message while working", labels: { steer: "Weave it in", queue: "Wait", interrupt: "Replace the task", "owner-interrupt": "Replace only for me" } },
  { id: "maxTurnsPerSession", title: "Fresh session after", description: "Turns before a conversation starts over.", presets: [0, 10, 25, 50, 100, 250, 500, 1000], label: (n) => n === 0 ? "Never" : `${n} turns` },
  { id: "maxTurnDuration", title: "Max turn length", description: "How long one answer may take.", presets: [300, 900, 1800, 3600, 7200, 14400, 28800, 86400], label: durationLabel },
  { id: "contextMessageLimit", title: "Context for replies", description: "Earlier messages it reads before answering.", presets: [0, 4, 8, 12, 20, 30, 50, 100], label: (n) => n === 0 ? "None" : `${n} messages` },
];

/** One conversation row's choices for `value` (the agent's own, or null for
 * buzz-acp's default) under the machine's `schema` for it, or null when the
 * machine lists none. A heartbeat agent runs at least two parallel
 * conversations, so with `heartbeat` on the default reads 2 and 1 cannot be
 * picked. A value outside the presets stays offered, so it is never hidden. */
export function controlOptions(row, schema, value, { heartbeat = false } = {}) {
  if (!schema || typeof schema !== "object") return null;
  const numeric = !Array.isArray(schema.values);
  const label = (entry) => (row.labels ? row.labels[entry] ?? String(entry) : row.label(entry));
  const within = (n) => (schema.min === undefined || n >= schema.min) && (schema.max === undefined || n <= schema.max);
  const values = numeric ? row.presets.filter(within) : schema.values;
  const floor = row.id === "agents" && heartbeat ? 2 : null;
  const standard = schema.default === undefined ? null : floor !== null ? Math.max(floor, Number(schema.default)) : schema.default;
  const chosen = value === null || value === undefined || value === "" ? "" : String(value);
  const options = [
    { id: "", label: standard === null ? "Default" : `Default (${label(standard)})` },
    ...values.map((entry) => ({ id: String(entry), label: label(entry), ...(floor !== null && Number(entry) < floor ? { unavailable: true } : {}) })),
  ];
  if (chosen && !options.some((option) => option.id === chosen)) options.push({ id: chosen, label: label(numeric ? Number(chosen) : chosen) });
  return { value: chosen, options, numeric };
}

/** What `settings.set` takes for a conversation row's pick: null for buzz-acp's default. */
export const controlValue = (row, schema, id) => (id === "" ? null : Array.isArray(schema?.values) ? id : Number(id));

/** Registers the "Black 4 hardware" agent type on `ctx`. `report(error)` hears
 * any failure of its components, so the plugin's Settings card can say so;
 * `sign` mints a door pass (the MCP's `sign_hardware_request`);
 * `access` is the Agent access link (`use()` reads it in a component, `link()`
 * asks for it), so the form can offer the one step it needs. */
export function applyHardware(ctx, { report = () => {}, access, sign, businesses } = {}) {
  const React = ctx.react;
  const h = React.createElement;
  const ask = sign && typeof ctx.host?.request === "function"
    ? doorTransport({ request: (input) => ctx.host.request(input), sign })
    : undefined;
  const statuses = statusReader(ask);
  // The businesses an agent can answer, read once per Buzz session from Black 4.
  let businessList = null;
  let businessRead = null;
  const readBusinesses = () => {
    if (businessList || typeof businesses !== "function") return Promise.resolve(businessList ?? []);
    businessRead ??= businesses().then((rows) => (businessList = businessesOf(rows)), () => []).finally(() => { businessRead = null; });
    return businessRead;
  };
  const modelLists = modelsReader(ask);
  const directory = agentDirectory(ask);
  const remote = hardwareProvider(ask, undefined, directory);
  const beats = heartbeatRemote(ask, directory);

  // Learn each agent's machine and harness once, off the render path, so
  // summaries and later steps have them.
  if (ask) setTimeout(() => { void directory.refresh(); }, 0);

  // The screens are drawn in Buzz's own primitives (buzzUi), laid out as
  // Buzz's Settings: a title, a rounded card of rows, each row a label and a
  // muted line on the left and its control on the right.
  const { SectionTitle, Group, Row, Button, Input, SwitchRow, Pill, TextField, Stack, Actions, ErrorLine, Spinner, Status, Value, Alert, Code,
    Page, PanelHeader, IconButton, EmptyState, Failure, Tabs, AgentBrowse, AgentGrid, AgentCard, CardMark, AgentPanel, AgentProfile, NameInput, NameActions,
    Menu, AvatarChoices, Caption, Line, Picture, Glyph } = buzzUi(React, { nativeSelect: NATIVE_SELECT });
  // An unsaved edit per agent, kept across Buzz mounting the Identity and
  // Settings tabs apart (each tab mounts the component anew).
  const drafts = new Map();

  // The person's Black 4 sign-in, and its Sign in, from the plugin. A sign-in
  // that ended leaves this type registered; its views then show Sign in, and
  // read the machine again once signed in.
  const SignInPrompt = access?.signIn?.Prompt;
  const ApprovalPrompt = access?.approval?.Prompt;
  // Signed out (or signing in): show Sign in. Reachable: Black 4 is
  // connected, so the door can mint passes. In between (starting, failed)
  // the machine is not asked; it is asked once connected.
  // `needsApproval`: Black 4 asked for a fresh browser approval before more
  // passes; `epoch` counts approvals given, so views read again after one.
  const useBlack4 = () => {
    const status = access?.signIn ? access.signIn.use?.() : "connected";
    const approval = access?.approval?.use?.() ?? { needed: false, epoch: 0 };
    // Idle shows the same prompt as signed out (its Approve); neither reaches the machine.
    return { signedOut: status === "signed-out" || status === "signing-in" || status === "idle", reachable: status === "connected", needsApproval: approval.needed, epoch: approval.epoch };
  };

  /** The machine's status (or its models), read in an effect and shared across views. */
  const useReader = (reader, machineId) => {
    const { reachable, epoch } = useBlack4();
    const [status, setStatus] = React.useState(() => reader.peek(machineId));
    const wasReachable = React.useRef(reachable);
    const lastEpoch = React.useRef(epoch);
    React.useEffect(() => {
      let live = true;
      // Just connected, or just approved again: anything read before is stale.
      const back = (!wasReachable.current && reachable) || lastEpoch.current !== epoch;
      wasReachable.current = reachable;
      lastEpoch.current = epoch;
      setStatus(reader.peek(machineId));
      const off = reader.subscribe((id) => { if (live && id === machineOf(machineId).id) setStatus(reader.peek(machineId)); });
      if (ask && reachable) void reader.read(machineId, back ? { force: true } : undefined).then((next) => { if (live) setStatus(next); });
      return () => { live = false; off(); };
    }, [machineId, reachable, epoch]);
    return status;
  };
  const useStatus = (machineId) => useReader(statuses, machineId);
  const useBusinesses = () => {
    const { reachable } = useBlack4();
    const [rows, setRows] = React.useState(() => businessList ?? []);
    React.useEffect(() => {
      let live = true;
      if (reachable) void readBusinesses().then((next) => { if (live) setRows(next); });
      return () => { live = false; };
    }, [reachable]);
    return rows;
  };
  const useModels = (machineId) => useReader(modelLists, machineId);
  /** The conversation levers the machine lists (its models reply), or null on an older machine. */
  const controlSchema = (models) => (models?.kind === "ok" && models.controls && typeof models.controls === "object" ? models.controls : null);

  /** Model, Thinking and Compact at for one harness, when the machine lists its models. */
  const ModelRows = ({ models, harness, value, onPick, disabled, note, shape }) => {
    const choices = modelChoices(models, harness, value);
    if (!choices) return null;
    return h(React.Fragment, null,
      h(Row, { title: "Model", description: note || undefined,
        trailing: h(Pill, { label: "Model", shape, value: choices.model, options: choices.models, disabled,
          onChange: (model) => onPick(applyPick(models, harness, value, { model })) }) }),
      choices.efforts.length > 0 && h(Row, { title: "Thinking",
        trailing: h(Pill, { label: "Thinking", shape, value: choices.effort ?? "", options: choices.efforts, disabled,
          onChange: (effort) => onPick(applyPick(models, harness, value, { effort })) }) }),
      // Greyed, with the machine's one-line reason, where the harness has no lever here.
      choices.compact && h(Row, { title: "Compact at", description: choices.compact.supported ? "Context it keeps before compacting." : choices.compact.note ?? undefined, disabled: !choices.compact.supported,
        trailing: h(Pill, { label: "Compact at", shape, value: choices.compact.value, options: choices.compact.options, disabled: disabled || !choices.compact.supported,
          onChange: (id) => onPick({ compactAt: id ? Number(id) : null }) }) }));
  };

  /** The Conversations card: buzz-acp's levers, as the machine lists them. */
  const ConversationRows = ({ schema, controls, heartbeat, disabled, onChange, shape }) =>
    h(React.Fragment, null, ...CONVERSATION_ROWS.map((row) => {
      const choice = controlOptions(row, schema[row.id], controls?.[row.id], { heartbeat });
      if (!choice) return null;
      const description = row.id === "agents" && heartbeat ? "At least 2 while its heartbeat is on." : row.description;
      return h(Row, { key: row.id, title: row.title, description,
        trailing: h(Pill, { label: row.title, shape, value: choice.value, options: choice.options, disabled,
          onChange: (id) => onChange(row.id, controlValue(row, schema[row.id], id)) }) });
    }));

  /** Sign-in for one harness on one machine, as rows of the card: its state,
   * and the flow (a link to open, a code or key to paste) when one is under way. */
  const SignInRows = ({ machineId, harness, status, disabled, pays = "subscription", shape }) => {
    const machine = machineOf(machineId);
    const state = signInState(status, harness, pays);
    const [login, setLogin] = React.useState({ step: "idle" });
    const [code, setCode] = React.useState("");
    const [copied, setCopied] = React.useState(false);
    const flow = React.useRef(null);
    const inputId = React.useId();
    React.useEffect(() => {
      const current = createLogin(ask, machine.id, harness, {
        pays,
        onChange: setLogin,
        // A harness signed out lists no models; signed in, it does.
        onSignedIn: () => Promise.all([statuses.read(machine.id, { force: true }), modelLists.read(machine.id, { force: true })]),
      });
      flow.current = current;
      setLogin(current.state);
      setCode("");
      return () => { if (flow.current === current) flow.current = null; void current.dispose(); };
    }, [machine.id, harness, pays]);

    const label = harnessLabel(harness) ?? harness;
    const key = pays === "key";
    const title = key ? "API key" : "Sign-in";
    const row = (description, trailing) => h(Row, { title, description, trailing });
    const button = (props, text) => h(Button, { size: "sm", shape, ...props }, text);
    const cancel = (extra) => button({ onClick: () => { setCode(""); void flow.current?.cancel(); }, ...extra }, "Cancel");
    if (state.kind === "loading") return row(`Checking ${machine.label}…`, h(Spinner));
    if (state.kind === "unreachable") return row(Alert(state.error || `Could not reach the ${machine.label}.`),
      button({ disabled, onClick: () => void statuses.read(machine.id, { force: true }) }, "Try again"));
    if (state.kind === "unsupported") return row(`The ${machine.label} cannot report sign-in yet.`);
    if (state.kind === "not-installed") return row(Alert(`${label} is not installed on the ${machine.label}.`));
    if (state.kind === "unavailable") return row(Alert(`${label} is unavailable: ${state.reason}`));
    if (state.kind === "signed-in" && !["waiting", "finishing", "renewing"].includes(login.step))
      return row(state.account ? `Signed in as ${state.account}` : key ? `${label} has an API key` : `${label} is signed in`);
    const start = (busy) => button({ variant: "prominent", disabled: disabled || busy, loading: busy, onClick: () => void flow.current?.start() }, key ? "Add key" : "Sign in");
    if (state.kind === "unknown" && login.step === "idle")
      return row(login.error ? Alert(login.error) : key ? "API key status unknown" : "Sign-in status unknown", start(false));

    // Not signed in, or a sign-in under way.
    const busy = login.step === "starting" || login.step === "finishing" || login.step === "renewing";
    if (login.step === "renewing") return row(Alert(login.error), Status("Getting a new link…"));
    if (login.step === "idle" || login.step === "starting" || login.step === "done")
      return row(login.error ? Alert(login.error)
          : login.step === "done" ? (key ? "Key saved. Checking…" : "Signed in. Checking…") : key ? `${label} has no API key` : `${label} is not signed in`,
        h(React.Fragment, null, login.step !== "done" && start(busy), login.step === "starting" && cancel()));

    const copy = () => {
      Promise.resolve(globalThis.navigator?.clipboard?.writeText?.(login.url))
        .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
    };
    const pasteKey = login.flow === "key";
    const link = (text) => h(Row, { title: text, trailing: h(React.Fragment, null,
      button({ href: login.url }, "Open"), button({ onClick: copy }, copied ? "Copied" : "Copy link")) });
    if (!login.needsCode) return h(React.Fragment, null,
      row(login.error ? Alert(login.error) : login.step === "finishing" ? "Signing in…" : `Waiting for you to approve it. The ${machine.label} finishes by itself.`,
        h(React.Fragment, null, h(Spinner), cancel())),
      link(SIGN_IN_SITE[harness] ? `Open ${SIGN_IN_SITE[harness]}` : `Open ${label} sign-in`),
      login.userCode && h(Row, { title: "Approve this code there", trailing: Code(login.userCode) }));
    // A key (flow "key"): the link opens the page where an API key is made,
    // and the key is pasted in place of a code. It goes to the machine once
    // and is kept there; it is never shown or kept here.
    const submit = () => {
      const pasted = code;
      setCode("");
      void flow.current?.finish(pasted);
    };
    return h(React.Fragment, null,
      row(login.error ? Alert(login.error) : pasteKey ? "The key goes to the machine once and stays there." : "Paste the code the page shows.", cancel()),
      link(pasteKey ? "Open the API keys page" : login.renewed ? `Open new ${label} sign-in` : `Open ${label} sign-in`),
      // Not a <form>: this sits inside Buzz's own Create agent form, and a
      // nested form's submit goes to the outer one, which abandons the dialog.
      h(Row, { title: pasteKey ? "Paste the key" : "Paste the code", controlId: inputId, trailing: h(React.Fragment, null,
        h(Input, { id: inputId, type: "password", autoComplete: "off", spellCheck: false, controlSize: "sm", width: "11rem",
          placeholder: pasteKey ? "API key" : "Code", value: code, disabled: busy, onChange: (event) => setCode(event.target.value),
          onKeyDown: (event) => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); if (!busy && code.trim()) submit(); } } }),
        button({ variant: "prominent", disabled: !code.trim(), loading: busy, onClick: submit }, pasteKey ? "Save key" : "Finish")) }));
  };

  /** The one step before an agent here can use Black 4 as its owner: the
   * Agent access link from Settings → Black 4, offered in place. */
  const LinkRow = () => {
    const link = access.use();
    if (link.status !== "unlinked" && link.status !== "linking") return null;
    const linking = link.status === "linking";
    return h(Row, { title: "Agent access", description: "Link your agents so it can use Black 4 as you.",
      trailing: h(Button, { size: "sm", variant: "prominent", loading: linking, onClick: () => void access.link() }, "Link my agents") });
  };

  const Configuration = ({ config, onChange, disabled, harnessControl, onReadyChange }) => {
    const value = { ...hardwareDefaults(), ...(config ?? {}) };
    const machine = machineOf(value.machine);
    const status = useStatus(machine.id);
    const models = useModels(machine.id);
    const options = harnessOptions(status);
    const offered = options.length ? options : HARNESSES;
    const businessRows = useBusinesses();
    const pays = value.pays || defaultPays(status, value.harness);
    const state = ask ? signInState(status, value.harness, pays) : { kind: "unreachable" };

    // A harness the machine does not have, or cannot sign in: suggest the
    // first one it can run.
    const usable = options.filter((entry) => !entry.unavailable);
    React.useEffect(() => {
      if (status?.kind === "ok" && usable.length && !usable.some((entry) => entry.id === value.harness))
        onChange({ ...value, harness: usable[0].id, model: "", effort: "" }, { suggested: true });
    }, [status, value.harness]);
    const { signedOut, needsApproval } = useBlack4();
    const isReady = !signedOut && !needsApproval && readyToCreate(state) && (status?.kind !== "ok" || usable.some((entry) => entry.id === value.harness));
    React.useEffect(() => { onReadyChange?.(isReady); }, [onReadyChange, isReady]);
    React.useEffect(() => () => onReadyChange?.(false), [onReadyChange]);

    // The host's Harness row is the first row of this card, as in Buzz's own dialog.
    if (signedOut && SignInPrompt) return h(Stack, null, h(Group, null, harnessControl), h(SignInPrompt, null));
    if (needsApproval && ApprovalPrompt) return h(Stack, null, h(Group, null, harnessControl), h(ApprovalPrompt, null));

    const noHarness = status?.kind === "ok" && !options.length;
    const audience = audienceValue(value.respondTo === "anyone" ? "staff" : value.respondTo, value.businessId) || "staff";
    const schema = controlSchema(models);
    const controls = value.controls && typeof value.controls === "object" ? value.controls : {};
    const minutes = Number(value.heartbeat) > 0 ? Number(value.heartbeat) : 0;
    return h(Stack, null,
      h(Group, null,
        harnessControl,
        access && h(LinkRow),
        h(Row, { title: "Runs on", trailing: h(Pill, { label: "Runs on", value: machine.id, options: MACHINES, disabled, onChange: (id) => onChange({ ...value, machine: id }) }) }),
        h(Row, { title: "Runs", description: noHarness ? Alert(`No harness is installed on the ${machine.label}.`) : undefined,
          trailing: h(Pill, { label: "Runs", value: value.harness, options: noHarness ? [] : offered, disabled: disabled || noHarness,
            onChange: (harness) => onChange({ ...value, harness, pays: "", model: "", effort: "" }) }) }),
        takesKey(status, value.harness) && h(Row, { title: "Pays with", trailing: h(Pill, { label: "Pays with", value: pays, options: PAYS, disabled,
          onChange: (next) => onChange({ ...value, pays: next, model: "", effort: "" }) }) }),
        h(ModelRows, { models, harness: value.harness, value: { ...value, pays }, disabled, onPick: (pick) => onChange({ ...value, ...pick }) }),
        h(Row, { title: "Audience", description: value.access === "platform" ? "Customer-facing: only the Black 4 tools." : "Who it answers in the community.", trailing: h(Pill, { label: "Audience", value: audience,
          options: audienceOptions(businessRows, { current: audience }), disabled, onChange: (next) => onChange({ ...value, ...audienceSettings(next) }) }) }),
        ask && h(SignInRows, { machineId: machine.id, harness: value.harness, status, disabled, pays })),
      !ask && (SignInPrompt ? h(SignInPrompt, null) : ErrorLine("Sign in to Black 4 in Settings → Black 4 to reach Black 4 hardware.")),
      // The heartbeat is set with the agent (activate takes it, and what it does): empty is Black 4's standard.
      h("div", null,
        h(SectionTitle, { title: "Heartbeat" }),
        h(Stack, { gap: 2 }, h(Group, null,
          h(SwitchRow, { label: "Heartbeat", description: "Wakes on its own to run the jobs due in Black 4.", checked: minutes > 0, disabled,
            onCheckedChange: (on) => onChange({ ...value, heartbeat: on ? HEARTBEAT_MINUTES : 0 }) }),
          minutes > 0 && h(Row, { title: "Wakes", trailing: h(Pill, { label: "Heartbeat interval", value: String(minutes), disabled,
            options: heartbeatChoices(minutes).map((choice) => ({ id: String(choice.value), label: choice.label })),
            onChange: (id) => onChange({ ...value, heartbeat: Number(id) }) }) })),
          minutes > 0 && h(TextField, { label: "On each heartbeat", optional: true, rows: 6, maxLength: 8000, disabled,
            description: "Empty runs Black 4’s standard: the jobs due for this agent in Black 4, one after another.",
            placeholder: "Check the Paid media board for every business, and raise a Review for any campaign over budget.",
            value: value.heartbeatPrompt ?? "", onChange: (heartbeatPrompt) => onChange({ ...value, heartbeatPrompt }) }))),
      schema && h("div", null,
        h(SectionTitle, { title: "Conversations" }),
        h(Group, null, h(ConversationRows, { schema, controls, heartbeat: minutes > 0, disabled,
          onChange: (name, next) => onChange({ ...value, controls: { ...controls, [name]: next } }) }))));
  };

  const Create = ({ config, onChange, disabled }) => {
    const value = { ...hardwareDefaults(), ...(config ?? {}) };
    return h(TextField, { label: "Instructions", optional: true, rows: 4, maxLength: 20000, placeholder: "Help me plan my week and prioritize tasks.",
      value: value.instructions, disabled, onChange: (instructions) => onChange({ ...value, instructions }) });
  };

  /** The Identity and Settings tabs (splitSettings): `settingsSection`
   * "identity" (harness, model, instructions), "runtime" (the machine, the
   * heartbeat, conversations), or both when unset. */
  const Settings = ({ agent, settingsHost, settingsSection, settingsContent }) => {
    const pubkey = agent.pubkey;
    const [seen, setSeen] = React.useState(() => directory.peek(pubkey));
    const [machineId, setMachineId] = React.useState(() => machineOf(seen?.machine).id);
    const [run, setRun] = React.useState({ loading: true });
    const [restarting, setRestarting] = React.useState(false);
    const [text, setText] = React.useState({ loading: true, base: "", draft: "" });
    const [saving, setSaving] = React.useState(false);
    const [revision, setRevision] = React.useState(0);
    const [beat, setBeat] = React.useState({ loading: true, minutes: 0, base: "", draft: "", custom: false, defaultPrompt: "" });
    const [beatBusy, setBeatBusy] = React.useState(false);
    const [picking, setPicking] = React.useState({ saving: false });
    const { signedOut, reachable, needsApproval, epoch } = useBlack4();

    React.useEffect(() => directory.subscribe(() => setSeen(directory.peek(pubkey))), [pubkey]);
    React.useEffect(() => {
      if (!reachable) return undefined; // read once connected (Sign in shows while signed out)
      const controller = new AbortController();
      const { signal } = controller;
      setRun((prior) => ({ ...prior, loading: true, error: undefined }));
      void (async () => {
        const machine = await directory.machine(pubkey);
        if (signal.aborted) return;
        setMachineId(machine.id);
        const [status, instructions, heartbeat] = await Promise.allSettled([
          askMachine(ask, machine, { op: "status", pubkey }, { signal, timeoutMs: STATUS_TIMEOUT_MS }),
          remote.instructions.get({ pubkey, signal }),
          beats.get({ pubkey, signal }),
        ]);
        if (signal.aborted) return;
        if (status.status === "fulfilled") {
          const reply = status.value;
          const audience = audienceValue(reply.respondTo, reply.audience?.businessId);
          directory.remember(pubkey, { machine: machine.id, harness: reply.harness, respondTo: audience });
          const pays = reply.pays === "key" ? "key" : "subscription";
          setRun({ loading: false, running: !!reply.running, activated: !!reply.activated, harness: reply.harness, respondTo: audience, pays,
            access: reply.access === "platform" ? "platform" : "full",
            createdBy: typeof reply.createdBy === "string" ? reply.createdBy : null, yours: reply.yours !== false,
            controls: reply.controls && typeof reply.controls === "object" ? reply.controls : null,
            unheard: unheardText(reply.audience?.unheard),
            ...("model" in reply ? { model: { pays, model: reply.modelChosen ? reply.model : "", effort: reply.effortChosen ? reply.effort : "",
              compactAt: typeof reply.compactAt === "number" ? reply.compactAt : null,
              shown: reply.model, shownEffort: reply.effort, note: reply.modelNote, problem: reply.modelProblem } } : {}) });
        } else setRun({ loading: false, error: String(status.reason?.message ?? status.reason) });
        const kept = drafts.get(pubkey) ?? {};
        if (instructions.status === "fulfilled") setText({ loading: false, base: instructions.value, draft: kept.instructions ?? instructions.value });
        else setText({ loading: false, base: "", draft: "", error: String(instructions.reason?.message ?? instructions.reason) });
        if (heartbeat.status === "fulfilled") setBeat({ ...beatFrom(heartbeat.value), ...(kept.prompt === undefined ? {} : { draft: kept.prompt }) });
        else setBeat({ loading: false, minutes: 0, base: "", draft: "", custom: false, defaultPrompt: "", error: String(heartbeat.reason?.message ?? heartbeat.reason) });
      })().catch((error) => { if (!signal.aborted) setRun({ loading: false, error: String(error?.message ?? error) }); });
      return () => controller.abort();
    }, [pubkey, revision, reachable, epoch]);

    const latest = React.useRef(null);
    latest.current = { text, beat };
    React.useEffect(() => () => {
      const { text, beat } = latest.current;
      const kept = { ...(!text.loading && text.draft !== text.base ? { instructions: text.draft } : {}), ...(!beat.loading && beat.draft !== beat.base ? { prompt: beat.draft } : {}) };
      if (Object.keys(kept).length) drafts.set(pubkey, kept); else drafts.delete(pubkey);
    }, [pubkey]);

    const machine = machineOf(machineId);
    const harness = run.harness ?? seen?.harness;
    const respondTo = run.respondTo ?? seen?.respondTo;
    const status = useStatus(machine.id);
    const businessRows = useBusinesses();
    const models = useModels(machine.id);

    // A pick goes to the machine at once (Buzz's selects apply on change);
    // its progress and any refusal show under the card it was made in.
    const pick = async (choice, section) => {
      if (picking.saving) return;
      setPicking({ saving: true, section });
      try {
        await setModel(ask, directory, { pubkey, ...choice });
        setPicking({ saving: false, section });
        setRevision((value) => value + 1);
      } catch (error) {
        setPicking({ saving: false, section, error: String(error?.message ?? error) });
      }
    };
    const picked = (section) => picking.section === section && (picking.saving ? Status("Restarting with it…") : picking.error ? ErrorLine(picking.error) : null);

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

    // Each change restarts the agent on its machine, so it applies at once.
    const saveBeat = async (change) => {
      if (beatBusy) return;
      setBeatBusy(true);
      try {
        setBeat(beatFrom(await beats.set({ pubkey, ...change })));
        setRevision((value) => value + 1);
      } catch (error) {
        setBeat((prior) => ({ ...prior, error: String(error?.message ?? error) }));
      } finally { setBeatBusy(false); }
    };
    const beatDirty = beat.draft !== beat.base;
    const dirty = text.draft !== text.base;
    const identity = settingsSection !== "runtime";
    const runtime = settingsSection !== "identity";
    const shape = "control"; // Buzz's pills in an agent's settings
    const harnessRow = settingsHost?.typeControl?.(false);
    const busy = picking.saving || run.loading;

    if (signedOut && SignInPrompt) return h(Stack, null,
      identity && harnessRow && h(Group, null, harnessRow), h(SignInPrompt, null), runtime && settingsContent);
    const schema = controlSchema(models);
    const actions = (...buttons) => h(Actions, null, ...buttons);
    return h(Stack, null,
      needsApproval && ApprovalPrompt && h(ApprovalPrompt, null),
      identity && (harnessRow || run.model) && h(Group, null,
        harnessRow,
        run.model && (modelChoices(models, harness, run.model)
          ? h(ModelRows, { models, harness, value: run.model, disabled: busy, note: run.model.note, shape, onPick: (choice) => void pick(choice, "model") })
          : run.model.shown && h(Row, { title: "Model", description: run.model.note || undefined,
            trailing: Value(run.model.shownEffort ? `${run.model.shown} · ${EFFORT_LABELS[run.model.shownEffort] ?? run.model.shownEffort}` : run.model.shown) }))),
      identity && picked("model"),
      identity && run.model?.problem && ErrorLine(run.model.problem),
      identity && !runtime && run.error && ErrorLine(run.error),
      identity && h(Stack, { as: "form", gap: 2, onSubmit: (event) => { event.preventDefault(); void save(); } },
        h(TextField, { label: "Instructions", rows: 8, maxLength: 20000, value: text.draft, disabled: text.loading || saving, error: text.error,
          placeholder: text.loading ? "Loading…" : "Help me plan my week and prioritize tasks.", onChange: (draft) => setText({ ...text, draft, error: undefined }) }),
        dirty && actions(
          h(Button, { disabled: saving, onClick: () => setText({ ...text, draft: text.base, error: undefined }) }, "Discard"),
          h(Button, { type: "submit", variant: "prominent", loading: saving }, saving ? "Saving…" : "Save"))),
      runtime && h("div", null,
        h(SectionTitle, { title: "Machine" }),
        h(Group, null,
          h(Row, { title: "Runs on", trailing: Value(machine.label) }),
          h(Row, { title: "Runs", trailing: Value(harnessLabel(harness) ?? (run.loading ? "…" : "Unknown")) }),
          // How it pays: a change restarts it on the other sign-in, with that one's default model.
          run.pays && takesKey(status, harness) && h(Row, { title: "Pays with", trailing: h(Pill, { label: "Pays with", shape, value: run.pays, options: PAYS, disabled: busy,
            onChange: (pays) => void pick({ pays, model: "", effort: "" }, "machine") }) }),
          // It runs on its creator's own sign-in: yours shows here to manage;
          // someone else's agent names whose it runs on.
          harness && (run.yours === false
            ? h(Row, { title: run.pays === "key" ? "API key" : "Sign-in", trailing: Value(run.createdBy ? `${run.createdBy}’s` : "No one’s") })
            : h(SignInRows, { machineId: machine.id, harness, status, disabled: false, pays: run.pays ?? "subscription", shape })),
          h(Row, { title: "Status", description: run.error ? Alert(run.error) : undefined, trailing: h(React.Fragment, null,
            run.loading ? Status("Checking…") : Value(run.running ? "Running" : run.activated === false ? "Not set up" : "Stopped"),
            h(Button, { size: "sm", shape, loading: restarting, disabled: run.loading, onClick: () => void restart() }, "Restart")) }),
          // Whom it answers: a change restarts it (the machine applies it at the start).
          // A customer-facing agent answers one business, so it is offered businesses only.
          h(Row, { title: "Audience", description: "Who it answers in the community.", trailing: respondTo
            ? h(Pill, { label: "Audience", shape, value: respondTo, disabled: busy,
              // A full-access agent never answers a business; a customer-facing one answers only one.
              options: run.access === "platform" ? audienceOptions(businessRows, { current: respondTo }).filter((option) => option.id.startsWith("business:"))
                : audienceOptions([], { settings: true, current: respondTo }),
              onChange: (next) => { const { respondTo: mode, businessId } = audienceSettings(next); void pick({ controls: mode === "business" ? { respondTo: mode, businessId } : { respondTo: mode } }, "machine"); } })
            : Value(run.loading ? "…" : "Unknown") }),
          // What its gate dropped: silent to the sender, so said here.
          run.unheard && h(Row, { title: "Not heard", description: run.unheard })),
        picked("machine")),
      runtime && h(Stack, null,
        h("div", null,
          h(SectionTitle, { title: "Heartbeat" }),
          h(Group, null,
            h(SwitchRow, { label: "Heartbeat", description: beat.error ? Alert(beat.error) : "Wakes on its own to run the jobs due in Black 4.",
              checked: beat.minutes > 0, disabled: beat.loading || beatBusy, onCheckedChange: (on) => void saveBeat({ minutes: on ? HEARTBEAT_MINUTES : 0 }) }),
            beat.minutes > 0 && h(Row, { title: "Wakes", trailing: h(Pill, { label: "Heartbeat interval", shape, value: String(beat.minutes), disabled: beatBusy,
              options: heartbeatChoices(beat.minutes).map((choice) => ({ id: String(choice.value), label: choice.label })),
              onChange: (id) => void saveBeat({ minutes: Number(id) }) }) }))),
        h(Stack, { as: "form", gap: 2, onSubmit: (event) => { event.preventDefault(); void saveBeat({ prompt: beat.draft.trim() === beat.defaultPrompt.trim() ? "" : beat.draft }); } },
          h(TextField, { label: "On each heartbeat", description: beat.loading ? undefined : beat.custom ? "Yours." : "Black 4’s standard.",
            rows: 8, maxLength: 8000, value: beat.draft, disabled: beat.loading || beatBusy, placeholder: beat.loading ? "Loading…" : undefined,
            onChange: (draft) => setBeat({ ...beat, draft, error: undefined }) }),
          (beatDirty || beat.custom) && actions(
            beatDirty && h(Button, { disabled: beatBusy, onClick: () => setBeat({ ...beat, draft: beat.base, error: undefined }) }, "Discard"),
            !beatDirty && beat.custom && h(Button, { disabled: beatBusy, onClick: () => void saveBeat({ prompt: "" }) }, "Use Black 4’s standard"),
            beatDirty && h(Button, { type: "submit", variant: "prominent", loading: beatBusy }, "Save")))),
      runtime && schema && h("div", null,
        h(SectionTitle, { title: "Conversations" }),
        h(Group, null, h(ConversationRows, { schema, controls: run.controls, heartbeat: beat.minutes > 0, disabled: busy, shape,
          onChange: (name, next) => void pick({ controls: { [name]: next } }, "conversations") })),
        picked("conversations")),
      runtime && settingsContent);
  };

  /** Black 4's mark, sized for a tab icon or a card's mark. */
  const Mark = (size) => h(Picture, { src: BLACK4_MARK, size });
  const robot = () => h(Glyph, { name: "robot" });
  /** "chris@black4.ai" → "Chris": the person who made an agent. */
  const personOf = (email) => {
    const local = String(email ?? "").split("@")[0];
    return local ? local.split(/[._-]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(" ") : "Black 4";
  };

  /** One open agent: Buzz's profile (picture, name, who made it, Change
   * avatar and Change name), then its Identity and Settings, the same ones
   * its maker sees in Buzz. */
  const TeamAgent = ({ agent, onClose, onChanged }) => {
    const [tab, setTab] = React.useState("identity");
    const [naming, setNaming] = React.useState(null); // { draft, saving, error }
    const [picking, setPicking] = React.useState(null); // { picture, saving, error }
    const name = agent.name || agent.pubkey.slice(0, 8);
    const save = async (change, done) => {
      try {
        await remote.profile({ pubkey: agent.pubkey, name: change.name ?? agent.name, picture: "picture" in change ? change.picture : agent.picture ?? null });
        done(null);
        onChanged();
      } catch (error) { done(String(error?.message ?? error)); }
    };
    const saveName = () => {
      const draft = naming.draft.trim();
      if (!draft) return setNaming({ ...naming, error: "Add a name to save your agent" });
      setNaming({ ...naming, saving: true, error: undefined });
      void save({ name: draft }, (error) => setNaming(error ? { draft, saving: false, error } : null));
    };
    const savePicture = () => {
      setPicking({ ...picking, saving: true, error: undefined });
      void save({ picture: picking.picture }, (error) => setPicking(error ? { ...picking, saving: false, error } : null));
    };
    const glass = agent.picture ? "glass" : "subtle";
    // The hero shows the avatar being chosen, as Buzz's Change avatar does.
    const picture = picking ? picking.picture : agent.picture;
    return h(AgentPanel, { name, picture: agent.picture, onClose },
      h(AgentProfile, { name, picture,
        under: Caption(`Made by ${personOf(agent.createdBy)} · ${agent.machine.label} · ${agent.running ? "Running" : agent.activated ? "Stopped" : "Not set up"}`),
        editing: naming && h(NameInput, { value: naming.draft, invalid: !!naming.error, onChange: (draft) => setNaming({ ...naming, draft, error: undefined }), onSubmit: saveName, onCancel: () => setNaming(null) }),
        actions: naming
          ? [h(NameActions, { key: "name" }, h(Button, { size: "sm", shape: "control", disabled: naming.saving, onClick: () => setNaming(null) }, "Cancel"),
              h(Button, { size: "sm", shape: "control", variant: "prominent", loading: naming.saving, onClick: saveName }, "Save")),
            naming.error ? Line(naming.error, { role: "alert", danger: true }) : null]
          : [h(Menu, { key: "menu", label: "Agent profile actions", variant: glass, items: [
              { label: "Change avatar", onSelect: () => setPicking({ picture: agent.picture ?? null }) },
              { label: "Change name", onSelect: () => setNaming({ draft: agent.name ?? "" }) }] })] },
        picking && h(Stack, { gap: 2 },
          h(SectionTitle, { title: "Change avatar" }),
          h(AvatarChoices, { value: picking.picture, disabled: picking.saving, onChange: (picture) => setPicking({ ...picking, picture, error: undefined }) }),
          picking.error ? ErrorLine(picking.error) : null,
          h(Actions, null,
            agent.picture ? h(Button, { disabled: picking.saving, onClick: () => setPicking({ ...picking, picture: null }) }, "Remove avatar") : null,
            h(Button, { disabled: picking.saving, onClick: () => setPicking(null) }, "Cancel"),
            h(Button, { variant: "prominent", loading: picking.saving, disabled: picking.picture === (agent.picture ?? null), onClick: savePicture }, "Save changes"))),
        h(Stack, null,
          h(Tabs, { label: `${name} sections`, value: tab, onChange: setTab,
            items: [{ value: "identity", label: "Identity" }, { value: "settings", label: "Settings" }] }),
          h(GuardedSettings, { key: `${agent.pubkey}:${tab}`, agent: { pubkey: agent.pubkey }, settingsSection: tab === "identity" ? "identity" : "runtime" }))));
  };

  /** The Black 4 team: every Black 4 hardware agent on every machine, for
   * every staff member, drawn as Buzz's Agents page. Buzz lists only the
   * agents this Buzz made; this shows everyone's, with who made each, and
   * opens the same profile and settings for any of them. */
  const AllAgents = () => {
    const { signedOut, reachable, epoch } = useBlack4();
    const [rows, setRows] = React.useState({ loading: true, machines: [] });
    const [selected, setSelected] = React.useState(null);
    const [show, setShow] = React.useState("team");
    const [revision, setRevision] = React.useState(0);
    const refresh = () => setRevision((value) => value + 1);
    React.useEffect(() => {
      if (!reachable || !ask) return undefined;
      let live = true;
      setRows((prior) => ({ ...prior, loading: true }));
      void Promise.all(MACHINES.map((machine) =>
        askMachine(ask, machine, { op: "list" }, { timeoutMs: STATUS_TIMEOUT_MS })
          .then((reply) => {
            const agents = (reply.agents ?? []).filter((row) => row?.pubkey);
            for (const row of agents) directory.remember(row.pubkey, { machine: machine.id, harness: row.harness, respondTo: audienceValue(row.respondTo, row.audience?.businessId) });
            return { machine, agents };
          }, (error) => ({ machine, agents: [], error: String(error?.message ?? error) }))))
        .then((machines) => { if (live) setRows({ loading: false, machines }); });
      return () => { live = false; };
    }, [reachable, epoch, revision]);

    const label = "Black 4 team";
    const all = rows.machines.flatMap(({ machine, agents }) => agents.map((agent) => ({ ...agent, machine })));
    const shown = show === "yours" ? all.filter((agent) => agent.yours) : all;
    const open = all.find((agent) => agent.pubkey === selected);
    const failures = rows.machines.filter((row) => row.error);
    const tabs = h(Tabs, { label: "Agent tabs", value: show, onChange: setShow,
      items: [{ value: "team", label: "All agents" }, { value: "yours", label: "Made by you" }] });
    const body = signedOut && SignInPrompt ? h(SignInPrompt, null)
      : rows.loading && !rows.machines.length ? Status("Loading agents…")
      : h(Stack, null,
        ...failures.map((row) => h(Failure, { key: row.machine.id, message: `${row.machine.label}: ${row.error}`, retry: refresh })),
        shown.length
          ? h(AgentGrid, { label: "Agents", busy: rows.loading }, ...shown.map((agent) => h(AgentCard, { key: agent.pubkey,
              name: agent.name || agent.pubkey.slice(0, 8), picture: agent.picture, selected: agent.pubkey === selected, unavailable: !agent.activated,
              detail: `${harnessLabel(agent.harness) ?? agent.harness} · ${personOf(agent.createdBy)}`, art: robot(),
              badge: h(CardMark, { art: Mark(16), label: "Black 4", color: BLACK4_BLUE }),
              menu: h(Menu, { label: `Actions for ${agent.name || "agent"}`, items: [
                { label: "Open settings", onSelect: () => setSelected(agent.pubkey) },
                { label: "Copy public key", onSelect: () => void globalThis.navigator?.clipboard?.writeText?.(agent.pubkey) }] }),
              onSelect: () => setSelected((value) => (value === agent.pubkey ? null : agent.pubkey)),
              onOpen: () => setSelected(agent.pubkey) })))
          : !failures.length && h(EmptyState, { title: show === "yours" ? "You have not made a Black 4 agent yet" : "No Black 4 agents yet",
              description: "Make one in Agents → New agent → Black 4 hardware. Every staff member sees it here." }));
    return h(AgentBrowse, { label, art: Mark(16), tabs,
      side: open ? h(TeamAgent, { key: open.pubkey, agent: open, onClose: () => setSelected(null), onChanged: refresh }) : null }, body);
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

  const GuardedSettings = guarded(Settings, "settings");

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
    tabs: [{ id: "settings", title: "Settings", role: "settings", splitSettings: true, component: GuardedSettings }],
    remote,
  });

  // Primary in the dock: Buzz lists a plugin page only when it is primary.
  ctx.pages?.register?.({ id: "black4-agents", title: "Black 4 team", primary: true, placement: "dock", layout: "workspace", icon: BLACK4_MARK, component: guarded(AllAgents, "agents") });
}

/** Offers the hardware type and takes it back. Buzz has no call to remove a
 * registered agent type, but a registration lasts as long as the scope that
 * made it, so the type lives in its own child scope (`ctx.plugin`), disposed to
 * withdraw it. Whatever the registration throws goes to `report`, never up to
 * the plugin: the MCP tools, Reviews and Agent access do not depend on it. */
export function hardwareSlot(ctx, { report, access, sign, businesses, register = applyHardware }) {
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
          register(ctx, { report, access, sign, businesses });
          return;
        }
        scope = ctx.plugin({
          name: "black4-hardware",
          inject: ["react", "host", "agents", "pages"],
          apply: (child) => {
            try { register(child, { report, access, sign, businesses }); } catch (error) { fail(error); }
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
