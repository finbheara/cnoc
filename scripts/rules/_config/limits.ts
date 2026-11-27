/**
 * The size caps the governance rules read.
 *
 * One file, so a change to any cap is one reviewable line. A rule lands only at zero violations,
 * and none of these rules has an exemption list: raising a cap here is the only way past one, and
 * that is a decision for the owner.
 */

/**
 * `file-size`: a TypeScript file (source, test, script or rule) over this many lines fails.
 * Set just above the largest file when the rule landed (src/server/store.ts, 720 lines), so it
 * stops growth without forcing a restructure. Five files were over 400 then; lower this as they
 * are split.
 */
export const MAX_FILE_LINES = 750;

/** `claude-md-size`: a CLAUDE.md over this many bytes (UTF-8) fails. */
export const MAX_CLAUDE_MD_BYTES = 8 * 1024;
