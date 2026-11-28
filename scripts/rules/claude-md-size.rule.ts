import type { Rule } from "am-i-done";
import { MAX_CLAUDE_MD_BYTES as MAX_BYTES } from "./_config/limits";

/**
 * Every CLAUDE.md an agent works under is loaded into every turn, so each byte is paid for on every
 * request, and a long one buries the rules that matter under the ones that don't. A cap makes
 * growth a decision. The anchor makes the rule fail, not pass, once the root CLAUDE.md is gone.
 * The cap is in `_config/limits.ts`; raising it is the owner's decision.
 */
export default {
  id: "claude-md-size",
  type: "check",
  category: "conventions",
  files: ["CLAUDE.md", "**/CLAUDE.md"],
  scold: `A CLAUDE.md over ${MAX_BYTES} bytes, which every agent turn pays for.`,
  guidance: [
    "Keep what an agent needs on every task: what done means, the layout, the conventions.",
    "Move the rest to docs the CLAUDE.md links to, which an agent reads when the task needs them.",
    "Delete what the code, the config or a rule already enforces.",
    "The cap lives in scripts/rules/_config/limits.ts (MAX_CLAUDE_MD_BYTES); raising it is the owner's decision.",
  ],
  anchors: [(files) => files.has("CLAUDE.md")],
  check(ctx) {
    const bytes = Buffer.byteLength(ctx.file.content);
    if (bytes > MAX_BYTES) ctx.violated(1, 1, `${bytes} bytes, over the ${MAX_BYTES}-byte cap`);
    return ctx.checked();
  },
} satisfies Rule;
