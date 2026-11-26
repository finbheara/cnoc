/**
 * Shared types: the job model, the changelog, and the client<->server wire messages.
 * The wire protocol is the product; server and client are one implementation of it.
 */

export const VERSION: string = process.env.CNOC_VERSION ?? "0.1.0";
/** Bumped on any incompatible change to the messages below. */
export const PROTOCOL = 1;

/** Named counters. Host capacity, job requests and fleet pools all use this shape. */
export type Resources = Record<string, number>;

export type JobState = "blocked" | "queued" | "assigned" | "running" | "done" | "failed" | "cancelled";
export const TERMINAL: readonly JobState[] = ["done", "failed", "cancelled"];
export type Outcome = "done" | "failed" | "cancelled";

/** One harness session. A job runs its stages in order. */
export interface Stage {
  harness: string;
  args: string;
  prompt: string;
}

export interface JobSpec {
  id: string;
  project: string;
  priority: number;
  resources: Resources;
  /** Host features the job needs, beyond the implied project/ and harness/ ones. */
  requires: string[];
  /** Job ids that must be `done` before this job may start. */
  depends: string[];
  /** Wall-clock limit for the whole job, seconds. */
  time_s: number | null;
  labels: Record<string, string>;
  env: Record<string, string>;
  stages: Stage[];
}

export interface StageResult {
  status: "done" | "failed";
  summary: string;
  data?: unknown;
}

export interface AttemptEnd {
  attempt: number;
  outcome: Outcome;
  reason: string | null;
  /** One entry per stage that produced a result. */
  results: StageResult[];
}

export interface Measured {
  cpus: number;
  load1: number;
  mem_total: number;
  mem_free: number;
}

export interface ChangeEvent {
  seq: number;
  ts: number;
  type: string;
  job: string | null;
  attempt: number | null;
  host: string | null;
  actor: string | null;
  data: unknown;
}

// ---- wire: server -> client ------------------------------------------------

export type ServerMsg =
  | { t: "challenge"; nonce: string; version: string; protocol: number }
  | { t: "pending"; fingerprint: string }
  | { t: "welcome"; host: string; api_token: string; heartbeat_s: number }
  | { t: "assign"; attempt: number; spec: JobSpec }
  | { t: "cancel"; attempt: number; reason: string }
  | { t: "ack"; attempt: number };

// ---- wire: client -> server ------------------------------------------------

export type ClientMsg =
  | { t: "hello"; name: string; pubkey: string; sig: string; version: string; protocol: number }
  | {
      /** Full view, sent once after every (re)connect. The server reconciles against it. */
      t: "sync";
      capacity: Resources;
      features: string[];
      running: number[];
      /** Attempts that finished and are waiting in the outbox for an ack. */
      ended: number[];
    }
  | { t: "status"; measured: Measured; reserved: Resources; running: number[] }
  | { t: "decline"; attempt: number; reason: string }
  | { t: "started"; attempt: number }
  | { t: "progress"; attempt: number; stage: number; note: string }
  | ({ t: "ended" } & AttemptEnd);

export function impliedFeatures(spec: JobSpec): string[] {
  const f = new Set<string>(spec.requires);
  f.add(`project/${spec.project}`);
  for (const s of spec.stages) f.add(`harness/${s.harness}`);
  return [...f];
}
