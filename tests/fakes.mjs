// In-process stand-ins for what the Black 4 plugin reaches through
// ctx.host.request: WorkOS AuthKit (device sign-in and refresh), the Black 4
// MCP and a machine's hardware door. `https(...)` routes a host.request to
// them by origin, the way Buzz would after checking the manifest's origins.
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

export const AUTHKIT = "https://overjoyed-tea-41.authkit.app";
export const MCP = "https://api.black4.ai";
export const DOOR = "https://black4-commerce-01.tail50b7f0.ts.net";

const source = await readFile(process.env.BLACK4_TEST_PLUGIN ?? new URL("../plugins/black4/plugin.js", import.meta.url), "utf8");
let imports = 0;
/** A fresh copy of the plugin module, so module-level memory (the run's
 * sign-in) never leaks from one test to the next. */
export const freshPlugin = () => import(`data:text/javascript;base64,${Buffer.from(`${source}\n// copy ${++imports}\n`).toString("base64")}`);

export const tick = () => new Promise((resolve) => setImmediate(resolve));
export async function settle(n = 24) { for (let i = 0; i < n; i++) await tick(); }

const json = (status, body, headers = {}) => ({ status, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const parseForm = (body) => Object.fromEntries(new URLSearchParams(body ?? ""));
export const sha256url = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("base64url");

/** AuthKit. `polls` scripts the device-grant answers in order: an OAuth error
 * name ("authorization_pending", "slow_down", "expired_token",
 * "access_denied") or "ok"; the last entry repeats. */
export function fakeAuthKit({ polls = ["ok"], expiresIn = 3600, interval = 0.001, rotate = true } = {}) {
  const self = {
    calls: [], // { path, form }
    access: new Map(), // token -> { expiresAt }
    refresh: new Set(), // live refresh tokens
    userCode: "WDJB-MJHT",
    deviceCode: "device-code-1",
    now: () => Date.now(),
    expiresIn,
    interval,
    polls: [...polls],
  };
  let serial = 0;
  const issue = () => {
    const access = `access-${++serial}`;
    const refresh = `refresh-${serial}`;
    self.access.set(access, { expiresAt: self.now() + self.expiresIn * 1000 });
    self.refresh.add(refresh);
    return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: self.expiresIn };
  };
  self.issue = issue;
  self.valid = (token) => (self.access.get(token)?.expiresAt ?? 0) > self.now();
  self.handle = (input) => {
    const path = new URL(input.url).pathname;
    const form = parseForm(input.body);
    self.calls.push({ path, form });
    if (input.method !== "POST" || input.headers?.["content-type"] !== "application/x-www-form-urlencoded") return json(400, { error: "invalid_request" });
    if (path === "/oauth2/device_authorization") {
      return json(200, {
        device_code: self.deviceCode, user_code: self.userCode,
        verification_uri: `${AUTHKIT}/device`, verification_uri_complete: `${AUTHKIT}/device?user_code=${self.userCode}`,
        expires_in: 600, interval: self.interval,
      });
    }
    if (path === "/oauth2/token" && form.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
      if (form.device_code !== self.deviceCode) return json(400, { error: "invalid_grant" });
      const next = self.polls.length > 1 ? self.polls.shift() : self.polls[0];
      return next === "ok" ? json(200, issue()) : json(400, { error: next, error_description: `fake ${next}` });
    }
    if (path === "/oauth2/token" && form.grant_type === "refresh_token") {
      if (!self.refresh.has(form.refresh_token)) return json(400, { error: "invalid_grant", error_description: "Refresh token is invalid." });
      if (rotate) self.refresh.delete(form.refresh_token);
      const tokens = issue();
      if (!rotate) { self.refresh.delete(tokens.refresh_token); delete tokens.refresh_token; }
      return json(200, tokens);
    }
    return json(404, { error: "not_found" });
  };
  return self;
}

/** The Black 4 MCP. `answer(message)` returns `{ result }` or `{ error }` for
 * every request after initialize; `sse` answers as an event stream.
 * `sign_hardware_request` (reached directly or through call_tool) mints
 * passes the door below accepts. */
export function fakeMcp(authkit, { answer = () => ({ result: {} }), sse = false, instructions = "People decide." } = {}) {
  // `ownerKeys`: when set, a sign_hardware_request ownerKey outside it is refused (owner_key_not_linked).
  // Platform Control's limits on a stored sign-in, in its real wire shapes
  // (black4-mcp-stored-signins.ts, black4-mcp-tool.ts `failure`/`result`):
  // `approvalRequired`: sign_hardware_request (directly or via call_tool) is
  //   refused with the tool error signin_approval_required;
  // `idle`: every message but initialize, ping, tools/list, notifications and
  //   a direct tools/call renew_signin gets HTTP 403 {"error":"signin_idle"};
  // `renew`: renew_signin. `supported: false` is today's server (unknown
  //   tool); `start` is what {} answers ("pending" or an error code); `polls`
  //   is what {approvalId} answers in order, the last repeating: a state
  //   ("pending", "approved", "denied", "expired") or an error code. An
  //   approval clears `idle` and `approvalRequired`.
  const self = {
    calls: [], passes: new Map(), sessions: new Set(), signed: [], tokens: [], ownerKeys: null,
    approvalRequired: false, idle: false,
    renew: { supported: true, start: "pending", polls: ["pending", "approved"], interval: 0.02, calls: [] },
  };
  const toolFailure = (id, headers, code, message) =>
    json(200, { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }] } }, headers);
  const toolResult = (data) => ({ result: { structuredContent: { data }, content: [{ type: "text", text: JSON.stringify(data) }] } });
  const RENEW_STATES = new Set(["pending", "approved", "denied", "expired"]);
  self.handle = async (input) => {
    const url = new URL(input.url);
    if (url.pathname !== "/mcp" || input.method !== "POST") return json(404, { error: "not found" });
    const token = /^Bearer (.+)$/.exec(input.headers?.authorization ?? "")?.[1];
    self.tokens.push(token);
    if (!authkit.valid(token)) return json(401, { error: "invalid_token", error_description: "The access token expired." });
    const message = JSON.parse(input.body);
    self.calls.push(message);
    const renewing = message.method === "tools/call" && message.params?.name === "renew_signin";
    if (self.idle && !(["initialize", "ping", "tools/list"].includes(message.method) || String(message.method).startsWith("notifications/") || renewing)) {
      return json(403, { error: "signin_idle", message: "This Black 4 sign-in has not been used for 14 days. Approve it again in a browser with renew_signin to keep using it." });
    }
    let headers = {};
    if (message.method === "initialize") {
      const id = randomUUID();
      self.sessions.add(id);
      headers = { "mcp-session-id": id };
    } else if (!self.sessions.has(input.headers?.["mcp-session-id"])) {
      return json(404, { error: "session not found" });
    }
    if (message.id == null) return { status: 202, headers: {}, body: "" };
    let reply;
    if (message.method === "initialize") reply = { result: { protocolVersion: "2025-06-18", instructions, capabilities: {} } };
    else {
      let { name, arguments: args } = message.params ?? {};
      if (message.method === "tools/call" && name === "call_tool" && args?.name === "sign_hardware_request") ({ name, arguments: args } = args);
      if (message.method === "tools/call" && name === "renew_signin" && self.renew) { // null: the test's own answer handles it
        const renew = self.renew;
        renew.calls.push(args ?? {});
        if (!renew.supported) return json(200, { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "MCP error -32602: Tool renew_signin not found" } }, headers);
        const answerWith = (step, approvalId) => {
          // not_needed: not a stored sign-in, so no limit applies to it either.
          if (step === "signin_approval_not_needed") { self.idle = false; self.approvalRequired = false; }
          if (!RENEW_STATES.has(step)) return toolFailure(message.id, headers, step, `fake ${step}`);
          if (step === "approved") { self.idle = false; self.approvalRequired = false; return null; }
          return null;
        };
        if (!args?.approvalId) {
          const failed = answerWith(renew.start);
          if (failed) return failed;
          renew.id = `ssa_${"a".repeat(21)}${renew.calls.length}`.slice(0, 26);
          reply = toolResult({ state: "pending", approvalId: renew.id, userCode: "RNEW-CODE", verificationUri: `${AUTHKIT}/device`, verificationUriComplete: `${AUTHKIT}/device?user_code=RNEW-CODE`, expiresAt: new Date(Date.now() + 600_000).toISOString(), interval: renew.interval });
        } else {
          const step = renew.polls.length > 1 ? renew.polls.shift() : renew.polls[0];
          const failed = answerWith(step);
          if (failed) return failed;
          reply = toolResult({ state: step, approvalId: args.approvalId, ...(step === "pending" ? { interval: renew.interval } : {}), ...(step === "approved" ? { approvedAt: new Date().toISOString() } : {}) });
        }
      } else if (message.method === "tools/call" && name === "sign_hardware_request") {
        if (self.approvalRequired) {
          return toolFailure(message.id, headers, "signin_approval_required", "This needs a browser approval of this sign-in within the last 24 hours. Approve it with renew_signin, then try again.");
        }
        if (self.ownerKeys && args?.ownerKey !== undefined && !self.ownerKeys.includes(args.ownerKey)) {
          const error = { code: "owner_key_not_linked", message: "That owner key is not one of your live links." };
          return json(200, { jsonrpc: "2.0", id: message.id, result: { isError: true, structuredContent: { error }, content: [{ type: "text", text: JSON.stringify({ error }) }] } }, headers);
        }
        const pass = `pass-${randomUUID()}`;
        self.passes.set(pass, { ...args, expiresAt: Date.now() + 60_000, used: false });
        self.signed.push(args);
        const data = { pass, expiresAt: new Date(Date.now() + 60_000).toISOString() };
        reply = { result: { structuredContent: { data }, content: [{ type: "text", text: JSON.stringify(data) }] } };
      } else reply = (await answer(message)) ?? { result: {} };
    }
    const body = { jsonrpc: "2.0", id: message.id, ...reply };
    if (sse) return { status: 200, headers: { "content-type": "text/event-stream", ...headers }, body: `event: message\ndata: ${JSON.stringify(body)}\n\n` };
    return json(200, body, headers);
  };
  return self;
}

/** A machine's door: accepts one fresh, unused pass per request whose
 * machine, op and body hash match, then answers with `agentctl(request)`. */
export function fakeDoor(mcp, agentctl = () => ({ ok: true })) {
  const self = { seen: [], refused: [] };
  self.handle = async (input) => {
    const url = new URL(input.url);
    if (url.pathname === "/health" && input.method === "GET") return json(200, { ok: true, machine: "commerce" });
    if (url.pathname !== "/agentctl" || input.method !== "POST") return json(404, { error: "not found" });
    const pass = /^Black4-Hardware (.+)$/.exec(input.headers?.authorization ?? "")?.[1];
    const grant = pass && mcp.passes.get(pass);
    const refuse = (error) => { self.refused.push(error); return json(401, { error }); };
    if (!grant) return refuse("no such pass");
    if (grant.used) return refuse("pass already used");
    if (grant.expiresAt < Date.now()) return refuse("pass expired");
    grant.used = true;
    if (grant.bodySha256 !== sha256url(input.body)) return refuse("pass does not match this request");
    const request = JSON.parse(input.body);
    if (grant.machine !== "commerce" || grant.op !== request.op) return refuse("pass is for another request");
    self.seen.push(request);
    return json(200, await agentctl(request));
  };
  return self;
}

/** ctx.host.request over the fakes. `offline` lists origins that fail to connect. */
export function https({ authkit, mcp, door, offline = new Set() }) {
  const requests = [];
  const request = async (input) => {
    const origin = new URL(input.url).origin;
    requests.push({ origin, path: new URL(input.url).pathname, headers: input.headers ?? {} });
    if (offline.has(origin)) throw new Error("error sending request: connection refused");
    if (origin === AUTHKIT && authkit) return authkit.handle(input);
    if (origin === MCP && mcp) return mcp.handle(input);
    if (origin === DOOR && door) return door.handle(input);
    throw new Error(`Origin not declared: ${origin}`);
  };
  return { request, requests, offline };
}

/** Waits, on real timers, until `ready()` is true (the device sign-in polls on
 * a timer, so ticks alone are not enough). */
export async function until(ready, { timeoutMs = 2000, what = "the condition" } = {}) {
  const end = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await settle(4);
  }
}
