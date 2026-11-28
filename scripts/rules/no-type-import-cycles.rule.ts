/**
 * Rule: no-type-import-cycles
 *
 * An import cycle that closes only through type imports (`import type`, `export type ... from`,
 * or an import Bun's scanner drops because every name in it is a type). The built-in
 * `no-import-cycles` follows the runtime graph, where such a cycle does not exist because it never
 * runs. It is still a cycle in the design: the two modules cannot be understood, moved or split
 * apart, and the next runtime import between them closes a real one. The gate's earlier cycle rule
 * counted type imports, so this keeps that, and leaves the cycles the built-in reports to it.
 *
 * Production code only (specs are leaves). Edges are every relative `from "..."`, side-effect
 * `import "..."` and `import("...")` specifier in a file, found with a pattern over its code: a
 * specifier built at run time is not seen.
 */
import { dirname, join, normalize } from "node:path";
import type { FileMeta, Rule } from "am-i-done";

const STATIC = /^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm;
const BARE = /^[ \t]*import\s*["']([^"']+)["']/gm;
const DYNAMIC = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Comments blanked (same length), so a specifier quoted in a comment is not an edge. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\/|(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead: string | undefined) =>
    lead === undefined ? m.replace(/[^\n]/g, " ") : lead + " ".repeat(m.length - lead.length),
  );
}

function resolveRelative(from: string, specifier: string, files: ReadonlySet<string>): string | undefined {
  const base = normalize(join(dirname(from), specifier));
  const ext = EXTENSIONS.find((e) => base.endsWith(e));
  const stem = ext === undefined ? base : base.slice(0, -ext.length);
  const candidates = [
    base,
    `${stem}.ts`,
    `${stem}.tsx`,
    ...EXTENSIONS.map((e) => base + e),
    ...EXTENSIONS.map((e) => join(base, `index${e}`)),
  ];
  return candidates.find((p) => files.has(p));
}

function edgesOf(file: FileMeta, files: ReadonlySet<string>): string[] {
  const code = stripComments(file.content);
  const specifiers = [...code.matchAll(STATIC), ...code.matchAll(BARE), ...code.matchAll(DYNAMIC)].map(
    (m) => m[1] as string,
  );
  const targets = specifiers.filter((s) => s.startsWith(".")).map((s) => resolveRelative(file.relativePath, s, files));
  return [...new Set(targets.filter((t): t is string => t !== undefined))].sort();
}

/** Strongly connected components with more than one file, plus self-imports (Tarjan). */
export function cyclicFiles(edges: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out = new Map<string, string[]>();
  let next = 0;
  const visit = (v: string): void => {
    index.set(v, next);
    low.set(v, next++);
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!edges.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
    }
    if (low.get(v) !== index.get(v)) return;
    const scc: string[] = [];
    for (let w = stack.pop(); w !== undefined; w = w === v ? undefined : stack.pop()) {
      onStack.delete(w);
      scc.push(w);
    }
    const self = (edges.get(v) ?? []).includes(v);
    if (scc.length > 1 || self) for (const f of scc) out.set(f, [...scc].sort());
  };
  for (const v of [...edges.keys()].sort()) if (!index.has(v)) visit(v);
  return out;
}

const cache = new WeakMap<ReadonlyMap<string, FileMeta>, Map<string, string[]>>();

function typeCycles(files: ReadonlyMap<string, FileMeta>): Map<string, string[]> {
  const hit = cache.get(files);
  if (hit !== undefined) return hit;
  const sources = [...files.values()].filter((f) => !f.isTest && /\.(?:[cm]?tsx?|[cm]?jsx?)$/.test(f.relativePath));
  const known = new Set(sources.map((f) => f.relativePath));
  const result = cyclicFiles(new Map(sources.map((f) => [f.relativePath, edgesOf(f, known)])));
  cache.set(files, result);
  return result;
}

export default {
  id: "no-type-import-cycles",
  type: "check",
  category: "architecture",
  tests: "exclude",
  scold: "an import cycle through type imports: the modules are coupled even though the cycle never runs",
  guidance: [
    "move the shared types into a leaf module both sides import, and import nothing back from it",
    "a type that belongs to one side stays there; the other side takes it as a parameter or a generic",
    "a cycle that also runs at run time is reported by no-import-cycles instead",
  ],
  check(ctx) {
    const cycle = typeCycles(ctx.files).get(ctx.file.relativePath);
    if (cycle === undefined) return ctx.checked();
    const runtime = ctx
      .graph()
      .cycles()
      .some((c) => c.includes(ctx.file.relativePath));
    if (!runtime) ctx.violated(1, 1, `type-import cycle (${cycle.length} files): ${cycle.join(" <-> ")}`);
    return ctx.checked();
  },
} satisfies Rule;
