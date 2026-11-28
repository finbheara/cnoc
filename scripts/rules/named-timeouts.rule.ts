/**
 * Rule: named-timeouts
 *
 * Flag a numeric literal sitting in a timeout/delay position, where the magic number drifts from
 * the constant that should govern it and carries no meaning at the call site.
 *
 * The rule anchors strictly on the call/argument CONTEXT, never on bare numeric literals elsewhere:
 *
 *   - `setTimeout(fn, <literal>)`: 2nd arg
 *   - `setInterval(fn, <literal>)`: 2nd arg
 *   - `AbortSignal.timeout(<literal>)`: 1st arg
 *   - `{ timeout: <literal> }` and `{ timeoutMs: <literal> }`: option-property
 *
 * Literal `0` is exempt (legitimate next-tick scheduling). Production code only; a literal delay
 * in a spec is `test-timeouts`'s.
 *
 * Fix: hoist the literal to a `const FOO_MS = 30_000` near the call site, or reuse an existing
 * `*_MS` constant where one fits.
 */
import { type Rule, type TSESTree, walk } from "am-i-done";

const TIMER_FN_NAMES: ReadonlySet<string> = new Set(["setTimeout", "setInterval"]);
const TIMEOUT_OPT_KEYS: ReadonlySet<string> = new Set(["timeout", "timeoutMs"]);

/**
 * A numeric literal other than 0, optionally behind a unary `+`. Variables, member accesses,
 * arithmetic and templates are "named enough": they carry an identifier the reader can chase.
 */
function flaggedLiteral(node: TSESTree.Node | undefined): TSESTree.Node | undefined {
  if (node === undefined) return undefined;
  const inner = node.type === "UnaryExpression" && node.operator === "+" ? node.argument : node;
  if (inner.type !== "Literal" || typeof inner.value !== "number" || inner.value === 0) return undefined;
  return node;
}

/** The delay argument of a timer call, if `call` is one. */
function delayArgument(call: TSESTree.CallExpression): TSESTree.Node | undefined {
  const { callee } = call;
  if (callee.type === "Identifier" && TIMER_FN_NAMES.has(callee.name)) return call.arguments[1];
  const isAbortSignalTimeout =
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name === "AbortSignal" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "timeout";
  return isAbortSignalTimeout ? call.arguments[0] : undefined;
}

function keyName(prop: TSESTree.Property): string | undefined {
  if (prop.computed) return undefined;
  if (prop.key.type === "Identifier") return prop.key.name;
  if (prop.key.type === "Literal" && typeof prop.key.value === "string") return prop.key.value;
  return undefined;
}

export default {
  id: "named-timeouts",
  type: "check",
  category: "conventions",
  ast: true,
  tests: "exclude",
  scold:
    "timeout/delay is a magic numeric literal: hoist it to a named `*_MS` constant so the value carries meaning at the call site and can't drift from related constants",
  guidance: [
    "the failure mechanism: an inline number (`setTimeout(fn, 30000)`, `{ timeoutMs: 5000 }`) drifts from the constant that should govern it and tells the reader nothing about what the duration means",
    "fix: hoist to a `const FOO_MS = 30_000` near the call site, or reuse an existing `*_MS` constant where one fits",
    "covers (non-exhaustive): `setTimeout(fn, 30000)`, `setInterval(fn, 3000)`, `AbortSignal.timeout(5000)`, `{ timeout: 10_000 }`, `{ timeoutMs: 5000 }`",
    "literal `0` is allowed (explicit next-tick); any non-literal (variable, expression, template) is treated as named enough",
    "for config-driven durations: validate with `z.number()` and thread a named default, which keeps the value tunable and self-documenting",
  ],
  check(ctx) {
    const lines = ctx.file.content.split("\n");
    const flag = (node: TSESTree.Node): void => {
      const { line, column } = node.loc.start;
      ctx.violated(line, column + 1, (lines[line - 1] ?? "").trim());
    };
    walk(ctx.ast().program, (node) => {
      if (node.type === "CallExpression") {
        const literal = flaggedLiteral(delayArgument(node));
        if (literal !== undefined) flag(literal);
      } else if (node.type === "Property" && !node.shorthand) {
        const key = keyName(node);
        const literal = key !== undefined && TIMEOUT_OPT_KEYS.has(key) ? flaggedLiteral(node.value) : undefined;
        if (literal !== undefined) flag(literal);
      }
    });
    return ctx.checked();
  },
} satisfies Rule;
