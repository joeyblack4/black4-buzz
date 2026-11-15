"""Tests for machine/agentctl. Run from the repo root:  /usr/bin/python3 -m unittest discover -s machine/tests

Each test gets a temporary home with fake `claude`, `claude-agent-acp`,
`buzz-acp` and `buzz` programs (and, where a test needs them, fake `codex`,
`codex-acp` and `grok`), so nothing touches the real machine, the network or
the crontab. The fake `claude setup-token` behaves like the real one over a
pty: banner, link, "Paste code" prompt, then a token or an OAuth error. The fake
`codex login --device-auth` and `grok login --device-auth` print what the real
ones printed on the machine (a link and a one-time code), then wait for the
test to approve or refuse (the file approve.txt in the test home).
"""
import re, importlib.machinery, importlib.util, json, os, signal, stat, subprocess, sys, tempfile, textwrap, time, unittest
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
if "-p" in args:
    token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "")
    if token == {FAKE_TOKEN!r}:
        print(json.dumps({{"is_error": False, "result": "OK"}}))
    elif token:
        print(json.dumps({{"is_error": True, "api_error_status": 401, "result": "Failed to authenticate. API Error: 401 OAuth access token is invalid."}}))
    else:
        print(json.dumps({{"is_error": True, "api_error_status": None, "result": "Not logged in"}}))
    sys.exit(1 if token != {FAKE_TOKEN!r} else 0)
"""

FAKE_BUZZ_ACP = f"""#!{PY}
import json, os, sys, time
with open("env.json", "w") as f:
    json.dump({{k: v for k, v in os.environ.items() if k.startswith(("BUZZ_ACP", "CLAUDE_CODE", "PATH", "CODEX", "GROK", "NO_BROWSER", "OPENAI", "XAI"))}}, f)
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
if "-p" in args:
    cred = stored("GROK_HOME")
    if {FAKE_CRED!r} in cred and "revoked" not in cred:
        print(json.dumps({{"type": "result", "result": "OK"}})); sys.exit(0)
    print(json.dumps({{"type": "error", "message": "Not signed in. To authenticate without a browser, run: grok login --device-code"}})); sys.exit(1)
"""


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
    def test_reports_four_harnesses_and_claude_signed_out(self):
        r = self.req(op="machine.status")
        self.assertTrue(r["ok"])
        self.assertIsInstance(r["machine"], str)
        rows = {h["id"]: h for h in r["harnesses"]}
        self.assertEqual(list(rows), ["claude", "codex", "grok", "goose"])
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

    def test_admin_agents_have_no_creator(self):
        d = self.make_agent(activate=False)
        self.assertIsNone(self.req(op="list")["agents"][0]["createdBy"])
        self.as_caller("lee")
        self.assertTrue(self.req(op="instructions.set", pubkey=d.name, instructions="x")["ok"], "unlabelled agents stay open")

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
        self.a.supervise_pass({})
        new = self.a.running(d)
        self.assertTrue(new)
        self.assertNotEqual(new, pid)

    def test_waits_for_sign_in_instead_of_retrying(self):
        d = self.make_agent()
        backoff = {}
        self.a.supervise_pass(backoff)
        self.assertIsNone(self.a.running(d))
        self.assertEqual(backoff, {})  # skipped, not failed: nothing to back off from

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
        self.assertTrue(self.a.running(d_agent))  # restarted on the new credential
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
    """Codex and Grok, installed as fakes."""
    def setUp(self):
        super().setUp()
        write_exe(self.a.BIN / "codex", FAKE_CODEX)
        write_exe(self.a.BIN / "codex-acp", "#!/bin/sh\nexit 0\n")
        write_exe(self.a.BIN / "grok", FAKE_GROK)
        self.a.FINISH_WAIT = 20

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
                self.assertTrue(self.a.running(agent))
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


class DeviceStatusAndStart(DeviceBase):
    def rows(self):
        return {h["id"]: h for h in self.req(op="machine.status")["harnesses"]}

    def test_signed_out_until_a_sign_in(self):
        rows = self.rows()
        for harness in ("codex", "grok"):
            self.assertEqual((rows[harness]["installed"], rows[harness]["signedIn"]), (True, False))
        self.sign_in_device("codex")
        self.assertEqual((self.rows()["codex"]["signedIn"], self.rows()["codex"]["account"]), (True, "owner@example.com"))

    def test_signed_in_is_verified_with_the_service_not_just_a_file(self):
        for harness in ("codex", "grok"):
            home = self.a.cli_home(harness)
            (home / "auth.json").write_text(json.dumps({"tokens": FAKE_CRED + "-revoked"}))
            self.assertFalse(self.rows()[harness]["signedIn"], harness)
            self.assertTrue(self.a.device_known_bad(harness))

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
        self.assertEqual(env["BUZZ_ACP_AGENT_ARGS"], "agent,--always-approve,stdio")
        self.assertEqual(env["GROK_HOME"], str(self.a.HOMES / "grok"))
        self.assertIn("auto_update = false", (self.a.HOMES / "grok" / "config.toml").read_text())
        self.sign_in_device("codex")
        agent = self.make_agent("codex")
        self.assertTrue(self.req(op="start", pubkey=agent.name)["ok"])
        env = json.loads((agent / "work" / "env.json").read_text())
        self.assertEqual(env["CODEX_HOME"], str(self.a.HOMES / "codex"))
        self.assertEqual(env["NO_BROWSER"], "1")
        self.assertIn('cli_auth_credentials_store = "file"', (self.a.HOMES / "codex" / "config.toml").read_text())

    def test_supervisor_waits_for_a_sign_in(self):
        agent = self.make_agent("codex")
        self.a.supervise_pass({})
        self.assertIsNone(self.a.running(agent))
        self.sign_in_device("codex")
        self.a.stop(agent)
        self.a.supervise_pass({})
        self.assertTrue(self.a.running(agent))


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


if __name__ == "__main__":
    unittest.main()
