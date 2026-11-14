#!/usr/bin/env node
// Black 4 MCP for an agent that runs on a Black 4 machine.
//
// buzz-acp starts this for the agent as its MCP server (stdio, one JSON-RPC
// message per line). Every message is forwarded to the Black 4 MCP over
// stateless Streamable HTTP, each POST signed by the agent's own Buzz key:
//
//   Authorization: Nostr <base64(JSON event)>
//   event = { kind: 27235, pubkey: <agent x-only key>, created_at: <now>,
//             tags: [["u", <MCP URL without query>], ["method", "POST"],
//                    ["payload", <hex SHA-256 of the exact body bytes>],
//                    <the agent's NIP-OA auth tag from BUZZ_AUTH_TAG>],
//             content: "", id, sig }        (NIP-01 id, BIP-340 signature)
//
// Black 4 maps the attestation's owner to a linked Black 4 account and acts as
// that person. Until the owner is linked (or while Black 4 cannot be reached)
// the agent still starts: it sees one `black4_status` tool and every Black 4
// call answers with a plain sentence. Nothing is retried on its own.
//
// Environment: BUZZ_PRIVATE_KEY (hex or nsec) and BUZZ_AUTH_TAG (JSON) from
// buzz-acp; BLACK4_MCP_URL (default https://api.black4.ai/mcp),
// BLACK4_MCP_TOOLS (default "core"; "" lists every tool), BLACK4_MCP_TIMEOUT_MS
// (default 15 minutes). Nothing is read from disk. The key, the attestation
// and the signed header are never logged.
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { schnorr } from "@noble/curves/secp256k1.js";

export { schnorr };

export const DEFAULT_URL = "https://api.black4.ai/mcp";
export const STATUS_TOOL = "black4_status";
const VERSION = "1.0.0";
const HEX64 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------- keys

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

/** The 32-byte secret of an `nsec1…` string (NIP-19, bech32 with checksum). */
export function decodeNsec(text) {
  const s = text.toLowerCase();
  const sep = s.lastIndexOf("1");
  if (s.slice(0, sep) !== "nsec" || s.length - sep < 7) throw new Error("not an nsec");
  const data = [...s.slice(sep + 1)].map((c) => {
    const v = BECH32.indexOf(c);
    if (v < 0) throw new Error("not an nsec");
    return v;
  });
  const hrp = [..."nsec"].map((c) => c.charCodeAt(0));
  const expanded = [...hrp.map((c) => c >> 5), 0, ...hrp.map((c) => c & 31), ...data];
  if (polymod(expanded) !== 1) throw new Error("nsec checksum is wrong");
  let acc = 0, bits = 0;
  const out = [];
  for (const v of data.slice(0, -6)) {
    acc = (acc << 5) | v; bits += 5;
    while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  if (out.length !== 32) throw new Error("not an nsec");
  return Uint8Array.from(out);
}

/** The agent's secret key from BUZZ_PRIVATE_KEY. buzz-acp hands MCP servers
 * the nsec form; the agent process itself has the hex form. */
export function secretKey(value) {
  const text = String(value ?? "").trim();
  const bytes = HEX64.test(text.toLowerCase())
    ? Uint8Array.from(Buffer.from(text.toLowerCase(), "hex"))
    : text.toLowerCase().startsWith("nsec1") ? decodeNsec(text) : null;
  if (!bytes) throw new Error("BUZZ_PRIVATE_KEY is not a hex or nsec key");
  schnorr.getPublicKey(bytes); // throws for 0 or >= n
  return bytes;
}

/** The NIP-OA tag from BUZZ_AUTH_TAG: ["auth", owner, conditions, signature]. */
export function parseAuthTag(text) {
  let tag;
  try { tag = JSON.parse(String(text ?? "")); } catch { tag = null; }
  if (!Array.isArray(tag) || tag.length !== 4 || tag[0] !== "auth" || !tag.every((v) => typeof v === "string")
      || !HEX64.test(tag[1]) || !/^[0-9a-f]{128}$/.test(tag[3])) {
    throw new Error("BUZZ_AUTH_TAG is not a NIP-OA auth tag");
  }
  return tag;
}

// ---------------------------------------------------------------- signing

export const sha256hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** NIP-01 event id: SHA-256 of [0, pubkey, created_at, kind, tags, content]. */
export function eventId(ev) {
  return sha256hex(Buffer.from(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content])));
}

/** The URL the `u` tag names: the MCP URL without its query (the `?tools=`
 * choice never changes authority, so it is not part of what is signed). */
export function signedUrl(url) {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

/** A fresh signed event and its Authorization header for one POST. */
export function signRequest({ secret, authTag, url, body, method = "POST", now = Date.now() }) {
  const pubkey = Buffer.from(schnorr.getPublicKey(secret)).toString("hex");
  const event = {
    pubkey,
    created_at: Math.floor(now / 1000),
    kind: 27235,
    tags: [["u", signedUrl(url)], ["method", method], ["payload", sha256hex(body)], [...authTag]],
    content: "",
  };
  event.id = eventId(event);
  event.sig = Buffer.from(schnorr.sign(Buffer.from(event.id, "hex"), secret)).toString("hex");
  return { event, header: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}` };
}

// ---------------------------------------------------------------- connector

function plain(text, max = 300) {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

/** The server's own words from an error reply, if it gave any. */
async function serverMessage(res) {
  let text = "";
  try { text = (await res.text()).slice(0, 4000); } catch { /* none */ }
  try {
    const body = JSON.parse(text);
    const pick = body?.error_description ?? body?.message ?? body?.error?.message ?? body?.error;
    if (typeof pick === "string" && pick.trim()) return plain(pick);
  } catch { /* not JSON */ }
  return plain(text);
}

export function createConnector({ env = process.env, write, fetchFn = fetch, log = () => {}, now = Date.now } = {}) {
  const base = env.BLACK4_MCP_URL || DEFAULT_URL;
  const tools = env.BLACK4_MCP_TOOLS ?? "core";
  const endpoint = new URL(base);
  if (tools && !endpoint.searchParams.has("tools")) endpoint.searchParams.set("tools", tools);
  const timeoutMs = Number(env.BLACK4_MCP_TIMEOUT_MS) > 0 ? Number(env.BLACK4_MCP_TIMEOUT_MS) : 15 * 60_000;
  // The status tool asks Black 4 again at most this often (tests shorten it).
  const recheckMs = Number(env.BLACK4_MCP_RECHECK_MS) >= 0 && env.BLACK4_MCP_RECHECK_MS ? Number(env.BLACK4_MCP_RECHECK_MS) : 30_000;

  let secret, authTag, setupProblem;
  try {
    secret = secretKey(env.BUZZ_PRIVATE_KEY);
    authTag = parseAuthTag(env.BUZZ_AUTH_TAG);
  } catch (error) {
    setupProblem = env.BUZZ_PRIVATE_KEY
      ? "This agent has no Buzz owner attestation, so it cannot use Black 4."
      : "This agent has no Buzz key, so it cannot use Black 4.";
    log(`not configured: ${error.message}`);
  }
  const owner = authTag?.[1];
  const ownerHint = owner ? ` (Buzz key ${owner})` : "";

  let protocolVersion;
  let sessionId;
  let unavailable = setupProblem; // the sentence a Black 4 call answers with, while it cannot work
  let lastCheck = 0;
  const inflight = new Map(); // request id -> AbortController
  const cancelled = new Set();

  function sentenceFor(result) {
    if (result.kind === "auth" && result.status === 401) {
      return `Black 4 does not recognise this agent's owner yet: the owner${ownerHint} must link their Buzz key to their Black 4 account before this agent can use Black 4 tools.${result.detail ? ` Black 4 said: ${result.detail}.` : ""}`;
    }
    if (result.kind === "auth") {
      return `Black 4 refused this agent's request${result.detail ? `: ${result.detail}` : ""}.`;
    }
    if (result.kind === "timeout") return `Black 4 did not answer within ${Math.round(timeoutMs / 60000) || 1} minutes.`;
    if (result.kind === "unreachable") return `Black 4 could not be reached (${result.detail}); try again later.`;
    return `Black 4 answered with an error (HTTP ${result.status}${result.detail ? `: ${result.detail}` : ""}).`;
  }

  /** POST one message. Messages in the reply are written straight through as
   * they arrive (SSE progress included); failures come back as a result. */
  async function post(message, { passThrough = true } = {}) {
    if (setupProblem) return { kind: "setup" };
    const body = Buffer.from(JSON.stringify(message));
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: signRequest({ secret, authTag, url: endpoint.href, body, now: now() }).header,
    };
    if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    const id = message.method && message.id !== undefined ? message.id : undefined;
    if (id !== undefined) inflight.set(id, controller);
    const collected = [];
    const emit = (m) => { if (passThrough) write(m); collected.push(m); };
    try {
      let res;
      try {
        res = await fetchFn(endpoint.href, { method: "POST", headers, body, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) return { kind: controller.signal.reason?.message === "timeout" ? "timeout" : "cancelled" };
        return { kind: "unreachable", detail: plain(error?.cause?.code || error?.message || "network error", 120) };
      }
      const sid = res.headers.get("mcp-session-id");
      if (sid) sessionId = sid;
      if (res.status === 401 || res.status === 403) {
        const detail = await serverMessage(res);
        log(`Black 4 answered HTTP ${res.status}`);
        return { kind: "auth", status: res.status, detail };
      }
      if (res.status === 202 || res.status === 204) return { kind: "ok", messages: collected };
      if (!res.ok) return { kind: "http", status: res.status, detail: await serverMessage(res) };
      const type = res.headers.get("content-type") || "";
      if (type.includes("text/event-stream")) await readEvents(res.body, emit);
      else {
        const text = await res.text();
        if (text.trim()) {
          const parsed = JSON.parse(text);
          for (const m of Array.isArray(parsed) ? parsed : [parsed]) emit(m);
        }
      }
      return { kind: "ok", messages: collected };
    } catch (error) {
      if (controller.signal.aborted) return { kind: controller.signal.reason?.message === "timeout" ? "timeout" : "cancelled" };
      return { kind: "unreachable", detail: plain(error?.message || "bad reply", 120) };
    } finally {
      clearTimeout(timer);
      if (id !== undefined) inflight.delete(id);
    }
  }

  const statusTool = () => ({
    name: STATUS_TOOL,
    description: "Black 4 is not available to this agent yet. Call this to see why, or to check again after the owner has linked their Buzz key to Black 4.",
    inputSchema: { type: "object", properties: {} },
  });
  const textResult = (text, isError) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

  /** The status tool: says why Black 4 is unavailable, or finds it works now. */
  async function checkStatus() {
    if (setupProblem) return textResult(setupProblem, true);
    if (unavailable && now() - lastCheck < recheckMs) return textResult(unavailable, true);
    lastCheck = now();
    const result = await post({ jsonrpc: "2.0", id: `${STATUS_TOOL}-${lastCheck}`, method: "tools/list", params: {} }, { passThrough: false });
    if (result.kind !== "ok" || result.messages.some((m) => m.error)) {
      if (result.kind !== "ok") unavailable = sentenceFor(result);
      return textResult(unavailable || "Black 4 did not list its tools.", true);
    }
    unavailable = undefined;
    write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    return textResult("Black 4 recognises this agent now. Its tools have been added to your tool list.");
  }

  /** Answer a request locally when Black 4 cannot take it. */
  function answerLocally(message, sentence) {
    const reply = (result) => write({ jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        protocolVersion = message.params?.protocolVersion || "2025-06-18";
        return reply({
          protocolVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "black4", version: VERSION },
          instructions: sentence,
        });
      case "ping": return reply({});
      case "tools/list": return reply({ tools: [statusTool()] });
      case "tools/call": return reply(textResult(sentence, true));
      default:
        return write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: sentence } });
    }
  }

  async function handle(message) {
    if (!message || typeof message !== "object") return;
    const isRequest = typeof message.method === "string" && message.id !== undefined;
    if (message.method === "notifications/cancelled") {
      const target = message.params?.requestId;
      if (inflight.has(target)) { cancelled.add(target); inflight.get(target).abort(new Error("cancelled")); }
    }
    if (isRequest && message.method === "tools/call" && message.params?.name === STATUS_TOOL) {
      return write({ jsonrpc: "2.0", id: message.id, result: await checkStatus() });
    }
    if (setupProblem) return isRequest ? answerLocally(message, setupProblem) : undefined;
    const result = await post(message);
    if (cancelled.delete(message.id)) return; // the client gave up on it: no reply
    if (result.kind === "ok") {
      if (message.method === "initialize") {
        const init = result.messages.find?.((m) => m.id === message.id);
        protocolVersion = init?.result?.protocolVersion || protocolVersion || message.params?.protocolVersion;
      }
      if (message.method === "tools/list" || message.method === "initialize") unavailable = undefined;
      return;
    }
    if (!isRequest) return;
    const sentence = sentenceFor(result);
    if (result.kind === "auth" || result.kind === "unreachable") { unavailable = sentence; lastCheck = now(); }
    if (message.method === "tools/call") return write({ jsonrpc: "2.0", id: message.id, result: textResult(sentence, true) });
    if (["initialize", "tools/list", "ping"].includes(message.method) && (result.kind === "auth" || result.kind === "unreachable")) {
      return answerLocally(message, sentence);
    }
    return write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: sentence } });
  }

  function close() { for (const c of inflight.values()) c.abort(new Error("cancelled")); }
  return { handle, close, endpoint: endpoint.href, owner };
}

/** Server-sent events: write each `data:` JSON message as it arrives. */
async function readEvents(stream, emit) {
  const decoder = new TextDecoder();
  let buffer = "";
  let data = [];
  const dispatch = () => {
    if (data.length) {
      const text = data.join("\n");
      data = [];
      if (text.trim()) {
        const parsed = JSON.parse(text);
        for (const m of Array.isArray(parsed) ? parsed : [parsed]) emit(m);
      }
    }
  };
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.search(/\r?\n|\r/)) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + (buffer.startsWith("\r\n", nl) ? 2 : 1));
      if (line === "") dispatch();
      else if (line.startsWith("data:")) data.push(line.slice(line[5] === " " ? 6 : 5));
    }
  }
  if (buffer.startsWith("data:")) data.push(buffer.slice(buffer[5] === " " ? 6 : 5));
  dispatch();
}

// ---------------------------------------------------------------- stdio

function main() {
  const log = (text) => process.stderr.write(`black4-agent-mcp: ${text}\n`);
  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const connector = createConnector({ write, log });
  log(`forwarding to ${connector.endpoint}${connector.owner ? ` for owner ${connector.owner.slice(0, 8)}` : ""}`);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch {
      return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    for (const m of Array.isArray(message) ? message : [message]) {
      connector.handle(m).catch((error) => {
        log(`internal error: ${plain(error?.message, 200)}`);
        if (m?.id !== undefined && m?.method) write({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "The Black 4 connector failed on this request." } });
      });
    }
  });
  lines.on("close", () => { connector.close(); setTimeout(() => process.exit(0), 200); });
}

function invokedDirectly() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}

if (invokedDirectly()) main();
