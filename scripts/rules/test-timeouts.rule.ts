import { type Rule, type TSESTree, walk } from "am-i-done";

/**
 * A literal delay in a test, `setTimeout(fn, 500)` or `await Bun.sleep(100)`, is a guess about how
 * long the code under test takes. On a fast machine it wastes time, on a loaded CI runner it is too
 * short and the test flakes, and either way it races the thing it waits for. Wait for the condition
 * (poll with a deadline, await the event, or inject a fake clock) instead.
 *
 * Owns delays written inside code, with a positive numeric literal: `setTimeout`'s second argument
 * and `Bun.sleep`/`Bun.sleepSync`'s first. The options slot of `test()` is `no-per-test-timeout`'s,
 * and this rule never looks there for a `timeout` number, so the two do not double-report.
 * `0` is left alone (a macrotask yield, not a wait), as are named constants, variables and other
 * expressions, since a name can be tuned in one place.
 *
 * Not caught: `sleep` imported from `timers/promises`, `setInterval`, and a delay hidden behind a
 * local helper (`const wait = () => Bun.sleep(100)` is caught only at its `Bun.sleep`).
 */
const isPositiveNumber = (node: TSESTree.Node | undefined): boolean =>
  node?.type === "Literal" && typeof node.value === "number" && node.value > 0;

const delayOf = (call: TSESTree.CallExpression): TSESTree.Node | undefined => {
  const { callee, arguments: args } = call;
  if (callee.type === "Identifier" && callee.name === "setTimeout") return args[1];
  const isBunSleep =
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    callee.object.name === "Bun" &&
    callee.property.type === "Identifier" &&
    (callee.property.name === "sleep" || callee.property.name === "sleepSync");
  return isBunSleep ? args[0] : undefined;
};

export default {
  id: "test-timeouts",
  type: "check",
  category: "testing",
  ast: true,
  tests: "only",
  scold: "A literal delay in a test (setTimeout or Bun.sleep) races the code it waits for.",
  guidance: [
    "Poll the condition with a deadline, or await the event the code emits, instead of sleeping.",
    "For timer-driven behavior, inject a fake clock or pass the delay in as a parameter.",
    "A named constant or variable delay is fine; a bare number is the guess this rule is after.",
  ],
  check(ctx) {
    const lines = ctx.file.content.split("\n");
    walk(ctx.ast().program, (node) => {
      if (node.type !== "CallExpression") return;
      const delay = delayOf(node);
      if (delay === undefined || !isPositiveNumber(delay)) return;
      const { line, column } = node.loc.start;
      ctx.violated(line, column + 1, (lines[line - 1] ?? "").trim());
    });
    return ctx.checked();
  },
} satisfies Rule;
