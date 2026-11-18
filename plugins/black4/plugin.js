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

  const toolCall = (name) => async (client, context, args) => {
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

  const register = (tools, instructions) => {
    for (const tool of tools) {
      const name = PREFIX + tool.name;
      if (registered.has(name)) continue;
      if (mintsPass(tool.name) || renews(tool.name)) continue; // never offered to agents
      if (appOnly(tool)) { appOnlyNames.add(String(tool.name).trim().toLowerCase()); continue; } // the person's click only
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
      if (!result?.isError) { const value = readAnswer(result); queue = value?.data && !value.kind ? value.data : value; }
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
    use: () => { const current = useBridgeState(); return { status: current.status, detail: current.detail, waiting: current.waiting, connect: reconnect }; },
    call: async (name, args, { timeoutMs = LINK_TIMEOUT_MS } = {}) => {
      if (state.status !== "connected") throw Object.assign(new Error("Black 4 is reconnecting. Try again once connected."), { code: "offline" });
      const attempt = generation;
      const result = await request("tools/call", { name, arguments: args }, { timeoutMs });
      // A queue the person just read is the freshest count the badge can show.
      if (name === "review_queue" && attempt === generation && state.status === "connected" && !result?.isError) {
        try { const value = readAnswer(result); noteQueue(value?.data && !value.kind ? value.data : value); } catch {}
      }
      return result;
    },
    queue: { subscribe: (listener) => { queueListeners.add(listener); return () => queueListeners.delete(listener); }, refresh: () => { clearTimeout(queueTimer); void pollQueue(); } },
    SignInPrompt,
    browser: ctx.browser?.available ? ctx.browser.View : null,
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
    const waiting = (code, onCancel) => {
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
    if (current.status === "signing-in") return current.signIn ? waiting(current.signIn, cancelSignIn) : busy("Signing in…", cancelSignIn);
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

  // The Settings card, as Buzz's own (GitHub, Claude): a title and subtitle,
  // then sections of cards.
  function Black4Settings() {
    const current = useBridgeState();
    const out = ["signed-out", "signing-in", "idle"].includes(current.status);
    const connected = current.status === "connected";
    return h("section", { "aria-labelledby": "b4-settings-title" },
      h(ui.Header, { id: "b4-settings-title", title: "Black 4", subtitle: "Gives every agent in Buzz the Black 4 tools, as you." }),
      h(ui.Stack, { gap: "section" },
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
  { id: "goose", label: "Goose" },
];
const ANSWERS = [
  { id: "anyone", label: "Everyone in the community" },
  { id: "owner-only", label: "Only me" },
];

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
  machine: DEFAULT_MACHINE, harness: "claude", pays: "", model: "", effort: "", respondTo: "anyone", instructions: "", heartbeatPrompt: "",
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
    link: ["M9 15l6 -6", "M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464", "M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463"] };
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
  const TextField = ({ label, description, error, optional = false, value, onChange, rows = 8, maxLength, placeholder, disabled }) => {
    const id = React.useId();
    return h("div", { "data-buzz-ui": "", className: "buzz-field" },
      h("label", { className: "buzz-field-label", htmlFor: id }, label,
        optional ? h(Fragment, null, " ", h("span", { className: "buzz-field-optional" }, "Optional")) : null),
      h("textarea", { id, rows, maxLength, placeholder, value, disabled,
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
    h(as, { className: GAPS[one(VARIANTS.Stack.gap, gap)], onSubmit }, ...each(children));
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
   * IconButton) first, the title, then `actions`. */
  const PanelHeader = ({ title, navigation, actions }) =>
    h("header", { "data-buzz-ui": "", className: "panel-header", "data-variant": "default" },
      navigation ?? null,
      h("div", { className: "panel-header-title" }, h("h2", { className: "text-label text-primary" }, title)),
      actions ? h("div", { className: "panel-header-actions" }, ...each(actions)) : null);

  /** A dock page's surface (Panel.tsx, laid out as Shared notes' page):
   * `header` (a PanelHeader) above a scrolling body. `fill`: the body has no
   * inset (an embedded browser fills it). */
  const Page = ({ label, header, fill = false, children }) =>
    h("section", { className: "panel", "data-buzz-surface": "", "data-shape": "panel", "aria-label": label },
      h("div", { "data-buzz-ui": "", style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, containerType: "inline-size" } },
        header ?? null,
        h("div", { style: fill ? { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }
            : { overflow: "auto", padding: "var(--space-4)", display: "flex", flexDirection: "column", gap: "var(--space-4)", minHeight: 0, flex: 1 } },
          ...each(children))));

  /** A drill-in inside a panel (PanelSubview): its bar stays put while the body scrolls. */
  const Subview = ({ header, children }) =>
    h("div", { "data-buzz-ui": "", style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } }, header, ...each(children));
  /** A side panel's body: Buzz leaves the inset to the panel (as GitHub's). */
  const PanelBody = ({ children }) =>
    h("div", { "data-buzz-ui": "", style: { padding: "var(--space-panel-inset)", overflowY: "auto", minHeight: 0, flex: 1, display: "flex", flexDirection: "column", gap: "var(--space-4)", color: "var(--text-standard)" } },
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
  const Tabs = ({ label, value, items, onChange }) => {
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
    return h("div", { "data-buzz-ui": "", className: "buzz-tabs", "data-variant": "panel", "data-size": "sm", "data-orientation": "horizontal" },
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
    Header, IconButton, PanelHeader, Page, Subview, PanelBody, Fill, Toolbar, EmptyState, NavItem, Tabs, Disclosure, CountBadge, Dot, LinkChip, OneTimeCode, CodeColumn, Failure, Notice,
    Title, Heading, Paragraph, Caption, Strong, Lines, Line, Pre, ICON };
}
// ---- end buzz-ui kit ----
export { buzzUi };

// ---- reviews: stamped from src/reviews/ by `npm run build`; edit it there ----
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

/** Everything waiting, in queue order, one entry per item: what next and
 * previous step through. Approved work that is blocked or stalled is not here. */
function reviewOrder(queue) {
  const out = [];
  for (const review of queue?.reviews ?? []) {
    for (const item of review.items ?? []) {
      out.push({ id: reviewItemId(review.businessId, review.assetId, item.key), businessId: review.businessId, businessName: review.businessName,
        assetId: review.assetId, reviewTitle: review.title, key: item.key, version: item.version, title: item.title, question: item.question,
        stake: item.stake, age: item.age, brief: item.brief, workType: item.workType, origin: item.origin ?? review.origin });
    }
  }
  return out;
}

/** The queue grouped by business, in the order businesses first appear. */
function reviewGroups(queue) {
  const groups = new Map();
  for (const entry of reviewOrder(queue)) {
    if (!groups.has(entry.businessId)) groups.set(entry.businessId, { businessId: entry.businessId, businessName: entry.businessName, items: [] });
    groups.get(entry.businessId).items.push(entry);
  }
  return [...groups.values()];
}

/** Where a review came from, when the server says: a Buzz thread, a job. */
function reviewOrigin(review, item) {
  const raw = item?.origin ?? review?.origin ?? {};
  const thread = raw.thread ?? {};
  const job = raw.job ?? {};
  const text = (value) => (typeof value === "string" && value.trim() ? plain(value, 200) : undefined);
  const out = {
    threadId: text(raw.threadId ?? thread.id ?? item?.threadId ?? review?.threadId),
    channelId: text(raw.channelId ?? thread.channelId ?? item?.channelId ?? review?.channelId),
    jobId: text(raw.jobId ?? job.id ?? item?.jobId ?? review?.jobId),
    jobTitle: text(raw.jobTitle ?? job.title ?? item?.jobTitle ?? review?.jobTitle),
  };
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value));
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
  const reviews = new Map(); // asset key -> { data, readAt }
  const flights = new Map(); // asset key -> a read in flight
  const businesses = new Map(); // assetId -> businessId (locators only)
  const receipts = new Map(); // item id -> receipt
  const timers = new Map(); // item id -> undo timer
  const images = new Map(); // `${id}/${which}` -> Promise<data URL | null>
  const listeners = new Set();
  let queue = null;
  let queueFlight = null;
  let serverNeedsBusiness = false;
  let revision = 0;
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
      const { data } = answer(await call("review_queue", {}));
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
  const canDecide = (review, item) => !!review && !!item && review.decideIn === "card" && item.decidable === true
    && tokens.has(reviewItemId(review.businessId, review.assetId, item.key));

  /** An image of the item's work as a data URL, read through get_review_file
   * (the MCP origin only): `which` is "after" (the preview) or "before". */
  const image = (businessId, assetId, key, which = "after") => {
    const id = reviewItemId(businessId, assetId, key);
    const cacheKey = `${id}/${which}`;
    if (images.has(cacheKey)) return images.get(cacheKey);
    const link = previews.get(id)?.[which];
    const read = (async () => {
      if (!link?.url || !/^image\//.test(String(link.contentType ?? ""))) return null;
      // The link names the file; only its path is used, never the link itself.
      const match = String(link.url).match(/^https:\/\/[^/]+\/v\/[^/]+\/(.+)$/);
      if (!match) return null;
      const path = match[1].split("/").map((part) => { try { return decodeURIComponent(part); } catch { return part; } }).join("/");
      const item = cachedReview(businessId, assetId)?.items?.find((entry) => entry.key === key);
      const result = await call("get_review_file", { businessId, assetId, path, ...(item?.version ? { version: item.version } : {}) });
      if (result?.isError) return null;
      const part = (result?.content ?? []).find((entry) => entry?.type === "image" && typeof entry.data === "string");
      if (!part || !/^image\/(png|jpeg|gif|webp|avif)$/.test(String(part.mimeType))) return null;
      return `data:${part.mimeType};base64,${part.data}`;
    })().catch(() => null);
    if (images.size >= 60) images.delete(images.keys().next().value);
    images.set(cacheKey, read);
    return read;
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
    setReceipt(id, { ...receipt, state: "sending", message: "" });
    let token = tokens.get(id);
    try {
      if (!token || token.expiresAt - now() < REVIEW_TOKEN_RENEW_MS) {
        await open({ assetId: receipt.assetId, businessId: receipt.businessId }, { fresh: true });
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
      try {
        result = await Promise.race([call("decide_review_item", {
          businessId: receipt.businessId, assetId: receipt.assetId, version: receipt.version, itemKey: receipt.key,
          verdict: receipt.verdict, decisionToken: token.token, ...(receipt.feedback ? { feedback: receipt.feedback } : {}),
        }, { timeoutMs }), late]);
      } finally { clearTimer(timer); }
    } catch (error) {
      if (disposed) return;
      // It may or may not have arrived: read before claiming anything.
      if (["timeout", "offline", "http"].includes(error?.code) || !error?.code) {
        setReceipt(id, { ...receipt, state: "unknown", message: "Checking whether it saved…" });
        return settle(id, { state: "unknown", message: "Couldn't confirm it saved." });
      }
      setReceipt(id, { ...receipt, state: "failed", message: plain(error?.message ?? error, 200) });
      return;
    }
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
    timers.set(id, setTimer(() => { timers.delete(id); void send(id); }, undoMs));
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
    void send(id);
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
    noteQueue, readQueue, open, cachedReview, canDecide, image,
    receipt: (id) => receipts.get(id) ?? null,
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

// stub

function reviewsPart() {}
function reviewsSlot() { return { dispose() {} }; }
// ---- end reviews ----
export { reviewLocator, reviewLink, reviewOrder, reviewGroups, reviewState, reviewData, wordDiff, reviewsPart, reviewsSlot, REVIEW_UNDO_MS };

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
export function applyHardware(ctx, { report = () => {}, access, sign } = {}) {
  const React = ctx.react;
  const h = React.createElement;
  const ask = sign && typeof ctx.host?.request === "function"
    ? doorTransport({ request: (input) => ctx.host.request(input), sign })
    : undefined;
  const statuses = statusReader(ask);
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
    Page, PanelHeader, IconButton, EmptyState, Failure } = buzzUi(React, { nativeSelect: NATIVE_SELECT });
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
        h(Row, { title: "Answers", trailing: h(Pill, { label: "Answers", value: value.respondTo, options: ANSWERS, disabled, onChange: (respondTo) => onChange({ ...value, respondTo }) }) }),
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
          directory.remember(pubkey, { machine: machine.id, harness: reply.harness, respondTo: reply.respondTo });
          const pays = reply.pays === "key" ? "key" : "subscription";
          setRun({ loading: false, running: !!reply.running, activated: !!reply.activated, harness: reply.harness, respondTo: reply.respondTo, pays,
            createdBy: typeof reply.createdBy === "string" ? reply.createdBy : null, yours: reply.yours !== false,
            controls: reply.controls && typeof reply.controls === "object" ? reply.controls : null,
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
          h(Row, { title: "Answers", trailing: respondTo
            ? h(Pill, { label: "Answers", shape, value: respondTo, options: ANSWERS, disabled: busy, onChange: (next) => void pick({ controls: { respondTo: next } }, "machine") })
            : Value(run.loading ? "…" : "Unknown") })),
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

  /** Every Black 4 hardware agent on every machine, for every staff member:
   * Buzz lists only the agents this Buzz made, so this dock page shows them
   * all and opens the same Settings for any of them. */
  const AllAgents = () => {
    const { signedOut, reachable, epoch } = useBlack4();
    const [rows, setRows] = React.useState({ loading: true, machines: [] });
    const [open, setOpen] = React.useState(null);
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
            for (const row of agents) directory.remember(row.pubkey, { machine: machine.id, harness: row.harness, respondTo: row.respondTo });
            return { machine, agents };
          }, (error) => ({ machine, agents: [], error: String(error?.message ?? error) }))))
        .then((machines) => { if (live) setRows({ loading: false, machines }); });
      return () => { live = false; };
    }, [reachable, epoch, revision]);

    const page = (header, ...body) => h(Page, { label: "Black 4 agents", header }, ...body);
    if (signedOut && SignInPrompt) return page(h(PanelHeader, { title: "Black 4 agents" }), h(SignInPrompt, null));
    if (open) return page(
      h(PanelHeader, { title: open.name || open.pubkey.slice(0, 8),
        navigation: h(IconButton, { label: "All agents", glyph: "back", large: true, onClick: () => { setOpen(null); refresh(); } }) }),
      h(GuardedSettings, { key: open.pubkey, agent: { pubkey: open.pubkey } }));
    const header = h(PanelHeader, { title: "Black 4 agents",
      actions: h(IconButton, { label: "Refresh", glyph: "refresh", large: true, disabled: rows.loading, onClick: refresh }) });
    if (rows.loading && !rows.machines.length) return page(header, Status("Loading agents…"));
    return page(header, ...rows.machines.map(({ machine, agents, error }) => h(Stack, { key: machine.id, gap: 2 },
      h(SectionTitle, { title: machine.label }),
      error ? h(Failure, { message: error, retry: refresh })
        : agents.length ? h(Group, null, ...agents.map((row) =>
          h(Row, { key: row.pubkey, title: row.name || row.pubkey.slice(0, 8),
            description: [harnessLabel(row.harness) ?? row.harness, row.createdBy ? `Made by ${row.createdBy}` : null].filter(Boolean).join(" · "),
            trailing: h(React.Fragment, null,
              Value(row.running ? "Running" : row.activated ? "Stopped" : "Not set up"),
              h(Button, { size: "sm", onClick: () => setOpen(row) }, "Open")) })))
        : h(EmptyState, { title: "No agents yet", description: "Agents made on this machine show here." }))));
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
  ctx.pages?.register?.({ id: "black4-agents", title: "Black 4 agents", primary: true, placement: "dock", layout: "workspace", component: guarded(AllAgents, "agents") });
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
          inject: ["react", "host", "agents", "pages"],
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
