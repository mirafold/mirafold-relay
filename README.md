# genui-relay

The hosted relay for [genui-shell](https://github.com/kserrec/genui-shell) — a
**dumb, end-to-end-blind WebSocket forwarder**. It lets a genui-shell daemon
running on your machine be reached from a phone or a second device without
opening any inbound port: the daemon dials *out* to the relay, the browser
connects *in*, and the relay shuttles opaque frames between them. It is the
paid tier's substrate (genui-shell PLAN Phase R).

> **Private repo, by design** — the open-core split: genui-shell is MIT; this
> hosted service is not. Until the first deploy, the dev source of truth for
> the shared files is `genui-shell/relay-service/`, where the service is
> verified against the REAL daemon (`server/relay-service.itest.ts`);
> `npm run sync` pulls those files here and `npm run sync:check` fails on
> drift. After the first deploy, this repo takes over as the source of truth.

## What it does, and deliberately does not

- **Matches** one daemon dial-in (`/daemon?pair=<id>`) to any number of browser
  viewports (`/ws?pair=<id>`) by pair id, and forwards frames between them.
- **Never parses payloads.** The `p` field of every envelope is the
  end-to-end-encrypted WireMsg/ClientMsg (AES-GCM, keyed off the pairing code
  the relay never sees — see genui-shell `server/relay-crypto.ts`). The relay
  routes on `t`/`v`/`pair` only. It logs no frame contents and stores nothing.
- **Serves no application bundle.** The only HTTP it answers is `GET /health`.
- **Enforces no credential policy — that lives in the daemon.** Only API-key or
  local/BYO sessions may be driven over the relay; a subscription-backed session
  is refused *by the genui-shell daemon* (`server/provider-policy.ts`, PLAN
  R.4i), before any frame is sent, independent of the paid entitlement (R.5).
  Because the relay is E2E-blind it can't tell one session from another anyway —
  and doesn't need to. The rule: charging for remote access to a
  subscription-driven agent trips the closed providers' reselling clauses, so
  the relay is BYO-API-key by construction.

### The trust decision (why it serves no JS)

End-to-end encryption stops the relay *reading* your traffic. But a relay that
also served the phone's app bundle could ship tampered JavaScript that reads
the pairing code out of the URL fragment before encryption ever happens — the
honest asterisk on every browser "E2E" story.

genui-relay closes that hole structurally: **it is a pure forwarder and serves
no JS.** The phone loads the genui-shell web app from a **separate static
origin** (the landing-page host), and only *then* opens an encrypted WebSocket
to the relay. A compromised relay can drop or scramble ciphertext (denial of
service) but can neither read it nor inject code into the page that produced
it. (The considered alternative — tunnelling the app bundle *through* the
daemon so client and daemon are always the same version — is a larger change
kept in reserve; genui-shell's tolerant wire schemas already make the
static-origin path's version skew survivable.)

### Versioning

The relay protocol version is baked into the pairing key derivation on the
daemon/browser side, so a future protocol bump is a clean break **by
construction**: an old client against a new relay simply fails to pair, which
the user sees as "wrong pairing code." There is nothing to negotiate here.

## Hardening (the DoS posture)

Everything is bounded and refused rather than degraded, mirroring the daemon.
All values are env-overridable (`src/limits.ts`):

| env | default | meaning |
| --- | --- | --- |
| `RELAY_MAX_CONNECTIONS` | 2000 | hard ceiling on live sockets |
| `RELAY_MAX_CONNECTIONS_PER_IP` | 64 | live sockets one source IP may hold (0 disables) |
| `RELAY_MAX_PAIRS` | 1000 | distinct daemons at once |
| `RELAY_MAX_VIEWPORTS_PER_PAIR` | 8 | browser viewports per pair |
| `RELAY_MAX_PAYLOAD_BYTES` | 8000000 | single-frame ceiling |
| `RELAY_RATE_MAX_FRAMES` / `RELAY_RATE_WINDOW_MS` | 480 / 1000 | per-connection frame rate |
| `RELAY_HEARTBEAT_MS` | 30000 | ws ping interval; a missed ping is reaped |
| `RELAY_MAX_SOCKETS` | 2400 | raw TCP sockets accepted at once — the pre-handshake floor; keep ≥ `RELAY_MAX_CONNECTIONS` so the app cap bites first; 0 = unbounded |
| `RELAY_HEADERS_TIMEOUT_MS` | 15000 | ms to receive the full request headers before a stalled handshake is cut; 0 disables |
| `RELAY_REQUEST_TIMEOUT_MS` | 20000 | ms to receive the whole request before a stalled handshake is cut; 0 disables |
| `RELAY_CONNECTION_CHECK_MS` | 5000 | how often stalled handshakes are swept for the two timeouts above; 0 disables both |
| `RELAY_CLIENT_IP_HEADER` | *(unset)* | trusted header carrying the true client IP |
| `RELAY_ALLOWED_ORIGINS` | *(unset)* | comma-separated web origins allowed to open a viewport; unset = allow any |
| `RELAY_ENTITLEMENT_PUBLIC_KEY` | *(unset)* | Ed25519 public key (base64 SPKI DER) gating daemon pairings; unset = no entitlement check |
| `PORT` / `HOST` | 8080 / 0.0.0.0 | listen address |

A guessably short pair id, a second daemon on a taken id, an unknown pair id, a
capacity cap, a per-source cap, or a frame flood each get a clean close (codes
in `src/contract.ts`).

**The per-source cap (`RELAY_MAX_CONNECTIONS_PER_IP`)** is what stops one host
from opening thousands of quiet connections to eat the whole global budget, or
squatting every pair slot with junk daemons — the per-*connection* frame-rate
limit can't, since that attack is many idle connections rather than one noisy
one. Behind a proxy (Fly.io), the socket address is the proxy's and is shared
by everyone, so set `RELAY_CLIENT_IP_HEADER` to the header the edge stamps with
the real client IP (`fly-client-ip` on Fly — already set in `fly.toml`). Leave
it unset only when clients reach the process directly; **never** set it on a
port an untrusted client can hit without the proxy, because the header is
spoofable there. NAT'd populations (an office behind one IP) may need the cap
raised. Raw NAT and platform-level protection sit *in front* of this; it is the
app's own floor, not the whole defense.

**The viewport origin allowlist (`RELAY_ALLOWED_ORIGINS`)** pins which web
origins may open a viewport socket — the browser same-origin rule does *not*
cover WebSockets, so without it a page on any origin can open one. Harmless on
its own (that page has no pairing code, so it completes no handshake and learns
nothing), but it is DoS surface the per-source cap only blunts. Set it to the
static app origin (e.g. `https://app.mirafold.com`) and every other origin — and
any connection with no `Origin` header — is refused with a clean close
(`CLOSE_FORBIDDEN_ORIGIN`, 4006). Unset = allow any, the default until that
static origin exists. Daemon dial-ins carry no `Origin` and are never gated.

**The entitlement gate (`RELAY_ENTITLEMENT_PUBLIC_KEY`)** is the paid-tier lock
(R.5). Set it to an Ed25519 public key (base64 SPKI DER) and a daemon must
present a valid, unexpired token on the `mirafold-entitlement` dial-in header to
open a pairing — a wrong, expired, forged, or missing token is refused with a
clean close (`CLOSE_UNENTITLED`, 4007). The token is compact
(`<b64url(payload)>.<b64url(sig)>`, `payload.exp` in unix seconds); the relay
verifies the signature + expiry **offline** — no Stripe call, no stored state,
still a dumb E2E-blind forwarder — and holds only the **public** half, so it can
verify tokens but never mint one (the R.5 billing backend keeps the private
key). Unset = no entitlement check, the default until billing ships. Viewports
carry no token: a pairing only exists behind an entitled daemon, so the daemon's
entitlement covers it.

**The pre-handshake floor (`RELAY_MAX_SOCKETS`, `RELAY_HEADERS_TIMEOUT_MS`,
`RELAY_REQUEST_TIMEOUT_MS`)** bounds connections that never finish the WebSocket
handshake. Every cap above is enforced *after* the upgrade, so a raw TCP or
half-open HTTP connection that stalls mid-handshake — a slowloris — would
otherwise be held only by Node's generous defaults. `RELAY_MAX_SOCKETS` caps raw
accepted sockets; the two timeouts cut a handshake that stalls on its headers or
the rest of the request, swept every `RELAY_CONNECTION_CHECK_MS`. All three clear
on a successful upgrade, so a live viewport or daemon socket is never severed by
them. This matters most on the self-host/VPS path — behind Fly.io the edge
already bounds concurrency, but a bare `node`-on-a-VPS deploy has no such floor.

## Repository layout

```
src/contract.ts   the routing envelope + close codes (VENDORED from mirafold
                  server/relay-protocol.ts; a sync-guard test there fails on drift)
src/limits.ts     the env-tuned DoS caps above
src/relay.ts      startRelay() — the whole forwarder
src/main.ts       container entrypoint; drains on SIGTERM
test/             standalone suite (node:test + tsx, raw ws clients)
scripts/smoke.mjs post-deploy go/no-go against the live relay
scripts/sync-from-genui-shell.sh   pull/check the shared files (see above)
Dockerfile        multi-stage, npm ci, runs as the unprivileged node user
fly.toml          single instance, /health check, auto_stop_machines=false
ARCHITECTURE.md   ground-up design: vocabulary, frame-routing flows, decisions
DEPLOY.md         the deploy-day runbook, command by command
```

New to this service? **[ARCHITECTURE.md](ARCHITECTURE.md)** is the guided tour —
the vocabulary (daemon, viewport, pair, pairing code), how a frame is routed end
to end, exactly what the relay can and cannot see, the unusual two-repo sync
relationship with genui-shell, and the reasoning behind every constraint.

## Run and test it

```
npm ci
npm test             # standalone suite: routing, refusals, every cap
npm run dev          # tsx, from source
# or
npm run build && npm start
```

Point a daemon at it: `MIRAFOLD_RELAY_URL=ws://localhost:8080 mirafold`.

The deeper cross-repo check — a real daemon driving a full remote turn through
this service — lives in genui-shell: `yarn test:server` runs
`server/relay-service.itest.ts` (9 tests) against this code.

## Deploy

See **DEPLOY.md** for the full runbook. Short version: Fly.io single instance,
TLS terminated by the platform, behind a domain we own (the indirection that
keeps the host replaceable), then `npm run smoke -- wss://relay.<domain>`.
