# The hardware door

With the door, a teammate's Buzz reaches a Black 4 machine's `agentctl` over plain HTTPS. They need no SSH key and no tailnet: Platform Control (api.black4.ai) signs a short-lived pass for each request, and the machine checks it.

```
Buzz plugin ──pass request──▶ Platform Control (WorkOS sign-in, staff only)
     │◀───────── pass (ES256 JWS, 60 s, one request) ─────┘
     │
     └─POST https://black4-commerce-01.tail50b7f0.ts.net/agentctl
          Authorization: Black4-Hardware <pass>
          body: the agentctl JSON request
              │
        Tailscale Funnel (TLS) ──▶ 127.0.0.1:8410  machine/door.mjs
                                      └─▶ agentctl --caller <staff email>
```

## What it checks, in order

1. The `Authorization: Black4-Hardware <pass>` header is present.
2. The header says `alg` ES256 and `typ` `black4-hardware+jwt`; nothing else is accepted (not `none`, HS256 or RS256).
3. The signature verifies against an EC P-256 key from `https://api.black4.ai/.well-known/black4-hardware-keys`. The key set is cached for 5 minutes. An unknown `kid` refetches it at most once a minute. If the keys can't be fetched, the request gets 503; the door never opens on a fetch failure.
4. `iss` is `https://api.black4.ai`.
5. `aud` is `black4-hardware:<name>`, where the name comes from `machine.json`. The Commerce Mac is `commerce`.
6. `iat` and `exp` fall within 30 s of skew, and `exp - iat` is at most 60.
7. `email` is a lowercase email, `owner` is 64 hex or null, and `jti` is base64url.
8. The `jti` has not been seen before. It is stored in `run/door-jti.json` (mode 600) until expiry plus the skew, so a restart doesn't forget it. A pass with a bad signature or bad times never reaches this store.
9. The `op` claim equals the body's `op`.
10. The `body` claim equals the base64url SHA-256 of the exact body bytes.
11. For `activate` with a non-null `owner`: the NIP-OA attestation's owner (`auth[1]`) equals `owner`.

If every check passes, the door runs `agentctl --caller <email>` with the body on stdin and returns agentctl's JSON reply with 200, including agentctl's own `{ok:false}` refusals.

Each failure gets one status:

| Status | When |
|---|---|
| 401 `{error}` | Any pass problem. The error names the check and never echoes the token. |
| 400 | The body is not a JSON object. |
| 413 | The body is over 64 KiB, by `Content-Length` or by the bytes that actually arrive. |
| 404 | Any other path. |
| 405 | Any other method. |
| 503 | The keys can't be fetched, or 16 requests are already running. |
| 502 | agentctl crashed or gave no JSON. |

`GET /health` returns `{ok:true, machine}` without a pass.

## Callers

agentctl stores the email as `createdBy`, and a caller changes only agents it created. An email always contains `@` and an SSH label (`machine/teammates.sh`) never does, so the two never collide. An agent made under the SSH label `annabelle` is therefore not changeable by `annabelle@black4.ai`. The machine owner's own unrestricted SSH key (no `--caller`) still changes everything.

The door adds no new trust between staff. Every agent on the machine runs with full access as the same OS user, so the machine is one staff trust zone. For the same reason, the door keeps no reusable secret: only public keys and spent `jti`s are on disk.

## Running it

`machine/deploy.sh` ships `door.mjs`, and `setup.sh` installs it as `<root>/bin/door.mjs` with two cron lines: `@reboot` and every minute. These are separate from the supervisor's lines because agentctl drops those once no agent is activated, and the first `provision` arrives through the door.

Cron restarts a stopped door within a minute. Binding the port is the lock, so extra copies exit at once. A door exits when its file is replaced, and cron starts the new one. The log is `run/door.log` (cut over to `.1` past 1 MB).

| Root | Port | Cron mark |
|---|---|---|
| `~/workforce` | 8410 | `# black4-door` |
| any other root, e.g. `~/workforce-dev` | 8411 | `# black4-door:<root>` |

`<root>/door.json` may set `{"port": n}`. Only a root other than `~/workforce` may also set `{"jwksUrl": "file:///…"}`, to test with a fixture key. Remove it, or the whole file, once Platform Control's keys are live; the real `~/workforce` refuses to start with it.

### Funnel

Tailscale runs as a system daemon, and Funnel publishes only the door's port on 443:

```sh
TS="/usr/local/bin/tailscale --socket=/var/run/tailscaled.socket"
$TS funnel --bg 8411     # dev door; the released door is 8410
$TS funnel status
```

To move from the dev door to the released one, run `$TS funnel --bg 8410` and then `$TS funnel --https=443 off` for the old mapping if it remains. Funnel must be enabled once for the tailnet in the Tailscale admin console; the command prints the link when it isn't.
