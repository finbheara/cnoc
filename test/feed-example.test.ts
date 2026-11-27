/**
 * The example source, examples/feed-github-issues.sh, against a stand-in `gh` on PATH. The stand-in
 * does not run the --jq program; it prints one line per issue as that program would, so what is
 * tested is the script's own checks and the arguments it gives gh.
 */
import { expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { specTempDir } from "../scripts/testkit";

const dir = specTempDir("cnoc-feed-example-");
const script = join(import.meta.dir, "..", "examples", "feed-github-issues.sh");
const calls = join(dir, "gh-calls");
writeFileSync(
  join(dir, "gh"),
  `#!/bin/sh
echo "$*" >> "${calls}"
case "$1 $2" in
  "label list") echo "$FAKE_LABEL_MATCHES" ;;
  "issue list") i=0; while [ "$i" -lt "$FAKE_ISSUES" ]; do i=$((i + 1)); echo "{\\"key\\":\\"$FEED_PROJECT-$i\\"}"; done ;;
esac
`,
);
chmodSync(join(dir, "gh"), 0o755);

async function run(args: string[], labelMatches: number, issues: number, env: Record<string, string> = {}) {
  writeFileSync(calls, "");
  const p = Bun.spawn(["sh", script, ...args], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      FAKE_LABEL_MATCHES: String(labelMatches),
      FAKE_ISSUES: String(issues),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code, gh: readFileSync(calls, "utf8").split("\n").filter(Boolean) };
}

test("lists the labelled issues oldest first, keyed by the lower-cased repository name", async () => {
  const r = await run(["example-org/MyApp", "ready", "lane"], 1, 2);
  expect(r).toMatchObject({ out: '{"key":"myapp-1"}\n{"key":"myapp-2"}\n', err: "", code: 0 });
  expect(r.gh[1]).toContain("--search sort:created-asc");
  expect(r.gh[1]).toContain("--limit 201");
  // A project given explicitly is used as given.
  expect((await run(["example-org/MyApp", "ready", "lane", "MyApp"], 1, 1)).out).toBe('{"key":"MyApp-1"}\n');
  expect(await run(["example-org/myapp", "ready", "lane"], 1, 0)).toMatchObject({ out: "", err: "", code: 0 });
});

test("a label that does not exist is an error, not an empty backlog", async () => {
  const r = await run(["example-org/myapp", "redy", "lane"], 0, 3);
  expect(r).toMatchObject({ out: "", code: 1 });
  expect(r.err).toContain('example-org/myapp has no label "redy"');
  expect(r.gh.length).toBe(1);
});

test("more issues than the limit is an error, not a quiet cut", async () => {
  expect(await run(["example-org/myapp", "ready", "lane"], 1, 3, { FEED_LIMIT: "3" })).toMatchObject({ code: 0 });
  const r = await run(["example-org/myapp", "ready", "lane"], 1, 4, { FEED_LIMIT: "3" });
  expect(r).toMatchObject({ out: "", code: 1 });
  expect(r.err).toContain('more than 3 open issues labelled "ready" in example-org/myapp; raise FEED_LIMIT');
  for (const bad of ["lots", "0", "1000"])
    expect((await run(["example-org/myapp", "ready", "lane"], 1, 1, { FEED_LIMIT: bad })).code).toBe(2);
  expect((await run(["example-org/myapp", "ready"], 1, 1)).code).toBe(2);
});
