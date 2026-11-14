// The hardware provider against a process double: no SSH, no machine.
import test from "node:test";
import assert from "node:assert/strict";
import { ask, provider, defaults } from "../plugins/hardware/plugin.js";

/** A spawn double: records each request and answers with `reply(request)`. */
function machine(reply) {
  const seen = [];
  const spawn = async (id, { onStdout, onStderr }) => {
    let input = "";
    let done;
    const exited = new Promise((resolve) => { done = resolve; });
    return {
      write: async (text) => { input += text; },
      end: async () => {
        const request = JSON.parse(input);
        seen.push({ id, request });
        const answer = reply(request);
        if (answer === undefined) onStderr("ssh: connect to host commerce: Operation timed out\n");
        else onStdout(`${JSON.stringify(answer)}\n`);
        done(0);
      },
      kill: async () => done(1),
      exited,
    };
  };
  return { spawn, seen };
}

const PUBKEY = "a".repeat(64);
const AUTH = ["auth", "b".repeat(64), "", "c".repeat(128)];

test("ask returns the machine's reply and names the machine's own error", async () => {
  const ok = machine(() => ({ ok: true, agents: [] }));
  assert.deepEqual(await ask(ok.spawn, { op: "list" }), { ok: true, agents: [] });
  assert.equal(ok.seen[0].id, "commerce");
  const refused = machine(() => ({ ok: false, error: "no such agent on this machine" }));
  await assert.rejects(ask(refused.spawn, { op: "status", pubkey: PUBKEY }), /no such agent/);
});

test("ask says so when the machine cannot be reached", async () => {
  const down = machine(() => undefined);
  await assert.rejects(ask(down.spawn, { op: "list" }), /Could not reach the commerce machine: ssh: connect/);
  await assert.rejects(ask(undefined, { op: "list" }), /cannot start processes/);
});

test("a retried creation asks for the same agent, and activation carries the attestation", async () => {
  const box = machine((request) => (request.op === "provision" ? { ok: true, pubkey: PUBKEY } : { ok: true }));
  let ids = 0;
  const remote = provider(box.spawn, () => `request-${++ids}`);
  const input = { name: "Paid Media", community: "wss://example.communities.buzz.xyz", config: { harness: "codex" } };
  assert.deepEqual(await remote.provision(input), { pubkey: PUBKEY });
  await remote.provision(input);
  assert.equal(box.seen[0].request.requestId, "request-1");
  assert.equal(box.seen[1].request.requestId, "request-1");
  assert.deepEqual(box.seen[0].request.config, { ...defaults(), harness: "codex" });

  await remote.activate({ pubkey: PUBKEY, name: "Paid Media", community: input.community, auth: AUTH });
  assert.deepEqual(box.seen[2].request, { op: "activate", pubkey: PUBKEY, community: input.community, auth: AUTH });
  await remote.provision(input);
  assert.equal(box.seen[3].request.requestId, "request-2");
});

test("profile, instructions and removal are one request each", async () => {
  const box = machine((request) => (request.op === "instructions.get" ? { ok: true, instructions: "Be brief." } : { ok: true }));
  const remote = provider(box.spawn);
  await remote.profile({ pubkey: PUBKEY, community: "wss://x", name: "Rock" });
  assert.equal(await remote.instructions.get({ pubkey: PUBKEY, community: "wss://x" }), "Be brief.");
  await remote.instructions.set({ pubkey: PUBKEY, community: "wss://x", instructions: "Be kind." });
  await remote.remove({ pubkey: PUBKEY, community: "wss://x" });
  assert.deepEqual(box.seen.map((entry) => entry.request.op), ["profile", "instructions.get", "instructions.set", "remove"]);
  assert.deepEqual(box.seen[0].request, { op: "profile", pubkey: PUBKEY, name: "Rock", picture: null });
});
