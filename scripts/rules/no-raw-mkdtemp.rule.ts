/**
 * Rule: no-raw-mkdtemp
 *
 * Every throwaway directory has an owner that removes it. A raw `mkdtemp` / `mkdtempSync`
 * call, a `tmpdir()` call, or a read of `process.env.TMPDIR` / `Bun.env.TMPDIR` is refused
 * everywhere except the two OWNERS:
 *
 *   - `scripts/testkit/tmp.ts` (`specTempDir`, `tmpScope`, `tmpDir`): spec temp dirs, all
 *     under `<tmpdir>/cnoc-test-tmp-<pid>/`, removed by the preload's global `afterAll`
 *     and, for a killed run, reaped by pid on the next run.
 *   - `scripts/testkit/scratch.ts` (`scratchDir`): production scratch, under
 *     `<tmpdir>/cnoc-scratch-<pid>/`, removed on release, on exit, and by pid after a
 *     death that did not unwind.
 *
 * WHY A RULE. A leaked temp dir is silent by construction: nothing goes red, the disk fills.
 *
 * AST-based: a call or property read in code is flagged, a comment that names the API is not,
 * and `fs.mkdtempSync(...)` / `os.tmpdir()` are calls too. WHAT IT DOES NOT COVER: a shell
 * `mktemp -d`, a `/tmp/...` string literal, and anything a child process makes.
 */

import ts from "typescript-5";
import type { CheckRule } from "./_engine/rule";

export const OWNERS: ReadonlySet<string> = new Set(["scripts/testkit/tmp.ts", "scripts/testkit/scratch.ts"]);

const CALLS = ["mkdtemp", "mkdtempSync", "tmpdir"];

const rule: CheckRule = {
  id: "no-raw-mkdtemp",
  kind: "check",
  scold: "raw mkdtemp / tmpdir() / $TMPDIR outside the temp owners: nothing removes what it makes",
  guidance: [
    'a spec: `specTempDir("x-")` from scripts/testkit (swept with the run, reaped by pid if the run is killed)',
    'a spec, one block: `using d = tmpDir("x-")` or `using fx = tmpScope(); fx.dir("x-")` (removed on return AND throw)',
    'production code or a script: `scratchDir("x-")` from scripts/testkit (the non-spec owner), then `.release()` when done',
    "the owners are scripts/testkit/tmp.ts and scripts/testkit/scratch.ts; do not add another",
  ],
  appliesToFile: (rel) => /\.tsx?$/.test(rel) && !OWNERS.has(rel),
  check({ file, violated, ast, checked }) {
    checked();
    const lines = file.content.split("\n");
    const flag = (node: ts.Node): void => {
      const pos = ast.positionOf(node);
      violated(pos.line, pos.column, (lines[pos.line - 1] ?? "").trim());
    };
    for (const name of CALLS) for (const call of ast.callsTo(name)) flag(call);
    for (const pa of ast.find(ts.isPropertyAccessExpression)) {
      if (pa.name.text !== "TMPDIR") continue;
      const env = pa.expression;
      if (ts.isPropertyAccessExpression(env) && env.name.text === "env") flag(pa);
    }
    for (const ea of ast.find(ts.isElementAccessExpression)) {
      const arg = ea.argumentExpression;
      if (ts.isStringLiteralLike(arg) && arg.text === "TMPDIR") flag(ea);
    }
  },
};

export default rule;
