/**
 * @rule no-raw-mkdtemp
 * @expect 0
 * @path scripts/example.ts
 *
 * A deliberate output file the user asked for, not scratch, carries a reasoned ignore.
 */
import { join } from "node:path";

// dotw-ignore no-raw-mkdtemp: the screenshot is the command's output, kept for the user, not scratch
export const out = join(process.env.TMPDIR ?? "/tmp", "shot.png");
