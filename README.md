# Black 4 in Buzz

Status: current  
Owner: Black 4 platform  
Updated: 2026-11-14

Black 4 runs its AI workforce in [Buzz](https://github.com/block/buzz-app).
Buzz stays stock, so it can be updated at any time; everything Black 4 adds is
a plugin in this repository, one folder each under `plugins/`:

| Plugin | Folder | Who needs it |
| --- | --- | --- |
| **Black 4** (`ai.black4`) | `plugins/black4` | Everyone. Black 4 staff also get **Black 4 hardware** agents from it. |
| **Claude Sub Plugin** (`black4.claude-subscription`) | `plugins/claude-subscription` | A person who wants agents on their own Claude subscription. |
| **Grok Sub Plugin** (`black4.grok-subscription`) | `plugins/grok-subscription` | A person who wants agents on their own Grok subscription. |

## Set up your Buzz (Black 4 staff)

**What you get:** one plugin, **Black 4**. Every agent in your Buzz can use
Black 4 (goals, context, metrics, skills, Reviews) as you; Reviews in Buzz's
dock; and **Black 4 hardware** in Buzz's Create agent dialog, for agents that
run on a Black 4 machine and keep working while your computer is off. Black 4
hardware appears only once you are signed in to Black 4 with a staff account.

**What you need first:**

- The Buzz desktop app, signed in, with the Black 4 community open.
- A Black 4 staff account (the one you use at app.black4.ai).
- Node 22.12 or newer (`node -v`; get it from [nodejs.org](https://nodejs.org)).
- For hardware: the company network (Tailscale on), and a Black 4 admin
  (Joey) who will give you the machine's `<user>@<address>` and add your key.
- A Mac. Mac is the supported path for now; Windows is best effort, see
  [Windows (untested)](#windows-untested).

Open Terminal for the commands below.

### 1. Ask for machine access

Your admin gives you the machine's `<user>@<address>`. Then:

```sh
curl -fsSL https://raw.githubusercontent.com/joeyblack4/black4-buzz/stable/install.sh | sh -s -- --hardware <user>@<address>
```

It makes a key used only for Black 4 machines (`~/.ssh/black4_hardware`),
adds a `commerce` entry to `~/.ssh/config` (your own entries are left alone)
and prints one line starting `ssh-ed25519`. Send that line to your admin (it
is a public key; safe to paste in chat). Carry on while they add it.

### 2. The Black 4 plugin and sign-in

```sh
curl -fsSL https://raw.githubusercontent.com/joeyblack4/black4-buzz/stable/install.sh | sh
```

It installs the sign-in bridge, then Buzz opens its install review for
**Black 4**. The review lists the two programs it may start:
`black4-mcp-bridge` (the sign-in) and `ssh … commerce workforce/bin/agentctl`
(Black 4 hardware). Choose **Install plugin**. Then in **Settings → Plugins**,
turn **Black 4** on (plugins start off). Your browser opens the Black 4
sign-in; sign in as yourself.

You should see: **Settings → Black 4** says **Connected**, signed in as your
email *(staff)*, with a number of agent tools. **Reviews** appears in the dock.

### 3. Link your agents (one click)

In **Settings → Black 4**, the **Agent access** card says *Agents you create
on Black 4 hardware need this to use Black 4 as you.* Choose **Link my
agents**.

You should see: **Linked** with today's date, and *Next: Agents → New agent →
Black 4 hardware.* Later it counts the agents that used it. **Remove…** undoes
it.

This tells Black 4 that agents your Buzz identity creates act as you, with
exactly your access and no more. It is never done without your click.

### 4. Your first agent on Black 4 hardware

When your admin says you are added, check:

```sh
curl -fsSL https://raw.githubusercontent.com/joeyblack4/black4-buzz/stable/install.sh | sh -s -- --check-hardware
```

You should see: `Black 4 hardware reached:` and what the machine can run.

In Buzz, **Agents → New agent**. Choose **Black 4 hardware**, give it a name
and choose what it runs (Claude Code if unsure) and who it answers. If the
machine is not signed in to it yet, the form offers **Sign in**. Create.

Each harness is signed in once per machine, to the subscription of whoever
signs it in, and every agent on that machine that runs it uses that sign-in:

- **Claude Code** (Claude subscription): open the link, approve, paste the
  code the Anthropic page shows into the form.
- **Codex** (ChatGPT subscription) and **Grok Build** (SuperGrok or grok.com):
  open the link, approve the short code the form shows. There is nothing to
  paste; the machine notices the approval and the form says it is signed in.
  The code lasts 15 minutes.

A harness the machine has installed but Buzz cannot sign in (Goose) is listed
as unavailable, with the reason.

You should see: the agent in your list with *Claude Code · Commerce Mac*
under its name. Its **Settings** tab shows **Status: Running**. @mention it in
a channel; it answers within a minute, and its Black 4 tools work with no
sign-in.

### If something is wrong

- **The plugin does nothing after Install.** It starts off: turn it on in
  **Settings → Plugins**. Black 4 says *Not connected*: choose **Connect**,
  and finish the browser sign-in.
- **No Black 4 hardware in New agent.** It appears once **Settings → Black 4**
  says **Connected** with a *(staff)* account. If the card instead says
  *Black 4 hardware is unavailable in this Buzz*, this Buzz version changed
  the agent API: tell the platform team; everything else keeps working.
- **An agent says no Black 4 person has linked its owner key.** Do step 3.
  The card says the key is linked to someone else: that person (or any staff
  member) removes their link first.
- **"Could not reach the Commerce Mac"** in the Create agent dialog. Turn
  Tailscale on and run `--check-hardware`. *The machine refused this key*
  means the admin has not added your line yet.
- **`install.sh` says your shell does not have `~/.local/bin` on its PATH.**
  Buzz starts the sign-in bridge by name, so add the line it prints to
  `~/.zprofile`, then quit and reopen Buzz (Cmd-Q, not just the window).
- **A change in this repository doesn't show up.** A plugin installed from a
  folder is a copy taken at install time: install it again, then ask a Buzz
  agent to run `plugin_reload`. Plugins installed with the links above update
  themselves (**Update and reload** in Settings).

### Windows (untested)

Mac is the supported path for now. Nobody has tried this on Windows; these
are the steps we believe are needed.

- **What is most likely to break:** the Black 4 plugin's sign-in. Its bridge
  is a shell script, which Buzz for Windows cannot start, so step 2 will show
  *Not connected*, step 3's button never appears, and **Black 4 hardware**
  never appears either (it waits for a staff sign-in). `install.sh` needs a
  POSIX shell too.
- **Step 3 instead:** ask Claude (or any app with the Black 4 MCP) to call
  `link_agent_owner_key` with your Buzz public key as 64 hex characters.
- **Step 1 by hand:** Windows ships OpenSSH. Make the key with
  `ssh-keygen -t ed25519 -C black4-hardware -f %USERPROFILE%\.ssh\black4_hardware`
  (press Enter twice for no passphrase). Send `black4_hardware.pub` to your
  admin. Put the `Host commerce` block that `install.sh --hardware` would
  write at the top of `%USERPROFILE%\.ssh\config`:

  ```
  Host commerce
    HostName <address>
    User <user>
    IdentityFile ~/.ssh/black4_hardware
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new
  ```

  Install the plugin with
  `buzz://plugin-install?repository=joeyblack4%2Fblack4-buzz&ref=stable&path=plugins%2Fblack4`.
  Buzz starts plugin programs by name, so `ssh` should resolve to Windows'
  own `ssh.exe`; whether it does is the next thing to find out.

## Admin

### Add or remove a teammate

From a computer that already reaches the machine (yours has `commerce`):

```sh
machine/teammates.sh --host commerce add sam 'ssh-ed25519 AAAA… black4-hardware'
machine/teammates.sh --host commerce list
machine/teammates.sh --host commerce remove sam
```

The label (`sam`) is how the machine records who created each agent. Each
line it writes forces `agentctl --caller <label>` with `restrict` (no shell,
no forwarding, no pty), so a teammate's key can only send agentctl one JSON
request. Your own key stays unrestricted. Removing a key leaves their agents
running; `agentctl list` still shows them, with `createdBy`.

On the machine, a teammate can see every agent but change, restart or remove
only the agents they created, and cannot sign the machine out of Claude. They
can sign the machine in to Claude, Codex or Grok Build while it is signed out,
which every agent on that harness then uses; only your key can switch a
working sign-in to another account. Agents made with your own unrestricted key, or before
labels existed, are yours: teammates can see them but not change them. Your
key is not limited.

### Set up a new machine

On a Mac with Apple Silicon, signed in as the user agents run under, with
your SSH key in its `authorized_keys` and an SSH alias for it on your computer:

```sh
machine/deploy.sh <ssh-host> [machine-name]
```

It installs Node, the ACP adapters, the Black 4 connector and `agentctl` under
`~/workforce`, without sudo, and is safe to run again. It ends with
`agentctl doctor`, a self-test: each harness at its pinned version
(`machine/pins.json`), buzz-acp's ACP handshake with each adapter, the
connector, the cron lines and free disk. It fails loudly when the machine cannot
run agents; Buzz's Create agent form shows the same problem for a harness
instead of creating an agent that never answers. Then sign the machine in
to Claude from Buzz (the Create agent dialog offers it). A second machine also
needs an entry in `MACHINES` in `plugins/black4/plugin.js` (the Black 4
hardware part) and a matching process in its manifest.

Cron runs `agentctl supervise` at boot and every minute; it restarts an agent
that stops, waiting 5, 10, 20 … up to 300 seconds while it keeps stopping, and
`status` then says `keepsStopping` with the end of its log. Each agent's
`agent.log` is cut over to `agent.log.1` past 5 MB.

Agents run with full access on their own machine: no harness asks permission
or runs sandboxed (`FULL_ACCESS` in `agentctl`; `doctor` shows each one's mode).
Changes to a customer's systems are gated by Reviews in Platform Control.

### Buzz updates and releases

The [Buzz canary](canary/README.md) checks every day that the latest Buzz still
offers everything these plugins use; red on the release means do not update
Buzz yet. Work lands on `main`. People install from `stable`, which only Joey
moves, to a tested commit on `main`; installed plugins then offer **Update and
reload**. Until a release, try `main` with `BLACK4_BUZZ_REF=main` before the
`sh` in the commands above.

## Black 4 hardware, inside the Black 4 plugin

`plugins/black4/plugin.js` ends with a fenced Black 4 hardware part: the
hosted agent type and its form, sign-in and Settings tab. It is offered only
after `whoami` reports a staff account, and withdrawn when a connected account
is not staff (a dropped connection changes nothing). It registers in its own
child scope, because Buzz has no call to remove an agent type: disposing that
scope withdraws it. While it is withdrawn, an existing hardware agent shows in
Buzz as *Harness unavailable* with no Delete, and keeps running on the machine;
it comes back when the type does. If registering or rendering it throws, the
MCP tools, Reviews and Agent access carry on and **Settings → Black 4** says
*Black 4 hardware is unavailable in this Buzz* with the reason.

## The rule this repository keeps

The plugin is a client of Black 4. It never defines a tool, a number, a
permission or a review rule of its own: those live in Platform Control and are
reached through the MCP. People decide in Reviews; no agent tool records a
decision. No customer data is stored here or in the plugin.

## Updates

Each plugin's manifest declares `"updates": { "defaultEnabled": true }`, so Buzz
checks a plugin installed from this repository against the branch it was
installed from (at startup, then hourly) and offers **Update and reload**. An
update that asks for more computer access needs a review first. A plugin loaded
from a folder gets no such check. `stable` is what people run; `main` is where
work lands. Releasing is moving `stable` to a tested commit on `main`.

A Mac managed for Black 4 can list the plugin in Buzz's
`managed-plugins.json` so Settings shows it as recommended, pinned to an exact
commit. Buzz never installs it without the person's click.

Updating **Buzz itself** is a separate question: its plugin API is a preview
and can change. The [Buzz canary](canary/README.md) checks every day whether
the latest Buzz release, preview and `main` still offer everything these
plugins use. Its workflow going red on the release means: do not update Buzz
yet.

## What is here

| Path | What it is |
| --- | --- |
| `plugins/<name>/` | Each plugin exactly as Buzz installs it: `manifest.json` and `plugin.js`. Buzz never runs a build, so nothing else belongs in these folders. |
| `subscriptions/` | Source, build and tests for the two subscription plugins. `npm run build --prefix subscriptions` writes their folders under `plugins/`; the check refuses a stale copy. |
| `bridge/black4-mcp-bridge` | The process the plugin starts: `mcp-remote` in front of the Black 4 MCP. It owns the browser sign-in and token refresh; the plugin never reads credentials. |
| `bridge/black4-agent-mcp/` | The Black 4 MCP for agents that run on a Black 4 machine. `buzz-acp` starts it as the agent's MCP server; it signs every request with the agent's own Buzz key and owner attestation (`Authorization: Nostr`), so there is no sign-in. One pinned dependency, `@noble/curves`. |
| `machine/` | The machine side: `agentctl` (what Black 4 hardware in the plugin calls over SSH), `setup.sh` and `deploy.sh <ssh-host>`, which installs both on a machine, and `teammates.sh`, which adds a teammate's forced-command key. |
| `install.sh` | The install above: the Black 4 plugin, and with `--hardware` only a teammate's machine key and SSH alias. |
| `tests/` | Unit tests against the plugin file, with a process double and fictional data. No sign-in or network. |
| `scripts/check-build-folder.mjs` | Refuses anything in a plugin folder that Buzz would not read. |
| `canary/` | The Buzz canary: the Buzz API each plugin uses (`contract.json`), checked against Buzz's source by `check.mjs` and by starting the plugins in Buzz's real services (`load.mjs`). |
| `machine/pins.json`, `scripts/check-machine-pins.mjs` | The buzz-acp harness and ACP adapter versions an agent machine runs together, and the check that `machine/setup.sh` agrees. |

## Reviews

Only `https://app.black4.ai/reviews` and `/r/:assetId` links match the panel.
The native brief reads through the signed-in MCP account, with access enforced
by the server: the exact action, the recommendation, current and proposed,
consequences, provenance and decision state. The queue belongs to the account
and is never inferred from a channel name. A link is a locator and grants
nothing. A link to an older version is refused, not substituted.

The Reviews dock page opens Black 4's decision inbox in Buzz's embedded
browser, in a website session named `black4-reviews` that is separate from the
MCP sign-in. Decisions are recorded there, by the person. Where Buzz has no
embedded browser (today, anything but macOS), the page shows the native queue
and brief, and "View work & decide" is an ordinary web link. A remembered
website sign-in needs macOS 14 or newer. Buzz labels the embedded browser a
preview API; it has no popups or downloads.

## Everyone in a channel reaches its agents

Buzz 1.0 starts an agent's turn for an @mention only when the agent's owner, or
the owner's own agent, wrote it, and it never shows an @mention to the agent's
Attention watches. No Buzz setting changes either. So the plugin relays the
rest: when a person other than the owner @mentions one of the owner's agents
running on this Mac, the plugin wakes that agent in the message's thread with
`ctx.agents.wake`, saying who asked and what they wrote.

The owner's own mentions and every agent's message (which carries a NIP-OA
`auth` tag) are left to Buzz, so nothing is woken twice and agents cannot loop.
It covers new messages only, while this Buzz app is open in that community.
Claude, Codex, goose and plugin agent types take these wakes; Pi ignores them.

Installing the plugin is the owner's choice to let every channel member direct
their agents, which run commands and Black 4 calls with the owner's authority.
A setting to limit this to chosen channels is not built yet.

## Agents on your own Claude or Grok subscription

The two subscription plugins add agent types that run the provider's official
command-line tool on your computer, signed in as you: Claude Code for Claude,
Grok Build for Grok. Install either from its folder:

```
buzz://plugin-install?repository=joeyblack4%2Fblack4-buzz&ref=stable&path=plugins%2Fclaude-subscription
buzz://plugin-install?repository=joeyblack4%2Fblack4-buzz&ref=stable&path=plugins%2Fgrok-subscription
```

Then open **Agents → New agent**, choose the type, and use **Install CLI** and
**Sign in** if the tool is not set up yet. Each person uses their own
subscription on their own computer. Credentials stay in the provider's own
storage; the plugin copies none into Buzz. It removes API-key overrides from
the processes it starts, so work runs on the subscription sign-in, and it never
changes a plan or buys credits. Your use of a subscription this way is subject
to that provider's terms.

Limits today: macOS is the tested platform; a session restarts from Buzz's
history when the plugin reloads; detailed activity transcripts and protected
execution are not built.

## Lifecycle and authority

Buzz's `host.spawn` and process `write` are asynchronous. Initialization waits
for both. Reconnect and disable invalidate an older attempt and kill a process
that finishes spawning after it was superseded. Completed and cancelled calls
remove their abort listeners; write failures reject immediately.

When the MCP lists `resolve_channel_business`, the plugin fills in the calling
agent's exact channel and community. A channel name never selects a business,
and nothing here prescribes how agents use channels. The MCP enforces authority
under the signed-in person's account, as it does in every other harness.

Agent results contain textual MCP content only. Private `_meta`, including
human decision tokens and preview grants, never goes into an agent result.

## Work on it

```sh
npm run setup   # once: the connector's pinned dependency
npm run check
```

That checks the plugin parses, each plugin folder holds only what Buzz reads,
the subscription plugins match their source, and the tests pass.
`npm run test:subscriptions` runs the subscription plugins' own tests. To try a change in your own Buzz, copy
`plugins/black4/plugin.js` over the installed folder plugin, or install from
your branch, then use Buzz's `plugin_reload` tool and confirm with
`plugin_status` that it is active and its tools are registered. Unit tests do
not prove the live connection, the embedded sign-in or a relayed mention: check
those in the app.

Customer names never go in this repository: tests use fictional businesses and
people.

## Where the rest lives

- The Black 4 MCP, Reviews and every rule: `joeyblack4/black4-retail-edge`.
- The Black 4 plugin for other agent hosts (Claude Code, Codex and others):
  `plugins/black4` in that repository.
- Agent definitions for the Macs: `joeyblack4/black4-agents`.
