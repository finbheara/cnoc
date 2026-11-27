# Rules

`bun doing-it-wrong` checks the repository against the rules in this directory. It runs as a step
of `bun am-i-done`, so a violation fails the gate.

```
bun doing-it-wrong              # every rule, every file
bun doing-it-wrong --list       # the catalog, one line per rule
bun doing-it-wrong --rule ID    # one rule
bun doing-it-wrong --filter src/server   # files whose path contains this
bun doing-it-wrong --all        # every violation, no per-rule cap
```

A violation prints what is wrong and how to fix it. Read that before looking anything up here.

## What a rule is

One file, `<id>.rule.ts`, with a default export. Any file with that suffix in this directory is
loaded; there is no list to add it to.

- A `pattern` rule is a regular expression run over each line.
- A `check` rule is a function that gets the file, every other loaded file and a lazily parsed
  TypeScript AST. It calls `violated(line, column, snippet)` for each finding and `checked()` when
  it has done real inspection, so a rule that silently matches nothing shows up.

Every rule has a `scold` (one line: what is wrong) and `guidance` (how to fix it). By default a
rule sees TypeScript under `src/`, `scripts/` and `test/`. `appliesToTests` narrows it to test
files or to everything else; `appliesToFile` lets it see the markdown, shell scripts and hooks
the loader also reads.

## A rule lands at zero violations

Fix the code in the same change that adds the rule. A rule that starts life with a list of
exemptions teaches everyone to add to the list.

## Fixtures

`fixtures/<id>__<scenario>.fixture.ts` is a small file with a header saying which rule it is for,
how many violations to expect and the path the rule should believe it has:

```ts
/**
 * @rule no-as-any
 * @expect 1
 * @path src/example.ts
 */
```

`fixtures.spec.ts` runs every fixture against its rule. Give a rule at least one fixture that is
flagged and one that is clean. Markdown and shell fixtures use `#fixture @rule ...` lines instead.

## Suppressing a finding

```ts
// dotw-ignore <rule-id>: <why this case is correct>
// dotw-todo <rule-id>: <what is wrong> - fix in #123
```

The comment goes on the line or the line above. `dotw-ignore` is permanent and needs a reason a
reviewer would accept. `dotw-todo` is temporary and must name a real issue number; the
`dotw-todo-needs-issue` rule refuses one without.

## Limits

Size caps are in `_config/limits.ts`. Raising one is the owner's decision.
