import { type Rule, type TSESTree, walk } from "am-i-done";

/**
 * Bun's third argument to `test()` and `it()` is an options slot: a number or `{ timeout }`, or
 * `{ retry }` / `{ repeats }`. A longer limit on one test lets it grow slow without anyone being
 * told, and the suite's time creeps up one exception at a time. A retry turns a flaky test green
 * on its second try, and the bug that made it flaky ships. Make the test fast and deterministic;
 * if a whole file truly needs longer, set that once for the file and say what is slow.
 *
 * Owns the third argument of a test registration and nothing inside the test body; waits and
 * delays in a body belong to `test-timeouts`, so the two never report the same code. Modifier
 * chains count (`test.only`, `test.skip.each(rows)(name, fn, 5_000)`, `test.skipIf(c)(...)`);
 * `describe`, hooks and the modifier calls themselves (`test.each(a, b, c)`) do not.
 */
const TEST_FUNCTIONS: ReadonlySet<string> = new Set(["test", "it"]);

/** Modifiers that take arguments of their own, so a call to one is not a test registration. */
const MODIFIERS: ReadonlySet<string> = new Set(["each", "if", "skipIf", "todoIf", "failing"]);

/** The identifier a callee chain starts from: `test.skip.each(rows)` gives `test`. */
const rootName = (node: TSESTree.Node): string | undefined => {
  let current = node;
  for (;;) {
    if (current.type === "Identifier") return current.name;
    if (current.type === "MemberExpression") current = current.object;
    else if (current.type === "CallExpression") current = current.callee;
    else return undefined;
  }
};

const isModifierCall = (callee: TSESTree.Node): boolean =>
  callee.type === "MemberExpression" &&
  !callee.computed &&
  callee.property.type === "Identifier" &&
  MODIFIERS.has(callee.property.name);

export default {
  id: "no-per-test-timeout",
  type: "check",
  category: "testing",
  ast: true,
  tests: "only",
  scold: "A test registered with its own timeout or retry, which lets it be slow or flaky unnoticed.",
  guidance: [
    "Make the test fast: extract the pure logic, split the file, or wait on a condition instead of a delay.",
    "If the whole file needs longer, call `setDefaultTimeout(...)` once at file scope with a comment giving the reason.",
    "Never retry: find out why the test fails on the first run.",
  ],
  check(ctx) {
    const lines = ctx.file.content.split("\n");
    walk(ctx.ast().program, (node) => {
      if (node.type !== "CallExpression" || isModifierCall(node.callee)) return;
      const third = node.arguments[2];
      const root = rootName(node.callee);
      if (third === undefined || root === undefined || !TEST_FUNCTIONS.has(root)) return;
      const { line, column } = third.loc.start;
      ctx.violated(line, column + 1, (lines[line - 1] ?? "").trim());
    });
    return ctx.checked();
  },
} satisfies Rule;
