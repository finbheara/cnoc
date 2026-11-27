/**
 * Version resolution and the client's update procedure, against real git repositories in temp
 * directories. The end-to-end path (a server restarting on a new commit) is in e2e.test.ts.
 */
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { specTempDir } from "../scripts/testkit";
import {
  LEGACY_UPDATE,
  UPDATE_RETRY_BASE_MS,
  UPDATE_RETRY_MAX_MS,
  UpdateError,
  Updater,
  retryDelayMs,
  updateCheckout,
} from "../src/client/update";
import { VERSION } from "../src/protocol";
import { checkoutOf, shortVersion, versionOf } from "../src/version";
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
  expect(shortVersion(null)).toBe("-");
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
});

test("local changes in the client's checkout are not overwritten", async () => {
  const { clone, commits } = fresh(2);
  writeFileSync(join(clone, "code.txt"), "work in progress\n");
  await expect(updateCheckout(clone, commits[1] as string, bun)).rejects.toThrow(/uncommitted changes/);
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
  const { u, lines } = updater(clone, specTempDir("cnoc-update-state-"), { t: 0 }, { command: legacy });
  expect(lines[0]).toMatch(/written by an older install.sh and is ignored/);
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
