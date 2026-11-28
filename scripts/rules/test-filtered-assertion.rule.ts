/**
 * Rule: test-filtered-assertion
 *
 * Flag `expect(arr.filter(...)).toHaveLength(0)` and `.toEqual([])` in tests.
 *
 * Why this is a trap: filtering is *subtractive*. You delete rows from the collection before you
 * ever look at it, so anything the filter removed can no longer fail the assertion. A passing
 * `filter(...).toHaveLength(0)` tells you "the specific bad thing I searched for is absent"; it can
 * never tell you "the output is correct".
 *
 * A filter anywhere inside the subject counts (`expect(xs.filter(p).map(f)).toEqual([])`), which
 * the package sample of the same idea does not catch.
 */
import { type Rule, type TSESTree, walk } from "am-i-done";

function containsFilterCall(node: TSESTree.Node): boolean {
  let found = false;
  walk(node, (n) => {
    if (
      n.type === "CallExpression" &&
      n.callee.type === "MemberExpression" &&
      n.callee.property.type === "Identifier" &&
      n.callee.property.name === "filter"
    )
      found = true;
  });
  return found;
}

function isEmptyAssertion(name: string, args: readonly TSESTree.Node[]): boolean {
  if (args.length !== 1) return false;
  const arg = args[0];
  if (name === "toHaveLength") return arg?.type === "Literal" && arg.raw === "0";
  if (name === "toEqual") return arg?.type === "ArrayExpression" && arg.elements.length === 0;
  return false;
}

/** The `expect(...)` call at the root of a matcher chain: `expect(x).not.toEqual` gives `expect(x)`. */
function expectAncestor(node: TSESTree.Node): TSESTree.CallExpression | undefined {
  if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "expect") return node;
  if (node.type === "MemberExpression") return expectAncestor(node.object);
  if (node.type === "CallExpression") return expectAncestor(node.callee);
  return undefined;
}

export default {
  id: "test-filtered-assertion",
  type: "check",
  category: "testing",
  ast: true,
  tests: "only",
  scold: "expect(collection.filter(...)) hides unexpected items: assert the whole collection instead",
  guidance: [
    "filtering is subtractive: whatever the filter removed can never fail the test, so .filter(...).toHaveLength(0) proves only that the bad thing you searched for is absent, never that the output is correct. Assert against the whole collection so unexpected items fail too.",
    "examples of doing it right (not exhaustive): expect(arr).toEqual([]) when it should be empty; expect(arr).not.toContainEqual(expect.objectContaining({ field: V })) when it legitimately holds other items (the filter predicate you wrote is the matcher); for a filter(p).map(f).toEqual([]), assert per element: for (const e of arr) expect(p(e)).toBe(false).",
  ],
  check(ctx) {
    const lines = ctx.file.content.split("\n");
    walk(ctx.ast().program, (node) => {
      if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return;
      const { property, object } = node.callee;
      if (property.type !== "Identifier" || !isEmptyAssertion(property.name, node.arguments)) return;
      const call = expectAncestor(object);
      if (call === undefined || call.arguments.length !== 1) return;
      const subject = call.arguments[0];
      if (subject === undefined || !containsFilterCall(subject)) return;
      const { line, column } = call.loc.start;
      ctx.violated(line, column + 1, (lines[line - 1] ?? "").trim());
    });
    return ctx.checked();
  },
} satisfies Rule;
