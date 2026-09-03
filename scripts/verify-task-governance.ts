/**
 * Disposable regression check for P5 task coordination.
 *
 * It proves assignment metadata is durable, turns into an audit event, and
 * can be exported without copying the task worktree path into the hand-off.
 */
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  createWorktree,
  discardTask,
  exportWorktreeAudit,
  setWorktreePathClaims,
  setWorktreeTaskAssignment,
  worktreeTaskDashboard,
} from "../src/main/worktrees";

const execFile = promisify(execFileCallback);
const scratchPrefix = "piwin-task-governance-smoke-";

async function run(command: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFile(command, args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Task governance smoke failed: ${message}`);
}

async function main(): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), scratchPrefix));
  const resolvedScratch = resolve(scratch);
  assert(resolvedScratch.startsWith(resolve(tmpdir(), scratchPrefix)), "refused an unexpected temporary path");
  let task: Awaited<ReturnType<typeof createWorktree>> | undefined;

  try {
    await run("git", ["init", "-q", "--initial-branch=main"], scratch);
    await run("git", ["config", "user.name", "PiWin smoke"], scratch);
    await run("git", ["config", "user.email", "piwin-smoke@desktop.local"], scratch);
    await writeFile(join(scratch, "README.md"), "baseline\n", "utf8");
    await run("git", ["add", "README.md"], scratch);
    await run("git", ["commit", "-qm", "baseline"], scratch);

    task = await createWorktree(scratch, "governance smoke");
    await setWorktreePathClaims(scratch, task.path, task.branch, task.task.taskId, ["src/ui", "docs"]);
    const assigned = await setWorktreeTaskAssignment(
      scratch,
      task.path,
      task.branch,
      task.task.taskId,
      { agent: "UI Agent", role: "frontend" },
    );
    const taskCard = assigned.tasks.find((candidate) => candidate.taskId === task!.task.taskId);
    assert(taskCard?.assignment?.agent === "UI Agent", "assignment owner was not persisted");
    assert(taskCard.assignment?.role === "frontend", "assignment role was not persisted");
    assert(assigned.events.some((event) => event.kind === "task_assignment_updated"), "assignment event missing");

    const exported = await exportWorktreeAudit(scratch);
    const commonDir = resolve(scratch, await run("git", ["rev-parse", "--git-common-dir"], scratch));
    assert(resolve(exported.path).startsWith(commonDir), "audit export escaped the Git common directory");
    const raw = await readFile(exported.path, "utf8");
    assert(!raw.includes(task.path), "audit export exposed the task worktree path");
    const artifact = JSON.parse(raw) as {
      integrity?: { algorithm?: string; payloadSha256?: string };
      tasks?: Array<{ taskId?: string; assignment?: { agent?: string; role?: string } }>;
    } & Record<string, unknown>;
    const { integrity, ...payload } = artifact;
    const recomputed = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    assert(integrity?.algorithm === "sha256", "audit export did not identify its digest algorithm");
    assert(integrity?.payloadSha256 === recomputed && exported.sha256 === recomputed, "audit export digest mismatch");
    const exportedTask = artifact.tasks?.find((candidate) => candidate.taskId === task!.task.taskId);
    assert(exportedTask?.assignment?.agent === "UI Agent", "audit export omitted assignment");
    assert(exportedTask.assignment?.role === "frontend", "audit export omitted assignment role");

    const dashboard = await worktreeTaskDashboard(scratch);
    assert(dashboard.tasks.some((candidate) => candidate.taskId === task!.task.taskId), "task disappeared from dashboard");
    const discarded = await discardTask(scratch, task.path, task.branch, task.task.taskId, true);
    assert(discarded.discarded, discarded.error ?? "temporary task cleanup failed");
    task = undefined;
    process.stdout.write("TASK_GOVERNANCE_P5_SMOKE_OK\n");
  } finally {
    if (task) {
      try {
        await discardTask(scratch, task.path, task.branch, task.task.taskId, true);
      } catch {
        // Keep the original assertion failure if cleanup also fails.
      }
    }
    await rm(resolvedScratch, { recursive: true, force: true });
  }
}

void main();
