// The Black 4 sign-in (WorkOS AuthKit device flow, RFC 8628) and token
// refresh, against a fake AuthKit and MCP behind host.request. No network.
import assert from "node:assert/strict";
import test from "node:test";
import { fakeAuthKit, fakeMcp, https, freshPlugin, settle, until, AUTHKIT } from "./fakes.mjs";

const { createSession, createMcp, memoryStore, AUTHKIT: CLIENT } = await freshPlugin();

/** A session over a fake AuthKit with an instant, recorded sleep. */
function setup(options = {}) {
  const authkit = fakeAuthKit(options);
  const net = https({ authkit, mcp: fakeMcp(authkit) });
  const store = options.store ?? memoryStore();
  const slept = [];
  let clock = 1_000_000;
  authkit.now = () => clock;
  const session = createSession({ request: net.request, store, now: () => clock, sleep: async (ms) => { slept.push(ms); } });
  return { authkit, net, store, slept, session, advance: (ms) => { clock += ms; } };
}
const tokenText = /access-\d|refresh-\d|device-code/;

test("device sign-in asks AuthKit as the Black 4 client, shows the prefilled link and code, and polls until approved", async () => {
  const { authkit, session, slept } = setup({ polls: ["authorization_pending", "authorization_pending", "ok"], interval: 5 });
  const shown = [];
  await session.signIn({ onCode: (code) => shown.push(code) });
  assert.equal(session.snapshot().status, "signed-in");
  assert.deepEqual(shown.map(({ url, userCode }) => ({ url, userCode })), [{ url: `${AUTHKIT}/device?user_code=WDJB-MJHT`, userCode: "WDJB-MJHT" }]);
  const start = authkit.calls[0];
  assert.equal(start.path, "/oauth2/device_authorization");
  assert.deepEqual(start.form, { client_id: CLIENT.clientId, scope: CLIENT.scope, ...CLIENT.params });
  const polls = authkit.calls.filter((call) => call.form.grant_type === "urn:ietf:params:oauth:grant-type:device_code");
  assert.equal(polls.length, 3);
  assert.ok(polls.every((call) => call.form.client_id === CLIENT.clientId && call.form.device_code === "device-code-1" && call.form.resource === "https://api.black4.ai/mcp"));
  assert.equal(CLIENT.clientId, "client_01M7G889K5GQTA4Q38Q6PPJQSN");
  assert.deepEqual(slept, [5000, 5000, 5000], "waits the server's interval before each poll");
  assert.match(await session.accessToken(), /^access-/);
  assert.doesNotMatch(JSON.stringify(session.snapshot()), tokenText, "the state never holds a token");
});

test("slow_down adds five seconds to every later poll", async () => {
  const { session, slept } = setup({ polls: ["slow_down", "authorization_pending", "slow_down", "ok"], interval: 5 });
  await session.signIn();
  assert.deepEqual(slept, [5000, 10000, 10000, 15000]);
});

test("an expired code and a declined sign-in end plainly, signed out", async () => {
  for (const [poll, sentence] of [["expired_token", /The sign-in code expired\. Sign in again\.$/], ["access_denied", /Sign-in was declined\.$/]]) {
    const { session } = setup({ polls: ["authorization_pending", poll] });
    await assert.rejects(session.signIn(), sentence);
    assert.equal(session.snapshot().status, "signed-out");
    assert.match(session.snapshot().detail, sentence);
    await assert.rejects(session.accessToken(), /Sign in to Black 4 first/);
  }
});

test("the code's own lifetime ends polling even while AuthKit still says pending", async () => {
  const { session, advance } = setup({ polls: ["authorization_pending"] });
  const pending = session.signIn({ onCode: () => advance(601_000) });
  await assert.rejects(pending, /expired/);
});

test("Cancel stops polling and leaves nothing signed in", async () => {
  const authkit = fakeAuthKit({ polls: ["authorization_pending"] });
  const net = https({ authkit });
  let wake;
  const session = createSession({ request: net.request, store: memoryStore(), sleep: () => new Promise((resolve) => { wake = resolve; }) });
  const flow = session.signIn();
  await settle();
  assert.equal(session.snapshot().status, "waiting");
  session.cancel();
  wake();
  await assert.rejects(flow, /Cancelled/);
  assert.equal(session.snapshot().status, "signed-out");
  assert.equal(session.snapshot().detail, undefined, "a cancel is not an error");
});

test("a link off the sign-in origin is never shown", async () => {
  const { authkit, session } = setup();
  const handle = authkit.handle;
  authkit.handle = (input) => {
    const reply = handle(input);
    if (input.url.endsWith("/oauth2/device_authorization")) {
      reply.body = JSON.stringify({ ...JSON.parse(reply.body), verification_uri_complete: "https://evil.example/device", verification_uri: "https://overjoyed-tea-41.authkit.app.evil.example/device" });
    }
    return reply;
  };
  await assert.rejects(session.signIn(), /returned no link to open/);
});

test("an access token near its end is refreshed first, once for concurrent callers, and the rotated refresh token is saved", async () => {
  const { authkit, session, store, advance } = setup({ expiresIn: 600 });
  await session.signIn();
  const first = await session.accessToken();
  assert.equal(await session.accessToken(), first, "still good: no refresh");
  advance(500_000); // within two minutes of the end
  const [a, b] = await Promise.all([session.accessToken(), session.accessToken()]);
  assert.equal(a, b);
  assert.notEqual(a, first);
  assert.equal(authkit.calls.filter((call) => call.form.grant_type === "refresh_token").length, 1, "one refresh for both");
  assert.equal(authkit.calls.find((call) => call.form.grant_type === "refresh_token").form.resource, "https://api.black4.ai/mcp");
  assert.equal(await store.load(), "refresh-2", "the rotated token replaced the old one");
  assert.ok(!authkit.refresh.has("refresh-1"), "the old one is spent");
});

test("a refused refresh reads the store again (another window rotated it) before signing out", async () => {
  const shared = memoryStore();
  const one = setup({ store: shared, expiresIn: 600 });
  await one.session.signIn();
  // Another window (same AuthKit) refreshes and saves a new token in the shared store.
  const other = createSession({ request: one.net.request, store: shared, now: one.authkit.now });
  await other.restore();
  one.advance(500_000);
  assert.match(await one.session.accessToken(), /^access-/, "used the token the other window saved");
  // Now every token is revoked: the session ends plainly.
  one.authkit.refresh.clear();
  one.advance(1_000_000);
  await assert.rejects(one.session.accessToken(), /^Error: Your Black 4 sign-in ended\. Sign in again\.$/);
  assert.equal(one.session.snapshot().status, "signed-out");
  assert.equal(await shared.load(), null, "the dead token is cleared");
});

test("a sign-in is restored from this Buzz run's memory, and a dead one is not", async () => {
  const { authkit, session, store } = setup();
  assert.equal(await session.restore(), false, "nothing saved");
  await store.save(authkit.issue().refresh_token);
  assert.equal(await session.restore(), true);
  assert.equal(session.snapshot().status, "signed-in");
  const stale = setup();
  await stale.store.save("refresh-gone");
  assert.equal(await stale.session.restore(), false);
});

test("an MCP 401 refreshes the sign-in and asks once more; a second 401 is a sign-in error", async () => {
  const authkit = fakeAuthKit();
  const mcp = fakeMcp(authkit, { answer: () => ({ result: { tools: [] } }) });
  const net = https({ authkit, mcp });
  const store = memoryStore();
  await store.save(authkit.issue().refresh_token);
  const session = createSession({ request: net.request, store });
  await session.restore();
  const client = createMcp({ request: net.request, session });
  await client.initialize();
  authkit.access.clear(); // the server revoked every access token early
  assert.deepEqual(await client.request("tools/list", {}), { tools: [] });
  assert.equal(authkit.calls.filter((call) => call.form.grant_type === "refresh_token").length, 2, "restore, then the forced refresh");
  mcp.handle = async () => ({ status: 401, headers: {}, body: JSON.stringify({ error: "invalid_token", error_description: "Not for this resource." }) });
  await assert.rejects(client.request("tools/list", {}), (error) => error.code === "signin" && /Black 4 refused your sign-in: Not for this resource\./.test(error.message));
});

test("the MCP's event-stream answer is read", async () => {
  const authkit = fakeAuthKit();
  const mcp = fakeMcp(authkit, { sse: true, answer: () => ({ result: { tools: [{ name: "whoami" }] } }) });
  const net = https({ authkit, mcp });
  const store = memoryStore();
  await store.save(authkit.issue().refresh_token);
  const session = createSession({ request: net.request, store });
  await session.restore();
  const client = createMcp({ request: net.request, session });
  assert.equal((await client.initialize()).instructions, "People decide.");
  assert.deepEqual(await client.request("tools/list", {}), { tools: [{ name: "whoami" }] });
});

// ---- Settings → Black 4 ----

test("Settings → Black 4: Sign in shows the prefilled link and code, then Connected with email and staff", async (t) => {
  const { apply } = await freshPlugin();
  const authkit = fakeAuthKit({ polls: ["authorization_pending", "authorization_pending", "authorization_pending", "ok"], interval: 0.02 });
  const mcp = fakeMcp(authkit, {
    answer: (message) => message.method === "tools/list" ? { result: { tools: [{ name: "whoami", inputSchema: { type: "object" } }] } }
      : message.params?.name === "whoami" ? { result: { content: [{ type: "text", text: JSON.stringify({ data: { kind: "staff", email: "person@example.test" } }) }] } }
      : { result: { content: [{ type: "text", text: "{}" }] } },
  });
  const net = https({ authkit, mcp });
  let card;
  const cleanups = [];
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children });
  apply({
    react: { createElement: h, useState: (v) => [typeof v === "function" ? v() : v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }), Component: class {} },
    agents: { snapshot: () => ({ running: [] }), addTool: () => () => {}, register: () => {} },
    settingsCards: { register: (value) => { card = value; } },
    pages: { register() {} }, panels: { register() {} }, conversation: {}, browser: { available: false },
    effect: (fn) => { const off = fn(); if (off) cleanups.push(off); },
    host: { request: net.request },
  });
  t.after(() => { for (const off of cleanups.reverse()) off(); });
  const expand = (node) => (!node || typeof node !== "object" ? node
    : typeof node.type === "function" ? expand(node.type(node.props)) : { ...node, children: (node.children ?? []).map(expand) });
  const texts = (node) => (node == null || node === false ? [] : typeof node !== "object" ? [String(node)] : (node.children ?? []).flatMap(texts));
  const find = (node, test) => {
    if (!node || typeof node !== "object") return null;
    if (test(node)) return node;
    for (const child of node.children ?? []) { const found = find(child, test); if (found) return found; }
    return null;
  };
  const view = () => expand(card.component());
  await settle();
  assert.match(texts(view()).join(" "), /Status Not signed in/);
  find(view(), (node) => node.type === "button" && texts(node).join("") === "Sign in").props.onClick();
  await until(() => find(view(), (node) => node.type === "a"), { what: "the sign-in link" });
  const link = find(view(), (node) => node.type === "a");
  assert.equal(link.props.href, `${AUTHKIT}/device?user_code=WDJB-MJHT`);
  assert.equal(link.props.target, "_blank");
  assert.match(texts(view()).join(" "), /WDJB-MJHT/);
  assert.equal(find(view(), (node) => node.type === "form"), null, "never a form");
  await until(() => /Status Connected/.test(texts(view()).join(" ")), { what: "Connected" });
  assert.match(texts(view()).join(" "), /Signed in as person@example\.test \(staff\)/);
  assert.doesNotMatch(JSON.stringify(view()), tokenText, "no token anywhere in the card");
  find(view(), (node) => node.type === "button" && texts(node).join("") === "Sign out").props.onClick();
  await settle();
  assert.match(texts(view()).join(" "), /Status Not signed in/);
});

test("an MCP that keeps forgetting its session is reopened once per call, then reported", async () => {
  const authkit = fakeAuthKit();
  const mcp = fakeMcp(authkit, { answer: () => ({ result: {} }) });
  const net = https({ authkit, mcp });
  const store = memoryStore();
  await store.save(authkit.issue().refresh_token);
  const session = createSession({ request: net.request, store });
  await session.restore();
  const client = createMcp({ request: net.request, session });
  await client.initialize();
  const handle = mcp.handle;
  mcp.handle = async (input) => (JSON.parse(input.body).method === "initialize" ? handle(input) : { status: 404, headers: {}, body: "session not found" });
  await assert.rejects(client.request("tools/list", {}), /Black 4 answered HTTP 404/);
  assert.equal(mcp.calls.filter((call) => call.method === "initialize").length, 2, "one reopen, not a loop");
});

test("Cancel, then Sign in again: the cancelled attempt ending later leaves the new link and code in place", async (t) => {
  const { apply } = await freshPlugin();
  const authkit = fakeAuthKit({ polls: ["authorization_pending"], interval: 0.15 });
  const net = https({ authkit, mcp: fakeMcp(authkit) });
  let card;
  const cleanups = [];
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children });
  apply({
    react: { createElement: h, useState: (v) => [typeof v === "function" ? v() : v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }), Component: class {} },
    agents: { snapshot: () => ({ running: [] }), addTool: () => () => {}, register: () => {} },
    settingsCards: { register: (value) => { card = value; } },
    pages: { register() {} }, panels: { register() {} }, conversation: {}, browser: { available: false },
    effect: (fn) => { const off = fn(); if (off) cleanups.push(off); },
    host: { request: net.request },
  });
  t.after(() => { for (const off of cleanups.reverse()) off(); });
  const expand = (node) => (!node || typeof node !== "object" ? node
    : typeof node.type === "function" ? expand(node.type(node.props)) : { ...node, children: (node.children ?? []).map(expand) });
  const texts = (node) => (node == null || node === false ? [] : typeof node !== "object" ? [String(node)] : (node.children ?? []).flatMap(texts));
  const find = (node, test) => {
    if (!node || typeof node !== "object") return null;
    if (test(node)) return node;
    for (const child of node.children ?? []) { const found = find(child, test); if (found) return found; }
    return null;
  };
  const view = () => expand(card.component());
  const click = (label) => find(view(), (node) => node.type === "button" && texts(node).join("") === label).props.onClick();
  await settle();
  click("Sign in");
  await until(() => find(view(), (node) => node.type === "a"), { what: "the first link" });
  click("Cancel");
  click("Sign in");
  await until(() => find(view(), (node) => node.type === "a"), { what: "the second link" });
  await new Promise((resolve) => setTimeout(resolve, 250)); // the first attempt's poll wakes and ends
  await settle();
  assert.ok(find(view(), (node) => node.type === "a"), "the new link is still shown");
  assert.match(texts(view()).join(" "), /Waiting for you to sign in/);
  click("Cancel");
});
