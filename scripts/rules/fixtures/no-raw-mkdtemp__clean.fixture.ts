/**
 * @rule no-raw-mkdtemp
 * @expect 0
 * @path src/example.spec.ts
 *
 * The helper is used; comments that NAME mkdtempSync( and tmpdir() are prose, not calls; an
 * env object that SETS TMPDIR for a child is not a read of it.
 */
import { specTempDir, tmpDir } from "../../testkit";

// was: mkdtempSync(join(tmpdir(), "outbox-"))
const root = specTempDir("outbox-");
using one = tmpDir("one-");
const env = { ...process.env, TMPDIR: root };
export { env, one, root };
