/**
 * Execution-context detection.
 *
 * This repo runs in three meaningful audiences:
 *
 *   - ci  → GitHub Actions or generic `CI=true` runners; stream output
 *     directly to the workflow log.
 *   - ai  → A Claude Code session (orchestrator, repair, QA, etc.); preserve
 *     context by writing detailed output to a file and surfacing only a
 *     short summary.
 *   - sh  → Interactive shell; pretty-print with colour where supported.
 *
 * `--pre-commit` / `--pre-push` / `--ci` are intent flags, not contexts:
 * the same runner answers all three, but the step list differs.
 */

import type { ExecutionContext } from "./types";

// Returns true only when AM_I_DONE_AI is explicitly set to "0" or "false" —
// the two values that signal an intentional opt-out of the ai context.
function isExplicitAiOptOut(val: string | undefined): boolean {
  return val === "0" || val === "false";
}

export function detectContext(env: Record<string, string | undefined> = process.env): ExecutionContext {
  // AI vars take priority over CI: an agent-driven workflow (e.g. Claude
  // Action) sets both, and the file-logger context-preservation behaviour
  // is the whole reason this project tracks audience. Set AM_I_DONE_AI=0 or
  // AM_I_DONE_AI=false to force-opt back into the streaming path — this
  // override wins even when CLAUDECODE/AGENT are set (e.g. a non-Claude
  // agent running inside a Claude session).
  if (!isExplicitAiOptOut(env.AM_I_DONE_AI) && (env.CLAUDECODE || env.AGENT || env.AM_I_DONE_AI)) return "ai";
  if (env.GITHUB_ACTIONS || env.CI) return "ci";
  const shell = env.SHELL?.split("/").pop() ?? "";
  if (["sh", "bash", "zsh"].includes(shell)) return "sh";
  return "unknown";
}

export const isPreCommit = process.argv.includes("--pre-commit");
export const isPrePush = process.argv.includes("--pre-push");
export const isCi = process.argv.includes("--ci");
