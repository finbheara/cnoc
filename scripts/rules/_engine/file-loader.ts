/**
 * File loader for the rule engine.
 *
 * The loader stays simple on purpose: glob `src/`, `scripts/`, `test/` for
 * *.ts (excluding .d.ts and node_modules), read each into memory, attach a few
 * quick-derived flags (`isTest`, `pkg`) and return a Map keyed by absolute path.
 *
 * Beyond TypeScript it also loads the text that tells a person or an agent what
 * to run, for the rules that police it (`no-process-kill`, `claude-md-size`):
 * shell scripts, the git hooks, `docs/`, the root README and CLAUDE.md, and
 * anything under `.claude/` (outside `.claude/worktrees/`). TypeScript under
 * `.git-hooks/` and `.claude/` is swept too; the default roots never reach a
 * dot directory. Rules see the non-TypeScript files only if they opt in via
 * `appliesToFile` (see rule.ts), so the generic rules never run over markdown.
 *
 * Rules that need richer metadata (parsed imports/exports) can attach
 * their own per-rule cache. We intentionally don't pre-parse ASTs across
 * the whole tree — most rules don't need it, and per-rule lazy parsing
 * keeps cold-run time predictable.
 */

import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { Glob } from "bun";

export interface FileMeta {
  /** Absolute path on disk. */
  path: string;
  /** Repo-relative path. Used in reports. */
  relPath: string;
  /** File contents, UTF-8. */
  content: string;
  /** Where the file belongs: "src" | "scripts" | "test" | "packages/<name>" (should the repo grow workspaces) | "". */
  pkg: string;
  /** True for *.spec.ts / *.test.ts (and .tsx variants). */
  isTest: boolean;
  /** True for a `*.rule.ts` definition: seen only by rules with `seesRuleSources` (see rule.ts). */
  isRuleSource?: boolean;
}

/**
 * [dir relative to repo root, glob inside it] — see the header. The dot directories that hold code (`.claude`,
 * `.git-hooks`) are swept for TypeScript too, so every TypeScript rule sees a helper or spec there; the
 * default-root walk does not descend into dot directories. `.claude/worktrees/**` (other checkouts) is never
 * walked: see `NEVER_WALK`.
 */
const EXTRA_GLOBS: readonly (readonly [string, string])[] = [
  [".claude", "**/*.{md,sh,ts,tsx}"],
  ["scripts", "**/*.sh"],
  [".git-hooks", "{pre-commit,pre-push,*.sh,*.ts,*.tsx}"],
  ["docs", "**/*.md"],
  [".", "{CLAUDE.md,README.md,install.sh}"],
];
/**
 * Top-level subdirectories of an extra root that are never descended into: other git worktrees
 * (`.claude/worktrees/<name>`, whole checkouts with their own node_modules) and installed packages.
 */
const NEVER_WALK: ReadonlySet<string> = new Set(["worktrees", "node_modules"]);

/**
 * The paths under `cwd` (relative to it) that match `pattern`, without ever entering a `NEVER_WALK` directory at the
 * top: a `**\/…` glob runs once per top-level subdirectory (exact, since `**\/` also matches the subdirectory's own
 * name), so a worktree is skipped by name, not walked and then filtered. A pattern with no `/` names top-level
 * files only.
 */
async function* scanExtra(cwd: string, pattern: string): AsyncGenerator<string> {
  const glob = new Glob(pattern);
  const recursive = pattern.startsWith("**/");
  if (!recursive && pattern.includes("/")) throw new Error(`file-loader: unsupported extra glob ${pattern}`);
  for (const entry of await readdir(cwd, { withFileTypes: true })) {
    if (entry.isFile()) {
      if (glob.match(entry.name)) yield entry.name;
      continue;
    }
    if (!recursive || !entry.isDirectory() || NEVER_WALK.has(entry.name)) continue;
    for await (const rel of glob.scan({ cwd: join(cwd, entry.name), absolute: false, dot: true })) {
      yield `${entry.name}/${rel}`;
    }
  }
}

/** A fixture bigger than this is not text we should be scanning line by line. */
const MAX_EXTRA_BYTES = 2 * 1024 * 1024;

const TEST_RE = /\.(spec|test)\.tsx?$/;

export function isTestFile(path: string): boolean {
  return TEST_RE.test(path);
}

export function getPackageForPath(repoRoot: string, absPath: string): string {
  const rel = relative(repoRoot, absPath);
  const parts = rel.split("/");
  if (parts[0] === "packages" && parts[1]) return `packages/${parts[1]}`;
  if (parts[0] === "src" || parts[0] === "scripts" || parts[0] === "test") return parts[0];
  return "";
}

export interface LoadOptions {
  repoRoot: string;
  /** Roots to scan, relative to repoRoot. Default: src/, scripts/, test/. */
  roots?: string[];
  /** Substring filter on relative path. Empty = no filter. */
  filter?: string;
  /**
   * Bypass the in-process memo and re-read from disk. Source files don't
   * change within a single run, so callers (the rule sweep, the spec) hit
   * the cache; set this only when you genuinely need a fresh read.
   */
  noCache?: boolean;
}

/**
 * Memoizes scans within a process. `doing-it-wrong.spec.ts` invokes the
 * sweep many times over the same tree; without this each call re-reads the
 * whole source tree, a large peak-memory contributor under shared `bun test`.
 * Keyed on the resolved (repoRoot, roots, filter) so different queries can't
 * collide. Reset via `resetFileCache()` if a test mutates the tree between calls.
 */
const cache = new Map<string, Map<string, FileMeta>>();

function cacheKey(repoRoot: string, scanRoots: string[], filter: string | undefined): string {
  return JSON.stringify({ repoRoot, roots: scanRoots, filter: filter ?? "" });
}

/** Clear the memoized scan results. For tests that change files on disk mid-run. */
export function resetFileCache(): void {
  cache.clear();
}

export async function loadFiles({ repoRoot, roots, filter, noCache }: LoadOptions): Promise<Map<string, FileMeta>> {
  const scanRoots = roots ?? ["src", "scripts", "test"];
  const key = cacheKey(repoRoot, scanRoots, filter);
  if (!noCache) {
    const hit = cache.get(key);
    if (hit) return hit;
  }
  const out = new Map<string, FileMeta>();
  for (const root of scanRoots) {
    const cwd = join(repoRoot, root);
    // A scan root that does not exist yet (no `test/` dir in a young repo) is empty, not an error.
    if (!existsSync(cwd)) continue;
    const glob = new Glob("**/*.{ts,tsx}");
    for await (const rel of glob.scan({ cwd, absolute: false })) {
      if (rel.endsWith(".d.ts")) continue;
      if (rel.includes("node_modules")) continue;
      // Fixtures intentionally contain the shapes rules detect; they're
      // exercised through the fixture-loader path, not the production scan.
      if (rel.includes("rules/fixtures/") || rel.endsWith(".fixture.ts") || rel.endsWith(".fixture.tsx")) continue;
      // Rule definitions document the very patterns they detect (regex
      // literals, scold strings, example snippets in JSDoc). Scanning
      // them means rules silently flag themselves, so they are loaded
      // marked `isRuleSource` and the engine hands them only to a rule
      // that opts in (`seesRuleSources`, e.g. file-size). Engine internals
      // (`scripts/rules/_engine/`) stay in scope — they're product code.
      const isRuleSource = rel.endsWith(".rule.ts") || rel.endsWith(".rule.tsx");
      const abs = join(cwd, rel);
      const repoRel = relative(repoRoot, abs);
      if (filter && !repoRel.includes(filter)) continue;
      const content = await readFile(abs, "utf8");
      out.set(abs, {
        path: abs,
        relPath: repoRel,
        content,
        pkg: getPackageForPath(repoRoot, abs),
        isTest: isTestFile(abs),
        ...(isRuleSource ? { isRuleSource } : {}),
      });
    }
  }
  // Non-TypeScript corpora (only when scanning the default roots, so a caller
  // that narrows `roots` for a spec keeps getting exactly what it asked for).
  if (!roots) {
    for (const [dir, pattern] of EXTRA_GLOBS) {
      const cwd = join(repoRoot, dir);
      if (!existsSync(cwd)) continue;
      for await (const rel of scanExtra(cwd, pattern)) {
        if (rel.includes("node_modules") || rel.includes("worktrees/") || rel.includes(".fixture.")) continue;
        if (rel.endsWith(".d.ts")) continue;
        const abs = join(cwd, rel);
        if (relative(repoRoot, abs).startsWith("scripts/rules/fixtures/")) continue;
        if (out.has(abs)) continue;
        const repoRel = relative(repoRoot, abs);
        if (filter && !repoRel.includes(filter)) continue;
        const st = await stat(abs);
        if (st.size > MAX_EXTRA_BYTES) continue;
        out.set(abs, {
          path: abs,
          relPath: repoRel,
          content: await readFile(abs, "utf8"),
          pkg: getPackageForPath(repoRoot, abs),
          isTest: isTestFile(abs),
        });
      }
    }
  }
  if (!noCache) cache.set(key, out);
  return out;
}
