/**
 * Rule: test-empty-catch
 *
 * Flag catch blocks in test files whose body contains no `expect(` call. An empty or
 * assertion-free catch swallows the failure the test claims to verify: the test passes vacuously
 * when the code throws.
 *
 * Stricter than the package sample of the same idea: every catch in a spec file counts, hooks and
 * helpers included, and a rethrow alone does not satisfy it.
 */
import { type Rule, type TSESTree, walk } from "am-i-done";

function containsExpectCall(node: TSESTree.Node): boolean {
  let found = false;
  walk(node, (n) => {
    if (n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "expect") found = true;
  });
  return found;
}

export default {
  id: "test-empty-catch",
  type: "check",
  category: "testing",
  ast: true,
  tests: "only",
  scold: "catch block in test has no expect(): swallows the failure the test should verify",
  guidance: [
    "assert the caught error: expect(e).toBeInstanceOf(SomeError) or expect((e as Error).message).toContain(...)",
    "or replace try/catch with expect(fn).toThrow(...)",
  ],
  check(ctx) {
    const lines = ctx.file.content.split("\n");
    walk(ctx.ast().program, (node) => {
      if (node.type !== "CatchClause" || containsExpectCall(node.body)) return;
      const { line, column } = node.loc.start;
      ctx.violated(line, column + 1, (lines[line - 1] ?? "").trim());
    });
    return ctx.checked();
  },
} satisfies Rule;
