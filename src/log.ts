// Structured, metadata-only logging — the relay's ops window AND its
// auditable claim about what it records. One JSON object per line on stdout
// (`{"ts":"…","event":"…",…}`); this union IS the schema, mirrored prose-side
// in README "What the relay logs".
//
// By construction no event ever carries: a frame payload (`p` is E2E
// ciphertext the relay couldn't read anyway), a pairing id, or a client IP.
// The pairing id is NOT a bearer secret — the daemon derives it from the
// pairing code by SHA-256, so it decrypts nothing and completes no
// handshake — but holding it lets a stranger squat or flood that pair's
// slot, so it stays out of the logs all the same. Anything added here must
// preserve that — the public event list is only an honest audit surface
// while it stays complete and clean.

export type RefusalReason =
  | "bad_pair_id" // daemon: short/guessable or already-taken id; viewport: no such pairing
  | "pair_cap"
  | "viewport_cap"
  | "connection_cap"
  | "per_ip_cap"
  | "per_ip_rate"
  | "origin"
  | "entitlement";

export type RelayEvent =
  | { event: "listening"; host: string; port: number }
  | { event: "daemon_paired"; pairs: number; connections: number }
  // frames/bytes = opaque traffic forwarded across this pairing's lifetime,
  // both directions summed — volume, never content. bytes counts payload
  // string length (UTF-16 code units), which equals bytes for the base64/JSON
  // text real clients send; multibyte characters would undercount slightly.
  | { event: "daemon_unpaired"; pairs: number; durationMs: number; frames: number; bytes: number }
  | { event: "viewport_opened"; viewports: number; connections: number }
  | { event: "viewport_closed"; viewports: number; durationMs: number }
  | { event: "refused"; role: "daemon" | "viewport"; reason: RefusalReason; limit?: number; origin?: string }
  // A request target Node's HTTP parser accepted but WHATWG URL won't parse.
  // Carries no role (the path is what we failed to read) and never the target
  // itself — it's attacker-controlled text.
  | { event: "bad_request_target" }
  | { event: "rate_limited"; frames: number; bytes: number; windowMs: number }
  // A receiver (slow phone, wedged daemon) whose socket buffered past the
  // backpressure limit and was closed for it — queue sizes, never content.
  | { event: "backpressure_closed"; role: "daemon" | "viewport"; buffered: number; limit: number }
  | { event: "socket_error"; message: string }
  | { event: "shutdown"; signal: string }
  | { event: "crash"; kind: string; message: string };

export type RelayLog = (e: RelayEvent) => void;

export const stdoutLog: RelayLog = (e) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...e }));
