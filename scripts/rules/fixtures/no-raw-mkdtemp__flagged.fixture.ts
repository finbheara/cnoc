/**
 * @rule no-raw-mkdtemp
 * @expect 6
 * @path src/example.spec.ts
 *
 * Six raw temp makers in a spec: mkdtempSync, promises mkdtemp, fs.mkdtempSync, tmpdir(),
 * os.tmpdir() and a read of process.env.TMPDIR. Each is flagged.
 */
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import { tmpdir } from "node:os";

const a = mkdtempSync("/x/a-");
const b = await mkdtemp("/x/b-");
const c = fs.mkdtempSync("/x/c-");
const d = tmpdir();
const e = os.tmpdir();
const f = process.env.TMPDIR;
export { a, b, c, d, e, f };
