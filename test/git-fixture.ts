/**
 * Throwaway git repositories for the update tests: an "origin" with a few commits on main, and
 * clones of it standing in for a host's install. Remotes are local paths; nothing reaches the
 * network.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Runs git with an identity and no signing, whatever the machine's own config says. */
export function git(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(
    [
      "git",
      "-C",
      dir,
      "-c",
      "user.name=cnoc test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

/** Writes a file and commits it. Resolves the new commit. */
export function commit(dir: string, file: string, text: string): string {
  writeFileSync(join(dir, file), text);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", `edit ${file}`);
  return git(dir, "rev-parse", "HEAD");
}

export interface Repos {
  origin: string;
  /** The host's install: a clone of origin, checked out at `commits[0]`. */
  clone: string;
  /** Commits on origin's main, oldest first. */
  commits: string[];
}

/** An origin with `n` commits on main and a clone of it at the first one. */
export function makeRepos(root: string, n = 3): Repos {
  const origin = join(root, "origin");
  const clone = join(root, "clone");
  mkdirSync(origin, { recursive: true });
  git(origin, "init", "-q", "-b", "main");
  writeFileSync(join(origin, ".gitignore"), "node_modules/\n");
  writeFileSync(join(origin, "package.json"), `${JSON.stringify({ name: "fixture", private: true })}\n`);
  git(origin, "add", ".gitignore", "package.json");
  const commits = [commit(origin, "code.txt", "1\n")];
  for (let i = 2; i <= n; i++) commits.push(commit(origin, "code.txt", `${i}\n`));
  git(root, "clone", "-q", origin, clone);
  git(clone, "checkout", "-q", "--detach", commits[0] as string);
  return { origin, clone, commits };
}
