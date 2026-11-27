/**
 * @rule no-import-cycles
 * @expect 0
 * @path src/no-cycle.ts
 *
 * Single file with no local imports — no cycle possible.
 */

export const bar = 1;
