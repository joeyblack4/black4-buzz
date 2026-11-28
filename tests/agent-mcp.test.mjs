// The Black 4 connector for machine agents (bridge/black4-agent-mcp).
// Needs its pinned dependency: npm ci --prefix bridge/black4-agent-mcp
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import test from "node:test";

const DIR = new URL("../bridge/black4-agent-mcp/", import.meta.url);
if (!existsSync(new URL("node_modules/@noble/curves/package.json", DIR))) {
  throw new Error("The connector's dependency is missing: run  npm ci --prefix bridge/black4-agent-mcp");
}
const CONNECTOR = new URL("black4-agent-mcp.mjs", DIR).pathname;
const { schnorr, decodeNsec, secretKey, parseAuthTag, signRequest, signedUrl, eventId, STATUS_TOOL, agentLabel, createConnector } = await import(CONNECTOR);
const { startFakeMcp, verifyRequest, authTagOwner } = await import(new URL("test/fake-black4-mcp.mjs", DIR).pathname);

const hex = (b) => Buffer.from(b).toString("hex");
const sha256 = (s) => createHash("sha256").update(s).digest();

function identity(conditions = "") {
  const ownerSecret = randomBytes(32);
  const agentSecret = randomBytes(32);
  const owner = hex(schnorr.getPublicKey(ownerSecret));
  const agent = hex(schnorr.getPublicKey(agentSecret));
  const sig = hex(schnorr.sign(sha256(`nostr:agent-auth:${agent}:${conditions}`), ownerSecret));
  return { owner, agent, agentSecret, authTag: ["auth", owner, conditions, sig] };
}

// ---------------------------------------------------------------- signing

test("BIP-340 test vectors: signing and verification", () => {
  const rows = readFileSync(new URL("fixtures/bip340-vectors.csv", import.meta.url), "utf8").trim().split("\n").slice(1);
  assert.ok(rows.length >= 15);
  for (const row of rows) {
    const [index, sk, pk, aux, msg, sig, result] = row.split(",");
    const bytes = (h) => Buffer.from(h, "hex");
    if (sk) {
      assert.equal(hex(schnorr.getPublicKey(bytes(sk))).toUpperCase(), pk, `vector ${index} pubkey`);
      assert.equal(hex(schnorr.sign(bytes(msg), bytes(sk), bytes(aux))).toUpperCase(), sig, `vector ${index} signature`);
    }
    let ok;
    try { ok = schnorr.verify(bytes(sig), bytes(msg), bytes(pk)); } catch { ok = false; }
    assert.equal(ok, result === "TRUE", `vector ${index} verification`);
  }
});

test("keys: hex and NIP-19 nsec give the same secret; junk is refused", () => {
  const nsec = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5"; // NIP-19 example
  const want = "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa";
  assert.equal(hex(decodeNsec(nsec)), want);
  assert.equal(hex(secretKey(nsec)), want);
  assert.equal(hex(secretKey(want.toUpperCase())), want);
  assert.throws(() => decodeNsec(nsec.slice(0, -1) + "q"), /checksum/);
  assert.throws(() => secretKey("0".repeat(64)));
  assert.throws(() => secretKey("npub1abc"));
  assert.throws(() => secretKey(""));
});

test("auth tag must be a NIP-OA tag", () => {
  const { authTag } = identity();
  assert.deepEqual(parseAuthTag(JSON.stringify(authTag)), authTag);
  assert.throws(() => parseAuthTag(""));
  assert.throws(() => parseAuthTag(JSON.stringify(authTag.slice(0, 3))));
  assert.throws(() => parseAuthTag(JSON.stringify(["p", ...authTag.slice(1)])));
});

test("the signed event matches the wire format and passes real verification", () => {
  const { agent, agentSecret, authTag, owner } = identity("created_at<4294967295");
  const url = "https://api.black4.ai/mcp?tools=core";
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  const now = Date.now();
  const { event, header } = signRequest({ secret: agentSecret, authTag, url, body, now });
  assert.equal(signedUrl(url), "https://api.black4.ai/mcp");
  assert.deepEqual(Object.keys(event).sort(), ["content", "created_at", "id", "kind", "pubkey", "sig", "tags"]);
  assert.equal(event.kind, 27235);
  assert.equal(event.pubkey, agent);
  assert.equal(event.created_at, Math.floor(now / 1000));
  assert.equal(event.content, "");
  assert.deepEqual(event.tags, [
    ["u", "https://api.black4.ai/mcp"], ["method", "POST"], ["payload", createHash("sha256").update(body).digest("hex")], authTag,
  ]);
  assert.equal(event.id, eventId(event));
  assert.ok(header.startsWith("Nostr "));
  assert.deepEqual(JSON.parse(Buffer.from(header.slice(6), "base64")), event);
  assert.equal(authTagOwner(agent, authTag), owner);

  const seen = new Set();
  const check = (over = {}) => verifyRequest({ header, method: "POST", url: "https://api.black4.ai/mcp", body, now, seen, ...over });
  assert.deepEqual(check(), { agent, owner });
  assert.equal(check().error, "replayed_event", "an event id is single-use");
  const fresh = (o = {}) => verifyRequest({ header: signRequest({ secret: agentSecret, authTag, url, body, now }).header, method: "POST", url: "https://api.black4.ai/mcp", body, now, ...o });
  assert.equal(fresh({ body: Buffer.from(body + " ") }).error, "wrong_payload");
  assert.equal(fresh({ url: "https://api.black4.ai/other" }).error, "wrong_url");
  assert.equal(fresh({ method: "GET" }).error, "wrong_method");
  assert.equal(fresh({ now: now + 61_000 }).error, "stale_event");
  const other = identity();
  assert.equal(verifyRequest({ header: signRequest({ secret: agentSecret, authTag: other.authTag, url, body, now }).header, method: "POST", url: "https://api.black4.ai/mcp", body, now }).error,
    "no_owner_attestation", "an attestation for another agent is refused");
  const expired = identity(`created_at<${Math.floor(now / 1000) - 10}`);
  assert.equal(verifyRequest({ header: signRequest({ secret: expired.agentSecret, authTag: expired.authTag, url, body, now }).header, method: "POST", url: "https://api.black4.ai/mcp", body, now }).error,
    "no_owner_attestation", "an expired attestation is refused");
  const tampered = { ...event, sig: event.sig.replace(/^./, (c) => (c === "0" ? "1" : "0")) };
  assert.equal(verifyRequest({ header: `Nostr ${Buffer.from(JSON.stringify(tampered)).toString("base64")}`, method: "POST", url: "https://api.black4.ai/mcp", body, now }).error, "bad_signature");
});

// ---------------------------------------------------------------- the process

function run(t, env) {
  const child = spawn(process.execPath, [CONNECTOR], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  const waiters = [];
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const m = JSON.parse(line);
    messages.push(m);
    for (const w of [...waiters]) if (w.match(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  t.after(() => child.kill());
  let next = 1;
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  const waitFor = (match, ms = 5000) => new Promise((resolve, reject) => {
    const found = messages.find(match);
    if (found) return resolve(found);
    const timer = setTimeout(() => reject(new Error("no reply")), ms);
    waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
  });
  const request = (method, params = {}, ms) => {
    const id = next++;
    send({ jsonrpc: "2.0", id, method, params });
    return waitFor((m) => m.id === id, ms);
  };
  const init = async () => {
    const r = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return r;
  };
  return { child, messages, send, request, waitFor, init, stderr: () => stderr, nextId: () => next++ };
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const envFor = (id, url, extra = {}) => ({
  BUZZ_PRIVATE_KEY: hex(id.agentSecret), BUZZ_AUTH_TAG: JSON.stringify(id.authTag), BLACK4_MCP_URL: url, ...extra,
});

test("the agent's name goes out as X-Black4-Agent on every request, and only when it has one", async (t) => {
  const id = identity();
  const fake = await startFakeMcp({ linked: new Set([id.owner]) });
  t.after(fake.close);
  const named = run(t, envFor(id, fake.url, { BUZZ_ACP_DISPLAY_NAME: "  Paid  Media ✓ " }));
  await named.init();
  await named.request("tools/call", { name: "whoami", arguments: {} });
  await settle();
  assert.ok(fake.requests.length >= 2);
  assert.ok(fake.requests.every((r) => r.headers["x-black4-agent"] === "Paid Media"), "printable, collapsed, trimmed");
  const before = fake.requests.length;
  const plain = run(t, envFor(id, fake.url));
  await plain.init();
  await settle();
  assert.ok(fake.requests.slice(before).every((r) => r.headers["x-black4-agent"] === undefined));
  assert.equal(agentLabel("x".repeat(100)).length, 80);
  assert.equal(agentLabel("✓"), null);
});

test("linked owner: forwards initialize, every tool, calls, SSE and notifications", async (t) => {
  const id = identity();
  const fake = await startFakeMcp({ linked: new Set([id.owner]) });
  t.after(fake.close);
  const c = run(t, envFor(id, fake.url));
  const init = await c.init();
  assert.equal(init.result.serverInfo.name, "fake-black4");
  const list = await c.request("tools/list");
  const names = list.result.tools.map((x) => x.name);
  assert.ok(names.includes("find_tools") && names.includes("call_tool"));
  assert.ok(!names.includes(STATUS_TOOL));
  const who = await c.request("tools/call", { name: "whoami", arguments: {} });
  assert.deepEqual(JSON.parse(who.result.content[0].text), { agent: id.agent, owner: id.owner });
  const echo = await c.request("tools/call", { name: "echo", arguments: { text: "héllo ✓\n\"q\"" } });
  assert.deepEqual(JSON.parse(echo.result.content[0].text), { text: "héllo ✓\n\"q\"" });
  const streamed = await c.request("tools/call", { name: "stream", arguments: {}, _meta: { progressToken: 1 } });
  assert.equal(streamed.result.content[0].text, "streamed");
  assert.ok(c.messages.some((m) => m.method === "notifications/progress"), "SSE notifications pass through");
  const boom = await c.request("tools/call", { name: "boom", arguments: {} });
  assert.equal(boom.result.isError, true);
  assert.match(boom.result.content[0].text, /HTTP 500: kaboom/);
  await settle();
  assert.ok(fake.requests.every((r) => !r.verdict.error), "every request verified");
  assert.ok(fake.requests.every((r) => r.url.endsWith("/mcp")), "no toolset: every tool, as any agent sees it");
  assert.equal(new Set(fake.requests.map((r) => r.headers.authorization)).size, fake.requests.length, "a fresh event per request");
  assert.equal(fake.requests.find((r) => r.body.includes("notifications/initialized")).verdict.owner, id.owner);
  assert.ok(fake.requests.slice(1).every((r) => r.headers["mcp-protocol-version"] === "2025-06-18"));
  assert.ok(!c.messages.some((m) => m.id === undefined && !m.method), "202 for a notification writes nothing");
});

test("unlinked owner: agent starts, sees one status tool, gets one plain sentence, no retries", async (t) => {
  const id = identity();
  const fake = await startFakeMcp();
  t.after(fake.close);
  const c = run(t, envFor(id, fake.url));
  const init = await c.init();
  assert.equal(init.result.serverInfo.name, "black4");
  assert.match(init.result.instructions, /^Black 4 does not recognise this agent's owner yet/);
  const list = await c.request("tools/list");
  assert.deepEqual(list.result.tools.map((x) => x.name), [STATUS_TOOL]);
  const call = await c.request("tools/call", { name: "whoami", arguments: {} });
  assert.equal(call.result.isError, true);
  const text = call.result.content[0].text;
  assert.match(text, /^Black 4 does not recognise this agent's owner yet/);
  assert.ok(text.includes(id.owner), "names the owner key that needs linking");
  assert.match(text, /not linked to a Black 4 account/, "carries the server's own words");
  const status = await c.request("tools/call", { name: STATUS_TOOL, arguments: {} });
  assert.equal(status.result.content[0].text, text, "a status check right after a refusal does not call again");
  await settle(500);
  const count = fake.requests.length;
  assert.equal(count, 4, "initialize, initialized, tools/list, one tools/call: nothing else");
  await settle(500);
  assert.equal(fake.requests.length, count, "no retry storm");

  // Once the owner is linked, the status tool finds it and refreshes the list.
  fake.linked.add(id.owner);
  const later = run(t, envFor(id, fake.url));
  await later.init();
  const ok = await later.request("tools/call", { name: STATUS_TOOL, arguments: {} });
  assert.match(ok.result.content[0].text, /recognises this agent now/);
  await later.waitFor((m) => m.method === "notifications/tools/list_changed");
  const relist = await later.request("tools/list");
  assert.ok(relist.result.tools.some((x) => x.name === "whoami"));
});

test("status tool rechecks after the throttle and announces the new tools", async (t) => {
  const id = identity();
  const fake = await startFakeMcp();
  t.after(fake.close);
  const c = run(t, envFor(id, fake.url, { BLACK4_MCP_RECHECK_MS: "300" }));
  await c.init();
  await c.request("tools/list");
  fake.linked.add(id.owner);
  const early = await c.request("tools/call", { name: STATUS_TOOL, arguments: {} });
  assert.equal(early.result.isError, true, "right after a refusal it answers from memory");
  await settle(400);
  const ok = await c.request("tools/call", { name: STATUS_TOOL, arguments: {} });
  assert.match(ok.result.content[0].text, /recognises this agent now/);
  await c.waitFor((m) => m.method === "notifications/tools/list_changed");
  assert.ok((await c.request("tools/list")).result.tools.some((x) => x.name === "find_tools"));
});

test("no key or no attestation: starts, explains, never calls Black 4", async (t) => {
  const fake = await startFakeMcp();
  t.after(fake.close);
  const id = identity();
  const c = run(t, { BUZZ_PRIVATE_KEY: hex(id.agentSecret), BLACK4_MCP_URL: fake.url });
  await c.init();
  assert.deepEqual((await c.request("tools/list")).result.tools.map((x) => x.name), [STATUS_TOOL]);
  const s = await c.request("tools/call", { name: STATUS_TOOL, arguments: {} });
  assert.match(s.result.content[0].text, /no Buzz owner attestation/);
  const none = run(t, { BLACK4_MCP_URL: fake.url });
  await none.init();
  const n = await none.request("tools/call", { name: "whoami", arguments: {} });
  assert.match(n.result.content[0].text, /no Buzz key/);
  await settle();
  assert.equal(fake.requests.length, 0);
});

test("unreachable Black 4: starts and says so", async (t) => {
  const id = identity();
  const fake = await startFakeMcp();
  const url = fake.url;
  await fake.close();
  const c = run(t, envFor(id, url));
  const init = await c.init();
  assert.match(init.result.instructions, /could not be reached/);
  const call = await c.request("tools/call", { name: "echo", arguments: {} });
  assert.match(call.result.content[0].text, /^Black 4 could not be reached/);
});

test("long calls: a timeout gives a sentence, a cancelled call gets no reply", async (t) => {
  const id = identity();
  const fake = await startFakeMcp({ linked: new Set([id.owner]) });
  t.after(fake.close);
  const c = run(t, envFor(id, fake.url, { BLACK4_MCP_TIMEOUT_MS: "300" }));
  await c.init();
  const slow = await c.request("tools/call", { name: "slow", arguments: { ms: 2000 } });
  assert.match(slow.result.content[0].text, /did not answer within/);
  const fine = await c.request("tools/call", { name: "slow", arguments: { ms: 50 } });
  assert.equal(fine.result.content[0].text, "done");

  const d = run(t, envFor(id, fake.url));
  await d.init();
  const rid = d.nextId();
  d.send({ jsonrpc: "2.0", id: rid, method: "tools/call", params: { name: "slow", arguments: { ms: 800 } } });
  await settle(100);
  d.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: rid } });
  await settle(1200);
  assert.ok(!d.messages.some((m) => m.id === rid), "no reply for a cancelled request");
});

test("never writes the key, the attestation signature or the header", async (t) => {
  const id = identity();
  const fake = await startFakeMcp();
  t.after(fake.close);
  const c = run(t, envFor(id, fake.url));
  await c.init();
  await c.request("tools/call", { name: "whoami", arguments: {} });
  await settle();
  const out = c.stderr() + JSON.stringify(c.messages);
  assert.ok(!out.includes(hex(id.agentSecret)));
  assert.ok(!out.includes(id.authTag[3]));
  assert.ok(!out.includes("Nostr "));
  assert.match(c.stderr(), /forwarding to \S*\/mcp for owner/);
});

// ---------------------------------------------------------------- one call (agentctl)

/** `black4-agent-mcp --call <tool>` with `env`: its one JSON line. */
function callOnce(env, tool = "get_buzz_audience", stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CONNECTOR, "--call", tool], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", reject);
    child.on("close", () => { try { resolve(JSON.parse(out.trim().split("\n").pop())); } catch (error) { reject(new Error(`not one JSON line: ${out}`)); } });
    child.stdin.end(stdin);
  });
}

test("--call: asks the tool signed as the agent and prints its result", async (t) => {
  const id = identity();
  const audience = ({ agent, owner }) => ({ keys: [{ pubkey: "f".repeat(64), email: "pat@example.com", kind: "staff" }], asOf: "2026-11-17T00:00:00Z", agent, owner });
  const fake = await startFakeMcp({ linked: new Set([id.owner]), audience });
  t.after(fake.close);
  const answer = await callOnce(envFor(id, fake.url));
  assert.equal(answer.ok, true);
  const data = JSON.parse(answer.result.content[0].text);
  assert.deepEqual([data.agent, data.owner, data.keys[0].kind], [id.agent, id.owner, "staff"], "signed as the agent, attesting its owner");
  assert.ok(fake.requests.every((r) => !r.verdict.error), "every request verified");
  assert.deepEqual(fake.requests.map((r) => JSON.parse(r.body).method), ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
});

test("--call: a server without the tool answers missing, through call_tool too", async (t) => {
  const id = identity();
  const fake = await startFakeMcp({ linked: new Set([id.owner]) }); // lists call_tool, has no get_buzz_audience
  t.after(fake.close);
  assert.deepEqual(await callOnce(envFor(id, fake.url)), { ok: false, kind: "missing", detail: "Black 4 has no get_buzz_audience tool for this agent." });
  // The same agent again within the same second: fresh ids, so no replay.
  const trimmed = await callOnce(envFor(id, fake.url, { BLACK4_MCP_TOOLS: "core" }));
  assert.equal(trimmed.kind, "missing");
});

test("--call: refusals, an unlinked owner and an unreachable server are failures, not missing", async (t) => {
  const id = identity();
  const refusing = await startFakeMcp({ linked: new Set([id.owner]), audience: { isError: true, content: [{ type: "text", text: "not seated" }] } });
  t.after(refusing.close);
  assert.deepEqual(await callOnce(envFor(id, refusing.url)), { ok: false, kind: "refused", detail: "not seated" });
  const unlinked = await startFakeMcp({ audience: { keys: [] } });
  t.after(unlinked.close);
  assert.equal((await callOnce(envFor(id, unlinked.url))).kind, "auth");
  assert.equal((await callOnce(envFor(id, "http://127.0.0.1:9/mcp", { BLACK4_MCP_TIMEOUT_MS: "2000" }))).kind, "unreachable");
  assert.equal((await callOnce({ BLACK4_MCP_URL: unlinked.url })).kind, "setup");
  assert.equal((await callOnce(envFor(id, unlinked.url), "Bad Name")).kind, "setup");
  assert.equal((await callOnce(envFor(id, unlinked.url), "get_buzz_audience", "[1]")).kind, "setup");
});

test("--call: an unseated agent's refusal carries Platform Control's code", async (t) => {
  const id = identity();
  const fake = await startFakeMcp({ linked: new Set([id.owner]), audience: { keys: [] }, unseated: new Set([id.agent]) });
  t.after(fake.close);
  const answer = await callOnce(envFor(id, fake.url));
  assert.deepEqual([answer.ok, answer.kind, answer.code], [false, "auth", "agent_unseated"]);
});

test("retries transient 503 on idempotent protocol reads (initialize / tools/list) during deploy cutovers, never tools/call", async (t) => {
  const id = identity();
  const fake = await startFakeMcp({ linked: new Set([id.owner]) });
  t.after(fake.close);
  let hits = 0;
  let callHits = 0;
  const fetchFn = async (url, init) => {
    hits++;
    const body = JSON.parse(Buffer.from(init.body).toString("utf8"));
    if (body.method === "initialize" && hits === 1) {
      return new Response("deploying", { status: 503, headers: { "content-type": "text/plain" } });
    }
    if (body.method === "tools/call") {
      callHits++;
      return new Response("deploying", { status: 503, headers: { "content-type": "text/plain" } });
    }
    return fetch(url, init);
  };
  const out = [];
  const conn = createConnector({ env: envFor(id, fake.url), write: (m) => out.push(m), fetchFn });
  await conn.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  await conn.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await conn.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "whoami", arguments: {} } });
  const listed = out.find((m) => m.id === 2);
  assert.ok(listed?.result?.tools?.some((tool) => tool.name === "whoami"), "initialize retried past 503 and tools/list succeeded");
  const called = out.find((m) => m.id === 3);
  assert.equal(called?.result?.isError, true, "tools/call surfaces 503 without retrying");
  assert.equal(callHits, 1, "tools/call must never retry on 503");
  assert.ok(hits >= 4, `expected retried initialize + tools/list + single tools/call, saw ${hits}`);
});
