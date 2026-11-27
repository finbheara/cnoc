/**
 * Rule: file-size
 *
 * A TypeScript file over MAX_FILE_LINES (scripts/rules/_config/limits.ts) fails: production
 * source, specs, scripts, hook specs, and the rule definitions themselves (`seesRuleSources`).
 * A tangle is grown one long file at a time; a cap that is checked from the start never has to
 * be landed on code that already breaks it.
 *
 * WHAT IT DOES NOT COVER: rule fixtures (`scripts/rules/fixtures/`, examples, never imported),
 * non-TypeScript files, and generated or vendored files the loader does not walk.
 */
import { MAX_FILE_LINES } from "./_config/limits";
import type { CheckRule } from "./_engine/rule";

/** Lines in a text: a trailing newline does not start another line. */
export function lineCount(content: string): number {
  if (content === "") return 0;
  const n = content.split("\n").length;
  return content.endsWith("\n") ? n - 1 : n;
}

const rule: CheckRule = {
  id: "file-size",
  kind: "check",
  scold: `a TypeScript file over ${MAX_FILE_LINES} lines: split it by concern`,
  guidance: [
    "split the file along a seam it already has: a pure core and its I/O shell, one concern per module, a spec per module",
    "a spec over the cap usually tests two modules: move each describe block next to the module it tests",
    `the cap lives in scripts/rules/_config/limits.ts (MAX_FILE_LINES); raising it is the owner's decision`,
  ],
  seesRuleSources: true,
  check({ file, violated, checked }) {
    checked();
    const n = lineCount(file.content);
    if (n > MAX_FILE_LINES) violated(MAX_FILE_LINES + 1, 1, `${file.relPath}: ${n} lines (cap ${MAX_FILE_LINES})`);
  },
};

export default rule;
