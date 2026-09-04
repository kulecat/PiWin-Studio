/** Real Docker regression for P6 private-copy lifecycle events. */
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  createWorktree,
  discardDockerTaskPatch,
  discardTask,
  prepareDockerTaskWorkspaceForChat,
  worktreeTaskDashboard,
} from "../src/main/worktrees";

const execFile = promisify(execFileCallback);
const scratchPrefix = "piwin-docker-task-audit-smoke-";

async function run(command: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFile(command, args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Docker task audit smoke failed: ${message}`);
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

    task = await createWorktree(scratch, "docker audit smoke");
    await prepareDockerTaskWorkspaceForChat(task.path);
    let dashboard = await worktreeTaskDashboard(scratch);
    const created = dashboard.tasks.find((item) => item.taskId === task!.task.taskId);
    assert(created?.privateWorkspace?.docker?.state === "ready", "dashboard omitted ready Docker private copy");
    assert(dashboard.events.some((event) => event.taskId === task!.task.taskId && event.kind === "docker_copy_created"), "Docker create event missing");

    const discarded = await discardDockerTaskPatch(scratch, task.path, task.branch, task.task.taskId, true);
    assert(discarded.discarded, discarded.error ?? "Docker private copy discard failed");
    dashboard = await worktreeTaskDashboard(scratch);
    const finished = dashboard.tasks.find((item) => item.taskId === task!.task.taskId);
    assert(finished?.privateWorkspace?.docker?.state === "discarded", "dashboard omitted discarded Docker private copy");
    assert(dashboard.events.some((event) => event.taskId === task!.task.taskId && event.kind === "docker_copy_discarded"), "Docker discard event missing");

    const taskDiscard = await discardTask(scratch, task.path, task.branch, task.task.taskId, true);
    assert(taskDiscard.discarded, taskDiscard.error ?? "temporary task cleanup failed");
    task = undefined;
    process.stdout.write("DOCKER_TASK_AUDIT_SMOKE_OK\n");
  } finally {
    if (task) {
      try {
        await discardTask(scratch, task.path, task.branch, task.task.taskId, true);
      } catch {
        // Preserve the original assertion failure if cleanup itself fails.
      }
    }
    await rm(resolvedScratch, { recursive: true, force: true });
  }
}

void main();
