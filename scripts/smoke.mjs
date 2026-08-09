// Post-deploy smoke check — run this the minute `fly deploy` finishes:
//
//   npm run smoke -- wss://relay.your-domain.example https://app.your-domain.example
//
// The second argument is the web origin the deployed relay allows
// (RELAY_ALLOWED_ORIGINS); every viewport connection presents it as its
// Origin header. Omit it only against a relay with no origin gate configured.
//
// Against a relay with the entitlement gate ON, set RELAY_ENTITLEMENT_TOKEN
// (mint one: ENTITLEMENT_PRIVATE_KEY=… node scripts/entitlement.mjs mint) —
// env, never argv, so the live token can't land in shell history. Without it
// a gated relay refuses the dial-in (4007) and the smoke says so and stops.
//
// Proves, against the LIVE relay: (1) /health answers over HTTPS, (2) a daemon
// dial-in and a viewport pair up, (3) an opaque payload round-trips both ways
// byte-identically, (4) a wrong pair id is refused, and — when an origin is
// given — (5) a viewport with no Origin is refused. No Mirafold checkout,
// no real daemon — this is the transport-level go/no-go, not the full E2E
// (that's a real phone driving a session, PLAN R.6).

import { WebSocket } from "ws";
import { randomBytes } from "node:crypto";

const url = (process.argv[2] ?? process.env.RELAY_URL ?? "").replace(/\/$/, "");
const origin = process.argv[3] ?? process.env.RELAY_ORIGIN ?? "";
if (!/^wss?:\/\//.test(url) || (origin && !/^https?:\/\//.test(origin))) {
  console.error(
    "usage: npm run smoke -- wss://relay.your-domain.example [https://allowed-app-origin.example]",
  );
  process.exit(2);
}
// Browsers stamp Origin on every WebSocket; the relay's viewport gate keys on
// it, so the smoke's viewports must present the allowed one to be admitted.
const viewportHeaders = origin ? { headers: { origin } } : {};
// Header name pinned by src/contract.ts ENTITLEMENT_HEADER.
const token = process.env.RELAY_ENTITLEMENT_TOKEN ?? "";
const daemonHeaders = token ? { headers: { "mirafold-entitlement": token } } : {};
const httpUrl = url.replace(/^ws/, "http");
const pair = randomBytes(16).toString("base64url"); // 22 chars, like a real pairId

const deadline = setTimeout(() => {
  console.error("✗ smoke timed out after 15s");
  process.exit(1);
}, 15_000);

const step = (msg) => console.log(`✓ ${msg}`);

function opened(ws, label) {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("close", (code) => reject(new Error(`${label}: closed ${code} before open`)));
    ws.once("error", (err) => reject(new Error(`${label}: ${err.message}`)));
  });
}
const nextMessage = (ws) => new Promise((r) => ws.once("message", (d) => r(String(d))));
const closeCode = (ws) =>
  new Promise((r) => {
    ws.once("close", (code) => r(code));
    ws.once("error", () => {});
  });

try {
  const health = await fetch(`${httpUrl}/health`);
  if (health.status !== 200 || (await health.text()) !== "ok") {
    throw new Error(`/health answered ${health.status}`);
  }
  step(`health ok (${httpUrl}/health)`);

  const daemon = await opened(new WebSocket(`${url}/daemon?pair=${pair}`, daemonHeaders), "daemon");
  step("daemon dialed in");
  // A gated relay accepts the handshake, then refuses (4007 = unentitled).
  // Without this, the smoke waits out its whole deadline on a dead pairing.
  daemon.once("close", (code) => {
    if (code === 4007) {
      console.error(
        "✗ relay refused the daemon as unentitled (4007) — the entitlement gate is ON; " +
          "mint a token (scripts/entitlement.mjs mint) and re-run with RELAY_ENTITLEMENT_TOKEN set",
      );
      process.exit(1);
    }
  });

  const openMsg = nextMessage(daemon);
  const viewport = await opened(
    new WebSocket(`${url}/ws?pair=${pair}`, viewportHeaders),
    "viewport",
  );
  const open = JSON.parse(await openMsg);
  if (open.t !== "open") throw new Error(`expected open envelope, got ${open.t}`);
  step("viewport paired");

  const up = `smoke-up-${randomBytes(8).toString("hex")}`;
  viewport.send(up);
  const framed = JSON.parse(await nextMessage(daemon));
  if (framed.t !== "frame" || framed.p !== up) throw new Error("upstream payload mangled");
  const down = `smoke-down-${randomBytes(8).toString("hex")}`;
  const arrived = nextMessage(viewport);
  daemon.send(JSON.stringify({ t: "frame", v: open.v, p: down }));
  if ((await arrived) !== down) throw new Error("downstream payload mangled");
  step("opaque payload round-trips byte-identically");

  const refused = await closeCode(
    new WebSocket(`${url}/ws?pair=${"0".repeat(22)}`, viewportHeaders),
  );
  if (refused !== 4003) throw new Error(`unknown pair closed with ${refused}, expected 4003`);
  step("unknown pair id refused (4003)");

  if (origin) {
    const noOrigin = await closeCode(new WebSocket(`${url}/ws?pair=${pair}`));
    if (noOrigin !== 4006) {
      throw new Error(`origin-less viewport closed with ${noOrigin}, expected 4006`);
    }
    step("viewport without an allowed Origin refused (4006)");
  }

  daemon.close();
  viewport.close();
  clearTimeout(deadline);
  console.log("\nsmoke PASS — the relay forwards and refuses correctly");
  process.exit(0);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
