"""Tests for machine/agentctl. Run from the repo root:  /usr/bin/python3 -m unittest discover -s machine/tests

Each test gets a temporary home with fake `claude`, `claude-agent-acp`,
`buzz-acp` and `buzz` programs (and, where a test needs them, fake `codex`,
`codex-acp`, `grok` and `qwen`), so nothing touches the real machine, the
network or the crontab. The fake `claude setup-token` behaves like the real
one over a pty: banner, link, "Paste code" prompt, then a token or an OAuth
error. The fake `codex login --device-auth` and `grok login --device-auth`
print what the real ones printed on the machine (a link and a one-time code),
then wait for the test to approve or refuse (the file approve.txt in the test
home). QwenCloud's GET /models (the key check and listing) is a fake in
process: it answers 200 for the fake keys, 401 for any other, and nothing at
all for a key starting sk-offline.
"""
import contextlib, io, re, importlib.machinery, importlib.util, json, os, signal, stat, subprocess, sys, tempfile, textwrap, time, unittest
from pathlib import Path

AGENTCTL = Path(__file__).resolve().parent.parent / "agentctl"
PY = sys.executable
GOOD_CODE = "good-code-123456#state"
FAKE_TOKEN = "sk-ant-oat01-" + "T" * 40  # what the fake prints; not a real credential


def load():
    loader = importlib.machinery.SourceFileLoader("agentctl", str(AGENTCTL))
    spec = importlib.util.spec_from_loader("agentctl", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


FAKE_CLAUDE = f"""#!{PY}
import json, os, sys, time
args = sys.argv[1:]
if args[:1] == ["setup-token"]:
    out = sys.stdout
    out.write("\\x1b[?25l\\x1b[1mWelcome\\x1b[1Cto\\x1b[1CClaude\\x1b[22m\\r\\n")
    out.write("Browser didn't open? Use the url below to sign in\\r\\n\\r\\n")
    out.write("https://claude.com/cai/oauth/authorize?code=true&client_id=x&scope=user%3Ainference&state=abc\\r\\n\\r\\n")
    out.write("Paste code here if prompted > ")
    out.flush()
    code = sys.stdin.readline().strip()
    if code == {GOOD_CODE!r}:
        out.write("\\r\\nLong-lived authentication token created successfully!\\r\\n\\r\\n{FAKE_TOKEN}\\r\\n")
        out.flush()
        time.sleep(0.5)
        sys.exit(0)
    out.write("\\r\\nOAuth error: Request failed with status code 400 Press Enter to retry.\\r\\n")
    out.flush()
    time.sleep(600)
if args[:1] == ["--help"]:  # the line 2.1.303 prints
    print("  --effort <level>                      Effort level for the current session\\n                                        (low, medium, high, xhigh, max)")
    sys.exit(0)
if "-p" in args:
    token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "")
    model = args[args.index("--model") + 1] if "--model" in args else "claude-sonnet-5-5"
    home = os.environ["HOME"]
    with open(os.path.join(home, "claude-calls.txt"), "a") as f: f.write(model + "\\n")
    refused = os.path.exists(os.path.join(home, "refuse-" + model))
    busy = os.path.exists(os.path.join(home, "busy-" + model))
    if token == {FAKE_TOKEN!r} and refused:  # what 2.1.303 answered for a model the sign-in lacks
        print(json.dumps({{"is_error": True, "subtype": "success", "api_error_status": 404, "modelUsage": {{}},
                          "result": "There's an issue with the selected model (" + model + "). It may not exist or you may not have access to it."}}))
    elif token == {FAKE_TOKEN!r} and busy:
        print(json.dumps({{"is_error": True, "api_error_status": 429, "result": "API Error: 429 rate limited"}}))
    elif token == {FAKE_TOKEN!r}:
        print(json.dumps({{"is_error": False, "result": "OK", "modelUsage": {{model: {{}}}}}}))
    elif token:
        print(json.dumps({{"is_error": True, "api_error_status": 401, "result": "Failed to authenticate. API Error: 401 OAuth access token is invalid."}}))
    else:
        print(json.dumps({{"is_error": True, "api_error_status": None, "result": "Not logged in"}}))
    sys.exit(1 if token != {FAKE_TOKEN!r} else 0)
"""

FAKE_BUZZ_ACP = f"""#!{PY}
import json, os, sys, time
home = os.environ["HOME"]
if sys.argv[1:2] == ["auth-methods"]:  # buzz-acp's own ACP initialize with an adapter
    with open(os.path.join(home, "handshakes.txt"), "a") as f: f.write(sys.argv[sys.argv.index("--agent-command") + 1] + "\\n")
    if os.path.exists(os.path.join(home, "handshake-fail.txt")):
        sys.stderr.write("error: initialize failed: -32602 Invalid params\\n"); sys.exit(1)
    print(json.dumps({{"methods": []}})); sys.exit(0)
if sys.argv[1:2] == ["models"]:  # what 0.5.30 printed for claude-agent-acp 0.94.0
    opts = [{{"value": "default", "name": "Default (recommended)"}}, {{"value": "sonnet", "name": "Sonnet 5.5"}},
            {{"value": "fable", "name": "Fable 5.1"}}, {{"value": "opus", "name": "Opus 5.5"}}, {{"value": "haiku", "name": "Haiku 5.5"}}]
    with open(os.path.join(home, "listings.txt"), "a") as f: f.write("claude\\n")
    print(json.dumps({{"stable": {{"configOptions": [{{"id": "model", "category": "model", "type": "select", "currentValue": "default", "options": opts}}]}}}}))
    sys.exit(0)
if os.path.exists(os.path.join(home, "crash.txt")):
    print("buzz-acp: relay refused the connection", flush=True); sys.exit(1)
with open("env.json", "w") as f:
    json.dump({{k: v for k, v in os.environ.items() if k.startswith(("BUZZ_ACP", "CLAUDE_CODE", "PATH", "CODEX", "GROK", "QWEN", "NO_BROWSER", "OPENAI", "XAI", "INITIAL_AGENT_MODE", "GOOSE", "ANTHROPIC"))}}, f)
while True: time.sleep(1)
"""

FAKE_CRED = "fake-subscription-credential-" + "C" * 24  # what the fakes store; not a real credential

# What `codex login --device-auth` (0.160.1) and `grok login --device-auth`
# (1.0.70) printed on the machine, with the codes replaced.
FAKE_DEVICE_LOGIN = f"""
import json, os, sys, time
def device_login(home_env, banner):
    out = sys.stdout
    out.write(banner); out.flush()
    approve = os.path.join(os.environ["HOME"], "approve.txt")
    ttl = os.path.join(os.environ["HOME"], "device-ttl.txt")
    end = time.time() + (float(open(ttl).read()) if os.path.exists(ttl) else 600)
    while time.time() < end:
        if os.path.exists(approve):
            answer = open(approve).read().strip()
            if answer == "ok":
                with open(os.path.join(os.environ[home_env], "auth.json"), "w") as f:
                    json.dump({{"tokens": {{"access_token": {FAKE_CRED!r}}}}}, f)
                out.write("\\r\\nSuccessfully logged in\\r\\n"); out.flush(); sys.exit(0)
            out.write("\\r\\nError: access_denied: the user denied the request\\r\\n"); out.flush(); sys.exit(1)
        time.sleep(0.1)
    out.write("\\r\\nError: device code expired\\r\\n"); out.flush(); sys.exit(1)
def stored(home_env):
    try: return open(os.path.join(os.environ[home_env], "auth.json")).read()
    except FileNotFoundError: return ""
"""

FAKE_CODEX = f"""#!{PY}
{FAKE_DEVICE_LOGIN}
args = sys.argv[1:]
if args[:2] == ["login", "--device-auth"]:
    device_login("CODEX_HOME", "\\r\\nWelcome to Codex [v0.160.1]\\r\\n\\r\\n1. Open this link in your browser and sign in to your account\\r\\n   https://auth.openai.com/codex/device\\r\\n\\r\\n2. Enter this one-time code (expires in 15 minutes)\\r\\n   ABCD-12EFG\\r\\n")
if args[:1] == ["app-server"]:
    cred = stored("CODEX_HOME")
    for line in sys.stdin:
        msg = json.loads(line)
        with open(os.path.join(os.environ["HOME"], "codex-calls.txt"), "a") as f: f.write(json.dumps([msg.get("method"), msg.get("params")]) + "\\n")
        if "id" not in msg: continue
        m, i = msg["method"], msg["id"]
        if m == "initialize": r = {{"result": {{"codexHome": os.environ["CODEX_HOME"]}}}}
        elif m == "account/read":
            acct = None
            if {FAKE_CRED!r} in cred: acct = {{"type": "chatgpt", "email": "owner@example.com", "planType": "plus"}}
            elif "apikey" in cred: acct = {{"type": "apiKey"}}
            r = {{"result": {{"account": acct, "requiresOpenaiAuth": True}}}}
        elif m == "account/rateLimits/read":
            if "revoked" in cred: r = {{"error": {{"code": -32600, "message": "codex account authentication required to read rate limits"}}}}
            else: r = {{"result": {{"rateLimits": {{}}}}}}
        else: r = {{"error": {{"code": -32601, "message": "unknown"}}}}
        print(json.dumps({{"id": i, **r}}), flush=True)
"""

FAKE_GROK = f"""#!{PY}
{FAKE_DEVICE_LOGIN}
args = sys.argv[1:]
if args[:2] == ["login", "--device-auth"]:
    device_login("GROK_HOME", "\\r\\nTo sign in, open this URL in your browser:\\r\\n\\r\\n  https://accounts.x.ai/oauth2/device?user_code=QRST-UVWX\\r\\n\\r\\nConfirm this code in your browser:\\r\\n\\r\\n  QRST-UVWX\\r\\n\\r\\nWaiting for authorization...\\r\\n")
if args[:1] == ["models"]:  # what 1.0.70 prints; it calls no model
    cred = stored("GROK_HOME")
    if not ({FAKE_CRED!r} in cred and "revoked" not in cred): print("You are not authenticated.\\n")
    print("Default model: grok-4.6\\n\\nAvailable models:\\n  * grok-4.6 (default)\\n  - grok-4.5"); sys.exit(0)
"""

# Qwen Code is only started by buzz-acp (the fake above records its
# environment); agentctl itself never runs it, so a stub will do.
FAKE_QWEN = "#!/bin/sh\nexit 0\n"
FAKE_QWEN_KEY = "sk-fake-qwencloud-key-" + "Q" * 24  # what the fake service accepts; not a real key
FAKE_QWEN_PLAN_KEY = "sk-fake-token-plan-key-" + "P" * 24  # likewise, on the Token Plan base only
QWEN_BASE = "https://maas.qwencloudapi.com/compatible-mode/v1"
QWEN_PLAN_BASE = "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1"
# The shape QwenCloud's GET /models answers (OpenAI's list), with rows a
# person would not pick for an agent mixed in.
QWEN_MODELS_BODY = {"object": "list", "data": [
    {"id": "qwen3.8-max", "object": "model"}, {"id": "qwen3-embedding-8b", "object": "model"},
    {"id": "qwen4-max", "object": "model"}, {"id": "qwen3.7-plus", "object": "model"},
    {"id": "qwen3-vl-plus", "object": "model"}, {"id": "deepseek-v4-pro", "object": "model"},
    {"id": "qwen-tts-latest", "object": "model"}]}


def fake_qwencloud(test):
    """A fake of QwenCloud's GET /models, in place of agentctl's urllib call:
    records (url, key) in test.http_calls; 200 for the fake key of each base,
    401 otherwise, nothing for an sk-offline key, 500 for an sk-broken one.
    The file qwen-revoked.txt in the test home makes every key a 401."""
    test.http_calls = []

    def get(url, key, timeout=20):
        test.http_calls.append((url, key))
        if key.startswith("sk-offline"): return None, None
        if key.startswith("sk-broken"): return 500, {"error": "upstream"}
        good = FAKE_QWEN_PLAN_KEY if url.startswith(QWEN_PLAN_BASE) else FAKE_QWEN_KEY
        if key == good and not (test.home / "qwen-revoked.txt").exists() and url.endswith("/models"):
            return 200, QWEN_MODELS_BODY
        return 401, {"error": {"message": "Incorrect API key provided.", "code": "invalid_api_key"}}
    return get


def gone(pid):
    """True once pid has exited (reaping it first if it is our own child)."""
    for _ in range(30):
        try: os.waitpid(pid, os.WNOHANG)
        except ChildProcessError: pass
        try: os.kill(pid, 0)
        except OSError: return True
        time.sleep(0.1)
    return False


def write_exe(path, text):
    path.write_text(textwrap.dedent(text) if not text.startswith("#!") else text)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.saved_env = dict(os.environ)
        os.environ.update({"HOME": str(self.home), "AGENTCTL_NO_CRON": "1"})
        self.a = load()
        self.a.set_root(self.home)
        self.a.START_GRACE = 0.3
        self.a.SELF = AGENTCTL
        bin_ = self.a.BIN
        bin_.mkdir(parents=True)
        write_exe(bin_ / "claude", FAKE_CLAUDE)
        write_exe(bin_ / "claude-agent-acp", "#!/bin/sh\nexit 0\n")
        write_exe(bin_ / "buzz-acp", FAKE_BUZZ_ACP)
        write_exe(bin_ / "buzz", "#!/bin/sh\nexit 0\n")
        # Only the fake bin and the system: a real goose or grok on the test
        # computer must not count as installed.
        self.a.agent_path = lambda: f"{bin_}:/usr/bin:/bin"
        # Sign-in checks run in this process, not in a detached `agentctl check`.
        self.a.spawn_check = lambda harness: self.a.run_check(harness)
        # Likewise the Claude and Qwen model listings: tests make them with refresh_models.
        self.a.spawn_models_refresh = lambda harness="claude": None
        self.crontab = ""  # never the test computer's own crontab
        self.a.read_crontab = lambda: self.crontab

    def tearDown(self):
        for d in self.a.agent_dirs():
            try: self.a.stop(d)
            except Exception: pass
        if self.a.LOGINS.exists():
            for d in self.a.LOGINS.iterdir(): self.a.kill_login(d)
        os.environ.clear(); os.environ.update(self.saved_env)
        self.tmp.cleanup()

    def req(self, **request):
        try: return self.a.handle(request)
        except self.a.Fail as e: return {"ok": False, "error": str(e)}

    def make_agent(self, harness="claude", activate=True):
        r = self.req(op="provision", name="Test agent", community="wss://relay.example.com",
                     config={"harness": harness})
        self.assertTrue(r["ok"], r)
        d = self.a.AGENTS / r["pubkey"]
        if activate:
            s = self.a.read_settings(d)
            s["auth"] = ["auth", "a" * 64, "", "b" * 128]
            self.a.write_settings(d, s)
        return d

    def sign_in(self):
        self.a.save_claude_token(FAKE_TOKEN, None)

    def wait_running(self, d, seconds=15):
        """A sign-in's helper restarts the agents after login.finish has replied."""
        for _ in range(int(seconds * 10)):
            if self.a.running(d): return True
            time.sleep(0.1)
        return False


class PureLogic(unittest.TestCase):
    def setUp(self):
        self.a = load()

    def test_pubkey_of_matches_bip340_vector(self):
        # BIP-340 test vector 1: secret key 3 -> x-only public key.
        self.assertEqual(self.a.pubkey_of("0" * 63 + "3"),
                         "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9")

    def test_community_url(self):
        self.assertEqual(self.a.community_url("wss://relay.example.com/"), "https://relay.example.com")
        self.assertEqual(self.a.community_url("https://relay.example.com:8443"), "https://relay.example.com:8443")
        for bad in ("http://x.com", "wss://x.com/path", "", None, "wss://a b"):
            with self.assertRaises(self.a.Fail): self.a.community_url(bad)

    def test_screen_text_turns_cursor_moves_into_spaces(self):
        raw = b"\x1b[1mPaste\x1b[1Ccode\x1b[3Chere\x1b[22m\r\n\x1b]0;title\x07done"
        self.assertEqual(self.a.screen_text(raw), "Paste code   here\n\ndone")

    def test_url_and_token_patterns(self):
        text = "Use the url below\n\nhttps://claude.com/cai/oauth/authorize?code=true&state=x\n\nPaste"
        self.assertEqual(self.a.URL_RE.search(text).group(0), "https://claude.com/cai/oauth/authorize?code=true&state=x")
        self.assertEqual(self.a.TOKEN_RE.search("token:\n" + FAKE_TOKEN + "\n").group(0), FAKE_TOKEN)
        self.assertIsNone(self.a.TOKEN_RE.search("sk-ant-oat01-short"))

    def test_judge_claude_check(self):
        j = self.a.judge_claude_check
        self.assertTrue(j('{"is_error": false, "result": "OK"}'))
        self.assertFalse(j('{"is_error": true, "api_error_status": 401, "result": "x"}'))
        self.assertFalse(j('{"is_error": true, "result": "Not logged in \\u00b7 Please run /login"}'))
        self.assertIsNone(j('{"is_error": true, "result": "Connection error"}'))
        self.assertIsNone(j("not json"))

    def test_merged_crontab_keeps_other_lines_and_is_idempotent(self):
        current = "MAILTO=\"\"\n0 3 * * * /usr/bin/true\n"
        once = self.a.merged_crontab(current, True)
        self.assertIn("0 3 * * * /usr/bin/true", once)
        self.assertEqual(once.count(self.a.CRON_MARK), 2)
        self.assertIn("@reboot", once)
        self.assertEqual(self.a.merged_crontab(once, True), once)
        self.assertEqual(self.a.merged_crontab(once, False), current)
        self.assertEqual(self.a.merged_crontab("", False), "")


class Requests(Base):
    def test_unknown_op_and_bad_pubkey(self):
        self.assertEqual(self.req(op="nope", pubkey="a" * 64)["ok"], False)
        self.assertIn("64 hex", self.req(op="status", pubkey="xyz")["error"])

    def test_main_prints_one_json_line_for_bad_input(self):
        out = subprocess.run([PY, str(AGENTCTL)], input="{not json", capture_output=True, text=True,
                             env=dict(os.environ))
        self.assertEqual(json.loads(out.stdout), {"ok": False, "error": "request is not JSON"})

    def test_provision_list_status_remove(self):
        d = self.make_agent(activate=False)
        self.assertEqual(stat.S_IMODE((d / "key").stat().st_mode), 0o600)
        rows = self.req(op="list")["agents"]
        self.assertEqual([r["pubkey"] for r in rows], [d.name])
        self.assertFalse(rows[0]["activated"])
        st = self.req(op="status", pubkey=d.name)
        self.assertEqual((st["ok"], st["running"], st["harness"]), (True, False, "claude"))
        self.assertTrue(self.req(op="remove", pubkey=d.name)["ok"])
        self.assertFalse(d.exists())

    def test_provision_retry_returns_same_agent(self):
        r1 = self.req(op="provision", name="A", community="wss://r.example.com", requestId="q1")
        r2 = self.req(op="provision", name="A", community="wss://r.example.com", requestId="q1")
        self.assertEqual(r1["pubkey"], r2["pubkey"])

    def test_instructions_round_trip(self):
        d = self.make_agent(activate=False)
        self.assertTrue(self.req(op="instructions.set", pubkey=d.name, instructions="Be brief.")["ok"])
        self.assertEqual(self.req(op="instructions.get", pubkey=d.name)["instructions"], "Be brief.")


class MachineStatus(Base):
    def test_reports_five_harnesses_and_claude_signed_out(self):
        r = self.req(op="machine.status")
        self.assertTrue(r["ok"])
        self.assertIsInstance(r["machine"], str)
        rows = {h["id"]: h for h in r["harnesses"]}
        self.assertEqual(list(rows), ["claude", "codex", "grok", "qwen", "goose"])
        self.assertEqual(rows["qwen"]["signIn"], "key")
        self.assertEqual(rows["qwen"]["label"], "Qwen Code")
        self.assertFalse(rows["qwen"]["installed"])
        self.assertEqual(rows["claude"], {"id": "claude", "label": "Claude Code", "installed": True,
                                          "signedIn": False, "account": None, "signIn": "code"})
        self.assertFalse(rows["goose"]["installed"])
        self.assertIsNone(rows["codex"]["signedIn"])  # not installed here: nothing to check
        self.assertEqual(rows["codex"]["signIn"], "device")
        self.assertEqual(rows["grok"]["signIn"], "device")
        self.assertEqual(rows["grok"]["label"], "Grok Build")
        self.assertIsNone(rows["goose"]["signIn"])
        self.assertIn("cannot sign it in", rows["goose"]["note"])

    def test_machine_name_from_config(self):
        self.a.ROOT.mkdir(parents=True, exist_ok=True)
        (self.a.ROOT / "machine.json").write_text('{"name": "commerce"}')
        self.assertEqual(self.req(op="machine.status")["machine"], "commerce")

    def test_signed_in_is_verified_not_just_a_file(self):
        self.a.SECRETS.mkdir(parents=True)
        (self.a.SECRETS / "claude").write_text("sk-ant-oat01-" + "X" * 40)  # rejected by the fake
        claude = self.req(op="machine.status")["harnesses"][0]
        self.assertFalse(claude["signedIn"])
        self.sign_in()
        (self.a.RUN / "claude-check.json").unlink()  # force a real check
        self.assertTrue(self.req(op="machine.status")["harnesses"][0]["signedIn"])


class Start(Base):
    def test_start_refuses_when_claude_signed_out(self):
        d = self.make_agent()
        r = self.req(op="start", pubkey=d.name)
        self.assertFalse(r["ok"])
        self.assertIn("not signed in", r["error"])

    def test_start_refuses_when_harness_missing(self):
        d = self.make_agent(harness="goose")
        r = self.req(op="start", pubkey=d.name)
        self.assertEqual(r, {"ok": False, "error": "Goose is not installed on this machine."})

    def test_start_passes_token_only_as_env(self):
        self.sign_in()
        d = self.make_agent()
        r = self.req(op="start", pubkey=d.name)
        self.assertTrue(r["ok"], r)
        self.assertNotIn(FAKE_TOKEN, json.dumps(r))
        for _ in range(30):
            if (d / "work" / "env.json").exists(): break
            time.sleep(0.1)
        env = json.loads((d / "work" / "env.json").read_text())
        self.assertEqual(env["CLAUDE_CODE_OAUTH_TOKEN"], FAKE_TOKEN)
        self.assertEqual(env["BUZZ_ACP_AGENT_COMMAND"], "claude-agent-acp")
        self.assertTrue(env["PATH"].startswith(str(self.a.BIN)))
        self.assertNotIn(FAKE_TOKEN, (d / "agent.log").read_text())

    def test_claude_runs_with_full_access(self):
        self.sign_in()
        d = self.make_agent()
        self.assertTrue(self.req(op="start", pubkey=d.name)["ok"])
        self.assertEqual(self.wait_env(d)["BUZZ_ACP_PERMISSION_MODE"], "bypassPermissions")

    def test_every_agent_gets_the_black4_mcp_when_installed(self):
        self.sign_in()
        d = self.make_agent()
        self.assertTrue(self.req(op="start", pubkey=d.name)["ok"])
        env = self.wait_env(d)
        self.assertNotIn("BUZZ_ACP_MCP_COMMAND", env, "no connector installed: no MCP")
        self.a.BLACK4_MCP.parent.mkdir(parents=True)
        write_exe(self.a.BLACK4_MCP, "#!/bin/sh\nexit 0\n")
        (d / "work" / "env.json").unlink()
        self.assertTrue(self.req(op="start", pubkey=d.name)["ok"])
        env = self.wait_env(d)
        self.assertEqual(env["BUZZ_ACP_MCP_COMMAND"], str(self.a.ROOT / "mcp" / "black4"))
        self.assertEqual(Path(env["BUZZ_ACP_MCP_COMMAND"]).stem, "black4")

    def test_heartbeat_keeps_the_model_on_and_asks_black4_what_is_due(self):
        self.sign_in()
        d = self.make_agent()
        self.assertTrue(self.req(op="start", pubkey=d.name)["ok"])
        env = self.wait_env(d)
        self.assertEqual(env["BUZZ_ACP_LAZY_POOL"], "true", "no heartbeat: the model sleeps until a mention")
        self.assertNotIn("BUZZ_ACP_HEARTBEAT_INTERVAL", env)
        (d / "work" / "env.json").unlink()
        r = self.req(op="heartbeat.set", pubkey=d.name, minutes=15)
        self.assertEqual((r["ok"], r["heartbeat"]), (True, 15))
        env = self.wait_env(d)
        self.assertEqual(env["BUZZ_ACP_LAZY_POOL"], "false")
        self.assertEqual(env["BUZZ_ACP_HEARTBEAT_INTERVAL"], "900")
        self.assertEqual(env["BUZZ_ACP_AGENTS"], "2")
        prompt = Path(env["BUZZ_ACP_HEARTBEAT_PROMPT_FILE"]).read_text()
        self.assertIn("start_next_standing_run", prompt)
        self.assertIn("post nothing", prompt)
        self.assertIn("call_tool", prompt, "the core toolset reaches start_next_standing_run through call_tool")
        self.assertIn("businesses:", prompt, "finish names its businesses field, or the server drops the outcomes")
        listed = self.req(op="list")["agents"][0]
        self.assertEqual(listed["heartbeat"], 15)
        self.assertEqual(self.req(op="heartbeat.set", pubkey=d.name, minutes=2)["ok"], False)
        (d / "work" / "env.json").unlink()
        self.assertEqual(self.req(op="heartbeat.set", pubkey=d.name, minutes=0)["heartbeat"], 0)
        self.assertEqual(self.wait_env(d)["BUZZ_ACP_LAZY_POOL"], "true")

    def test_the_heartbeat_prompt_can_be_read_and_defined(self):
        self.sign_in()
        d = self.make_agent()
        view = self.req(op="heartbeat.get", pubkey=d.name)
        self.assertEqual((view["heartbeat"], view["custom"]), (0, False))
        self.assertEqual(view["prompt"], view["defaultPrompt"])
        r = self.req(op="heartbeat.set", pubkey=d.name, minutes=15, prompt="Check the paid media channel and summarise.")
        self.assertEqual((r["heartbeat"], r["custom"], r["prompt"]), (15, True, "Check the paid media channel and summarise."))
        env = self.wait_env(d)
        self.assertEqual(Path(env["BUZZ_ACP_HEARTBEAT_PROMPT_FILE"]).read_text().strip(), "Check the paid media channel and summarise.")
        r = self.req(op="heartbeat.set", pubkey=d.name, prompt="")
        self.assertEqual((r["heartbeat"], r["custom"]), (15, False), "an empty prompt is the default; minutes left out stay")
        self.assertEqual(self.req(op="heartbeat.set", pubkey=d.name, prompt=5)["ok"], False)

    def test_the_agent_name_reaches_the_black4_connector(self):
        self.sign_in()
        d = self.make_agent()
        self.assertTrue(self.req(op="start", pubkey=d.name)["ok"])
        env = self.wait_env(d)
        self.assertEqual(env["BUZZ_ACP_DISPLAY_NAME"], self.a.read_settings(d)["name"])

    def wait_env(self, d):
        for _ in range(30):
            if (d / "work" / "env.json").exists(): break
            time.sleep(0.1)
        time.sleep(0.1)
        return json.loads((d / "work" / "env.json").read_text())


class Identity(Base):
    def test_identity_lists_each_agent_and_its_owner(self):
        self.assertEqual(self.req(op="identity"), {"ok": True, "agents": []})
        active = self.make_agent()
        pending = self.make_agent(activate=False)
        r = self.req(op="identity")
        self.assertTrue(r["ok"])
        rows = {row["pubkey"]: row for row in r["agents"]}
        self.assertEqual(rows[active.name], {"pubkey": active.name, "name": "Test agent", "owner": "a" * 64})
        self.assertEqual(rows[pending.name]["owner"], None)
        secret = (active / "key").read_text().strip()
        self.assertNotIn(secret, json.dumps(r))


class Callers(Base):
    """A teammate's key forces `agentctl --caller <label>` (machine/teammates.sh)."""

    def as_caller(self, label):
        self.a.CALLER = label
        self.addCleanup(setattr, self.a, "CALLER", None)

    def test_creator_is_stored_and_listed(self):
        self.as_caller("sam")
        d = self.make_agent(activate=False)
        self.assertEqual(self.a.read_settings(d)["createdBy"], "sam")
        self.assertEqual(self.req(op="list")["agents"][0]["createdBy"], "sam")

    def test_the_owners_agents_are_closed_to_callers(self):
        # Made with the machine owner's own key (no label), or before creators
        # were recorded: a teammate reads them but cannot change them.
        d = self.make_agent(activate=False)
        self.assertIsNone(self.req(op="list")["agents"][0]["createdBy"])
        self.as_caller("lee")
        for op, extra in [("remove", {}), ("instructions.set", {"instructions": "x"}), ("profile", {"name": "Taken"}), ("start", {})]:
            self.assertEqual(self.req(op=op, pubkey=d.name, **extra),
                             {"ok": False, "error": "This agent belongs to the machine owner. Only they or a Black 4 admin can change it."}, op)
        self.assertTrue(d.exists())
        self.assertTrue(self.req(op="status", pubkey=d.name)["ok"])
        self.assertTrue(self.req(op="instructions.get", pubkey=d.name)["ok"])
        self.assertEqual(len(self.req(op="list")["agents"]), 1)

    def test_a_caller_changes_only_its_own_agents(self):
        self.as_caller("sam")
        mine = self.make_agent(activate=False)
        self.a.CALLER = "lee"
        for op, extra in [("remove", {}), ("instructions.set", {"instructions": "x"}), ("profile", {"name": "Taken"}),
                          ("start", {}), ("activate", {"auth": ["auth", "c" * 64, "", "d" * 128]})]:
            r = self.req(op=op, pubkey=mine.name, **extra)
            self.assertEqual(r, {"ok": False, "error": "This agent belongs to sam. Only they or a Black 4 admin can change it."}, op)
        self.assertTrue(mine.exists())
        self.assertTrue(self.req(op="status", pubkey=mine.name)["ok"], "reading is allowed")
        self.assertTrue(self.req(op="instructions.get", pubkey=mine.name)["ok"])
        self.a.CALLER = None
        self.assertTrue(self.req(op="remove", pubkey=mine.name)["ok"], "the admin may")

    def test_a_retry_never_returns_another_callers_agent(self):
        self.as_caller("sam")
        r1 = self.req(op="provision", name="A", community="wss://r.example.com", requestId="q1")
        self.a.CALLER = "lee"
        r2 = self.req(op="provision", name="A", community="wss://r.example.com", requestId="q1")
        self.assertNotEqual(r1["pubkey"], r2["pubkey"])

    def test_a_caller_signs_in_only_a_signed_out_harness(self):
        self.as_caller("sam")
        r = self.req(op="login.start", harness="claude")
        self.assertTrue(r["ok"], "signed out: a teammate may sign it in")
        self.req(op="login.cancel", loginId=r["loginId"])
        self.sign_in()
        self.assertEqual(self.req(op="login.start", harness="claude"),
                         {"ok": False, "error": "Claude Code is already signed in on this machine. Only a Black 4 admin can switch it to another account."})
        self.a.CALLER = None
        r = self.req(op="login.start", harness="claude")
        self.assertTrue(r["ok"], "the admin may switch it")
        self.req(op="login.cancel", loginId=r["loginId"])

    def test_only_the_admin_signs_the_machine_out(self):
        self.as_caller("sam")
        self.assertEqual(self.req(op="logout", harness="claude"),
                         {"ok": False, "error": "Only a Black 4 admin can sign this machine out."})

    def run_main(self, *argv, request='{"op": "list"}'):
        env = dict(os.environ, HOME=str(self.home), AGENTCTL_HOME=str(self.home))
        out = subprocess.run([PY, str(AGENTCTL), *argv], input=request, capture_output=True, text=True, env=env, timeout=30)
        return json.loads(out.stdout)

    def test_forced_command_ignores_what_the_client_asked_and_never_supervises(self):
        self.assertEqual(self.run_main("--caller", "sam"), {"ok": True, "agents": []})
        self.assertFalse(self.run_main("--caller", "Not Valid")["ok"])
        self.assertFalse(self.run_main("--caller")["ok"])
        # `--caller x supervise` is not a way in: anything after the label is refused.
        self.assertFalse(self.run_main("--caller", "sam", "supervise")["ok"])
        made = self.run_main("--caller", "sam", request='{"op": "provision", "name": "N", "community": "wss://r.example.com"}')
        self.assertEqual(self.run_main()["agents"][0], {**self.run_main()["agents"][0], "pubkey": made["pubkey"], "createdBy": "sam"})


    def test_the_door_passes_a_staff_email_as_the_caller(self):
        # machine/door.mjs runs `agentctl --caller <email>` for a valid pass.
        made = self.run_main("--caller", "annabelle@black4.ai", request='{"op": "provision", "name": "A", "community": "wss://r.example.com"}')
        self.assertTrue(made["ok"])
        row = self.run_main()["agents"][0]
        self.assertEqual(row["createdBy"], "annabelle@black4.ai")
        # Only she (or the admin) changes it; an SSH label with her name does not.
        for other in ("annabelle", "sam@black4.ai"):
            r = self.run_main("--caller", other, request=json.dumps({"op": "remove", "pubkey": made["pubkey"]}))
            self.assertEqual(r, {"ok": False, "error": "This agent belongs to annabelle@black4.ai. Only they or a Black 4 admin can change it."}, other)
        self.assertTrue(self.run_main("--caller", "annabelle@black4.ai", request=json.dumps({"op": "remove", "pubkey": made["pubkey"]}))["ok"])
        # Not an email agentctl accepts: upper case, no domain dot, spaces, a newline, too long.
        for bad in ("Annabelle@black4.ai", "a@b", "a b@black4.ai", "sam@black4.ai\n", "sam\n", "@black4.ai", "a" * 65 + "@black4.ai"):
            self.assertFalse(self.run_main("--caller", bad)["ok"], repr(bad))


class Supervisor(Base):
    def test_killed_agent_comes_back(self):
        self.sign_in()
        d = self.make_agent()
        pid = self.req(op="start", pubkey=d.name)["pid"]
        os.killpg(pid, signal.SIGKILL)
        for _ in range(30):
            if not self.a.running(d): break
            time.sleep(0.1)
        self.assertIsNone(self.a.running(d))
        self.a.supervise_pass()
        new = self.a.running(d)
        self.assertTrue(new)
        self.assertNotEqual(new, pid)

    def test_waits_for_sign_in_instead_of_retrying(self):
        d = self.make_agent()
        self.a.supervise_pass()
        self.assertIsNone(self.a.running(d))
        self.assertEqual(self.a.restarts(d), {})  # skipped, not failed: nothing to back off from

    def test_single_supervisor(self):
        self.a.RUN.mkdir(parents=True, exist_ok=True)
        import fcntl
        held = open(self.a.RUN / "supervisor.lock", "a")
        fcntl.flock(held, fcntl.LOCK_EX)
        t = time.time()
        self.a.supervise()  # must return at once, not loop
        self.assertLess(time.time() - t, 1)
        held.close()

    def test_remove_stops_agent(self):
        self.sign_in()
        d = self.make_agent()
        pid = self.req(op="start", pubkey=d.name)["pid"]
        self.assertTrue(self.req(op="remove", pubkey=d.name)["ok"])
        self.assertTrue(gone(pid))


class Login(Base):
    def start_login(self):
        r = self.req(op="login.start", harness="claude")
        self.assertTrue(r["ok"], r)
        self.assertTrue(r["url"].startswith("https://claude.com/cai/oauth/authorize?"))
        self.assertTrue(r["needsCode"])
        d = self.a.LOGINS / r["loginId"]
        self.assertEqual(stat.S_IMODE(d.stat().st_mode), 0o700)
        return r["loginId"], d

    def test_harnesses_buzz_cannot_sign_in(self):
        self.assertIn("is not installed", self.req(op="login.start", harness="codex", flows=["device"])["error"])
        self.assertIn("cannot sign it in", self.req(op="login.start", harness="goose")["error"])
        self.assertIn("cannot sign that harness out", self.req(op="logout", harness="goose")["error"])

    def test_good_code_stores_token_and_restarts_agents(self):
        d_agent = self.make_agent()
        login_id, d = self.start_login()
        r = self.req(op="login.finish", loginId=login_id, code=GOOD_CODE)
        self.assertEqual(r, {"ok": True, "signedIn": True, "account": None})
        self.assertFalse(d.exists())
        secret = self.a.SECRETS / "claude"
        self.assertEqual(secret.read_text().strip(), FAKE_TOKEN)
        self.assertEqual(stat.S_IMODE(secret.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.a.SECRETS.stat().st_mode), 0o700)
        self.assertTrue(self.wait_running(d_agent))  # restarted on the new credential, after the reply
        for path in self.a.ROOT.rglob("*"):
            if path.is_file() and path != secret and path.name != "env.json" and path.parent != self.a.BIN:
                self.assertNotIn(FAKE_TOKEN, path.read_text(errors="replace"), path)
        self.assertTrue(self.req(op="machine.status")["harnesses"][0]["signedIn"])
        self.assertEqual(self.req(op="logout", harness="claude"), {"ok": True})
        self.assertFalse(secret.exists())
        self.assertIsNone(self.a.running(d_agent))

    def test_wrong_code_fails_cleanly(self):
        login_id, d = self.start_login()
        t = time.time()
        r = self.req(op="login.finish", loginId=login_id, code="wrong-code-999999#state")
        self.assertLess(time.time() - t, 20)
        self.assertEqual(r["ok"], False)
        self.assertIn("not accepted", r["error"])
        self.assertFalse(d.exists())
        self.assertFalse((self.a.SECRETS / "claude").exists())

    def test_cancel_and_finish_after_cancel(self):
        login_id, d = self.start_login()
        pid = json.loads((d / "helper.json").read_text())["pid"]
        self.assertEqual(self.req(op="login.cancel", loginId=login_id), {"ok": True})
        self.assertFalse(d.exists())
        self.assertTrue(gone(pid))
        r = self.req(op="login.finish", loginId=login_id, code=GOOD_CODE)
        self.assertIn("expired or was cancelled", r["error"])
        self.assertEqual(self.req(op="login.cancel", loginId=login_id), {"ok": True})

    def test_bad_inputs(self):
        self.assertIn("loginId", self.req(op="login.finish", loginId="../x", code=GOOD_CODE)["error"])
        login_id, _ = self.start_login()
        self.assertIn("does not look like", self.req(op="login.finish", loginId=login_id, code="a\nb")["error"])

    def test_stale_login_is_cleaned(self):
        login_id, d = self.start_login()
        self.a.cleanup_logins(now=time.time() + self.a.LOGIN_TTL + 5)
        self.assertFalse(d.exists())


class DeviceBase(Base):
    """Codex, Grok and Qwen Code, installed as fakes, with a fake QwenCloud."""
    def setUp(self):
        super().setUp()
        write_exe(self.a.BIN / "codex", FAKE_CODEX)
        write_exe(self.a.BIN / "codex-acp", "#!/bin/sh\nexit 0\n")
        write_exe(self.a.BIN / "grok", FAKE_GROK)
        write_exe(self.a.BIN / "qwen", FAKE_QWEN)
        self.a.http_get_json = fake_qwencloud(self)
        # A key sign-in restarts agents detached; here, in this process.
        self.a.spawn_restart = lambda harness: self.a.restart_harness_agents(harness)
        self.a.FINISH_WAIT = 20

    def start_key(self, harness="qwen", flows=("code", "device", "key")):
        r = self.req(op="login.start", harness=harness, flows=list(flows))
        self.assertTrue(r["ok"], r)
        return r, self.a.LOGINS / r["loginId"]

    def sign_in_key(self, key=FAKE_QWEN_KEY):
        r, _ = self.start_key()
        return self.req(op="login.finish", loginId=r["loginId"], code=key)

    def approve(self, answer="ok"):
        (self.home / "approve.txt").write_text(answer)

    def start_device(self, harness):
        r = self.req(op="login.start", harness=harness, flows=["code", "device"])
        self.assertTrue(r["ok"], r)
        self.assertFalse(r["needsCode"])
        d = self.a.LOGINS / r["loginId"]
        self.assertEqual(stat.S_IMODE(d.stat().st_mode), 0o700)
        return r, d

    def sign_in_device(self, harness):
        r, _ = self.start_device(harness)
        self.approve()
        return self.req(op="login.finish", loginId=r["loginId"])


class DeviceLogin(DeviceBase):
    def test_codex_link_and_code_from_the_cli(self):
        r, _ = self.start_device("codex")
        self.assertEqual(r["url"], "https://auth.openai.com/codex/device")
        self.assertEqual(r["userCode"], "ABCD-12EFG")
        self.assertGreater(r["expiresAt"], time.time())

    def test_grok_link_and_code_from_the_cli(self):
        r, _ = self.start_device("grok")
        self.assertEqual(r["url"], "https://accounts.x.ai/oauth2/device?user_code=QRST-UVWX")
        self.assertEqual(r["userCode"], "QRST-UVWX")

    def test_an_older_plugin_gets_a_sentence_not_a_sign_in_it_cannot_show(self):
        for harness, label in (("codex", "Codex"), ("grok", "Grok Build")):
            r = self.req(op="login.start", harness=harness)
            self.assertEqual(r, {"ok": False, "error": f"Update the Black 4 plugin in Buzz to sign in to {label} from it."})
        self.assertFalse(any(self.a.LOGINS.iterdir()) if self.a.LOGINS.exists() else False)

    def test_approval_stores_the_sign_in_privately_and_restarts_agents(self):
        for harness in ("codex", "grok"):
            with self.subTest(harness=harness):
                agent = self.make_agent(harness)
                r, d = self.start_device(harness)
                self.approve()
                done = self.req(op="login.finish", loginId=r["loginId"])
                self.assertEqual(done["ok"], True, done)
                self.assertEqual(done["signedIn"], True)
                self.assertEqual(done["account"], "owner@example.com" if harness == "codex" else None)
                self.assertFalse(d.exists())
                cred = self.a.HOMES / harness / "auth.json"
                self.assertIn(FAKE_CRED, cred.read_text())
                self.assertEqual(stat.S_IMODE(cred.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE((self.a.HOMES / harness).stat().st_mode), 0o700)
                self.assertEqual(stat.S_IMODE(self.a.HOMES.stat().st_mode), 0o700)
                self.assertTrue(self.wait_running(agent))
                env = json.loads((agent / "work" / "env.json").read_text())
                home_env = "CODEX_HOME" if harness == "codex" else "GROK_HOME"
                self.assertEqual(env[home_env], str(self.a.HOMES / harness))
                for key in env:  # the subscription pays: no API key reaches the agent
                    self.assertNotRegex(key, r"API_KEY")
                for path in self.a.ROOT.rglob("*"):
                    if path.is_file() and path.name != "auth.json" and path.parent != self.a.BIN:
                        self.assertNotIn(FAKE_CRED, path.read_text(errors="replace"), path)
                (self.home / "approve.txt").unlink()

    def test_not_yet_approved_keeps_the_sign_in_open(self):
        self.a.FINISH_WAIT = 0.5
        r, d = self.start_device("codex")
        self.assertEqual(self.req(op="login.finish", loginId=r["loginId"]), {"ok": True, "signedIn": False, "pending": True})
        self.assertTrue(d.exists())
        self.a.FINISH_WAIT = 20
        self.approve()
        self.assertTrue(self.req(op="login.finish", loginId=r["loginId"])["signedIn"])

    def test_a_pasted_code_is_ignored_for_a_device_sign_in(self):
        self.a.FINISH_WAIT = 0.5
        r, d = self.start_device("grok")
        self.assertTrue(self.req(op="login.finish", loginId=r["loginId"], code="anything-at-all")["pending"])

    def test_refused_approval_fails_cleanly(self):
        r, d = self.start_device("grok")
        self.approve("deny")
        done = self.req(op="login.finish", loginId=r["loginId"])
        self.assertEqual(done, {"ok": False, "error": "The sign-in was not approved. Start the sign-in again."})
        self.assertFalse(d.exists())
        self.assertFalse((self.a.HOMES / "grok" / "auth.json").exists())

    def test_expired_code_fails_cleanly(self):
        (self.home / "device-ttl.txt").write_text("1")
        r, d = self.start_device("codex")
        done = self.req(op="login.finish", loginId=r["loginId"])
        self.assertEqual(done, {"ok": False, "error": "This sign-in code expired. Start the sign-in again."})
        self.assertFalse((self.a.HOMES / "codex" / "auth.json").exists())

    def test_sign_in_left_open_past_its_lifetime_is_dropped(self):
        self.a.LOGIN_TTL = 2  # passed to the detached helper in helper.json
        r, d = self.start_device("codex")
        done = self.req(op="login.finish", loginId=r["loginId"])
        self.assertEqual(done, {"ok": False, "error": "This sign-in code expired. Start the sign-in again."})

    def test_cancel_stops_the_cli(self):
        r, d = self.start_device("grok")
        info = json.loads((d / "helper.json").read_text())
        self.assertEqual(self.req(op="login.cancel", loginId=r["loginId"]), {"ok": True})
        self.assertFalse(d.exists())
        self.assertTrue(gone(info["pid"]) and gone(info["child"]))
        self.assertIn("expired or was cancelled", self.req(op="login.finish", loginId=r["loginId"])["error"])
        self.approve()  # approving afterwards signs nothing in
        time.sleep(0.5)
        self.assertFalse((self.a.HOMES / "grok" / "auth.json").exists())

    def test_a_new_sign_in_replaces_the_open_one(self):
        first, d1 = self.start_device("codex")
        second, d2 = self.start_device("grok")
        self.assertFalse(d1.exists())
        self.assertTrue(d2.exists())

    def test_logout_forgets_and_stops(self):
        agent = self.make_agent("grok")
        self.assertTrue(self.sign_in_device("grok")["signedIn"])
        self.assertTrue(self.a.running(agent))
        self.assertEqual(self.req(op="logout", harness="grok"), {"ok": True})
        self.assertFalse((self.a.HOMES / "grok" / "auth.json").exists())
        self.assertIsNone(self.a.running(agent))
        self.assertIn("not signed in", self.req(op="start", pubkey=agent.name)["error"])


class DeviceFinishNeverHangs(DeviceBase):
    """login.finish answers pending only while the sign-in can still finish."""
    def test_a_helper_that_died_is_an_error_not_pending_forever(self):
        r, d = self.start_device("codex")
        info = json.loads((d / "helper.json").read_text())
        os.kill(info["pid"], signal.SIGKILL)
        self.assertTrue(gone(info["pid"]))
        self.assertEqual(self.req(op="login.finish", loginId=r["loginId"]),
                         {"ok": False, "error": "The Codex sign-in stopped on this machine. Start the sign-in again."})
        self.assertFalse(d.exists())

    def test_a_sign_in_past_its_lifetime_is_an_error(self):
        r, d = self.start_device("grok")
        info = json.loads((d / "helper.json").read_text())
        info["startedAt"] -= info["ttl"] + 60
        (d / "helper.json").write_text(json.dumps(info))
        self.assertEqual(self.req(op="login.finish", loginId=r["loginId"])["error"],
                         "This sign-in code expired. Start the sign-in again.")

    def test_an_unexpected_helper_failure_is_written_as_the_result(self):
        d = self.a.private_dir(self.a.private_dir(self.a.LOGINS) / ("a" * 16))
        (d / "helper.json").write_text(json.dumps({"harness": "grok", "startedAt": time.time()}))
        def boom(*args): raise UnicodeDecodeError("utf-8", b"", 0, 1, "bad")
        self.a.device_helper = boom
        self.a.login_helper("a" * 16)
        error = "The sign-in failed on this machine. Start the sign-in again."
        self.assertEqual(json.loads((d / "result.json").read_text()), {"ok": False, "error": error})
        self.assertEqual(json.loads((d / "state.json").read_text()), {"error": error})
        self.assertEqual(self.req(op="login.finish", loginId="a" * 16), {"ok": False, "error": error})


class SafeWrites(DeviceBase):
    def test_config_toml_keeps_what_the_cli_wrote_and_is_written_only_on_change(self):
        home = self.a.cli_home("codex")
        path = home / "config.toml"
        path.write_text('model = "gpt-5"\ncli_auth_credentials_store = "keyring"\n\n[projects."/x"]\ntrust_level = "trusted"\n')
        self.a.cli_home("codex")
        text = path.read_text()
        self.assertTrue(text.startswith('cli_auth_credentials_store = "file"\n'))
        self.assertIn('model = "gpt-5"', text)
        self.assertIn('trust_level = "trusted"', text)
        self.assertNotIn("keyring", text)
        mtime = path.stat().st_mtime_ns
        time.sleep(0.01)
        self.a.cli_home("codex")
        self.assertEqual(path.stat().st_mtime_ns, mtime, "unchanged: not rewritten")
        grok = self.a.cli_home("grok") / "config.toml"
        grok.write_text("[cli]\nauto_update = true\ntheme = \"dark\"\n\n[mcp]\nx = 1\n")
        self.a.cli_home("grok")
        self.assertEqual(grok.read_text(), "[cli]\nauto_update = false\ntheme = \"dark\"\n\n[mcp]\nx = 1\n")

    def test_concurrent_private_writes_never_collide(self):
        import threading
        target = self.a.private_dir(self.a.RUN) / "x.json"
        errors = []
        def write(i):
            try:
                for _ in range(50): self.a.write_private(target, str(i))
            except Exception as e: errors.append(e)
        threads = [threading.Thread(target=write, args=(i,)) for i in range(8)]
        for t in threads: t.start()
        for t in threads: t.join()
        self.assertEqual(errors, [])
        self.assertEqual(sorted(p.name for p in self.a.RUN.iterdir()), ["x.json"], "no temporary file left")


class DeviceStatusAndStart(DeviceBase):
    def rows(self):
        return {h["id"]: h for h in self.req(op="machine.status")["harnesses"]}

    def test_signed_out_until_a_sign_in(self):
        rows = self.rows()
        for harness in ("codex", "grok"):
            self.assertEqual((rows[harness]["installed"], rows[harness]["signedIn"]), (True, False))
        self.sign_in_device("codex")
        self.assertEqual((self.rows()["codex"]["signedIn"], self.rows()["codex"]["account"]), (True, "owner@example.com"))

    def test_a_grok_sign_in_is_verified_not_just_a_file(self):
        (self.a.cli_home("grok") / "auth.json").write_text(json.dumps({"tokens": FAKE_CRED + "-revoked"}))
        self.assertFalse(self.rows()["grok"]["signedIn"])
        self.assertTrue(self.a.known_bad("grok"))

    def test_the_codex_check_never_refreshes_the_sign_in(self):
        # Codex's refresh token is used once: a check that refreshed beside a
        # running agent could sign the agent out. Only account/read, without refresh.
        self.sign_in_device("codex")
        (self.home / "codex-calls.txt").unlink(missing_ok=True)
        self.a.run_check("codex")
        calls = [json.loads(line) for line in (self.home / "codex-calls.txt").read_text().splitlines()]
        self.assertEqual([c[0] for c in calls], ["initialize", "initialized", "account/read"])
        self.assertEqual(calls[2][1], {"refreshToken": False})

    def test_status_answers_from_the_last_check_and_starts_at_most_one(self):
        self.sign_in_device("grok")
        spawned = []
        self.a.spawn_check = spawned.append  # a due check goes out of band
        self.a.STATUS_WAIT = 0.3
        self.assertTrue(self.rows()["grok"]["signedIn"])
        self.assertEqual(spawned, [], "a fresh check is not repeated")
        cache = self.a.RUN / "grok-check.json"
        old = json.loads(cache.read_text()); old["at"] -= 3600
        cache.write_text(json.dumps(old))
        t = time.time()
        self.assertTrue(self.rows()["grok"]["signedIn"], "the last answer stands while the check runs")
        self.assertLess(time.time() - t, 3)
        self.assertEqual(spawned, ["grok"])
        # Single flight: a check that finds the lock held returns at once.
        import fcntl
        held = open(self.a.RUN / "grok-check.lock", "a"); fcntl.flock(held, fcntl.LOCK_EX)
        self.a.DEVICE_CHECK["grok"] = lambda: self.fail("a second check ran")
        self.a.run_check("grok")
        held.close()

    def test_the_check_command_runs_detached(self):
        self.sign_in_device("grok")
        (self.a.RUN / "grok-check.json").unlink()
        env = dict(os.environ, HOME=str(self.home), AGENTCTL_HOME=str(self.home))
        subprocess.run([PY, str(AGENTCTL), "check", "grok"], env=env, timeout=60, check=True)
        self.assertTrue(json.loads((self.a.RUN / "grok-check.json").read_text())["ok"])
        out = subprocess.run([PY, str(AGENTCTL), "--caller", "sam", "check", "grok"], input="", env=env, capture_output=True, text=True, timeout=60)
        self.assertFalse(json.loads(out.stdout)["ok"], "not open to a teammate's key")

    def test_a_rejection_expires_and_is_checked_again(self):
        (self.a.cli_home("grok") / "auth.json").write_text(json.dumps({"tokens": FAKE_CRED + "-revoked"}))
        self.a.run_check("grok")
        spawned = []
        self.a.spawn_check = spawned.append
        self.assertTrue(self.a.known_bad("grok"))
        self.assertEqual(spawned, [])
        cache = self.a.RUN / "grok-check.json"
        old = json.loads(cache.read_text()); old["at"] -= self.a.KNOWN_BAD_TTL + 1
        cache.write_text(json.dumps(old))
        self.assertTrue(self.a.known_bad("grok"), "stands until the new check answers")
        self.assertEqual(spawned, ["grok"])

    def test_an_api_key_sign_in_is_not_a_subscription(self):
        (self.a.cli_home("codex") / "auth.json").write_text(json.dumps({"auth_mode": "apikey"}))
        self.assertFalse(self.rows()["codex"]["signedIn"])

    def test_check_is_cached(self):
        self.sign_in_device("grok")
        self.a.DEVICE_CHECK["grok"] = lambda: self.fail("should use the cache")
        self.assertTrue(self.rows()["grok"]["signedIn"])

    def test_start_refuses_when_signed_out(self):
        for harness, label in (("codex", "Codex"), ("grok", "Grok Build")):
            agent = self.make_agent(harness)
            self.assertEqual(self.req(op="start", pubkey=agent.name)["error"],
                             f"{label} is not signed in on this machine. Sign in to {label} from Buzz first.")

    def test_start_passes_the_private_home_and_the_buzz_preset(self):
        self.sign_in_device("grok")
        agent = self.make_agent("grok")
        self.assertTrue(self.req(op="start", pubkey=agent.name)["ok"])
        env = json.loads((agent / "work" / "env.json").read_text())
        self.assertEqual(env["BUZZ_ACP_AGENT_COMMAND"], "grok")
        self.assertEqual(env["BUZZ_ACP_AGENT_ARGS"], "agent,--model,grok-4.7,--reasoning-effort,high,--always-approve,stdio")
        self.assertEqual(env["GROK_HOME"], str(self.a.HOMES / "grok"))
        self.assertIn("auto_update = false", (self.a.HOMES / "grok" / "config.toml").read_text())
        self.sign_in_device("codex")
        agent = self.make_agent("codex")
        self.assertTrue(self.req(op="start", pubkey=agent.name)["ok"])
        env = json.loads((agent / "work" / "env.json").read_text())
        self.assertEqual(env["CODEX_HOME"], str(self.a.HOMES / "codex"))
        self.assertEqual(env["NO_BROWSER"], "1")
        self.assertIn('cli_auth_credentials_store = "file"', (self.a.HOMES / "codex" / "config.toml").read_text())

    def test_codex_runs_with_full_access(self):
        self.sign_in_device("codex")
        agent = self.make_agent("codex")
        self.assertTrue(self.req(op="start", pubkey=agent.name)["ok"])
        env = json.loads((agent / "work" / "env.json").read_text())
        self.assertEqual(env["INITIAL_AGENT_MODE"], "agent-full-access")
        self.assertNotIn("sandbox", (self.a.HOMES / "codex" / "config.toml").read_text(), "the mode decides, not config.toml")

    def test_grok_runs_with_full_access(self):
        self.sign_in_device("grok")
        agent = self.make_agent("grok")
        self.assertTrue(self.req(op="start", pubkey=agent.name)["ok"])
        env = json.loads((agent / "work" / "env.json").read_text())
        self.assertIn("--always-approve", env["BUZZ_ACP_AGENT_ARGS"].split(","))
        self.assertEqual(env["GROK_SANDBOX"], "off")

    def test_supervisor_waits_for_a_sign_in(self):
        agent = self.make_agent("codex")
        self.a.supervise_pass()
        self.assertIsNone(self.a.running(agent))
        self.sign_in_device("codex")
        self.a.stop(agent)
        self.a.supervise_pass()
        self.assertTrue(self.a.running(agent))


class KeyLogin(DeviceBase):
    """Qwen Code on QwenCloud: a pasted API key, checked, kept privately, and
    never on a command line."""
    def test_a_key_sign_in_is_a_link_to_the_key_page_and_a_field(self):
        r, d = self.start_key()
        self.assertEqual(r["url"], "https://docs.qwencloud.com/developer-guides/administration/api-keys")
        self.assertEqual((r["needsCode"], r["flow"]), (True, "key"))
        self.assertGreater(r["expiresAt"], time.time())
        self.assertEqual(stat.S_IMODE(d.stat().st_mode), 0o700)
        info = json.loads((d / "helper.json").read_text())
        self.assertEqual(info["kind"], "key")
        self.assertNotIn("pid", info, "no helper process for a key")
        self.assertEqual(self.http_calls, [], "nothing is asked until a key is pasted")

    def test_an_older_plugin_gets_a_sentence_not_a_field_it_cannot_show(self):
        r = self.req(op="login.start", harness="qwen", flows=["code", "device"])
        self.assertEqual(r, {"ok": False, "error": "Update the Black 4 plugin in Buzz to sign in to Qwen Code from it."})
        self.assertFalse(any(self.a.LOGINS.iterdir()) if self.a.LOGINS.exists() else False)

    def test_a_good_key_is_checked_kept_privately_and_its_agents_start(self):
        agent = self.make_agent("qwen")
        r, d = self.start_key()
        done = self.req(op="login.finish", loginId=r["loginId"], code=f"  {FAKE_QWEN_KEY}\n")
        self.assertEqual(done, {"ok": True, "signedIn": True, "account": None})
        self.assertFalse(d.exists())
        secret = self.a.SECRETS / "qwen"
        self.assertEqual(secret.read_text().strip(), FAKE_QWEN_KEY)
        self.assertEqual(stat.S_IMODE(secret.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.a.SECRETS.stat().st_mode), 0o700)
        info = json.loads((self.a.SECRETS / "qwen.json").read_text())
        self.assertEqual((info["base"], info["plan"]), (QWEN_BASE, "pay-as-you-go"))
        self.assertNotIn(FAKE_QWEN_KEY, json.dumps(info))
        self.assertEqual(self.http_calls[0], (QWEN_BASE + "/models", FAKE_QWEN_KEY), "the pay-as-you-go base first")
        self.assertTrue(all(FAKE_QWEN_KEY not in url for url, _ in self.http_calls), "the key is never in a URL")
        rows = {h["id"]: h for h in self.req(op="machine.status")["harnesses"]}
        self.assertEqual((rows["qwen"]["signedIn"], rows["qwen"]["account"], rows["qwen"]["signIn"]), (True, None, "key"))
        self.assertTrue(self.wait_running(agent))
        env = json.loads((agent / "work" / "env.json").read_text())
        self.assertEqual(env["BUZZ_ACP_AGENT_COMMAND"], "qwen")
        self.assertEqual(env["BUZZ_ACP_AGENT_ARGS"], "--acp,--approval-mode,yolo,--auth-type,openai")
        self.assertEqual(env["OPENAI_API_KEY"], FAKE_QWEN_KEY)
        self.assertEqual(env["OPENAI_BASE_URL"], QWEN_BASE)
        self.assertEqual(env["OPENAI_MODEL"], "qwen4-max")
        self.assertEqual(env["QWEN_HOME"], str(self.a.HOMES / "qwen"))
        self.assertNotIn(FAKE_QWEN_KEY, env["BUZZ_ACP_AGENT_ARGS"])
        self.assertEqual([k for k, v in env.items() if FAKE_QWEN_KEY in v], ["OPENAI_API_KEY"], "the key is in one place")
        self.assertEqual(stat.S_IMODE((self.a.HOMES / "qwen").stat().st_mode), 0o700)
        settings = json.loads((self.a.HOMES / "qwen" / "settings.json").read_text())
        self.assertFalse(settings["general"]["enableAutoUpdate"])
        self.assertFalse(settings["privacy"]["usageStatisticsEnabled"])
        self.assertFalse(settings["telemetry"]["enabled"])
        self.assertEqual(settings["memory"], {"enableManagedAutoMemory": False, "enableManagedAutoDream": False},
                         "no shared memory folder, no second model call per turn")
        self.assertFalse((self.home / ".qwen").exists(), "never the machine user's own ~/.qwen")

    def test_the_private_home_keeps_what_qwen_code_wrote_there(self):
        home = self.a.private_dir(self.a.HOMES / "qwen")
        (home / "settings.json").write_text(json.dumps({"general": {"enableAutoUpdate": True, "vimMode": True}, "ui": {"theme": "dark"}}))
        self.a.key_home("qwen")
        settings = json.loads((home / "settings.json").read_text())
        self.assertEqual(settings["general"], {"enableAutoUpdate": False, "vimMode": True})
        self.assertEqual(settings["ui"], {"theme": "dark"})
        before = (home / "settings.json").stat().st_mtime_ns
        self.a.key_home("qwen")
        self.assertEqual((home / "settings.json").stat().st_mtime_ns, before, "written only when it changes")

    def test_a_token_plan_key_is_kept_for_its_own_base(self):
        self.assertTrue(self.sign_in_key(FAKE_QWEN_PLAN_KEY)["signedIn"])
        info = json.loads((self.a.SECRETS / "qwen.json").read_text())
        self.assertEqual((info["base"], info["plan"]), (QWEN_PLAN_BASE, "token-plan"))
        self.assertEqual([url for url, _ in self.http_calls[:2]], [QWEN_BASE + "/models", QWEN_PLAN_BASE + "/models"])
        agent = self.make_agent("qwen")
        self.assertTrue(self.req(op="start", pubkey=agent.name)["ok"])
        env = json.loads((agent / "work" / "env.json").read_text())
        self.assertEqual(env["OPENAI_BASE_URL"], QWEN_PLAN_BASE)

    def test_a_refused_key_says_so_and_the_sign_in_stays_open(self):
        r, d = self.start_key()
        bad = self.req(op="login.finish", loginId=r["loginId"], code="sk-not-the-right-key-000000000000")
        self.assertEqual(bad["error"], "QwenCloud did not accept that key. Check it and paste it again.")
        self.assertTrue(d.exists(), "paste again, no new link needed")
        self.assertFalse((self.a.SECRETS / "qwen").exists())
        self.assertEqual(len(self.http_calls), 2, "both bases were tried")
        good = self.req(op="login.finish", loginId=r["loginId"], code=FAKE_QWEN_KEY)
        self.assertTrue(good["signedIn"])
        self.assertFalse(d.exists())

    def test_a_key_that_cannot_be_checked_is_not_kept(self):
        r, d = self.start_key()
        for key in ("sk-offline-no-answer-00000000000", "sk-broken-upstream-000000000000"):
            with self.subTest(key=key):
                bad = self.req(op="login.finish", loginId=r["loginId"], code=key)
                self.assertEqual(bad["error"], "QwenCloud could not be reached to check the key. Try again in a moment.")
                self.assertTrue(d.exists())
                self.assertFalse((self.a.SECRETS / "qwen").exists())

    def test_what_is_not_a_key_is_refused_before_any_request(self):
        r, d = self.start_key()
        for pasted in ("", "short", "sk-has a space-000000000000000", "sk-has\ttab-00000000000000000", "k" * 600, None):
            with self.subTest(pasted=pasted):
                bad = self.req(op="login.finish", loginId=r["loginId"], code=pasted)
                self.assertEqual(bad["error"], "That does not look like an API key. Copy the whole key from the QwenCloud page and paste it again.")
        self.assertEqual(self.http_calls, [])
        self.assertTrue(d.exists())

    def test_a_key_sign_in_stays_open_for_its_lifetime_then_expires(self):
        r, d = self.start_key()
        self.a.cleanup_logins(now=time.time() + 300)
        self.assertTrue(d.exists(), "no helper to be dead: it waits for the key")
        self.a.cleanup_logins(now=time.time() + self.a.LOGIN_TTL + 5)
        self.assertFalse(d.exists())
        self.assertIn("expired or was cancelled", self.req(op="login.finish", loginId=r["loginId"], code=FAKE_QWEN_KEY)["error"])
        r, d = self.start_key()
        (d / "helper.json").write_text(json.dumps({"harness": "qwen", "kind": "key", "startedAt": time.time() - self.a.LOGIN_TTL - 1, "ttl": self.a.LOGIN_TTL}))
        self.assertEqual(self.req(op="login.finish", loginId=r["loginId"], code=FAKE_QWEN_KEY)["error"], "This sign-in expired. Start the sign-in again.")
        self.assertFalse(d.exists())
        self.assertEqual(self.http_calls, [])

    def test_start_refuses_while_signed_out(self):
        agent = self.make_agent("qwen")
        self.assertEqual(self.req(op="start", pubkey=agent.name)["error"],
                         "Qwen Code is not signed in on this machine. Sign in to Qwen Code from Buzz first.")
        self.a.supervise_pass()
        self.assertIsNone(self.a.running(agent), "the supervisor waits for a sign-in")

    def test_logout_forgets_the_key_and_stops_its_agents(self):
        agent = self.make_agent("qwen")
        self.assertTrue(self.sign_in_key()["signedIn"])
        self.assertTrue(self.wait_running(agent))
        self.assertEqual(self.req(op="logout", harness="qwen"), {"ok": True})
        for name in ("qwen", "qwen.json"): self.assertFalse((self.a.SECRETS / name).exists())
        self.assertFalse((self.a.RUN / "qwen-models.json").exists())
        self.assertIsNone(self.a.running(agent))
        rows = {h["id"]: h for h in self.req(op="machine.status")["harnesses"]}
        self.assertFalse(rows["qwen"]["signedIn"])
        self.assertIn("not signed in", self.req(op="start", pubkey=agent.name)["error"])

    def test_a_key_qwencloud_no_longer_takes_shows_in_the_check_and_blocks_start(self):
        self.assertTrue(self.sign_in_key()["signedIn"])
        self.assertTrue(json.loads((self.a.RUN / "qwen-check.json").read_text())["ok"])
        (self.home / "qwen-revoked.txt").write_text("x")
        (self.a.RUN / "qwen-check.json").unlink()
        rows = {h["id"]: h for h in self.req(op="machine.status")["harnesses"]}
        self.assertFalse(rows["qwen"]["signedIn"])
        self.assertTrue(self.a.known_bad("qwen"))
        agent = self.make_agent("qwen")
        self.assertIn("not signed in", self.req(op="start", pubkey=agent.name)["error"])
        self.assertTrue(all(url.endswith("/models") for url, _ in self.http_calls), "the check calls no model")

    def test_a_qwen_agent_is_told_how_to_reach_its_deferred_black4_tools(self):
        note = self.a.DEFERRED_MCP_NOTE["qwen"]
        self.assertIn("tool_search", note)
        self.assertIn("mcp__black4__", note)
        home = self.a.key_home("qwen")
        context = home / "QWEN.md"
        self.assertEqual(context.read_text(), note, "Qwen Code reads QWEN.md in its home into every session")
        self.assertEqual(stat.S_IMODE(context.stat().st_mode), 0o600)
        self.a.key_home("qwen")
        self.assertEqual(context.read_text(), note)
        self.assertIn("tool_search", self.a.heartbeat_prompt({"name": "Q", "model": "qwen4-max"}))

    def test_a_teammate_may_sign_qwen_in_while_it_is_signed_out_only(self):
        self.a.CALLER = "sam"
        self.assertTrue(self.sign_in_key()["signedIn"])
        self.assertIn("already signed in", self.req(op="login.start", harness="qwen", flows=["key"])["error"])
        self.assertEqual(self.req(op="logout", harness="qwen")["error"], "Only a Black 4 admin can sign this machine out.")

    def test_doctor_says_what_a_new_qwen_agent_runs_with_no_effort(self):
        self.assertTrue(self.sign_in_key()["signedIn"])
        out = io.StringIO()
        with contextlib.redirect_stdout(out): self.a.print_doctor()
        self.assertIn("Qwen Code: ready; full access (--approval-mode yolo, no sandbox); new agents run qwen4-max\n", out.getvalue())
        self.assertNotIn(FAKE_QWEN_KEY, out.getvalue())


def install_pinned(a, home):
    """Lays out what setup.sh installs, at the versions in machine/pins.json."""
    pins = json.loads((AGENTCTL.parent / "pins.json").read_text())
    (a.ROOT / "pins.json").write_text(json.dumps(pins))
    buzz = a.VENDOR / f"buzz-{pins['harness']['release']}"
    buzz.mkdir(parents=True)
    (a.BIN / "buzz-acp").rename(buzz / "buzz-acp")
    (a.BIN / "buzz-acp").symlink_to(buzz / "buzz-acp")
    def package(parts, version, folder="acp"):
        d = a.VENDOR / folder / "node_modules" / parts
        d.mkdir(parents=True, exist_ok=True)
        (d / "package.json").write_text(json.dumps({"version": version}))
    package("@qwen-code/qwen-code", pins["clis"]["@qwen-code/qwen-code"]["version"], folder="qwen-code")
    for name, pin in pins["adapters"].items():
        package(name, pin["version"])
    (a.VENDOR / "acp/node_modules/@agentclientprotocol/codex-acp/dist").mkdir()
    (a.VENDOR / "acp/node_modules/@agentclientprotocol/codex-acp/dist/index.js").write_text('static AgentFullAccess = new _AgentMode(\n    "agent-full-access",\n')
    package("@agentclientprotocol/sdk", pins["adapters"]["@agentclientprotocol/claude-agent-acp"]["sdk"])
    package("@agentclientprotocol/codex-acp/node_modules/@agentclientprotocol/sdk", pins["adapters"]["@agentclientprotocol/codex-acp"]["sdk"])
    package("@openai/codex", pins["clis"]["@openai/codex"]["version"])
    grok = a.VENDOR / f"grok-{pins['clis']['grok']['version']}"
    grok.mkdir()
    if (a.BIN / "grok").exists():
        (a.BIN / "grok").rename(grok / "grok")
        (a.BIN / "grok").symlink_to(grok / "grok")
    (a.ROOT / "mcp").mkdir()
    write_exe(a.ROOT / "mcp" / "black4", "#!/bin/sh\nexit 0\n")
    return pins


class Health(DeviceBase):
    """doctor, and the per-harness `problem` that machine.status and start use."""
    def setUp(self):
        super().setUp()
        self.pins = install_pinned(self.a, self.home)

    def rows(self, op="machine.status"):
        return {h["id"]: h for h in self.req(op=op)["harnesses"]}

    def test_a_pinned_install_is_healthy_and_signing_in_makes_a_harness_ready(self):
        r = self.req(op="doctor")
        self.assertTrue(r["healthy"], r["problems"])
        self.assertEqual(r["problems"], [])
        self.assertEqual((r["connector"], r["cron"]), (True, "not needed"))
        self.assertGreater(r["diskFreeGB"], 0)
        rows = {h["id"]: h for h in r["harnesses"]}
        self.assertNotIn("problem", rows["claude"])
        self.assertFalse(rows["claude"]["ready"], "signed out: healthy, not ready")
        self.sign_in()
        self.assertTrue(self.rows("doctor")["claude"]["ready"])

    def test_a_version_off_its_pin_is_a_problem_that_blocks_start(self):
        (self.a.VENDOR / "acp/node_modules/@agentclientprotocol/codex-acp/node_modules/@agentclientprotocol/sdk/package.json").write_text('{"version": "2.0.1"}')
        problem = self.rows()["codex"]["problem"]
        self.assertEqual(problem, "its ACP SDK is 2.0.1, pinned 1.9.0")
        self.assertNotIn("problem", self.rows()["claude"])
        r = self.req(op="doctor")
        self.assertFalse(r["healthy"])
        self.assertIn("Codex: its ACP SDK is 2.0.1, pinned 1.9.0.", r["problems"])
        self.sign_in_device("codex")
        agent = self.make_agent("codex")
        self.assertEqual(self.req(op="start", pubkey=agent.name)["error"],
                         "Codex cannot run on this machine: its ACP SDK is 2.0.1, pinned 1.9.0.")

    def test_a_qwen_code_off_its_pin_is_a_problem_that_blocks_start(self):
        (self.a.VENDOR / "qwen-code/node_modules/@qwen-code/qwen-code/package.json").write_text('{"version": "0.27.3"}')
        self.assertEqual(self.rows()["qwen"]["problem"], "@qwen-code/qwen-code is 0.27.3, pinned 0.27.4")
        self.assertIn("Qwen Code: @qwen-code/qwen-code is 0.27.3, pinned 0.27.4.", self.req(op="doctor")["problems"])
        self.sign_in_key()
        agent = self.make_agent("qwen")
        self.assertEqual(self.req(op="start", pubkey=agent.name)["error"],
                         "Qwen Code cannot run on this machine: @qwen-code/qwen-code is 0.27.3, pinned 0.27.4.")

    def test_the_handshake_with_qwen_code_runs_in_its_private_home(self):
        self.assertNotIn("problem", self.rows()["qwen"])
        self.assertIn("qwen", (self.home / "handshakes.txt").read_text().split())
        self.assertTrue((self.a.HOMES / "qwen" / "settings.json").exists())
        self.assertFalse((self.home / ".qwen").exists())

    def test_doctor_reports_each_harness_runs_with_full_access(self):
        rows = self.rows("doctor")
        for harness in ("claude", "codex", "grok", "qwen", "goose"):
            self.assertTrue(rows[harness]["access"].startswith("full access"), rows[harness])
        out = io.StringIO()
        with contextlib.redirect_stdout(out): self.a.print_doctor()
        self.assertIn("Codex: signed out; full access (agent-full-access", out.getvalue())

    def test_a_codex_adapter_without_the_full_access_mode_is_a_problem(self):
        (self.a.VENDOR / "acp/node_modules/@agentclientprotocol/codex-acp/dist/index.js").write_text('static Agent = new _AgentMode("agent",')
        self.assertEqual(self.rows()["codex"]["problem"], "@agentclientprotocol/codex-acp has no agent-full-access mode")

    def test_a_failed_handshake_is_a_problem_and_a_good_one_is_remembered(self):
        (self.home / "handshake-fail.txt").write_text("x")
        self.assertEqual(self.rows()["claude"]["problem"],
                         "claude-agent-acp failed buzz-acp's ACP handshake: error: initialize failed: -32602 Invalid params")
        self.sign_in()
        agent = self.make_agent()
        self.assertIn("failed buzz-acp's ACP handshake", self.req(op="start", pubkey=agent.name)["error"])
        self.assertIsNone(self.a.running(agent), "never started an agent that cannot answer")
        (self.home / "handshake-fail.txt").unlink()
        self.assertNotIn("problem", self.rows()["claude"])
        (self.home / "handshakes.txt").unlink()
        self.rows()
        self.assertFalse((self.home / "handshakes.txt").exists(), "remembered while buzz-acp and the adapter are unchanged")
        os.utime(self.a.BIN / "claude-agent-acp", (1, 1))
        self.rows()
        self.assertIn("claude-agent-acp", (self.home / "handshakes.txt").read_text().split())

    def test_machine_wide_problems(self):
        (self.a.ROOT / "mcp" / "black4").unlink()
        (self.a.ROOT / "pins.json").unlink()
        self.make_agent()  # activated, and no cron lines
        r = self.req(op="doctor")
        self.assertFalse(r["healthy"])
        self.assertEqual(r["cron"], "missing")
        self.assertEqual(r["problems"], [
            "pins.json is missing; run machine/deploy.sh again.",
            "The Black 4 connector (mcp/black4) is missing; run machine/deploy.sh again.",
            "The cron lines that bring agents back after a reboot are missing; start any agent to restore them."])
        self.crontab = "\n".join(self.a.cron_lines()) + "\n"
        self.assertEqual(self.req(op="doctor")["cron"], "present")
        self.a.DISK_MIN_GB = 10 ** 9
        self.assertTrue(self.req(op="doctor")["problems"][-1].endswith("GB of disk is free."))

    def test_agentctl_doctor_prints_and_exits_nonzero_when_unhealthy(self):
        import io, contextlib
        out = io.StringIO()
        with contextlib.redirect_stdout(out): code = self.a.print_doctor()
        self.assertEqual(code, 0)
        self.assertIn("Claude Code: signed out", out.getvalue())
        self.assertTrue(out.getvalue().rstrip().endswith("doctor: healthy"))
        self.sign_in_device("codex")
        (self.a.ROOT / "mcp" / "black4").unlink()
        out = io.StringIO()
        with contextlib.redirect_stdout(out): code = self.a.print_doctor()
        self.assertEqual(code, 1)
        self.assertIn("Codex: ready", out.getvalue())
        self.assertNotIn("owner@example.com", out.getvalue(), "no account is printed")
        self.assertIn("PROBLEM: The Black 4 connector", out.getvalue())

    def test_callers_may_run_doctor_but_not_as_a_command(self):
        env = dict(os.environ, HOME=str(self.home), AGENTCTL_HOME=str(self.home))
        out = subprocess.run([PY, str(AGENTCTL), "--caller", "sam", "doctor"], input="", capture_output=True, text=True, env=env, timeout=60)
        self.assertFalse(json.loads(out.stdout)["ok"])


class Restarts(Base):
    """A crashing agent: the supervisor backs off and status says it keeps stopping."""
    def test_a_crash_loop_backs_off_and_status_says_it_keeps_stopping(self):
        self.sign_in()
        d = self.make_agent()
        (self.home / "crash.txt").write_text("x")
        t = 1_000_000.0
        delays = []
        for _ in range(4):
            self.a.supervise_pass(now=t)
            r = self.a.restarts(d)
            delays.append(r["delay"])
            self.a.supervise_pass(now=t + r["delay"] - 1)  # too soon: no new try
            self.assertEqual(self.a.restarts(d)["count"], len(delays))
            t += r["delay"]
        self.assertEqual(delays, [5, 10, 20, 40])
        status = self.req(op="status", pubkey=d.name)
        self.assertEqual((status["running"], status["keepsStopping"], status["restarts"]), (False, True, 4))
        self.assertEqual(status["nextRestart"], int(t))
        self.assertIn("relay refused the connection", status["log"])
        self.assertTrue(self.req(op="list")["agents"][0]["keepsStopping"])
        for _ in range(10):
            self.a.supervise_pass(now=t)
            t += self.a.restarts(d)["delay"]
        self.assertEqual(self.a.restarts(d)["delay"], 300, "never faster than every 5 minutes")

    def test_a_start_asked_for_in_person_starts_over_and_a_healthy_agent_is_forgiven(self):
        self.sign_in()
        d = self.make_agent()
        (self.home / "crash.txt").write_text("x")
        for i in range(3): self.a.supervise_pass(now=1_000_000.0 + 1000 * i)
        self.assertTrue(self.a.keeps_stopping(d))
        (self.home / "crash.txt").unlink()
        self.assertTrue(self.req(op="start", pubkey=d.name)["ok"])
        self.assertEqual(self.a.restarts(d), {})
        self.a.stop(d)
        self.a.supervise_pass(now=2_000_000.0)
        self.assertTrue(self.a.running(d))
        self.assertEqual(self.a.restarts(d)["count"], 1)
        self.a.supervise_pass(now=2_000_000.0 + 301)
        self.assertEqual(self.a.restarts(d), {}, "up 5 minutes: the count starts over")

    def test_the_reboot_line_brings_agents_back(self):
        # After a reboot nothing runs; cron's @reboot line runs `agentctl supervise`.
        self.sign_in()
        d = self.make_agent()
        reboot = self.a.cron_lines()[0]
        self.assertTrue(reboot.startswith("@reboot ") and " supervise " in reboot)
        self.a.supervise(passes=1)
        self.assertTrue(self.a.running(d))


class Logs(Base):
    def test_agent_log_is_cut_over_once_and_the_agent_keeps_writing(self):
        d = self.a.AGENTS / ("e" * 64)
        d.mkdir(parents=True)
        log = d / "agent.log"
        writer = open(log, "ab")  # how buzz-acp holds it
        writer.write(b"old line\n" * 10); writer.flush()
        self.a.cap_log(log, 50)
        self.assertEqual(log.stat().st_size, 0)
        self.assertEqual((d / "agent.log.1").read_bytes(), b"old line\n" * 10)
        writer.write(b"new line\n"); writer.flush(); writer.close()
        self.assertEqual(log.read_bytes(), b"new line\n", "appends land at the start of the emptied file")
        self.assertEqual(self.a.log_tail(d, 18), "old line\nnew line\n")
        self.a.cap_log(log, 50)
        self.assertEqual(log.read_bytes(), b"new line\n", "under the cap: untouched")
        (d / "agent.log").write_bytes(b"\x1b[2m2026\x1b[0m \x1b[33m WARN\x1b[0m relay\n")
        self.assertEqual(self.a.log_tail(d, 17), "2026  WARN relay\n", "no terminal colours")

    def test_the_supervisor_caps_every_agent_log(self):
        d = self.make_agent(activate=False)
        (d / "agent.log").write_bytes(b"x" * (self.a.AGENT_LOG_CAP + 1))
        self.a.supervise_pass()
        self.assertEqual((d / "agent.log").stat().st_size, 0)
        self.assertEqual((d / "agent.log.1").stat().st_size, self.a.AGENT_LOG_CAP + 1)

    def test_run_logs_are_capped(self):
        self.a.RUN_LOG_CAP = 100
        for i in range(20): self.a.log_line("supervisor", f"line {i:04d} " + "-" * 10)
        self.assertLessEqual((self.a.RUN / "supervisor.log").stat().st_size, 100 + 40)
        self.assertTrue((self.a.RUN / "supervisor.log.1").exists())


class SecondRoot(unittest.TestCase):
    """BLACK4_WORKFORCE_ROOT: a dev runner beside the real one."""
    def setUp(self):
        self.a = load()

    def test_paths_and_cron_mark_follow_the_root(self):
        self.a.set_root("/Users/m", "workforce-dev")
        self.assertEqual(self.a.ROOT, Path("/Users/m/workforce-dev"))
        self.assertEqual(self.a.HOMES, Path("/Users/m/workforce-dev/homes"))
        self.assertEqual(self.a.root_env(), {"BLACK4_WORKFORCE_ROOT": "/Users/m/workforce-dev"})
        lines = self.a.cron_lines()
        self.assertTrue(all("BLACK4_WORKFORCE_ROOT=/Users/m/workforce-dev " in line for line in lines))
        # A released runner drops every crontab line containing its mark.
        self.assertTrue(all("# black4-workforce" not in line for line in lines))

    def test_each_root_keeps_the_others_cron_lines(self):
        self.a.set_root("/Users/m")
        real = self.a.cron_lines()
        self.assertEqual(self.a.root_env(), {})
        self.a.set_root("/Users/m", "/Users/m/workforce-dev")
        dev = self.a.cron_lines()
        both = self.a.merged_crontab("\n".join(real) + "\n", True)
        self.assertEqual(both.splitlines(), real + dev)
        self.assertEqual(self.a.merged_crontab(both, False).splitlines(), real)
        self.a.set_root("/Users/m")
        self.assertEqual(self.a.merged_crontab(both, False).splitlines(), dev)


class SetupPins(unittest.TestCase):
    """machine/setup.sh must install adapters whose ACP SDK accepts the initialize
    that the vendored buzz-acp (Buzz 0.5.30) sends: protocolVersion 2 with
    `clientInfo`. @agentclientprotocol/sdk 2.0.1+ rejects it with -32602, and
    every agent then fails to start. SDK 2.0.0 and 1.x negotiate down to v1."""

    def setUp(self):
        text = (AGENTCTL.parent / "setup.sh").read_text()
        self.pins = dict(re.findall(r"^([A-Z][A-Z0-9_]*)=(\S+)", text, re.M))
        self.text = text

    @staticmethod
    def version(v):
        return tuple(int(x) for x in v.split("."))

    def test_sdk_pins_speak_buzz_acp_protocol(self):
        for key in ("CLAUDE_ACP_SDK", "CODEX_ACP_SDK"):
            self.assertLessEqual(self.version(self.pins[key]), (2, 0, 0), key)

    def test_adapters_are_the_known_good_versions(self):
        self.assertEqual(self.pins["CLAUDE_ACP_VERSION"], "0.94.0")
        self.assertEqual(self.pins["CODEX_ACP_VERSION"], "2.2.2")
        self.assertEqual(self.pins["CODEX_CLI_VERSION"], "0.160.1")
        self.assertEqual(self.pins["GROK_VERSION"], "1.0.70")
        self.assertEqual(self.pins["QWEN_CODE_VERSION"], "0.27.4")

    def test_qwen_code_is_installed_in_its_own_folder_where_agentctl_looks(self):
        self.assertIn('"@qwen-code/qwen-code": "$QWEN_CODE_VERSION"', self.text)
        self.assertIn('QWEN_DIR="$VENDOR/qwen-code"', self.text)
        self.assertIn('ln -sfn "$QWEN_DIR/node_modules/.bin/qwen" "$BIN/qwen"', self.text)
        self.assertNotIn("qwen", self.text[self.text.index('"name": "workforce-acp"'):self.text.index("npm install --prefix \"$ACP_DIR\"")],
                         "never in the adapters' package.json: that reinstalls them under running agents")

    def test_grok_download_is_checked_and_never_updates_itself(self):
        self.assertRegex(self.pins["GROK_SHA256"], r"^[0-9a-f]{64}$")
        self.assertIn('[ "$got" = "$GROK_SHA256" ]', self.text)
        self.assertIn('"@openai/codex": "$CODEX_CLI_VERSION"', self.text)

    def test_sdk_is_forced_with_overrides(self):
        self.assertIn('"overrides"', self.text)
        self.assertIn('"@agentclientprotocol/sdk": "$CLAUDE_ACP_SDK"', self.text)
        self.assertIn('"@agentclientprotocol/sdk": "$CODEX_ACP_SDK"', self.text)

    def test_connector_is_installed_from_its_lockfile_where_agentctl_looks(self):
        self.assertIn('npm ci --omit=dev', self.text)
        self.assertIn('package-lock.json', self.text)
        self.assertIn('"$ROOT/mcp/black4"', self.text)
        a = load()
        a.set_root("/h")
        self.assertEqual(str(a.BLACK4_MCP), "/h/workforce/mcp/black4")
        lock = json.loads((AGENTCTL.parent.parent / "bridge" / "black4-agent-mcp" / "package-lock.json").read_text())
        curves = lock["packages"]["node_modules/@noble/curves"]
        self.assertEqual(curves["version"], "2.0.1")
        self.assertTrue(curves["integrity"].startswith("sha512-"))


# The shapes Codex 0.160.1 and Grok 1.0.70 write to models_cache.json in their
# homes (fields agentctl does not read left out).
CODEX_MODELS = {"client_version": "0.160.1", "models": [
    {"slug": "gpt-6.1-sol", "display_name": "GPT-6.1-Sol", "visibility": "list", "priority": 1, "default_reasoning_level": "low",
     "supported_reasoning_levels": [{"effort": e} for e in ("low", "medium", "high", "xhigh", "max", "ultra")]},
    {"slug": "gpt-6-astra", "display_name": "GPT-6-Astra", "visibility": "list", "priority": 2, "default_reasoning_level": "medium",
     "supported_reasoning_levels": [{"effort": e} for e in ("low", "medium", "high", "xhigh", "max", "ultra")]},
    {"slug": "gpt-6-luna", "display_name": "GPT-6-Luna", "visibility": "list", "priority": 6,
     "supported_reasoning_levels": [{"effort": e} for e in ("low", "medium", "high", "xhigh", "max")]},
    {"slug": "codex-auto-review", "display_name": "Codex Auto Review", "visibility": "hide", "priority": 10,
     "supported_reasoning_levels": [{"effort": "medium"}]},
]}
GROK_MODELS = {"grok_version": "1.0.70", "models": {
    "grok-4.7": {"info": {"id": "grok-4.7", "name": "Grok 4.7", "hidden": False, "supports_reasoning_effort": True,
                          "reasoning_efforts": [{"value": e} for e in ("xhigh", "high", "medium", "low")]}},
    "grok-4.5": {"info": {"id": "grok-4.5", "name": "Grok 4.5", "hidden": False, "supports_reasoning_effort": True,
                          "reasoning_efforts": [{"value": e} for e in ("medium", "low")]}},
    "grok-secret": {"info": {"id": "grok-secret", "name": "Hidden", "hidden": True}},
}}


class ModelAndEffort(DeviceBase):
    """Each agent's model and effort: what each harness offers, the defaults,
    how each harness is told, and refusing what it does not offer."""
    def setUp(self):
        super().setUp()
        for harness, cache in (("codex", CODEX_MODELS), ("grok", GROK_MODELS)):
            home = self.a.private_dir(self.a.HOMES / harness)
            (home / "models_cache.json").write_text(json.dumps(cache))
            (home / "auth.json").write_text(json.dumps({"tokens": {"access_token": FAKE_CRED}}))
        self.sign_in()
        # The out-of-band listings, made in this process.
        self.a.spawn_models_refresh = lambda harness="claude": self.a.refresh_models(harness)
        self.a.MODELS_WAIT = 2

    def listed(self):
        self.a.refresh_claude_models(wait=True)

    def env_of(self, agent):
        self.assertTrue(self.req(op="start", pubkey=agent.name)["ok"])
        return json.loads((agent / "work" / "env.json").read_text())

    def test_each_harness_offers_what_its_own_listing_says(self):
        r = self.req(op="models")
        rows = {h["id"]: h for h in r["harnesses"]}
        self.assertEqual(set(rows), {"claude", "codex", "grok", "qwen"}, "Goose takes no model")
        self.assertEqual((rows["qwen"]["models"], rows["qwen"]["checked"]), ([], False), "no key yet: nothing to list")
        self.assertEqual([m["id"] for m in rows["claude"]["models"]], ["claude-fable-5-2", "sonnet", "fable", "opus", "haiku"])
        self.assertEqual(rows["claude"]["models"][0]["label"], "Fable 5.2")
        self.assertEqual(rows["claude"]["models"][0]["efforts"], ["low", "medium", "high", "xhigh", "max"])
        self.assertEqual([m["id"] for m in rows["codex"]["models"]], ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"], "hidden rows left out")
        self.assertEqual(rows["codex"]["models"][2]["efforts"], ["low", "medium", "high", "xhigh", "max"])
        self.assertEqual([m["id"] for m in rows["grok"]["models"]], ["grok-4.7", "grok-4.5"])
        self.assertEqual(rows["grok"]["models"][0]["efforts"], ["low", "medium", "high", "xhigh"], "least to most")
        for hid, model in (("claude", "claude-fable-5-2"), ("codex", "gpt-6-astra"), ("grok", "grok-4.7")):
            self.assertEqual((rows[hid]["model"], rows[hid]["effort"], rows[hid]["checked"]), (model, "high", True))
            self.assertNotIn("note", rows[hid])

    def test_qwen_offers_the_chat_models_qwencloud_lists_for_the_key_with_no_effort(self):
        self.assertTrue(self.sign_in_key()["signedIn"])
        row = next(h for h in self.req(op="models")["harnesses"] if h["id"] == "qwen")
        self.assertEqual([m["id"] for m in row["models"]], ["qwen4-max", "qwen3.8-max", "qwen3.7-plus"],
                         "the defaults first, then QwenCloud's order; embeddings, vision, speech and other makers' models left out")
        self.assertTrue(all(m["efforts"] == [] for m in row["models"]), "Qwen Code 0.27.4 has no effort lever for an environment model")
        self.assertEqual((row["model"], row["effort"], row["checked"]), ("qwen4-max", None, True))
        self.assertNotIn("note", row, "no effort is not a shortfall for Qwen")
        self.assertEqual(self.req(op="provision", name="Q", community="wss://r.example.com", config={"harness": "qwen", "effort": "high"})["error"],
                         "qwen4-max does not take the effort high. Choose another effort for this agent.")
        self.assertIn("does not offer the model qwen4-max-preview",
                      self.req(op="provision", name="Q", community="wss://r.example.com", config={"harness": "qwen", "model": "qwen4-max-preview"})["error"])
        agent = self.make_agent("qwen")
        self.assertTrue(self.req(op="settings.set", pubkey=agent.name, model="qwen3.7-plus")["ok"])
        env = json.loads((agent / "work" / "env.json").read_text())
        self.assertEqual(env["OPENAI_MODEL"], "qwen3.7-plus")
        self.assertEqual(json.loads((agent / "launch.json").read_text()), {"model": "qwen3.7-plus", "effort": None, "note": None, "checked": True})
        st = self.req(op="status", pubkey=agent.name)
        self.assertEqual((st["model"], st["effort"], st["modelChosen"], st["effortChosen"]), ("qwen3.7-plus", None, True, False))
        self.assertNotIn("modelNote", st)
        self.assertEqual([url for url, _ in self.http_calls].count(QWEN_BASE + "/models"), 2, "one check, one listing; cached after")

    def test_a_qwen_listing_that_fails_keeps_the_last_one_and_the_default_still_applies(self):
        self.assertTrue(self.sign_in_key()["signedIn"])
        self.assertEqual([m["id"] for m in self.a.offered("qwen")][:1], ["qwen4-max"])
        (self.a.RUN / "qwen-models.json").unlink()
        (self.home / "qwen-revoked.txt").write_text("x")  # the service says no for a while
        self.a.refresh_models("qwen", wait=True)
        self.assertIsNone(self.a.offered("qwen"))
        cache = json.loads((self.a.RUN / "qwen-models.json").read_text())
        self.assertEqual(cache["fails"], 1)
        self.assertGreater(cache["retryAt"], time.time())
        (self.a.RUN / "qwen-check.json").write_text(json.dumps({"hash": self.a.credential("qwen"), "ok": True, "at": time.time()}))
        env = self.env_of(self.make_agent("qwen"))
        self.assertEqual(env["OPENAI_MODEL"], "qwen4-max", "unchecked: the first default still starts")

    def test_fable_5_2_is_offered_only_when_it_answers_on_this_sign_in(self):
        (self.home / "refuse-claude-fable-5-2").write_text("x")
        row = next(h for h in self.req(op="models")["harnesses"] if h["id"] == "claude")
        self.assertNotIn("claude-fable-5-2", [m["id"] for m in row["models"]])
        self.assertEqual((row["model"], row["effort"]), ("fable", "high"))
        self.assertEqual(row["note"], "claude-fable-5-2 is not offered here; fable runs instead.")

    def test_a_busy_api_proves_nothing_and_the_default_still_applies(self):
        (self.home / "busy-claude-fable-5-2").write_text("x")
        self.listed()
        self.assertIsNone(self.a.offered("claude"), "a 429 is not 'not offered'")
        env = self.env_of(self.make_agent("claude"))
        self.assertEqual(env["ANTHROPIC_MODEL"], "claude-fable-5-2", "never 5.1 for a day because of one busy reply")

    def test_status_reports_what_a_running_agent_was_started_with(self):
        self.listed()
        agent = self.make_agent("grok")
        self.a.start(agent)
        s = self.a.read_settings(agent); s["model"] = "grok-4.5"; self.a.write_settings(agent, s)  # not restarted
        status = self.req(op="status", pubkey=agent.name)
        self.assertEqual((status["model"], status["effort"], status["modelChosen"]), ("grok-4.7", "high", True))
        (agent / "launch.json").unlink()  # as if the old runner had started it
        status = self.req(op="status", pubkey=agent.name)
        self.assertEqual((status["model"], status["effort"]), (None, None))
        self.assertIn("runs Grok Build's own default until it restarts", status["modelNote"])
        self.a.stop(agent)
        self.assertEqual(self.req(op="status", pubkey=agent.name)["model"], "grok-4.5", "stopped: what it would start with")

    def test_the_claude_listing_is_kept_per_sign_in(self):
        self.listed(); self.listed()
        self.assertEqual((self.home / "listings.txt").read_text().count("claude"), 1)
        self.assertEqual((self.home / "claude-calls.txt").read_text().split(), ["claude-fable-5-2"], "one call proves the default")
        self.a.save_claude_token(FAKE_TOKEN + "x", None)
        self.assertIsNone(self.a.offered("claude"), "another sign-in: not known yet")

    def test_a_new_agent_runs_the_most_capable_model_at_high_effort(self):
        self.listed()
        env = self.env_of(self.make_agent("claude"))
        self.assertEqual((env["ANTHROPIC_MODEL"], env["CLAUDE_CODE_EFFORT_LEVEL"]), ("claude-fable-5-2", "high"))
        self.assertNotIn("BUZZ_ACP_MODEL", env, "buzz-acp keeps the default model when the adapter refuses it, silently")
        self.assertNotIn("BUZZ_ACP_EFFORT_LEVEL", env)
        env = self.env_of(self.make_agent("codex"))
        self.assertEqual(json.loads(env["CODEX_CONFIG"]), {"model": "gpt-6-astra", "model_reasoning_effort": "high"})
        self.assertEqual(env["INITIAL_AGENT_MODE"], "agent-full-access")
        env = self.env_of(self.make_agent("grok"))
        self.assertEqual(env["BUZZ_ACP_AGENT_ARGS"], "agent,--model,grok-4.7,--reasoning-effort,high,--always-approve,stdio")

    def test_a_chosen_model_and_effort_are_stored_applied_and_reported(self):
        self.listed()
        r = self.req(op="provision", name="Picked", community="wss://relay.example.com",
                     config={"harness": "claude", "model": "opus", "effort": "max"})
        self.assertTrue(r["ok"], r)
        agent = self.a.AGENTS / r["pubkey"]
        s = self.a.read_settings(agent)
        self.assertEqual((s["model"], s["effort"]), ("opus", "max"))
        s["auth"] = ["auth", "a" * 64, "", "b" * 128]; self.a.write_settings(agent, s)
        env = self.env_of(agent)
        self.assertEqual((env["ANTHROPIC_MODEL"], env["CLAUDE_CODE_EFFORT_LEVEL"]), ("opus", "max"))
        status = self.req(op="status", pubkey=agent.name)
        self.assertEqual((status["model"], status["effort"], status["modelChosen"], status["effortChosen"]), ("opus", "max", True, True))
        row = next(a for a in self.req(op="list")["agents"] if a["pubkey"] == agent.name)
        self.assertEqual((row["model"], row["effort"]), ("opus", "max"))

    def test_changing_them_restarts_the_agent_and_empty_means_the_default(self):
        self.listed()
        agent = self.make_agent("grok")
        old = self.a.start(agent)
        r = self.req(op="settings.set", pubkey=agent.name, model="grok-4.5", effort="low")
        self.assertTrue(r["ok"], r)
        self.assertEqual((r["model"], r["effort"]), ("grok-4.5", "low"))
        self.assertNotEqual(self.a.running(agent), old, "restarted on the change")
        env = json.loads((agent / "work" / "env.json").read_text())
        self.assertEqual(env["BUZZ_ACP_AGENT_ARGS"], "agent,--model,grok-4.5,--reasoning-effort,low,--always-approve,stdio")
        r = self.req(op="settings.set", pubkey=agent.name, effort="")
        self.assertEqual((r["model"], r["effort"]), ("grok-4.5", "medium"), "Grok 4.5 has no high: the highest below it")
        self.assertIn("Grok 4.5 does not take high effort; medium instead.", r["modelNote"])
        r = self.req(op="settings.set", pubkey=agent.name, model="")
        self.assertEqual((r["model"], r["effort"], r["modelChosen"]), ("grok-4.7", "high", False))

    def test_a_model_or_effort_it_does_not_offer_is_refused_loudly(self):
        self.listed()
        agent = self.make_agent("codex")
        self.assertEqual(self.req(op="settings.set", pubkey=agent.name, model="gpt-9")["error"],
                         "Codex does not offer the model gpt-9 on this machine. Choose another model for this agent.")
        self.assertEqual(self.req(op="settings.set", pubkey=agent.name, model="gpt-6-luna", effort="ultra")["error"],
                         "GPT-6-Luna does not take the effort ultra. Choose another effort for this agent.")
        self.assertEqual(self.a.read_settings(agent)["model"], "", "nothing stored")
        r = self.req(op="provision", name="Bad", community="wss://relay.example.com", config={"harness": "grok", "model": "grok-9"})
        self.assertIn("does not offer the model grok-9", r["error"])
        self.assertIn("takes its model from the machine", self.req(op="provision", name="G", community="wss://relay.example.com",
                                                                   config={"harness": "goose", "model": "x"})["error"])
        # A model the subscription stopped offering after it was chosen.
        s = self.a.read_settings(agent); s["model"] = "gpt-5-gone"; self.a.write_settings(agent, s)
        self.assertIn("does not offer the model gpt-5-gone", self.req(op="start", pubkey=agent.name)["error"])
        self.assertIsNone(self.a.running(agent))
        self.assertIn("gpt-5-gone", self.req(op="status", pubkey=agent.name)["modelProblem"])

    def test_without_a_listing_yet_the_choice_still_applies_and_says_unchecked(self):
        (self.a.HOMES / "codex" / "models_cache.json").unlink()
        agent = self.make_agent("codex")
        env = self.env_of(agent)
        self.assertEqual(json.loads(env["CODEX_CONFIG"]), {"model": "gpt-6-astra", "model_reasoning_effort": "high"})
        self.assertFalse(json.loads((agent / "launch.json").read_text())["checked"])
        row = next(h for h in self.req(op="models")["harnesses"] if h["id"] == "codex")
        self.assertEqual((row["models"], row["checked"]), ([], False))

    def test_a_heartbeat_names_the_exact_model_it_runs(self):
        self.listed()
        agent = self.make_agent("claude")
        self.assertTrue(self.req(op="heartbeat.set", pubkey=agent.name, minutes=30)["ok"])
        self.assertIn('model "claude-fable-5-2"', (agent / "heartbeat.md").read_text())
        self.assertTrue(self.req(op="settings.set", pubkey=agent.name, model="opus")["ok"])
        self.assertIn("(your exact model id)", (agent / "heartbeat.md").read_text(), "an alias: the agent names it exactly")
        self.assertTrue(self.req(op="settings.set", pubkey=agent.name, model="")["ok"])
        self.assertIn('model "claude-fable-5-2"', self.req(op="heartbeat.get", pubkey=agent.name)["prompt"], "the form shows what it runs")

    def claude_calls(self):
        path = self.home / "claude-calls.txt"
        return path.read_text().split() if path.exists() else []

    def test_a_failed_listing_keeps_the_last_good_one_and_backs_off(self):
        self.listed()
        cache = json.loads((self.a.RUN / "claude-models.json").read_text())
        cache["at"] -= self.a.CLAUDE_MODELS_TTL + 1  # due again
        (self.a.RUN / "claude-models.json").write_text(json.dumps(cache))
        (self.home / "busy-claude-fable-5-2").write_text("x")
        self.a.refresh_claude_models(wait=True)
        self.assertEqual(self.a.offered("claude")[0]["id"], "claude-fable-5-2", "the last good listing stands")
        calls = len(self.claude_calls())
        for _ in range(3): self.a.refresh_claude_models(wait=True)
        self.assertEqual(len(self.claude_calls()), calls, "no paid call again until the back-off is over")
        cache = json.loads((self.a.RUN / "claude-models.json").read_text())
        self.assertEqual(cache["fails"], 1)
        self.assertAlmostEqual(cache["retryAt"] - cache["failedAt"], self.a.CLAUDE_MODELS_FAIL_TTL, delta=1)
        cache["retryAt"] = time.time() - 1
        (self.a.RUN / "claude-models.json").write_text(json.dumps(cache))
        self.a.refresh_claude_models(wait=True)
        cache = json.loads((self.a.RUN / "claude-models.json").read_text())
        self.assertEqual(cache["retryAt"] - cache["failedAt"], 2 * self.a.CLAUDE_MODELS_FAIL_TTL, "doubling")
        (self.home / "busy-claude-fable-5-2").unlink()
        cache["retryAt"] = time.time() - 1
        (self.a.RUN / "claude-models.json").write_text(json.dumps(cache))
        self.a.refresh_claude_models(wait=True)
        self.assertNotIn("retryAt", json.loads((self.a.RUN / "claude-models.json").read_text()))

    def test_a_start_with_no_listing_yet_makes_it_first(self):
        self.a.spawn_models_refresh = lambda harness="claude": None  # as after a deploy: nothing out of band has run
        (self.home / "refuse-claude-fable-5-2").write_text("x")
        agent = self.make_agent("claude")
        env = self.env_of(agent)
        self.assertEqual(env["ANTHROPIC_MODEL"], "fable", "never a model the sign-in lacks, unseen")
        self.assertTrue(json.loads((agent / "launch.json").read_text())["checked"])

    def test_an_agent_started_unchecked_is_put_right_once_the_listing_is_in(self):
        self.a.spawn_models_refresh = lambda harness="claude": None
        self.a.listing_due = lambda harness: False  # the listing could not be made at start (offline)
        (self.home / "refuse-claude-fable-5-2").write_text("x")
        agent = self.make_agent("claude")
        old = self.a.start(agent)
        status = self.req(op="status", pubkey=agent.name)
        self.assertEqual((status["model"], status["modelChecked"]), ("claude-fable-5-2", False))
        self.assertIn("not yet checked", status["modelNote"])
        self.listed()
        self.a.supervise_pass()
        self.assertNotEqual(self.a.running(agent), old)
        self.assertEqual(json.loads((agent / "work" / "env.json").read_text())["ANTHROPIC_MODEL"], "fable")
        self.assertTrue(self.req(op="status", pubkey=agent.name)["modelChecked"])
        # Its own choice, not offered: stopped and said, not left failing every turn.
        other = self.make_agent("claude")
        s = self.a.read_settings(other); s["model"] = "claude-gone-1"; self.a.write_settings(other, s)
        real = self.a.cached_models
        self.a.cached_models = lambda harness, spawn=True: None  # started while nothing was known
        self.a.start(other)
        self.a.cached_models = real
        self.a.supervise_pass(now=time.time() - 3600)  # restarts not yet due
        self.assertIsNone(self.a.running(other))
        row = next(a for a in self.req(op="list")["agents"] if a["pubkey"] == other.name)
        self.assertIn("does not offer the model claude-gone-1", row["modelProblem"])

    def test_an_effort_name_it_does_not_know_never_breaks_a_request(self):
        cache = json.loads(json.dumps(GROK_MODELS))
        cache["models"]["grok-4.7"]["info"]["reasoning_efforts"] = [{"value": "low"}, {"value": "turbo"}]
        (self.a.HOMES / "grok" / "models_cache.json").write_text(json.dumps(cache))
        agent = self.make_agent("grok")
        self.assertEqual(self.req(op="status", pubkey=agent.name)["effort"], "low")
        self.assertTrue(self.req(op="list")["ok"])
        self.assertTrue(self.req(op="models")["ok"])
        self.assertTrue(self.req(op="settings.set", pubkey=agent.name, effort="turbo")["ok"], "offered, so it may be chosen")

    def test_ids_that_are_not_ids_never_reach_a_harness(self):
        agent = self.make_agent("grok")
        for bad in ("grok-4.7,--sandbox", "-rf", "a b"):
            self.assertEqual(self.req(op="settings.set", pubkey=agent.name, model=bad)["error"], "model is not a model id")
        self.assertEqual(self.req(op="settings.set", pubkey=agent.name, effort="high,x")["error"], "effort is not an effort level")
        cache = json.loads(json.dumps(GROK_MODELS))
        cache["models"]["grok-4.7,--x"] = {"info": {"id": "grok-4.7,--x", "name": "Odd", "hidden": False}}
        (self.a.HOMES / "grok" / "models_cache.json").write_text(json.dumps(cache))
        self.assertNotIn("grok-4.7,--x", [m["id"] for m in self.a.offered("grok")])
        s = self.a.read_settings(agent); s["model"] = "grok,--x"; self.a.write_settings(agent, s)  # an old saved value
        with self.assertRaises(self.a.Fail): self.a.launch("grok", {"model": "grok,--x", "effort": "high"})
        self.assertIn("grok,--x", self.req(op="start", pubkey=agent.name)["error"])

    def test_only_its_creator_changes_an_agents_model(self):
        agent = self.make_agent("grok")
        self.a.CALLER = "teammate"
        self.addCleanup(setattr, self.a, "CALLER", None)
        self.assertIn("Only they or a Black 4 admin can change it", self.req(op="settings.set", pubkey=agent.name, model="grok-4.5")["error"])
        self.assertEqual(self.a.read_settings(agent)["model"], "")

    def test_doctor_says_what_new_agents_run(self):
        self.listed()
        rows = {h["id"]: h for h in self.req(op="doctor")["harnesses"]}
        self.assertEqual((rows["claude"]["model"], rows["claude"]["effort"]), ("claude-fable-5-2", "high"))
        self.assertNotIn("model", rows["goose"])
        out = io.StringIO()
        with contextlib.redirect_stdout(out): self.a.print_doctor()
        self.assertIn("new agents run gpt-6-astra at high effort", out.getvalue())


class ModelLevers(unittest.TestCase):
    def setUp(self):
        self.a = load()

    def test_launch_tells_each_harness_its_own_way(self):
        pick = {"model": "m", "effort": "high"}
        self.assertEqual(self.a.launch("claude", pick), ({"ANTHROPIC_MODEL": "m", "CLAUDE_CODE_EFFORT_LEVEL": "high"}, ""))
        env, args = self.a.launch("codex", pick)
        self.assertEqual((json.loads(env["CODEX_CONFIG"]), args), ({"model": "m", "model_reasoning_effort": "high"}, ""))
        self.assertEqual(self.a.launch("grok", pick), ({}, "agent,--model,m,--reasoning-effort,high,--always-approve,stdio"))
        self.assertEqual(self.a.launch("grok", {"model": None, "effort": None}), ({}, "agent,--always-approve,stdio"))
        self.assertEqual(self.a.launch("goose", {"model": None, "effort": None}), ({}, "acp"))

    def test_labels_and_effort_order(self):
        self.assertEqual(self.a.claude_label("claude-fable-5-2"), "Fable 5.2")
        self.assertEqual(self.a.claude_label("claude-opus-5"), "Opus 5")
        self.assertEqual(self.a.effort_sorted(["max", "low", "bogus level", "high", "low"]), ["low", "high", "max"])


if __name__ == "__main__":
    unittest.main()
