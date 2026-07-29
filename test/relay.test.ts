// Standalone verification of the forwarder — no genui-shell checkout needed.
// These tests speak the routing contract directly with raw ws clients; the
// cross-repo proof that a REAL daemon drives a full turn through this service
// lives in genui-shell (server/relay/relay-service.itest.ts, Tier 2) and stays the
// deeper check. Here we pin what the relay itself promises: routing, refusal
// codes, and every DoS cap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync, sign as signMessage, type KeyObject } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import net from "node:net";
import { WebSocket } from "ws";
import type { Limits } from "../src/limits.js";
import { startRelay, type Relay, type RelayOptions } from "../src/relay.js";
import type { RelayEvent } from "../src/log.js";
import {
  CLOSE_BAD_CODE,
  CLOSE_CODE_TAKEN,
  CLOSE_FORBIDDEN_ORIGIN,
  CLOSE_OVERLOADED,
  CLOSE_RATE_LIMITED,
  CLOSE_UNENTITLED,
  ENTITLEMENT_HEADER,
  type RelayToDaemon,
} from "../src/contract.js";

const PAIR = "a-real-22-char-pair-id";

async function relay(opts: RelayOptions = {}): Promise<Relay> {
  return startRelay({ host: "127.0.0.1", heartbeatMs: 0, log: () => {}, ...opts });
}

function dial(r: Relay, path: string, pair: string, headers?: Record<string, string>): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${r.port}${path}?pair=${pair}`, { headers });
}

/** Resolves once open; rejects if the server closes/refuses it first. */
function opened(ws: WebSocket): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("close", (code) => reject(new Error(`closed ${code} before open`)));
    ws.once("error", reject);
  });
}

/** Resolves with the close code, whether or not the socket opened first. */
function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.once("close", (code) => resolve(code));
    ws.once("error", () => {}); // refusal may surface as an error event too
  });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => ws.once("message", (d) => resolve(String(d))));
}

/** Resolves with the first envelope of type `t`, skipping any queued ahead of
 * it — for when other traffic (a viewport closing) may arrive first. */
function nextEnvelope(ws: WebSocket, t: string): Promise<{ t: string; v: string }> {
  return new Promise((resolve) => {
    const onMessage = (d: unknown) => {
      const env = JSON.parse(String(d)) as { t: string; v: string };
      if (env.t !== t) return;
      ws.off("message", onMessage);
      resolve(env);
    };
    ws.on("message", onMessage);
  });
}

/** The common preamble: a daemon and one viewport paired on PAIR, resolved
 * once the daemon has been told the viewport's id. */
async function paired(r: Relay): Promise<{ daemon: WebSocket; viewport: WebSocket; v: string }> {
  const daemon = await opened(dial(r, "/daemon", PAIR));
  const openMsg = nextMessage(daemon);
  const viewport = await opened(dial(r, "/ws", PAIR));
  const { v } = JSON.parse(await openMsg) as { v: string };
  return { daemon, viewport, v };
}

test("health answers ok; every other HTTP path is 404 (serves no bundle)", async () => {
  const r = await relay();
  try {
    const base = `http://127.0.0.1:${r.port}`;
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok");
    // Uptime monitors commonly probe with HEAD — it must answer too.
    const headProbe = await fetch(`${base}/health`, { method: "HEAD" });
    assert.equal(headProbe.status, 200);
    for (const path of ["/", "/index.html", "/assets/app.js", "/daemon"]) {
      assert.equal((await fetch(`${base}${path}`)).status, 404, path);
    }
  } finally {
    await r.close();
  }
});

test("pairs a daemon with a viewport and shuttles opaque payloads both ways", async () => {
  const r = await relay();
  try {
    const daemon = await opened(dial(r, "/daemon", PAIR));
    const openMsg = nextMessage(daemon);
    const viewport = await opened(dial(r, "/ws", PAIR));

    const open = JSON.parse(await openMsg) as RelayToDaemon;
    assert.equal(open.t, "open");
    const v = (open as { v: string }).v;

    // Viewport → daemon: payload arrives wrapped in a frame envelope, verbatim.
    const up = "opaque-ciphertext-⚡-" + "x".repeat(500);
    viewport.send(up);
    const framed = JSON.parse(await nextMessage(daemon)) as RelayToDaemon;
    assert.deepEqual(framed, { t: "frame", v, p: up });

    // Daemon → viewport: the p field lands unwrapped, byte-identical.
    const down = "also-opaque-" + "y".repeat(500);
    const arrived = nextMessage(viewport);
    daemon.send(JSON.stringify({ t: "frame", v, p: down }));
    assert.equal(await arrived, down);
  } finally {
    await r.close();
  }
});

test("routes each frame to the addressed viewport only, among several", async () => {
  const r = await relay();
  try {
    const daemon = await opened(dial(r, "/daemon", PAIR));
    const open1 = nextMessage(daemon);
    const vp1 = await opened(dial(r, "/ws", PAIR));
    const { v: v1 } = JSON.parse(await open1) as { v: string };
    const open2 = nextMessage(daemon);
    const vp2 = await opened(dial(r, "/ws", PAIR));
    const { v: v2 } = JSON.parse(await open2) as { v: string };
    assert.notEqual(v1, v2, "each viewport gets its own id");

    // Down: a frame addressed to v2 reaches viewport 2 alone — nothing leaks
    // to viewport 1 — and a frame for a viewport id that doesn't exist is
    // dropped harmlessly (same-socket ordering: for-two arriving proves the
    // stray was processed and survived).
    const strays: string[] = [];
    vp1.on("message", (d) => strays.push(String(d)));
    const at2 = nextMessage(vp2);
    daemon.send(JSON.stringify({ t: "frame", v: "no-such-v", p: "lost" }));
    daemon.send(JSON.stringify({ t: "frame", v: v2, p: "for-two" }));
    assert.equal(await at2, "for-two");
    await new Promise((res) => setTimeout(res, 50)); // let any misdelivery land
    assert.deepEqual(strays, [], "viewport 1 heard nothing");

    // Up: each viewport's frames arrive tagged with its own id.
    const up1 = nextMessage(daemon);
    vp1.send("from-one");
    assert.deepEqual(JSON.parse(await up1), { t: "frame", v: v1, p: "from-one" });
    const up2 = nextMessage(daemon);
    vp2.send("from-two");
    assert.deepEqual(JSON.parse(await up2), { t: "frame", v: v2, p: "from-two" });
  } finally {
    await r.close();
  }
});

test("a daemon-sent close envelope drops that viewport; the pairing itself survives", async () => {
  const r = await relay();
  try {
    const { daemon, viewport, v } = await paired(r);
    const dropped = closeCode(viewport);
    const echoed = nextMessage(daemon);
    daemon.send(JSON.stringify({ t: "close", v }));
    assert.equal(await dropped, CLOSE_BAD_CODE, "the addressed viewport is closed");
    // The relay's viewport-close handler then confirms the drop to the daemon…
    assert.deepEqual(JSON.parse(await echoed), { t: "close", v });
    // …and the pairing is intact: the daemon is up and a fresh viewport joins.
    assert.equal(daemon.readyState, WebSocket.OPEN);
    await opened(dial(r, "/ws", PAIR));
  } finally {
    await r.close();
  }
});

test("refuses a guessably short pair id", async () => {
  const r = await relay();
  try {
    assert.equal(await closeCode(dial(r, "/daemon", "short")), CLOSE_CODE_TAKEN);
  } finally {
    await r.close();
  }
});

test("refuses a second daemon on a taken pair id", async () => {
  const r = await relay();
  try {
    await opened(dial(r, "/daemon", PAIR));
    assert.equal(await closeCode(dial(r, "/daemon", PAIR)), CLOSE_CODE_TAKEN);
  } finally {
    await r.close();
  }
});

test("refuses a viewport for a pair no daemon holds", async () => {
  const r = await relay();
  try {
    assert.equal(await closeCode(dial(r, "/ws", PAIR)), CLOSE_BAD_CODE);
  } finally {
    await r.close();
  }
});

test("caps distinct pairs", async () => {
  const r = await relay({ maxPairs: 1 });
  try {
    await opened(dial(r, "/daemon", PAIR));
    assert.equal(await closeCode(dial(r, "/daemon", "another-pair-id-22-ch")), CLOSE_OVERLOADED);
  } finally {
    await r.close();
  }
});

test("caps viewports per pair, independent of the daemon's own cap", async () => {
  const r = await relay({ maxViewportsPerPair: 2 });
  try {
    await opened(dial(r, "/daemon", PAIR));
    await opened(dial(r, "/ws", PAIR));
    await opened(dial(r, "/ws", PAIR));
    assert.equal(await closeCode(dial(r, "/ws", PAIR)), CLOSE_OVERLOADED);
  } finally {
    await r.close();
  }
});

test("caps total connections globally", async () => {
  const r = await relay({ maxConnections: 2 });
  try {
    await opened(dial(r, "/daemon", PAIR));
    await opened(dial(r, "/ws", PAIR));
    assert.equal(r.connections(), 2);
    assert.equal(await closeCode(dial(r, "/ws", PAIR)), CLOSE_OVERLOADED);
  } finally {
    await r.close();
  }
});

test("caps live connections from one source IP", async () => {
  // All test sockets share 127.0.0.1, so two fill the cap and the third —
  // whichever kind — is refused. Stops one host eating the global budget.
  const r = await relay({ maxConnectionsPerIp: 2 });
  try {
    await opened(dial(r, "/daemon", PAIR));
    await opened(dial(r, "/ws", PAIR));
    assert.equal(await closeCode(dial(r, "/ws", PAIR)), CLOSE_OVERLOADED);
  } finally {
    await r.close();
  }
});

test("caps the RATE of new connections from one source IP (churn the concurrent cap can't see)", async () => {
  // Concurrent per-IP cap disabled to isolate the rate gate; a wide window so
  // all attempts fall inside it. Three new connections are allowed; the fourth
  // from the same source is refused even though the earlier ones already closed
  // — exactly the open/close churn the concurrent count never registers.
  const r = await relay({
    maxNewConnectionsPerIp: 3,
    newConnectionWindowMs: 60_000,
    maxConnectionsPerIp: 0,
  });
  try {
    // Viewports for a pair no daemon holds: each would close with CLOSE_BAD_CODE
    // on its own, but the rate gate runs first and counts every attempt.
    for (let i = 0; i < 3; i++) {
      assert.equal(await closeCode(dial(r, "/ws", PAIR)), CLOSE_BAD_CODE);
    }
    assert.equal(await closeCode(dial(r, "/ws", PAIR)), CLOSE_OVERLOADED);
  } finally {
    await r.close();
  }
});

test("the connect-rate window resets: a refused source is admitted again once it elapses", async () => {
  // The gate must be a brake, not a permanent lockout — the window self-resets
  // on the next attempt after it elapses. (The heartbeat's perIpRate sweep is
  // memory hygiene only; this reset works with the heartbeat off, as here.)
  const r = await relay({
    maxNewConnectionsPerIp: 2,
    newConnectionWindowMs: 400,
    maxConnectionsPerIp: 0,
  });
  try {
    assert.equal(await closeCode(dial(r, "/ws", PAIR)), CLOSE_BAD_CODE);
    assert.equal(await closeCode(dial(r, "/ws", PAIR)), CLOSE_BAD_CODE);
    assert.equal(await closeCode(dial(r, "/ws", PAIR)), CLOSE_OVERLOADED); // over budget
    await new Promise((res) => setTimeout(res, 500)); // the window elapses
    assert.equal(await closeCode(dial(r, "/ws", PAIR)), CLOSE_BAD_CODE); // back in
  } finally {
    await r.close();
  }
});

test("per-IP cap keys on the configured trusted header, and frees on close", async () => {
  const r = await relay({ maxConnectionsPerIp: 2, clientIpHeader: "x-real-ip" });
  const ONE = { "x-real-ip": "1.1.1.1" };
  const TWO = { "x-real-ip": "2.2.2.2" };
  try {
    await opened(dial(r, "/daemon", PAIR, ONE)); // 1.1.1.1 slot 1
    const v1 = await opened(dial(r, "/ws", PAIR, ONE)); // slot 2 — now at cap
    // A different source is unaffected — separate bucket.
    await opened(dial(r, "/daemon", "second-pair-id-22-char", TWO));
    // A third from the saturated source is refused.
    assert.equal(await closeCode(dial(r, "/ws", PAIR, ONE)), CLOSE_OVERLOADED);
    // Freeing one of that source's slots (the pair stays up) lets it back in.
    v1.close();
    await new Promise((res) => setTimeout(res, 100));
    await opened(dial(r, "/ws", PAIR, ONE));
  } finally {
    await r.close();
  }
});

test("the trusted client-IP header may be a comma list — the first hop is the client", async () => {
  const r = await relay({ maxConnectionsPerIp: 1, clientIpHeader: "x-real-ip" });
  try {
    await opened(dial(r, "/daemon", PAIR, { "x-real-ip": "9.9.9.9, 10.0.0.1" }));
    // The same client via a different proxy chain lands in the same bucket.
    assert.equal(
      await closeCode(dial(r, "/ws", PAIR, { "x-real-ip": "9.9.9.9" })),
      CLOSE_OVERLOADED,
    );
  } finally {
    await r.close();
  }
});

test("viewport Origin allowlist: unset allows any; set admits only its origins, refuses the rest", async () => {
  // Unset (default): a viewport from any web origin is admitted — the
  // pre-allowlist behavior is preserved.
  {
    const r = await relay();
    try {
      await opened(dial(r, "/daemon", PAIR));
      await opened(dial(r, "/ws", PAIR, { origin: "https://anything.example" }));
    } finally {
      await r.close();
    }
  }
  // Configured: only the listed origin opens a viewport; a wrong origin AND a
  // missing Origin are both refused. The daemon (no Origin) is never gated.
  {
    const ALLOWED = "https://app.mirafold.com";
    const r = await relay({ allowedViewportOrigins: [ALLOWED] });
    try {
      await opened(dial(r, "/daemon", PAIR)); // daemon bypasses the origin gate
      await opened(dial(r, "/ws", PAIR, { origin: ALLOWED })); // right origin admitted
      assert.equal(
        await closeCode(dial(r, "/ws", PAIR, { origin: "https://evil.example" })),
        CLOSE_FORBIDDEN_ORIGIN,
      ); // wrong origin refused
      assert.equal(await closeCode(dial(r, "/ws", PAIR)), CLOSE_FORBIDDEN_ORIGIN); // no Origin refused
    } finally {
      await r.close();
    }
  }
});

test("entitlement gate (daemons): unset admits any; configured requires a valid, unexpired token", async () => {
  // Mint a compact "<b64url(payload)>.<b64url(sig)>" token the way the R.5
  // billing backend will — Ed25519 over the payload segment.
  const mint = (priv: KeyObject, expSeconds: number): string => {
    const seg = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
    const sig = signMessage(null, Buffer.from(seg), priv).toString("base64url");
    return `${seg}.${sig}`;
  };
  const ent = (token: string) => ({ [ENTITLEMENT_HEADER]: token });
  const soon = Math.floor(Date.now() / 1000) + 3600;
  const past = Math.floor(Date.now() / 1000) - 10;

  // Unset (default): no entitlement check — a daemon dials in freely, with or
  // without any token. This is today's pre-billing behavior, preserved.
  {
    const r = await relay();
    try {
      await opened(dial(r, "/daemon", PAIR));
    } finally {
      await r.close();
    }
  }
  // Configured: the relay holds the PUBLIC half; only a token signed by the
  // matching private key and not yet expired opens a pairing.
  {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const { privateKey: otherKey } = generateKeyPairSync("ed25519"); // a different signer
    const r = await relay({ entitlementPublicKey: pubB64 });
    try {
      // A valid, unexpired token is admitted — and its viewport still works
      // (viewports carry no token; the daemon's entitlement covers the pairing).
      const daemon = await opened(dial(r, "/daemon", PAIR, ent(mint(privateKey, soon))));
      const openMsg = nextMessage(daemon);
      const viewport = await opened(dial(r, "/ws", PAIR));
      assert.equal((JSON.parse(await openMsg) as RelayToDaemon).t, "open");
      viewport.close();

      // No token, an expired token, a garbage token, and a token signed by the
      // wrong key are each refused with the same clean close.
      assert.equal(await closeCode(dial(r, "/daemon", "no-token-pair-id-22-c")), CLOSE_UNENTITLED);
      assert.equal(
        await closeCode(dial(r, "/daemon", "expired-pair-id-22-ch", ent(mint(privateKey, past)))),
        CLOSE_UNENTITLED,
      );
      assert.equal(
        await closeCode(dial(r, "/daemon", "garbage-pair-id-22-ch", ent("not.a.valid.token"))),
        CLOSE_UNENTITLED,
      );
      assert.equal(
        await closeCode(dial(r, "/daemon", "wrongkey-pair-id-22-c", ent(mint(otherKey, soon)))),
        CLOSE_UNENTITLED,
      );
    } finally {
      await r.close();
    }
  }
  // Max-TTL backstop (audit B2): a correctly SIGNED token whose `exp` lies
  // implausibly far out — the minter issues 48h tokens — is refused too; a
  // compromised or buggy minter must not be able to grant effectively
  // permanent access. 0 disables the ceiling.
  {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const farOut = Math.floor(Date.now() / 1000) + 30 * 86_400; // 30 days
    const underCap = Math.floor(Date.now() / 1000) + 6 * 86_400; // inside the 7d default
    const r = await relay({ entitlementPublicKey: pubB64 }); // default cap: 7 days
    try {
      assert.equal(
        await closeCode(dial(r, "/daemon", "overcap-pair-id-22-c", ent(mint(privateKey, farOut)))),
        CLOSE_UNENTITLED,
      );
      await opened(dial(r, "/daemon", PAIR, ent(mint(privateKey, underCap))));
    } finally {
      await r.close();
    }
    const rOff = await relay({ entitlementPublicKey: pubB64, entitlementMaxTtlSeconds: 0 });
    try {
      await opened(dial(rOff, "/daemon", PAIR, ent(mint(privateKey, farOut))));
      // Even with the ceiling off, a correctly signed token whose `exp` decodes
      // to Infinity (JSON `1e999`) is refused — Number.isFinite closes the
      // never-expiring case the mint helper can't even express (JSON.stringify
      // turns Infinity into null).
      const infSeg = Buffer.from('{"exp":1e999}').toString("base64url");
      const infSig = signMessage(null, Buffer.from(infSeg), privateKey).toString("base64url");
      assert.equal(
        await closeCode(dial(rOff, "/daemon", "infinity-pair-id-22-c", ent(`${infSeg}.${infSig}`))),
        CLOSE_UNENTITLED,
      );
    } finally {
      await rOff.close();
    }
  }
});

test("drops a connection that floods past the frame-rate budget", async () => {
  const r = await relay({ rateMaxFrames: 5, rateWindowMs: 60_000 });
  try {
    const { viewport } = await paired(r);
    const dropped = closeCode(viewport);
    for (let i = 0; i < 10; i++) viewport.send(`flood-${i}`);
    assert.equal(await dropped, CLOSE_RATE_LIMITED);
  } finally {
    await r.close();
  }
});

test("a flood past the rate cap logs rate_limited ONCE, not once per excess frame", async () => {
  // Closing is a handshake, not a cut: frames the flooder already sent keep
  // arriving until the close completes, and each used to re-enter withinRate
  // and re-log — a 50-frame flood past a cap of 3 emitted 47 rate_limited
  // lines (2026-07-29 bughunt), turning attacker frames into log volume 1:1.
  // The capClosed latch pins this to exactly one event per closed socket.
  const events: RelayEvent[] = [];
  const r = await relay({ rateMaxFrames: 3, rateWindowMs: 60_000, log: (e) => events.push(e) });
  try {
    const { viewport } = await paired(r);
    const dropped = closeCode(viewport);
    for (let i = 0; i < 50; i++) viewport.send(`flood-${i}`);
    assert.equal(await dropped, CLOSE_RATE_LIMITED);
    await new Promise((res) => setTimeout(res, 100)); // let the queued tail land
    assert.equal(
      events.filter((e) => e.event === "rate_limited").length,
      1,
      "one flood, one event",
    );
  } finally {
    await r.close();
  }
});

test("drops a connection that floods past the BYTE budget, frames within count", async () => {
  // 2026-07-27 audit: the frame cap alone left rateMaxFrames × maxPayloadBytes
  // legal per window. Few frames, big frames — the byte budget must fire.
  const r = await relay({ rateMaxFrames: 1_000, rateMaxBytes: 10_000, rateWindowMs: 60_000 });
  try {
    const { daemon, viewport } = await paired(r);
    // A small frame passes and forwards…
    const arrived = nextMessage(daemon);
    viewport.send("small");
    assert.equal((JSON.parse(await arrived) as { p: string }).p, "small");
    // …then one oversize-for-the-window frame trips the byte budget.
    const dropped = closeCode(viewport);
    viewport.send("x".repeat(20_000));
    assert.equal(await dropped, CLOSE_RATE_LIMITED);
    assert.equal(daemon.readyState, WebSocket.OPEN, "only the flooder pays");
  } finally {
    await r.close();
  }
});

test("backpressure: a stalled viewport is closed CLOSE_OVERLOADED; the daemon survives", async () => {
  // 2026-07-27 audit: without a bufferedAmount bound a slow receiver queues
  // forwarded frames in relay memory without bound. Stall the viewport by
  // pausing its TCP socket so the relay's sends stop draining, then pump
  // from the daemon until the relay's buffer for it crosses the (tiny) limit.
  const r = await relay({ maxBufferedBytes: 50_000, rateMaxBytes: 0, rateMaxFrames: 100_000 });
  try {
    const { daemon, viewport, v } = await paired(r);
    // Pause the client-side socket: the OS window fills, then the relay-side
    // ws buffer (bufferedAmount) grows with every forward. The pump is
    // bounded but must comfortably exceed anything the kernel can absorb;
    // once the limit trips, the relay's readyState guard skips the rest, so
    // relay memory never holds more than the limit plus one frame.
    const sock = (viewport as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    sock.pause();
    const dropped = closeCode(viewport);
    const chunk = "z".repeat(512 * 1024);
    for (let i = 0; i < 400; i++) {
      daemon.send(JSON.stringify({ t: "frame", v, p: chunk }));
      // Yield so the relay processes each envelope before the next arrives.
      await new Promise((res) => setImmediate(res));
    }
    // A paused socket can't read the server's close frame — resume so the
    // client drains what buffered and then sees the close.
    sock.resume();
    assert.equal(await dropped, CLOSE_OVERLOADED, "stalled receiver is refused, not buffered");
    assert.equal(daemon.readyState, WebSocket.OPEN, "the healthy side stays up");
  } finally {
    await r.close();
  }
});

test("backpressure: a stalled DAEMON is closed too, and its orphaned viewport cascades", async () => {
  // The mirror of the test above — the daemon is the receiver this time. Its
  // close also proves the cascade: a pair whose daemon is dropped closes its
  // viewports with CLOSE_BAD_CODE (they re-dial), exactly as if the daemon
  // had left on its own.
  const events: RelayEvent[] = [];
  const r = await relay({
    maxBufferedBytes: 50_000,
    rateMaxBytes: 0,
    rateMaxFrames: 100_000,
    log: (e) => events.push(e),
  });
  try {
    const { daemon, viewport } = await paired(r);
    const dsock = (daemon as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    dsock.pause();
    const daemonDropped = closeCode(daemon);
    const cascade = closeCode(viewport);
    const chunk = "z".repeat(512 * 1024);
    for (let i = 0; i < 400; i++) {
      viewport.send(chunk);
      await new Promise((res) => setImmediate(res));
    }
    dsock.resume();
    assert.equal(await daemonDropped, CLOSE_OVERLOADED, "stalled daemon is refused");
    assert.equal(await cascade, CLOSE_BAD_CODE, "its viewport is cascade-closed");
    const bp = events.filter((e) => e.event === "backpressure_closed") as Extract<
      RelayEvent,
      { event: "backpressure_closed" }
    >[];
    assert.equal(bp[0]?.role, "daemon", "the event names the stalled role");
    // The sender kept pumping while the daemon's close handshake ran; the
    // capClosed latch must keep that tail to one event (2026-07-29 bughunt —
    // it used to log once per frame that arrived after the close began).
    assert.equal(bp.length, 1, "one stalled receiver, one event");
  } finally {
    await r.close();
  }
});

test("handshake timeouts bound the handshake only — a live WebSocket is never cut by them", async () => {
  // The pre-handshake floor must not sever an established, idle session (a
  // phone waiting between turns). Set both timeouts absurdly short, then idle a
  // paired connection well past them and prove it still forwards. If Node ever
  // stopped clearing these timers on upgrade, this test catches it.
  const r = await relay({ headersTimeoutMs: 200, requestTimeoutMs: 300 });
  try {
    const { daemon, viewport, v } = await paired(r);
    await new Promise((res) => setTimeout(res, 700)); // idle past both timeouts
    const arrived = nextMessage(viewport);
    daemon.send(JSON.stringify({ t: "frame", v, p: "still-forwarding" }));
    assert.equal(await arrived, "still-forwarding");
    assert.equal(daemon.readyState, WebSocket.OPEN);
  } finally {
    await r.close();
  }
});

test("heartbeat reaper: a socket that stops answering pings is terminated; live ones survive", async () => {
  // Conforming clients pong automatically at the protocol level, so a paired
  // session must ride out several intervals untouched. Then the viewport goes
  // silent — its TCP socket paused, so it can never pong again — and the
  // reaper terminates it: one interval marks it dead, the next reaps it. The
  // daemon hears the viewport-close cascade, which is how we observe the reap.
  const r = await relay({ heartbeatMs: 100 });
  try {
    const { daemon, viewport, v } = await paired(r);
    await new Promise((res) => setTimeout(res, 350)); // several ping rounds
    const arrived = nextMessage(viewport);
    daemon.send(JSON.stringify({ t: "frame", v, p: "alive-across-pings" }));
    assert.equal(await arrived, "alive-across-pings");

    const reaped = nextMessage(daemon);
    (viewport as unknown as { _socket: { pause(): void } })._socket.pause();
    assert.deepEqual(JSON.parse(await reaped), { t: "close", v }, "zombie viewport reaped");
    assert.equal(daemon.readyState, WebSocket.OPEN, "the answering daemon is never reaped");
  } finally {
    await r.close();
  }
});

/** A raw TCP connection to the relay — no HTTP, no WebSocket — resolved once
 * it is established. For the pre-handshake-floor tests below. */
function rawConnect(port: number): Promise<net.Socket> {
  return new Promise((res, rej) => {
    const sock = net.connect(port, "127.0.0.1");
    sock.once("connect", () => res(sock));
    sock.once("error", rej);
  });
}

// Resolves true once the socket closes/errors (server dropped it), false on
// timeout. Always destroys the socket, so it can never linger and hang close().
// resume() drains any server response (e.g. the 408 before a graceful FIN): a
// paused socket buffers that data and never emits "close", which would look
// like the server failed to reap it.
function droppedWithin(sock: net.Socket, ms: number): Promise<boolean> {
  return new Promise<boolean>((res) => {
    sock.resume();
    const t = setTimeout(() => res(false), ms);
    const done = (v: boolean) => {
      clearTimeout(t);
      sock.destroy();
      res(v);
    };
    sock.once("close", () => done(true));
    sock.once("error", () => done(true));
  });
}

test("a slowloris that never completes its headers is dropped (pre-handshake floor)", async () => {
  // Short headers timeout + a tight check interval so the sweep reaps it fast.
  const r = await relay({ headersTimeoutMs: 100, connectionCheckMs: 30 });
  try {
    const sock = await rawConnect(r.port);
    // A partial request the server can never finish parsing — the header block
    // is deliberately left unterminated (no closing blank line). Without the
    // headers timeout this half-open socket would park a slot indefinitely.
    sock.write("GET /health HTTP/1.1\r\nHost: relay\r\n");
    assert.ok(await droppedWithin(sock, 2000), "server closed the stalled handshake");
  } finally {
    await r.close();
  }
});

test("caps raw TCP sockets past maxSockets (the self-host connection floor)", async () => {
  const r = await relay({ maxSockets: 1 });
  let first: net.Socket | undefined;
  try {
    first = await rawConnect(r.port);
    // With one raw socket already held and maxSockets = 1, the server accepts
    // then immediately drops the next one — enforced at accept, no timeout wait.
    const second = net.connect(r.port, "127.0.0.1");
    assert.ok(await droppedWithin(second, 2000), "second raw socket refused past maxSockets");
  } finally {
    first?.destroy();
    await r.close();
  }
});

test("an upgrade on an unknown path is destroyed outright", async () => {
  // The upgrade handler only knows /daemon and /ws; anything else is dropped
  // pre-handshake (socket.destroy), the same fate as an unparseable target.
  const r = await relay();
  try {
    const sock = await rawConnect(r.port);
    sock.write(
      `GET /nope?pair=${PAIR} HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`,
    );
    assert.ok(await droppedWithin(sock, 2000), "unknown-path upgrade dropped");
  } finally {
    await r.close();
  }
});

test("a daemon leaving closes its viewports; a viewport leaving notifies the daemon", async () => {
  const r = await relay();
  try {
    // Viewport leaves → daemon hears {t:"close",v}.
    const { daemon, viewport, v } = await paired(r);
    const closed = nextMessage(daemon);
    viewport.close();
    assert.deepEqual(JSON.parse(await closed), { t: "close", v });

    // Daemon leaves → its viewport is closed and the pair id frees up.
    const viewport2 = await opened(dial(r, "/ws", PAIR));
    const cascade = closeCode(viewport2);
    daemon.close();
    assert.equal(await cascade, CLOSE_BAD_CODE);
    await opened(dial(r, "/daemon", PAIR)); // id reusable — not a taken-id refusal
  } finally {
    await r.close();
  }
});

test("malformed daemon frames — bad envelopes and non-string payloads — are dropped, never fatal", async () => {
  const r = await relay();
  try {
    const { daemon, viewport, v } = await paired(r);

    // Two once-fatal crash classes, both an uncaught throw in the daemon
    // handler that killed the process (dropping every live pairing):
    //  - a non-envelope that still parses: "null" → reading `.t` off null threw.
    //  - a well-formed frame whose `p` is not the string the contract requires:
    //    ws.send(<object|bool|null>) threw. These carry the REAL viewport id so
    //    they reach the forwarding send — the exact line that once crashed.
    const junk = [
      "null",
      "42",
      '"str"',
      "[]",
      "not json at all",
      JSON.stringify({ t: "frame", v, p: { nested: 1 } }),
      JSON.stringify({ t: "frame", v, p: true }),
      JSON.stringify({ t: "frame", v, p: null }),
    ];
    for (const j of junk) daemon.send(j);

    // Same-socket ordering means all the junk was processed before this real
    // frame — so its arrival proves every junk frame was survived, not fatal.
    const arrived = nextMessage(viewport);
    daemon.send(JSON.stringify({ t: "frame", v, p: "still-alive" }));
    assert.equal(await arrived, "still-alive");
    assert.equal(daemon.readyState, WebSocket.OPEN);
  } finally {
    await r.close();
  }
});

// A seeded PRNG (mulberry32) so the fuzz below is random-looking but the SAME
// every run: a failure is reproducible from the seed alone, and CI can never
// go red for a case that vanishes on re-run. Hand-rolled on purpose — a
// property-testing dependency would be a whole transitive tree for twelve
// lines we can own safely.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

test("fuzz: seeded random malformed envelopes never kill the relay (200 cases)", async () => {
  // The daemon envelope is one of only two attacker-controlled parse surfaces,
  // and BOTH of this relay's process-killing crashes lived here (a non-object
  // that still parses; a `p` that isn't a string). Those exact classes are
  // pinned by name above; this throws structured garbage at the same handler
  // to catch the next variant before an audit has to. Rate caps are lifted so
  // the flood itself isn't what ends the socket.
  const rand = rng(0x5eed_1);
  const r = await relay({ rateMaxFrames: 1_000_000, rateMaxBytes: 0 });
  try {
    const { daemon, v } = await paired(r);
    const types = ["frame", "close", "pong", "open", "ping", "", "FRAME", 0, null, undefined, {}];
    const payloads = [
      "ok",
      "",
      0,
      -1,
      1e999,
      true,
      false,
      null,
      undefined,
      {},
      { nested: { deep: 1 } },
      [],
      ["a"],
      " ￿",
      "🙈".repeat(4),
    ];
    const viewportIds = [v, "", "no-such-v", "../..", 0, null, undefined, {}, [v]];

    for (let i = 0; i < 200; i++) {
      // Half well-formed-ish envelopes with fuzzed fields, half raw junk text —
      // the JSON.parse guard and the field guards each need their own pressure.
      if (rand() < 0.5) {
        const env: Record<string, unknown> = {
          t: pick(rand, types),
          v: pick(rand, viewportIds),
          p: pick(rand, payloads),
        };
        if (rand() < 0.2) delete env[pick(rand, ["t", "v", "p"] as const)];
        if (rand() < 0.15) env[`x${i}`] = pick(rand, payloads); // unknown extra field
        daemon.send(JSON.stringify(env));
      } else {
        const junk = [
          "",
          "{",
          "}",
          "[",
          "null",
          "true",
          "0",
          '"str"',
          "{'t':1}",
          "{}{}",
          " ",
          "NaN",
          "Infinity",
          '{"t":"frame","v":"' + v + '","p":',
          "not json at all",
        ];
        daemon.send(pick(rand, junk));
      }
    }

    // The original viewport may be gone — a fuzzed {t:"close", v} is legal
    // routing, not a crash — so survival is proved with a FRESH viewport.
    // Same-socket ordering still holds: the daemon socket processes all 200
    // cases before the frame below, so its arrival proves none was fatal.
    const announced = nextEnvelope(daemon, "open");
    const viewport2 = await opened(dial(r, "/ws", PAIR));
    const { v: v2 } = await announced;
    const arrived = nextMessage(viewport2);
    daemon.send(JSON.stringify({ t: "frame", v: v2, p: "survived-the-fuzz" }));
    assert.equal(await arrived, "survived-the-fuzz");
    assert.equal(daemon.readyState, WebSocket.OPEN, "the daemon socket is still open");
    // And the relay is healthy for everyone else, not just this pairing.
    assert.equal((await fetch(`http://127.0.0.1:${r.port}/health`)).status, 200);
  } finally {
    await r.close();
  }
});

test("fuzz: seeded random upgrade targets never kill the relay (60 cases)", async () => {
  // The second parse surface: `new URL(req.url, …)` in the upgrade handler,
  // where `//[` once threw ERR_INVALID_URL and exited the process. Characters
  // are drawn from a set Node's HTTP parser passes THROUGH (no space, no
  // control bytes — those are rejected before our handler, proving nothing).
  // Each socket is expected to be dropped; what's under test is that the
  // relay is still routing afterward.
  const rand = rng(0x5eed_2);
  const events: RelayEvent[] = [];
  const r = await relay({ log: (e) => events.push(e) });
  try {
    const daemon = await opened(dial(r, "/daemon", PAIR)); // must survive it all
    const chars = "/[]%:@?#&=.-_~+abZ019{}|\\^`<>\"'()*,;$!".split("");
    for (let i = 0; i < 60; i++) {
      let target = "/";
      const len = 1 + Math.floor(rand() * 12);
      for (let c = 0; c < len; c++) target += pick(rand, chars);
      const sock = await rawConnect(r.port);
      sock.write(
        `GET ${target} HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`,
      );
      assert.ok(await droppedWithin(sock, 2000), `target dropped: ${target}`);
    }

    // No crash event, the existing pairing is intact, and new sockets still pair.
    assert.equal(events.filter((e) => e.event === "crash").length, 0);
    assert.equal(daemon.readyState, WebSocket.OPEN, "existing pairing survived");
    const viewport = await opened(dial(r, "/ws", PAIR));
    assert.equal(viewport.readyState, WebSocket.OPEN, "relay still accepts new sockets");
  } finally {
    await r.close();
  }
});

test("oversize frames kill the sender, not the relay", async () => {
  const r = await relay({ maxPayloadBytes: 1024 });
  try {
    const { daemon, viewport } = await paired(r);
    const dropped = closeCode(viewport);
    viewport.send("z".repeat(4096));
    assert.equal(await dropped, 1009); // ws standard "message too big"

    // The relay is still healthy for everyone else.
    assert.equal((await fetch(`http://127.0.0.1:${r.port}/health`)).status, 200);
    assert.equal(daemon.readyState, WebSocket.OPEN);
  } finally {
    await r.close();
  }
});

test('an empty-string env override means "unset", never 0', async () => {
  // Number("") === 0, so without the guard in limits.ts a set-but-empty var
  // (a blank .env line, CI interpolating an unset value) configured a relay
  // that refused every socket while still answering /health. Pin both edges:
  // empty/whitespace falls back to the default; an explicit "0" is honored.
  // LIMITS is computed at import time from process.env, hence subprocesses.
  const readLimits = async (env: Record<string, string>): Promise<Limits> => {
    const limitsUrl = new URL("../src/limits.ts", import.meta.url).href;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "--eval",
        `import(${JSON.stringify(limitsUrl)}).then((m) => console.log(JSON.stringify(m.LIMITS)))`,
      ],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), env },
    );
    return JSON.parse(stdout) as Limits;
  };
  const [unset, empty] = await Promise.all([
    readLimits({ RELAY_MAX_PAIRS: "0" }),
    readLimits({ RELAY_MAX_PAIRS: "0", RELAY_MAX_CONNECTIONS: "", RELAY_HEARTBEAT_MS: "   " }),
  ]);
  assert.equal(empty.maxConnections, unset.maxConnections); // "" ≡ unset
  assert.equal(empty.heartbeatMs, unset.heartbeatMs); // whitespace ≡ unset
  assert.equal(unset.maxPairs, 0); // explicit "0" still means 0…
  assert.equal(empty.maxPairs, 0); // …in both runs
});

test('a set-but-empty PORT means "unset" for the entrypoint too — 8080, never port 0', async () => {
  // main.ts used Number(process.env.PORT ?? 8080), so PORT="" (a platform-
  // config accident) became 0 — an ephemeral port the health check could
  // never find. envNum gives PORT the same empty-means-unset rule as every
  // RELAY_* knob. Spawn the real entrypoint and read its listening event.
  // If this machine already holds 8080 the bind fails EADDRINUSE — which
  // still proves the fallback (port 0 can never collide), so both outcomes
  // pin the fix.
  const proc = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, PORT: "", HOST: "127.0.0.1" },
  });
  try {
    const outcome = await new Promise<{ port?: number; crash?: string }>((resolve, reject) => {
      let out = "";
      let errOut = "";
      const scan = (chunk: Buffer) => {
        out += String(chunk);
        for (const line of out.split("\n")) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line) as { event: string; port?: number; message?: string };
            if (e.event === "listening") return resolve({ port: e.port });
            if (e.event === "crash") return resolve({ crash: e.message });
          } catch {
            /* partial line — keep buffering */
          }
        }
      };
      proc.stdout.on("data", scan);
      proc.stderr.on("data", (c: Buffer) => (errOut += String(c)));
      proc.on("error", reject);
      // A child that dies without either event (it must not — the crash
      // handlers register before the bind) fails loudly instead of hanging
      // the suite until the event loop drains and cancels everything after.
      proc.on("exit", () =>
        reject(new Error(`exited with no listening/crash event; stderr: ${errOut}`)),
      );
      setTimeout(() => reject(new Error(`no listening/crash event; output: ${out}`)), 10_000).unref();
    });
    if (outcome.crash !== undefined) {
      assert.match(outcome.crash, /EADDRINUSE/, "only an occupied 8080 may stop the bind");
      assert.match(outcome.crash, /8080/, "the attempted port was 8080, not 0");
    } else {
      assert.equal(outcome.port, 8080);
    }
  } finally {
    proc.kill("SIGTERM");
    await new Promise((res) => proc.once("exit", res));
  }
});

test("structured log: lifecycle events carry volume metadata and never a payload, pair id, or IP", async () => {
  const events: RelayEvent[] = [];
  const r = await relay({ log: (e) => events.push(e) });
  try {
    const { daemon, viewport, v } = await paired(r);

    const payload = "SECRET-CIPHERTEXT-" + "z".repeat(200);
    const arrived = nextMessage(viewport);
    daemon.send(JSON.stringify({ t: "frame", v, p: payload }));
    await arrived;
    const up = "UPSTREAM-SECRET-" + "w".repeat(100);
    const framed = nextMessage(daemon);
    viewport.send(up);
    await framed;

    viewport.close();
    await new Promise((res) => viewport.once("close", res));
    const unpaired = new Promise((res) => daemon.once("close", res));
    daemon.close();
    await unpaired;
    // The unpair event lands on the server's own close handler — settle it.
    await new Promise((res) => setTimeout(res, 50));

    const byName = (name: string) => events.filter((e) => e.event === name);
    assert.equal(byName("listening").length, 1);
    assert.equal(byName("daemon_paired").length, 1);
    assert.equal(byName("viewport_opened").length, 1);
    assert.equal(byName("viewport_closed").length, 1);
    const un = byName("daemon_unpaired")[0] as Extract<RelayEvent, { event: "daemon_unpaired" }>;
    assert.ok(un, "daemon_unpaired must be emitted");
    assert.equal(un.frames, 2); // one frame each way
    assert.equal(un.bytes, payload.length + up.length); // volume, both directions
    assert.ok(un.durationMs >= 0);

    // The audit claim, mechanically: nothing that crosses or names the pairing
    // may appear in any event — not the payloads, not the pair id, and no
    // client address. (`listening` is exempt from the address check — its host
    // is the relay's own bind address, not a client's.)
    const dump = JSON.stringify(events);
    assert.ok(!dump.includes("SECRET"), "no payload content in events");
    assert.ok(!dump.includes(PAIR), "no pair id in events");
    const clientDump = JSON.stringify(events.filter((e) => e.event !== "listening"));
    assert.ok(!clientDump.includes("127.0.0.1"), "no client IP in events");
  } finally {
    await r.close();
  }
});

test("structured log: refusals name the reason (bad pair id, both roles)", async () => {
  const events: RelayEvent[] = [];
  const r = await relay({ log: (e) => events.push(e) });
  try {
    // A viewport with no live pairing behind its id.
    assert.equal(await closeCode(dial(r, "/ws", PAIR)), CLOSE_BAD_CODE);
    // A daemon with a too-short (guessable) id.
    assert.equal(await closeCode(dial(r, "/daemon", "short")), CLOSE_CODE_TAKEN);
    const refused = events.filter((e) => e.event === "refused") as Extract<
      RelayEvent,
      { event: "refused" }
    >[];
    assert.deepEqual(
      refused.map((e) => [e.role, e.reason]),
      [
        ["viewport", "bad_pair_id"],
        ["daemon", "bad_pair_id"],
      ],
    );
  } finally {
    await r.close();
  }
});

test("structured log: a rate-limited flood logs its budget numbers, never content", async () => {
  const events: RelayEvent[] = [];
  const r = await relay({ rateMaxFrames: 3, rateWindowMs: 60_000, log: (e) => events.push(e) });
  try {
    const { viewport } = await paired(r);
    const dropped = closeCode(viewport);
    for (let i = 0; i < 4; i++) viewport.send("SECRET-flood-x"); // 4th trips the cap of 3
    assert.equal(await dropped, CLOSE_RATE_LIMITED);
    const rl = events.filter((e) => e.event === "rate_limited") as Extract<
      RelayEvent,
      { event: "rate_limited" }
    >[];
    assert.equal(rl.length, 1);
    assert.equal(rl[0]?.frames, 4);
    assert.equal(rl[0]?.windowMs, 60_000);
    assert.ok((rl[0]?.bytes ?? 0) > 0, "byte volume, not content");
    assert.ok(!JSON.stringify(events).includes("SECRET"), "no payload in events");
  } finally {
    await r.close();
  }
});

test("a request target Node accepts but WHATWG URL rejects can't kill the relay", async () => {
  // Node's HTTP parser passes `//[` straight through to the upgrade handler,
  // where `new URL(target, "ws://relay")` throws ERR_INVALID_URL. Uncaught,
  // that reaches main.ts's uncaughtException handler and exits the process —
  // and we run single-instance, so one malformed request line from anyone on
  // the internet would drop EVERY live pairing (2026-07-27 audit, verified).
  const events: RelayEvent[] = [];
  const r = await relay({ log: (e) => events.push(e) });
  try {
    // A pairing that must SURVIVE the hostile request below.
    const daemon = await opened(dial(r, "/daemon", PAIR));

    // Each of these is accepted by the HTTP parser and rejected by `new URL`.
    // (A target with a space — `//a b` — is NOT a probe: the parser refuses it
    // before the handler ever runs, so it proves nothing about this guard.)
    const targets = ["//[", "//]", "//%", "//[::1", "//%zz"];
    for (const target of targets) {
      const sock = await rawConnect(r.port);
      sock.write(
        `GET ${target} HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
      );
      assert.ok(await droppedWithin(sock, 2000), `unparseable target dropped: ${target}`);
    }

    assert.equal(events.filter((e) => e.event === "bad_request_target").length, targets.length);
    // The relay is still up and still routing: the pairing above is intact and
    // a fresh viewport can still reach it.
    assert.equal(daemon.readyState, WebSocket.OPEN, "existing pairing survived");
    const viewport = await opened(dial(r, "/ws", PAIR));
    assert.equal(viewport.readyState, WebSocket.OPEN, "relay still accepts new sockets");
    viewport.close();
    daemon.close();
  } finally {
    await r.close();
  }
});
