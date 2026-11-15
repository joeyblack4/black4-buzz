// The hardware door (machine/door.mjs) against fixture keys made at run time:
// every pass check in the contract, the body cap, paths and methods, replay
// across a restart, and one real agentctl run in a temporary home.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDoor, listen, keyRing, replayStore, agentctlRunner, bodyDigest, MAX_BODY, ISSUER, TYP,
} from "../machine/door.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const AGENTCTL = path.join(here, "..", "machine", "agentctl");
const OWNER = "a".repeat(64);
const b64 = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

const signing = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const stranger = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwkOf = (pair, kid) => ({ ...pair.publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "ES256" });

function sign(header, claims, key = signing.privateKey) {
  const input = `${b64(header)}.${b64(claims)}`;
  const sig = crypto.sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${sig.toString("base64url")}`;
}

let clock = 1_800_000_000;
const now = () => clock;

function pass(body, { header = {}, claims = {}, key } = {}) {
  const request = JSON.parse(body);
  return sign({ alg: "ES256", typ: TYP, kid: "pc-1", ...header }, {
    iss: ISSUER, aud: "black4-hardware:commerce", sub: "user_01", email: "annabelle@black4.ai", owner: null,
    op: request.op, body: bodyDigest(Buffer.from(body)), iat: clock, exp: clock + 60,
    jti: crypto.randomBytes(16).toString("base64url"), ...claims,
  }, key);
}

/** A door on an ephemeral port with a fake agentctl that echoes what it got. */
async function door(t, { jwks = { keys: [jwkOf(signing, "pc-1")] }, run, replayFile } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "door-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const loads = { n: 0 };
  const handler = createDoor({
    machine: "commerce",
    keys: keyRing(async () => { loads.n++; if (jwks instanceof Error) throw jwks; return typeof jwks === "function" ? jwks() : jwks; }, { now }),
    replay: replayStore(replayFile || path.join(dir, "jti.json"), { now }),
    run: run || (async (caller, body) => { calls.push({ caller, request: JSON.parse(body) }); return JSON.stringify({ ok: true, agents: [] }); }),
    now,
  });
  const server = await listen(handler, { port: 0 });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (body, authorization, extra = {}) => {
    const res = await fetch(`${url}/agentctl`, {
      method: "POST", body, headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}), ...extra },
    });
    return { status: res.status, json: await res.json() };
  };
  return { url, post, calls, loads, dir };
}

const LIST = JSON.stringify({ op: "list" });
const auth = (token) => `Black4-Hardware ${token}`;

test("a valid pass runs agentctl as the pass email with the exact body", async (t) => {
  const d = await door(t);
  const r = await d.post(LIST, auth(pass(LIST)));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, agents: [] });
  assert.deepEqual(d.calls, [{ caller: "annabelle@black4.ai", request: { op: "list" } }]);
});

test("health answers without a pass; other paths are 404 and other methods 405", async (t) => {
  const d = await door(t);
  const health = await fetch(`${d.url}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, machine: "commerce" });
  assert.equal((await fetch(`${d.url}/`)).status, 404);
  assert.equal((await fetch(`${d.url}/agentctl/x`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${d.url}/etc/passwd`)).status, 404);
  assert.equal((await fetch(`${d.url}/agentctl`)).status, 405);
  assert.equal((await fetch(`${d.url}/agentctl`, { method: "PUT", body: LIST })).status, 405);
  assert.equal((await fetch(`${d.url}/health`, { method: "POST" })).status, 405);
  assert.equal(d.calls.length, 0);
});

test("no pass, or another scheme, is 401", async (t) => {
  const d = await door(t);
  assert.equal((await d.post(LIST)).status, 401);
  const bearer = await d.post(LIST, `Bearer ${pass(LIST)}`);
  assert.equal(bearer.status, 401);
  assert.match(bearer.json.error, /no pass/);
  assert.equal((await d.post(LIST, "Black4-Hardware not-a-jws")).status, 401);
  assert.equal(d.calls.length, 0);
});

test("a forged signature is refused, and the error never echoes the pass", async (t) => {
  const d = await door(t);
  const forged = pass(LIST, { key: stranger.privateKey });
  const r = await d.post(LIST, auth(forged));
  assert.equal(r.status, 401);
  assert.match(r.json.error, /signature is not valid/);
  assert.ok(!JSON.stringify(r.json).includes(forged.split(".")[2]));
  // Claims changed after signing: the signature no longer covers them.
  const [h, , s] = pass(LIST).split(".");
  const swapped = `${h}.${b64({ iss: ISSUER, aud: "black4-hardware:commerce", email: "joey@black4.ai" })}.${s}`;
  assert.match((await d.post(LIST, auth(swapped))).json.error, /signature is not valid/);
  // A DER signature (Node's default) is not a JWS signature.
  const input = pass(LIST).split(".").slice(0, 2).join(".");
  const der = crypto.sign("sha256", Buffer.from(input), signing.privateKey).toString("base64url");
  assert.match((await d.post(LIST, auth(`${input}.${der}`))).json.error, /signature is not valid/);
  assert.equal(d.calls.length, 0);
});

test("alg confusion: none, HS256 and RS256 are refused before any key is used", async (t) => {
  const d = await door(t);
  const claims = JSON.parse(Buffer.from(pass(LIST).split(".")[1], "base64url"));
  const none = `${b64({ alg: "none", typ: TYP, kid: "pc-1" })}.${b64(claims)}.`;
  assert.match((await d.post(LIST, auth(none))).json.error, /ES256/);
  // HS256 keyed with the public key's own bytes: the classic confusion.
  const pem = signing.publicKey.export({ format: "pem", type: "spki" });
  const input = `${b64({ alg: "HS256", typ: TYP, kid: "pc-1" })}.${b64(claims)}`;
  const mac = crypto.createHmac("sha256", pem).update(input).digest("base64url");
  const r = await d.post(LIST, auth(`${input}.${mac}`));
  assert.equal(r.status, 401);
  assert.match(r.json.error, /ES256/);
  const rs = `${b64({ alg: "RS256", typ: TYP, kid: "pc-1" })}.${b64(claims)}.${"A".repeat(342)}`;
  assert.match((await d.post(LIST, auth(rs))).json.error, /ES256/);
  assert.match((await d.post(LIST, auth(pass(LIST, { header: { typ: "JWT" } })))).json.error, /type/);
  assert.equal(d.calls.length, 0);
});

test("only EC P-256 keys from the JWKS are trusted", async (t) => {
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const p384 = crypto.generateKeyPairSync("ec", { namedCurve: "P-384" });
  const d = await door(t, { jwks: { keys: [
    { ...rsa.publicKey.export({ format: "jwk" }), kid: "pc-1" },
    { ...p384.publicKey.export({ format: "jwk" }), kid: "pc-2" },
    { ...jwkOf(signing, "pc-3"), alg: "HS256" },
  ] } });
  for (const kid of ["pc-1", "pc-2", "pc-3"]) {
    const r = await d.post(LIST, auth(pass(LIST, { header: { kid } })));
    assert.equal(r.status, 401, kid);
    assert.match(r.json.error, /does not know/, kid);
  }
});

test("wrong issuer or another machine's audience is refused", async (t) => {
  const d = await door(t);
  assert.match((await d.post(LIST, auth(pass(LIST, { claims: { iss: "https://evil.example" } })))).json.error, /Platform Control/);
  const other = await d.post(LIST, auth(pass(LIST, { claims: { aud: "black4-hardware:studio" } })));
  assert.equal(other.status, 401);
  assert.match(other.json.error, /another machine/);
  assert.equal((await d.post(LIST, auth(pass(LIST, { claims: { aud: ["black4-hardware:commerce"] } })))).status, 401);
  assert.equal(d.calls.length, 0);
});

test("expired, not yet valid, or too long-lived passes are refused; 30 s of skew is allowed", async (t) => {
  const d = await door(t);
  const at = (iat, exp = iat + 60) => pass(LIST, { claims: { iat, exp } });
  assert.match((await d.post(LIST, auth(at(clock - 91)))).json.error, /expired/);
  assert.match((await d.post(LIST, auth(at(clock + 31)))).json.error, /not valid yet/);
  assert.match((await d.post(LIST, auth(at(clock, clock + 3600)))).json.error, /at most 60/);
  assert.match((await d.post(LIST, auth(at(clock, clock)))).json.error, /at most 60/);
  assert.match((await d.post(LIST, auth(pass(LIST, { claims: { exp: "soon" } })))).json.error, /iat and exp/);
  assert.equal(d.calls.length, 0);
  assert.equal((await d.post(LIST, auth(at(clock - 85)))).status, 200, "expired 25 s ago: within skew");
  assert.equal((await d.post(LIST, auth(at(clock + 25)))).status, 200, "issued 25 s ahead: within skew");
});

test("a pass works once, and still only once after a restart", async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "door-jti-")), "jti.json");
  const token = pass(LIST);
  const first = await door(t, { replayFile: file });
  assert.equal((await first.post(LIST, auth(token))).status, 200);
  const again = await first.post(LIST, auth(token));
  assert.equal(again.status, 401);
  assert.match(again.json.error, /already used/);
  const restarted = await door(t, { replayFile: file });
  assert.match((await restarted.post(LIST, auth(token))).json.error, /already used/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // Forgotten only once it could no longer pass the time check anyway.
  const saved = clock;
  clock += 120;
  t.after(() => { clock = saved; });
  const store = replayStore(file, { now });
  assert.equal(store.has(JSON.parse(Buffer.from(token.split(".")[1], "base64url")).jti), false);
});

test("a refused signature does not use up the jti", async (t) => {
  const d = await door(t);
  const jti = crypto.randomBytes(16).toString("base64url");
  await d.post(LIST, auth(pass(LIST, { claims: { jti }, key: stranger.privateKey })));
  assert.equal((await d.post(LIST, auth(pass(LIST, { claims: { jti } })))).status, 200);
});

test("the op in the pass must be the body's op", async (t) => {
  const d = await door(t);
  const remove = JSON.stringify({ op: "remove", pubkey: OWNER });
  const r = await d.post(remove, auth(pass(remove, { claims: { op: "list" } })));
  assert.equal(r.status, 401);
  assert.match(r.json.error, /another op/);
  assert.equal(d.calls.length, 0);
});

test("a body changed after signing is refused", async (t) => {
  const d = await door(t);
  const token = pass(JSON.stringify({ op: "status", pubkey: OWNER }));
  const tampered = JSON.stringify({ op: "status", pubkey: "b".repeat(64) });
  const r = await d.post(tampered, auth(token));
  assert.equal(r.status, 401);
  assert.match(r.json.error, /not the one the pass was signed for/);
  // Same JSON, different bytes (whitespace) is still a different body.
  const spaced = `${LIST} `;
  assert.equal((await d.post(spaced, auth(pass(LIST)))).status, 401);
  assert.equal(d.calls.length, 0);
});

test("a body that is not a JSON object is 400", async (t) => {
  const d = await door(t);
  const token = pass(LIST, { claims: { body: bodyDigest(Buffer.from("[]")) } });
  assert.equal((await d.post("[]", auth(token))).status, 400);
});

test("a body over 64 KiB is 413, by header or by what actually arrives", async (t) => {
  const d = await door(t);
  const big = JSON.stringify({ op: "instructions.set", pubkey: OWNER, instructions: "x".repeat(MAX_BODY) });
  const r = await d.post(big, auth(pass(big)));
  assert.equal(r.status, 413);
  // Chunked, with no Content-Length to go by.
  const stream = new ReadableStream({
    start(c) { for (let i = 0; i < 80; i++) c.enqueue(new TextEncoder().encode("x".repeat(1024))); c.close(); },
  });
  const res = await fetch(`${d.url}/agentctl`, { method: "POST", body: stream, duplex: "half", headers: { authorization: auth(pass(LIST)) } });
  assert.equal(res.status, 413);
  const exact = JSON.stringify({ op: "list", pad: "x".repeat(MAX_BODY - 22) });
  assert.equal(Buffer.byteLength(exact), MAX_BODY);
  assert.equal((await d.post(exact, auth(pass(exact)))).status, 200, "exactly 64 KiB is allowed");
  assert.equal(d.calls.length, 1);
});

test("activate with a linked owner needs the attestation for that owner", async (t) => {
  const d = await door(t);
  const activate = (owner) => JSON.stringify({ op: "activate", pubkey: "c".repeat(64), auth: ["auth", owner, "", "d".repeat(128)] });
  const wrong = activate("e".repeat(64));
  const r = await d.post(wrong, auth(pass(wrong, { claims: { owner: OWNER } })));
  assert.equal(r.status, 401);
  assert.match(r.json.error, /owner attestation/);
  const right = activate(OWNER);
  assert.equal((await d.post(right, auth(pass(right, { claims: { owner: OWNER } })))).status, 200);
  // No linked owner yet: the attestation is agentctl's to check, as today.
  assert.equal((await d.post(wrong, auth(pass(wrong)))).status, 200);
  assert.equal(d.calls.length, 2);
});

test("a pass without a valid lowercase email or owner is refused", async (t) => {
  const d = await door(t);
  for (const email of ["Annabelle@black4.ai", "annabelle", "a b@black4.ai", "x;rm -rf ~@black4.ai", 42]) {
    assert.equal((await d.post(LIST, auth(pass(LIST, { claims: { email } })))).status, 401, String(email));
  }
  assert.equal((await d.post(LIST, auth(pass(LIST, { claims: { owner: "ZZ" } })))).status, 401);
  assert.equal(d.calls.length, 0);
});

test("keys: cached five minutes, an unknown kid refetches at most once a minute, unreachable fails closed", async (t) => {
  const rotated = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  let published = [jwkOf(signing, "pc-1")];
  const d = await door(t, { jwks: () => ({ keys: published }) });
  assert.equal((await d.post(LIST, auth(pass(LIST)))).status, 200);
  assert.equal((await d.post(LIST, auth(pass(LIST)))).status, 200);
  assert.equal(d.loads.n, 1, "cached");
  // An unknown kid refetches once, then not again within the minute.
  assert.equal((await d.post(LIST, auth(pass(LIST, { header: { kid: "pc-2" }, key: rotated.privateKey })))).status, 401);
  assert.equal(d.loads.n, 2);
  published = [jwkOf(signing, "pc-1"), jwkOf(rotated, "pc-2")];
  assert.equal((await d.post(LIST, auth(pass(LIST, { header: { kid: "pc-2" }, key: rotated.privateKey })))).status, 401);
  assert.equal(d.loads.n, 2, "rate limited");
  const saved = clock;
  t.after(() => { clock = saved; });
  clock += 61;
  assert.equal((await d.post(LIST, auth(pass(LIST, { header: { kid: "pc-2" }, key: rotated.privateKey })))).status, 200);
  assert.equal(d.loads.n, 3);
  clock += 300;
  published = [jwkOf(rotated, "pc-2")];
  assert.equal((await d.post(LIST, auth(pass(LIST)))).status, 401, "pc-1 withdrawn after the cache expires");
});

test("keys that cannot be fetched are 503, never an open door", async (t) => {
  const d = await door(t, { jwks: new Error("connect ECONNREFUSED") });
  const r = await d.post(LIST, auth(pass(LIST)));
  assert.equal(r.status, 503);
  assert.match(r.json.error, /cannot fetch the pass keys/);
  assert.equal(d.calls.length, 0);
});

test("agentctl that fails without a JSON reply is 502; its own refusals are 200", async (t) => {
  const broken = await door(t, { run: async () => { throw new Error("agentctl gave no JSON reply (exit 1)"); } });
  assert.equal((await broken.post(LIST, auth(pass(LIST)))).status, 502);
  const refusing = await door(t, { run: async () => JSON.stringify({ ok: false, error: "no such agent on this machine" }) });
  const r = await refusing.post(LIST, auth(pass(LIST)));
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
});

test("end to end: a fixture-signed list runs the real agentctl as the email caller", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "door-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const python = fs.existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3";
  const run = agentctlRunner({ python, agentctl: AGENTCTL, env: { AGENTCTL_HOME: home, AGENTCTL_NO_CRON: "1", PATH: process.env.PATH } });
  const d = await door(t, { run });
  const r = await d.post(LIST, auth(pass(LIST)));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, agents: [] });
  const provision = JSON.stringify({ op: "provision", name: "Door test", community: "wss://r.example.com" });
  const made = await d.post(provision, auth(pass(provision)));
  assert.equal(made.json.ok, true);
  const listed = await d.post(LIST, auth(pass(LIST)));
  assert.equal(listed.json.agents[0].createdBy, "annabelle@black4.ai");
  const remove = JSON.stringify({ op: "remove", pubkey: made.json.pubkey });
  const other = await d.post(remove, auth(pass(remove, { claims: { email: "sam@black4.ai" } })));
  assert.match(other.json.error, /belongs to annabelle@black4.ai/);
  assert.equal((await d.post(remove, auth(pass(remove)))).json.ok, true);
});

test("agentctl answers even when a child it leaves running holds its stdout", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "door-child-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, "agentctl");
  // Like start or login.start: a detached child inherits stdout and outlives agentctl.
  fs.writeFileSync(script, [
    "import json, subprocess, sys",
    "p = subprocess.Popen(['/bin/sleep', '30'], start_new_session=True)",
    "open(sys.argv[0] + '.pid', 'w').write(str(p.pid))",
    "print(json.dumps({'ok': True, 'caller': sys.argv[2]}))",
  ].join("\n"));
  t.after(() => { try { process.kill(Number(fs.readFileSync(`${script}.pid`, "utf8")), "SIGKILL"); } catch {} });
  const python = fs.existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3";
  const run = agentctlRunner({ python, agentctl: script, env: { PATH: process.env.PATH }, timeout: 10 });
  const started = Date.now();
  assert.equal(await run("annabelle@black4.ai", LIST), JSON.stringify({ ok: true, caller: "annabelle@black4.ai" }));
  assert.ok(Date.now() - started < 5000, "did not wait for the child");
  const hung = path.join(dir, "hung");
  fs.writeFileSync(hung, "import time\ntime.sleep(30)\n");
  await assert.rejects(agentctlRunner({ python, agentctl: hung, env: { PATH: process.env.PATH }, timeout: 1 })("a@black4.ai", LIST), /took over 1 s/);
});

test("a busy machine answers 503 without spending the pass", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const d = await door(t, { run: async () => { await gate; return JSON.stringify({ ok: true }); } });
  const running = Array.from({ length: 16 }, () => d.post(LIST, auth(pass(LIST))));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const token = pass(LIST);
  const busy = await d.post(LIST, auth(token));
  assert.equal(busy.status, 503);
  release();
  await Promise.all(running);
  assert.equal((await d.post(LIST, auth(token))).status, 200, "the same pass works once there is room");
});
