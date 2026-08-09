# Mirafold Relay

The hosted relay for [Mirafold](https://github.com/mirafold/mirafold) — a
**dumb, end-to-end-blind WebSocket forwarder**. It lets a Mirafold daemon
running on your machine be reached from a phone or a second device without
opening any inbound port: the daemon dials *out* to the relay, the browser
connects *in*, and the relay shuttles opaque frames between them. It is the
paid tier's substrate (Mirafold PLAN Phase R).

> **Open source (MIT)** — relicensed 2026-07-15, reversing the earlier
> open-core split (Mirafold PLAN Phase K.1). The paid tier sells the
> *hosted* convenience (`relay.mirafold.sh`), not code secrecy — open relay
> code lets anyone verify exactly what the relay can and cannot see, which
> is the point of an E2E-blind design. Self-hosting is expected and fine.
> The repo has been public since 2026-07-31. It is the relay's
> **single source of truth**
> (since the first deploy; Mirafold's vendored `relay-service/` dev copy
> and the sync scripts were retired 2026-07-15). The service is still verified
> against the REAL daemon from Mirafold: its `server/relay/relay-service.itest.ts`
> imports `src/` from this repo as a sibling checkout.

## What it does, and deliberately does not

- **Matches** one daemon dial-in (`/daemon?pair=<id>`) to any number of browser
  viewports (`/ws?pair=<id>`) by pair id, and forwards frames between them.
- **Never parses payloads.** The `p` field of every envelope is the
  end-to-end-encrypted WireMsg/ClientMsg (AES-GCM, keyed off the pairing code
  the relay never sees — see Mirafold `server/relay/relay-crypto.ts`). The relay
  routes on `t`/`v`/`pair` only. It logs no frame contents and stores nothing.
- **Serves no application bundle.** The only HTTP it answers is `GET /health`.
- **Enforces no credential policy — that lives in the daemon.** Only API-key or
  local/BYO sessions may be driven over the relay; a subscription-backed session
  is refused *by the Mirafold daemon* (`server/provider-policy.ts`, PLAN
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

Mirafold Relay closes that hole structurally: **it is a pure forwarder and serves
no JS.** The phone loads the Mirafold web app from a **separate static
origin** (the landing-page host), and only *then* opens an encrypted WebSocket
to the relay. A compromised relay can drop or scramble ciphertext (denial of
service) but can neither read it nor inject code into the page that produced
it. (The considered alternative — tunnelling the app bundle *through* the
daemon so client and daemon are always the same version — is a larger change
kept in reserve; Mirafold's tolerant wire schemas already make the
static-origin path's version skew survivable.)

### Versioning

The relay protocol version is baked into the pairing key derivation on the
daemon/browser side, so a future protocol bump is a clean break **by
construction**: an old client against a new relay simply fails to pair, which
the user sees as "wrong pairing code." There is nothing to negotiate here.

## Hardening (the DoS posture)

> **Deploying this yourself? Two env vars decide who can use your relay, and
> both default to _open_.** With neither set, any daemon can pair (no
> `RELAY_ENTITLEMENT_PUBLIC_KEY`) and a viewport from any web origin is admitted
> (no `RELAY_ALLOWED_ORIGINS`). That is the correct default for local dev, but a
> relay put on the public internet without at least the origin allowlist is a
> free forwarder for anyone who finds it. Set `RELAY_ALLOWED_ORIGINS` to the web
> origin that serves your phone app; add `RELAY_ENTITLEMENT_PUBLIC_KEY` if you
> want to gate pairing on a signed token. Both are detailed below.

Everything is bounded and refused rather than degraded, mirroring the daemon.
All values are env-overridable (`src/limits.ts`):

| env | default | meaning |
| --- | --- | --- |
| `RELAY_MAX_CONNECTIONS` | 256 | hard ceiling on live sockets — sized for launch scale and the machine's actual memory (2026-07-28; was 2000); raise per-deploy when real usage asks |
| `RELAY_MAX_CONNECTIONS_PER_IP` | 64 | live sockets one source IP may hold (0 disables) |
| `RELAY_MAX_NEW_CONNECTIONS_PER_IP` | 0 (off) | new connections one source IP may open per window before the rest are refused — bounds open/close churn the concurrent cap can't see; off by default (see note below) |
| `RELAY_NEW_CONNECTION_WINDOW_MS` | 60000 | fixed window for the cap above — a boundary-straddling burst can briefly see 2× (only meaningful when it's > 0) |
| `RELAY_MAX_PAIRS` | 128 | distinct daemons at once (2026-07-28; was 1000) |
| `RELAY_MAX_VIEWPORTS_PER_PAIR` | 8 | browser viewports per pair |
| `RELAY_MAX_PAYLOAD_BYTES` | 8000000 | single-frame ceiling |
| `RELAY_RATE_MAX_FRAMES` / `RELAY_RATE_WINDOW_MS` | 480 / 1000 | per-connection frame rate |
| `RELAY_RATE_MAX_BYTES` | 64000000 | per-connection bytes per window (the frame cap alone left frames × payload — gigabytes/s — legal); sized so a maxed-ring attach-replay (~43 MB sealed) passes; 0 disables |
| `RELAY_MAX_BUFFERED_BYTES` | 64000000 | send-side backpressure: a receiver whose socket buffers past this is closed `CLOSE_OVERLOADED` (a re-attach replays; nothing else bounds a stalled consumer's queue); 0 disables |
| `RELAY_HEARTBEAT_MS` | 30000 | ws ping interval; a missed ping is reaped |
| `RELAY_MAX_SOCKETS` | 320 | raw TCP sockets accepted at once — the pre-handshake floor; keep ≥ `RELAY_MAX_CONNECTIONS` so the app cap bites first; 0 = unbounded (2026-07-28; was 2400) |
| `RELAY_HEADERS_TIMEOUT_MS` | 15000 | ms to receive the full request headers before a stalled handshake is cut; 0 disables |
| `RELAY_REQUEST_TIMEOUT_MS` | 20000 | ms to receive the whole request before a stalled handshake is cut; 0 disables |
| `RELAY_CONNECTION_CHECK_MS` | 5000 | how often stalled handshakes are swept for the two timeouts above; 0 disables both |
| `RELAY_CLIENT_IP_HEADER` | *(unset)* | trusted header carrying the true client IP |
| `RELAY_ALLOWED_ORIGINS` | *(unset)* | comma-separated web origins allowed to open a viewport; unset = allow any |
| `RELAY_ENTITLEMENT_PUBLIC_KEY` | *(unset)* | Ed25519 public key (base64 SPKI DER) gating daemon pairings; unset = no entitlement check |
| `RELAY_ENTITLEMENT_MAX_TTL_SECONDS` | 604800 (7d) | ceiling on how far out a token's `exp` may lie — a signed but implausibly long-lived token (the minter issues 48h) is refused; 0 disables |
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

**The per-source connection-rate cap (`RELAY_MAX_NEW_CONNECTIONS_PER_IP`)**
covers the blind spot the concurrent cap above has: a source that opens and
immediately closes connections in a tight loop never accumulates a high
concurrent count, so the concurrent cap never fires, yet the churn still costs
the relay handshake work. This bounds *new connections per source per window*
(`RELAY_NEW_CONNECTION_WINDOW_MS`, default 60 s); a source over budget is
refused with a clean `CLOSE_OVERLOADED`. It ships **off by default** (`0`)
because the client re-dials on every disconnect (a phone flipping wifi↔LTE, a
daemon reconnecting on backoff), so a value set too low would refuse legitimate
reconnects — a self-inflicted outage. Enable it per-deploy with a generous
value once you've seen your real reconnect rates, the same way the origin and
entitlement gates are turned on deliberately rather than by default. Behind
Fly.io, set `RELAY_CLIENT_IP_HEADER` (already set) so it keys on the real
client IP, not the shared proxy address.

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
entitlement covers it. A signed token whose `exp` lies further out than
`RELAY_ENTITLEMENT_MAX_TTL_SECONDS` is refused too — the backstop against a
buggy or compromised minter granting effectively permanent access. Keypair
generation and hand-minting (comped beta access, ops smoke tests) live in
`scripts/entitlement.mjs`.

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

## What the relay logs

One JSON object per line on stdout — structured, metadata-only events, and the
list below is **exhaustive**: it is the complete claim about what this service
records. The typed schema lives in `src/log.ts`; a test pins that the lifecycle
events stay free of payloads and pairing ids.

| event | fields | when |
| --- | --- | --- |
| `listening` | `host`, `port` | boot (the relay's own bind address) |
| `daemon_paired` | `pairs`, `connections` | a daemon opens a pairing |
| `daemon_unpaired` | `pairs`, `durationMs`, `frames`, `bytes` | that pairing ends — traffic *volume* across its lifetime, both directions (`bytes` counts payload string length, equal to bytes for the base64 text real clients send) |
| `viewport_opened` / `viewport_closed` | counts, `durationMs` | a browser joins/leaves a pairing |
| `refused` | `role`, `reason`, `limit?`, `origin?` | any gate turns a socket away (`bad_pair_id`, `pair_cap`, `viewport_cap`, `connection_cap`, `per_ip_cap`, `per_ip_rate`, `origin`, `entitlement`) |
| `rate_limited` | `frames`, `bytes`, `windowMs` | a socket exceeds the frame or byte budget and is closed |
| `backpressure_closed` | `role`, `buffered`, `limit` | a receiver stalled past the send-buffer limit and is closed — queue sizes, never content |
| `socket_error` | `message` | a ws protocol violation (the socket is closed, the process lives) |
| `shutdown` / `crash` | `signal` / `kind`, `message` | process lifecycle |

What never appears in any event, by construction: **frame payloads** (E2E
ciphertext the relay could not read anyway), **pairing ids**, and **client IP
addresses** (IPs are counted in-memory for the DoS caps above, then
discarded — a `refused` event says a cap fired, never who hit it). Nothing
is written anywhere but stdout; the relay stores nothing.

A calibration on pairing ids: the id is **not a bearer secret**. The daemon
derives it as `b64url(SHA-256(code)[0..16))` — the pairing *code* never
reaches the relay, and the id decrypts nothing and cannot complete the E2E
handshake. Someone holding a pairing id can squat or flood that rendezvous
slot (denial), not read or join the session (disclosure). It stays out of
the relay's own logs all the same — but note the id necessarily rides the
upgrade URL's query string, so infrastructure *in front of* the relay (a
platform's edge proxy) may record request lines independently of this
process. That exposure is bounded by the same calibration.

## Repository layout

```
src/contract.ts   the routing envelope + close codes (mirrors mirafold's
                  server/relay/relay-protocol.ts; a contract-guard test there fails on drift)
src/limits.ts     the env-tuned DoS caps above
src/log.ts        the structured, metadata-only log schema ("What the relay
                  logs" above) + the stdout JSON-lines logger
src/relay.ts      startRelay() — the whole forwarder
src/main.ts       container entrypoint; drains on SIGTERM
test/             standalone suite (node:test + tsx, raw ws clients)
scripts/smoke.mjs post-deploy go/no-go against the live relay
scripts/load.mjs  load harness: proves the caps bite on real hardware —
                  run against staging, never production
scripts/deployed.mjs
                  what is actually running (per environment) and whether it
                  is behind main — measured off the live image, not a doc
scripts/entitlement.mjs
                  entitlement keypair + token ops: generate / mint / verify
Dockerfile        multi-stage, npm ci, runs as the unprivileged node user
fly.toml          single instance, /health check, auto_stop_machines=false
fly.staging.toml  the staging app's config (DEPLOY.md's staging runbook)
ARCHITECTURE.md   ground-up design: vocabulary, frame-routing flows, decisions
DEPLOY.md         the deploy-day runbook, command by command
```

New to this service? **[ARCHITECTURE.md](ARCHITECTURE.md)** is the guided tour —
the vocabulary (daemon, viewport, pair, pairing code), how a frame is routed end
to end, exactly what the relay can and cannot see, the two-repo relationship
with Mirafold, and the reasoning behind every constraint.

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
this service — lives in Mirafold: `yarn test:server` runs
`server/relay/relay-service.itest.ts` (12 tests) against this code.

## Deploy

See **DEPLOY.md** for the full runbook. Short version: Fly.io single instance,
TLS terminated by the platform, behind a domain we own (the indirection that
keeps the host replaceable), then
`npm run smoke -- wss://relay.<domain> https://<allowed-app-origin>`.
