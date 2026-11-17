#!/usr/bin/env node
// qwen-account.mjs <signin|check|models> <qwen-code package dir>
//
// Qwen membership (Plus or Pro on chat.qwen.ai) for the Qwen Code harness,
// driven through Qwen Code's own QwenSubscriptionSession, so the sign-in
// file (subscription_credentials.json in QWEN_HOME), its refresh and its lock
// are exactly Qwen Code's: nothing here writes or refreshes a token itself.
// Prints one JSON object per line and never a token.
//   signin  {"url", "userCode", "expiresAt"} once the device code is issued,
//           then {"ok": true, "memberType", "account"} or {"ok": false, "error"}
//   check   {"ok": true|false|null, "memberType", "account"}; null: could not tell
//   models  {"ok": true, "models": [ids]} or {"ok": false, "error"}
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [command, pkg] = process.argv.slice(2);
const say = (value) => process.stdout.write(JSON.stringify(value) + "\n");

/** The chunk of the pinned Qwen Code that exports QwenSubscriptionSession. */
async function qwenSession() {
  const dir = join(pkg, "chunks");
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".js")) continue;
    const text = readFileSync(join(dir, name), "utf8");
    if (!text.includes("QwenSubscriptionSession=class") || !/export\{[^}]*\bQwenSubscriptionSession\b/.test(text)) continue;
    const mod = await import(pathToFileURL(join(dir, name)).href);
    if (typeof mod.QwenSubscriptionSession === "function") return mod.QwenSubscriptionSession;
  }
  throw new Error("This Qwen Code has no QwenSubscriptionSession.");
}

const account = (user) => (user && (user.email || user.name)) || null;
const memberType = (user) => (user && typeof user.member_type === "string" ? user.member_type.toLowerCase() : null);
const why = (error) => (error && (error.code || error.name)) || "failed";

async function main() {
  if (!process.env.QWEN_HOME) throw new Error("QWEN_HOME is not set.");
  const Session = await qwenSession();
  const session = new Session();
  if (command === "signin") {
    const controller = new AbortController();
    const user = await session.signIn((device) => {
      // The page Qwen Code itself opens; the server's verification_uri_complete
      // (/device?user_code=...) only lands on chat.qwen.ai's home page.
      const url = new URL("https://chat.qwen.ai/authorize");
      url.searchParams.set("user_code", device.user_code);
      url.searchParams.set("client", "cli");
      url.searchParams.set("entry", "qwen_code");
      url.searchParams.set("paywallScene", "cli");
      say({ url: url.toString(), userCode: device.user_code, expiresAt: Math.floor((device.expiresAt || Date.now() + device.expires_in * 1000) / 1000) });
    }, controller.signal);
    say({ ok: true, memberType: memberType(user), account: account(user) });
    return;
  }
  if (command === "check") {
    if (!session.isSignedIn()) return say({ ok: false, memberType: null, account: null });
    try {
      const user = await session.getUserInfo(AbortSignal.timeout(20000));
      if (!user) return say({ ok: false, memberType: null, account: null });
      const type = memberType(user);
      return say({ ok: type === "plus" || type === "pro", memberType: type, account: account(user) });
    } catch (error) {
      const expired = error && (error.code === "invalid_grant" || error.code === "session_changed" || error.status === 401);
      return say({ ok: expired ? false : null, memberType: null, account: null, error: why(error) });
    }
  }
  if (command === "models") {
    const result = await session.getModels(AbortSignal.timeout(20000));
    const ids = (result?.models || []).filter((id) => typeof id === "string");
    return say({ ok: true, models: ids });
  }
  throw new Error(`unknown command ${command}`);
}

main().then(() => process.exit(0), (error) => { say({ ok: false, error: why(error) }); process.exit(1); });
