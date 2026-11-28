// Updates nobody can miss (src/updates/watch.js): the notice comes back after
// it is closed, sooner once overdue; the overdue clock lives on the device by
// installed revision; and the watch is inert on a Buzz without the services.
import assert from "node:assert/strict";
import test from "node:test";
import { freshPlugin, settle } from "./fakes.mjs";

const HOUR = 60 * 60 * 1000;
const { createUpdateWatch, UPDATE_SEEN_KEY, UPDATE_REQUIRED_TEXT } = await freshPlugin();

function world({ candidate = { token: "t1", id: "ai.black4", installedRevision: "old", candidateRevision: "new" }, stored } = {}) {
  let clock = 1_000_000;
  const timers = new Map();
  let nextTimer = 1;
  const values = new Map(stored ? [[UPDATE_SEEN_KEY, JSON.stringify(stored)]] : []);
  const shown = [];
  let close = null;
  const listeners = new Set();
  let current = candidate;
  const queued = [];
  const updates = {
    getSnapshot: () => ({ candidates: current ? [current] : [] }),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    refresh: async () => {},
    queueUpdates: (tokens) => { queued.push(tokens); return { id: "q" }; },
  };
  const notices = { show: (content) => { shown.push(content); return new Promise((resolve) => { close = resolve; }); } };
  const changes = []; // what Settings would draw after each onChange
  const watch = createUpdateWatch({
    pluginId: "ai.black4", updates, notices,
    storage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    now: () => clock,
    onChange: () => changes.push(watch.status()),
    timers: {
      setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock + ms }); return id; },
      clearTimeout: (id) => timers.delete(id),
      setInterval: () => 0, clearInterval: () => {},
    },
  });
  return {
    watch, shown, queued, values, changes,
    close: async (action) => { close(action); await settle(); },
    later: (ms) => { clock += ms; for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); } },
    publish: (next) => { current = next; for (const listener of listeners) listener(); },
  };
}

test("shown at once, back an hour after Later, never twice at a time", async () => {
  const w = world();
  w.watch.start();
  assert.equal(w.shown.length, 1);
  w.later(5 * 60 * 1000);
  assert.equal(w.shown.length, 1, "one notice while it is on screen");
  await w.close("later");
  w.later(59 * 60 * 1000);
  assert.equal(w.shown.length, 1);
  w.later(2 * 60 * 1000);
  assert.equal(w.shown.length, 2, "closed: served again an hour later");
  await w.close(undefined); // dismissed with ×
  w.later(HOUR + 1);
  assert.equal(w.shown.length, 3, "dismissing it is the same as Later");
});

test("Update now opens Buzz's Update review for this plugin's candidate", async () => {
  const w = world();
  w.watch.start();
  await w.close("update");
  assert.deepEqual(w.queued, [["t1"]]);
});

test("overdue after a day on this device: tools refuse, the notice says so and returns every 15 minutes", async () => {
  const w = world({ stored: { installed: "old", since: 1_000_000 - 25 * HOUR } });
  w.watch.start();
  assert.equal(w.watch.refusal(), UPDATE_REQUIRED_TEXT);
  assert.equal(w.shown[0].title, "Update Black 4 now");
  await w.close("later");
  w.later(16 * 60 * 1000);
  assert.equal(w.shown.length, 2);
});

test("the clock starts at the first update seen for the installed revision, and a newer release does not restart it", () => {
  const w = world();
  w.watch.start();
  assert.equal(w.watch.refusal(), null);
  w.later(23 * HOUR);
  w.publish({ token: "t2", id: "ai.black4", installedRevision: "old", candidateRevision: "newer" });
  assert.equal(w.watch.refusal(), null);
  w.later(2 * HOUR);
  assert.equal(w.watch.refusal(), UPDATE_REQUIRED_TEXT, "a day from the first sight, not from the newer release");
  // Updated to the release, with another one already out: a new day starts.
  w.publish({ token: "t3", id: "ai.black4", installedRevision: "newer", candidateRevision: "newest" });
  assert.equal(w.watch.refusal(), null);
});

test("no candidate for this plugin: nothing shown, nothing refused; another plugin's update is not ours", () => {
  const w = world({ candidate: { token: "x", id: "someone.else", installedRevision: "a", candidateRevision: "b" } });
  w.watch.start();
  assert.equal(w.shown.length, 0);
  assert.equal(w.watch.status(), null);
  assert.equal(w.watch.refusal(), null);
});

test("the day runs out while Buzz is open: Settings flips to Update required and the notice says the tools are paused, without a restart", async () => {
  const w = world();
  w.watch.start();
  assert.equal(w.shown[0].title, "Update Black 4");
  assert.deepEqual(w.changes.map((status) => status.overdue), [false], "Settings drew Update ready when the update appeared");
  w.later(23 * HOUR);
  assert.equal(w.watch.refusal(), null, "still within the day");
  assert.equal(w.watch.status().overdue, false);
  assert.equal(w.shown.length, 1);
  w.later(HOUR + 1);
  assert.equal(w.watch.refusal(), UPDATE_REQUIRED_TEXT, "the tools pause");
  assert.deepEqual(w.changes.map((status) => status.overdue), [false, true], "and Settings is told to draw Update required at that moment");
  assert.equal(w.shown.length, 2, "the notice on screen is replaced");
  assert.equal(w.shown[1].title, "Update Black 4 now");
  assert.match(w.shown[1].description, /tools are paused/);
  // Closed earlier, waiting for its hourly return: the flip still redraws Settings.
  const closed = world();
  closed.watch.start();
  await closed.close("later");
  closed.later(24 * HOUR + 1);
  assert.equal(closed.watch.refusal(), UPDATE_REQUIRED_TEXT);
  assert.deepEqual(closed.changes.map((status) => status.overdue), [false, true]);
  assert.equal(closed.shown.at(-1).title, "Update Black 4 now");
  // Updated in time: the clock is dropped with the candidate, nothing flips later.
  const current = world();
  current.watch.start();
  current.publish(null);
  assert.equal(current.changes.length, 2);
  current.later(25 * HOUR);
  assert.equal(current.changes.length, 2);
  assert.equal(current.watch.refusal(), null);
  current.watch.stop();
});

test("the refusal tells the agent exactly where the person updates", () => {
  for (const place of ["Update now", "Settings → Black 4", "Settings → Plugins", "Update Black 4 now"]) assert.ok(UPDATE_REQUIRED_TEXT.includes(place), place);
});

test("an older Buzz without the update or notice services: the watch does nothing", () => {
  const watch = createUpdateWatch({ pluginId: "ai.black4", updates: undefined, notices: undefined, storage: undefined });
  watch.start();
  assert.equal(watch.status(), null);
  assert.equal(watch.refusal(), null);
  watch.stop();
});
