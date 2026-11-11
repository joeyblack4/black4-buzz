# Black 4 in Buzz

Status: current  
Owner: Black 4 platform  
Updated: 2026-11-11

Black 4 builds an outcome-getting machine. This repository is how that machine
shows up in [Buzz](https://github.com/block/buzz-app). Buzz itself stays stock,
so it can be updated at any time. Every Black 4 plugin lives here, each in its
own folder under `plugins/`:

| Plugin | Folder | Who needs it |
| --- | --- | --- |
| **Black 4** (`ai.black4`) | `plugins/black4` | Everyone. |
| **Claude Sub Plugin** (`black4.claude-subscription`) | `plugins/claude-subscription` | A person who wants agents on their own Claude subscription. |
| **Grok Sub Plugin** (`black4.grok-subscription`) | `plugins/grok-subscription` | A person who wants agents on their own Grok subscription. |

The Black 4 plugin does three things:

1. **Connects every Buzz agent to the Black 4 MCP** (`https://api.black4.ai/mcp`).
   The MCP's core tools appear to each agent as `black4_<tool>`, and each call
   runs with the signed-in person's Black 4 authority.
2. **Puts Reviews in Buzz**: a Reviews entry in the dock with a count of
   decisions waiting, a review panel beside conversations, and previews of
   review links in messages.
3. **Lets everyone in a channel reach its agents**: Buzz answers @mentions only
   for an agent's owner, so the plugin relays everyone else's.

## The rule this repository keeps

The plugin is a client of Black 4. It never defines a tool, a number, a
permission or a review rule of its own: those live in Platform Control and are
reached through the MCP. People decide in Reviews; no agent tool records a
decision. No customer data is stored here or in the plugin.

## Install

Node 22.12 or newer and the Buzz desktop app are required. On a Mac:

```sh
curl -fsSL https://raw.githubusercontent.com/joeyblack4/black4-buzz/stable/install.sh | sh
```

The script installs the sign-in bridge, then opens Buzz's own install review.
Choose **Install plugin**, turn the plugin on, and finish the Black 4 sign-in
in your browser. Each person signs in as themselves, and sees and does only
what their Black 4 account allows.

If you would rather read the script first, clone the repository and run
`./install.sh`. Once the bridge is in place, this link alone opens the install
review:

```
buzz://plugin-install?repository=joeyblack4%2Fblack4-buzz&ref=stable&path=plugins%2Fblack4
```

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

## What is here

| Path | What it is |
| --- | --- |
| `plugins/<name>/` | Each plugin exactly as Buzz installs it: `manifest.json` and `plugin.js`. Buzz never runs a build, so nothing else belongs in these folders. |
| `subscriptions/` | Source, build and tests for the two subscription plugins. `npm run build --prefix subscriptions` writes their folders under `plugins/`; the check refuses a stale copy. |
| `bridge/black4-mcp-bridge` | The process the plugin starts: `mcp-remote` in front of the Black 4 MCP. It owns the browser sign-in and token refresh; the plugin never reads credentials. |
| `install.sh` | The one-command install above. |
| `tests/` | Unit tests against the plugin file, with a process double and fictional data. No sign-in or network. |
| `scripts/check-build-folder.mjs` | Refuses anything in a plugin folder that Buzz would not read. |

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
