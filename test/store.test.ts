import { beforeEach, expect, test } from "bun:test";
import { Store, SubmitError } from "../src/server/store";

const J = (id: string, depends: string[] = []) => `---\nid: ${id}\ndepends: [${depends.join(", ")}]\n---\nFROM app\nHARNESS shell\nPROMPT true\n`;
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
  expect(s.events(0).filter((e) => e.type === "job.ready").map((e) => e.job)).toEqual(["b", "c"]);
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
  expect(ev.map((e) => e.type)).toEqual(["host.approved", "job.submitted", "attempt.assigned", "attempt.started", "attempt.ended", "job.terminal"]);
  expect(s.events(4).map((e) => e.type)).toEqual(["attempt.ended", "job.terminal"]);
});

// ---- overrides, priority, templates --------------------------------------------

const T = (name: string, body = "PROMPT true") => `---\nid: ${name}\n---\nARG PROJECT\nARG NOTE=hi\nFROM \${PROJECT}\nHARNESS shell\n${body}\n`;

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
  expect(s.events(0).filter((e) => e.type === "job.priority").map((e) => e.data)).toEqual([{ from: 0, to: 5 }]);
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
  for (const ref of [String(first.template.id), "clean", "/repo/templates/clean.job"]) expect(s.template(ref)?.name).toBe("clean");
  expect(s.template("templates/clean.job", "/repo/templates/clean.job")?.name).toBe("clean");
  expect(s.template("other")).toBeNull();
  expect(() => s.templateAdd("---\nid: x\n---\nARG lower\nFROM a\nHARNESS shell\nPROMPT true\n", null, "t")).toThrow(/ARG takes NAME/);
});

test("running a template submits a numbered job each time", () => {
  s.templateAdd(T("clean", 'PROMPT "echo ${NOTE}"'), null, "t");
  const one = s.templateRun("clean", { PROJECT: "app" }, { on: "h" }, "t");
  const two = s.templateRun("1", { PROJECT: "app", NOTE: "again" }, {}, "t");
  expect([one.job, two.job]).toEqual(["clean/1", "clean/2"]);
  expect(s.job("clean/1")?.spec).toMatchObject({ project: "app", requires: ["host/h"], labels: { template: "clean" }, stages: [{ prompt: "echo hi" }] });
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
  expect(s.events(0).map((e) => e.type).filter((t) => t.startsWith("template."))).toEqual([
    "template.added",
    "template.run",
    "template.removed",
    "template.added",
    "template.run",
  ]);
});
