/**
 * Real-WSL smoke test for the guarded private-copy recovery path.
 *
 * It creates a disposable Git repository, writes only inside the native WSL
 * private copy, then calls the preparation API a second time to model an app
 * restart. The second call must attach to the same copy and preserve the
 * un-imported patch. This needs an installed `Ubuntu` WSL distribution.
 */
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  createWorktree,
  discardTask,
  discardWslTaskPatch,
  prepareWslTaskWorkspaceForChat,
  previewWslTaskPatch,
} from "../src/main/worktrees";

const execFile = promisify(execFileCallback);
const scratchPrefix = "piwin-wsl-recovery-smoke-";

async function run(command: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFile(command, args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`WSL recovery smoke failed: ${message}`);
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

    task = await createWorktree(scratch, "wsl recovery smoke");
    const first = await prepareWslTaskWorkspaceForChat(task.path, { distribution: "Ubuntu", mountRoot: "/mnt" });
    await run("wsl.exe", [
      "--distribution", "Ubuntu", "--exec", "sh", "-lc",
      'printf "recovered private change\\n" > "$1/recovery-proof.txt"',
      "piwin-smoke", first.path,
    ]);

    // A second preparation call reloads task metadata from disk just like a
    // newly started Electron main process would do after an interruption.
    const resumed = await prepareWslTaskWorkspaceForChat(task.path, { distribution: "Ubuntu", mountRoot: "/mnt" });
    assert(resumed.path === first.path, "restart did not reuse the same native WSL private copy");

    const preview = await previewWslTaskPatch(scratch, task.path, task.branch, task.task.taskId);
    assert(preview.state === "ready", "private copy was not still marked ready after restart");
    assert(preview.changedFiles.includes("recovery-proof.txt"), "un-imported WSL change was not recovered");

    const discarded = await discardWslTaskPatch(scratch, task.path, task.branch, task.task.taskId, true);
    assert(discarded.discarded, discarded.error ?? "explicit private-copy discard failed");

    const taskDiscard = await discardTask(scratch, task.path, task.branch, task.task.taskId, true);
    assert(taskDiscard.discarded, taskDiscard.error ?? "temporary task cleanup failed");
    task = undefined;
    process.stdout.write("WSL_PRIVATE_RECOVERY_SMOKE_OK\n");
  } finally {
    if (task) {
      try {
        await discardTask(scratch, task.path, task.branch, task.task.taskId, true);
      } catch {
        // Keep the original assertion error if cleanup itself fails.
      }
    }
    await rm(resolvedScratch, { recursive: true, force: true });
  }
}

void main();
