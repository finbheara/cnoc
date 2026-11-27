/**
 * Version resolution and the client's update procedure, against real git repositories in temp
 * directories. The end-to-end path (a server restarting on a new commit) is in e2e.test.ts.
 */
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { specTempDir } from "../scripts/testkit";
import {
  LEGACY_UPDATE,
  UPDATE_RESTART_LIMIT,
  UPDATE_RESTART_WINDOW_MS,
  UPDATE_RETRY_BASE_MS,
  UPDATE_RETRY_MAX_MS,
  UpdateError,
  Updater,
  retryDelayMs,
  updateCheckout,
} from "../src/client/update";
import { VERSION } from "../src/protocol";
import { INVALID_VERSION, checkoutOf, shortVersion, versionOf, versionProblem } from "../src/version";
import { commit, git, makeRepos } from "./git-fixture";

const bun = process.execPath;
const fresh = (n = 3) => makeRepos(specTempDir("cnoc-update-"), n);
const head = (dir: string) => git(dir, "rev-parse", "HEAD");

/** An Updater with a clock the test moves. */
function updater(
  checkout: string,
  stateDir: string,
  clock: { t: number },
  over: { version?: string; command?: string } = {},
) {
  const lines: string[] = [];
  const u = new Updater({
    checkout,
    stateDir,
    version: over.version ?? "client-version",
    command: over.command,
    log: (l) => lines.push(l),
    now: () => clock.t,
  });
  return { u, lines };
}

test("a clean checkout's version is its commit", () => {
  const { clone, commits } = fresh(1);
  expect(versionOf(clone)).toBe(commits[0] as string);
  expect(checkoutOf(clone)).toEqual({ commit: commits[0] as string, dirty: false });
});

test("an edit to a tracked file marks the version dirty, an untracked file does not", () => {
  const { clone, commits } = fresh(1);
  writeFileSync(join(clone, "notes.txt"), "scratch\n");
  expect(versionOf(clone)).toBe(commits[0] as string);
  writeFileSync(join(clone, "code.txt"), "edited\n");
  expect(versionOf(clone)).toBe(`${commits[0]}-dirty`);
});

test("without a checkout of its own the version is the fallback", () => {
  const plain = specTempDir("cnoc-plain-");
  expect(versionOf(plain)).toBe(VERSION);
  // A directory inside some other repository is not a checkout of cnoc.
  const { clone } = fresh(1);
  const sub = join(clone, "vendor");
  mkdirSync(sub);
  expect(versionOf(sub)).toBe(VERSION);
});

test("a version is shortened for people only when it is a commit", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  expect(shortVersion(sha)).toBe("0123456");
  expect(shortVersion(`${sha}-dirty`)).toBe("0123456-dirty");
  expect(shortVersion("0.1.0")).toBe("0.1.0");
  // Text from a server is never printed raw.
  expect(shortVersion("\u001b[2Jx-dirty\nforged")).toBe('" [2Jx-dirty forged"');
  expect(shortVersion(null)).toBe("-");
  // What the server records for a version it rejected is shown as it is, not quoted as if a host sent it.
  expect(shortVersion(INVALID_VERSION)).toBe("(invalid)");
});

test("an update goes to exactly the server's commit, not to the tip of main", async () => {
  const { clone, commits } = fresh(3);
  const [, target, tip] = commits as [string, string, string];
  expect(git(join(clone, "..", "origin"), "rev-parse", "main")).toBe(tip);
  expect(await updateCheckout(clone, target, bun)).toBe(true);
  expect(head(clone)).toBe(target);
  expect(versionOf(clone)).toBe(target);
  // Already there: dependencies are installed again but nothing moves.
  expect(await updateCheckout(clone, target, bun)).toBe(false);
});

test("a commit that was never pushed is refused with a reason", async () => {
  const { origin, clone } = fresh(1);
  const elsewhere = join(origin, "..", "dev");
  git(join(origin, ".."), "clone", "-q", origin, elsewhere);
  const unpushed = commit(elsewhere, "code.txt", "local only\n");
  await expect(updateCheckout(clone, unpushed, bun)).rejects.toThrow(/is not on origin; was it pushed\?/);
  expect(head(clone)).not.toBe(unpushed);
});

test("an unreachable origin is reported as a failed fetch", async () => {
  const { origin, clone } = fresh(1);
  // Pushed after the host cloned, so only a fetch could bring it.
  const later = commit(origin, "code.txt", "later\n");
  renameSync(origin, `${origin}-gone`);
  await expect(updateCheckout(clone, later, bun)).rejects.toThrow(/git fetch from origin failed: .+/);
});

test("a version that is not a commit is never handed to git", async () => {
  const { clone, commits } = fresh(1);
  await expect(updateCheckout(clone, `${commits[0]}-dirty`, bun)).rejects.toThrow(/uncommitted changes/);
  await expect(updateCheckout(clone, "0.1.0", bun)).rejects.toThrow(/not a git commit/);
  await expect(updateCheckout(clone, "--upload-pack=touch pwned", bun)).rejects.toBeInstanceOf(UpdateError);
  await expect(updateCheckout(clone, "main", bun)).rejects.toThrow(/not a git commit/);
  await expect(updateCheckout(clone, "a".repeat(64), bun)).rejects.toThrow(
    /SHA-256 name but .* uses SHA-1; it is not a clone/,
  );
});

test("local changes in the client's checkout are not overwritten", async () => {
  const { clone, commits } = fresh(2);
  writeFileSync(join(clone, "code.txt"), "work in progress\n");
  await expect(updateCheckout(clone, commits[1] as string, bun)).rejects.toThrow(
    /has uncommitted changes; not checking out over them\. .* discard them with: git -C '.+' reset -q --hard, or re-run install\.sh$/,
  );
  expect(readFileSync(join(clone, "code.txt"), "utf8")).toBe("work in progress\n");
});

test("the wait between tries doubles and is capped", () => {
  expect(retryDelayMs(1)).toBe(UPDATE_RETRY_BASE_MS);
  expect(retryDelayMs(2)).toBe(2 * UPDATE_RETRY_BASE_MS);
  expect(retryDelayMs(3)).toBe(4 * UPDATE_RETRY_BASE_MS);
  expect(retryDelayMs(50)).toBe(UPDATE_RETRY_MAX_MS);
});

test("a failing update backs off, and the backoff survives a restart", async () => {
  const { origin, clone } = fresh(1);
  const elsewhere = join(origin, "..", "dev");
  git(join(origin, ".."), "clone", "-q", origin, elsewhere);
  const unpushed = commit(elsewhere, "code.txt", "local only\n");
  const state = specTempDir("cnoc-update-state-");
  const clock = { t: 1_000_000 };

  const first = updater(clone, state, clock);
  expect(first.u.dueIn(unpushed)).toBe(0);
  expect(await first.u.attempt(unpushed)).toBe(false);
  expect(first.lines).toEqual([
    expect.stringMatching(/^update to \w{7} failed: commit \w{7} is not on origin.*next try in 1m$/),
  ]);
  expect(first.u.dueIn(unpushed)).toBe(UPDATE_RETRY_BASE_MS);
  expect(first.u.note(unpushed)).toMatch(/failed \(try 1\): commit \w{7} is not on origin/);

  // A restarted process reads the same state and does not try again early.
  const second = updater(clone, state, clock);
  expect(await second.u.attempt(unpushed)).toBe(false);
  expect(second.lines).toEqual([]);
  expect(second.u.state()?.tries).toBe(1);

  clock.t += UPDATE_RETRY_BASE_MS;
  expect(await second.u.attempt(unpushed)).toBe(false);
  expect(second.u.state()?.tries).toBe(2);
  expect(second.u.dueIn(unpushed)).toBe(2 * UPDATE_RETRY_BASE_MS);

  // A different target is a new reason to try, at once.
  expect(second.u.dueIn(head(clone))).toBe(0);

  // Agreement clears the record.
  second.u.clear();
  expect(second.u.state()).toBeNull();
});

test("an update that lands but leaves the client mismatched restarts once, then backs off", async () => {
  const { clone, commits } = fresh(2);
  const target = commits[1] as string;
  const state = specTempDir("cnoc-update-state-");
  const clock = { t: 1_000_000 };

  const before = updater(clone, state, clock);
  expect(await before.u.attempt(target)).toBe(true);
  expect(head(clone)).toBe(target);

  // The restarted process still reports another version (CNOC_VERSION left in its environment, say).
  const after = updater(clone, state, clock, { version: "still-wrong" });
  expect(await after.u.attempt(target)).toBe(false);
  expect(after.lines).toEqual([]);
  clock.t += UPDATE_RETRY_BASE_MS;
  expect(await after.u.attempt(target)).toBe(false);
  expect(after.lines).toEqual([
    expect.stringMatching(
      /failed: the code for \w{7} is in place but this client still reports still-wrong; is CNOC_VERSION set\?; next try in 2m$/,
    ),
  ]);
  clock.t += 2 * UPDATE_RETRY_BASE_MS;
  expect(await after.u.attempt(target)).toBe(false);
  expect(after.u.state()).toMatchObject({ target, tries: 3, restarted: true });
});

test("the update command an older installer wrote is ignored for the built-in one", async () => {
  const { clone, commits } = fresh(2);
  const legacy = `git -C '${clone}' pull -q --ff-only && '${bun}' install --cwd '${clone}' --frozen-lockfile --production`;
  expect(LEGACY_UPDATE.test(legacy)).toBe(true);
  // The unquoted form the example config used to show.
  const example =
    "git -C ~/.local/share/cnoc/app pull -q --ff-only && bun install --cwd ~/.local/share/cnoc/app --frozen-lockfile --production";
  expect(LEGACY_UPDATE.test(example)).toBe(true);
  // install.sh removes old commands with this very pattern, and its copy for old code is checked in install.test.ts.
  expect(readFileSync(join(import.meta.dir, "..", "install.sh"), "utf8")).toContain("require(own).LEGACY_UPDATE");
  const { u, lines } = updater(clone, specTempDir("cnoc-update-state-"), { t: 0 }, { command: legacy });
  expect(lines).toEqual([expect.stringMatching(/an older install.sh wrote it.*re-run install.sh, to silence this$/)]);
  expect(await u.attempt(commits[1] as string)).toBe(true);
  expect(head(clone)).toBe(commits[1] as string);
});

test("a configured update command gets the target in its environment, never in its text", async () => {
  const dir = specTempDir("cnoc-update-cmd-");
  const marker = join(dir, "target.txt");
  const command = `printf '%s' "$CNOC_TARGET_VERSION" > '${marker}'`;
  mkdirSync(join(dir, "state"));
  const { u } = updater(dir, join(dir, "state"), { t: 0 }, { command });
  expect(await u.attempt("1.2.3")).toBe(true);
  expect(readFileSync(marker, "utf8")).toBe("1.2.3");

  const hostile = updater(dir, join(dir, "state"), { t: 0 }, { command });
  expect(await hostile.u.attempt("$(touch pwned)")).toBe(false);
  expect(hostile.lines).toEqual([expect.stringMatching(/refusing to pass version/)]);

  const failing = updater(dir, join(dir, "state"), { t: 0 }, { command: "echo nope >&2; exit 3" });
  expect(await failing.u.attempt("1.2.4")).toBe(false);
  expect(failing.lines).toEqual([expect.stringMatching(/the configured update command failed: nope/)]);
});

/** A stand-in for bun whose install fails in a checkout whose code.txt says "bad". */
function fussyBun(): string {
  const file = join(specTempDir("cnoc-fake-bun-"), "bun");
  // Called as: bun install --cwd DIR ...
  writeFileSync(
    file,
    '#!/bin/sh\ngrep -q bad "$3/code.txt" && { echo "error: lockfile had changes, but lockfile is frozen" >&2; exit 1; }\nexit 0\n',
  );
  chmodSync(file, 0o755);
  return file;
}

test("when installing the new commit's dependencies fails, the checkout goes back", async () => {
  const { origin, clone, commits } = fresh(1);
  const before = commits[0] as string;
  git(clone, "checkout", "-q", "-B", "main", before);
  const broken = commit(origin, "code.txt", "bad\n");
  await expect(updateCheckout(clone, broken, fussyBun())).rejects.toThrow(
    /^bun install failed: error: lockfile had changes, but lockfile is frozen; went back to \w{7}$/,
  );
  // Back on the old code, on the branch it was on: a restart reports the old version and tries again.
  expect(versionOf(clone)).toBe(before);
  expect(git(clone, "symbolic-ref", "--short", "HEAD")).toBe("main");
});

/** Runs `fn` with these environment variables set, and puts back what was there. */
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("a git that refuses a checkout owned by someone else still reports its commit", () => {
  const { clone, commits } = fresh(1);
  const empty = join(specTempDir("cnoc-gitconfig-"), "gitconfig");
  writeFileSync(empty, "");
  // No global or system config, which might already trust every directory (CI runners do).
  const env = { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1", GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: "1" };
  withEnv(env, () => {
    // Plain git refuses it, which is what a service user running someone's clone would see.
    expect(Bun.spawnSync(["git", "-C", clone, "rev-parse", "HEAD"], { env: process.env }).exitCode).not.toBe(0);
    expect(versionOf(clone)).toBe(commits[0] as string);
  });
});

test("a version that strands clients says why", () => {
  const { clone } = fresh(1);
  expect(versionProblem(clone)).toBeNull();
  writeFileSync(join(clone, "code.txt"), "edited\n");
  expect(versionProblem(clone)).toMatch(
    /has uncommitted changes, so the version is \w{7}-dirty\. No other host can update to it/,
  );
  expect(versionProblem(specTempDir("cnoc-plain-"))).toMatch(
    new RegExp(
      `^the version is the fallback ${VERSION.replace(/\./g, "\\.")} because .+ is not a git checkout\. Clients cannot update to it`,
    ),
  );
  // A checkout whose git calls fail is named as such, with git's own words.
  const broken = fresh(1).clone;
  writeFileSync(join(broken, ".git", "HEAD"), "garbage\n");
  expect(versionProblem(broken)).toMatch(/because git failed in .+: .+/);
});

test("when the record cannot be written the backoff is kept in memory", async () => {
  const { clone } = fresh(1);
  const unpushed = "0".repeat(40);
  // A state directory that is not there stands in for a full or read-only disk.
  const state = join(specTempDir("cnoc-update-state-"), "missing");
  const clock = { t: 1_000_000 };
  const { u, lines } = updater(clone, state, clock);
  expect(await u.attempt(unpushed)).toBe(false);
  expect(await u.attempt(unpushed)).toBe(false);
  expect(lines).toEqual([
    expect.stringMatching(/^cannot write .+update\.json .*keeping the update backoff in memory/),
    expect.stringMatching(/^update to 0000000 failed: commit 0000000 is not on origin/),
  ]);
  expect(u.dueIn(unpushed)).toBe(UPDATE_RETRY_BASE_MS);
  expect(() => u.clear()).not.toThrow();
  expect(existsSync(state)).toBe(false);
});

test("the wait never exceeds the cap, even if the clock jumps back", async () => {
  const { clone } = fresh(1);
  const clock = { t: 1_000_000_000 };
  const { u } = updater(clone, specTempDir("cnoc-update-state-"), clock);
  expect(await u.attempt("0".repeat(40))).toBe(false);
  clock.t -= 10 * 3_600_000;
  expect(u.dueIn("0".repeat(40))).toBe(UPDATE_RETRY_MAX_MS);
});

/** One restart onto `target` per call, each by a new process on the code the last one checked out, `step` ms apart. */
async function restartsOnto(clone: string, state: string, clock: { t: number }, targets: string[], step: number) {
  const out: boolean[] = [];
  for (const target of targets) {
    const { u } = updater(clone, state, clock, { version: versionOf(clone) });
    out.push(await u.attempt(target));
    clock.t += step;
  }
  return out;
}

test("any number of new deploys in an hour goes through", async () => {
  const n = UPDATE_RESTART_LIMIT + 3;
  const { clone, commits } = fresh(n + 1);
  const state = specTempDir("cnoc-update-state-");
  const clock = { t: 1_000_000 };
  expect(await restartsOnto(clone, state, clock, commits.slice(1), 5 * 60_000)).toEqual(Array(n).fill(true));
  expect(head(clone)).toBe(commits[n] as string);
  // The previous version counts `restarts` against its own limit: new deploys are not written there,
  // so a host downgraded to it is not held by them.
  const { u } = updater(clone, state, clock, { version: versionOf(clone) });
  expect(u.state()?.restarts).toEqual([]);
  expect(u.state()?.returns).toEqual([]);
});

test("a server flapping between versions is held once returns reach the limit, for exactly as long as it says", async () => {
  const { clone, commits } = fresh(4);
  const state = specTempDir("cnoc-update-state-");
  const t0 = 1_000_000;
  const clock = { t: t0 };
  const step = 15_000;
  const [a, b] = [commits[1], commits[2]] as [string, string];
  // From commits[0]: a and b are new, then every flip goes back to one this client ran.
  const flips = Array.from({ length: UPDATE_RESTART_LIMIT + 2 }, (_, i) => (i % 2 ? b : a));
  expect(await restartsOnto(clone, state, clock, flips, step)).toEqual(Array(flips.length).fill(true));
  const at = head(clone);
  const { u, lines } = updater(clone, state, clock, { version: versionOf(clone) });
  const next = versionOf(clone) === a ? b : a;
  expect(await u.attempt(next)).toBe(false);
  expect(head(clone)).toBe(at);
  // The oldest return was the third restart; the budget has room when it leaves the hour.
  const wait = t0 + 2 * step + UPDATE_RESTART_WINDOW_MS - clock.t;
  expect(wait).toBeGreaterThan(UPDATE_RETRY_MAX_MS);
  expect(lines).toEqual([
    `not updating to ${shortVersion(next)} yet: ${UPDATE_RESTART_LIMIT} restarts in the last hour went back to a version this client had already run; is the server's version changing back and forth? Next try in 59m`,
  ]);
  expect(u.dueIn(next)).toBe(wait);
  const now = clock.t;
  clock.t -= 10 * 3_600_000; // the clock jumps back: the hold is still bounded by the window
  expect(u.dueIn(next)).toBe(UPDATE_RESTART_WINDOW_MS);
  clock.t = now;
  expect(u.note(next)).toBe(
    `holding the update to ${shortVersion(next)}: ${UPDATE_RESTART_LIMIT} restarts in the last hour went back to a version this client had already run; is the server's version changing back and forth?; next try in 59m`,
  );

  // A version the client has not run goes through while the flap is held.
  const { u: other } = updater(clone, state, clock, { version: versionOf(clone) });
  expect(await other.attempt(commits[3] as string)).toBe(true);

  // Agreeing with the server does not wipe the history the limit is counted from.
  const { u: agreed } = updater(clone, state, clock, { version: versionOf(clone) });
  agreed.clear();
  expect(agreed.state()?.returns).toHaveLength(UPDATE_RESTART_LIMIT);
  // Only the returns are in the previous version's field.
  expect(agreed.state()?.restarts).toEqual(agreed.state()?.returns);

  // Once the oldest return is out of the window, going back is allowed again.
  clock.t = t0 + 2 * step + UPDATE_RESTART_WINDOW_MS;
  const { u: later } = updater(clone, state, clock, { version: versionOf(clone) });
  expect(await later.attempt(next)).toBe(true);
});

test("a record the previous version wrote is read without its restarts counting, and stays readable to it", async () => {
  const { clone, commits } = fresh(3);
  const state = specTempDir("cnoc-update-state-");
  const now = 10_000_000;
  const clock = { t: now };
  const old = (over: object) =>
    writeFileSync(
      join(state, "update.json"),
      JSON.stringify({
        target: commits[1],
        tries: 1,
        next_at: now + 20 * 60_000,
        reason: null,
        restarted: true,
        at: now - 60_000,
        restarts: [1, 2, 3, 4, 5].map((i) => now - i * 60_000),
        ...over,
      }),
    );

  // What the old code left on the restart that brought this code in: the next deploy goes through.
  old({});
  const first = updater(clone, state, clock, { version: commits[1] as string });
  first.u.clear();
  expect(first.u.state()).toMatchObject({ target: "", left: [], returns: [] });
  expect(first.u.state()?.restarts).toHaveLength(5);
  expect(await first.u.attempt(commits[2] as string)).toBe(true);
  // Still the previous version's fields and types, so a client downgraded to it reads it.
  const onDisk = JSON.parse(readFileSync(join(state, "update.json"), "utf8"));
  expect(onDisk).toMatchObject({ target: commits[2], tries: 1, restarted: true, reason: null });
  expect(typeof onDisk.next_at).toBe("number");
  // The old restarts are carried forward; this new deploy is not added to them.
  expect(onDisk.restarts).toHaveLength(5);
  expect(onDisk.restarts.every((t: unknown) => typeof t === "number")).toBe(true);

  // A hold the old code made for its restart limit is dropped: the target is tried at once.
  old({ reason: "5 restarts for updates in the last hour; is the server's version changing back and forth?" });
  const held = updater(clone, state, clock, { version: commits[0] as string });
  expect(held.u.dueIn(commits[1] as string)).toBe(0);
  // Nothing was restarted for that target, and nothing failed: the hello says only that it is updating.
  expect(held.u.note(commits[1] as string)).toBe(`updating to ${shortVersion(commits[1])}`);
  // Any other backoff it recorded is honoured as it was.
  old({ reason: "commit 0123456 is not on origin; was it pushed?" });
  expect(updater(clone, state, clock).u.dueIn(commits[1] as string)).toBe(20 * 60_000);
});

test("a configured command that leaves a git checkout short of the target is not trusted", async () => {
  const { clone, commits } = fresh(2);
  const { u, lines } = updater(clone, specTempDir("cnoc-update-state-"), { t: 0 }, { command: "true" });
  expect(await u.attempt(commits[1] as string)).toBe(false);
  expect(lines).toEqual([
    expect.stringMatching(/the configured update command succeeded but left .+ at \w{7}; next try in 1m$/),
  ]);
});

test("without git on PATH the fallback says that git could not be run", () => {
  const { clone } = fresh(1);
  const saved = process.env.PATH;
  process.env.PATH = specTempDir("cnoc-empty-path-");
  try {
    expect(versionOf(clone)).toBe(VERSION);
    expect(versionProblem(clone)).toMatch(/because git failed in .+: git could not be run: /);
  } finally {
    process.env.PATH = saved;
  }
});
