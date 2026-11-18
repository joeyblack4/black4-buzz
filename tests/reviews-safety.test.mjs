// People decide; agents never do. The review card's decision tools are never
// offered to agents, are refused by name (also through call_tool), and no
// decision token or preview grant ever reaches what an agent reads.
import assert from "node:assert/strict";
import test from "node:test";
import { fakeAuthKit, fakeMcp, https, freshPlugin, settle } from "./fakes.mjs";

const { appOnly, decides, agentText, APP_ONLY_TOOLS } = await freshPlugin();

const TOKEN = `b4rd_${"t".repeat(43)}`;
const GRANT = "https://review-content.example.test/v/grant-secret/hero.png";
const META = { "ai.black4/review-card": { decisionTokens: { hero: { token: TOKEN, version: 1, expiresAt: "2099-01-01T00:00:00Z" } }, previews: { hero: { url: GRANT, contentType: "image/png" } } } };
const review = { kind: "black4_review", businessId: "business-sample", assetId: "rv_sample", items: [] };

async function harness(t, { tools, answer } = {}) {
  const { apply, signInStore } = await freshPlugin();
  const registered = new Map();
  const authkit = fakeAuthKit();
  const mcp = fakeMcp(authkit, {
    answer: (message) => {
      if (message.method === "tools/list") return { result: { tools } };
      return answer(message);
    },
  });
  const net = https({ authkit, mcp });
  await signInStore.save(authkit.issue().refresh_token);
  let cleanup;
  const h = (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat() }, children: children.flat() });
  const ctx = {
    react: { createElement: h, useState: (v) => [v, () => {}], useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }), useId: () => "id", useMemo: (fn) => fn(), useCallback: (fn) => fn, Fragment: "f", Component: class { constructor(props) { this.props = props; } } },
    agents: { snapshot: () => ({ running: [] }), addTool: (tool) => { registered.set(tool.name, tool); return () => registered.delete(tool.name); }, register: () => {} },
    settingsCards: { register() {} }, pages: { register() {} }, panels: { register() {} },
    conversation: { registerLink() {}, registerLinkPreview() {} },
    browser: { available: false },
    effect: (fn) => { const off = fn(); if (off) cleanup = cleanup ? ((a, b) => () => { b(); a(); })(cleanup, off) : off; },
    host: { request: net.request },
  };
  apply(ctx);
  t.after(() => cleanup?.());
  await settle();
  return { registered, mcp };
}

const listed = (name, extra = {}) => ({ name, description: name, inputSchema: { type: "object" }, ...extra });

test("app-only tools are recognised by visibility and by name", () => {
  assert.deepEqual([...APP_ONLY_TOOLS], ["decide_review_item", "void_review", "restore_review"]);
  assert.equal(appOnly(listed("decide_review_item")), true, "by name, even without the mark");
  assert.equal(appOnly(listed("approve_things", { _meta: { ui: { visibility: ["app"] } } })), true);
  assert.equal(appOnly(listed("approve_things", { _meta: { ui: { visibility: "app" } } })), true);
  assert.equal(appOnly(listed("open_review", { _meta: { ui: { visibility: ["model", "app"] } } })), false);
  assert.equal(appOnly(listed("open_review", { _meta: { ui: { resourceUri: "ui://black4/review.html" } } })), false);
  for (const [name, args] of [
    ["decide_review_item", {}],
    [" Decide_Review_Item ", {}],
    ["call_tool", { name: "decide_review_item", arguments: {} }],
    ["call_tool", { name: "call_tool", arguments: { name: "void_review" } }],
    ["call_tool", JSON.stringify({ name: "restore_review" })],
    ["call_tool", { name: "call_tool", arguments: JSON.stringify({ name: "decide_review_item" }) }],
    ["call_tool", { name: "secret_app_tool" }],
  ]) assert.equal(decides(name, args, new Set(["secret_app_tool"])), true, `${name} ${JSON.stringify(args)}`);
  assert.equal(decides("call_tool", { name: "open_review" }), false);
});

test("decision tools are never offered to agents, and refused directly or through call_tool", async (t) => {
  const tools = [listed("open_review"), listed("call_tool"), listed("decide_review_item", { _meta: { ui: { visibility: ["app"] } } }),
    listed("void_review"), listed("app_only_extra", { _meta: { ui: { visibility: ["app"] } } })];
  const app = await harness(t, { tools, answer: () => ({ result: { content: [{ type: "text", text: "ok" }] } }) });
  assert.deepEqual([...app.registered.keys()].sort(), ["black4_call_tool", "black4_open_review"]);
  const before = app.mcp.calls.length;
  for (const args of [
    { name: "decide_review_item", arguments: { decisionToken: TOKEN } },
    { name: "app_only_extra", arguments: {} },
    { name: "call_tool", arguments: { name: "void_review", arguments: {} } },
  ]) await assert.rejects(app.registered.get("black4_call_tool").call({ key: "agent" }, {}, args), /Agents cannot decide, void or restore Black 4 reviews/);
  assert.equal(app.mcp.calls.length, before, "nothing an agent asked for reached Black 4");
});

test("an agent never reads _meta: no decision token or preview grant, directly or through call_tool", async (t) => {
  const body = { result: {
    _meta: META,
    structuredContent: { data: review },
    content: [
      { type: "text", text: JSON.stringify({ data: review }) },
      { type: "resource", resource: { uri: "ui://black4/review.html", text: "<card>" }, _meta: META },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png", _meta: META },
    ],
  } };
  const app = await harness(t, { tools: [listed("open_review"), listed("call_tool")], answer: () => body });
  const direct = await app.registered.get("black4_open_review").call({ key: "agent" }, {}, { businessId: "business-sample", assetId: "rv_sample" });
  const through = await app.registered.get("black4_call_tool").call({ key: "agent" }, {}, { name: "open_review", arguments: { businessId: "business-sample", assetId: "rv_sample" } });
  for (const text of [direct, through]) {
    assert.equal(typeof text, "string");
    assert.doesNotMatch(text, /b4rd_|grant-secret|decisionTokens|ai\.black4\/review-card|_meta/);
    assert.match(text, /rv_sample/, "the review itself still reads");
  }
  assert.doesNotMatch(agentText(body.result), /b4rd_|grant-secret/);
});

test("a review an agent raises points back to its conversation: start_review defaults threadId, never overrides it", async (t) => {
  const seen = [];
  const app = await harness(t, { tools: [listed("start_review"), listed("call_tool")], answer: (message) => { if (["start_review", "call_tool"].includes(message.params?.name)) seen.push(message.params.arguments); return { result: { content: [{ type: "text", text: "ok" }] } }; } });
  await app.registered.get("black4_start_review").call({ key: "agent" }, { channel: "chan-1", root: "root-9" }, { businessId: "b" });
  await app.registered.get("black4_start_review").call({ key: "agent" }, { channel: "chan-1" }, { businessId: "b" });
  await app.registered.get("black4_start_review").call({ key: "agent" }, { channel: "chan-1", root: "root-9" }, { businessId: "b", threadId: "chosen" });
  await app.registered.get("black4_call_tool").call({ key: "agent" }, { channel: "chan-1", root: "root-9" }, { name: "start_review", arguments: { businessId: "b" } });
  await app.registered.get("black4_start_review").call({ key: "agent" }, {}, { businessId: "b" });
  const args = seen.filter(Boolean);
  assert.equal(args[0].threadId, "root-9", "the thread it was asked in");
  assert.equal(args[1].threadId, "chan-1", "else its channel");
  assert.equal(args[2].threadId, "chosen", "the agent's own choice stands");
  assert.equal(args[3].arguments.threadId, "root-9", "through call_tool too");
  assert.equal("threadId" in args[4], false, "outside a conversation, nothing is added");
});

test("the queue's _meta (its capture links) never reaches an agent, directly or through call_tool", async (t) => {
  const queue = { kind: "black4_review_queue", total: 1, reviews: [{ businessId: "business-sample", assetId: "rv_sample", title: "Menu", items: [] }] };
  const body = { result: {
    _meta: { "ai.black4/review-card": { captures: { rv_sample: { desktop: { url: "https://content.example.test/v/grant-queue-secret/c.jpg", contentType: "image/jpeg" } } } } },
    structuredContent: { data: queue }, content: [{ type: "text", text: JSON.stringify({ data: queue }) }],
  } };
  const app = await harness(t, { tools: [listed("review_queue"), listed("call_tool")], answer: () => body });
  for (const text of [
    await app.registered.get("black4_review_queue").call({ key: "agent" }, {}, {}),
    await app.registered.get("black4_call_tool").call({ key: "agent" }, {}, { name: "review_queue", arguments: {} }),
  ]) {
    assert.doesNotMatch(text, /grant-queue-secret|captures|_meta|ai\.black4\/review-card/);
    assert.match(text, /rv_sample/, "the queue itself still reads");
  }
});
