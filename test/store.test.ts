import { beforeEach, expect, test } from "bun:test";
import { Store, SubmitError } from "../src/server/store";

const J = (id: string, depends: string[] = []) =>
  `---\nid: ${id}\ndepends: [${depends.join(", ")}]\n---\nFROM app\nHARNESS shell\nPROMPT true\n`;
let s: Store;
beforeEach(() => {
  s = new Store(":memory:");
  s.enroll("h", "key", true);
});
const run = (job: string, outcome: "done" | "failed" = "done") => {
  const a = s.assign(job, "h");
  s.started(a.id, "h");
  s.ended({ attempt: a.id, outcome, reason: null, results: [] }, "h");
};

test("a batch submits atomically and resolves dependencies inside it", () => {
  const out = s.submit([J("b", ["a"]), J("a")], "t");
  expect(out).toEqual([
    { id: "b", state: "blocked", created: true },
    { id: "a", state: "queued", created: true },
  ]);
});

test("resubmitting the same content is a no-op; different content is refused", () => {
  s.submit([J("a")], "t");
  const before = s.seq();
  expect(s.submit([J("a")], "t")).toEqual([{ id: "a", state: "queued", created: false }]);
  expect(s.seq()).toBe(before);
  expect(() => s.submit([J("a", []).replace("true", "false")], "t")).toThrow(/different content/);
});

test("unknown dependencies and cycles are refused, and nothing is stored", () => {
  expect(() => s.submit([J("a", ["ghost"])], "t")).toThrow(/unknown job ghost/);
  expect(() => s.submit([J("a", ["b"]), J("b", ["c"]), J("c", ["a"])], "t")).toThrow(/cycle/);
  expect(() => s.submit([J("a"), "not a job"], "t")).toThrow(SubmitError);
  expect(s.jobs()).toEqual([]);
});

test("a dependent becomes ready only when its dependency is done", () => {
  s.submit([J("a"), J("b", ["a"]), J("c", ["a", "b"])], "t");
  run("a");
  expect(s.job("b")?.state).toBe("queued");
  expect(s.job("c")?.state).toBe("blocked");
  run("b");
  expect(s.job("c")?.state).toBe("queued");
  expect(
    s
      .events(0)
      .filter((e) => e.type === "job.ready")
      .map((e) => e.job),
  ).toEqual(["b", "c"]);
});

test("a failed dependency leaves the dependent unstartable until a requeue succeeds", () => {
  s.submit([J("a"), J("b", ["a"])], "t");
  run("a", "failed");
  expect(s.job("b")).toMatchObject({ state: "blocked", reason: "dependency-not-done: a" });
  expect(s.requeue("a", "t").state).toBe("queued");
  run("a");
  expect(s.job("b")).toMatchObject({ state: "queued", reason: null });
});

test("cancel before start is immediate; cancel after start only asks", () => {
  s.submit([J("a"), J("b")], "t");
  expect(s.cancel("a", "t").job.state).toBe("cancelled");
  const att = s.assign("b", "h");
  s.started(att.id, "h");
  const r = s.cancel("b", "t");
  expect(r.job).toMatchObject({ state: "running", cancel_requested: true });
  expect(r.attempt?.id).toBe(att.id);
});

test("an attempt given back while the host was away is adopted if the job is still free", () => {
  s.submit([J("a")], "t");
  const att = s.assign("a", "h");
  s.giveBack(att.id, "host-disconnected");
  expect(s.job("a")?.state).toBe("queued");
  expect(s.started(att.id, "h")).toBe("ok");
  expect(s.job("a")?.state).toBe("running");
});

test("a late report for a job that moved on is ignored", () => {
  s.enroll("h2", "key2", true);
  s.submit([J("a")], "t");
  const first = s.assign("a", "h");
  s.giveBack(first.id, "host-disconnected");
  const second = s.assign("a", "h2");
  expect(s.started(first.id, "h")).toBe("stale");
  expect(s.ended({ attempt: first.id, outcome: "done", reason: null, results: [] }, "h")).toBe("stale");
  expect(s.job("a")?.state).toBe("assigned");
  expect(s.openAttempt("a")?.id).toBe(second.id);
});

test("only the host that owns an attempt can report on it", () => {
  s.submit([J("a")], "t");
  const att = s.assign("a", "h");
  expect(s.started(att.id, "intruder")).toBe("stale");
});

test("every mutation advances the changelog in order", () => {
  s.submit([J("a")], "t");
  run("a");
  const ev = s.events(0);
  expect(ev.map((e) => e.seq)).toEqual(ev.map((_, i) => i + 1));
  expect(ev.map((e) => e.type)).toEqual([
    "host.approved",
    "job.submitted",
    "attempt.assigned",
    "attempt.started",
    "attempt.ended",
    "job.terminal",
  ]);
  expect(s.events(4).map((e) => e.type)).toEqual(["attempt.ended", "job.terminal"]);
});

// ---- overrides, priority, templates --------------------------------------------

const T = (name: string, body = "PROMPT true") =>
  `---\nid: ${name}\n---\nARG PROJECT\nARG NOTE=hi\nFROM \${PROJECT}\nHARNESS shell\n${body}\n`;

test("overrides pin a host, set priority and delay the start", () => {
  s.submit([J("a")], "t", { on: "h", priority: 7, begin: "+1h" });
  const spec = s.job("a")?.spec;
  expect(spec?.requires).toEqual(["host/h"]);
  expect(spec?.priority).toBe(7);
  expect(spec?.begin_at).toBeGreaterThan(Date.now() + 3_590_000);
  expect(() => s.submit([J("b")], "t", { on: "nowhere" })).toThrow(/no such host: nowhere/);
  expect(() => s.submit([J("b")], "t", { begin: "noon" })).toThrow(/time with a zone/);
  expect(s.job("b")).toBeNull();
});

test("priority can change until a job is dispatched", () => {
  s.submit([J("a"), J("b", ["a"])], "t");
  expect(s.setPriority("b", 5, "t").spec.priority).toBe(5);
  expect(
    s
      .events(0)
      .filter((e) => e.type === "job.priority")
      .map((e) => e.data),
  ).toEqual([{ from: 0, to: 5 }]);
  s.assign("a", "h");
  expect(() => s.setPriority("a", 9, "t")).toThrow(/only a job that has not been dispatched/);
  expect(() => s.setPriority("nope", 1, "t")).toThrow(/no such job/);
  expect(() => s.setPriority("b", 1.5, "t")).toThrow(/integer/);
});

test("a template is added once, updated in place and found by number, name or file", () => {
  const first = s.templateAdd(T("clean"), "/repo/templates/clean.job", "t");
  expect(first.result).toBe("added");
  expect(first.template.args).toEqual([
    { name: "PROJECT", default: null },
    { name: "NOTE", default: "hi" },
  ]);
  expect(s.templateAdd(T("clean"), "/repo/templates/clean.job", "t").result).toBe("unchanged");
  const second = s.templateAdd(T("clean", "PROMPT false"), "/repo/templates/clean.job", "t");
  expect(second).toMatchObject({ result: "updated", template: { id: first.template.id } });
  for (const ref of [String(first.template.id), "clean", "/repo/templates/clean.job"])
    expect(s.template(ref)?.name).toBe("clean");
  expect(s.template("templates/clean.job", "/repo/templates/clean.job")?.name).toBe("clean");
  expect(s.template("other")).toBeNull();
  expect(() => s.templateAdd("---\nid: x\n---\nARG lower\nFROM a\nHARNESS shell\nPROMPT true\n", null, "t")).toThrow(
    /ARG takes NAME/,
  );
});

test("running a template submits a numbered job each time", () => {
  s.templateAdd(T("clean", 'PROMPT "echo ${NOTE}"'), null, "t");
  const one = s.templateRun("clean", { PROJECT: "app" }, { on: "h" }, "t");
  const two = s.templateRun("1", { PROJECT: "app", NOTE: "again" }, {}, "t");
  expect([one.job, two.job]).toEqual(["clean/1", "clean/2"]);
  expect(s.job("clean/1")?.spec).toMatchObject({
    project: "app",
    requires: ["host/h"],
    labels: { template: "clean" },
    stages: [{ prompt: "echo hi" }],
  });
  expect(s.job("clean/2")?.spec.stages[0]?.prompt).toBe("echo again");
  expect(two.template).toMatchObject({ runs: 2, last_job: "clean/2" });
  expect(() => s.templateRun("clean", {}, {}, "t")).toThrow(/PROJECT has no default/);
  expect(() => s.templateRun("clean", { PROJECT: "app", X: "1" }, {}, "t")).toThrow(/unknown argument X/);
  expect(() => s.templateRun("gone", {}, {}, "t")).toThrow(/no such template/);
  // A failed run takes no number and leaves no job behind.
  expect(s.templateRun("clean", { PROJECT: "app" }, {}, "t").job).toBe("clean/3");
});

test("a removed and re-added template does not reuse job ids", () => {
  s.templateAdd(T("clean"), "/repo/clean.job", "t");
  s.templateRun("clean", { PROJECT: "app" }, {}, "t");
  expect(s.templateRemove("clean.job", "/repo/clean.job", "t").name).toBe("clean");
  expect(s.templates()).toEqual([]);
  expect(() => s.templateRemove("clean", undefined, "t")).toThrow(/no such template/);
  const again = s.templateAdd(T("clean"), null, "t");
  expect(again.template.id).toBe(2);
  expect(s.templateRun("clean", { PROJECT: "app" }, {}, "t").job).toBe("clean/2");
  expect(
    s
      .events(0)
      .map((e) => e.type)
      .filter((t) => t.startsWith("template.")),
  ).toEqual(["template.added", "template.run", "template.removed", "template.added", "template.run"]);
});

test("a keyed run is named by its key, and running it again changes nothing", () => {
  s.templateAdd(T("lane"), null, "t");
  const first = s.templateRun("lane", { PROJECT: "app" }, {}, "t", { key: "myapp/1234" });
  expect(first).toMatchObject({ job: "lane/myapp/1234", created: true, template: { runs: 1 } });
  // Different arguments, a changed template, a failed job: all the same run.
  s.templateAdd(T("lane", "PROMPT false"), null, "t");
  expect(s.templateRun("lane", { PROJECT: "other" }, {}, "t", { key: "myapp/1234" })).toMatchObject({
    job: "lane/myapp/1234",
    created: false,
  });
  run("lane/myapp/1234", "failed");
  const failed = s.seq();
  expect(s.templateRun("lane", {}, {}, "t", { key: "myapp/1234", keyed: true }).created).toBe(false);
  expect(s.job("lane/myapp/1234")?.state).toBe("failed");
  expect(s.seq()).toBe(failed);
  expect(s.template("lane")?.runs).toBe(1);
  expect(s.events(0).flatMap((e) => (e.type === "template.run" ? [e.data] : []))).toEqual([
    { template: 1, name: "lane", set: { PROJECT: "app" }, key: "myapp/1234" },
  ]);
  expect(() => s.templateRun("lane", { PROJECT: "app" }, {}, "t", { key: "a b" })).toThrow(/not a valid id segment/);
});

test("a declared key finds its run even after the template's arguments change", () => {
  const keyed = (extra = "") =>
    T("lane")
      .replace("id: lane\n", "id: lane\nkey: ${PROJECT}-${NOTE} # one per project\n")
      .replace("ARG NOTE=hi\n", extra);
  s.templateAdd(keyed("ARG NOTE=hi\n"), null, "t");
  expect(s.templateRun("lane", { PROJECT: "app" }, {}, "t").job).toBe("lane/app-hi");
  run("lane/app-hi", "failed");
  const failed = s.seq();
  // The template gains a required argument the feeder does not send yet.
  s.templateAdd(keyed("ARG NOTE=hi\nARG NEW\n"), null, "t");
  expect(s.templateRun("lane", { PROJECT: "app" }, {}, "t", { keyed: true })).toMatchObject({
    job: "lane/app-hi",
    created: false,
  });
  // It drops one the feeder still sends, and its default moves into the key line.
  s.templateAdd(keyed().replace("${NOTE}", "hi"), null, "t");
  expect(s.templateRun("lane", { PROJECT: "app", NOTE: "hi" }, {}, "t").created).toBe(false);
  expect(s.seq()).toBe(failed + 2); // the two template.updated events, nothing else
  expect(s.job("lane/app-hi")?.state).toBe("failed");
  // A new key still fills the whole template, so its errors still show.
  expect(() => s.templateRun("lane", { PROJECT: "other", NOTE: "hi" }, {}, "t")).toThrow(/unknown argument NOTE/);
});

test("a template can declare its key, and a key given with the run overrides it", () => {
  s.templateAdd(T("lane").replace("id: lane\n", "id: lane\nkey: ${PROJECT}-${NOTE}\n"), null, "t");
  expect(s.templateRun("lane", { PROJECT: "app" }, {}, "t").job).toBe("lane/app-hi");
  expect(s.templateRun("lane", { PROJECT: "app" }, {}, "t", { keyed: true }).created).toBe(false);
  expect(s.templateRun("lane", { PROJECT: "app", NOTE: "x" }, {}, "t").job).toBe("lane/app-x");
  expect(s.templateRun("lane", { PROJECT: "app" }, {}, "t", { key: "mine" }).job).toBe("lane/mine");
  expect(s.job("lane/app-hi")?.spec.labels).toEqual({ template: "lane" });
  expect(() => s.templateRun("lane", { PROJECT: "a b" }, {}, "t")).toThrow(/key "a b-hi" is not a valid id segment/);
  expect(() => s.templateRun("lane", {}, {}, "t")).toThrow(/PROJECT has no default/);
});

test("a key in an argument's value cannot be cut short by a comment", () => {
  s.templateAdd(T("dk").replace("id: dk\n", "id: dk\nkey: i-${PROJECT} # one per issue\n"), null, "t");
  expect(s.templateRun("dk", { PROJECT: "7" }, {}, "t").job).toBe("dk/i-7");
  for (const PROJECT of ["7 #x", "5 #x"])
    expect(() => s.templateRun("dk", { PROJECT }, {}, "t")).toThrow(/not a valid id segment/);
  expect(s.jobs().map((j) => j.id)).toEqual(["dk/i-7"]);
});

test("a key given with the run means the template's own key is not read", () => {
  s.templateAdd(T("lane").replace("id: lane\n", "id: lane\nkey: ${NOTE}\n"), null, "t");
  expect(() => s.templateRun("lane", { PROJECT: "app", NOTE: "" }, {}, "t")).toThrow(/key is empty/);
  expect(s.templateRun("lane", { PROJECT: "app", NOTE: "" }, {}, "t", { key: "mine" })).toMatchObject({
    job: "lane/mine",
    created: true,
  });
});

test("keyed refuses a run with no key; a key is never a run number", () => {
  s.templateAdd(T("lane"), null, "t");
  expect(() => s.templateRun("lane", {}, {}, "t", { keyed: true })).toThrow(SubmitError);
  expect(() => s.templateRun("lane", {}, {}, "t", { keyed: true })).toThrow(/this run has no key/);
  expect(s.jobs()).toEqual([]);
  expect(s.templateRun("lane", { PROJECT: "app" }, {}, "t").job).toBe("lane/1");
  expect(() => s.templateRun("lane", { PROJECT: "app" }, {}, "t", { key: "1" })).toThrow(/all digits/);
  for (const key of ["4/x", "007x", "issue-4", "myapp/4"])
    expect(s.templateRun("lane", { PROJECT: "app" }, {}, "t", { key }).created).toBe(true);
  // The counter skips an id that exists, whoever made it.
  s.submit([J("lane/2")], "t");
  expect(s.templateRun("lane", { PROJECT: "app" }, {}, "t").job).toBe("lane/3");
});

test("a keyed run does not adopt a job that this template did not start", () => {
  s.templateAdd(T("lane"), null, "t");
  s.submit([J("lane/plain")], "t");
  expect(() => s.templateRun("lane", { PROJECT: "app" }, {}, "t", { key: "plain" })).toThrow(
    /job lane\/plain exists and was not started by template lane/,
  );
  s.templateAdd(T("lane/b"), null, "t");
  expect(s.templateRun("lane/b", { PROJECT: "app" }, {}, "t").job).toBe("lane/b/1");
  let thrown = false;
  try {
    s.templateRun("lane", { PROJECT: "app" }, {}, "t", { key: "b/1" });
  } catch (e) {
    thrown = true;
    expect(e).toMatchObject({ status: 409, message: "job lane/b/1 exists and was not started by template lane" });
  }
  expect(thrown).toBe(true);
});
