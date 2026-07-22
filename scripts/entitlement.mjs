#!/usr/bin/env node
// Entitlement key + token ops (R.5). Zero dependencies — node:crypto only.
//
//   node scripts/entitlement.mjs generate
//     Mint a fresh Ed25519 keypair and print both halves as env values:
//     the PUBLIC half for the relay (fly secrets set RELAY_ENTITLEMENT_PUBLIC_KEY=…)
//     and the PRIVATE half for the minting backend (Cloudflare Pages secret
//     ENTITLEMENT_PRIVATE_KEY). Printed to stdout only — nothing is written to
//     disk; store both in the password manager the moment they scroll by.
//
//   ENTITLEMENT_PRIVATE_KEY=… node scripts/entitlement.mjs mint --ttl 48h
//     Mint one compact entitlement token ("<b64url({exp})>.<b64url(sig)>") —
//     the hand-issued path for comped beta testers (they set it as
//     MIRAFOLD_ENTITLEMENT_TOKEN) and for ops smoke tests. The private key is
//     read from the environment, never argv, so it can't land in shell history.
//     TTL forms: 90m, 48h, 7d, or bare seconds. Default 48h.
//
//   … mint --ttl 48h | RELAY_ENTITLEMENT_PUBLIC_KEY=… node scripts/entitlement.mjs verify
//     Check a token the way the deployed relay does (signature + expiry) and
//     print its payload. The token arrives on STDIN (pipe it), never argv —
//     same reason mint reads the key from env: a live credential must not
//     land in shell history. Note the relay ALSO caps how far out `exp` may
//     lie (RELAY_ENTITLEMENT_MAX_TTL_SECONDS, default 7d) — a hand-minted
//     token with a longer TTL will verify here but be refused there.

import { readFileSync } from "node:fs";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signMessage,
  verify as verifySignature,
} from "node:crypto";

const [, , cmd, ...rest] = process.argv;

const fail = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};

const parseTtlSeconds = (raw) => {
  const m = /^(\d+)([smhd]?)$/.exec(raw ?? "");
  if (!m) fail(`bad --ttl "${raw}" — use e.g. 90m, 48h, 7d, or bare seconds`);
  const mult = { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
  return Number(m[1]) * mult;
};

if (cmd === "generate") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const priv = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  console.log(`# Relay (verify side) — fly secrets set, on the relay app:`);
  console.log(`RELAY_ENTITLEMENT_PUBLIC_KEY=${pub}`);
  console.log(``);
  console.log(`# Minting backend (sign side) — Cloudflare Pages secret. KEEP PRIVATE:`);
  console.log(`ENTITLEMENT_PRIVATE_KEY=${priv}`);
} else if (cmd === "mint") {
  const b64 = process.env.ENTITLEMENT_PRIVATE_KEY;
  if (!b64) fail("set ENTITLEMENT_PRIVATE_KEY in the environment (base64 PKCS8 DER)");
  const ttlIdx = rest.indexOf("--ttl");
  const ttl = parseTtlSeconds(ttlIdx >= 0 ? rest[ttlIdx + 1] : "48h");
  const key = createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const seg = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  const sig = signMessage(null, Buffer.from(seg), key).toString("base64url");
  console.log(`${seg}.${sig}`);
  console.error(`# expires ${new Date(exp * 1000).toISOString()} (ttl ${ttl}s)`);
} else if (cmd === "verify") {
  const b64 = process.env.RELAY_ENTITLEMENT_PUBLIC_KEY;
  if (!b64) fail("set RELAY_ENTITLEMENT_PUBLIC_KEY in the environment (base64 SPKI DER)");
  if (rest[0]) fail("tokens are credentials — pipe on stdin (… mint | … verify), never argv");
  const token = readFileSync(0, "utf8").trim();
  if (!token) fail("pipe the token on stdin, e.g.:  … mint --ttl 48h | … verify");
  const key = createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) fail("malformed token (no '.' separator)");
  const seg = token.slice(0, dot);
  const ok = verifySignature(null, Buffer.from(seg), key, Buffer.from(token.slice(dot + 1), "base64url"));
  if (!ok) fail("signature INVALID for this public key");
  const payload = JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
  const live = typeof payload.exp === "number" && payload.exp * 1000 > Date.now();
  console.log(JSON.stringify(payload));
  console.log(live ? `valid — expires ${new Date(payload.exp * 1000).toISOString()}` : "signature ok but EXPIRED");
  if (!live) process.exit(1);
} else {
  fail("usage: entitlement.mjs generate | mint [--ttl 48h] | verify <token>");
}
