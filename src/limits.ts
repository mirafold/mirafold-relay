// genui-relay capacity + policy limits — the DoS posture, mirroring the
// daemon's (bounded everything, refuse rather than degrade). Every value is
// env-overridable for tuning without a redeploy; startRelay() options win
// over env (the tests pass options directly).

export type Limits = {
  /** Hard ceiling on live sockets across all pairs. */
  maxConnections: number;
  /** Live sockets one source IP may hold — stops one host eating the global
   * budget or squatting every pair slot. 0 disables the per-IP gate. */
  maxConnectionsPerIp: number;
  /** New connections one source IP may open per newConnectionWindowMs before
   * the rest are refused. The per-IP CONCURRENT cap can't see open/close churn
   * (each connection is short-lived, so the concurrent count never climbs);
   * this bounds that. 0 disables — the default, since the reconnect-heavy
   * client (any close is a re-dial; wifi↔LTE flips) makes a too-tight value a
   * self-inflicted outage, so it ships off and is enabled per-deploy after
   * tuning, like the origin/entitlement gates. */
  maxNewConnectionsPerIp: number;
  /** Fixed (tumbling) window for maxNewConnectionsPerIp — a burst straddling
   * a window boundary can briefly see up to 2× the cap. Only meaningful when
   * that cap is > 0. */
  newConnectionWindowMs: number;
  /** Distinct daemons (pairs) at once. */
  maxPairs: number;
  /** Browser viewports per pair — independent of the daemon's own cap. */
  maxViewportsPerPair: number;
  /** Single-frame byte ceiling (daemon frames carry whole WireMsgs). */
  maxPayloadBytes: number;
  /** Frames one connection may send per window before it's dropped. */
  rateMaxFrames: number;
  /** Bytes one connection may send per window before it's dropped (2026-07-27
   * audit: the frame-count cap alone left rateMaxFrames × maxPayloadBytes —
   * gigabytes per second — legal on a single socket). Sized so the biggest
   * legitimate burst passes: an attach-replay of a maxed daemon ring
   * (32 MB of messages, sealed + base64 ≈ 43 MB) must cross in one window.
   * 0 disables. */
  rateMaxBytes: number;
  rateWindowMs: number;
  /** Send-side backpressure (2026-07-27 audit): bytes the relay will let one
   * receiver's socket buffer (ws bufferedAmount) before treating it as
   * stalled and closing it CLOSE_OVERLOADED. Without this a slow consumer —
   * a phone that stopped draining, a wedged daemon — queues forwarded
   * frames in relay memory without bound, so every other cap is theoretical.
   * Closing (not dropping frames) keeps the stream gapless: the client
   * re-attaches and replays. Sized like rateMaxBytes: a full maxed-ring
   * replay (~43 MB) headed to a briefly-slow viewport must survive.
   * 0 disables. */
  maxBufferedBytes: number;
  /** ws-level ping interval; a socket that missed the last ping is reaped. 0 disables. */
  heartbeatMs: number;
  /** Raw TCP sockets the HTTP server accepts at once — a floor for the
   * self-host path (Fly's edge already bounds concurrency). Every cap above is
   * checked AFTER the WebSocket handshake, so half-open / never-upgraded sockets
   * escape them; this bounds them. Keep ≥ maxConnections so it never bites
   * before the app cap does. 0 = Node's default (unbounded). */
  maxSockets: number;
  /** ms to receive the complete request headers; a slowloris dribbling headers
   * is cut here. Handshake-only — the timer clears on upgrade, so a live
   * WebSocket is never cut by it. 0 disables. */
  headersTimeoutMs: number;
  /** ms to receive the entire request; bounds a handshake that stalls after the
   * headers. Handshake-only, like headersTimeoutMs. 0 disables. */
  requestTimeoutMs: number;
  /** How often Node sweeps live connections to enforce the two handshake
   * timeouts above. It is a poll, not a precise deadline: a stalled handshake
   * lives up to headersTimeout/requestTimeout PLUS one of these intervals. We
   * default tighter than Node's 30s so "15s" means roughly that. 0 disables the
   * sweep entirely — which also disables both timeouts above. */
  connectionCheckMs: number;
  /** Ceiling on how far in the future an entitlement token's `exp` may lie
   * (2026-07-12 audit, B2): the minting backend issues 48h tokens, so an `exp`
   * years out can only mean a buggy or compromised minter — reject it even
   * though the signature verifies. Only meaningful when the entitlement gate
   * (RELAY_ENTITLEMENT_PUBLIC_KEY) is on. 0 disables the ceiling. */
  entitlementMaxTtlSeconds: number;
};

// Exported for main.ts's PORT — Number("") === 0, and a set-but-empty PORT
// would bind an ephemeral port and fail the platform health check, the same
// accident class this guards against for every knob below.
export const envNum = (name: string, fallback: number): number => {
  // Number("") === 0, so a set-but-empty var (an easy .env/CI accident) would
  // silently become 0 — refuse-everything or cap-disabled, depending on the
  // knob — instead of the default. Empty/whitespace means unset; "0" is honored.
  const v = process.env[name]?.trim();
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const LIMITS: Limits = {
  // 256/320/128 (were 2000/2400/1000, 2026-07-28): launch scale needs
  // hundreds of sockets, not thousands, and the worst-case in-flight memory
  // the caps make legal must be sized against the actual machine (the Fly VM
  // has no [[vm]] section — the default is small). Raise per-deploy via env
  // when real usage asks for it.
  maxConnections: envNum("RELAY_MAX_CONNECTIONS", 256),
  maxConnectionsPerIp: envNum("RELAY_MAX_CONNECTIONS_PER_IP", 64),
  maxNewConnectionsPerIp: envNum("RELAY_MAX_NEW_CONNECTIONS_PER_IP", 0),
  newConnectionWindowMs: envNum("RELAY_NEW_CONNECTION_WINDOW_MS", 60_000),
  maxPairs: envNum("RELAY_MAX_PAIRS", 128),
  maxViewportsPerPair: envNum("RELAY_MAX_VIEWPORTS_PER_PAIR", 8),
  maxPayloadBytes: envNum("RELAY_MAX_PAYLOAD_BYTES", 8_000_000),
  rateMaxFrames: envNum("RELAY_RATE_MAX_FRAMES", 480),
  rateMaxBytes: envNum("RELAY_RATE_MAX_BYTES", 64_000_000),
  rateWindowMs: envNum("RELAY_RATE_WINDOW_MS", 1_000),
  maxBufferedBytes: envNum("RELAY_MAX_BUFFERED_BYTES", 64_000_000),
  heartbeatMs: envNum("RELAY_HEARTBEAT_MS", 30_000),
  maxSockets: envNum("RELAY_MAX_SOCKETS", 320),
  headersTimeoutMs: envNum("RELAY_HEADERS_TIMEOUT_MS", 15_000),
  requestTimeoutMs: envNum("RELAY_REQUEST_TIMEOUT_MS", 20_000),
  connectionCheckMs: envNum("RELAY_CONNECTION_CHECK_MS", 5_000),
  entitlementMaxTtlSeconds: envNum("RELAY_ENTITLEMENT_MAX_TTL_SECONDS", 604_800), // 7 days
};
