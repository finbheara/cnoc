/**
 * Rule: no-process-kill
 *
 * `pkill`, `killall` and `kill -9` (also `kill -KILL`, `kill -SIGKILL`, `kill -s KILL|9`) are
 * refused in code, shell scripts, the git hooks, `.claude/**` briefs, `docs/` and the root
 * CLAUDE.md and README.md.
 *
 * WHY. A host-wide match is unsafe by construction on a box that runs live sessions and parallel
 * worktrees: `pkill -f <pattern>` (and `pgrep -f`) match the shell whose own command line holds
 * the pattern, and every other worktree's and session's processes that happen to match. `kill -9`
 * skips the handler that releases locks and temp dirs. Stop only a pid you own, by pid, with
 * SIGTERM; a process that needs SIGKILL is a teardown bug.
 *
 * TEXT THAT WARNS IS ALLOWED, by a precise test rather than a path ignore. A mention is a
 * warning when, in its own sentence (bounded by `. ! ? ;`, a blank line, a list item or a table
 * cell):
 *   (a) the sentence OPENS with a prohibition: `Never`, `NEVER:`, `Do not`, `Don't`, `No`, `Avoid`;
 *   (b) a prohibition word directly governs it: `never`, `no`, `not`, `nor`, `without`,
 *       `instead of`, `rather than`, `refuses`, `bans`, with only articles, backticks, commas, `or`
 *       / `and`, `-f` and other refused commands in between (`never \`kill -9\`, \`pkill\` or
 *       \`killall\`` covers all three);
 *   (c) it is followed by `is|are` + `banned|forbidden|refused|unsafe|never ...`.
 * In code and shell (`.ts`, `.sh`, the hooks) the exemption applies only inside a comment; a
 * string or a command is always flagged. "If it does not stop, run pkill" is NOT a warning:
 * `stop, run` is not filler, so (b) fails, and the sentence opens with `If`.
 *
 * WHAT IT DOES NOT COVER: `process.kill(pid, "SIGKILL")` and `kill(["-9", pid])` built from
 * arrays. The deadline escalation in `scripts/_runner/process-tree.ts` is the one owner of SIGKILL.
 */

import type { CheckRule } from "./_engine/rule";

const TERM_RE = /\bpkill\b|\bkillall\b|\bkill\s+(?:-(?:9|KILL|SIGKILL)\b|-s\s+(?:KILL|SIGKILL|9)\b)/g;

const PROHIBIT = String.raw`never|no|not|nor|without|instead\s+of|rather\s+than|refuses?|bans?|forbids?|avoid|don't|do\s+not`;
/** A backtick, for the character classes below (a raw template cannot hold one bare). */
const BT = "`";
/** (a) the sentence opens with a prohibition, after any markdown / comment markers. */
const OPENS_RE = new RegExp(String.raw`^[\s>*#/|\-+\d.)${BT}_]*(?:never|do\s+not|don't|no|avoid)\b`, "i");
/**
 * (b) a prohibition word, then only filler, then the end (where the term starts). Filler: articles,
 * quotes/backticks, punctuation of a list, `or`/`and`, `use`/`run`, `bare`, `-f`, and other terms.
 */
const FILLER = String.raw`(?:[\s${BT}'",:*()/]|\ba\b|\ban\b|\bany\b|\bthe\b|\bbare\b|\binline\b|\bor\b|\band\b|\buse\b|\brun\b|\bcall\b|\bwith\b|-f\b|-9\b|-KILL\b|\bpkill\b|\bpgrep\b|\bkillall\b|\bkill\b)*`;
const GOVERNED_RE = new RegExp(String.raw`\b(?:${PROHIBIT})\b${FILLER}$`, "i");
/** (c) `<term> ... is banned` */
const PREDICATE_RE = /^[\s`'"]*(?:-f\b[\s`'"]*)?(?:is|are)\s+(?:banned|forbidden|refused|unsafe|never|not)\b/i;

const CODE_RE = /\.(?:tsx?|sh)$|(?:^|\/)\.git-hooks\/(?:pre-commit|pre-push)$/;

export function isCodeLike(relPath: string): boolean {
  return CODE_RE.test(relPath);
}

/** Start offset of the sentence holding `at`. */
function sentenceStart(content: string, at: number): number {
  const before = content.slice(0, at);
  let start = 0;
  for (const re of [/[.!?;](?=\s)/g, /\n[ \t]*\n/g, /\n[ \t]*(?:[-*+]|\d+\.)\s/g, /\|/g]) {
    for (let m = re.exec(before); m !== null; m = re.exec(before)) start = Math.max(start, m.index + m[0].length);
  }
  return start;
}

/** End offset (exclusive) of the sentence that starts before `from`. */
function sentenceEnd(content: string, from: number): number {
  const after = content.slice(from);
  const m = /[.!?;](?=\s|$)|\n[ \t]*\n|\n[ \t]*(?:[-*+]|\d+\.)\s|\|/.exec(after);
  return m ? from + m.index : content.length;
}

/** True when offset `at` sits in a comment on its line (`//`, a JSDoc `*` line, or shell `#`). */
function inComment(content: string, at: number, relPath: string): boolean {
  const lineStart = content.lastIndexOf("\n", at - 1) + 1;
  const head = content.slice(lineStart, at);
  if (/\.tsx?$/.test(relPath)) return head.includes("//") || /^\s*(?:\*|\/\*)/.test(head);
  return /^\s*#/.test(head) || /\s#\s/.test(head);
}

/** True when the mention at `[at, at+len)` warns against the command (see the header). */
export function isWarning(content: string, at: number, len: number): boolean {
  const start = sentenceStart(content, at);
  const lead = content.slice(start, at);
  if (OPENS_RE.test(lead)) return true;
  if (GOVERNED_RE.test(lead)) return true;
  const tail = content.slice(at + len, sentenceEnd(content, at + len));
  return PREDICATE_RE.test(tail);
}

const rule: CheckRule = {
  id: "no-process-kill",
  kind: "check",
  scold: "pkill / killall / kill -9: host-wide or handler-skipping process kills",
  guidance: [
    "stop only a pid you own, by pid, with SIGTERM: `kill <pid>` (the pid from your own spawn or pidfile)",
    "a wait on a process runs from a script file that polls `kill -0 <pid>`, not an inline `pgrep -f` loop",
    "a process that needs SIGKILL is a teardown bug: fix its signal handler",
    "text that WARNS is fine when the sentence opens with Never / Do not, or `never`/`no` directly governs the command",
    "a genuine exception: // dotw-ignore no-process-kill: <why> (in markdown: <!-- // dotw-ignore no-process-kill: why -->)",
  ],
  appliesToFile: (rel) =>
    !rel.startsWith(".claude/worktrees/") &&
    (isCodeLike(rel) || /^(?:\.claude|docs)\/.+\.md$/.test(rel) || rel === "CLAUDE.md" || rel === "README.md"),
  check({ file, violated, checked }) {
    checked();
    const { content, relPath } = file;
    const code = isCodeLike(relPath);
    for (const m of content.matchAll(TERM_RE)) {
      const at = m.index ?? 0;
      if ((!code || inComment(content, at, relPath)) && isWarning(content, at, m[0].length)) continue;
      const line = content.slice(0, at).split("\n").length;
      const lineText = content.split("\n")[line - 1] ?? "";
      violated(line, 1, lineText.trim().slice(0, 160));
    }
  },
};

export default rule;
