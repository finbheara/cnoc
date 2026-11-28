import type { Rule } from "am-i-done";

/**
 * An example rule. Every rule file default-exports one rule, and every rule needs at least one
 * fixture in ./fixtures/: `<rule-id>__<scenario>.<ext>.fixture`, with `@expect <n>` for the number
 * of violations the rule must report there.
 */
export default {
  id: "todo-cites-issue",
  type: "pattern",
  category: "conventions",
  scope: "comments",
  pattern: /\b(?:TODO|FIXME)\b(?![^\n]*#\d+)/g,
  scold: "A TODO without an issue is a promise nobody is tracking.",
  guidance: ["Cite the issue that tracks it: `// TODO(#123): ...`, or do it now."],
  expected: 0,
} satisfies Rule;
