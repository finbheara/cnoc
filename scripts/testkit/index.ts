// Spec helpers. The one way a spec makes a throwaway directory (rule no-raw-mkdtemp).
export {
  SPEC_TMP_PREFIX,
  TmpDir,
  TmpScope,
  reapDeadSpecTempRoots,
  specTempDir,
  specTempRoot,
  sweepSpecTempDirs,
  tmpDir,
  tmpScope,
} from "./tmp";
// Non-spec scratch for scripts; see the header of scratch.ts.
export { SCRATCH_PREFIX, Scratch, pidAlive, reapDeadPidRoots, releaseAllScratch, scratchDir } from "./scratch";
