// A local stand-in for the Black 4 MCP, for tests only. It verifies
// `Authorization: Nostr` exactly as the wire format says the real server does,
// so the connector is tested against real verification, not a stub:
//   - kind 27235, x-only pubkey, created_at within 60 s, content "";
//   - u = the MCP URL without query, method = POST, payload = SHA-256 of the
//     raw body bytes;
//   - id = SHA-256 of the NIP-01 serialization, BIP-340 signature over the id;
//   - each id is accepted once;
//   - exactly one NIP-OA auth tag whose owner signature verifies (the checks of
//     buzz-app src/features/agents/owner-attestation.ts: shape, clause syntax,
//     owner != agent, schnorr over sha256("nostr:agent-auth:<agent>:<conds>"),
//     created_at clauses honoured);
//   - the owner must be linked, else 401 like the real server's refusal.
// It then answers a tiny MCP: initialize, tools/list (?tools=core trims the
// list), tools/call of echo / slow / stream / boom.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { schnorr } from "@noble/curves/secp256k1.js";

const KEY = /^[0-9a-f]{64}$/;
const SIG = /^[0-9a-f]{128}$/;
const CLAUSE = /^(kind=|created_at<|created_at>)(0|[1-9][0-9]*)$/;
const sha256 = (data) => createHash("sha256").update(data).digest();

function validConditions(conditions) {
  return conditions === "" || conditions.split("&").every((clause) => {
    const [, name, digits] = CLAUSE.exec(clause) ?? [];
    if (!name || !digits) return false;
    return Number(digits) <= (name === "kind=" ? 65535 : 4294967295);
  });
}

function satisfied(conditions, event, ignoreKind = false) {
  if (!validConditions(conditions)) return false;
  if (conditions === "") return true;
  return conditions.split("&").every((clause) => {
    const [, name, digits] = CLAUSE.exec(clause);
    const value = Number(digits);
    if (name === "kind=") return ignoreKind || event.kind === value;
    return name === "created_at<" ? event.created_at < value : event.created_at > value;
  });
}

/** The owner a NIP-OA tag attests for `target`, or undefined. */
export function authTagOwner(target, tag) {
  const [name, owner, conditions, sig] = tag;
  if (name !== "auth" || tag.length !== 4 || !owner || conditions === undefined || !sig
      || !KEY.test(owner) || !SIG.test(sig) || owner === target || !validConditions(conditions)) return undefined;
  try {
    const digest = sha256(Buffer.from(`nostr:agent-auth:${target}:${conditions}`));
    return schnorr.verify(Buffer.from(sig, "hex"), digest, Buffer.from(owner, "hex")) ? owner : undefined;
  } catch { return undefined; }
}

/** Verify one request's header. Returns { agent, owner } or { error }. */
export function verifyRequest({ header, method, url, body, now = Date.now(), seen = new Set() }) {
  const m = /^Nostr ([A-Za-z0-9+/=]+)$/.exec(header ?? "");
  if (!m) return { error: "authentication_required" };
  let event;
  try { event = JSON.parse(Buffer.from(m[1], "base64").toString("utf8")); } catch { return { error: "bad_event" }; }
  const { id, pubkey, created_at, kind, tags, content, sig } = event ?? {};
  if (kind !== 27235 || !KEY.test(pubkey ?? "") || !Number.isInteger(created_at) || content !== ""
      || !Array.isArray(tags) || !tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === "string"))
      || !KEY.test(id ?? "") || !SIG.test(sig ?? "")) return { error: "bad_event" };
  if (Math.abs(Math.floor(now / 1000) - created_at) > 60) return { error: "stale_event" };
  const one = (name) => { const found = tags.filter((t) => t[0] === name); return found.length === 1 ? found[0] : undefined; };
  if (one("u")?.[1] !== url) return { error: "wrong_url" };
  if (one("method")?.[1] !== method) return { error: "wrong_method" };
  if (one("payload")?.[1] !== sha256(body).toString("hex")) return { error: "wrong_payload" };
  const expected = sha256(Buffer.from(JSON.stringify([0, pubkey, created_at, kind, tags, content]))).toString("hex");
  if (expected !== id) return { error: "wrong_id" };
  let good = false;
  try { good = schnorr.verify(Buffer.from(sig, "hex"), Buffer.from(id, "hex"), Buffer.from(pubkey, "hex")); } catch { /* bad */ }
  if (!good) return { error: "bad_signature" };
  if (seen.has(id)) return { error: "replayed_event" };
  seen.add(id);
  const auth = tags.filter((t) => t[0] === "auth");
  // Like withinTimeBounds in the reference: only created_at clauses apply to a request.
  if (auth.length !== 1 || !satisfied(auth[0][2] ?? "", { kind: -1, created_at }, true)) return { error: "no_owner_attestation" };
  const owner = authTagOwner(pubkey, auth[0]);
  if (!owner) return { error: "no_owner_attestation" };
  return { agent: pubkey, owner };
}

const ALL_TOOLS = [
  { name: "whoami", core: true },
  { name: "find_tools", core: true },
  { name: "call_tool", core: true },
  { name: "echo", core: true },
  { name: "slow", core: true },
  { name: "stream", core: true },
  { name: "boom", core: true },
  { name: "list_reviews", core: false },
].map(({ name, core }) => ({ name, core, description: name, inputSchema: { type: "object" } }));

/** Start the fake. `linked` is the set of owner pubkeys Black 4 knows.
 * `audience`, when given, is what get_buzz_audience answers (a function of
 * the verified { agent, owner }, or a value); without it the fake has no
 * such tool, like a server from before it. */
export async function startFakeMcp({ linked = new Set(), audience } = {}) {
  const seen = new Set();
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const full = new URL(req.url, `http://${req.headers.host}`);
    const signedUrl = `${full.origin}${full.pathname}`;
    const verdict = verifyRequest({ header: req.headers.authorization, method: req.method, url: signedUrl, body, seen });
    requests.push({ verdict, url: full.href, headers: req.headers, body: body.toString() });
    const json = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (verdict.error) return json(401, { error: verdict.error });
    if (!linked.has(verdict.owner)) return json(401, { error: "owner_not_linked", message: "This Buzz owner is not linked to a Black 4 account" });
    const msg = JSON.parse(body.toString());
    if (msg.id === undefined) { res.writeHead(202); return res.end(); }
    const reply = (result) => json(200, { jsonrpc: "2.0", id: msg.id, result });
    const core = full.searchParams.get("tools") === "core";
    switch (msg.method) {
      case "initialize":
        return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-black4", version: "0" } });
      case "tools/list":
        return reply({ tools: [...ALL_TOOLS, ...(audience ? [{ name: "get_buzz_audience", core: false, description: "audience", inputSchema: { type: "object" } }] : [])]
          .filter((t) => !core || t.core).map(({ core: _, ...t }) => t) });
      case "tools/call": {
        const { name, arguments: args = {} } = msg.params;
        if (name === "whoami") return reply({ content: [{ type: "text", text: JSON.stringify(verdict) }] });
        if (name === "echo") return reply({ content: [{ type: "text", text: JSON.stringify(args) }] });
        if (name === "slow") { setTimeout(() => reply({ content: [{ type: "text", text: "done" }] }), args.ms ?? 100); return; }
        if (name === "boom") return json(500, { error: "kaboom" });
        if (name === "get_buzz_audience" && audience) {
          const value = typeof audience === "function" ? audience(verdict) : audience;
          return reply(value?.isError ? value : { content: [{ type: "text", text: JSON.stringify(value) }] });
        }
        if (name === "stream") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 1, progress: 1 } })}\n\n`);
          res.write(": keep-alive\n\n");
          setTimeout(() => res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "streamed" }] } })}\n\n`), 20);
          return;
        }
        // What Platform Control answers for a tool it does not have (or does not offer this caller).
        return json(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Tool ${name} not found` } });
      }
      default:
        return json(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  return { url, requests, linked, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}
