# Rules

`bun doing-it-wrong` checks the repository against the rules of the
[am-i-done](https://github.com/theshadow27/am-i-done#rules) package: its built-in rules plus every
`*.rule.ts` in this directory. It runs as the `rules` stage of `bun am-i-done`, so a violation
fails the gate.

```
bun doing-it-wrong              # every rule, every file
bun doing-it-wrong --list       # the catalog, by category
bun doing-it-wrong --rule ID    # one rule
bun doing-it-wrong src/server   # only these paths
```

A violation prints what is wrong and how to fix it. Read that before looking anything up here.

## What a rule is

One file, `<id>.rule.ts`, that default-exports a `Rule` from `am-i-done`. Any file with that
suffix in this directory is loaded; there is no list to add it to.

- A `pattern` rule is a global regular expression over each file's code (not its comments or
  strings, unless it sets `scope`).
- A `check` rule is a function that gets the file, every other loaded file, the file's syntax tree
  (`ast: true`, then `ctx.ast()`) and the import graph. It calls `ctx.violated(line, column,
  snippet)` for each finding and returns `ctx.checked()` or `ctx.skipped()`, so a rule that
  inspects nothing on the real tree fails instead of passing.

Every rule has a `scold` (one line: what is wrong) and `guidance` (how to fix it). By default a
rule sees every script file git does not ignore; `files` widens or narrows that (markdown, shell,
the hooks) and `tests: "only"` / `"exclude"` scopes it by spec files.

## A rule lands at zero violations

Fix the code in the same change that adds the rule. A rule that starts life with a list of
exemptions teaches everyone to add to the list.

## Fixtures

`fixtures/<id>__<scenario>.<ext>.fixture` is a small file the rule runs over on every run. A
comment line of its own in its first lines says how many violations to expect and, if the scenario
name is not the path, the path the rule should believe it has:

```ts
// @expect 1
// @path src/example.ts
```

Give a rule at least one fixture that fires and one that is clean. A rule that looks across files
gets a scenario directory, `fixtures/<id>__<scenario>/`, holding a small project.

## Suppressing a finding

```ts
// doing-it-wrong-ignore <rule-id>: <why this case is correct> (#123)
```

It applies to its own line and the two below, in any comment syntax (in markdown, inside
`<!-- -->`). `doing-it-wrong-ignore-file <rule-id>: <why> (#123)` covers a whole file. Every
suppression cites the issue that tracks it, and one that no longer suppresses anything is itself a
violation.

## Limits

Size caps are in `_config/limits.ts`. Raising one is the owner's decision.
