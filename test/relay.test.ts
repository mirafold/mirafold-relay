// Standalone verification of the forwarder — no genui-shell checkout needed.
// These tests speak the routing contract directly with raw ws clients; the
// cross-repo proof that a REAL daemon drives a full turn through this service
// lives in genui-shell (server/relay-service.itest.ts, Tier 2) and stays the
// deeper check. Here we pin what the relay itself promises: routing, refusal
// codes, and every DoS cap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startRelay, type Relay, type RelayOptions } from "../src/relay.js";
import {
  CLOSE_BAD_CODE,
  CLOSE_CODE_TAKEN,
  CLOSE_OVERLOADED,
  CLOSE_RATE_LIMITED,
  type RelayToDaemon,
} from "../src/contract.js";

const PAIR = "a-real-pair-id-22-chars";

async function relay(opts: RelayOptions = {}): Promise<Relay> {
  return startRelay({ host: "127.0.0.1", heartbeatMs: 0, log: () => {}, ...opts });
}

function dial(r: Relay, path: string, pair: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${r.port}${path}?pair=${pair}`);
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

test("health answers ok; every other HTTP path is 404 (serves no bundle)", async () => {
  const r = await relay();
  try {
    const base = `http://127.0.0.1:${r.port}`;
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok");
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

test("drops a connection that floods past the frame-rate budget", async () => {
  const r = await relay({ rateMaxFrames: 5, rateWindowMs: 60_000 });
  try {
    await opened(dial(r, "/daemon", PAIR));
    const viewport = await opened(dial(r, "/ws", PAIR));
    const dropped = closeCode(viewport);
    for (let i = 0; i < 10; i++) viewport.send(`flood-${i}`);
    assert.equal(await dropped, CLOSE_RATE_LIMITED);
  } finally {
    await r.close();
  }
});

test("a daemon leaving closes its viewports; a viewport leaving notifies the daemon", async () => {
  const r = await relay();
  try {
    // Viewport leaves → daemon hears {t:"close",v}.
    const daemon = await opened(dial(r, "/daemon", PAIR));
    const openMsg = nextMessage(daemon);
    const viewport = await opened(dial(r, "/ws", PAIR));
    const { v } = JSON.parse(await openMsg) as { v: string };
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

test("oversize frames kill the sender, not the relay", async () => {
  const r = await relay({ maxPayloadBytes: 1024 });
  try {
    const daemon = await opened(dial(r, "/daemon", PAIR));
    const openMsg = nextMessage(daemon);
    const viewport = await opened(dial(r, "/ws", PAIR));
    await openMsg;
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
