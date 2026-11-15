#!/usr/bin/env node
// The hardware door: a public HTTPS way into agentctl for teammates whose Buzz
// has no SSH key and no tailnet. Tailscale Funnel terminates TLS on the
// machine's ts.net name and forwards to this server on 127.0.0.1.
//
//   POST /agentctl   Authorization: Black4-Hardware <pass>
//                    body: the JSON request agentctl reads on stdin (64 KiB max)
//   GET  /health     {ok: true, machine}
//
// A pass is a compact JWS (ES256, typ black4-hardware+jwt) that Platform Control
// (api.black4.ai) signs for one request: it names this machine (aud), the staff
// member (email), the op, and the SHA-256 of the exact body, and lives 60 s.
// Each pass works once (its jti is remembered past its expiry, across
// restarts). No reusable secret is ever kept here: every agent on this machine
// runs with full access as the same OS user and could read it.
//
// A request that passes every check runs `agentctl --caller <email>` with the
// body on stdin, so agentctl records the email as the creator and lets the
// caller change only agents it created. agentctl's reply is returned as is.
//
// Runs from <root>/bin/door.mjs with the pinned Node; cron starts it at boot
// and every minute (setup.sh writes the lines). Binding the port is the lock:
// a second copy exits at once. It exits when this file is replaced, and cron
// starts the new one within a minute. No npm dependencies.
//
// Ports: 8410 for ~/workforce, 8411 for any other root (a dev runner beside
// it); <root>/door.json {"port": n} overrides. Only a root other than
// ~/workforce may also set {"jwksUrl": "..."} (http, https or file), to test
// with a fixture key before or beside Platform Control's real keys.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ISSUER = "https://api.black4.ai";
export const JWKS_URL = "https://api.black4.ai/.well-known/black4-hardware-keys";
export const TYP = "black4-hardware+jwt";
export const MAX_BODY = 64 * 1024;
export const SKEW = 30;               // seconds of clock skew allowed either way
export const LIFETIME = 60;           // a pass lives at most this long
export const KEYS_TTL = 300;          // the JWKS is refetched after this long
export const KEYS_MISS_EVERY = 60;    // an unknown kid refetches at most this often
export const AGENTCTL_TIMEOUT = 120;  // login.finish alone may wait 85 s
export const MAX_IN_FLIGHT = 16;
export const LOG_CAP = 1 << 20;
// The same shape agentctl accepts for an email caller (machine/agentctl).
export const EMAIL = /^(?=.{3,254}$)[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const JTI = /^[A-Za-z0-9_-]{16,64}$/;

/** A pass problem: 401 with this message, which never contains the pass. */
export class PassError extends Error {
  constructor(message, status = 401) { super(message); this.status = status; }
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");
export const bodyDigest = (bytes) => b64url(crypto.createHash("sha256").update(bytes).digest());

function decodeJson(segment, what) {
  if (!B64URL.test(segment)) throw new PassError(`the pass ${what} is not base64url`);
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  throw new PassError(`the pass ${what} is not a JSON object`);
}

/** A public key from one JWKS entry, or null for anything but an EC P-256
 * signing key. */
export function keyFromJwk(jwk) {
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.kid !== "string") return null;
  if (jwk.use !== undefined && jwk.use !== "sig") return null;
  if (jwk.alg !== undefined && jwk.alg !== "ES256") return null;
  if (jwk.d !== undefined) return null; // a private key was published by mistake; refuse it
  try { return crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" }); } catch { return null; }
}

/** Platform Control's signing keys, cached KEYS_TTL seconds. An unknown kid
 * refetches at most once a KEYS_MISS_EVERY seconds. When they cannot be
 * fetched the door fails closed (503). `load()` returns the JWKS object. */
export function keyRing(load, { now = () => Date.now() / 1000 } = {}) {
  let keys = null, fetchedAt = -Infinity, missAt = -Infinity, pending = null;
  const refresh = () => (pending ??= (async () => {
    try {
      const jwks = await load();
      const next = new Map();
      for (const jwk of Array.isArray(jwks?.keys) ? jwks.keys : []) {
        const key = keyFromJwk(jwk);
        if (key) next.set(jwk.kid, key);
      }
      keys = next;
      fetchedAt = now();
    } finally { pending = null; }
  })());
  return {
    async get(kid) {
      try {
        if (!keys || now() - fetchedAt >= KEYS_TTL) await refresh();
        if (!keys.has(kid) && now() - missAt >= KEYS_MISS_EVERY) { missAt = now(); await refresh(); }
      } catch (e) {
        throw new PassError(`this machine cannot fetch the pass keys right now (${String(e.message || e).slice(0, 120)})`, 503);
      }
      return keys.get(kid) || null;
    },
  };
}

/** Fetches a JWKS from http(s) or, for a dev fixture, a file: URL. */
export function jwksLoader(url) {
  if (url.startsWith("file:")) return async () => JSON.parse(fs.readFileSync(fileURLToPath(url), "utf8"));
  return async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`keys answered ${res.status}`);
    return res.json();
  };
}

/** Single-use passes: each accepted jti is remembered until its exp plus the
 * skew, in a private file so a restart does not forget it. */
export function replayStore(file, { now = () => Date.now() / 1000 } = {}) {
  let seen = new Map();
  try {
    for (const [jti, until] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8")))) {
      if (typeof until === "number") seen.set(jti, until);
    }
  } catch {}
  const prune = () => { const t = now(); for (const [jti, until] of seen) if (until < t) seen.delete(jti); };
  return {
    has(jti) { prune(); return seen.has(jti); },
    /** Remembers jti until `until`, on disk before it returns. */
    add(jti, until) {
      prune();
      seen.set(jti, until);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(seen)), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

/** Checks the Authorization header and body against the contract, in order,
 * and returns the pass claims. Throws PassError. Records the jti. */
export async function checkPass({ authorization, body, machine, keys, replay, now = () => Date.now() / 1000 }) {
  const m = /^Black4-Hardware ([^\s]+)$/.exec(authorization || "");
  if (!m) throw new PassError("no pass: send Authorization: Black4-Hardware <pass>");
  const parts = m[1].split(".");
  if (parts.length !== 3) throw new PassError("the pass is not a compact JWS");
  const header = decodeJson(parts[0], "header");
  if (header.alg !== "ES256") throw new PassError("the pass must be signed with ES256");
  if (header.typ !== TYP) throw new PassError(`the pass type must be ${TYP}`);
  if (typeof header.kid !== "string" || !header.kid) throw new PassError("the pass names no key (kid)");
  if (!B64URL.test(parts[2])) throw new PassError("the pass signature is not base64url");
  const signature = Buffer.from(parts[2], "base64url");
  const key = await keys.get(header.kid);
  if (!key) throw new PassError("the pass is signed with a key this machine does not know");
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`, "ascii");
  if (signature.length !== 64 || !crypto.verify("sha256", signed, { key, dsaEncoding: "ieee-p1363" }, signature)) {
    throw new PassError("the pass signature is not valid");
  }
  const claims = decodeJson(parts[1], "payload");
  if (claims.iss !== ISSUER) throw new PassError("the pass was not issued by Platform Control");
  if (claims.aud !== `black4-hardware:${machine}`) throw new PassError(`the pass is for another machine (this is ${machine})`);
  const t = now();
  const { iat, exp } = claims;
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) throw new PassError("the pass has no valid iat and exp");
  if (exp <= iat || exp - iat > LIFETIME) throw new PassError(`the pass must live at most ${LIFETIME} seconds`);
  if (iat > t + SKEW) throw new PassError("the pass is not valid yet (check the clock)");
  if (exp < t - SKEW) throw new PassError("the pass has expired");
  if (typeof claims.email !== "string" || !EMAIL.test(claims.email)) throw new PassError("the pass has no valid lowercase email");
  if (typeof claims.sub !== "string" || !claims.sub) throw new PassError("the pass has no subject");
  if (claims.owner !== null && !(typeof claims.owner === "string" && HEX64.test(claims.owner))) {
    throw new PassError("the pass owner must be a 64-hex key or null");
  }
  if (typeof claims.jti !== "string" || !JTI.test(claims.jti)) throw new PassError("the pass has no valid jti");
  if (replay.has(claims.jti)) throw new PassError("the pass was already used");
  replay.add(claims.jti, exp + SKEW);
  let request;
  try { request = JSON.parse(body.toString("utf8")); } catch {}
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new PassError("the body is not a JSON object", 400);
  if (typeof claims.op !== "string" || claims.op !== request.op) throw new PassError("the pass is for another op than the body");
  if (claims.body !== bodyDigest(body)) throw new PassError("the body is not the one the pass was signed for");
  if (request.op === "activate" && claims.owner !== null) {
    const auth = request.auth;
    if (!Array.isArray(auth) || auth[1] !== claims.owner) {
      throw new PassError("the agent's owner attestation is not for the owner linked to this pass");
    }
  }
  return claims;
}

/** Runs agentctl as `caller` with `body` on stdin; resolves its JSON reply text. */
export function agentctlRunner({ python = "/usr/bin/python3", agentctl, env = {}, timeout = AGENTCTL_TIMEOUT }) {
  return (caller, body) => new Promise((resolve, reject) => {
    if (!EMAIL.test(caller)) return reject(new Error("caller is not an email"));
    // The environment cron gives agentctl, so agents started from here match
    // the ones the supervisor starts.
    const me = os.userInfo();
    const child = spawn(python, [agentctl, "--caller", caller], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: os.homedir(), USER: me.username, LOGNAME: me.username, SHELL: me.shell || "/bin/sh", ...env },
    });
    let out = "", settled = false;
    const settle = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    child.stdout.setEncoding("utf8").on("data", (s) => { if (out.length < 4 << 20) out += s; });
    // Settle on its own: a child agentctl leaves running (an agent, a sign-in
    // helper) may hold stdout open long after agentctl itself has exited.
    const timer = setTimeout(() => { child.kill("SIGKILL"); settle(reject, new Error(`agentctl took over ${timeout} s`)); }, timeout * 1000);
    child.on("error", (e) => settle(reject, e));
    const finish = (code, signal) => {
      const line = out.trim().split("\n").pop() || "";
      try {
        const reply = JSON.parse(line);
        if (reply && typeof reply === "object") return settle(resolve, JSON.stringify(reply));
      } catch {}
      settle(reject, new Error(signal ? `agentctl was stopped (${signal})` : `agentctl gave no JSON reply (exit ${code})`));
    };
    child.on("close", finish);
    // After exit, give stdout a moment to drain, then answer with what came.
    child.on("exit", (code, signal) => setTimeout(() => { child.stdout.destroy(); finish(code, signal); }, 200));
    child.stdin.on("error", () => {});
    child.stdin.end(body);
  });
}

/** The HTTP handler. Everything outside is injected so tests run it in-process. */
export function createDoor({ machine, keys, replay, run, now = () => Date.now() / 1000, log = () => {} }) {
  let inFlight = 0;
  const send = (res, status, value) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };
  const handler = async (req, res) => {
    let pathname;
    try { pathname = new URL(req.url, "http://door").pathname; } catch { pathname = ""; }
    if (pathname === "/health") {
      if (req.method !== "GET") return send(res, 405, { error: "use GET" });
      return send(res, 200, { ok: true, machine });
    }
    if (pathname !== "/agentctl") return send(res, 404, { error: "not found" });
    if (req.method !== "POST") return send(res, 405, { error: "use POST" });
    if (!req.headers.authorization) {
      req.resume();
      return send(res, 401, { error: "no pass: send Authorization: Black4-Hardware <pass>" });
    }
    if (Number(req.headers["content-length"] || 0) > MAX_BODY) {
      res.setHeader("connection", "close");
      req.resume();
      return send(res, 413, { error: `the body is over ${MAX_BODY} bytes` });
    }
    // Before the pass is checked, so a busy machine does not spend its jti.
    if (inFlight >= MAX_IN_FLIGHT) { req.resume(); return send(res, 503, { error: "this machine is busy; try again" }); }
    inFlight++;
    try { await admitted(req, res); } finally { inFlight--; }
  };
  const admitted = async (req, res) => {
    const body = await new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) { req.pause(); req.removeAllListeners("data"); resolve(null); } else chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", () => resolve(undefined));
    });
    if (body === undefined) return;
    if (body === null) {
      res.setHeader("connection", "close");
      send(res, 413, { error: `the body is over ${MAX_BODY} bytes` });
      res.on("finish", () => req.socket.destroy());
      return;
    }
    let claims;
    try {
      claims = await checkPass({ authorization: req.headers.authorization, body, machine, keys, replay, now });
    } catch (e) {
      if (!(e instanceof PassError)) { log(`check failed: ${e.stack || e}`); return send(res, 500, { error: "the door failed" }); }
      log(`refused ${e.status}: ${e.message}`);
      return send(res, e.status, { error: e.message });
    }
    const started = Date.now();
    try {
      const reply = await run(claims.email, body);
      log(`ran ${claims.op} for ${claims.email} (jti ${claims.jti.slice(0, 6)}…) in ${Date.now() - started} ms`);
      send(res, 200, reply);
    } catch (e) {
      log(`agentctl ${claims.op} for ${claims.email} failed: ${e.message}`);
      send(res, 502, { error: `agentctl failed: ${e.message}` });
    }
  };
  return Object.assign(handler, { inFlight: () => inFlight });
}

/** Tightened server timeouts: a public port should not hold slow clients. */
export function listen(handler, { port, host = "127.0.0.1" }) {
  const server = http.createServer(handler);
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;   // receiving the request; agentctl's run is not counted
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(server); });
  });
}

function fileLog(file) {
  return (line) => {
    try {
      if (fs.statSync(file).size > LOG_CAP) fs.renameSync(file, `${file}.1`);
    } catch {}
    try { fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); } catch {}
  };
}

export async function main() {
  const self = fs.realpathSync(fileURLToPath(import.meta.url));
  const root = path.dirname(path.dirname(self));
  const home = os.homedir();
  const released = root === path.join(home, "workforce");
  const run = path.join(root, "run");
  fs.mkdirSync(run, { recursive: true, mode: 0o700 });
  const log = fileLog(path.join(run, "door.log"));
  const fail = (message) => { log(message); console.error(message); process.exit(1); };

  let machine;
  try { machine = JSON.parse(fs.readFileSync(path.join(root, "machine.json"), "utf8")).name; } catch {}
  if (typeof machine !== "string" || !/^[A-Za-z0-9._-]+$/.test(machine)) fail(`no machine name in ${root}/machine.json; run machine/deploy.sh with one`);
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(root, "door.json"), "utf8")); } catch (e) { if (e.code !== "ENOENT") fail(`door.json is not JSON: ${e.message}`); }
  if (config.jwksUrl && released) fail("door.json may not change the pass keys in ~/workforce; only a dev runner may");
  const jwksUrl = config.jwksUrl || JWKS_URL;
  if (!/^(https:|file:|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(jwksUrl)) fail(`jwksUrl must be https, file, or local http: ${jwksUrl}`);
  const port = Number.isInteger(config.port) ? config.port : released ? 8410 : 8411;

  const handler = createDoor({
    machine,
    keys: keyRing(jwksLoader(jwksUrl)),
    replay: replayStore(path.join(run, "door-jti.json")),
    run: agentctlRunner({ agentctl: path.join(root, "bin", "agentctl"), env: released ? {} : { BLACK4_WORKFORCE_ROOT: root } }),
    log,
  });
  let server;
  try { server = await listen(handler, { port }); } catch (e) {
    if (e.code === "EADDRINUSE") process.exit(0); // another copy holds the port
    fail(`cannot listen on 127.0.0.1:${port}: ${e.message}`);
  }
  log(`door ${process.pid} up on 127.0.0.1:${port} for ${machine}, keys ${jwksUrl === JWKS_URL ? "Platform Control" : jwksUrl}`);
  const born = fs.statSync(self).mtimeMs;
  const watch = setInterval(() => {
    let changed = true;
    try { changed = fs.statSync(self).mtimeMs !== born; } catch {}
    if (!changed) return;
    clearInterval(watch);
    log("door.mjs changed; exiting for cron to restart");
    server.close();
    const quit = () => (handler.inFlight() ? setTimeout(quit, 500) : process.exit(0));
    quit();
  }, 5000);
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { log(`door ${process.pid} stopping (${sig})`); process.exit(0); });
}

const entry = process.argv[1] && (() => { try { return fs.realpathSync(process.argv[1]); } catch { return ""; } })();
if (entry && entry === fs.realpathSync(fileURLToPath(import.meta.url))) main();
