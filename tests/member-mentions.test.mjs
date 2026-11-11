import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(process.env.BLACK4_TEST_PLUGIN ?? new URL("../plugins/black4/plugin.js", import.meta.url), "utf8");
const { inject, memberMentionWakes, relayMemberMentions, threadRoot } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

const hex = (c) => c.repeat(64);
const OWNER = hex("a");
const MEMBER = hex("b");
const AGENT = hex("c");
const OTHER_AGENT = hex("d");
const CHANNEL = "11111111-2222-4333-8444-555555555555";
const agents = [
  { key: AGENT, pubkey: AGENT, owner: OWNER, relay: "wss://community.test" },
  { key: OTHER_AGENT, pubkey: OTHER_AGENT, owner: OWNER, relay: "wss://community.test" },
];
const message = (patch = {}) => ({
  id: hex("1"),
  kind: 9,
  pubkey: MEMBER,
  created_at: 2_000_000_000,
  content: "@Agent what's up?",
  tags: [["h", CHANNEL], ["p", AGENT]],
  ...patch,
});

test("the plugin asks for the relay service", () => {
  assert.ok(inject.includes("relay"));
});

test("a member's @mention wakes that agent in a thread rooted at the message", () => {
  const wakes = memberMentionWakes(message(), agents, OWNER, () => "Sam");
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].key, AGENT);
  assert.equal(wakes[0].channel, CHANNEL);
  assert.equal(wakes[0].root, hex("1"));
  assert.match(wakes[0].text, /Sam \(nostr:b{64}\), a member of this channel, @mentioned you/);
  assert.match(wakes[0].text, /Their message:\n@Agent what's up\?/);
});

test("a reply in a thread wakes the agent in that thread", () => {
  const root = hex("9");
  const event = message({ tags: [["h", CHANNEL], ["e", root, "", "root"], ["p", AGENT]] });
  assert.equal(threadRoot(event), root);
  assert.equal(memberMentionWakes(event, agents, OWNER)[0].root, root);
});

test("each mentioned agent is woken once, and unmentioned ones are not", () => {
  const event = message({ tags: [["h", CHANNEL], ["p", AGENT], ["p", OTHER_AGENT], ["p", AGENT], ["p", hex("e")]] });
  assert.deepEqual(memberMentionWakes(event, agents, OWNER).map((wake) => wake.key), [AGENT, OTHER_AGENT]);
});

test("the owner's own mentions are left to Buzz", () => {
  assert.deepEqual(memberMentionWakes(message({ pubkey: OWNER }), agents, OWNER), []);
});

test("agents never wake agents through the plugin", () => {
  assert.deepEqual(memberMentionWakes(message({ pubkey: OTHER_AGENT }), agents, OWNER), []);
  const attested = message({ pubkey: hex("f"), tags: [["h", CHANNEL], ["p", AGENT], ["auth", OWNER, "", hex("0") + hex("0")]] });
  assert.deepEqual(memberMentionWakes(attested, agents, OWNER), []);
});

test("other people's agents and other kinds are ignored", () => {
  const foreign = [{ key: AGENT, pubkey: AGENT, owner: hex("2") }];
  assert.deepEqual(memberMentionWakes(message(), foreign, OWNER), []);
  assert.deepEqual(memberMentionWakes(message({ kind: 7 }), agents, OWNER), []);
  assert.deepEqual(memberMentionWakes(message({ tags: [["p", AGENT]] }), agents, OWNER), []);
});

function fakeCtx(t, options = {}) {
  const wakes = [];
  const relayListeners = new Set();
  let viewListener;
  let events = [];
  let filters;
  let cleanup;
  const now = Math.floor(Date.now() / 1000);
  const ctx = {
    relay: {
      snapshot: () => ({
        status: "ready",
        viewer: OWNER,
        origin: "https://community.test",
        scope: "community",
        generation: 1,
        session: {
          profiles: { snapshot: () => new Map([[MEMBER, { name: "Sam" }]]), ensure: async () => {} },
          observe: (value) => {
            filters = value;
            return {
              snapshot: () => ({ status: "ready", events }),
              subscribe: (fn) => { viewListener = fn; return () => { viewListener = undefined; }; },
              refresh: async () => {},
              dispose: () => {},
            };
          },
        },
      }),
      subscribe: (fn) => { relayListeners.add(fn); return () => relayListeners.delete(fn); },
    },
    agents: {
      snapshot: () => ({ running: options.running ?? agents }),
      subscribe: () => () => {},
      wake: (key, wake) => {
        if (options.throws) throw new Error("queue full");
        wakes.push({ key, ...wake });
      },
    },
    effect: (fn) => { cleanup = fn(); },
  };
  relayMemberMentions(ctx);
  t.after(() => cleanup?.());
  return {
    wakes,
    filters: () => filters,
    deliver: (list) => { events = list; viewListener?.(); },
    now,
  };
}

test("the relay watches new mentions of the owner's agents and wakes each once", (t) => {
  const run = fakeCtx(t);
  assert.deepEqual(run.filters()[0].kinds, [9]);
  assert.deepEqual(run.filters()[0]["#p"], [AGENT, OTHER_AGENT]);
  const fresh = message({ created_at: run.now + 5 });
  run.deliver([fresh]);
  run.deliver([fresh]);
  assert.equal(run.wakes.length, 1);
  assert.equal(run.wakes[0].key, AGENT);
  assert.equal(run.wakes[0].root, fresh.id);
  assert.match(run.wakes[0].text, /^Sam /);
});

test("messages from before the plugin started are not replayed", (t) => {
  const run = fakeCtx(t);
  run.deliver([message({ created_at: run.now - 60 })]);
  assert.equal(run.wakes.length, 0);
});

test("a wake that Buzz refuses does not stop the relay", (t) => {
  const run = fakeCtx(t, { throws: true });
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = warn; });
  assert.doesNotThrow(() => run.deliver([message({ created_at: run.now + 5 })]));
});

test("with no agents of the owner running here, nothing is watched", (t) => {
  const run = fakeCtx(t, { running: [] });
  assert.equal(run.filters(), undefined);
});
