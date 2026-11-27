import { describe, expect, test } from "bun:test";
import {
  JobfileError,
  checkTemplate,
  declaredKey,
  expand,
  fill,
  instantiate,
  isTemplate,
  keyedId,
  parseAdapter,
  parseBegin,
  parseDuration,
  parseJob,
  shellQuote,
  withId,
} from "../src/jobfile";

const job = (front: string, body: string) => `---\n${front}\n---\n${body}\n`;

describe("parseJob", () => {
  test("a minimal job", () => {
    const spec = parseJob(job("id: app/1", 'FROM app\nHARNESS claude --model opus\nPROMPT "do the thing"'));
    expect(spec).toMatchObject({
      id: "app/1",
      project: "app",
      priority: 0,
      resources: { slots: 1 },
      depends: [],
      time_s: null,
    });
    expect(spec.stages).toEqual([{ harness: "claude", args: "--model opus", prompt: "do the thing" }]);
  });

  test("front matter fields", () => {
    const spec = parseJob(
      job(
        "id: app/2\npriority: 5\nresources: { cpu: 2, claude-max: 1 }\nrequires: [linux]\ndepends: [app/1]\ntime: 1h30m\nlabels: { lane: A }",
        "FROM app\nHARNESS shell\nPROMPT true",
      ),
    );
    expect(spec.priority).toBe(5);
    expect(spec.resources).toEqual({ cpu: 2, "claude-max": 1 });
    expect(spec.requires).toEqual(["linux"]);
    expect(spec.depends).toEqual(["app/1"]);
    expect(spec.time_s).toBe(5400);
    expect(spec.labels).toEqual({ lane: "A" });
  });

  test("multiple stages, comments, continuation, heredoc and ENV", () => {
    const spec = parseJob(
      job(
        "id: app/3",
        [
          "# implement, then review",
          "FROM app",
          "ENV MODE=fast",
          "HARNESS claude",
          "PROMPT <<EOF",
          "line one",
          "line two",
          "EOF",
          "HARNESS codex \\",
          "  --careful",
          'PROMPT "review \\"it\\""',
        ].join("\n"),
      ),
    );
    expect(spec.env).toEqual({ MODE: "fast" });
    expect(spec.stages).toEqual([
      { harness: "claude", args: "", prompt: "line one\nline two" },
      { harness: "codex", args: "--careful", prompt: 'review "it"' },
    ]);
  });

  test.each([
    ["no front matter", "FROM app\nHARNESS shell\nPROMPT true", /front matter/],
    ["no id", job("priority: 1", "FROM app\nHARNESS shell\nPROMPT true"), /id is required/],
    ["bad id", job("id: 'has space'", "FROM app\nHARNESS shell\nPROMPT true"), /id is required/],
    ["unknown key", job("id: a\nprio: 1", "FROM app\nHARNESS shell\nPROMPT true"), /unknown front matter key: prio/],
    ["self dependency", job("id: a\ndepends: [a]", "FROM app\nHARNESS shell\nPROMPT true"), /depend on itself/],
    ["no FROM", job("id: a", "HARNESS shell\nPROMPT true"), /FROM <project> is required/],
    ["no PROMPT", job("id: a", "FROM app\nHARNESS shell"), /at least one PROMPT/],
    ["PROMPT before HARNESS", job("id: a", "FROM app\nPROMPT true"), /needs a HARNESS/],
    ["RUN is reserved", job("id: a", "FROM app\nRUN make\nHARNESS shell\nPROMPT true"), /RUN is reserved/],
    ["adapter verb in a job", job("id: a", 'FROM app\nTYPE "x"'), /belongs in a harness adapter/],
    [
      "negative resource",
      job("id: a\nresources: { cpu: -1 }", "FROM app\nHARNESS shell\nPROMPT true"),
      /cpu must be a number/,
    ],
  ])("rejects %s", (_name, text, pattern) => {
    expect(() => parseJob(text)).toThrow(JobfileError);
    expect(() => parseJob(text)).toThrow(pattern);
  });

  test("errors carry the line number", () => {
    expect(() => parseJob(job("id: a", "FROM app\nBOGUS x"))).toThrow(/line 5: unknown instruction: BOGUS/);
  });
});

describe("parseAdapter", () => {
  test("terminal verbs", () => {
    const a = parseAdapter(
      'REQUIRE claude\nTMUX claude ${ARGS}\nEXPECT "❯" TIMEOUT 30\nTYPE "${PROMPT}" Enter\nSLEEP 0.5\nSTOP TYPE "/exit" Enter',
    );
    expect(a.requires).toEqual(["claude"]);
    expect(a.steps).toEqual([
      { op: "tmux", cmd: "claude ${ARGS}" },
      { op: "expect", pattern: "❯", timeout_s: 30 },
      { op: "type", keys: [{ text: "${PROMPT}" }, { key: "Enter" }] },
      { op: "sleep", s: 0.5 },
    ]);
    expect(a.stop).toEqual([{ op: "type", keys: [{ text: "/exit" }, { key: "Enter" }] }]);
  });

  test("must start with TMUX", () => {
    expect(() => parseAdapter('TYPE "x"')).toThrow(/must start its session with TMUX/);
  });

  test("rejects a bad EXPECT pattern", () => {
    expect(() => parseAdapter('TMUX sh\nEXPECT "("')).toThrow(/not a valid regular expression/);
  });
});

test("parseDuration", () => {
  expect(parseDuration("90s")).toBe(90);
  expect(parseDuration("2h")).toBe(7200);
  expect(parseDuration("1d2h3m4s")).toBe(93784);
  expect(parseDuration(45)).toBe(45);
  expect(() => parseDuration("soon")).toThrow();
  expect(() => parseDuration("")).toThrow();
});

test("expand quotes only what it is told to and leaves shell variables alone", () => {
  const out = expand("run ${ARGS} ${PROMPT} ${HOME} $?", { ARGS: "-x", PROMPT: "it's here" }, (n, v) =>
    n === "PROMPT" ? shellQuote(v) : v,
  );
  expect(out).toBe("run -x 'it'\\''s here' ${HOME} $?");
});

// ---- templates and begin ------------------------------------------------------

const TEMPLATE = `---
id: maint/cleanup
resources: { slots: \${SLOTS} }
---
ARG PROJECT
ARG SLOTS=1
ARG HOURS="12"
FROM \${PROJECT}
HARNESS shell
PROMPT <<END
echo "older than \${HOURS}h in \${PWD} for \${USER}"
END
`;

describe("templates", () => {
  test("checkTemplate reports the name and arguments", () => {
    expect(checkTemplate(TEMPLATE)).toEqual({
      name: "maint/cleanup",
      args: [
        { name: "PROJECT", default: null },
        { name: "SLOTS", default: "1" },
        { name: "HOURS", default: "12" },
      ],
    });
  });

  test("instantiate fills declared arguments only, renames the job and keeps line numbers", () => {
    const text = instantiate(TEMPLATE, { PROJECT: "app", HOURS: "6" }, "maint/cleanup/3");
    expect(text.split("\n").length).toBe(TEMPLATE.split("\n").length);
    const spec = parseJob(text);
    expect(spec).toMatchObject({ id: "maint/cleanup/3", project: "app", resources: { slots: 1 } });
    // PWD and USER are not arguments, so they are left for the shell.
    expect(spec.stages[0]?.prompt).toBe('echo "older than 6h in ${PWD} for ${USER}"');
  });

  test("a missing or unknown argument is refused", () => {
    expect(() => instantiate(TEMPLATE, {})).toThrow(/PROJECT has no default/);
    expect(() => instantiate(TEMPLATE, { PROJECT: "app", NOPE: "1" })).toThrow(
      /unknown argument NOPE; this template takes: PROJECT, SLOTS, HOURS/,
    );
    expect(() => instantiate(TEMPLATE, { PROJECT: "a\nb" })).toThrow(/single line/);
  });

  test("a Jobfile with no ARG is a valid template, and ARG is refused in a plain job", () => {
    const plain = "---\nid: a\n---\nFROM app\nHARNESS shell\nPROMPT true\n";
    expect(checkTemplate(plain)).toEqual({ name: "a", args: [] });
    expect(() => parseJob(TEMPLATE)).toThrow(/line 5: ARG makes this a template/);
  });

  test("bad templates are refused when added", () => {
    expect(() => checkTemplate(TEMPLATE.replace("ARG SLOTS=1", "ARG slots=1"))).toThrow(/line 6: ARG takes NAME/);
    expect(() => checkTemplate(TEMPLATE.replace("ARG SLOTS=1", "ARG PROJECT=x"))).toThrow(/declared twice/);
    expect(() => checkTemplate(TEMPLATE.replace("id: maint/cleanup", "id: maint/${PROJECT}"))).toThrow(
      /cannot contain an argument/,
    );
    expect(() => checkTemplate(TEMPLATE.replace("HARNESS shell\n", ""))).toThrow(/PROMPT needs a HARNESS/);
  });
});

describe("template keys", () => {
  const KEYED = TEMPLATE.replace("id: maint/cleanup\n", "id: maint/cleanup\nkey: ${PROJECT}-${HOURS}\n");
  test("a declared key is filled from the arguments and removed from the job", () => {
    const set = { PROJECT: "myapp", HOURS: "007" };
    const key = declaredKey(KEYED, set);
    expect(key).toBe("myapp-007");
    const f = fill(KEYED, set);
    expect(f.text.split("\n").length).toBe(KEYED.split("\n").length);
    expect(f.text).not.toContain("key:");
    expect(parseJob(withId(f.text, keyedId("maint/cleanup", key ?? ""))).id).toBe("maint/cleanup/myapp-007");
    expect(declaredKey(KEYED.replace("${PROJECT}-${HOURS}", "0x7"), set)).toBe("0x7");
    expect(declaredKey(KEYED.replace("key: ${PROJECT}-${HOURS}", 'key: "a/${PROJECT}"'), { PROJECT: "b" })).toBe("a/b");
    expect(checkTemplate(KEYED).name).toBe("maint/cleanup");
  });

  test("a key may contain slashes but must make a valid id", () => {
    expect(keyedId("lane", "myapp/1234")).toBe("lane/myapp/1234");
    expect(keyedId("lane", "#12")).toBe("lane/#12");
    for (const bad of ["", "a b", "a//b", "/a", "a/", "x".repeat(200)])
      expect(() => keyedId("lane", bad)).toThrow(/is not a valid id segment/);
    // All-digit ids are the numbered runs, so a key cannot be one.
    for (const bad of ["1", "0042"]) expect(() => keyedId("lane", bad)).toThrow(/all digits/);
    for (const ok of ["4/x", "007x", "issue-4", "myapp/4"]) expect(keyedId("lane", ok)).toBe(`lane/${ok}`);
    for (const bad of [".", "..", "a/./b", "a/.."]) expect(() => keyedId("lane", bad)).toThrow(/\. or \.\. segment/);
    expect(keyedId("lane", "a.b/.c")).toBe("lane/a.b/.c");
  });

  test("the declared key fills only its own line, and a trailing comment is dropped", () => {
    const k = (line: string) => KEYED.replace("key: ${PROJECT}-${HOURS}", line);
    expect(declaredKey(k("key: ${PROJECT}-${HOURS} # one per project"), { PROJECT: "p" })).toBe("p-12");
    expect(declaredKey(k("key: issue#4"), {})).toBe("issue#4");
    expect(declaredKey(k('key: "a #b" # c'), {})).toBe("a #b");
    // Names the key does not use, known or not, do not matter; ones it uses must have a value.
    expect(declaredKey(k("key: ${HOURS}h"), { NOPE: "1" })).toBe("12h");
    expect(() => declaredKey(k("key: ${PROJECT}"), {})).toThrow(/PROJECT has no default/);
    expect(declaredKey(TEMPLATE, {})).toBeNull();
    // A comment or a quote inside an argument's value is part of the key, never the end of it.
    expect(declaredKey(k("key: i-${PROJECT}"), { PROJECT: "7 #x" })).toBe("i-7 #x");
    expect(declaredKey(k('key: "i-${PROJECT}" # c'), { PROJECT: '7" #x' })).toBe('i-7" #x');
    expect(() => keyedId("dk", "i-7 #x")).toThrow(/not a valid id segment/);
  });

  test("a bad key is caught when the template is checked", () => {
    expect(() => checkTemplate(KEYED.replace("${PROJECT}-${HOURS}", "two words"))).toThrow(/not a valid id segment/);
    expect(() => checkTemplate(KEYED.replace("${PROJECT}-${HOURS}", ""))).toThrow(/line 3: key is empty/);
    expect(() => checkTemplate(KEYED.replace("${PROJECT}-${HOURS}", "[1, 2]"))).toThrow(/not a valid id segment/);
  });

  test("a key of one bare argument without a default passes the check; a run that makes it all digits is refused", () => {
    const bare = "---\nid: lane\nkey: ${ISSUE}\n---\nARG ISSUE\nFROM app\nHARNESS shell\nPROMPT echo ${ISSUE}\n";
    expect(checkTemplate(bare)).toEqual({ name: "lane", args: [{ name: "ISSUE", default: null }] });
    expect(checkTemplate(bare.replace("key: ${ISSUE}", "key: ${ISSUE}/${ISSUE}")).name).toBe("lane");
  });

  test("a key error found by the check names the template's text, not the stand-in", () => {
    const k = (key: string, arg = "ARG ISSUE") =>
      `---\nid: lane\nkey: ${key}\n---\n${arg}\nFROM app\nHARNESS shell\nPROMPT true\n`;
    expect(() => checkTemplate(k("${ISSUE}/.."))).toThrow('line 3: key "${ISSUE}/.." has a . or .. segment');
    expect(() => checkTemplate(k("a ${ISSUE}"))).toThrow('line 3: key "a ${ISSUE}" is not a valid id segment');
    // A default that makes the key all digits is caught, with the fix.
    expect(() => checkTemplate(k("${ISSUE}", "ARG ISSUE=12"))).toThrow(
      'line 3: key "${ISSUE}" is all digits, which are the numbers of unkeyed runs; prefix the key in template lane, as in key: run-${ISSUE}',
    );
  });

  test("key is legal only in a template", () => {
    const plain = "---\nid: a\nkey: b\n---\nFROM app\nHARNESS shell\nPROMPT true\n";
    expect(() => parseJob(plain)).toThrow(/key belongs in a template/);
    expect(isTemplate(plain)).toBe(true);
    expect(checkTemplate(plain)).toEqual({ name: "a", args: [] });
    expect(isTemplate("---\nid: a\nlabels: { key: b }\n---\nFROM app\n")).toBe(false);
    expect(isTemplate(TEMPLATE)).toBe(true);
    // A quoted key is a key too, so checking it as a template finds it.
    const quoted = plain.replace("key: b", '"key": b');
    expect(isTemplate(quoted)).toBe(true);
    expect(checkTemplate(quoted)).toEqual({ name: "a", args: [] });
    expect(declaredKey(quoted, {})).toBe("b");
    expect(fill(quoted, {}).text).not.toContain("key");
  });
});

describe("begin", () => {
  const withBegin = (v: string) => `---\nid: a\nbegin: ${v}\n---\nFROM app\nHARNESS shell\nPROMPT true\n`;
  test("an absolute time needs a zone", () => {
    expect(parseJob(withBegin("2027-01-31T03:00:00Z")).begin_at).toBe(Date.UTC(2027, 0, 31, 3));
    expect(parseJob(withBegin("2027-01-31T03:00:00-05:00")).begin_at).toBe(Date.UTC(2027, 0, 31, 8));
    expect(() => parseJob(withBegin("2027-01-31T03:00:00"))).toThrow(/time with a zone/);
    expect(() => parseJob(withBegin("tomorrow"))).toThrow(/time with a zone/);
  });
  test("a delay counts from submission", () => {
    expect(parseJob(withBegin("+90m"), 1_000_000).begin_at).toBe(1_000_000 + 90 * 60_000);
    expect(parseBegin("+2h", 0)).toBe(7_200_000);
    expect(parseJob("---\nid: a\n---\nFROM app\nHARNESS shell\nPROMPT true\n").begin_at).toBeNull();
  });
});
