# Deploy runbook (PLAN R.2, sequencing steps b + c)

The code half is done and verified; this file is the exact sequence for deploy
day. Prerequisites you do once, in your own terminal — then the deploy itself
is about six commands.

> **Access defaults to open — set the gating secrets before this faces real
> users.** A relay with none of the access-gating env vars set will pair *any*
> daemon and admit a viewport from *any* web origin (correct for local dev,
> wrong for the public internet). On the hosted deploy these are Fly secrets;
> a self-hoster sets the same env vars. The two that matter:
> - `RELAY_ALLOWED_ORIGINS` — the web origin serving the phone app (e.g.
>   `https://app.mirafold.com`). Unset admits any origin.
> - `RELAY_ENTITLEMENT_PUBLIC_KEY` — gate pairing on a signed token (the
>   paid-tier lock). Unset means no token is required.
>
> Optional churn brake: `RELAY_MAX_NEW_CONNECTIONS_PER_IP` (off by default —
> see the README; enable with a generous value once real reconnect rates are
> known, never so tight it refuses legitimate wifi↔LTE reconnects).

## 0. One-time prerequisites (Kyle)

1. **Fly.io account** — sign up at https://fly.io (free to create; this app
   fits the smallest paid machine, ~$2–3/mo class).
2. **flyctl** — install the CLI:

   ```
   curl -L https://fly.io/install.sh | sh
   ```

   Then log in (interactive — your own terminal, it opens a browser):

   ```
   fly auth login
   ```

3. **A credit card on the Fly account** — the trial stops every machine
   after 5 minutes (observed on first deploy, 2026-07-08); a stopped relay
   drops all live pairings. Add one at https://fly.io/trial before relying
   on the deploy.
4. **A domain you own** — any registrar. The daemon will point at
   `relay.<your-domain>`; owning the name is what keeps Fly replaceable by
   any VPS later without touching installed daemons. Not a blocker for
   deploying and smoking against `genui-relay.fly.dev`; it IS a blocker for
   launch (the daemon-side URL must be ours, never the platform's).

## 1. First deploy

From this repo's root:

```
fly apps create genui-relay
fly deploy --ha=false
```

`fly deploy` builds the Dockerfile remotely and starts the machine in `iad`.
Watch for the health check going green. **`--ha=false` matters:** without it
the first deploy creates TWO machines (Fly's high-availability default), and
pair affinity needs exactly one — a daemon on machine A and a phone on
machine B never meet. It happened on the real first deploy (2026-07-08);
the fix after the fact is `fly scale count 1`. Verify with `fly status`:
exactly one machine, `1 total, 1 passing`.

If the app name `genui-relay` is taken globally, pick another
(`fly apps create <name>` + update `app = ` in `fly.toml`) — the public name
users see is the domain, not the Fly app name.

## 2. Point the domain

```
fly certs add relay.<your-domain>
```

The command prints the DNS records to create at your registrar — a CNAME
`relay` → `genui-relay.fly.dev` (or the A/AAAA pair it shows; check what it
prints with `fly ips list`). Add them, then wait for:

```
fly certs check relay.<your-domain>
```

to report the certificate issued (usually minutes after DNS propagates).

## 3. Verify — the smoke check

```
npm run smoke -- wss://relay.<your-domain> https://<allowed-app-origin>
```

The second argument is the web origin the relay's `RELAY_ALLOWED_ORIGINS`
secret admits (the static app origin, e.g. `https://app.mirafold.com`); the
smoke's viewports present it as their `Origin` header. Omit it only against a
relay with no origin gate configured. (Before the domain exists, the same
check works against the platform name: `npm run smoke -- wss://genui-relay.fly.dev …`.)

Green means: health answers over HTTPS, a daemon and viewport pair up, an
opaque payload round-trips byte-identically, a bogus pair id is refused, and —
with the origin gate on — an origin-less viewport is refused.

Then the real thing, from the genui-shell repo on your machine:

```
MIRAFOLD_RELAY_URL=wss://relay.<your-domain> yarn dev
```

Scan the QR with your phone **on cellular, wifi off** — that's R.2's
"Done when" (and R.6 repeats it as the real-hardware check, plus the
wifi→LTE mid-turn flip).

Also confirm the relay learned nothing: `fly logs` must show connection
metadata only — pair counts, close reasons — never frame contents. The code
can't log payloads (it never parses `p`), but deploy day is when we look.

## 4. Day-2 operations

**Repeat deploys can run from GitHub instead of a terminal:** the `Deploy`
workflow (`.github/workflows/deploy.yml`) is manual-dispatch only — Actions →
Deploy → "Run workflow", pick the ref to ship. It needs a `FLY_API_TOKEN`
repo secret (`fly tokens create deploy -a genui-relay`, then Settings →
Secrets and variables → Actions); until that secret exists it fails at auth
and deploys nothing. Everything in §§0–3 (app create, certs, DNS, smoke)
stays manual — the workflow only does the `fly deploy` half.

| task | command |
| --- | --- |
| tail logs | `fly logs` |
| instance status / health | `fly status` |
| restart | `fly apps restart genui-relay` |
| roll back | `fly releases` then `fly deploy --image <previous image ref>` |
| tune a cap without redeploy | `fly secrets set RELAY_MAX_PAIRS=2000` (secrets are just env; triggers a restart — brief pairing drop) |
| scale up (same single-instance shape) | `fly scale vm shared-cpu-2x` |

Two standing constraints from `fly.toml`, do not "optimize" them away:

- `auto_stop_machines = false` — a stopped machine drops every live pairing.
- Single instance, single region — pair affinity is why. Multi-region needs
  the ~20-line `fly-replay` routing shim (PLAN's locked decision: add ONLY
  if growth demands it).

## 5. After the first deploy

- **Done 2026-07-15 (genui-shell PLAN Phase G):** this repo is the source of
  truth; genui-shell's `relay-service/` copy was reduced to a pointer README
  (removed entirely later that day, genui-shell H2.3) and the sync
  scripts are gone. genui-shell's real-daemon itest now imports the relay from
  this repo as a sibling checkout.
- Update genui-shell PLAN R.2: check the box with the date and the domain.
- The daemon's default relay URL (today `MIRAFOLD_RELAY_URL` must be set by
  hand) gets baked in as the paid-tier default during R.5 entitlement work.

## 6. Staging (R.5d — prove a ref before production)

A second Fly app, `genui-relay-staging`, built from the same Dockerfile via
`fly.staging.toml`. Differences from production, all deliberate: auto-stop
with `min_machines_running = 0` (idles at zero cost — a dropped pairing is
free in staging; a dial wakes it), the bare `*.fly.dev` URL (nothing
installed ever points at staging, so the own-domain rule doesn't apply),
and no entitlement/origin secrets (ungated — the smoke passes end-to-end
without a minted token).

**The flow it buys:**

```
# 1. Deploy the ref to staging: Actions → Deploy → Run workflow →
#    pick the ref, environment = staging (the default)
# 2. Smoke it:
npm run smoke -- wss://genui-relay-staging.fly.dev
# 3. Point a local shell at it for a real pairing check if warranted:
MIRAFOLD_RELAY_URL=wss://genui-relay-staging.fly.dev mirafold
# 4. Same workflow, same ref, environment = production
```

**Load-testing the caps (R.6) belongs here, on staging — never production.**

```
npm run load -- wss://genui-relay-staging.fly.dev
```

It ramps connections until one is refused, floods a socket past the frame and
byte budgets, and parks half-open handshakes against the pre-handshake floor,
reporting which cap fired at what threshold. A clean `4xxx` close is the pass
signal — the relay refuses rather than degrades. The client can't tell the
three capacity caps apart (all close `4004`), so read `fly logs -a
genui-relay-staging` alongside it: the `refused` event names the reason. Note
the slowloris phase self-skips over TLS (behind Fly's edge it would measure
the edge, not this process) — that phase is meaningful on a plain-`ws`
self-host deploy. Re-run it after any cap retune or machine resize and compare
the numbers; that comparison is why it's a script and not a one-off.

Tokens: each GitHub Environment (staging, production) holds its own
`FLY_API_TOKEN`, minted app-scoped with `fly tokens create deploy -a <app>`
— staging's token cannot touch production and vice versa. One-time setup
(done 2026-07-23): `fly apps create genui-relay-staging`, mint the token,
create the GitHub environment, set the secret.

## 7. Secret rotation (rotate-on-event, not calendar)

Two deploy-side secrets rotate here; the Pages-side billing secrets
(`ENTITLEMENT_PRIVATE_KEY`, Paddle keys) rotate in `mirafold-site` — its
PLAN.md holds that runbook. Policy is rotate-on-event (suspected exposure,
a departing collaborator), and each is app-scoped so blast radius is one app.

- **`FLY_API_TOKEN` (GitHub Environment secret, per environment).** Mint a
  fresh one — `fly tokens create deploy -a genui-relay` (or `-staging`) —
  set it under Settings → Secrets and variables → Actions → the matching
  Environment, then revoke the old token in the Fly dashboard (Account →
  Access Tokens). Disruption: none — the token is only read during a manual
  deploy dispatch; nothing live depends on it. Do staging and production
  separately (distinct tokens).

- **`RELAY_ENTITLEMENT_PUBLIC_KEY` (Fly secret) — the coupled half of the
  entitlement keypair.** This is HALF of a two-place rotation; the private
  half is the `mirafold-site` Pages secret `ENTITLEMENT_PRIVATE_KEY`, and the
  ORDER across the two decides the refusal-window size, so **rehearse on
  `genui-relay-staging` first**. Generate the pair with
  `node scripts/entitlement.mjs generate`. Because the relay holds exactly
  ONE public key (no overlap window), rotation is a brief coordinated
  cutover: set the new Pages private key + redeploy the site, then
  immediately `fly secrets set RELAY_ENTITLEMENT_PUBLIC_KEY=<new>` (which
  restarts the relay). Outstanding 48h tokens signed by the old key then fail
  verification → daemons re-exchange their license key on the
  `CLOSE_UNENTITLED` (4007) refusal and re-pair within one dial. Disruption:
  seconds of remote-access refusal during the cutover; local sessions
  untouched. Staging rehearsal proves the order and the self-heal before
  it's ever done to production.

## 8. DDoS posture + the Cloudflare-fronting exit (a shelf plan, not built)

**Accepted position:** a volumetric flood on `relay.mirafold.sh` is an
accepted availability risk. The relay is stateless and E2E-blind, holds no
data, and every LOCAL session is untouched by a relay outage; daemons
re-dial with backoff, so the blast radius is remote-access uptime for the
duration of an attack, nothing more. Application-layer floods (one host or a
modest botnet exhausting sockets/CPU) are already handled by the caps in the
README. What no in-process code can absorb is a network-layer flood that
saturates the pipe before our code runs — that's Fly's edge today, which
gives some absorption but isn't dedicated DDoS mitigation.

**The exit if it ever materializes: front the relay with Cloudflare's proxy**
(free plan includes unmetered DDoS mitigation and proxies WebSockets). This
is documented so it's a config change on a shelf, not a mid-incident
scramble. Steps, in order:

1. **DNS.** `relay.mirafold.sh` lives on the `mirafold.sh` zone at Namecheap
   today (pointing straight at Fly). Move that zone to Cloudflare (or host
   `relay` under the already-Cloudflare `mirafold.com`), and set the record
   **proxied** (orange cloud) → Cloudflare terminates the edge and forwards
   to the Fly origin. TLS: Cloudflare edge cert + Full (strict) to Fly, which
   keeps its own cert — no relay change.
2. **The trusted client-IP header changes.** With Cloudflare in front, Fly's
   edge (and thus `fly-client-ip`) now reports Cloudflare's address, not the
   real client — so the per-IP caps would collapse every visitor into one
   bucket. Flip `RELAY_CLIENT_IP_HEADER` from `fly-client-ip` to
   `cf-connecting-ip` (Cloudflare sets it to the true client). No code
   change — it's already the env-driven `clientIpHeader` in `relay.ts`.
3. **Close the origin bypass (the header-spoofing guard).** `cf-connecting-ip`
   is only trustworthy if clients cannot reach the Fly origin directly and
   spoof it. Restrict the Fly app to accept connections only from
   Cloudflare's IP ranges (Fly firewall / `fly ips` allowlist, or an origin
   check), so the header can't be forged by hitting Fly directly. This is the
   same "never trust the proxy header on a port an untrusted client can reach"
   rule already stated in `relay.ts`.
4. **Optional: a Cloudflare rate-limiting rule** on the WebSocket path as a
   second layer, mirroring the `/api/*` rule the site already uses.

Caveats to check at execution time (why it's not pre-built): Cloudflare's
free-plan WebSocket handling has connection-duration behavior worth verifying
against the heartbeat interval, and moving the `mirafold.sh` zone touches DNS
that currently also serves the install one-liner — both are fine but want a
deliberate maintenance window, not an under-fire rush. Documented; not built.

## Rollback of the whole idea

Nothing here locks us in: the artifact is a plain Node process (`npm run
build && npm start` on any VPS behind any TLS proxy serves identically), and
every installed daemon just re-dials whatever `relay.<your-domain>` resolves
to. Moving hosts = repoint DNS.
