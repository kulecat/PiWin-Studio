/**
 * Best-effort append-only execution audit.
 *
 * Each agent host writes to its own JSONL file, so parallel chats cannot
 * contend for one log. We keep a hash chain to make accidental truncation or
 * reordering visible during review. This is not a tamper-proof ledger: a user
 * with filesystem access can still edit the log and recompute hashes.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { PolicyEventPayload } from "@shared/protocol";
import type { LocalRunnerKind } from "./windows-execution";

type AuditRunner = LocalRunnerKind | "e2b";
type AuditWorld = "local" | "vm";

interface AuditContext {
  cwd: string;
  sessionId: string;
  logPath: string;
  previousHash: string;
}

let context: AuditContext | undefined;
let writeQueue: Promise<void> = Promise.resolve();

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function commandProgram(command: string): string {
  return command.trim().split(/\s+/, 1)[0]?.slice(0, 80) || "(empty)";
}

/** Configure one log file per host process before the agent begins executing. */
export function configureAuditLog(cwd: string, sessionId: string): void {
  const root = process.env.PIWIN_AUDIT_DIR || join(cwd, ".piwin", "audit");
  context = {
    cwd,
    sessionId,
    logPath: join(root, `${sessionId}.jsonl`),
    previousHash: "GENESIS",
  };
  writeQueue = Promise.resolve();
}

export interface AuditedCommand {
  world: AuditWorld;
  runner: AuditRunner;
  cwd: string;
  command: string;
  timeoutMs?: number;
}

/**
 * Records only command metadata and a SHA-256 fingerprint, never the raw
 * command text. Shell commands commonly carry tokens, so retaining them by
 * default would make the audit log a secret store.
 */
export async function runAuditedCommand<T extends { exitCode: number | null }>(
  command: AuditedCommand,
  execute: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await execute();
    queueAudit({
      ...command,
      startedAt,
      finishedAt: Date.now(),
      exitCode: result.exitCode,
      outcome: "completed",
    });
    return result;
  } catch (error) {
    queueAudit({
      ...command,
      startedAt,
      finishedAt: Date.now(),
      exitCode: null,
      outcome: "error",
      errorKind: error instanceof Error ? error.name : "UnknownError",
    });
    throw error;
  }
}

function queueAudit(input: AuditedCommand & {
  startedAt: number;
  finishedAt: number;
  exitCode: number | null;
  outcome: "completed" | "error";
  errorKind?: string;
}): void {
  if (!context) return;
  const active = context;
  writeQueue = writeQueue
    .catch(() => {
      // A failed prior write must not prevent a later event from being tried.
    })
    .then(async () => {
      const entry = {
        schemaVersion: 1,
        id: randomUUID(),
        event: "command_finished",
        recordedAt: new Date(input.finishedAt).toISOString(),
        sessionId: active.sessionId,
        workspace: active.cwd,
        world: input.world,
        runner: input.runner,
        command: {
          program: commandProgram(input.command),
          bytes: Buffer.byteLength(input.command, "utf8"),
          sha256: sha256(input.command),
        },
        timeoutMs: input.timeoutMs,
        startedAt: input.startedAt,
        durationMs: input.finishedAt - input.startedAt,
        policyDecision: "executed",
        outcome: input.outcome,
        exitCode: input.exitCode,
        errorKind: input.errorKind,
        previousHash: active.previousHash,
      };
      const hash = sha256(JSON.stringify(entry));
      await mkdir(dirname(active.logPath), { recursive: true });
      await appendFile(active.logPath, `${JSON.stringify({ ...entry, hash })}\n`, "utf8");
      active.previousHash = hash;
    });
}

/** Record allow/ask/deny/budget decisions without duplicating sensitive detail. */
export function appendPolicyAudit(event: PolicyEventPayload): void {
  if (!context) return;
  const active = context;
  writeQueue = writeQueue
    .catch(() => {
      // A failed prior write must not prevent a later event from being tried.
    })
    .then(async () => {
      const entry = {
        schemaVersion: 1,
        id: event.id,
        event: "policy_decision",
        recordedAt: new Date(event.time).toISOString(),
        sessionId: active.sessionId,
        workspace: active.cwd,
        toolName: event.toolName,
        decision: event.kind,
        detail: {
          bytes: Buffer.byteLength(event.detail, "utf8"),
          sha256: sha256(event.detail),
        },
        previousHash: active.previousHash,
      };
      const hash = sha256(JSON.stringify(entry));
      await mkdir(dirname(active.logPath), { recursive: true });
      await appendFile(active.logPath, `${JSON.stringify({ ...entry, hash })}\n`, "utf8");
      active.previousHash = hash;
    });
}

/**
 * Record a Docker proxy decision without retaining full URLs, headers, bodies,
 * or credentials. The proxy itself only emits a DNS host, port, HTTP method,
 * a small fixed reason, and (when known) an HTTP status.
 */
export function appendNetworkAudit(event: {
  decision: "allowed" | "denied";
  host: string;
  port: number;
  method: string;
  reason?: string;
  statusCode?: number;
}): void {
  if (!context) return;
  const active = context;
  writeQueue = writeQueue
    .catch(() => {
      // A failed prior write must not prevent a later event from being tried.
    })
    .then(async () => {
      const entry = {
        schemaVersion: 1,
        id: randomUUID(),
        event: "network_request",
        recordedAt: new Date().toISOString(),
        sessionId: active.sessionId,
        workspace: active.cwd,
        target: {
          host: event.host.slice(0, 253),
          port: event.port,
          method: event.method.slice(0, 16),
        },
        decision: event.decision,
        reason: event.reason?.slice(0, 80),
        statusCode: event.statusCode,
        previousHash: active.previousHash,
      };
      const hash = sha256(JSON.stringify(entry));
      await mkdir(dirname(active.logPath), { recursive: true });
      await appendFile(active.logPath, `${JSON.stringify({ ...entry, hash })}\n`, "utf8");
      active.previousHash = hash;
    });
}

/** Record a temporary Docker credential decision by variable name only. */
export function appendCredentialAudit(event: {
  decision: "approved" | "denied" | "executed" | "failed";
  names: string[];
  exitCode?: number | null;
}): void {
  if (!context) return;
  const active = context;
  writeQueue = writeQueue
    .catch(() => {
      // A failed prior write must not prevent a later event from being tried.
    })
    .then(async () => {
      const entry = {
        schemaVersion: 1,
        id: randomUUID(),
        event: "credential_access",
        recordedAt: new Date().toISOString(),
        sessionId: active.sessionId,
        workspace: active.cwd,
        decision: event.decision,
        names: [...new Set(event.names)].slice(0, 16),
        exitCode: event.exitCode,
        previousHash: active.previousHash,
      };
      const hash = sha256(JSON.stringify(entry));
      await mkdir(dirname(active.logPath), { recursive: true });
      await appendFile(active.logPath, `${JSON.stringify({ ...entry, hash })}\n`, "utf8");
      active.previousHash = hash;
    });
}
