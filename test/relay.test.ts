// Standalone verification of the forwarder — no genui-shell checkout needed.
// These tests speak the routing contract directly with raw ws clients; the
// cross-repo proof that a REAL daemon drives a full turn through this service
// lives in genui-shell (server/relay/relay-service.itest.ts, Tier 2) and stays the
// deeper check. Here we pin what the relay itself promises: routing, refusal
// codes, and every DoS cap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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

const PAIR = "a-real-pair-id-22-chars";

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
    const sock = net.connect(r.port, "127.0.0.1");
    await new Promise<void>((res, rej) => {
      sock.once("connect", () => res());
      sock.once("error", rej);
    });
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
  const first = net.connect(r.port, "127.0.0.1");
  try {
    await new Promise<void>((res, rej) => {
      first.once("connect", () => res());
      first.once("error", rej);
    });
    // With one raw socket already held and maxSockets = 1, the server accepts
    // then immediately drops the next one — enforced at accept, no timeout wait.
    const second = net.connect(r.port, "127.0.0.1");
    assert.ok(await droppedWithin(second, 2000), "second raw socket refused past maxSockets");
  } finally {
    first.destroy();
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
