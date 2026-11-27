/**
 * Rule: no-per-test-timeout
 *
 * A test call (`test`, `it`, and their `.only` / `.skip` / `.if(c)` / `.each(t)` forms) with a
 * THIRD argument: a per-test `{ timeout }` / number, or `{ retry }` / `{ repeats }`. Bun's third
 * positional is exactly that options slot, so any third argument is one of them.
 *
 * WHY. A per-test timeout hides one slow test inside a fast file: the file as a whole looks
 * fine and nothing ever names the slow test. A per-test `retry` is a flake absorbed by
 * construction. When a file genuinely needs longer, say so once at file scope with
 * `setDefaultTimeout(NAMED_MS)` and a comment giving the reason.
 *
 * AST-based: only a call whose callee chain bottoms out in the identifier `test` or `it` counts;
 * `describe`, hooks and unrelated three-argument calls are not flagged.
 */

import ts from "typescript-5";
import type { CheckRule } from "./_engine/rule";

const TEST_FNS: ReadonlySet<string> = new Set(["test", "it"]);

/** The identifier a callee chain starts from: `test.skip.each(t)` -> `test`. */
function rootIdentifier(expr: ts.Expression): string | null {
  let cur: ts.Expression = expr;
  for (;;) {
    if (ts.isIdentifier(cur)) return cur.text;
    if (ts.isPropertyAccessExpression(cur)) cur = cur.expression;
    else if (ts.isCallExpression(cur)) cur = cur.expression;
    else return null;
  }
}

const rule: CheckRule = {
  id: "no-per-test-timeout",
  kind: "check",
  appliesToTests: true,
  scold: "a per-test timeout / retry (third argument to test/it): it hides a slow or flaky test",
  guidance: [
    "Bad:   test('x', async () => { ... }, 30_000)        Bad: test('x', fn, { retry: 3 })",
    "Good:  at file scope, `setDefaultTimeout(X_SPEC_TIMEOUT_MS)` with a comment saying what is slow and why",
    "better: make the test fast (extract pure logic, split the file, poll a condition)",
    "a retry is never the fix: a test that is green only on a rerun is a flake; find its cause",
  ],
  check({ file, violated, ast, checked }) {
    checked();
    const lines = file.content.split("\n");
    for (const call of ast.find(ts.isCallExpression)) {
      if (call.arguments.length < 3) continue;
      const root = rootIdentifier(call.expression);
      if (root === null || !TEST_FNS.has(root)) continue;
      const third = call.arguments[2] as ts.Expression;
      const pos = ast.positionOf(third);
      violated(pos.line, pos.column, (lines[pos.line - 1] ?? "").trim());
    }
  },
};

export default rule;
