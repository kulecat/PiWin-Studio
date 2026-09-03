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
  WslTaskPatchDiscardResult,
  WslTaskPatchImportResult,
  WslTaskPatchPreview,
  WslTaskWorkspaceState,
  WorktreeTaskAuditEvent,
  WorktreeTaskAuditEventKind,
  WorktreeCheckpointKind,
  WorktreeCheckpointRestoreResult,
  WorktreeDiscardResult,
  WorktreeMergeResult,
  WorktreeQueueResult,
  WorktreeStatusInfo,
  WorktreeTaskDashboard,
  WorktreeTaskDashboardItem,
  WorktreeTaskCheckpoint,
  WorktreeTaskRef,
  WorktreeTaskState,
} from "@shared/protocol";
import { getDockerSandboxProfile, windowsPathToWsl } from "../host/windows-execution";
import {
  dockerFilteredWorkspaceCopyCommand,
  DOCKER_NON_SOURCE_FILE_GLOBS,
  DOCKER_SECRET_FILE_GLOBS,
} from "../host/docker-credential-policy";

const exec = promisify(execFile);
const TASKS_FILE = "piwin-tasks.json";
const TASKS_SCHEMA_VERSION = 4;
const TASK_AUDIT_EVENT_LIMIT = 600;
const DOCKER_PRIVATE_VOLUME_PREFIX = "piwin-task-";
const DOCKER_PRIVATE_BASE_REF = "refs/piwin/private-base";
const WSL_PRIVATE_BASE_REF = "refs/piwin/wsl-private-base";

interface DockerTaskWorkspaceRecord {
  volume: string;
  state: DockerTaskWorkspaceState;
  sourceCommit: string;
  createdAt: string;
  importedAt?: string;
  discardedAt?: string;
}

interface WslTaskWorkspaceRecord {
  /** Native-Linux path in the selected WSL distribution, never a DrvFs path. */
  path: string;
  distribution?: string;
  mountRoot: string;
  state: WslTaskWorkspaceState;
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
  mergedCommit?: string;
  discardedAt?: string;
  /** The review/queue snapshots needed to resume a task after a host crash. */
  checkpoints?: WorktreeTaskCheckpoint[];
  queuedAt?: string;
  queueBlocked?: {
    reason: string;
    conflictingFiles?: string[];
    checkedAt: string;
  };
  /** User-declared project-relative paths used for conservative conflict warnings. */
  pathClaims?: string[];
  dockerWorkspace?: DockerTaskWorkspaceRecord;
  wslWorkspace?: WslTaskWorkspaceRecord;
}

interface MergeQueueEntry {
  taskId: string;
  queuedAt: string;
  message?: string;
}

interface TaskStore {
  version: number;
  tasks: PersistedTask[];
  mergeQueue: MergeQueueEntry[];
  auditEvents: WorktreeTaskAuditEvent[];
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

/**
 * Run one non-interactive command in WSL without shell-concatenating user
 * input. Unlike `git()`, callers receive raw stdout so NUL-separated names
 * and unified-diff final newlines remain intact.
 */
async function wsl(
  distribution: string | undefined,
  args: string[],
  options: { timeout?: number; maxBuffer?: number } = {},
): Promise<string> {
  if (process.platform !== "win32") throw new Error("WSL 私有副本仅支持 Windows 主机");
  const distributionArgs = distribution ? ["--distribution", distribution] : [];
  const { stdout } = await exec("wsl.exe", [...distributionArgs, "--exec", ...args], {
    timeout: options.timeout ?? 180_000,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    windowsHide: true,
  });
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
    // Older versions predate durable events, path claims, or native WSL task
    // copies. Upgrade in
    // memory and write the new shape only after the next normal mutation.
    if (
      (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3 && parsed.version !== TASKS_SCHEMA_VERSION) ||
      !Array.isArray(parsed.tasks)
    ) {
      throw new Error("unsupported task metadata");
    }
    return {
      version: TASKS_SCHEMA_VERSION,
      tasks: (parsed.tasks as PersistedTask[]).map((task) => ({
        ...task,
        checkpoints: task.checkpoints ?? [],
        pathClaims: task.pathClaims ?? [],
      })),
      mergeQueue: Array.isArray(parsed.mergeQueue) ? parsed.mergeQueue : [],
      auditEvents: Array.isArray(parsed.auditEvents) ? parsed.auditEvents : [],
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { version: TASKS_SCHEMA_VERSION, tasks: [], mergeQueue: [], auditEvents: [] };
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
    checkpointCount: task.checkpoints?.length ?? 0,
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

async function appendTaskCheckpoint(
  root: string,
  task: PersistedTask,
  kind: WorktreeCheckpointKind,
  commit: string,
  targetCommit: string,
): Promise<PersistedTask> {
  const checkpoint: WorktreeTaskCheckpoint = {
    id: randomUUID(),
    kind,
    commit,
    targetCommit,
    createdAt: new Date().toISOString(),
  };
  return updateTask(root, task.id, {
    checkpoints: [...(task.checkpoints ?? []), checkpoint],
  });
}

function latestCheckpoint(task: PersistedTask): WorktreeTaskCheckpoint | undefined {
  return task.checkpoints?.at(-1);
}

async function appendTaskAuditEvent(
  root: string,
  taskId: string,
  kind: WorktreeTaskAuditEventKind,
  options: Pick<WorktreeTaskAuditEvent, "detail" | "files" | "checkpointId"> = {},
): Promise<void> {
  const store = await readTaskStore(root);
  store.auditEvents = [
    ...store.auditEvents,
    {
      id: randomUUID(),
      taskId,
      kind,
      createdAt: new Date().toISOString(),
      ...options,
      files: options.files?.slice(0, 64),
    },
  ].slice(-TASK_AUDIT_EVENT_LIMIT);
  await writeTaskStore(root, store);
}

function normalizePathClaim(value: string): string | undefined {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/i.test(normalized)) return undefined;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  return normalized.slice(0, 240);
}

function normalizePathClaims(claims: string[]): string[] {
  const normalized = claims
    .flatMap((claim) => claim.split(/[\r\n,]/))
    .map(normalizePathClaim)
    .filter((claim): claim is string => Boolean(claim));
  return [...new Set(normalized)].sort().slice(0, 64);
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function overlappingPaths(left: string[], right: string[]): string[] {
  const overlaps = new Set<string>();
  for (const leftPath of left) {
    for (const rightPath of right) {
      if (!pathsOverlap(leftPath, rightPath)) continue;
      overlaps.add(leftPath === rightPath ? leftPath : `${leftPath} ↔ ${rightPath}`);
    }
  }
  return [...overlaps].sort().slice(0, 64);
}

function dockerVolumeName(task: PersistedTask): string {
  return `${DOCKER_PRIVATE_VOLUME_PREFIX}${task.id.replaceAll("-", "").slice(0, 24)}`;
}

function dockerTaskMount(volume: string): string {
  return ["type=volume", `src=${volume}`, "dst=/workspace"].join(",");
}

function validWslDistribution(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > 120 || /[\0\r\n]/.test(normalized)) {
    throw new Error("WSL 发行版名称无效");
  }
  return normalized;
}

function validWslMountRoot(value: string | undefined): string {
  const withForwardSlashes = value?.trim().replaceAll("\\", "/");
  const normalized = withForwardSlashes === "/" ? "/" : withForwardSlashes?.replace(/\/+$/, "");
  if (!normalized || !normalized.startsWith("/") || normalized.length > 120) {
    throw new Error("WSL 挂载根目录必须是绝对 Linux 路径");
  }
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new Error("WSL 挂载根目录不能包含 ..");
  }
  return normalized;
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
    throw new Error("私有副本补丁只能导入尚未审核的活动任务");
  }
  const [dirty, head] = await Promise.all([
    git(task.worktreePath, "status", "--porcelain", "--untracked-files=all"),
    git(task.worktreePath, "rev-parse", "HEAD"),
  ]);
  if (dirty || head !== task.baseCommit) {
    throw new Error("任务 worktree 已有宿主机改动或提交，拒绝混合导入私有副本补丁。请先审核、提交或丢弃其中一侧的改动。");
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

/** Configuration resolved from the selected WSL2 runner before a chat starts. */
export interface WslTaskWorkspaceOptions {
  distribution?: string;
  mountRoot?: string;
}

interface WslTaskWorkspaceForChat {
  /** Native Linux path under $HOME/.piwin/task-sandboxes, never a DrvFs path. */
  path: string;
  distribution?: string;
  mountRoot: string;
}

interface ResolvedWslTaskWorkspaceOptions {
  distribution?: string;
  mountRoot: string;
}

interface WslPatchData {
  patch: string;
  changedFiles: string[];
}

function wslWorkspaceOptions(options: WslTaskWorkspaceOptions = {}): ResolvedWslTaskWorkspaceOptions {
  return {
    distribution: validWslDistribution(options.distribution ?? process.env.PIWIN_WSL_DISTRIBUTION),
    mountRoot: validWslMountRoot(options.mountRoot ?? process.env.PIWIN_WSL_MOUNT_ROOT ?? "/mnt"),
  };
}

function isTaskId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function wslPrivateWorkspaceScript(
  script: string,
  workspace: string,
  taskId: string,
): string[] {
  if (!isTaskId(taskId)) throw new Error("WSL 私有副本任务标识无效");
  // `sh -lc` receives the script as one opaque argument. The workspace path
  // remains a positional parameter throughout; it is never interpolated into
  // shell source or a destructive command.
  return ["sh", "-lc", script, "piwin", workspace, taskId];
}

function wslFilteredWorkspaceCopyCommand(): string {
  const quote = (value: string): string => `'${value.replaceAll("'", `"'"`)}'`;
  const excludes = [".git", ...DOCKER_SECRET_FILE_GLOBS, ...DOCKER_NON_SOURCE_FILE_GLOBS]
    .map((pattern) => `--exclude=${quote(pattern)}`)
    .join(" ");
  return `tar -C "$source" ${excludes} -cf - . | tar -C "$staging" -xf -`;
}

function wslWorkspaceGuardScript(command: string): string {
  return [
    "set -eu",
    'workspace="$1"',
    'task_id="$2"',
    'base="$HOME/.piwin/task-sandboxes"',
    'expected="$base/$task_id"',
    'case "$workspace" in "$base"/*) ;; *) echo "PiWin refused an unsafe WSL workspace path" >&2; exit 64;; esac',
    'test "$workspace" = "$expected" || { echo "PiWin WSL workspace does not match the task" >&2; exit 64; }',
    command,
  ].join("\n");
}

async function wslWorkspaceExists(
  workspace: WslTaskWorkspaceRecord,
  taskId: string,
): Promise<boolean> {
  const script = wslWorkspaceGuardScript('test -d "$workspace/.git"');
  try {
    await wsl(
      workspace.distribution,
      wslPrivateWorkspaceScript(script, workspace.path, taskId),
      { timeout: 20_000, maxBuffer: 1024 * 1024 },
    );
    return true;
  } catch {
    return false;
  }
}

async function initializeWslTaskWorkspace(
  task: PersistedTask,
  options: ResolvedWslTaskWorkspaceOptions,
): Promise<string> {
  if (!isTaskId(task.id)) throw new Error("WSL 私有副本任务标识无效");
  const source = windowsPathToWsl(task.worktreePath, options.mountRoot);
  const bootstrap = [
    "set -eu",
    "umask 077",
    'source="$1"',
    'task_id="$2"',
    'base="$HOME/.piwin/task-sandboxes"',
    'workspace="$base/$task_id"',
    'test -d "$source" || { echo "PiWin task source is not visible inside WSL" >&2; exit 66; }',
    'test ! -e "$workspace" || { echo "PiWin WSL task copy already exists" >&2; exit 17; }',
    'mkdir -p "$base"',
    'staging="$(mktemp -d "$base/.seed-$task_id.XXXXXX")"',
    'cleanup() { rm -rf -- "$staging"; }',
    "trap cleanup EXIT HUP INT TERM",
    wslFilteredWorkspaceCopyCommand(),
    'git -C "$staging" init -q',
    'git -C "$staging" config user.name "PiWin Studio"',
    'git -C "$staging" config user.email "piwin@desktop.local"',
    'git -C "$staging" add -A',
    'git -C "$staging" commit --allow-empty -qm "PiWin WSL private task base"',
    `git -C "$staging" update-ref ${WSL_PRIVATE_BASE_REF} HEAD`,
    'mv "$staging" "$workspace"',
    'trap - EXIT HUP INT TERM',
    'printf "%s\\n" "$workspace"',
  ].join("\n");
  const output = await wsl(
    options.distribution,
    ["sh", "-lc", bootstrap, "piwin", source, task.id],
    { timeout: 300_000 },
  );
  const workspace = output.trim();
  if (!workspace.startsWith("/") || workspace.includes("\0") || workspace.includes("\r") || workspace.includes("\n")) {
    throw new Error("WSL 私有副本返回了无效路径");
  }
  return workspace;
}

async function assertWslTaskSource(task: PersistedTask): Promise<void> {
  if (task.state !== "active") {
    throw new Error("只有处于活动状态且尚未审核的 PiWin 任务可以启用 WSL 私有副本");
  }
  const [dirty, head] = await Promise.all([
    git(task.worktreePath, "status", "--porcelain", "--untracked-files=all"),
    git(task.worktreePath, "rev-parse", "HEAD"),
  ]);
  if (dirty || head !== task.baseCommit) {
    throw new Error("WSL 私有副本只能从未修改的任务基线创建；请先审核或丢弃当前任务，再新建任务。");
  }
}

/**
 * Make a private native-Linux task snapshot. The Windows worktree is used
 * only as controlled one-time copy input; subsequent edits and patch reads
 * target $HOME/.piwin/task-sandboxes/<task-id> inside WSL.
 */
export async function prepareWslTaskWorkspaceForChat(
  worktreePath: string,
  requestedOptions: WslTaskWorkspaceOptions = {},
): Promise<WslTaskWorkspaceForChat> {
  const options = wslWorkspaceOptions(requestedOptions);
  const root = await primaryRoot(worktreePath);
  const branch = await git(worktreePath, "branch", "--show-current");
  if (!branch) throw new Error("WSL 可写模式要求当前目录是已签出的 PiWin 任务分支");
  const task = await findTask(root, worktreePath, branch);
  if (!task) throw new Error("WSL 可写模式只允许 PiWin 受控任务 worktree；请先创建一个新任务。");
  if (task.dockerWorkspace?.state === "ready") {
    throw new Error("此任务仍有 Docker 私有副本。请先导入或丢弃该副本，再创建 WSL 私有副本。");
  }

  const existing = task.wslWorkspace;
  if (existing?.state === "imported" || existing?.state === "discarded") {
    throw new Error("此任务的 WSL 私有副本已经结束。请审核它的改动并新建下一个任务。");
  }
  if (existing?.state === "ready") {
    if (existing.distribution === options.distribution && existing.mountRoot === options.mountRoot &&
      (await wslWorkspaceExists(existing, task.id))) {
      return { path: existing.path, distribution: existing.distribution, mountRoot: existing.mountRoot };
    }
    throw new Error("WSL 私有副本元数据存在，但原生副本不可用或与当前 WSL 设置不一致；请先显式丢弃该副本。");
  }

  await assertWslTaskSource(task);
  let path: string;
  try {
    path = await initializeWslTaskWorkspace(task, options);
  } catch (error) {
    throw new Error(`无法创建 WSL 私有任务副本：${compactCommandError(error)}`);
  }
  const record: WslTaskWorkspaceRecord = {
    path,
    distribution: options.distribution,
    mountRoot: options.mountRoot,
    state: "ready",
    sourceCommit: task.baseCommit,
    createdAt: new Date().toISOString(),
  };
  await updateTask(root, task.id, { wslWorkspace: record });
  await appendTaskAuditEvent(root, task.id, "wsl_copy_created", {
    detail: `Native WSL private copy created in ${options.distribution ?? "default distribution"}`,
  });
  return { path, distribution: record.distribution, mountRoot: record.mountRoot };
}

async function readWslTaskPatch(task: PersistedTask): Promise<WslPatchData> {
  const workspace = task.wslWorkspace;
  if (!workspace || workspace.state !== "ready") return { patch: "", changedFiles: [] };
  const prefix = wslWorkspaceGuardScript([
    'test -d "$workspace/.git" || { echo "PiWin WSL private copy is missing" >&2; exit 66; }',
    'git -C "$workspace" add -N -- .',
  ].join("\n"));
  try {
    const names = await wsl(
      workspace.distribution,
      wslPrivateWorkspaceScript(`${prefix}\ngit -C "$workspace" diff --name-only -z ${WSL_PRIVATE_BASE_REF}`, workspace.path, task.id),
      { timeout: 120_000 },
    );
    const patch = await wsl(
      workspace.distribution,
      wslPrivateWorkspaceScript(`${prefix}\ngit -C "$workspace" diff --binary --no-ext-diff --full-index ${WSL_PRIVATE_BASE_REF}`, workspace.path, task.id),
      { timeout: 120_000 },
    );
    return { patch, changedFiles: names.split("\0").filter(Boolean) };
  } catch (error) {
    throw new Error(`无法读取 WSL 私有副本：${compactCommandError(error)}`);
  }
}

async function removeWslTaskWorkspace(workspace: WslTaskWorkspaceRecord, taskId: string): Promise<void> {
  const script = wslWorkspaceGuardScript('rm -rf -- "$workspace"');
  await wsl(workspace.distribution, wslPrivateWorkspaceScript(script, workspace.path, taskId), {
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
}

async function requireWslTask(
  projectPath: string,
  worktreePath: string,
  branch: string,
  taskId: string,
): Promise<{ root: string; task: PersistedTask }> {
  const root = await primaryRoot(projectPath);
  const task = await requireTask(root, worktreePath, branch, taskId);
  return { root, task };
}

export async function previewWslTaskPatch(
  projectPath: string,
  worktreePath: string,
  branch: string,
  taskId: string,
): Promise<WslTaskPatchPreview> {
  const { task } = await requireWslTask(projectPath, worktreePath, branch, taskId);
  const state = task.wslWorkspace?.state;
  if (!state) return { state: "unavailable", changedFiles: [], patchBytes: 0 };
  if (state !== "ready") return { state, changedFiles: [], patchBytes: 0 };
  try {
    const patch = await readWslTaskPatch(task);
    return { state, changedFiles: patch.changedFiles, patchBytes: Buffer.byteLength(patch.patch, "utf8") };
  } catch (error) {
    return {
      state,
      changedFiles: [],
      patchBytes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function importWslTaskPatch(
  projectPath: string,
  worktreePath: string,
  branch: string,
  taskId: string,
  confirmed: boolean,
): Promise<WslTaskPatchImportResult> {
  const { root, task } = await requireWslTask(projectPath, worktreePath, branch, taskId);
  if (task.wslWorkspace?.state !== "ready") {
    return { imported: false, requiresConfirmation: false, changedFiles: [], patchBytes: 0, error: "没有可导入的 WSL 私有副本" };
  }
  let patch: WslPatchData = { patch: "", changedFiles: [] };
  try {
    patch = await readWslTaskPatch(task);
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
    return { imported: false, requiresConfirmation: false, changedFiles: [], patchBytes: 0, error: "WSL 私有副本没有可导入的代码改动" };
  }

  const tempDir = await mkdtemp(join(tmpdir(), "piwin-wsl-patch-"));
  const patchPath = join(tempDir, "task.patch");
  try {
    await writeFile(patchPath, patch.patch, "utf8");
    await git(worktreePath, "apply", "--check", "--binary", "--whitespace=nowarn", patchPath);
    if (!confirmed) return { imported: false, requiresConfirmation: true, changedFiles: patch.changedFiles, patchBytes };

    await git(worktreePath, "apply", "--binary", "--whitespace=nowarn", patchPath);
    try {
      await removeWslTaskWorkspace(task.wslWorkspace, task.id);
    } catch (error) {
      await updateTask(root, task.id, {
        wslWorkspace: { ...task.wslWorkspace, state: "imported", importedAt: new Date().toISOString() },
      });
      await appendTaskAuditEvent(root, task.id, "wsl_patch_imported", { files: patch.changedFiles });
      return {
        imported: true,
        requiresConfirmation: false,
        changedFiles: patch.changedFiles,
        patchBytes,
        error: `补丁已导入，但 WSL 私有副本清理失败：${compactCommandError(error)}`,
      };
    }
    await updateTask(root, task.id, {
      wslWorkspace: { ...task.wslWorkspace, state: "imported", importedAt: new Date().toISOString() },
    });
    await appendTaskAuditEvent(root, task.id, "wsl_patch_imported", { files: patch.changedFiles });
    return { imported: true, requiresConfirmation: false, changedFiles: patch.changedFiles, patchBytes };
  } catch (error) {
    return {
      imported: false,
      requiresConfirmation: false,
      changedFiles: patch.changedFiles,
      patchBytes,
      error: `WSL 补丁未导入：${compactCommandError(error)}`,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function discardWslTaskPatch(
  projectPath: string,
  worktreePath: string,
  branch: string,
  taskId: string,
  confirmed: boolean,
): Promise<WslTaskPatchDiscardResult> {
  const { root, task } = await requireWslTask(projectPath, worktreePath, branch, taskId);
  if (task.wslWorkspace?.state !== "ready") {
    return { discarded: false, requiresConfirmation: false, changedFiles: [], patchBytes: 0, error: "没有可丢弃的 WSL 私有副本" };
  }
  let patch: WslPatchData = { patch: "", changedFiles: [] };
  try {
    patch = await readWslTaskPatch(task);
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
    await removeWslTaskWorkspace(task.wslWorkspace, task.id);
    await updateTask(root, task.id, {
      wslWorkspace: { ...task.wslWorkspace, state: "discarded", discardedAt: new Date().toISOString() },
    });
    await appendTaskAuditEvent(root, task.id, "wsl_copy_discarded", { files: patch.changedFiles });
    return { discarded: true, requiresConfirmation: false, changedFiles: patch.changedFiles, patchBytes };
  } catch (error) {
    return {
      discarded: false,
      requiresConfirmation: false,
      changedFiles: patch.changedFiles,
      patchBytes,
      error: `WSL 私有副本未丢弃：${compactCommandError(error)}`,
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
      checkpoints: [{
        id: randomUUID(),
        kind: "created",
        commit: baseCommit,
        targetCommit,
        createdAt: new Date().toISOString(),
      }],
    };
    try {
      const store = await readTaskStore(root);
      store.tasks.push(task);
      store.auditEvents = [
        ...store.auditEvents,
        {
          id: randomUUID(),
          taskId: task.id,
          kind: "task_created" as const,
          createdAt: task.createdAt,
          detail: `Created ${branch} from ${baseRef}`,
        },
      ].slice(-TASK_AUDIT_EVENT_LIMIT);
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

async function changedPathsForDashboard(task: PersistedTask): Promise<string[]> {
  if (task.state === "merged" || task.state === "discarded") return [];
  try {
    const [diff, untracked] = await Promise.all([
      git(task.worktreePath, "diff", "--name-only", "--diff-filter=ACDMRT", `${task.baseCommit}..HEAD`),
      git(task.worktreePath, "ls-files", "--others", "--exclude-standard"),
    ]);
    return [...new Set([...diff.split("\n"), ...untracked.split("\n")].filter(Boolean))].sort().slice(0, 256);
  } catch {
    // A manually removed/repaired worktree still deserves an auditable card.
    return [];
  }
}

function isMutableTask(task: PersistedTask): boolean {
  return task.state === "active" || task.state === "review_ready" || task.state === "merge_queued";
}

async function buildWorktreeTaskDashboard(root: string): Promise<WorktreeTaskDashboard> {
  const store = await readTaskStore(root);
  const visibleTasks = store.tasks.filter((task) => task.state !== "discarded");
  const changedPaths = await Promise.all(visibleTasks.map((task) => changedPathsForDashboard(task)));
  const events = [...store.auditEvents]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 160);
  const lastEventByTask = new Map<string, WorktreeTaskAuditEvent>();
  for (const event of events) {
    if (!lastEventByTask.has(event.taskId)) lastEventByTask.set(event.taskId, event);
  }

  const items: WorktreeTaskDashboardItem[] = visibleTasks.map((task, index) => {
    const queueIndex = store.mergeQueue.findIndex((entry) => entry.taskId === task.id);
    return {
      taskId: task.id,
      worktreePath: task.worktreePath,
      branch: task.branch,
      state: task.state,
      createdAt: task.createdAt,
      targetBranch: task.targetBranch,
      checkpointCount: task.checkpoints?.length ?? 0,
      claimedPaths: task.pathClaims ?? [],
      changedPaths: changedPaths[index],
      conflicts: [],
      queue: queueIndex >= 0 && task.queuedAt
        ? {
            position: queueIndex + 1,
            queuedAt: task.queuedAt,
            blockedReason: task.queueBlocked?.reason,
            conflictingFiles: task.queueBlocked?.conflictingFiles,
          }
        : undefined,
      lastEvent: lastEventByTask.get(task.id),
    };
  });

  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    const left = items[leftIndex];
    const leftTask = visibleTasks[leftIndex];
    if (!isMutableTask(leftTask)) continue;
    const leftPaths = [...left.claimedPaths, ...left.changedPaths];
    if (leftPaths.length === 0) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      const right = items[rightIndex];
      const rightTask = visibleTasks[rightIndex];
      if (!isMutableTask(rightTask)) continue;
      const paths = overlappingPaths(leftPaths, [...right.claimedPaths, ...right.changedPaths]);
      if (paths.length === 0) continue;
      left.conflicts.push({ taskId: right.taskId, branch: right.branch, paths });
      right.conflicts.push({ taskId: left.taskId, branch: left.branch, paths });
    }
  }

  return {
    tasks: items.sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    events,
  };
}

/** Read-only Mission Control data; path overlaps are warnings, not write locks. */
export async function worktreeTaskDashboard(projectPath: string): Promise<WorktreeTaskDashboard> {
  const root = await primaryRoot(projectPath);
  return buildWorktreeTaskDashboard(root);
}

/** Persist a task's project-relative path claims for conservative overlap warnings. */
export async function setWorktreePathClaims(
  projectPath: string,
  worktreePath: string,
  branch: string,
  taskId: string,
  claims: string[],
): Promise<WorktreeTaskDashboard> {
  const root = await primaryRoot(projectPath);
  return withMergeQueueLock(root, async () => {
    const task = await requireTask(root, worktreePath, branch, taskId);
    if (!isMutableTask(task)) throw new Error("只能为进行中的任务声明路径。");
    const rawClaims = claims.flatMap((claim) => claim.split(/[\r\n,]/)).filter((claim) => claim.trim());
    if (rawClaims.some((claim) => !normalizePathClaim(claim))) {
      throw new Error("路径声明必须是项目内相对路径，且不能包含 .. 或盘符。");
    }
    const normalized = normalizePathClaims(claims);
    const store = await readTaskStore(root);
    const index = store.tasks.findIndex((candidate) => candidate.id === task.id);
    if (index < 0) throw new Error("PiWin 任务元数据不存在");
    store.tasks[index] = { ...store.tasks[index], pathClaims: normalized };
    store.auditEvents = [
      ...store.auditEvents,
      {
        id: randomUUID(),
        taskId: task.id,
        kind: "path_claims_updated" as const,
        createdAt: new Date().toISOString(),
        detail: normalized.length ? `Declared ${normalized.length} path claim(s)` : "Cleared path claims",
        files: normalized,
      },
    ].slice(-TASK_AUDIT_EVENT_LIMIT);
    await writeTaskStore(root, store);
    return buildWorktreeTaskDashboard(root);
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
  const queue = await readTaskStore(root);
  const queueIndex = queue.mergeQueue.findIndex((entry) => entry.taskId === task.id);
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
        (task.state === "review_ready" || task.state === "merge_queued") &&
        (Boolean(status) || !task.reviewCommit || task.reviewCommit !== taskHead),
      queue: queueIndex >= 0 && task.queuedAt
        ? {
            position: queueIndex + 1,
            queuedAt: task.queuedAt,
            blockedReason: task.queueBlocked?.reason,
            conflictingFiles: task.queueBlocked?.conflictingFiles,
          }
        : undefined,
      recovery: {
        checkpointCount: task.checkpoints?.length ?? 0,
        latest: latestCheckpoint(task),
      },
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
  if (task.dockerWorkspace?.state === "ready" || task.wslWorkspace?.state === "ready") {
    throw new Error("Docker 或 WSL 私有副本仍在保留改动。请先导入补丁或显式丢弃该副本，再准备审核。");
  }
  await commitTaskSnapshot(worktreePath, branch, task.id);
  const reviewCommit = await git(worktreePath, "rev-parse", "HEAD");
  const reviewedTask = await updateTask(root, task.id, {
    state: "review_ready",
    reviewedAt: new Date().toISOString(),
    reviewCommit,
    queuedAt: undefined,
    queueBlocked: undefined,
  });
  const checkpointedTask = await appendTaskCheckpoint(root, reviewedTask, "review", reviewCommit, task.targetCommit);
  await appendTaskAuditEvent(root, task.id, "review_prepared", {
    detail: `Prepared review snapshot ${reviewCommit.slice(0, 12)}`,
    checkpointId: latestCheckpoint(checkpointedTask)?.id,
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
  return withMergeQueueLock(root, () => mergeWorktreeAtRoot(root, worktreePath, branch, taskId, message));
}

async function mergeWorktreeAtRoot(
  root: string,
  worktreePath: string,
  branch: string,
  taskId: string,
  message?: string,
): Promise<WorktreeMergeResult> {
  const task = await requireTask(root, worktreePath, branch, taskId);
  const mainBranch = (await git(root, "branch", "--show-current")) || "HEAD";
  if (task.state !== "review_ready") {
    return { merged: false, mainBranch, mergedCommits: 0, error: "请先将任务标记为“准备审核”" };
  }
  if (task.dockerWorkspace?.state === "ready" || task.wslWorkspace?.state === "ready") {
    return { merged: false, mainBranch, mergedCommits: 0, error: "Docker 或 WSL 私有副本尚未导入或丢弃，拒绝合并。" };
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
    const mergedTask = await updateTask(root, task.id, {
      state: "merged",
      mergedAt: new Date().toISOString(),
      mergedCommit: mainHead,
    });
    const checkpointedTask = await appendTaskCheckpoint(root, mergedTask, "merged", task.reviewCommit, mainHead);
    await appendTaskAuditEvent(root, task.id, "merge_completed", {
      detail: "Review snapshot was already contained in the target branch",
      checkpointId: latestCheckpoint(checkpointedTask)?.id,
    });
    return { merged: true, mainBranch, mergedCommits: 0 };
  }
  try {
    await git(root, "merge", "--no-ff", branch, "-m", message || `Merge PiWin task ${branch}`);
    const mergedHead = await git(root, "rev-parse", "HEAD");
    const mergedTask = await updateTask(root, task.id, {
      state: "merged",
      mergedAt: new Date().toISOString(),
      mergedCommit: mergedHead,
    });
    const checkpointedTask = await appendTaskCheckpoint(root, mergedTask, "merged", task.reviewCommit, mergedHead);
    await appendTaskAuditEvent(root, task.id, "merge_completed", {
      detail: `Merged into ${mainBranch} at ${mergedHead.slice(0, 12)}`,
      checkpointId: latestCheckpoint(checkpointedTask)?.id,
    });
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

interface QueueBlocker {
  taskId: string;
  branch: string;
  reason: string;
  conflictingFiles?: string[];
}

interface QueueDrainResult {
  mergedTaskIds: string[];
  blocked?: QueueBlocker;
}

const mergeQueueTails = new Map<string, Promise<void>>();

/** Serialize queue updates per repository so two windows cannot merge at once. */
async function withMergeQueueLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const previous = mergeQueueTails.get(root) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = previous.then(() => gate);
  mergeQueueTails.set(root, tail);
  await previous;
  try {
    return await work();
  } finally {
    release?.();
    if (mergeQueueTails.get(root) === tail) mergeQueueTails.delete(root);
  }
}

async function isAncestor(root: string, older: string, newer: string): Promise<boolean> {
  try {
    await git(root, "merge-base", "--is-ancestor", older, newer);
    return true;
  } catch {
    return false;
  }
}

async function changedFilesBetween(root: string, older: string, newer: string): Promise<string[]> {
  if (older === newer) return [];
  const changed = await git(root, "diff", "--name-only", "--diff-filter=ACDMRT", older, newer);
  return changed.split("\n").filter(Boolean);
}

async function taskReviewIsStable(task: PersistedTask): Promise<string | undefined> {
  if (!task.reviewCommit) return "任务缺少审核快照；请重新准备审核。";
  if (task.dockerWorkspace?.state === "ready" || task.wslWorkspace?.state === "ready") {
    return "Docker 或 WSL 私有副本尚未导入或丢弃。";
  }
  const [dirty, head] = await Promise.all([
    git(task.worktreePath, "status", "--porcelain", "--untracked-files=all"),
    git(task.worktreePath, "rev-parse", "HEAD"),
  ]);
  if (dirty || head !== task.reviewCommit) return "任务在审核快照后发生变化；请重新准备审核。";
  return undefined;
}

async function queueBlock(
  root: string,
  task: PersistedTask,
  reason: string,
  conflictingFiles?: string[],
): Promise<QueueBlocker> {
  const unchanged =
    task.queueBlocked?.reason === reason &&
    JSON.stringify(task.queueBlocked?.conflictingFiles ?? []) === JSON.stringify(conflictingFiles ?? []);
  await updateTask(root, task.id, {
    queueBlocked: {
      reason,
      conflictingFiles: conflictingFiles?.slice(0, 64),
      checkedAt: new Date().toISOString(),
    },
  });
  if (!unchanged) {
    await appendTaskAuditEvent(root, task.id, "queue_paused", { detail: reason, files: conflictingFiles });
  }
  return { taskId: task.id, branch: task.branch, reason, conflictingFiles };
}

async function mergeQueuedTask(root: string, task: PersistedTask, entry: MergeQueueEntry): Promise<
  { merged: true } | { merged: false; blocked: QueueBlocker }
> {
  const mainBranch = (await git(root, "branch", "--show-current")) || "HEAD";
  if (mainBranch !== task.targetBranch) {
    return { merged: false, blocked: await queueBlock(root, task, `主工作区当前为 ${mainBranch}，任务目标为 ${task.targetBranch}`) };
  }
  try {
    await assertCleanPrimary(root);
  } catch (error) {
    return { merged: false, blocked: await queueBlock(root, task, (error as Error).message) };
  }
  const stableReason = await taskReviewIsStable(task);
  if (stableReason) return { merged: false, blocked: await queueBlock(root, task, stableReason) };

  const mainHead = await git(root, "rev-parse", "HEAD");
  if (!(await isAncestor(root, task.targetCommit, mainHead))) {
    return {
      merged: false,
      blocked: await queueBlock(root, task, "主分支历史已重写，无法安全重放排队任务。请人工处理后重新审核。"),
    };
  }
  if (!task.reviewCommit) {
    return { merged: false, blocked: await queueBlock(root, task, "任务缺少审核快照；请重新准备审核。") };
  }

  const [taskFiles, advancedFiles] = await Promise.all([
    changedFilesBetween(root, task.targetCommit, task.reviewCommit),
    changedFilesBetween(root, task.targetCommit, mainHead),
  ]);
  const advanced = new Set(advancedFiles);
  const conflicts = taskFiles.filter((file) => advanced.has(file));
  if (conflicts.length > 0 && !(await isAncestor(root, task.reviewCommit, mainHead))) {
    return {
      merged: false,
      blocked: await queueBlock(
        root,
        task,
        `与主分支之后的改动存在 ${conflicts.length} 个文件重叠，队列已暂停，未尝试合并。`,
        conflicts,
      ),
    };
  }

  const commits = Number(await git(root, "rev-list", "--count", `${mainHead}..${task.branch}`).catch(() => "0"));
  let mergedHead = mainHead;
  if (commits > 0) {
    try {
      await git(root, "merge", "--no-ff", "--no-commit", task.branch);
      await exec("git", ["commit", "-m", entry.message || `Merge queued PiWin task ${task.branch}`], {
        cwd: root,
        timeout: 30000,
        maxBuffer: 16 * 1024 * 1024,
        env: taskCommitEnv(),
      });
      mergedHead = await git(root, "rev-parse", "HEAD");
    } catch (error) {
      try {
        await git(root, "merge", "--abort");
      } catch {
        // No merge was in progress, or Git already cleaned it up.
      }
      return {
        merged: false,
        blocked: await queueBlock(
          root,
          task,
          `Git 合并失败，已回退：${compactCommandError(error)}`,
        ),
      };
    }
  }

  const mergedTask = await updateTask(root, task.id, {
    state: "merged",
    mergedAt: new Date().toISOString(),
    mergedCommit: mergedHead,
    queuedAt: undefined,
    queueBlocked: undefined,
  });
  const checkpointedTask = await appendTaskCheckpoint(root, mergedTask, "merged", task.reviewCommit, mergedHead);
  await appendTaskAuditEvent(root, task.id, "merge_completed", {
    detail: `Merged queued snapshot into ${task.targetBranch} at ${mergedHead.slice(0, 12)}`,
    checkpointId: latestCheckpoint(checkpointedTask)?.id,
  });
  return { merged: true };
}

async function drainMergeQueue(root: string): Promise<QueueDrainResult> {
  const mergedTaskIds: string[] = [];
  for (;;) {
    const store = await readTaskStore(root);
    const entry = store.mergeQueue[0];
    if (!entry) return { mergedTaskIds };
    const task = store.tasks.find((candidate) => candidate.id === entry.taskId);
    if (!task || task.state !== "merge_queued") {
      store.mergeQueue = store.mergeQueue.filter((candidate) => candidate.taskId !== entry.taskId);
      await writeTaskStore(root, store);
      continue;
    }
    const outcome = await mergeQueuedTask(root, task, entry);
    if (!outcome.merged) return { mergedTaskIds, blocked: outcome.blocked };
    const updated = await readTaskStore(root);
    updated.mergeQueue = updated.mergeQueue.filter((candidate) => candidate.taskId !== task.id);
    await writeTaskStore(root, updated);
    mergedTaskIds.push(task.id);
  }
}

/**
 * Persist an explicitly approved review snapshot in the per-repository merge
 * queue, then drain only the safe prefix. Every queued task was individually
 * confirmed in the UI; overlapping paths or a Git conflict pause the queue.
 */
export async function queueWorktreeMerge(
  projectPath: string,
  worktreePath: string,
  branch: string,
  taskId: string,
  message?: string,
): Promise<WorktreeQueueResult> {
  const root = await primaryRoot(projectPath);
  return withMergeQueueLock(root, async () => {
    const task = await requireTask(root, worktreePath, branch, taskId);
    if (task.state === "merged") {
      return { queued: false, mergedTaskIds: [], error: "此任务已经合并。" };
    }
    if (task.state === "discarded") {
      return { queued: false, mergedTaskIds: [], error: "此任务已经丢弃。" };
    }
    if (task.state !== "review_ready" && task.state !== "merge_queued") {
      return { queued: false, mergedTaskIds: [], error: "请先将任务标记为“准备审核”。" };
    }
    const stableReason = await taskReviewIsStable(task);
    if (stableReason) return { queued: false, mergedTaskIds: [], error: stableReason };

    let position = 0;
    if (task.state !== "merge_queued") {
      const store = await readTaskStore(root);
      const now = new Date().toISOString();
      const checkpoint: WorktreeTaskCheckpoint = {
        id: randomUUID(),
        kind: "queued",
        commit: task.reviewCommit!,
        targetCommit: task.targetCommit,
        createdAt: now,
      };
      const index = store.tasks.findIndex((candidate) => candidate.id === task.id);
      if (index < 0) return { queued: false, mergedTaskIds: [], error: "PiWin 任务元数据不存在。" };
      store.tasks[index] = {
        ...store.tasks[index],
        state: "merge_queued",
        queuedAt: now,
        queueBlocked: undefined,
        checkpoints: [...(store.tasks[index].checkpoints ?? []), checkpoint],
      };
      store.mergeQueue.push({ taskId: task.id, queuedAt: now, message });
      store.auditEvents = [
        ...store.auditEvents,
        {
          id: randomUUID(),
          taskId: task.id,
          kind: "merge_queued" as const,
          createdAt: now,
          detail: `Queued review snapshot at position ${store.mergeQueue.length}`,
          checkpointId: checkpoint.id,
        },
      ].slice(-TASK_AUDIT_EVENT_LIMIT);
      position = store.mergeQueue.length;
      await writeTaskStore(root, store);
    } else {
      const store = await readTaskStore(root);
      position = store.mergeQueue.findIndex((entry) => entry.taskId === task.id) + 1;
    }

    const drained = await drainMergeQueue(root);
    return {
      queued: true,
      position: position || undefined,
      mergedTaskIds: drained.mergedTaskIds,
      blocked: drained.blocked,
    };
  });
}

/** Remove a waiting snapshot from the queue without changing its review commit. */
export async function unqueueWorktreeMerge(
  projectPath: string,
  worktreePath: string,
  branch: string,
  taskId: string,
): Promise<WorktreeStatusInfo> {
  const root = await primaryRoot(projectPath);
  return withMergeQueueLock(root, async () => {
    const task = await requireTask(root, worktreePath, branch, taskId);
    if (task.state !== "merge_queued") return worktreeStatus(root, worktreePath, branch, taskId);
    const store = await readTaskStore(root);
    const index = store.tasks.findIndex((candidate) => candidate.id === task.id);
    if (index < 0) throw new Error("PiWin 任务元数据不存在");
    store.tasks[index] = {
      ...store.tasks[index],
      state: "review_ready",
      queuedAt: undefined,
      queueBlocked: undefined,
    };
    store.mergeQueue = store.mergeQueue.filter((entry) => entry.taskId !== task.id);
    store.auditEvents = [
      ...store.auditEvents,
      {
        id: randomUUID(),
        taskId: task.id,
        kind: "queue_cancelled" as const,
        createdAt: new Date().toISOString(),
        detail: "Removed from merge queue while keeping the review snapshot",
      },
    ].slice(-TASK_AUDIT_EVENT_LIMIT);
    await writeTaskStore(root, store);
    return worktreeStatus(root, worktreePath, branch, taskId);
  });
}

/** Restore a durable task Git checkpoint only after an explicit UI confirmation. */
export async function restoreWorktreeCheckpoint(
  projectPath: string,
  worktreePath: string,
  branch: string,
  taskId: string,
  checkpointId: string,
  confirmed: boolean,
): Promise<WorktreeCheckpointRestoreResult> {
  const root = await primaryRoot(projectPath);
  return withMergeQueueLock(root, async () => {
    const task = await requireTask(root, worktreePath, branch, taskId);
    const checkpoint = task.checkpoints?.find((candidate) => candidate.id === checkpointId);
    if (!checkpoint) return { restored: false, requiresConfirmation: false, error: "找不到该任务 checkpoint。" };
    if (task.state === "merged" || task.state === "discarded") {
      return { restored: false, requiresConfirmation: false, checkpoint, error: "已完成的任务不能恢复到旧 checkpoint。" };
    }
    if (task.dockerWorkspace?.state === "ready" || task.wslWorkspace?.state === "ready") {
      return { restored: false, requiresConfirmation: false, checkpoint, error: "请先导入或丢弃 Docker / WSL 私有副本。" };
    }
    try {
      await git(worktreePath, "cat-file", "-e", `${checkpoint.commit}^{commit}`);
    } catch {
      return { restored: false, requiresConfirmation: false, checkpoint, error: "checkpoint Git 提交已不可用。" };
    }
    if (!confirmed) return { restored: false, requiresConfirmation: true, checkpoint };

    try {
      await git(worktreePath, "reset", "--hard", checkpoint.commit);
      // The confirmation explicitly discards post-checkpoint work. `reset`
      // does not remove untracked files, so clean them as well to make the
      // recovered worktree match its durable checkpoint.
      await git(worktreePath, "clean", "-fd");
      const nextState: WorktreeTaskState = checkpoint.kind === "created" ? "active" : "review_ready";
      const store = await readTaskStore(root);
      const index = store.tasks.findIndex((candidate) => candidate.id === task.id);
      if (index < 0) throw new Error("PiWin 任务元数据不存在");
      store.tasks[index] = {
        ...store.tasks[index],
        state: nextState,
        reviewCommit: checkpoint.kind === "created" ? undefined : checkpoint.commit,
        reviewedAt: checkpoint.kind === "created" ? undefined : checkpoint.createdAt,
        queuedAt: undefined,
        queueBlocked: undefined,
      };
      store.mergeQueue = store.mergeQueue.filter((entry) => entry.taskId !== task.id);
      store.auditEvents = [
        ...store.auditEvents,
        {
          id: randomUUID(),
          taskId: task.id,
          kind: "checkpoint_restored" as const,
          createdAt: new Date().toISOString(),
          detail: `Restored ${checkpoint.kind} checkpoint ${checkpoint.commit.slice(0, 12)}`,
          checkpointId: checkpoint.id,
        },
      ].slice(-TASK_AUDIT_EVENT_LIMIT);
      await writeTaskStore(root, store);
      return { restored: true, requiresConfirmation: false, checkpoint };
    } catch (error) {
      return {
        restored: false,
        requiresConfirmation: false,
        checkpoint,
        error: `checkpoint 恢复失败：${compactCommandError(error)}`,
      };
    }
  });
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
  return withMergeQueueLock(root, () => discardTaskAtRoot(root, worktreePath, branch, taskId, confirmed));
}

async function discardTaskAtRoot(
  root: string,
  worktreePath: string,
  branch: string,
  taskId: string,
  confirmed: boolean,
): Promise<WorktreeDiscardResult> {
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
  if (task.wslWorkspace?.state === "ready") {
    try {
      privateChanges = (await readWslTaskPatch(task)).changedFiles.length > 0 || privateChanges;
    } catch {
      // An unavailable native copy is still a destructive state: retain the
      // explicit-confirmation requirement rather than assuming it is empty.
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
    let wslWorkspace = task.wslWorkspace;
    if (wslWorkspace && wslWorkspace.state !== "discarded") {
      await removeWslTaskWorkspace(wslWorkspace, task.id);
      wslWorkspace = {
        ...wslWorkspace,
        state: "discarded",
        discardedAt: now,
      };
    }
    await git(root, "worktree", "remove", "--force", task.worktreePath);
    await git(root, "branch", "-D", task.branch);
    const store = await readTaskStore(root);
    const index = store.tasks.findIndex((candidate) => candidate.id === task.id);
    if (index < 0) throw new Error("PiWin 任务元数据不存在");
    store.tasks[index] = {
      ...store.tasks[index],
      state: "discarded",
      discardedAt: now,
      dockerWorkspace,
      wslWorkspace,
      queuedAt: undefined,
      queueBlocked: undefined,
    };
    store.mergeQueue = store.mergeQueue.filter((entry) => entry.taskId !== task.id);
    store.auditEvents = [
      ...store.auditEvents,
      {
        id: randomUUID(),
        taskId: task.id,
        kind: "task_discarded" as const,
        createdAt: now,
        detail: "Task worktree and branch discarded after explicit confirmation",
      },
    ].slice(-TASK_AUDIT_EVENT_LIMIT);
    await writeTaskStore(root, store);
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
