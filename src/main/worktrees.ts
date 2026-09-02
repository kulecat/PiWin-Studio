/**
 * Guarded Git worktree tasks.
 *
 * A task is created from a clean primary checkout, lives on its own branch,
 * and must be explicitly prepared for review before it can be merged. Task
 * metadata is intentionally stored under the Git common directory, so it is
 * local-only and not mixed into the user's source tree.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  DockerTaskPatchDiscardResult,
  DockerTaskPatchImportResult,
  DockerTaskPatchPreview,
  DockerTaskWorkspaceState,
  WorktreeDiscardResult,
  WorktreeMergeResult,
  WorktreeStatusInfo,
  WorktreeTaskRef,
  WorktreeTaskState,
} from "@shared/protocol";
import { getDockerSandboxProfile } from "../host/windows-execution";
import { dockerFilteredWorkspaceCopyCommand } from "../host/docker-credential-policy";

const exec = promisify(execFile);
const TASKS_FILE = "piwin-tasks.json";
const TASKS_SCHEMA_VERSION = 1;
const DOCKER_PRIVATE_VOLUME_PREFIX = "piwin-task-";
const DOCKER_PRIVATE_BASE_REF = "refs/piwin/private-base";

interface DockerTaskWorkspaceRecord {
  volume: string;
  state: DockerTaskWorkspaceState;
  sourceCommit: string;
  createdAt: string;
  importedAt?: string;
  discardedAt?: string;
}

interface PersistedTask {
  id: string;
  root: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  baseCommit: string;
  targetBranch: string;
  targetCommit: string;
  state: WorktreeTaskState;
  createdAt: string;
  reviewedAt?: string;
  reviewCommit?: string;
  mergedAt?: string;
  discardedAt?: string;
  dockerWorkspace?: DockerTaskWorkspaceRecord;
}

interface TaskStore {
  version: number;
  tasks: PersistedTask[];
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  isMain: boolean;
  task?: WorktreeTaskRef;
}

export interface WorktreeCreateResult {
  path: string;
  branch: string;
  task: WorktreeTaskRef;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

function dockerExecutable(): string {
  return process.platform === "win32" ? "docker.exe" : "docker";
}

async function docker(args: string[], options: { timeout?: number; maxBuffer?: number } = {}): Promise<string> {
  const { stdout } = await exec(dockerExecutable(), args, {
    timeout: options.timeout ?? 60_000,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    windowsHide: true,
  });
  // A unified diff must retain its final newline. Do not normalize Docker
  // command output here; callers that need a trimmed scalar can do so locally.
  return stdout;
}

function compactCommandError(error: unknown): string {
  const detail = error as { stderr?: string; message?: string };
  const text = (detail.stderr || detail.message || String(error)).replace(/\s+/g, " ").trim();
  return text.slice(0, 360);
}

function normalizePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "task";
}

function taskWorktreeContainer(root: string): string {
  const name = slugify(basename(root));
  const suffix = createHash("sha256").update(normalizePath(root)).digest("hex").slice(0, 10);
  return join(homedir(), ".piwin", "task-worktrees", `${name}-${suffix}`);
}

function parseWorktreeList(output: string): WorktreeInfo[] {
  const result: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9), isMain: result.length === 0 };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace("refs/heads/", "");
    } else if (line === "") {
      if (current.path) result.push(current as WorktreeInfo);
      current = {};
    }
  }
  if (current.path) result.push(current as WorktreeInfo);
  return result;
}

async function primaryRoot(projectPath: string): Promise<string> {
  const listed = parseWorktreeList(await git(projectPath, "worktree", "list", "--porcelain"));
  const main = listed.find((worktree) => worktree.isMain)?.path;
  if (!main) throw new Error("无法定位 Git 主工作区");
  return main;
}

async function gitCommonDir(root: string): Promise<string> {
  const common = await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return isAbsolute(common) ? common : resolve(root, common);
}

async function taskStorePath(root: string): Promise<string> {
  return join(await gitCommonDir(root), TASKS_FILE);
}

async function readTaskStore(root: string): Promise<TaskStore> {
  try {
    const raw = await readFile(await taskStorePath(root), "utf8");
    const parsed = JSON.parse(raw) as Partial<TaskStore>;
    if (parsed.version !== TASKS_SCHEMA_VERSION || !Array.isArray(parsed.tasks)) {
      throw new Error("unsupported task metadata");
    }
    return { version: TASKS_SCHEMA_VERSION, tasks: parsed.tasks as PersistedTask[] };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { version: TASKS_SCHEMA_VERSION, tasks: [] };
    // Do not silently overwrite malformed metadata: it is part of the audit trail.
    throw new Error("PiWin 任务元数据无法读取；请先备份 .git/piwin-tasks.json 后再重试");
  }
}

async function writeTaskStore(root: string, store: TaskStore): Promise<void> {
  const file = await taskStorePath(root);
  await mkdir(resolve(file, ".."), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

function toTaskRef(task: PersistedTask): WorktreeTaskRef {
  return {
    taskId: task.id,
    branch: task.branch,
    projectPath: task.root,
    baseCommit: task.baseCommit,
    state: task.state,
  };
}

async function findTask(
  root: string,
  worktreePath: string,
  branch: string,
  taskId?: string,
): Promise<PersistedTask | undefined> {
  const store = await readTaskStore(root);
  const task = taskId
    ? store.tasks.find((candidate) => candidate.id === taskId)
    : store.tasks.find(
        (candidate) => samePath(candidate.worktreePath, worktreePath) && candidate.branch === branch,
      );
  if (!task) return undefined;
  if (
    !samePath(task.root, root) ||
    !samePath(task.worktreePath, worktreePath) ||
    task.branch !== branch
  ) {
    throw new Error("任务身份与 worktree 不匹配，已拒绝操作");
  }
  return task;
}

async function requireTask(
  root: string,
  worktreePath: string,
  branch: string,
  taskId: string,
): Promise<PersistedTask> {
  const task = await findTask(root, worktreePath, branch, taskId);
  if (!task) throw new Error("这不是 PiWin 管理的任务 worktree，已拒绝执行受控操作");
  return task;
}

async function assertCleanPrimary(root: string): Promise<void> {
  const status = await git(root, "status", "--porcelain", "--untracked-files=all");
  if (status) {
    throw new Error("主工作区存在未提交或未跟踪改动。请先提交、暂存或清理，再创建/合并任务。");
  }
}

function taskCommitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "PiWin Studio",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "piwin@desktop.local",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "PiWin Studio",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "piwin@desktop.local",
  };
}

async function commitTaskSnapshot(worktreePath: string, branch: string, taskId: string): Promise<void> {
  const dirty = await git(worktreePath, "status", "--porcelain", "--untracked-files=all");
  if (!dirty) return;
  await exec("git", ["add", "-A"], {
    cwd: worktreePath,
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
  });
  await exec(
    "git",
    ["commit", "-m", `PiWin task review snapshot (${branch}, ${taskId.slice(0, 8)})`],
    { cwd: worktreePath, timeout: 30000, maxBuffer: 16 * 1024 * 1024, env: taskCommitEnv() },
  );
}

async function updateTask(root: string, taskId: string, patch: Partial<PersistedTask>): Promise<PersistedTask> {
  const store = await readTaskStore(root);
  const index = store.tasks.findIndex((task) => task.id === taskId);
  if (index < 0) throw new Error("PiWin 任务元数据不存在");
  const task = { ...store.tasks[index], ...patch };
  store.tasks[index] = task;
  await writeTaskStore(root, store);
  return task;
}

function dockerVolumeName(task: PersistedTask): string {
  return `${DOCKER_PRIVATE_VOLUME_PREFIX}${task.id.replaceAll("-", "").slice(0, 24)}`;
}

function dockerTaskMount(volume: string): string {
  return ["type=volume", `src=${volume}`, "dst=/workspace"].join(",");
}

function dockerTaskIsolationArgs(): string[] {
  const profile = getDockerSandboxProfile();
  return [
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=512m",
    "--tmpfs",
    "/var/tmp:rw,nosuid,nodev,size=128m",
    "--tmpfs",
    "/home/node:rw,nosuid,nodev,size=256m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--ipc",
    "none",
    "--pids-limit",
    String(profile.pidsLimit),
    "--memory",
    profile.memory,
    "--memory-swap",
    profile.memory,
    "--cpus",
    profile.cpus,
  ];
}

async function dockerVolumeExists(volume: string): Promise<boolean> {
  try {
    await docker(["volume", "inspect", volume], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function removeDockerVolume(volume: string): Promise<void> {
  try {
    await docker(["volume", "rm", volume], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    if (/no such volume/i.test(compactCommandError(error))) return;
    throw error;
  }
}

function assertDockerTaskSource(task: PersistedTask): Promise<void> {
  return (async () => {
    if (task.state !== "active") {
      throw new Error("只有处于活动状态且尚未审核的 PiWin 任务可以启用 Docker 私有副本");
    }
    const [dirty, head] = await Promise.all([
      git(task.worktreePath, "status", "--porcelain", "--untracked-files=all"),
      git(task.worktreePath, "rev-parse", "HEAD"),
    ]);
    if (dirty || head !== task.baseCommit) {
      throw new Error("Docker 私有副本只能从未修改的任务基线创建；请先审核或丢弃当前任务，再新建任务。");
    }
  })();
}

async function initializeDockerTaskWorkspace(task: PersistedTask, volume: string): Promise<void> {
  const profile = getDockerSandboxProfile();
  const sourceMount = ["type=bind", `src=${task.worktreePath}`, "dst=/source", "readonly"].join(",");
  const bootstrap = [
    "set -eu",
    dockerFilteredWorkspaceCopyCommand("/source", "/workspace"),
    "git -C /workspace init -q",
    "git -C /workspace config user.name 'PiWin Studio'",
    "git -C /workspace config user.email 'piwin@desktop.local'",
    "git -C /workspace add -A",
    "git -C /workspace commit --allow-empty -qm 'PiWin private task base'",
    `git -C /workspace update-ref ${DOCKER_PRIVATE_BASE_REF} HEAD`,
    "chown -R 1000:1000 /workspace",
  ].join("; ");
  await docker(
    [
      "run",
      "--rm",
      "--init",
      ...dockerTaskIsolationArgs(),
      // This short bootstrap needs ownership changes on a newly-created Docker
      // volume so the unprivileged command container can write afterwards.
      "--cap-add",
      "CHOWN",
      "--user",
      "root",
      "--mount",
      dockerTaskMount(volume),
      "--mount",
      sourceMount,
      profile.image,
      "sh",
      "-lc",
      bootstrap,
    ],
    { timeout: 300_000 },
  );
}

interface DockerTaskWorkspaceForChat {
  volume: string;
}

/**
 * Prepare the only writable Docker mount for a chat. It is a named volume,
 * never the host task path, and starts as a Git snapshot of the task baseline.
 */
export async function prepareDockerTaskWorkspaceForChat(
  worktreePath: string,
): Promise<DockerTaskWorkspaceForChat> {
  const root = await primaryRoot(worktreePath);
  const branch = await git(worktreePath, "branch", "--show-current");
  if (!branch) throw new Error("Docker 可写模式要求当前目录是已签出的 PiWin 任务分支");
  const task = await findTask(root, worktreePath, branch);
  if (!task) {
    throw new Error("Docker 可写模式只允许 PiWin 受控任务 worktree；请先创建一个新任务。");
  }
  const existing = task.dockerWorkspace;
  if (existing?.state === "imported" || existing?.state === "discarded") {
    throw new Error("此任务的 Docker 私有副本已经结束。请审核它的改动并新建下一个任务。");
  }
  if (existing?.state === "ready" && (await dockerVolumeExists(existing.volume))) {
    return { volume: existing.volume };
  }

  await assertDockerTaskSource(task);
  const volume = existing?.volume ?? dockerVolumeName(task);
  try {
    if (!(await dockerVolumeExists(volume))) {
      await docker([
        "volume",
        "create",
        "--label",
        "piwin.managed=true",
        "--label",
        `piwin.task-id=${task.id}`,
        volume,
      ]);
    }
    await initializeDockerTaskWorkspace(task, volume);
  } catch (error) {
    try {
      await removeDockerVolume(volume);
    } catch {
      // Keep the original bootstrap failure; Docker's volume can be removed manually.
    }
    throw new Error(`无法创建 Docker 私有任务副本：${compactCommandError(error)}`);
  }

  await updateTask(root, task.id, {
    dockerWorkspace: {
      volume,
      state: "ready",
      sourceCommit: task.baseCommit,
      createdAt: new Date().toISOString(),
    },
  });
  return { volume };
}

interface DockerPatchData {
  patch: string;
  changedFiles: string[];
}

async function readDockerTaskPatch(task: PersistedTask): Promise<DockerPatchData> {
  const workspace = task.dockerWorkspace;
  if (!workspace || workspace.state !== "ready") return { patch: "", changedFiles: [] };
  if (!(await dockerVolumeExists(workspace.volume))) {
    throw new Error("Docker 私有副本已丢失；请丢弃该任务或按需手动恢复 Docker volume。");
  }
  const profile = getDockerSandboxProfile();
  const prefix = [
    "run",
    "--rm",
    "--init",
    ...dockerTaskIsolationArgs(),
    "--user",
    "node",
    "--workdir",
    "/workspace",
    "--mount",
    dockerTaskMount(workspace.volume),
    "--env",
    "HOME=/tmp",
    profile.image,
    "sh",
    "-lc",
  ];
  try {
    // Intent-to-add makes untracked, non-ignored files part of the preview and
    // binary patch without modifying the host task tree.
    const names = await docker([...prefix, `git add -N -- . && git diff --name-only -z ${DOCKER_PRIVATE_BASE_REF}`], {
      timeout: 120_000,
    });
    const patch = await docker(
      [...prefix, `git add -N -- . && git diff --binary --no-ext-diff --full-index ${DOCKER_PRIVATE_BASE_REF}`],
      { timeout: 120_000 },
    );
    return { patch, changedFiles: names.split("\0").filter(Boolean) };
  } catch (error) {
    throw new Error(`无法读取 Docker 私有副本：${compactCommandError(error)}`);
  }
}

async function requireDockerTask(
  projectPath: string,
  worktreePath: string,
  branch: string,
  taskId: string,
): Promise<{ root: string; task: PersistedTask }> {
  const root = await primaryRoot(projectPath);
  const task = await requireTask(root, worktreePath, branch, taskId);
  return { root, task };
}

export async function previewDockerTaskPatch(
  projectPath: string,
  worktreePath: string,
  branch: string,
  taskId: string,
): Promise<DockerTaskPatchPreview> {
  const { task } = await requireDockerTask(projectPath, worktreePath, branch, taskId);
  const state = task.dockerWorkspace?.state;
  if (!state) return { state: "unavailable", changedFiles: [], patchBytes: 0 };
  if (state !== "ready") return { state, changedFiles: [], patchBytes: 0 };
  try {
    const patch = await readDockerTaskPatch(task);
    return {
      state,
      changedFiles: patch.changedFiles,
      patchBytes: Buffer.byteLength(patch.patch, "utf8"),
    };
  } catch (error) {
    return {
      state,
      changedFiles: [],
      patchBytes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function assertHostTaskReadyForPatch(task: PersistedTask): Promise<void> {
  if (task.state !== "active") {
    throw new Error("Docker 补丁只能导入尚未审核的活动任务");
  }
  const [dirty, head] = await Promise.all([
    git(task.worktreePath, "status", "--porcelain", "--untracked-files=all"),
    git(task.worktreePath, "rev-parse", "HEAD"),
  ]);
  if (dirty || head !== task.baseCommit) {
    throw new Error("任务 worktree 已有宿主机改动或提交，拒绝混合导入 Docker 补丁。请先审核、提交或丢弃其中一侧的改动。");
  }
}

export async function importDockerTaskPatch(
  projectPath: string,
  worktreePath: string,
  branch: string,
  taskId: string,
  confirmed: boolean,
): Promise<DockerTaskPatchImportResult> {
  const { root, task } = await requireDockerTask(projectPath, worktreePath, branch, taskId);
  if (task.dockerWorkspace?.state !== "ready") {
    return {
      imported: false,
      requiresConfirmation: false,
      changedFiles: [],
      patchBytes: 0,
      error: "没有可导入的 Docker 私有副本",
    };
  }
  let patch: DockerPatchData = { patch: "", changedFiles: [] };
  try {
    patch = await readDockerTaskPatch(task);
    await assertHostTaskReadyForPatch(task);
  } catch (error) {
    return {
      imported: false,
      requiresConfirmation: false,
      changedFiles: patch.changedFiles,
      patchBytes: Buffer.byteLength(patch.patch, "utf8"),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const patchBytes = Buffer.byteLength(patch.patch, "utf8");
  if (!patch.patch) {
    return {
      imported: false,
      requiresConfirmation: false,
      changedFiles: [],
      patchBytes: 0,
      error: "Docker 私有副本没有可导入的代码改动",
    };
  }

  const tempDir = await mkdtemp(join(tmpdir(), "piwin-docker-patch-"));
  const patchPath = join(tempDir, "task.patch");
  try {
    await writeFile(patchPath, patch.patch, "utf8");
    await git(worktreePath, "apply", "--check", "--binary", "--whitespace=nowarn", patchPath);
    if (!confirmed) {
      return {
        imported: false,
        requiresConfirmation: true,
        changedFiles: patch.changedFiles,
        patchBytes,
      };
    }
    await git(worktreePath, "apply", "--binary", "--whitespace=nowarn", patchPath);
    try {
      await removeDockerVolume(task.dockerWorkspace.volume);
    } catch (error) {
      // The host patch already applied safely. Persist the terminal state so
      // PiWin never presents this old copy as importable again.
      await updateTask(root, task.id, {
        dockerWorkspace: {
          ...task.dockerWorkspace,
          state: "imported",
          importedAt: new Date().toISOString(),
        },
      });
      return {
        imported: true,
        requiresConfirmation: false,
        changedFiles: patch.changedFiles,
        patchBytes,
        error: `补丁已导入，但 Docker volume 清理失败：${compactCommandError(error)}`,
      };
    }
    await updateTask(root, task.id, {
      dockerWorkspace: {
        ...task.dockerWorkspace,
        state: "imported",
        importedAt: new Date().toISOString(),
      },
    });
    return { imported: true, requiresConfirmation: false, changedFiles: patch.changedFiles, patchBytes };
  } catch (error) {
    return {
      imported: false,
      requiresConfirmation: false,
      changedFiles: patch.changedFiles,
      patchBytes,
      error: `Docker 补丁未导入：${compactCommandError(error)}`,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function discardDockerTaskPatch(
  projectPath: string,
  worktreePath: string,
  branch: string,
  taskId: string,
  confirmed: boolean,
): Promise<DockerTaskPatchDiscardResult> {
  const { root, task } = await requireDockerTask(projectPath, worktreePath, branch, taskId);
  if (task.dockerWorkspace?.state !== "ready") {
    return { discarded: false, requiresConfirmation: false, changedFiles: [], patchBytes: 0, error: "没有可丢弃的 Docker 私有副本" };
  }
  let patch: DockerPatchData = { patch: "", changedFiles: [] };
  try {
    patch = await readDockerTaskPatch(task);
  } catch (error) {
    return {
      discarded: false,
      requiresConfirmation: false,
      changedFiles: [],
      patchBytes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const patchBytes = Buffer.byteLength(patch.patch, "utf8");
  if (!confirmed && patch.changedFiles.length > 0) {
    return { discarded: false, requiresConfirmation: true, changedFiles: patch.changedFiles, patchBytes };
  }
  try {
    await removeDockerVolume(task.dockerWorkspace.volume);
    await updateTask(root, task.id, {
      dockerWorkspace: {
        ...task.dockerWorkspace,
        state: "discarded",
        discardedAt: new Date().toISOString(),
      },
    });
    return { discarded: true, requiresConfirmation: false, changedFiles: patch.changedFiles, patchBytes };
  } catch (error) {
    return {
      discarded: false,
      requiresConfirmation: false,
      changedFiles: patch.changedFiles,
      patchBytes,
      error: `Docker 私有副本未丢弃：${compactCommandError(error)}`,
    };
  }
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    await git(path, "rev-parse", "--git-dir");
    return true;
  } catch {
    return false;
  }
}

/** Resolve persisted PiWin task identity when a saved session is reopened. */
export async function findManagedTaskForWorktreePath(worktreePath: string): Promise<WorktreeTaskRef | undefined> {
  try {
    const root = await primaryRoot(worktreePath);
    const branch = await git(worktreePath, "branch", "--show-current");
    if (!branch) return undefined;
    const task = await findTask(root, worktreePath, branch);
    return task ? toTaskRef(task) : undefined;
  } catch {
    // Ordinary folders and legacy sessions do not have PiWin task metadata.
    return undefined;
  }
}

async function refExists(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

export async function createWorktree(
  projectPath: string,
  taskHint?: string,
  baseBranch?: string,
): Promise<WorktreeCreateResult> {
  const root = await primaryRoot(projectPath);
  await assertCleanPrimary(root);
  const targetBranch = (await git(root, "branch", "--show-current")) || "HEAD";
  if (targetBranch === "HEAD") {
    throw new Error("主工作区处于 detached HEAD，无法创建可安全合并的任务分支");
  }
  const targetCommit = await git(root, "rev-parse", "HEAD");
  const baseRef = baseBranch || targetBranch;
  const baseCommit = await git(root, "rev-parse", "--verify", `${baseRef}^{commit}`);
  const container = taskWorktreeContainer(root);
  await mkdir(container, { recursive: true });
  const hint = slugify(taskHint ?? "task");

  for (let i = 0; i < 8; i++) {
    const stamp = new Date().toISOString().slice(5, 19).replace(/[-:T]/g, "");
    const slug = i === 0 ? `${hint}-${stamp}` : `${hint}-${stamp}-${i + 1}`;
    const branch = `piwin/task/${slug}`;
    const worktreePath = join(container, slug);
    if ((await refExists(root, branch))) continue;
    try {
      await git(root, "worktree", "add", "-b", branch, worktreePath, baseCommit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already exists|already registered/i.test(message)) continue;
      throw error;
    }
    const task: PersistedTask = {
      id: randomUUID(),
      root,
      worktreePath,
      branch,
      baseRef,
      baseCommit,
      targetBranch,
      targetCommit,
      state: "active",
      createdAt: new Date().toISOString(),
    };
    try {
      const store = await readTaskStore(root);
      store.tasks.push(task);
      await writeTaskStore(root, store);
      return { path: worktreePath, branch, task: toTaskRef(task) };
    } catch (error) {
      // A task without its identity record must never be left runnable.
      try {
        await git(root, "worktree", "remove", "--force", worktreePath);
        await git(root, "branch", "-D", branch);
      } catch {
        // Preserve the original metadata failure; Git's recovery commands can be run manually.
      }
      throw error;
    }
  }

  throw new Error("无法创建并行任务：分支名冲突，请稍后重试");
}

export interface BranchList {
  /** branch currently checked out in the main working copy ("HEAD" when detached) */
  current: string;
  /** local branches, most recently committed first */
  branches: string[];
}

export async function listBranches(projectPath: string): Promise<BranchList> {
  const root = await primaryRoot(projectPath);
  const current = (await git(root, "branch", "--show-current")) || "HEAD";
  const out = await git(root, "branch", "--format=%(refname:short)", "--sort=-committerdate");
  return { current, branches: out.split("\n").filter(Boolean) };
}

export async function listWorktrees(projectPath: string): Promise<WorktreeInfo[]> {
  const root = await primaryRoot(projectPath);
  const [listed, store] = await Promise.all([
    git(root, "worktree", "list", "--porcelain"),
    readTaskStore(root),
  ]);
  return parseWorktreeList(listed).map((worktree) => {
    const task = store.tasks.find(
      (candidate) => samePath(candidate.worktreePath, worktree.path) && candidate.branch === worktree.branch,
    );
    return task ? { ...worktree, task: toTaskRef(task) } : worktree;
  });
}

async function legacyRemoveWorktree(root: string, worktreePath: string, branch?: string): Promise<void> {
  const dirty = await git(worktreePath, "status", "--porcelain", "--untracked-files=all");
  if (dirty) {
    throw new Error("任务 worktree 有未审核改动；请在 PiWin 中显式丢弃，或先自行提交。");
  }
  await git(root, "worktree", "remove", worktreePath);
  if (branch) {
    try {
      await git(root, "branch", "-d", branch);
    } catch {
      // Keep a branch with unmerged commits for manual recovery.
    }
  }
}

/** Legacy compatibility entry point. PiWin-managed tasks must use discardTask. */
export async function removeWorktree(
  projectPath: string,
  worktreePath: string,
  branch?: string,
): Promise<void> {
  const root = await primaryRoot(projectPath);
  const task = branch ? await findTask(root, worktreePath, branch) : undefined;
  if (task) {
    const result = await discardTask(root, worktreePath, task.branch, task.id, false);
    if (result.requiresConfirmation) {
      throw new Error("此任务可能包含改动；请使用“丢弃任务”并确认删除。");
    }
    if (!result.discarded) throw new Error(result.error ?? "无法清理任务 worktree");
    return;
  }
  if (!branch?.startsWith("pi/")) {
    throw new Error("只允许清理 PiWin 创建的 legacy pi/* worktree");
  }
  await legacyRemoveWorktree(root, worktreePath, branch);
}

export async function worktreeStatus(
  projectPath: string,
  worktreePath: string,
  branch: string,
  taskId?: string,
): Promise<WorktreeStatusInfo> {
  const root = await primaryRoot(projectPath);
  const task = await findTask(root, worktreePath, branch, taskId);
  const mainBranch = (await git(root, "branch", "--show-current")) || "HEAD";
  const mainHead = await git(root, "rev-parse", "HEAD");
  const mainStatus = await git(root, "status", "--porcelain", "--untracked-files=all");
  const status = await git(worktreePath, "status", "--porcelain", "--untracked-files=all");
  const dirtyFiles = status ? status.split("\n").filter(Boolean).length : 0;
  const base = task?.baseCommit ?? mainHead;
  let ahead = 0;
  let changedFiles: string[] = [];
  try {
    ahead = Number(await git(root, "rev-list", "--count", `${base}..${branch}`));
    const [diff, untracked] = await Promise.all([
      git(worktreePath, "diff", "--name-only", base),
      git(worktreePath, "ls-files", "--others", "--exclude-standard"),
    ]);
    changedFiles = [...new Set([...diff.split("\n"), ...untracked.split("\n")].filter(Boolean))];
  } catch {
    // A legacy task can have no shared history. Its basic dirty state remains useful.
  }
  if (!task) return { mainBranch, dirtyFiles, ahead, changedFiles };

  const taskHead = await git(worktreePath, "rev-parse", "HEAD");
  return {
    mainBranch,
    dirtyFiles,
    ahead,
    changedFiles,
    task: {
      taskId: task.id,
      state: task.state,
      baseCommit: task.baseCommit,
      targetAdvanced: mainHead !== task.targetCommit || Boolean(mainStatus),
      targetBranchChanged: mainBranch !== task.targetBranch,
      taskChangedAfterReview:
        task.state === "review_ready" &&
        (Boolean(status) || !task.reviewCommit || task.reviewCommit !== taskHead),
    },
  };
}

/** Freeze the current task branch into an isolated review snapshot. */
export async function prepareWorktreeReview(
  projectPath: string,
  worktreePath: string,
  branch: string,
  taskId: string,
): Promise<WorktreeStatusInfo> {
  const root = await primaryRoot(projectPath);
  const task = await requireTask(root, worktreePath, branch, taskId);
  if (task.state === "merged" || task.state === "discarded") {
    throw new Error("已完成的任务不能再次进入审核");
  }
  if (task.dockerWorkspace?.state === "ready") {
    throw new Error("Docker 私有副本仍在保留改动。请先导入补丁或显式丢弃该副本，再准备审核。");
  }
  await commitTaskSnapshot(worktreePath, branch, task.id);
  const reviewCommit = await git(worktreePath, "rev-parse", "HEAD");
  await updateTask(root, task.id, {
    state: "review_ready",
    reviewedAt: new Date().toISOString(),
    reviewCommit,
  });
  return worktreeStatus(root, worktreePath, branch, task.id);
}

/**
 * Merge only a previously frozen review snapshot. The primary worktree must
 * still be clean and on the branch/commit captured when this task was created.
 */
export async function mergeWorktree(
  projectPath: string,
  worktreePath: string,
  branch: string,
  taskId: string,
  message?: string,
): Promise<WorktreeMergeResult> {
  const root = await primaryRoot(projectPath);
  const task = await requireTask(root, worktreePath, branch, taskId);
  const mainBranch = (await git(root, "branch", "--show-current")) || "HEAD";
  if (task.state !== "review_ready") {
    return { merged: false, mainBranch, mergedCommits: 0, error: "请先将任务标记为“准备审核”" };
  }
  if (task.dockerWorkspace?.state === "ready") {
    return { merged: false, mainBranch, mergedCommits: 0, error: "Docker 私有副本尚未导入或丢弃，拒绝合并。" };
  }
  if (mainBranch !== task.targetBranch) {
    return { merged: false, mainBranch, mergedCommits: 0, error: `主工作区当前为 ${mainBranch}，任务目标为 ${task.targetBranch}` };
  }
  try {
    await assertCleanPrimary(root);
  } catch (error) {
    return { merged: false, mainBranch, mergedCommits: 0, error: (error as Error).message };
  }
  const mainHead = await git(root, "rev-parse", "HEAD");
  if (mainHead !== task.targetCommit) {
    return {
      merged: false,
      mainBranch,
      mergedCommits: 0,
      error: "主分支在任务创建后发生变化；请先人工处理/rebase 任务，再重新审核。",
    };
  }
  const dirty = await git(worktreePath, "status", "--porcelain", "--untracked-files=all");
  const taskHead = await git(worktreePath, "rev-parse", "HEAD");
  if (dirty || !task.reviewCommit || taskHead !== task.reviewCommit) {
    return {
      merged: false,
      mainBranch,
      mergedCommits: 0,
      error: "任务在审核快照后又发生变化；请重新准备审核。",
    };
  }
  const mergedCommits = Number(await git(root, "rev-list", "--count", `${mainBranch}..${branch}`).catch(() => "0"));
  if (mergedCommits === 0) {
    await updateTask(root, task.id, { state: "merged", mergedAt: new Date().toISOString() });
    return { merged: true, mainBranch, mergedCommits: 0 };
  }
  try {
    await git(root, "merge", "--no-ff", branch, "-m", message || `Merge PiWin task ${branch}`);
    await updateTask(root, task.id, { state: "merged", mergedAt: new Date().toISOString() });
    return { merged: true, mainBranch, mergedCommits };
  } catch (error) {
    try {
      await git(root, "merge", "--abort");
    } catch {
      // no merge in progress
    }
    const detail = error instanceof Error ? error.message : String(error);
    return {
      merged: false,
      mainBranch,
      mergedCommits: 0,
      error: `合并冲突或失败，已回退：${detail.split("\n").slice(-3).join(" ").slice(0, 240)}`,
    };
  }
}

/** Delete a task only after the caller has made an explicit discard decision. */
export async function discardTask(
  projectPath: string,
  worktreePath: string,
  branch: string,
  taskId: string,
  confirmed: boolean,
): Promise<WorktreeDiscardResult> {
  const root = await primaryRoot(projectPath);
  const task = await requireTask(root, worktreePath, branch, taskId);
  const status = await worktreeStatus(root, worktreePath, branch, task.id);
  let privateChanges = false;
  if (task.dockerWorkspace?.state === "ready") {
    try {
      privateChanges = (await readDockerTaskPatch(task)).changedFiles.length > 0;
    } catch {
      // If the private copy cannot be inspected, err on the side of asking for
      // an explicit destructive decision before removing the task and volume.
      privateChanges = true;
    }
  }
  const hasChanges = status.dirtyFiles > 0 || status.ahead > 0 || privateChanges;
  if (!confirmed && task.state !== "merged" && hasChanges) {
    return {
      discarded: false,
      requiresConfirmation: true,
      dirtyFiles: status.dirtyFiles,
      ahead: status.ahead,
    };
  }
  try {
    const now = new Date().toISOString();
    let dockerWorkspace = task.dockerWorkspace;
    if (dockerWorkspace && dockerWorkspace.state !== "discarded") {
      await removeDockerVolume(dockerWorkspace.volume);
      dockerWorkspace = {
        ...dockerWorkspace,
        state: "discarded",
        discardedAt: now,
      };
    }
    await git(root, "worktree", "remove", "--force", task.worktreePath);
    await git(root, "branch", "-D", task.branch);
    await updateTask(root, task.id, { state: "discarded", discardedAt: now, dockerWorkspace });
    return {
      discarded: true,
      requiresConfirmation: false,
      dirtyFiles: status.dirtyFiles,
      ahead: status.ahead,
    };
  } catch (error) {
    return {
      discarded: false,
      requiresConfirmation: false,
      dirtyFiles: status.dirtyFiles,
      ahead: status.ahead,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
