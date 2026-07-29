// genui-relay entrypoint — the container's CMD. Reads PORT/HOST from the
// environment (limits come from env inside limits.ts), starts the forwarder,
// and shuts down cleanly on SIGTERM/SIGINT (the platform's stop signal).

import { startRelay } from "./relay.js";
import { envNum } from "./limits.js";
import { stdoutLog } from "./log.js";

// A crash stays loud and exits nonzero (the platform restarts the instance).
// The message field carries our own stack — server code paths, not user data.
// Registered BEFORE startRelay: a failed bind (EADDRINUSE, EACCES) throws
// during the await below, and with these handlers after it that crash left no
// structured event — a raw stack, invisible to anything reading the JSON log.
const crash = (kind: string) => (err: unknown) => {
  stdoutLog({
    event: "crash",
    kind,
    message: err instanceof Error ? (err.stack ?? err.message) : String(err),
  });
  process.exit(1);
};
process.on("uncaughtException", crash("uncaughtException"));
process.on("unhandledRejection", crash("unhandledRejection"));

const relay = await startRelay({
  // envNum, not Number(): a set-but-empty PORT (a platform-config accident)
  // would otherwise become 0 — an ephemeral port the health check can't find.
  port: envNum("PORT", 8080),
  host: process.env.HOST?.trim() || "0.0.0.0",
  // Set by the platform's edge (e.g. RELAY_CLIENT_IP_HEADER=fly-client-ip);
  // empty means the per-IP cap keys on the socket address (direct/dev).
  clientIpHeader: process.env.RELAY_CLIENT_IP_HEADER,
  // Comma-separated web origins allowed to open a viewport (e.g. the static
  // app origin, RELAY_ALLOWED_ORIGINS=https://app.mirafold.com). Unset = allow
  // any origin — the default until that static origin exists (R.5).
  allowedViewportOrigins: process.env.RELAY_ALLOWED_ORIGINS?.split(","),
  // Ed25519 public key (base64 SPKI DER) that signs paid-tier entitlement
  // tokens (R.5). Unset = no entitlement check — the default until billing
  // ships. The relay holds only the public half; the minting backend has the
  // private key.
  entitlementPublicKey: process.env.RELAY_ENTITLEMENT_PUBLIC_KEY,
});

let closing = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    stdoutLog({ event: "shutdown", signal: sig });
    relay.close().then(() => process.exit(0));
    // Never hang the platform's stop past its grace window.
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
