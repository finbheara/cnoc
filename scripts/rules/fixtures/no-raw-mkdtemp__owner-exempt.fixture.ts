/**
 * @rule no-raw-mkdtemp
 * @expect 0
 * @path scripts/testkit/scratch.ts
 *
 * The non-spec owner may spell the primitive: it is the thing that removes what it makes.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

export const made = mkdtempSync(`${tmpdir()}/cnoc-scratch-1/x-`);
