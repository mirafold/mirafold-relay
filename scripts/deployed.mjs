// What is actually running, and is it behind main? — measured, never read
// off a document.
//
//   npm run deployed
//
// Prints, per environment: the Fly release version, the commit the LIVE image
// was built from, and how that commit compares to origin/main — classified by
// whether the drift touches src/ (functional, worth a deploy) or only tests,
// scripts, and docs (not worth restarting the single instance, which drops
// every live pairing).
//
// Why this exists: on 2026-07-28 the roadmap's deploy ledger had a row for v9
// and none for v10, so the live relay was described as three commits older
// than it was, and a deploy was recommended for security work that had
// shipped two hours earlier. The ledger is HISTORY; it cannot be current
// state, because a deploy changes the world without leaving a diff in any
// repo. The only authority on what is running is the running machine — this
// reads the GH_SHA label that the deploy workflow stamps onto every image.
//
// Workstation tool: needs `flyctl` authenticated, so CI can't run it. That is
// fine — the question it answers ("should I deploy?") is asked from a laptop.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const sh = async (cmd, args) => {
  const { stdout } = await run(cmd, args, { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
};

/** App name straight from the fly config, so a rename can't leave this lying. */
const appFrom = (file) => {
  const m = /^app\s*=\s*"(.+)"/m.exec(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
  if (!m) throw new Error(`no app name in ${file}`);
  return { file, app: m[1] };
};

const ENVIRONMENTS = [
  { label: "production", ...appFrom("fly.toml") },
  { label: "staging", ...appFrom("fly.staging.toml") },
];

/** The commit the live image was built from, per the deploy workflow's label. */
async function liveSha(app) {
  const images = JSON.parse(await sh("flyctl", ["image", "show", "-a", app, "--json"]));
  if (!images.length) return null;
  // Labels arrives as a JSON string nested inside the JSON — parse it again.
  const labels = JSON.parse(images[0].Labels ?? "{}");
  return labels.GH_SHA ?? null;
}

async function liveVersion(app) {
  const releases = JSON.parse(await sh("flyctl", ["releases", "-a", app, "--json"]));
  const current = releases.find((r) => r.Status === "complete") ?? releases[0];
  return current ? { version: `v${current.Version}`, at: current.CreatedAt } : null;
}

/** How the live commit compares to origin/main, and whether the gap matters. */
async function drift(sha) {
  if (!sha) return { known: false, note: "no GH_SHA label on the live image" };
  const known = await sh("git", ["cat-file", "-t", sha])
    .then((t) => t === "commit")
    .catch(() => false);
  if (!known) {
    return { known: false, note: `commit ${sha.slice(0, 7)} not in this checkout — fetch it` };
  }
  const subject = await sh("git", ["log", "-1", "--format=%s", sha]);
  const behind = await sh("git", ["rev-list", "--count", `${sha}..origin/main`]);
  const files = behind === "0" ? "" : await sh("git", ["diff", "--name-only", sha, "origin/main"]);
  const changed = files ? files.split("\n") : [];
  // src/ is the only path that reaches the running container's behavior —
  // test/, scripts/ and the docs ship nothing. That distinction is the whole
  // point: it turns "what's deployed" into "should I deploy".
  const functional = changed.filter((f) => f.startsWith("src/"));
  return { known: true, sha, subject, behind: Number(behind), changed, functional };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

console.log("measuring the running machines (not the roadmap)…\n");
await sh("git", ["fetch", "--quiet", "origin"]).catch(() => {
  console.log("  ! could not fetch origin — comparing against the local origin/main ref\n");
});

let anyFunctional = false;
let measured = 0;
for (const { label, app } of ENVIRONMENTS) {
  let sha;
  let release;
  try {
    [sha, release] = await Promise.all([liveSha(app), liveVersion(app)]);
  } catch (err) {
    // A stopped machine still reports its image, so a failure here is usually
    // auth or a wrong app name. flyctl explains itself on stderr while the
    // thrown message is only "Command failed" — surface the useful half.
    const why = (err.stderr ?? "").split("\n").find((l) => l.trim()) ?? err.message.split("\n")[0];
    console.log(`${label.padEnd(11)} ${app}: unavailable — ${why.trim()}`);
    continue;
  }
  measured++;
  const d = await drift(sha);
  const version = release ? release.version : "?";
  const when = release ? release.at.replace("T", " ").replace("Z", " UTC") : "";

  if (!d.known) {
    console.log(`${label.padEnd(11)} ${version.padEnd(5)} ${d.note}`);
    continue;
  }
  console.log(`${label.padEnd(11)} ${version.padEnd(5)} ${d.sha.slice(0, 7)}  ${d.subject}`);
  console.log(`${" ".repeat(11)} deployed ${when}`);
  if (d.behind === 0) {
    console.log(`${" ".repeat(11)} up to date with origin/main`);
  } else if (d.functional.length === 0) {
    console.log(
      `${" ".repeat(11)} ${plural(d.behind, "commit")} behind origin/main —` +
        ` no src/ change, so nothing functional is unshipped`,
    );
  } else {
    anyFunctional = true;
    // Deliberately "touches src/", never "changes behavior": a refactor lands
    // in src/ too, and no tool can tell one from the other. Narrowing the
    // question to a named diff is the honest service — overclaiming here
    // would repeat the very error this script exists to prevent.
    console.log(
      `${" ".repeat(11)} ${plural(d.behind, "commit")} behind origin/main —` +
        ` touches ${plural(d.functional.length, "src/ file")}: ${d.functional.join(", ")}`,
    );
    console.log(`${" ".repeat(11)} review: git diff ${d.sha.slice(0, 7)}..origin/main -- src/`);
  }
  console.log();
}

if (measured === 0) {
  console.error("could not measure any environment — is flyctl authenticated? (flyctl auth whoami)");
  process.exit(1);
}
console.log(
  anyFunctional
    ? "src/ has unshipped changes — read the diff above to judge whether they are behavioral," +
        " then DEPLOY.md (staging first, then production)"
    : "nothing outside src/ is unshipped; a deploy would only restart the instance and drop live pairings",
);
