// genui-relay — the deployable dumb forwarder (PLAN Step R.2).
//
// The stub's shape (genui-shell server/relay/relay-stub.ts) grown up for the world:
// same routing, hardened for a public port. It matches ONE daemon dial-in to
// any number of browser viewports by pair id and shuttles opaque payloads. It
// parses only the envelope's routing fields (`t`/`v`/`pair`), never `p` (the
// E2E ciphertext), logs no frame contents, and stores nothing.
//
// It is a PURE WebSocket forwarder — it serves no application bundle. See
// README.md for why (the trust decision): a relay that served the phone's JS
// could steal the pairing code from the URL fragment, so the phone loads the
// app from a separate static origin and the relay only ever sees ciphertext.
// The only HTTP it answers is GET /health (for the platform's health check).

import { createServer, type IncomingMessage } from "node:http";
import { createPublicKey, randomUUID, verify as verifySignature, type KeyObject } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  CLOSE_BAD_CODE,
  CLOSE_CODE_TAKEN,
  CLOSE_FORBIDDEN_ORIGIN,
  CLOSE_OVERLOADED,
  CLOSE_RATE_LIMITED,
  CLOSE_UNENTITLED,
  DAEMON_PATH,
  ENTITLEMENT_HEADER,
  MIN_PAIR_ID_LENGTH,
  PAIR_PARAM,
  VIEWPORT_PATH,
  type DaemonToRelay,
  type RelayToDaemon,
} from "./contract.js";
import { LIMITS, type Limits } from "./limits.js";
import { stdoutLog, type RelayEvent, type RelayLog } from "./log.js";

export type RelayOptions = Partial<Limits> & {
  port?: number;
  host?: string;
  /** Structured, metadata-only event log (see log.ts for the full schema —
   * never payloads, pairing ids, or IPs). Defaults to JSON lines on stdout. */
  log?: RelayLog;
  /** Request header carrying the true client IP, set by the trusted proxy in
   * front of us (e.g. "fly-client-ip"). The socket address is the proxy's, so
   * without this every connection shares one per-IP bucket. Empty = direct
   * connection, use the socket address. Never trust this header on a port an
   * untrusted client can reach directly — it is spoofable there. */
  clientIpHeader?: string;
  /** Web origins allowed to open a VIEWPORT socket, e.g.
   * ["https://app.mirafold.com"]. The browser same-origin rule does NOT cover
   * WebSockets, so a stray page on any origin can otherwise open one (harmless
   * without the pairing code, but it's DoS surface). Empty/unset = allow any
   * origin (dev, and before the static app origin exists). Daemon dial-ins are
   * never gated — they carry no Origin header. Exact scheme+host(+port) match. */
  allowedViewportOrigins?: string[];
  /** Ed25519 public key (base64 SPKI DER) that signs entitlement tokens — the
   * paid-tier gate (R.5). When set, a daemon must present a valid, unexpired
   * token (header `mirafold-entitlement`) to open a pairing; the relay verifies
   * the signature + expiry OFFLINE (no Stripe call, no state — it stays a dumb
   * forwarder) and holds only the PUBLIC half, so it can never mint one. Unset =
   * no entitlement check (today's behavior, before billing ships). */
  entitlementPublicKey?: string;
};

export type Relay = {
  port: number;
  host: string;
  /** Live socket count — for the capacity test and future metrics. */
  connections: () => number;
  close: () => Promise<void>;
};

// openedAt/frames/bytes feed the daemon_unpaired volume event — counts of the
// opaque traffic forwarded, both directions, never its content.
type Pair = {
  daemon: WebSocket;
  viewports: Map<string, WebSocket>;
  openedAt: number;
  frames: number;
  bytes: number;
};

// Per-socket bookkeeping the ws library doesn't give us: liveness for the
// heartbeat reaper, sliding frame + byte counters for the rate limit, and the
// open stamp for close-event durations.
type Meta = { alive: boolean; windowStart: number; frames: number; bytes: number; openedAt: number };

// One incoming ws message's size, whatever shape the library delivered it in.
const rawSize = (d: RawData): number =>
  Array.isArray(d)
    ? d.reduce((n, b) => n + b.length, 0)
    : d instanceof ArrayBuffer
      ? d.byteLength
      : d.length;

export function startRelay(opts: RelayOptions = {}): Promise<Relay> {
  const cfg: Limits = { ...LIMITS, ...stripUndefined(opts) };
  const host = opts.host ?? "0.0.0.0";
  const log = opts.log ?? stdoutLog;

  const pairs = new Map<string, Pair>();
  const meta = new WeakMap<WebSocket, Meta>();
  const perIp = new Map<string, number>();
  // Per-IP sliding window of new-connection attempts (the churn gate, distinct
  // from perIp's concurrent count). Unlike perIp it is NOT freed when an IP's
  // sockets close — the whole point is to remember attempts across the window
  // even after they disconnect — so stale entries are swept in the heartbeat.
  const perIpRate = new Map<string, { windowStart: number; count: number }>();
  let connections = 0;

  const ipHeader = opts.clientIpHeader?.toLowerCase() ?? "";
  const clientIp = (req: IncomingMessage): string => {
    if (ipHeader) {
      const h = req.headers[ipHeader];
      const first = (Array.isArray(h) ? h[0] : h)?.split(",")[0].trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  // Per-IP new-connection rate gate. Returns true if this fresh connection is
  // within the window budget; false once a source has opened too many too fast.
  // Counts every attempt, whether or not the socket then closes — that is how
  // it catches open/close churn the concurrent per-IP cap can't. 0 = disabled.
  const withinConnectRate = (ip: string): boolean => {
    if (cfg.maxNewConnectionsPerIp <= 0) return true;
    const now = Date.now();
    const r = perIpRate.get(ip);
    if (!r || now - r.windowStart >= cfg.newConnectionWindowMs) {
      perIpRate.set(ip, { windowStart: now, count: 1 });
      return true;
    }
    r.count++;
    return r.count <= cfg.maxNewConnectionsPerIp;
  };

  // Viewport Origin allowlist. Empty set = allow any (preserves the pre-gate
  // behavior and dev/no-static-origin-yet). When set, only these exact origins
  // may open a viewport socket; anything else (including a missing Origin) is
  // refused. Daemon dial-ins bypass this — they are not browsers.
  const allowedOrigins = new Set(
    (opts.allowedViewportOrigins ?? []).map((o) => o.trim()).filter(Boolean),
  );
  const originAllowed = (req: IncomingMessage): boolean => {
    if (allowedOrigins.size === 0) return true;
    const origin = req.headers.origin;
    return typeof origin === "string" && allowedOrigins.has(origin);
  };

  // Entitlement gate (daemons only). null = no check (pre-billing default).
  // When configured, a daemon must present a valid, unexpired signed token.
  const entitlementKey: KeyObject | null = opts.entitlementPublicKey
    ? createPublicKey({
        key: Buffer.from(opts.entitlementPublicKey, "base64"),
        format: "der",
        type: "spki",
      })
    : null;
  const entitled = (req: IncomingMessage): boolean => {
    if (!entitlementKey) return true;
    const h = req.headers[ENTITLEMENT_HEADER];
    return entitlementValid(Array.isArray(h) ? h[0] : h, entitlementKey, cfg.entitlementMaxTtlSeconds);
  };

  // Pre-handshake flood floor. Every cap below is enforced AFTER the WebSocket
  // handshake, so raw TCP / half-open sockets that never upgrade would otherwise
  // be bounded only by Node's generous defaults — fine behind Fly's edge, but
  // the self-host/VPS path (DEPLOY.md) has no such floor. The two timeouts cut a
  // slowloris, swept every connectionsCheckingInterval; they must be passed as
  // createServer options — set as post-hoc properties, Node's timeout checker
  // silently ignores them (verified). Both clear on a successful upgrade, so a
  // live WebSocket is never severed by them. 0 disables the corresponding knob.
  const server = createServer(
    {
      connectionsCheckingInterval: cfg.connectionCheckMs,
      headersTimeout: cfg.headersTimeoutMs,
      requestTimeout: cfg.requestTimeoutMs,
    },
    (req, res) => {
      // The ONLY HTTP surface: a health check. Everything else is 404 — the
      // relay serves no app bundle by design (README, the trust decision).
      // HEAD is answered too: uptime monitors commonly probe with it (Node
      // suppresses the body on HEAD automatically).
      if ((req.method === "GET" || req.method === "HEAD") && req.url === "/health") {
        res.writeHead(200, { "content-type": "text/plain" }).end("ok");
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("genui-relay: not found");
    },
  );
  // maxConnections is a net.Server property and DOES take effect post-construction
  // (it caps raw accepted sockets immediately, no timeout sweep). 0 = unbounded.
  if (cfg.maxSockets > 0) server.maxConnections = cfg.maxSockets;

  // Daemon envelopes carry whole WireMsgs (artifacts, capped tool output), so
  // the frame ceiling sits well above any single client frame.
  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxPayloadBytes });

  // ws surfaces protocol violations (oversize frame, bad opcode) as 'error'
  // events; unhandled, one such frame would crash the whole process (an
  // uncaughtException in main.ts) and drop every live pairing. Swallow and
  // log — ws follows up with its own close (e.g. 1009) on that socket only.
  const guard = (ws: WebSocket) =>
    ws.on("error", (err: Error) => log({ event: "socket_error", message: err.message }));

  // Every gate turns a socket away the same way: a metadata-only log line and
  // a clean close, always together — never one without the other.
  const refuse = (
    ws: WebSocket,
    code: number,
    why: Omit<Extract<RelayEvent, { event: "refused" }>, "event">,
  ) => {
    log({ event: "refused", ...why });
    ws.close(code);
  };

  const track = (ws: WebSocket, ip: string) => {
    connections++;
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    const now = Date.now();
    meta.set(ws, { alive: true, windowStart: now, frames: 0, bytes: 0, openedAt: now });
    ws.on("pong", () => {
      const m = meta.get(ws);
      if (m) m.alive = true;
    });
    ws.once("close", () => {
      connections--;
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left <= 0) perIp.delete(ip);
      else perIp.set(ip, left);
    });
  };

  // Returns true if this frame is within the per-connection rate budget —
  // frames AND bytes per window (the frame count alone left rateMaxFrames ×
  // maxPayloadBytes legal per window, gigabytes per second; 2026-07-27
  // audit). On exceed it closes the socket and returns false. A flood must
  // cost the flooder its connection, not the relay's CPU.
  const withinRate = (ws: WebSocket, size: number): boolean => {
    const m = meta.get(ws);
    if (!m) return false;
    const now = Date.now();
    if (now - m.windowStart >= cfg.rateWindowMs) {
      m.windowStart = now;
      m.frames = 0;
      m.bytes = 0;
    }
    m.bytes += size;
    if (++m.frames > cfg.rateMaxFrames || (cfg.rateMaxBytes > 0 && m.bytes > cfg.rateMaxBytes)) {
      log({ event: "rate_limited", frames: m.frames, bytes: m.bytes, windowMs: cfg.rateWindowMs });
      ws.close(CLOSE_RATE_LIMITED);
      return false;
    }
    return true;
  };

  // Send-side backpressure (2026-07-27 audit): a receiver whose socket has
  // maxBufferedBytes queued in relay memory has stalled — a phone that
  // stopped draining, a wedged daemon. Nothing else bounds that queue, so
  // every other cap is theoretical without this. Close it (never drop
  // frames — the stream must stay gapless; a re-attach replays) and skip the
  // forward: the readyState guard at each send site keeps later frames from
  // racing the close handshake.
  const withinBackpressure = (receiver: WebSocket, role: "daemon" | "viewport"): boolean => {
    if (cfg.maxBufferedBytes <= 0 || receiver.bufferedAmount <= cfg.maxBufferedBytes) return true;
    log({
      event: "backpressure_closed",
      role,
      buffered: receiver.bufferedAmount,
      limit: cfg.maxBufferedBytes,
    });
    receiver.close(CLOSE_OVERLOADED);
    return false;
  };

  const acceptDaemon = (ws: WebSocket, pairId: string, ip: string) => {
    // One daemon per pair id, ever; a short/guessable id or a second
    // dial-in is refused, never silently adopted. And no more distinct
    // pairs than the cap — a hostile flood of dial-ins can't exhaust us.
    if (pairId.length < MIN_PAIR_ID_LENGTH || pairs.has(pairId)) {
      refuse(ws, CLOSE_CODE_TAKEN, { role: "daemon", reason: "bad_pair_id" });
      return;
    }
    if (pairs.size >= cfg.maxPairs) {
      refuse(ws, CLOSE_OVERLOADED, { role: "daemon", reason: "pair_cap", limit: cfg.maxPairs });
      return;
    }
    track(ws, ip);
    const pair: Pair = { daemon: ws, viewports: new Map(), openedAt: Date.now(), frames: 0, bytes: 0 };
    pairs.set(pairId, pair);
    log({ event: "daemon_paired", pairs: pairs.size, connections });
    ws.on("message", (data: RawData) => {
      if (!withinRate(ws, rawSize(data))) return;
      let env: DaemonToRelay;
      try {
        const parsed: unknown = JSON.parse(String(data));
        // JSON.parse can succeed with a non-envelope — "null" parses to null,
        // and reading `.t` off it would throw uncaught and kill the process.
        if (typeof parsed !== "object" || parsed === null) return;
        env = parsed as DaemonToRelay;
      } catch {
        return;
      }
      if (env.t === "pong") return;
      const viewport = pair.viewports.get(env.v);
      // `p` must be the string the contract promises: ws.send() throws on a
      // non-string (object/bool/null), and that throw here is uncaught — it
      // would kill the process. So a mistyped `p` is dropped, not forwarded.
      if (env.t === "frame" && typeof env.p === "string" && viewport?.readyState === WebSocket.OPEN) {
        if (!withinBackpressure(viewport, "viewport")) return;
        pair.frames++;
        pair.bytes += env.p.length;
        viewport.send(env.p); // opaque — routed, never parsed
      } else if (env.t === "close") {
        viewport?.close(CLOSE_BAD_CODE);
      }
    });
    ws.on("close", () => {
      pairs.delete(pairId);
      for (const viewport of pair.viewports.values()) viewport.close(CLOSE_BAD_CODE);
      log({
        event: "daemon_unpaired",
        pairs: pairs.size,
        durationMs: Date.now() - pair.openedAt,
        frames: pair.frames,
        bytes: pair.bytes,
      });
    });
  };

  const acceptViewport = (ws: WebSocket, pairId: string, ip: string) => {
    const pair = pairs.get(pairId);
    if (!pair) {
      refuse(ws, CLOSE_BAD_CODE, { role: "viewport", reason: "bad_pair_id" });
      return;
    }
    // Per-pair viewport cap: independent of the daemon's own remote-viewport
    // cap (defense in depth — a hostile relay-adjacent flood must not force
    // the daemon to fend off unbounded announcements).
    if (pair.viewports.size >= cfg.maxViewportsPerPair) {
      refuse(ws, CLOSE_OVERLOADED, {
        role: "viewport",
        reason: "viewport_cap",
        limit: cfg.maxViewportsPerPair,
      });
      return;
    }
    track(ws, ip);
    // 32 random bits across ≤8 live viewports: a collision would cross-wire
    // two sockets under one id, so regenerate on the astronomically rare hit.
    let v: string;
    do {
      v = randomUUID().slice(0, 8);
    } while (pair.viewports.has(v));
    pair.viewports.set(v, ws);
    log({ event: "viewport_opened", viewports: pair.viewports.size, connections });
    pair.daemon.send(JSON.stringify({ t: "open", v } satisfies RelayToDaemon));
    ws.on("message", (data: RawData) => {
      if (!withinRate(ws, rawSize(data))) return;
      if (pair.daemon.readyState === WebSocket.OPEN) {
        if (!withinBackpressure(pair.daemon, "daemon")) return;
        const p = String(data);
        pair.frames++;
        pair.bytes += p.length;
        pair.daemon.send(JSON.stringify({ t: "frame", v, p } satisfies RelayToDaemon));
      }
    });
    ws.on("close", () => {
      if (pair.viewports.delete(v)) {
        log({
          event: "viewport_closed",
          viewports: pair.viewports.size,
          durationMs: Date.now() - (meta.get(ws)?.openedAt ?? Date.now()),
        });
        if (pair.daemon.readyState === WebSocket.OPEN) {
          pair.daemon.send(JSON.stringify({ t: "close", v } satisfies RelayToDaemon));
        }
      }
    });
  };

  server.on("upgrade", (req, socket, head) => {
    // Node's HTTP parser hands the request target through largely unvalidated,
    // and `new URL` throws on plenty of targets it accepts — `GET //[` is
    // enough (verified 2026-07-27, ERR_INVALID_URL). An uncaught throw in this
    // handler reaches main.ts's uncaughtException, which exits the process, and
    // we run single-instance by design: one malformed request line from anyone
    // on the internet would drop EVERY live pairing. Treat an unparseable
    // target exactly like an unknown path — destroy the socket, stay up.
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "ws://relay");
    } catch {
      log({ event: "bad_request_target" });
      socket.destroy();
      return;
    }
    const pairId = url.searchParams.get(PAIR_PARAM) ?? "";
    const isDaemon = url.pathname === DAEMON_PATH;
    if (!isDaemon && url.pathname !== VIEWPORT_PATH) {
      socket.destroy();
      return;
    }
    const ip = clientIp(req);
    wss.handleUpgrade(req, socket, head, (ws) => {
      guard(ws);
      // Global capacity gate: the refused socket exists only long enough to
      // be told why (the client sees a clean CLOSE_OVERLOADED, not a hangup).
      const role = isDaemon ? ("daemon" as const) : ("viewport" as const);
      if (connections >= cfg.maxConnections) {
        refuse(ws, CLOSE_OVERLOADED, { role, reason: "connection_cap", limit: cfg.maxConnections });
        return;
      }
      // Per-source gate: one host can't hold more than its share, so it can
      // neither exhaust the global budget nor squat every pair slot.
      if (cfg.maxConnectionsPerIp > 0 && (perIp.get(ip) ?? 0) >= cfg.maxConnectionsPerIp) {
        refuse(ws, CLOSE_OVERLOADED, { role, reason: "per_ip_cap", limit: cfg.maxConnectionsPerIp });
        return;
      }
      // Per-source rate gate: the concurrent cap above can't see a source that
      // opens and closes connections in a tight loop; this bounds that churn.
      if (!withinConnectRate(ip)) {
        refuse(ws, CLOSE_OVERLOADED, {
          role,
          reason: "per_ip_rate",
          limit: cfg.maxNewConnectionsPerIp,
        });
        return;
      }
      // Origin gate (viewports only): with an allowlist configured, a socket
      // from any other web origin is refused before it can pair. Daemons carry
      // no Origin and are never gated here.
      if (!isDaemon && !originAllowed(req)) {
        refuse(ws, CLOSE_FORBIDDEN_ORIGIN, {
          role,
          reason: "origin",
          origin: req.headers.origin ?? "none",
        });
        return;
      }
      // Entitlement gate (daemons only): with a public key configured, a daemon
      // must present a valid, unexpired token to open a pairing — the paid-tier
      // gate. Viewports need no token; a pairing only exists behind an entitled
      // daemon, so the daemon's entitlement covers it.
      if (isDaemon && !entitled(req)) {
        refuse(ws, CLOSE_UNENTITLED, { role, reason: "entitlement" });
        return;
      }
      if (isDaemon) acceptDaemon(ws, pairId, ip);
      else acceptViewport(ws, pairId, ip);
    });
  });

  // Heartbeat reaper: ping every socket each interval; a socket that missed
  // the previous ping (dead TCP, sleeping phone with no FIN) is terminated so
  // it can't park a slot forever. Distinct from the daemon's app-level
  // zombie-viewport reaper — this one is about the transport being gone.
  const heartbeat =
    cfg.heartbeatMs > 0
      ? setInterval(() => {
          for (const pair of pairs.values()) {
            for (const ws of [pair.daemon, ...pair.viewports.values()]) {
              const m = meta.get(ws);
              if (!m) continue;
              if (!m.alive) {
                ws.terminate();
                continue;
              }
              m.alive = false;
              ws.ping();
            }
          }
          // Evict connect-rate windows that have fully elapsed, so the map holds
          // only sources seen within the last window rather than every IP ever.
          if (perIpRate.size > 0) {
            const now = Date.now();
            for (const [ip, r] of perIpRate) {
              if (now - r.windowStart >= cfg.newConnectionWindowMs) perIpRate.delete(ip);
            }
          }
        }, cfg.heartbeatMs)
      : null;
  if (heartbeat) heartbeat.unref?.();

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, host, () => {
      const port = (server.address() as { port: number }).port;
      log({ event: "listening", host, port });
      resolve({
        port,
        host,
        connections: () => connections,
        close: () =>
          new Promise((done) => {
            if (heartbeat) clearInterval(heartbeat);
            for (const pair of pairs.values()) {
              pair.daemon.terminate();
              for (const viewport of pair.viewports.values()) viewport.terminate();
            }
            server.close(() => done());
          }),
      });
    });
  });
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// Verifies a compact entitlement token, "<b64url(payloadJSON)>.<b64url(sig)>":
// an Ed25519 signature (by the key that pairs with entitlementKey) over the
// payload segment's bytes, and a payload `exp` (unix seconds) still in the
// future — but not further out than maxTtlSeconds (audit B2: the minter issues
// 48h tokens, so a far-future `exp` means a buggy or compromised minter even
// when the signature verifies; 0 disables the ceiling). Offline and
// side-effect-free — the relay stores nothing and calls no one. Any malformed,
// mis-signed, expired, or implausibly long-lived token returns false.
function entitlementValid(
  token: string | undefined,
  key: KeyObject,
  maxTtlSeconds: number,
): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return false;
  const payloadSeg = token.slice(0, dot);
  try {
    const sig = Buffer.from(token.slice(dot + 1), "base64url");
    if (!verifySignature(null, Buffer.from(payloadSeg), key, sig)) return false;
    const payload = JSON.parse(Buffer.from(payloadSeg, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    // Number.isFinite rejects a non-number, NaN, AND ±Infinity in one check.
    // The last matters: JSON.parse turns `1e999` into Infinity, and with the
    // max-TTL ceiling disabled (maxTtlSeconds === 0) an Infinity `exp` would
    // otherwise sail through as a never-expiring token. Only a holder of the
    // minter's private key could sign one, but the check costs nothing.
    if (!Number.isFinite(payload.exp)) return false;
    const expMs = (payload.exp as number) * 1000;
    const now = Date.now();
    if (expMs <= now) return false;
    return maxTtlSeconds === 0 || expMs <= now + maxTtlSeconds * 1000;
  } catch {
    return false;
  }
}
