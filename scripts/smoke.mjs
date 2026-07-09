// Post-deploy smoke check — run this the minute `fly deploy` finishes:
//
//   npm run smoke -- wss://relay.your-domain.example
//
// Proves, against the LIVE relay: (1) /health answers over HTTPS, (2) a daemon
// dial-in and a viewport pair up, (3) an opaque payload round-trips both ways
// byte-identically, (4) a wrong pair id is refused. No genui-shell checkout,
// no real daemon — this is the transport-level go/no-go, not the full E2E
// (that's a real phone driving a session, PLAN R.6).

import { WebSocket } from "ws";
import { randomBytes } from "node:crypto";

const url = (process.argv[2] ?? process.env.RELAY_URL ?? "").replace(/\/$/, "");
if (!/^wss?:\/\//.test(url)) {
  console.error("usage: npm run smoke -- wss://relay.your-domain.example");
  process.exit(2);
}
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

  const daemon = await opened(new WebSocket(`${url}/daemon?pair=${pair}`), "daemon");
  step("daemon dialed in");

  const openMsg = nextMessage(daemon);
  const viewport = await opened(new WebSocket(`${url}/ws?pair=${pair}`), "viewport");
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

  const refused = await closeCode(new WebSocket(`${url}/ws?pair=${"0".repeat(22)}`));
  if (refused !== 4003) throw new Error(`unknown pair closed with ${refused}, expected 4003`);
  step("unknown pair id refused (4003)");

  daemon.close();
  viewport.close();
  clearTimeout(deadline);
  console.log("\nsmoke PASS — the relay forwards and refuses correctly");
  process.exit(0);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
