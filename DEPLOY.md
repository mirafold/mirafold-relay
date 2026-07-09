# Deploy runbook (PLAN R.2, sequencing steps b + c)

The code half is done and verified; this file is the exact sequence for deploy
day. Prerequisites you do once, in your own terminal — then the deploy itself
is about six commands.

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

3. **A domain you own** — any registrar. The daemon will point at
   `relay.<your-domain>`; owning the name is what keeps Fly replaceable by
   any VPS later without touching installed daemons.

## 1. First deploy

From this repo's root:

```
fly apps create genui-relay
fly deploy
```

`fly deploy` builds the Dockerfile remotely and starts one machine in `iad`
(both pinned in `fly.toml`). Watch for the health check going green.

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
npm run smoke -- wss://relay.<your-domain>
```

Green means: health answers over HTTPS, a daemon and viewport pair up, an
opaque payload round-trips byte-identically, and a bogus pair id is refused.

Then the real thing, from the genui-shell repo on your machine:

```
GENUI_RELAY_URL=wss://relay.<your-domain> yarn dev
```

Scan the QR with your phone **on cellular, wifi off** — that's R.2's
"Done when" (and R.6 repeats it as the real-hardware check, plus the
wifi→LTE mid-turn flip).

Also confirm the relay learned nothing: `fly logs` must show connection
metadata only — pair counts, close reasons — never frame contents. The code
can't log payloads (it never parses `p`), but deploy day is when we look.

## 4. Day-2 operations

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

- This repo becomes the source of truth; genui-shell's `relay-service/` copy
  is retired to a pointer (or kept synced via `npm run sync:check` in CI —
  decide then).
- Update genui-shell PLAN R.2: check the box with the date and the domain.
- The daemon's default relay URL (today `GENUI_RELAY_URL` must be set by
  hand) gets baked in as the paid-tier default during R.5 entitlement work.

## Rollback of the whole idea

Nothing here locks us in: the artifact is a plain Node process (`npm run
build && npm start` on any VPS behind any TLS proxy serves identically), and
every installed daemon just re-dials whatever `relay.<your-domain>` resolves
to. Moving hosts = repoint DNS.
