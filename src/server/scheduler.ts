/**
 * Placement. A pure function over a snapshot, so a policy can be tested without a server.
 *
 * The shape follows the Kubernetes scheduler: order the queue, filter hosts that can run
 * a job, score the survivors. Nothing is ever evicted; a job that has started finishes.
 */
import type { Measured, Resources } from "../protocol";

export interface QueuedJob {
  id: string;
  priority: number;
  submitted_at: number;
  resources: Resources;
  /** All required features, including the implied project/ and harness/ ones. */
  features: string[];
}

export interface HostView {
  name: string;
  online: boolean;
  drained: boolean;
  capacity: Resources;
  reserved: Resources;
  features: string[];
  measured: Measured | null;
}

export interface SchedContext {
  now: number;
  /** Fleet-wide counters. A job resource with a pool's name draws from the pool, not the host. */
  pools: Record<string, { total: number; used: number }>;
  /** True while a host has recently declined this job. */
  backedOff(job: string, host: string): boolean;
  /** A job that has waited this long for resources stops later jobs from passing it. */
  starve_after_s: number;
}

export interface Policy {
  order(jobs: QueuedJob[], ctx: SchedContext): QueuedJob[];
  /** Return a reason to exclude the host, or null to keep it. */
  filter(job: QueuedJob, host: HostView, ctx: SchedContext): string | null;
  /** Higher wins. */
  score(job: QueuedJob, host: HostView, ctx: SchedContext): number;
}

export type PendingReason = "no-eligible-host" | "resources" | "held-back";

export interface Placement {
  assignments: Array<{ job: string; host: string }>;
  pending: Record<string, PendingReason>;
}

export const defaultPolicy: Policy = {
  order: (jobs) =>
    [...jobs].sort((a, b) => b.priority - a.priority || a.submitted_at - b.submitted_at || a.id.localeCompare(b.id)),
  filter: (job, host, ctx) => (ctx.backedOff(job.id, host.name) ? "declined-recently" : null),
  score: (_job, host) => {
    const names = Object.keys(host.capacity);
    const free = names.length
      ? names.reduce((sum, n) => {
          const cap = host.capacity[n] ?? 0;
          return sum + (cap > 0 ? (cap - (host.reserved[n] ?? 0)) / cap : 0);
        }, 0) / names.length
      : 0;
    const load = host.measured && host.measured.cpus > 0 ? host.measured.load1 / host.measured.cpus : 0;
    return free - load;
  },
};

export function schedule(jobs: QueuedJob[], hosts: HostView[], ctx: SchedContext, policy: Policy = defaultPolicy): Placement {
  const reserved = new Map(hosts.map((h) => [h.name, { ...h.reserved }]));
  const poolUsed: Record<string, number> = Object.fromEntries(Object.entries(ctx.pools).map(([k, v]) => [k, v.used]));
  /** Resource names a starving job is waiting for, per host and for pools. */
  const heldOnHost = new Map<string, Set<string>>();
  const heldPools = new Set<string>();
  const out: Placement = { assignments: [], pending: {} };

  for (const job of policy.order(jobs, ctx)) {
    const poolNames = Object.keys(job.resources).filter((n) => n in ctx.pools);
    const hostNames = Object.keys(job.resources).filter((n) => !(n in ctx.pools));
    const poolShort = poolNames.some((n) => (poolUsed[n] ?? 0) + (job.resources[n] ?? 0) > (ctx.pools[n]?.total ?? 0));
    const poolHeld = poolNames.some((n) => heldPools.has(n));

    // Capable means the host could run the job if it were idle. A job no host could ever
    // fit must not hold others back.
    const poolFits = poolNames.every((n) => (job.resources[n] ?? 0) <= (ctx.pools[n]?.total ?? 0));
    const capable = hosts.filter(
      (h) =>
        poolFits &&
        h.online &&
        !h.drained &&
        job.features.every((f) => h.features.includes(f)) &&
        hostNames.every((n) => (h.capacity[n] ?? 0) >= (job.resources[n] ?? 0)),
    );
    let heldBack = poolHeld;
    const candidates = capable.filter((h) => {
      const held = heldOnHost.get(h.name);
      if (held && hostNames.some((n) => held.has(n))) {
        heldBack = true;
        return false;
      }
      const used = reserved.get(h.name) ?? {};
      if (hostNames.some((n) => (h.capacity[n] ?? 0) - (used[n] ?? 0) < (job.resources[n] ?? 0))) return false;
      return policy.filter(job, { ...h, reserved: used }, ctx) === null;
    });

    if (poolShort || poolHeld || candidates.length === 0) {
      const reason: PendingReason = capable.length === 0 ? "no-eligible-host" : heldBack ? "held-back" : "resources";
      out.pending[job.id] = reason;
      if (reason === "resources" && ctx.now - job.submitted_at >= ctx.starve_after_s * 1000) {
        for (const h of capable) {
          const set = heldOnHost.get(h.name) ?? new Set<string>();
          for (const n of hostNames) set.add(n);
          heldOnHost.set(h.name, set);
        }
        for (const n of poolNames) heldPools.add(n);
      }
      continue;
    }

    let best = candidates[0] as HostView;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const h of candidates) {
      const s = policy.score(job, { ...h, reserved: reserved.get(h.name) ?? {} }, ctx);
      if (s > bestScore) {
        best = h;
        bestScore = s;
      }
    }
    const used = reserved.get(best.name) ?? {};
    for (const n of hostNames) used[n] = (used[n] ?? 0) + (job.resources[n] ?? 0);
    reserved.set(best.name, used);
    for (const n of poolNames) poolUsed[n] = (poolUsed[n] ?? 0) + (job.resources[n] ?? 0);
    out.assignments.push({ job: job.id, host: best.name });
  }
  return out;
}
