/**
 * Rule: claude-md-size
 *
 * A CLAUDE.md over MAX_CLAUDE_MD_BYTES (scripts/rules/_config/limits.ts) fails. An
 * uncapped CLAUDE.md only grows, and every agent pays for every byte on every turn.
 * Anchored on the root CLAUDE.md, so deleting or renaming it is an engine error, not a pass.
 *
 * WHAT IT DOES NOT COVER: a CLAUDE.md the loader does not walk (it walks the root, `.claude/**`
 * and `docs/**`), and whatever CLAUDE.md imports or links to.
 */
import { MAX_CLAUDE_MD_BYTES } from "./_config/limits";
import type { CheckRule } from "./_engine/rule";

const rule: CheckRule = {
  id: "claude-md-size",
  kind: "check",
  scold: `CLAUDE.md over ${MAX_CLAUDE_MD_BYTES} bytes: it is loaded into every agent's context`,
  guidance: [
    "cut, do not compress: a statement that a check enforces does not need to be in CLAUDE.md as well",
    "move reference material to the file it describes, and leave a one-line pointer",
    `the cap lives in scripts/rules/_config/limits.ts (MAX_CLAUDE_MD_BYTES); raising it is the owner's decision`,
  ],
  anchors: ["CLAUDE.md"],
  appliesToFile: (rel) => rel === "CLAUDE.md" || rel.endsWith("/CLAUDE.md"),
  check({ file, violated, checked }) {
    checked();
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > MAX_CLAUDE_MD_BYTES) violated(1, 1, `${file.relPath}: ${bytes} bytes (cap ${MAX_CLAUDE_MD_BYTES})`);
  },
};

export default rule;
