# genui-relay — architecture

This document is for someone taking ownership of the relay. It explains what
the service is, the vocabulary, how the code is laid out, the two or three
flows that matter, and the decisions that shaped it — enough to change the code
confidently. The [README](README.md) is the front door (what it is, how to run,
the hardening knobs); [DEPLOY.md](DEPLOY.md) is the deploy-day runbook. This
file is the "how and why it works" underneath both.

---

## 1. What this service is, in one paragraph

genui-relay is a **dumb, end-to-end-blind WebSocket forwarder**. Its entire job
is to let a [genui-shell](https://github.com/kserrec/genui-shell) daemon running
on someone's laptop be reached from their phone (or a second device) **without
that laptop opening any inbound network port**. The laptop dials *out* to the
relay; the phone connects *in* to the relay; the relay matches the two and
shuttles opaque bytes between them. It never parses those bytes, never stores
them, and — by design — cannot read them. It is the paid tier's substrate in
the genui-shell roadmap (Phase R).

The guiding principle, which every design choice below serves: **the relay is a
liability to be minimized, not a place to add features.** The less it knows, the
less it can leak, the cheaper it is to run, and the easier it is to replace. So
it is deliberately kept small, stateless-per-restart, and vendor-neutral.

---

## 2. Vocabulary (define once, used throughout)

- **Daemon** — the Mirafold process on the user's own machine (the "server"
  half of Mirafold). It runs the actual coding agent. For remote access it
  opens an *outbound* WebSocket to the relay instead of listening for inbound
  connections. In relay terms it is the *one* authoritative endpoint per pair.
- **Viewport** — a browser tab connected *inbound* to the relay (the phone, or
  any second device). A single daemon can have several viewports at once. The
  relay assigns each one a short id (`v`) so the daemon can tell them apart.
- **Pair** — one daemon plus all of its viewports, grouped under a **pair id**.
  This is the relay's only real state: a `Map` from pair id to `{ daemon,
  viewports }`.
- **Pairing code** — a high-entropy secret (128-bit random) that Mirafold
  prints/QR-codes when a user starts a remote session. It is the root of trust
  for the end-to-end encryption. **The relay never sees the code.**
- **Pair id** — the base64url of the first 16 bytes of `SHA-256(pairing code)`
  (a 22-character string; derived by `derivePair()` in genui-shell's
  `server/relay-crypto.ts`). This is what travels to the relay in the connection
  URL (`?pair=<id>`). Because it's a one-way hash of the code, knowing the pair
  id does not reveal the code, so the relay can route on it without being able
  to decrypt anything.
- **Frame** — one message crossing the relay. The application payload inside a
  frame is the **ciphertext** of a Mirafold wire message; the relay treats
  it as an opaque string.
- **Envelope** — the thin JSON wrapper the relay and daemon use to say *which
  viewport* a frame belongs to (`{ t, v, p }`: a type, a viewport id, and the
  opaque payload). Viewports do not send envelopes — they send bare payloads,
  and the relay wraps/unwraps on their behalf (see §4).

---

## 3. Code map

Small on purpose — one runtime dependency (`ws`), five source files.

| File | Responsibility |
| --- | --- |
| `src/relay.ts` | The whole forwarder: `startRelay()` builds the HTTP+WS server, the routing tables, the caps, and the heartbeat. Everything of substance is here. |
| `src/contract.ts` | The routing contract — envelope types, URL paths, close codes, the minimum pair-id length. **Vendored** (a hand-kept copy) from genui-shell's `server/relay-protocol.ts`; see §6. |
| `src/limits.ts` | The DoS caps as an env-overridable `Limits` object. Pure config, no logic. |
| `src/main.ts` | The container entrypoint (`node dist/main.js`): reads env, calls `startRelay()`, drains on `SIGTERM`/`SIGINT`, and exits loudly on an uncaught error so the platform restarts it. |
| `test/relay.test.ts` | Standalone suite (node:test + tsx, raw `ws` clients). Pins routing, every refusal code, and every cap. Runs with no genui-shell checkout. |
| `scripts/smoke.mjs` | Post-deploy go/no-go against a *live* relay URL. Plain Node, zero deps beyond `ws`. |
| `scripts/sync-from-genui-shell.sh` | Pulls the shared files from genui-shell's `relay-service/` (the dev source of truth) or `--check`s for drift. See §6. |
| `Dockerfile` / `fly.toml` | Deploy: multi-stage build, unprivileged runtime user; single Fly.io instance with a `/health` check. |

The public API of the module is exactly three things exported from `relay.ts`:
`startRelay(opts)`, and the `RelayOptions` / `Relay` types. `startRelay` returns
a promise of a `Relay` handle with `{ port, host, connections(), close() }`.

---

## 4. Key flow: the life of a pairing session

This is the flow to understand before touching anything. All of it lives in
`startRelay()` in `src/relay.ts`.

**Step 0 — the HTTP surface.** The service is an `http.Server` whose only route
is `GET /health` → `"ok"`. Every other HTTP request gets a `404`. It serves *no*
application bundle (that is a security decision — see §7, "serves no JS").
WebSocket upgrades are handled separately via the server's `upgrade` event and a
`WebSocketServer({ noServer: true })`.

**Step 1 — a daemon dials in.** Mirafold opens `wss://<relay>/daemon?pair=<id>`.
The `upgrade` handler computes the client IP (`clientIp(req)`, see §5),
completes the WebSocket handshake, then calls `acceptDaemon(ws, pairId, ip)`:
- If the pair id is shorter than `MIN_PAIR_ID_LENGTH` (guessable dev junk) or a
  daemon already holds that id, it is refused with close code `CLOSE_CODE_TAKEN`
  (4002). One daemon per pair id, ever — never silently adopted.
- If we're at the `maxPairs` cap, refused with `CLOSE_OVERLOADED` (4004).
- **Entitlement gate (the paid-tier lock, R.5).** If `RELAY_ENTITLEMENT_PUBLIC_KEY`
  is configured, the daemon must present a valid, unexpired signed token on the
  `mirafold-entitlement` header or it is refused with `CLOSE_UNENTITLED` (4007).
  The relay verifies the Ed25519 signature + `exp` **offline** (`node:crypto`, no
  Stripe call, no state) and holds only the *public* key, so it can never mint a
  token. Unset = no check — today's default, until billing ships.
- Otherwise it is `track()`ed (counted toward the global and per-IP tallies) and
  stored as `pairs.set(pairId, { daemon: ws, viewports: new Map() })`.

**Step 2 — a viewport connects.** The phone opens `wss://<relay>/ws?pair=<id>`.
After the same handshake + capacity gates, `acceptViewport(ws, pairId, ip)`:
- Looks up the pair. No daemon holds that id → refused with `CLOSE_BAD_CODE`
  (4003).
- **Origin gate.** If `RELAY_ALLOWED_ORIGINS` is configured, a viewport whose
  `Origin` header is not on the list (or absent) is refused with
  `CLOSE_FORBIDDEN_ORIGIN` (4006). Unset = allow any — today's default, until the
  static app origin exists. (WebSocket upgrades aren't covered by the browser
  same-origin rule, so this is an explicit server-side check.)
- At the `maxViewportsPerPair` cap → refused with `CLOSE_OVERLOADED`.
- Otherwise assigns a short id `v = randomUUID().slice(0, 8)`, stores it in
  `pair.viewports`, and tells the daemon a viewport arrived:
  `daemon.send({ t: "open", v })`.

**Step 3 — frames flow, and the wrap/unwrap asymmetry.** This is the one
non-obvious mechanic:
- **Viewport → daemon:** the browser sends a *bare* opaque payload string. The
  relay wraps it with the viewport's id and forwards to the daemon:
  `daemon.send({ t: "frame", v, p: <payload> })`. The daemon needs `v` to know
  *which* viewport spoke.
- **Daemon → viewport:** the daemon sends a *full envelope*
  `{ t: "frame", v, p }`. The relay reads `v` to pick the destination viewport,
  then sends that viewport the *bare* `p` (`viewport.send(env.p)`) — a browser
  WebSocket just wants the payload, not the envelope.

In both directions `p` is untouched — routed on the envelope's `t`/`v` and never
parsed. The relay literally cannot look inside `p` (it's ciphertext; §5).

**Step 4 — closing, and the cascades.**
- A viewport disconnects → the relay removes it and tells the daemon
  `{ t: "close", v }` so it can clean up that viewport's server-side state.
- The daemon disconnects → the relay deletes the whole pair and closes every one
  of its viewports with `CLOSE_BAD_CODE`. A viewport with no daemon is useless,
  so it is dropped rather than left hanging.
- The client side of Mirafold treats *any* close as "reconnect", so these
  codes are informational — a dropped connection simply re-dials. That is also
  why refusals are delivered as a WebSocket close *after* the handshake rather
  than an HTTP rejection before it (see §7, "post-handshake refusal").

**Envelope reference** (`src/contract.ts`): daemon→relay is one of
`{t:"frame",v,p}` / `{t:"close",v}` / `{t:"pong"}`; relay→daemon is
`{t:"open",v}` / `{t:"frame",v,p}` / `{t:"close",v}` / `{t:"ping"}`. Liveness in
the deployed relay is done at the WebSocket *protocol* level (`ws.ping()` /
`pong` events in the heartbeat, §5), not with the app-level `ping`/`pong`
envelope entries — those exist in the vendored contract for the daemon side and
the relay merely ignores an app-level `pong` if one arrives.

---

## 5. Key flow: what the relay can and cannot see

The relay's selling point is that its operator (you, or any self-hoster)
**cannot read the traffic**. Understanding exactly where that boundary sits is
essential before you touch anything near routing or logging.

- The pairing **code** never travels to the relay. Only `pairId =
  SHA-256(code)` does, in the URL. So the relay knows a routing label but not
  the secret that label is derived from.
- Every `p` payload is AES-GCM ciphertext, encrypted end-to-end between the
  daemon and the viewport using keys derived from the code. The encryption is
  implemented on *both ends* in genui-shell's `server/relay-crypto.ts` — **not
  in this repo at all**. From the relay's side there is nothing to decrypt with;
  it only ever forwards `p`.
- The relay's logs record connection *metadata* only — pair counts, connection
  counts, close reasons, cap hits. They never contain `p`, and never even the
  pair id. (When you add logging, keep it that way: metadata, never payload.)

Concretely, "the relay learned nothing" is verified on deploy day by reading
`fly logs` and seeing only lines like `daemon paired (1 pair(s), 1 conn)`.

**The client-IP boundary.** The per-IP connection cap (below) needs the *real*
client IP. Behind a proxy like Fly.io, the raw socket address is the proxy's and
is shared by everyone, so `clientIp(req)` prefers a configured trusted header
(`RELAY_CLIENT_IP_HEADER`, set to `fly-client-ip` in `fly.toml`) and falls back
to the socket address only when no header is configured. **Security caveat baked
into the code comment:** never set that header on a port an untrusted client can
reach *without* going through the proxy — a client could then spoof it. On Fly,
only Fly's edge can set `fly-client-ip`, so it's trustworthy there.

---

## 6. The two-repo relationship (this is unusual — read it)

genui-relay is a **standalone, private repo** (the open-core split: genui-shell
is MIT, the hosted relay is not). But during development the shared service code
also lives *inside* genui-shell at `relay-service/`, and **that copy is the
source of truth until first deploy** — because only there can it be tested
against a real Mirafold daemon (`server/relay-service.itest.ts`, which stands
up the real daemon dialing the real service).

The mechanics:
- **Synced from genui-shell** (do not hand-edit here; edit in
  `genui-shell/relay-service/` and run `npm run sync`): `src/*.ts`,
  `tsconfig.json`, `fly.toml`, `.dockerignore`. `npm run sync:check` fails on
  drift.
- **Owned by this repo** (never synced): `package.json`, `package-lock.json`,
  `Dockerfile`, `.gitignore`, `README.md`, `ARCHITECTURE.md`, `DEPLOY.md`,
  `test/`, `scripts/`.
- **`src/contract.ts` is "vendored."** A separate repo cannot import from
  genui-shell, so the small, stable routing contract is *duplicated* from
  genui-shell's `server/relay-protocol.ts`. The two must stay byte-identical for
  the parts that both ends rely on; a **sync-guard test** in genui-shell's
  `relay-service.itest.ts` fails loudly if they diverge (a silent divergence
  would break pairing in production). If you change the contract, change it in
  genui-shell first, then sync.

After the first production deploy, the plan is for this repo to become the
source of truth and the in-shell copy to retire to a pointer (or a CI
`sync:check`). Until then: **genui-shell leads, genui-relay follows.**

---

## 7. Decisions and constraints (the "why", and what each rules out)

- **A dumb forwarder, not a smart server.** It parses only routing fields, keeps
  no history, and has no database. This is what makes it end-to-end-blind and
  cheap. It rules out any feature that would need to understand or persist
  traffic (server-side scrollback, replay, analytics on content) — those belong
  in the daemon, never here.
- **Portable Node + `ws`, no proprietary platform primitives.** The relay is a
  plain Node process that runs identically on Fly.io, any VPS, or `npm start`
  locally. Cloudflare Workers / Durable Objects were explicitly rejected: they'd
  solve pair-affinity for you but lock the launch-critical path into a rewrite
  to ever leave. The cost of that choice is that horizontal scaling (multiple
  instances) is *not* free — see the next point.
- **Single instance, single region — because of pair affinity.** A daemon and
  its viewport must land on the *same* relay process to find each other (the
  pair map is in-process memory). With more than one instance they can hash to
  different machines and never meet. So `fly.toml` pins one machine
  (`auto_stop_machines = false`, and deploy with `--ha=false` — the platform's
  default of two machines silently breaks pairing). The documented escape hatch
  for real growth is a ~20-line `fly-replay` routing shim, added *only* if
  demand requires it; that shim is the one place platform-specific code is
  permitted.
- **Serves no application JavaScript (the trust decision).** End-to-end
  encryption stops the relay *reading* traffic, but a relay that also served the
  phone's app bundle could ship tampered JS that steals the pairing code from
  the URL fragment *before* encryption happens — the honest asterisk on every
  browser "E2E" story. genui-relay closes that structurally by serving no JS at
  all: the phone loads the app from a *separate* static origin and only then
  opens the encrypted socket. A compromised relay can drop or scramble
  ciphertext (denial of service) but can neither read it nor inject page code.
  (README §"The trust decision" is the user-facing version of this.)
- **Refusals happen after the WebSocket handshake, on purpose.** Because the
  `ws` library completes the handshake inside `handleUpgrade` before our gate
  callback runs, a refused connection briefly opens and is then closed with a
  4xxx code. Every cap behaves this way, and the Mirafold client treats any
  close as "reconnect", so it is consistent and correct — not a bug. If you're
  ever tempted to reject earlier by destroying the socket pre-handshake, know
  you'd be making per-IP/global/pair refusals behave differently from each
  other for no client-visible benefit.
- **Protocol-version bumps are a clean break by construction.** The relay
  protocol version is baked into the pairing key derivation on the daemon/
  browser side. An old client against a new relay simply fails to pair, which
  the user sees as "wrong pairing code." There is nothing to negotiate and no
  compatibility matrix to maintain here.

---

## 8. The DoS / hardening posture

The relay faces the open internet, so everything is bounded and *refused rather
than degraded*. All values live in `src/limits.ts` and are env-overridable so
they can be tuned without a redeploy (see the README hardening table for the env
names and defaults). The mechanisms, and what each stops:

- **Global connection cap** (`maxConnections`, 2000) and **pair cap**
  (`maxPairs`, 1000) — ceilings on total live sockets and distinct daemons.
- **Per-IP connection cap** (`maxConnectionsPerIp`, 64) — the floor that stops
  *one* host from eating the whole global budget with many quiet connections, or
  squatting every pair slot with junk daemons. The per-*connection* frame-rate
  limit can't stop that (the attack is many idle connections, not one noisy
  one), which is exactly why this cap exists. It keys on the trusted client IP
  (§5). `0` disables it. (Added from the 2026-07-08 security audit, finding #1.)
- **Per-connection frame-rate limit** (`rateMaxFrames`/`rateWindowMs`, 480 per
  second) — a flooder loses its own connection (`CLOSE_RATE_LIMITED`, 4008), not
  the relay's CPU. Implemented as a sliding window in `withinRate()`.
- **Max payload** (`maxPayloadBytes`, 8 MB) — enforced by `ws` itself; an
  oversize frame closes that sender with the standard 1009. A `guard()` error
  handler on *every* accepted socket ensures such a protocol violation logs and
  closes the one socket instead of throwing an uncaught error that would crash
  the whole process (which would drop *every* pairing). This guard is
  load-bearing — do not remove it.
- **Heartbeat reaper** (`heartbeatMs`, 30 s) — WebSocket-level ping to every
  socket each interval; one that missed the previous ping (dead TCP, a sleeping
  phone that never sent a FIN) is `terminate()`d so it can't park a slot
  forever. `0` disables it (the tests disable it to stay deterministic).

The **viewport origin allowlist** (`RELAY_ALLOWED_ORIGINS`) and the **daemon
entitlement gate** (`RELAY_ENTITLEMENT_PUBLIC_KEY`) are both built (§4, Steps 1–2)
but **off by default** — each ships inert until its env value is set (the static
app origin, and the entitlement signing key, respectively), so production
behavior is unchanged until R.5 turns them on. Known gap still tracked in the
roadmap: there is no application-level per-IP *rate of new connections* yet; the
per-IP *concurrent* cap plus Fly.io's platform protection sit in front, and
load-testing the cap numbers on real hardware is filed under R.6.

---

## 9. Where things stand / the roadmap

genui-relay has **no roadmap of its own** — it is one step in genui-shell's plan.
The single source of truth for status and next steps is **genui-shell's
`PLAN.md`, Phase R**:

- **R.2** is this service. Status as of 2026-07-08: code complete and verified,
  **deployed** to `genui-relay.fly.dev`, smoke-tested, and a real daemon has
  driven a full turn through it. Still open before R.2's box closes (all on the
  genui-shell side): a credit card on the Fly account (the trial stops the
  machine after ~5 minutes), an owned domain plus `fly certs add` (so installed
  daemons point at *our* name, never `fly.dev`), and the cellular-phone
  real-hardware pass.
- **R.5** adds entitlement/billing and the static app-serving origin. The relay's
  two decision-independent halves already landed (2026-07-12): the `Origin`
  allowlist (`RELAY_ALLOWED_ORIGINS`) and the entitlement gate
  (`RELAY_ENTITLEMENT_PUBLIC_KEY`), both off by default. Still owed: the Stripe
  Checkout + token-minting backend, and setting the two env values at deploy.
- **R.6** load-tests the caps on real hardware.

Do not duplicate that plan here; read it there.

## 10. Known limitations (honest list)

- **No forward secrecy** in the encryption scheme (a genui-shell concern, not
  this repo's): if a pairing code leaks *later*, previously recorded ciphertext
  could be opened. Per-launch codes bound the window today; an ECDH handshake is
  the documented v2 candidate.
- **Single point of failure by design.** One instance means a relay restart
  drops every live pairing. Acceptable because daemons re-dial automatically and
  the relay holds no durable state — but it is a real availability characteristic
  to know.
- **Pair affinity blocks naive horizontal scaling** (§7). Growth past one
  instance needs the `fly-replay` shim, not just "add machines."
- **NAT'd populations may trip the per-IP cap** — an office behind one public IP
  shares one bucket. The cap is env-tunable for exactly this; R.6 load-testing
  will confirm the default of 64 is right.
