/**
 * Rule: file-size
 *
 * A TypeScript file over MAX_FILE_LINES (scripts/rules/_config/limits.ts) fails: production
 * source, specs, scripts, and the rule definitions themselves. A tangle is grown one long file at
 * a time; a cap that is checked from the start never has to be landed on code that already breaks
 * it.
 *
 * WHAT IT DOES NOT COVER: rule fixtures (never loaded as source), non-TypeScript files, and files
 * git ignores.
 */
import type { Rule } from "am-i-done";
import { MAX_FILE_LINES } from "./_config/limits";

/** Lines in a text: a trailing newline does not start another line. */
export function lineCount(content: string): number {
  if (content === "") return 0;
  const n = content.split("\n").length;
  return content.endsWith("\n") ? n - 1 : n;
}

export default {
  id: "file-size",
  type: "check",
  category: "architecture",
  files: ["**/*.{ts,tsx}"],
  scold: `a TypeScript file over ${MAX_FILE_LINES} lines: split it by concern`,
  guidance: [
    "split the file along a seam it already has: a pure core and its I/O shell, one concern per module, a spec per module",
    "a spec over the cap usually tests two modules: move each describe block next to the module it tests",
    `the cap lives in scripts/rules/_config/limits.ts (MAX_FILE_LINES); raising it is the owner's decision`,
  ],
  check(ctx) {
    const n = lineCount(ctx.file.content);
    if (n > MAX_FILE_LINES)
      ctx.violated(MAX_FILE_LINES + 1, 1, `${ctx.file.relativePath}: ${n} lines (cap ${MAX_FILE_LINES})`);
    return ctx.checked();
  },
} satisfies Rule;
