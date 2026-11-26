import { expect, test } from "bun:test";
import { type HostView, type QueuedJob, type SchedContext, defaultPolicy, schedule } from "../src/server/scheduler";

const NOW = 1_000_000_000;
const host = (name: string, over: Partial<HostView> = {}): HostView => ({
  name,
  online: true,
  drained: false,
  capacity: { slots: 2 },
  reserved: {},
  features: ["project/app", "harness/shell"],
  measured: null,
  ...over,
});
const job = (id: string, over: Partial<QueuedJob> = {}): QueuedJob => ({
  id,
  priority: 0,
  submitted_at: NOW,
  resources: { slots: 1 },
  features: ["project/app", "harness/shell"],
  ...over,
});
const ctx = (over: Partial<SchedContext> = {}): SchedContext => ({ now: NOW, pools: {}, backedOff: () => false, starve_after_s: 600, ...over });

test("priority first, then age", () => {
  const p = schedule(
    [job("old", { submitted_at: NOW - 5000 }), job("new", { submitted_at: NOW - 1000 }), job("urgent", { priority: 9 })],
    [host("a", { capacity: { slots: 1 } })],
    ctx(),
  );
  expect(p.assignments).toEqual([{ job: "urgent", host: "a" }]);
  expect(p.pending).toEqual({ old: "resources", new: "resources" });
});

test("a job lands only on a host with its features", () => {
  const p = schedule([job("j", { features: ["project/data"] })], [host("a"), host("b", { features: ["project/data"] })], ctx());
  expect(p.assignments).toEqual([{ job: "j", host: "b" }]);
});

test("no host has the feature", () => {
  expect(schedule([job("j", { features: ["project/nope"] })], [host("a")], ctx()).pending).toEqual({ j: "no-eligible-host" });
});

test("offline and drained hosts get nothing", () => {
  const p = schedule([job("j")], [host("a", { online: false }), host("b", { drained: true })], ctx());
  expect(p.pending).toEqual({ j: "no-eligible-host" });
});

test("capacity is respected within one pass and spreads across hosts", () => {
  const p = schedule([job("1"), job("2"), job("3"), job("4"), job("5")], [host("a"), host("b")], ctx());
  expect(p.assignments.length).toBe(4);
  expect(p.assignments.filter((x) => x.host === "a").length).toBe(2);
  expect(p.assignments.filter((x) => x.host === "b").length).toBe(2);
  expect(p.pending).toEqual({ "5": "resources" });
});

test("a resource the host does not declare cannot be requested from it", () => {
  expect(schedule([job("j", { resources: { gpu: 1 } })], [host("a")], ctx()).pending).toEqual({ j: "no-eligible-host" });
});

test("a fleet pool caps jobs across hosts", () => {
  const jobs = [1, 2, 3].map((n) => job(`j${n}`, { resources: { slots: 1, acct: 1 } }));
  const p = schedule(jobs, [host("a"), host("b")], ctx({ pools: { acct: { total: 2, used: 0 } } }));
  expect(p.assignments.length).toBe(2);
  expect(p.pending).toEqual({ j3: "resources" });
});

test("a recent decline keeps the job off that host", () => {
  const p = schedule([job("j")], [host("a"), host("b")], ctx({ backedOff: (_j, h) => h === "a" }));
  expect(p.assignments).toEqual([{ job: "j", host: "b" }]);
});

test("a starving big job holds back smaller jobs that want the same resource", () => {
  const big = job("big", { priority: 1, resources: { slots: 2 }, submitted_at: NOW - 700_000 });
  const hosts = [host("a", { reserved: { slots: 1 } })];
  expect(schedule([big, job("small")], hosts, ctx()).pending).toEqual({ big: "resources", small: "held-back" });
  // Before the starvation age the small job is allowed past.
  const young = { ...big, submitted_at: NOW - 1000 };
  expect(schedule([young, job("small")], hosts, ctx()).assignments).toEqual([{ job: "small", host: "a" }]);
});

test("a job no host could ever fit does not hold others back", () => {
  const huge = job("huge", { priority: 1, resources: { slots: 99 }, submitted_at: NOW - 700_000 });
  const p = schedule([huge, job("small")], [host("a")], ctx());
  expect(p.pending).toEqual({ huge: "no-eligible-host" });
  expect(p.assignments).toEqual([{ job: "small", host: "a" }]);
});

test("a custom policy can reorder and rescore", () => {
  const p = schedule([job("x"), job("y")], [host("a", { capacity: { slots: 1 } }), host("b", { capacity: { slots: 1 } })], ctx(), {
    ...defaultPolicy,
    order: (jobs) => [...jobs].reverse(),
    score: (_j, h) => (h.name === "b" ? 1 : 0),
  });
  expect(p.assignments).toEqual([
    { job: "y", host: "b" },
    { job: "x", host: "a" },
  ]);
});
