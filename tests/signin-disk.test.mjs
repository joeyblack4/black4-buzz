// The sign-in kept on this computer: the refresh token alone, in one
// localStorage key, behind createSession's store. Rotation, two windows,
// Sign out, a refused grant, a dropped network and blocked storage, against a
// fake AuthKit and a fake localStorage. No network.
import assert from "node:assert/strict";
import test from "node:test";
import { fakeAuthKit, https, freshPlugin, AUTHKIT } from "./fakes.mjs";

const { createSession, diskStore, SIGNIN_KEY } = await freshPlugin();
const tokenLike = /access-\d|device-code/;
const yieldTurn = () => new Promise((resolve) => setImmediate(resolve)); // a sleep that lets timers run

/** A localStorage stand-in. `fail` lists the methods that throw. */
function fakeStorage({ fail = [] } = {}) {
  const values = new Map();
  const guard = (name) => { if (fail.includes(name)) throw new Error(`SecurityError: ${name}`); };
  return {
    values,
    getItem: (key) => { guard("getItem"); return values.has(key) ? values.get(key) : null; },
    setItem: (key, value) => { guard("setItem"); values.set(key, String(value)); },
    removeItem: (key) => { guard("removeItem"); values.delete(key); },
  };
}
const stored = (storage) => { const raw = storage.values.get(SIGNIN_KEY); return raw == null ? null : JSON.parse(raw).refresh; };

/** A window: a session over the shared storage, with instant sleeps and a clock. */
function windowOn(authkit, storage, { offline } = {}) {
  const net = https({ authkit, offline });
  return createSession({ request: net.request, store: diskStore({ storage: () => storage }), sleep: yieldTurn });
}

test("the key names the plugin and the sign-in server", () => {
  assert.equal(SIGNIN_KEY, `ai.black4.signin.v1:${new URL(AUTHKIT).host}`);
});

test("a sign-in keeps only the refresh token, in one key; the next launch restores it without a browser", async () => {
  const authkit = fakeAuthKit({ polls: ["ok"], interval: 0.001 });
  const storage = fakeStorage();
  const first = windowOn(authkit, storage);
  await first.signIn();
  assert.deepEqual([...storage.values.keys()], [SIGNIN_KEY]);
  const raw = storage.values.get(SIGNIN_KEY);
  assert.deepEqual(Object.keys(JSON.parse(raw)), ["v", "refresh"]);
  assert.match(stored(storage), /^refresh-\d+$/);
  assert.doesNotMatch(raw, tokenLike, "never the access token");
  // Quit and launch: a new session over the same disk.
  const relaunched = windowOn(authkit, storage);
  assert.equal(await relaunched.restore(), true);
  assert.equal(relaunched.snapshot().status, "signed-in");
  assert.equal(authkit.calls.filter((call) => call.path === "/oauth2/device_authorization").length, 1, "no second browser sign-in");
  assert.doesNotMatch(JSON.stringify(relaunched.snapshot()), /refresh-|access-/, "no token in the state");
});

test("rotation: each refresh replaces the kept token, and the used one is gone", async () => {
  const authkit = fakeAuthKit();
  const storage = fakeStorage();
  storage.setItem(SIGNIN_KEY, JSON.stringify({ v: 1, refresh: authkit.issue().refresh_token }));
  const session = windowOn(authkit, storage);
  await session.restore();
  const afterRestore = stored(storage);
  assert.ok(authkit.refresh.has(afterRestore));
  await session.accessToken({ force: true });
  assert.notEqual(stored(storage), afterRestore);
  assert.ok(authkit.refresh.has(stored(storage)), "the kept token is the live one");
  assert.equal(authkit.refresh.has(afterRestore), false);
});

test("Sign out deletes the kept token at once; a new sign-in replaces it from its start", async () => {
  const authkit = fakeAuthKit({ polls: ["authorization_pending"], interval: 0.001 });
  const storage = fakeStorage();
  storage.setItem(SIGNIN_KEY, JSON.stringify({ v: 1, refresh: authkit.issue().refresh_token }));
  const session = windowOn(authkit, storage);
  await session.restore();
  await session.signOut();
  assert.equal(storage.values.has(SIGNIN_KEY), false);
  storage.setItem(SIGNIN_KEY, JSON.stringify({ v: 1, refresh: authkit.issue().refresh_token }));
  const replacing = windowOn(authkit, storage);
  const flow = replacing.signIn();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(storage.values.has(SIGNIN_KEY), false, "the old sign-in is gone while the new one waits");
  replacing.cancel();
  await assert.rejects(flow, /Cancelled/);
});

test("a refused grant (sign-in ended) deletes the kept token", async () => {
  const authkit = fakeAuthKit();
  const storage = fakeStorage();
  storage.setItem(SIGNIN_KEY, JSON.stringify({ v: 1, refresh: authkit.issue().refresh_token }));
  const session = windowOn(authkit, storage);
  await session.restore();
  authkit.refresh.clear(); // revoked
  await assert.rejects(session.accessToken({ force: true }), /sign-in ended/);
  assert.equal(storage.values.has(SIGNIN_KEY), false);
  assert.equal(session.snapshot().ended, true);
  const relaunched = windowOn(authkit, storage);
  assert.equal(await relaunched.restore(), false);
});

test("a dropped network never deletes it: refresh and restore fail as offline, and it works once back", async () => {
  const authkit = fakeAuthKit();
  const storage = fakeStorage();
  storage.setItem(SIGNIN_KEY, JSON.stringify({ v: 1, refresh: authkit.issue().refresh_token }));
  const offline = new Set([AUTHKIT]);
  const session = windowOn(authkit, storage, { offline });
  await assert.rejects(session.restore(), (error) => error.code === "offline");
  assert.ok(stored(storage), "kept");
  assert.notEqual(session.snapshot().ended, true);
  offline.clear();
  assert.equal(await session.restore(), true);
  offline.add(AUTHKIT);
  await assert.rejects(session.accessToken({ force: true }), (error) => error.code === "offline");
  assert.ok(authkit.refresh.has(stored(storage)), "still the live token");
  assert.equal(session.snapshot().status, "signed-in");
});

test("two windows: one rotates, the other uses the rotated token instead of its own, and nothing is cleared", async () => {
  const authkit = fakeAuthKit();
  const storage = fakeStorage();
  storage.setItem(SIGNIN_KEY, JSON.stringify({ v: 1, refresh: authkit.issue().refresh_token }));
  const a = windowOn(authkit, storage);
  const b = windowOn(authkit, storage);
  await a.restore();
  await b.restore(); // b reads what a rotated
  await a.accessToken({ force: true }); // a rotates again; b still holds the older one in memory
  await b.accessToken({ force: true });
  for (const session of [a, b]) assert.equal(session.snapshot().status, "signed-in");
  assert.ok(authkit.refresh.has(stored(storage)));
});

test("two windows refreshing at the same moment: the loser picks up the winner's token instead of signing out", async () => {
  const authkit = fakeAuthKit();
  const storage = fakeStorage();
  storage.setItem(SIGNIN_KEY, JSON.stringify({ v: 1, refresh: authkit.issue().refresh_token }));
  const a = windowOn(authkit, storage);
  const b = windowOn(authkit, storage);
  await a.restore();
  await b.restore();
  const results = await Promise.allSettled([a.accessToken({ force: true }), b.accessToken({ force: true })]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"]);
  for (const session of [a, b]) assert.equal(session.snapshot().status, "signed-in");
  assert.ok(stored(storage), "never cleared");
  assert.ok(authkit.refresh.has(stored(storage)), "the kept token is live");
});

test("a refused token is cleared only if the disk still holds it: a newer sign-in saved meanwhile stays", async () => {
  const authkit = fakeAuthKit();
  const storage = fakeStorage();
  storage.setItem(SIGNIN_KEY, JSON.stringify({ v: 1, refresh: authkit.issue().refresh_token }));
  const session = windowOn(authkit, storage);
  await session.restore();
  // This window's sign-in is revoked; another window has just signed in anew,
  // and its token lands on disk after this window's last look.
  authkit.refresh.clear();
  const newer = authkit.issue().refresh_token;
  authkit.refresh.delete(newer); // not live for this window's exchange either
  let looks = 0;
  const store = diskStore({ storage: () => storage });
  const watched = createSession({
    request: https({ authkit }).request, sleep: yieldTurn,
    // Loads: restore, the pre-read, three looks after the refusal, then the
    // compare before clearing: the other window's save lands just before it.
    store: { ...store, load: async () => { looks += 1; if (looks === 6) storage.setItem(SIGNIN_KEY, JSON.stringify({ v: 1, refresh: "refresh-another-window" })); return store.load(); } },
  });
  storage.setItem(SIGNIN_KEY, JSON.stringify({ v: 1, refresh: "refresh-revoked" }));
  assert.equal(await watched.restore(), false, "refused");
  assert.equal(stored(storage), "refresh-another-window", "the other window's sign-in is left alone");
  await assert.rejects(session.accessToken({ force: true }));
});

test("Sign out in one window signs the other out at its next refresh, without bringing the token back", async () => {
  const authkit = fakeAuthKit();
  const storage = fakeStorage();
  storage.setItem(SIGNIN_KEY, JSON.stringify({ v: 1, refresh: authkit.issue().refresh_token }));
  const a = windowOn(authkit, storage);
  const b = windowOn(authkit, storage);
  await a.restore();
  await b.restore();
  await a.signOut();
  await assert.rejects(b.accessToken({ force: true }), /Sign in to Black 4 first/);
  assert.equal(b.snapshot().status, "signed-out");
  assert.notEqual(b.snapshot().ended, true, "not an ended sign-in: no prompt");
  assert.equal(storage.values.has(SIGNIN_KEY), false, "not written back");
});

test("blocked localStorage: the sign-in is kept in memory for this run, and nothing breaks", async () => {
  for (const fail of [["getItem", "setItem", "removeItem"], ["setItem"]]) {
    const authkit = fakeAuthKit({ polls: ["ok"], interval: 0.001 });
    const storage = fakeStorage({ fail });
    const store = diskStore({ storage: () => storage });
    const session = createSession({ request: https({ authkit }).request, store, sleep: yieldTurn });
    await session.signIn();
    assert.equal(session.snapshot().status, "signed-in");
    assert.match(await store.load(), /^refresh-/, `${fail}: kept in memory`);
    await session.accessToken({ force: true });
    assert.equal(session.snapshot().status, "signed-in");
    assert.equal(storage.values.has(SIGNIN_KEY), false, "no stale token left on disk");
    await session.signOut();
    assert.equal(await store.load(), null);
  }
  const missing = diskStore({ storage: () => undefined });
  await missing.save("refresh-x");
  assert.equal(await missing.load(), "refresh-x");
  await missing.clear();
  assert.equal(await missing.load(), null);
});

test("a disk that cannot delete writes an empty record instead, read as no sign-in", async () => {
  const storage = fakeStorage({ fail: ["removeItem"] });
  const store = diskStore({ storage: () => storage });
  await store.save("refresh-1");
  await store.clear();
  assert.equal(stored(storage), null);
  assert.equal(await diskStore({ storage: () => storage }).load(), null);
});

test("a fresh approval (step up) keeps the current sign-in in use and kept; cancelling it changes nothing", async () => {
  const authkit = fakeAuthKit({ polls: ["authorization_pending"], interval: 0.001 });
  const storage = fakeStorage();
  storage.setItem(SIGNIN_KEY, JSON.stringify({ v: 1, refresh: authkit.issue().refresh_token }));
  const session = windowOn(authkit, storage);
  await session.restore();
  const kept = stored(storage);
  const flow = session.signIn({ stepUp: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(stored(storage), kept, "kept while approving");
  assert.match(await session.accessToken(), /^access-/, "still usable while approving");
  session.cancel();
  await assert.rejects(flow, /Cancelled/);
  assert.equal(session.snapshot().status, "signed-in");
  assert.equal(stored(storage), kept);
  authkit.polls = ["ok"];
  await session.signIn({ stepUp: true });
  assert.equal(session.snapshot().status, "signed-in");
  assert.notEqual(stored(storage), kept, "approved: the new sign-in replaces it");
});
