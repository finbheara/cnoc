// Loaded by the root bunfig.toml `[test] preload`, before the first spec file; nothing imports it.
/**
 * THE TEST RUN CLEANS UP AFTER ITSELF.
 *
 * At start: every `cnoc-test-tmp-<pid>` and `cnoc-scratch-<pid>` root whose process is gone
 * (a killed run) is removed, by pid, never by age: a concurrent run's root is young and live.
 *
 * At end: an `afterAll` registered here is GLOBAL, and bun runs it once after the last file.
 * It removes this run's spec root (everything `specTempDir` / `tmpScope` / `tmpDir` made) and
 * this process's scratch root.
 */
import { afterAll } from "bun:test";
import { SCRATCH_PREFIX, reapDeadPidRoots, releaseAllScratch } from "./scratch";
import { reapDeadSpecTempRoots, sweepSpecTempDirs } from "./tmp";

reapDeadSpecTempRoots();
reapDeadPidRoots(SCRATCH_PREFIX);

afterAll(() => {
  sweepSpecTempDirs();
  releaseAllScratch();
});
