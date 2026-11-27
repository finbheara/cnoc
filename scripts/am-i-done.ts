#!/usr/bin/env bun
/**
 * `am-i-done`: the one answer to "did I run every check?"
 *
 *   bun am-i-done                       # everything, with lint auto-fix
 *   bun am-i-done --pre-commit          # the static subset (pre-commit hook)
 *   bun am-i-done --pre-push            # static + the test suite (pre-push hook)
 *   bun am-i-done --ci                  # everything, nothing auto-fixed
 *   bun am-i-done --from 3              # resume at step 3 (number or name)
 *   bun am-i-done --only typecheck      # run a single step
 *   bun am-i-done --skip test           # skip a step by name (repeatable)
 *   bun am-i-done --verbose             # don't hide successful step output
 *
 * In an AI context (CLAUDECODE / AGENT / AM_I_DONE_AI env), all step output is
 * redirected to `build/am-i-done-<timestamp>.txt` and only the file path is
 * surfaced on failure. The file is deleted on success. This is load-bearing: a
 * failing typecheck dumps hundreds of lines that otherwise blow out an agent's
 * context. Set AM_I_DONE_AI=0 to opt back out.
 *
 * Steps that are standalone tools (typecheck, lint, shellcheck, the test suite)
 * run as commands: a string is split on spaces and executed directly, with no
 * shell, so it cannot use globs, pipes or `&&`. The rule checks and the example
 * Jobfiles run in-process, with no second bun startup.
 *
 * The ladder: pre-commit is static only; pre-push adds the tests; `--ci` is
 * the same list with nothing auto-fixed. Hooks are bypassable (--no-verify);
 * the CI workflow (.github/workflows/ci.yml) runs `--ci` on every pull request
 * and its jobs are required checks on main.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Glob } from "bun";

import { checkTemplate, isTemplate, parseJob } from "../src/jobfile";
import { detectContext, isCi, isPreCommit, isPrePush } from "./_runner/context";
import { createAiFileLogger, createConsoleLogger } from "./_runner/logger";
import { killTrackedTree } from "./_runner/process-tree";
import { StepRunner } from "./_runner/runner";
import type { ScriptFunction, Step } from "./_runner/types";
import { doingItWrongStep } from "./doing-it-wrong";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");

// ===== Step library =====
//
// Each step is declarative: name, description, command. Tools are wrapped as
// string commands. The rule engine runs in-process via doingItWrongStep.

const INSTALL: Step = {
  name: "install",
  description: "bun install --frozen-lockfile (no-op when deps are current)",
  command: "bun install --frozen-lockfile",
  onFailure: ["lockfile may be out of date: run `bun install` manually and commit bun.lock"],
};

const TYPECHECK: Step = {
  name: "typecheck",
  description: "bun check (Bun's native TS checker)",
  command: "bun check",
  onFailure: ["fix type errors before continuing", "run with --only typecheck to iterate fast"],
};

const LINT: Step = {
  name: "lint",
  description: "biome check --write (auto-fix where safe)",
  command: "bunx biome check --write .",
  onFailure: ["run `bunx biome check .` to see unfixable issues"],
};

const LINT_CHECK: Step = {
  name: "lint",
  description: "biome check (no auto-fix; pre-commit/pre-push/CI mode)",
  command: "bunx biome check .",
  onFailure: ["run `bun run lint` locally to auto-fix"],
};

const RULES: Step = {
  name: "doing-it-wrong",
  description: "architectural rule engine (scripts/rules/*.rule.ts)",
  command: doingItWrongStep,
  source: "scripts/doing-it-wrong.ts",
  onFailure: [
    "see the rule-by-rule guidance above; the rule tells you how to recover, do not memorize the catalog",
    "run `bun scripts/doing-it-wrong.ts --rule <id>` to iterate on one rule",
    "permanent exception: // dotw-ignore <rule-id>: <reason>",
    "temporary exception: // dotw-todo <rule-id>: <desc> - fix in #1234 (a real issue number)",
  ],
};

/** Parses every example in-process, with the parser the server and the CLI use. */
export const jobfilesStep: ScriptFunction = async ({ logger }) => {
  const files = [...new Glob("examples/*.job").scanSync({ cwd: REPO_ROOT })].sort();
  // An empty directory would otherwise pass by checking nothing.
  if (files.length === 0) return { success: false, error: "no examples/*.job found" };
  let bad = 0;
  for (const rel of files) {
    const text = readFileSync(resolve(REPO_ROOT, rel), "utf8");
    try {
      if (isTemplate(text)) checkTemplate(text);
      else parseJob(text);
    } catch (e) {
      bad++;
      logger.error(`${rel}: ${(e as Error).message}`);
    }
  }
  return { success: bad === 0, error: bad ? `${bad} of ${files.length} examples do not parse` : undefined };
};

const JOBFILES: Step = {
  name: "jobfiles",
  description: "every example Jobfile and template parses (examples/*.job)",
  command: jobfilesStep,
  source: "scripts/am-i-done.ts",
  onFailure: [
    "an example no longer matches the Jobfile syntax: fix the example, or the parser if the syntax was meant to hold",
    "check one by hand: bun src/cli.ts check examples/NAME.job",
  ],
};

const SHELL: Step = {
  name: "shell",
  description: "shellcheck over install.sh, the example feed source and the git hooks",
  command: "shellcheck install.sh examples/feed-github-issues.sh .git-hooks/pre-commit .git-hooks/pre-push",
  onFailure: [
    "`shellcheck` not found: install it (brew install shellcheck, apt install shellcheck); the step is not optional",
    "otherwise fix what shellcheck reports; disable a finding only with a comment that says why",
  ],
};

const TEST: Step = {
  name: "test",
  description: "bun test (the whole suite; the end-to-end tests start real tmux sessions)",
  command: "bun test",
  onFailure: [
    "run `bun test <path>` to iterate on one file, `bun test -t <name>` on one test",
    "the end-to-end tests need tmux on PATH",
  ],
};

// ===== Step lists per mode =====
//
// Pre-commit: fast feedback during `git commit`. No tests, but every static
//   check: they are cheap and catch the easy mistakes early.
//
// Pre-push: the local gate. Static checks, then the whole test suite. The
//   suite is small enough that a diff-aware subset would save little.
//
// CI: the same list as pre-push today. It is its own flag so that a slower,
//   exhaustive check (coverage, per-file timing) has a place to land without
//   slowing every push.
//
// Default (no flag): the developer-friendly path: `biome --write` fixes what
//   it can, then everything else runs.

const STATIC: Step[] = [INSTALL, TYPECHECK, LINT_CHECK, RULES, JOBFILES, SHELL];
export const PRE_COMMIT: Step[] = STATIC;
export const PRE_PUSH: Step[] = [...STATIC, TEST];
export const COMPREHENSIVE: Step[] = [INSTALL, TYPECHECK, LINT, RULES, JOBFILES, SHELL, TEST];
export const CI: Step[] = [...STATIC, TEST];

function selectSteps(): { steps: Step[]; label: string } {
  if (isPreCommit) return { steps: PRE_COMMIT, label: "pre-commit" };
  if (isCi) return { steps: CI, label: "ci" };
  if (isPrePush) return { steps: PRE_PUSH, label: "pre-push" };
  return { steps: COMPREHENSIVE, label: "default" };
}

export function parseFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export function parseRepeatableFlag(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && i + 1 < argv.length) out.push(argv[i + 1] as string);
  }
  return out;
}

/**
 * Steps run in their own process groups so the wall-clock deadline can
 * reap a wedged tree. The cost of `detached` is that a terminal Ctrl-C no
 * longer reaches them — it goes to the foreground group, which is now just
 * this process. Without these handlers, interrupting the gate would strand a
 * whole `bun test` fan-out.
 */
function installSignalHandlers(): void {
  const onSignal = (sig: NodeJS.Signals, code: number): void => {
    process.stderr.write(`\n${sig} — killing child process tree\n`);
    void killTrackedTree().then(() => process.exit(code));
  };
  process.once("SIGINT", () => onSignal("SIGINT", 130));
  process.once("SIGTERM", () => onSignal("SIGTERM", 143));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  installSignalHandlers();

  const { steps, label } = selectSteps();
  const xc = detectContext();
  const aiLogger = xc === "ai" && !argv.includes("--verbose") ? createAiFileLogger(REPO_ROOT) : null;
  const logger = aiLogger ?? createConsoleLogger();

  process.stdout.write(`am-i-done? — ${label} mode (${steps.length} step${steps.length === 1 ? "" : "s"})\n\n`);

  const runner = new StepRunner({
    logger,
    from: parseFlag(argv, "--from"),
    only: parseFlag(argv, "--only"),
    skip: parseRepeatableFlag(argv, "--skip"),
    verbose: argv.includes("--verbose") || argv.includes("-v"),
  });
  runner.add(...steps);
  const report = await runner.run();

  // Warnings from passing steps (a warn-only finding, a green-only-on-rerun) are
  // repeated at the end on stderr: the AI file logger does not mirror them, and a
  // passing run's log file is deleted.
  const warnings = report.warnings ?? [];
  if (warnings.length > 0) {
    process.stderr.write(`\n${warnings.length} warning(s) from passing steps:\n`);
    for (const w of warnings) process.stderr.write(`  ⚠ ${w.step}: ${w.message}\n`);
  }

  if (aiLogger) {
    await aiLogger.finalize(report.success);
    if (!report.success) {
      process.stderr.write(`\nfull logs: ${aiLogger.path}\n`);
    }
  }

  if (report.success) {
    process.stdout.write(`\nall checks passed (${report.totalMs}ms)\n`);
    process.exit(0);
  } else if (report.timedOut) {
    process.stderr.write(`\nam-i-done timed out in ${label} mode after ${report.totalMs}ms\n`);
    process.exit(1);
  } else {
    process.stderr.write(`\nFAILED: ${report.failures.length} step(s) failed in ${label} mode\n`);
    process.exit(1);
  }
}

const HELP = `am-i-done: unified development readiness check

Usage:
  bun am-i-done [--pre-commit | --pre-push | --ci]
                [--from N] [--only NAME] [--skip NAME...] [--verbose]

Flags:
  --pre-commit   the static checks: typecheck, lint, rules, example Jobfiles, shell scripts
  --pre-push     the static checks, then the whole test suite
  --ci           the same list as --pre-push; what the CI workflow runs
  --from N       resume from step N (number or name substring)
  --only N       run exactly one step (number or name substring)
  --skip NAME    skip a step by name (repeatable; substring match)
  --verbose      show captured step output even on success

With no flag it runs everything and lets the linter fix what it safely can.
One definition of done: the hooks, a person and an agent all run this command.

The whole run is bounded by a strict wall-clock deadline: 600s by default,
AM_I_DONE_TIMEOUT_MS to override (<= 0 disables). On expiry the runner names the
in-flight step, dumps the output that step had produced so far, kills the entire
child process TREE (each step runs in its own process group, so a grandchild
test worker cannot be orphaned by the kill), and exits non-zero. This is a
liveness ceiling, not a flake fix: nothing is retried.

In a Claude / AI context (CLAUDECODE / AGENT / AM_I_DONE_AI env var set), step
output is captured to build/am-i-done-<timestamp>.txt and only the path is
surfaced on failure. This is intentional: it keeps a failing typecheck or test
run from filling an agent's context.

All architectural invariants run through the doing-it-wrong rule engine; see
scripts/rules/README.md. \`bun doing-it-wrong --list\` is the catalog.
`;

if (import.meta.main) {
  await main();
}
