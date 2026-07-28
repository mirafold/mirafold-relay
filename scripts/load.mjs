// Load harness — proves the DoS caps actually bite on REAL hardware (PLAN R.6).
//
//   npm run load -- wss://genui-relay-staging.fly.dev [https://allowed-app-origin]
//
// Run it against STAGING, or a relay you own and can afford to saturate. It
// deliberately opens hundreds of sockets, floods frames, and parks half-open
// handshakes: pointed at production it is a self-inflicted outage, and pointed
// at someone else's host it is an attack. The relay refuses rather than
// degrades, so a healthy run ends with every phase reporting a clean refusal.
//
// Why a script and not a test: the caps are sized to the machine (memory, file
// descriptors, the platform's own edge limits), so the only answer that means
// anything comes from flooding the deployed VM. A CI runner would measure the
// runner. Re-run this after any cap retune or machine resize and compare the
// numbers — that comparison is the whole point of it being repeatable.
//
// What each phase reports, and what to do with it:
//   1. connection ramp — how many concurrent sockets are admitted before a
//      refusal. Should land at RELAY_MAX_CONNECTIONS (or the per-IP cap, if
//      that is lower and you are dialing from one host — it usually is).
//   2. frame rate     — frames/second one socket sustains before 4008.
//                       Compare against RELAY_RATE_MAX_FRAMES.
//   3. byte rate      — bytes/second one socket sustains before 4008.
//                       Compare against RELAY_RATE_MAX_BYTES.
//   4. slowloris      — half-open handshakes parked, and how fast the
//                       pre-handshake floor reaps them (RELAY_HEADERS_TIMEOUT_MS
//                       plus up to one RELAY_CONNECTION_CHECK_MS sweep).
//
// A 4xxx close is the SUCCESS signal here — it means a cap fired cleanly. What
// would be bad: sockets hanging open past every cap, the relay going
// unreachable for /health mid-run, or a phase ending with a transport error
// instead of a close code. The relay's own logs name WHICH cap fired (the
// client only ever sees 4004 for all three capacity caps) — read `fly logs`
// alongside this output.
//
// Env: RELAY_ENTITLEMENT_TOKEN (if the gate is on, as in production-like
// staging), same as the smoke script — env, never argv, so it stays out of
// shell history.

import { WebSocket } from "ws";
import net from "node:net";
import { randomBytes } from "node:crypto";

// Split "--name value" pairs from the two positional args, in any order.
const positional = [];
const flags = new Map();
for (const args = process.argv.slice(2); args.length > 0; ) {
  const arg = args.shift();
  if (arg.startsWith("--")) flags.set(arg, args.shift());
  else positional.push(arg);
}
const url = (positional[0] ?? process.env.RELAY_URL ?? "").replace(/\/$/, "");
const origin = positional[1] ?? process.env.RELAY_ORIGIN ?? "";
if (!/^wss?:\/\//.test(url) || (origin && !/^https?:\/\//.test(origin))) {
  console.error(
    "usage: npm run load -- wss://relay.host [https://allowed-app-origin]" +
      " [--max N] [--frames N] [--bytes N] [--slowloris N]",
  );
  process.exit(2);
}

const flag = (name, fallback) => {
  const n = Number(flags.get(name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
// Ceilings on how far each phase pushes — every one is a bound on OUR effort,
// not an expectation about the relay. A phase that hits its ceiling without a
// refusal reports "no cap fired", which is a finding, not a pass.
const MAX_SOCKETS = flag("--max", 400); // > the 256 default, so the cap trips
const MAX_FRAMES = flag("--frames", 20_000);
const MAX_BYTES = flag("--bytes", 512 * 1024 * 1024);
const SLOWLORIS = flag("--slowloris", 20);

const httpUrl = url.replace(/^ws/, "http");
const token = process.env.RELAY_ENTITLEMENT_TOKEN ?? "";
const daemonOpts = token ? { headers: { "mirafold-entitlement": token } } : {};
const viewportOpts = origin ? { headers: { origin } } : {};
const newPair = () => randomBytes(16).toString("base64url"); // 22 chars, like a real pairId

const live = new Set();
const track = (ws) => {
  live.add(ws);
  ws.once("close", () => live.delete(ws));
  return ws;
};
const closeAll = () => {
  for (const ws of live) {
    try {
      ws.terminate();
    } catch {
      /* already gone */
    }
  }
  live.clear();
};

const ms = (n) => `${Math.round(n)}ms`;
const rate = (n, elapsed) => Math.round(n / (elapsed / 1000)).toLocaleString();
const results = [];
const record = (phase, verdict, detail) => {
  results.push({ phase, verdict, detail });
  console.log(`  ${verdict === "capped" ? "✓" : "!"} ${detail}`);
};

/** Opens a socket and reports which came first: a refusal close, or an open
 * that survived the grace window. Refusals arrive as a close AFTER the
 * handshake (the relay's documented design), so "opened" alone proves
 * nothing — we must wait out the grace to know it was admitted. */
function dialOutcome(ws, graceMs = 400) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    ws.once("close", (code) => done({ ok: false, code }));
    ws.once("error", (err) => done({ ok: false, code: 0, error: err.message }));
    ws.once("open", () => setTimeout(() => done({ ok: true }), graceMs).unref());
  });
}

const closeCode = (ws) =>
  new Promise((resolve) => {
    ws.once("close", (code) => resolve(code));
    ws.once("error", () => {});
  });

/** The close code if one lands within the grace window, else null (the socket
 * is still open — no cap fired). */
const settle = (closing, graceMs = 2000) =>
  Promise.race([closing, new Promise((r) => setTimeout(() => r(null), graceMs).unref())]);
const nextMessage = (ws) => new Promise((r) => ws.once("message", (d) => r(String(d))));

/** A daemon + one viewport, ready to push traffic through. */
async function pair() {
  const id = newPair();
  const daemon = track(new WebSocket(`${url}/daemon?pair=${id}`, daemonOpts));
  const dialed = await dialOutcome(daemon);
  if (!dialed.ok) {
    throw new Error(
      dialed.code === 4007
        ? "daemon refused as unentitled (4007) — set RELAY_ENTITLEMENT_TOKEN"
        : `daemon dial-in failed (${dialed.error ?? `closed ${dialed.code}`})`,
    );
  }
  const announced = nextMessage(daemon);
  const viewport = track(new WebSocket(`${url}/ws?pair=${id}`, viewportOpts));
  const joined = await dialOutcome(viewport);
  if (!joined.ok) throw new Error(`viewport refused (closed ${joined.code})`);
  const { v } = JSON.parse(await announced);
  return { daemon, viewport, v };
}

// ---- phase 1: how many concurrent sockets before a refusal --------------
async function rampConnections() {
  console.log(`\n[1/4] connection ramp (up to ${MAX_SOCKETS})`);
  const started = Date.now();
  // A refusal is a close that lands SHORTLY AFTER its handshake opened, so it
  // can't be read from the socket we're currently dialing — by then we may be
  // two sockets ahead. Instead every socket reports its own fate as it lands,
  // and the admitted count is the live total once the dust settles.
  let dialed = 0;
  let closed = 0;
  let refusedCode = null;
  let transportError = null;
  for (let i = 0; i < MAX_SOCKETS; i++) {
    // Daemon dial-ins on distinct pair ids: each consumes a connection slot AND
    // a pair slot, so this ramp finds whichever ceiling is lower.
    const ws = track(new WebSocket(`${url}/daemon?pair=${newPair()}`, daemonOpts));
    ws.on("close", (code) => {
      closed++;
      if (code >= 4000 && refusedCode === null) refusedCode = code;
    });
    ws.on("error", (err) => (transportError ??= err.message));
    await new Promise((res) => {
      ws.once("open", res);
      ws.once("close", res);
      ws.once("error", res);
    });
    dialed++;
    if (refusedCode !== null || transportError !== null) break;
    await new Promise((r) => setImmediate(r)); // let any in-flight close land
  }
  await new Promise((r) => setTimeout(r, 500)); // settle refusals still in flight

  if (transportError !== null && refusedCode === null) {
    record("connections", "error", `socket ${dialed} failed without a close code (${transportError})`);
    return;
  }
  if (refusedCode === null) {
    record("connections", "uncapped", `no cap fired — ${dialed} sockets admitted, raise --max`);
    return;
  }
  record(
    "connections",
    "capped",
    `refused with ${refusedCode} at ${dialed - closed} concurrent sockets` +
      ` in ${ms(Date.now() - started)} — the relay's log line names which cap fired`,
  );
}

// ---- phase 2: frames per second on one socket ---------------------------
async function floodFrames() {
  console.log(`\n[2/4] frame-rate flood (up to ${MAX_FRAMES.toLocaleString()} frames)`);
  const { viewport } = await pair();
  const dropped = closeCode(viewport);
  const started = Date.now();
  let sent = 0;
  while (sent < MAX_FRAMES && viewport.readyState === WebSocket.OPEN) {
    viewport.send(`load-${sent++}`);
    if (sent % 200 === 0) await new Promise((r) => setImmediate(r));
  }
  const elapsed = Date.now() - started;
  // readyState flips as soon as the close FRAME arrives, which is before the
  // close EVENT carrying its code — so the loop above always exits first on a
  // cap hit. Wait for the code rather than racing it, or a fired cap reads as
  // "no cap fired" (the whole point of the phase, inverted).
  const tripped = await settle(dropped);
  if (tripped === null) {
    record("frame rate", "uncapped", `no cap fired after ${sent.toLocaleString()} frames`);
  } else {
    record(
      "frame rate",
      "capped",
      `closed ${tripped} after ${sent.toLocaleString()} frames in ${ms(elapsed)}` +
        ` (~${rate(sent, elapsed)} frames/s)`,
    );
  }
}

// ---- phase 3: bytes per second on one socket ----------------------------
async function floodBytes() {
  console.log(`\n[3/4] byte-rate flood (up to ${(MAX_BYTES / 1e6).toFixed(1)} MB)`);
  const { viewport } = await pair();
  const dropped = closeCode(viewport);
  const chunk = "z".repeat(256 * 1024); // well under the 8 MB frame ceiling
  const started = Date.now();
  let bytes = 0;
  while (bytes < MAX_BYTES && viewport.readyState === WebSocket.OPEN) {
    viewport.send(chunk);
    bytes += chunk.length;
    await new Promise((r) => setImmediate(r)); // let the socket drain
  }
  const elapsed = Date.now() - started;
  const tripped = await settle(dropped); // see floodFrames: wait, never race

  const mb = (bytes / 1e6).toFixed(1);
  if (tripped === null) {
    record("byte rate", "uncapped", `no cap fired after ${mb} MB`);
  } else {
    record(
      "byte rate",
      "capped",
      `closed ${tripped} after ${mb} MB in ${ms(elapsed)}` +
        ` (~${(bytes / 1e6 / (elapsed / 1000)).toFixed(1)} MB/s)`,
    );
  }
}

// ---- phase 4: half-open handshakes (the pre-handshake floor) ------------
async function slowloris() {
  console.log(`\n[4/4] slowloris: ${SLOWLORIS} half-open handshakes`);
  const { hostname, port } = new URL(httpUrl);
  const tls = httpUrl.startsWith("https");
  if (tls) {
    record(
      "slowloris",
      "skipped",
      "skipped over TLS — the platform edge terminates it, so this measures the" +
        " edge, not the relay's floor. Run it against a plain-ws self-host deploy.",
    );
    return;
  }
  const started = Date.now();
  const reaped = await Promise.all(
    Array.from({ length: SLOWLORIS }, () => {
      return new Promise((resolve) => {
        const sock = net.connect(Number(port || 80), hostname);
        const at = Date.now();
        const done = (dropped) => {
          sock.destroy();
          resolve(dropped ? Date.now() - at : null);
        };
        sock.once("connect", () => {
          sock.resume();
          // A header block deliberately left unterminated: the server can never
          // finish parsing it, so only the headers timeout frees the slot.
          sock.write("GET /health HTTP/1.1\r\nHost: relay\r\n");
        });
        sock.once("close", () => done(true));
        sock.once("error", () => done(true));
        setTimeout(() => done(false), 60_000).unref();
      });
    }),
  );
  const times = reaped.filter((t) => t !== null);
  if (times.length === SLOWLORIS) {
    record(
      "slowloris",
      "capped",
      `all ${SLOWLORIS} reaped in ${ms(Math.min(...times))}–${ms(Math.max(...times))}` +
        ` (total ${ms(Date.now() - started)})`,
    );
  } else {
    record(
      "slowloris",
      "uncapped",
      `${SLOWLORIS - times.length}/${SLOWLORIS} still parked after 60s —` +
        ` the pre-handshake floor is not bounding them`,
    );
  }
}

// ---- run ----------------------------------------------------------------
const deadline = setTimeout(() => {
  console.error("\n✗ load run exceeded 10 minutes — aborting");
  closeAll();
  process.exit(1);
}, 600_000);

try {
  const health = await fetch(`${httpUrl}/health`);
  if (health.status !== 200) throw new Error(`/health answered ${health.status} before we started`);
  console.log(`load target: ${url} (health ok)`);

  for (const phase of [rampConnections, floodFrames, floodBytes, slowloris]) {
    await phase();
    closeAll(); // each phase starts from an empty relay, and frees its slots
    await new Promise((r) => setTimeout(r, 1500)); // let rate windows lapse
  }

  // The relay must still be serving after all of it — refusing load is the
  // pass condition, going down is not.
  const after = await fetch(`${httpUrl}/health`);
  if (after.status !== 200) throw new Error(`relay unhealthy after the run (${after.status})`);

  const uncapped = results.filter((r) => r.verdict === "uncapped");
  const errored = results.filter((r) => r.verdict === "error");
  console.log(`\nrelay still healthy after the run.`);
  clearTimeout(deadline);
  if (errored.length || uncapped.length) {
    console.log(
      `\nload INCONCLUSIVE — ${[
        errored.length && `${errored.length} phase(s) errored`,
        uncapped.length && `${uncapped.length} phase(s) hit no cap`,
      ]
        .filter(Boolean)
        .join(", ")}. Raise the ceilings (--max/--frames/--bytes) or check the config.`,
    );
    process.exit(1);
  }
  console.log("load PASS — every phase was refused cleanly and the relay stayed up");
  process.exit(0);
} catch (err) {
  clearTimeout(deadline);
  closeAll();
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
}
