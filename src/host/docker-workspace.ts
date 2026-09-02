/**
 * Docker workspace file adapter.
 *
 * In the writable Windows Docker profile, the agent receives a task-specific
 * named volume rather than a writable host bind mount. Bash already uses that
 * volume; this module gives Pi's file tools the exact same view of it.
 *
 * Every host path is first constrained to the chat worktree, then translated
 * to /workspace. The shell-side checks resolve existing symlinks (or a write
 * target's parent) and reject anything that would leave /workspace.
 */
import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { runAuditedCommand } from "./audit";
import {
  isDockerHostWriteBlocked,
  isDockerPrivateCopyModeActive,
  resolveLocalPtyInvocation,
} from "./windows-execution";

const CONTAINER_WORKSPACE = "/workspace";
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface DockerWorkspaceCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
}

function isInsideWorkspace(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Translate a host path to its private Docker-volume counterpart. */
export function toDockerWorkspacePath(localCwd: string, hostPath: string): string {
  const root = resolve(localCwd);
  const target = resolve(hostPath);
  if (!isInsideWorkspace(root, target)) {
    throw new Error("Docker file tools may only access the active task worktree.");
  }
  const rel = relative(root, target).split(sep).join("/");
  return rel ? `${CONTAINER_WORKSPACE}/${rel}` : CONTAINER_WORKSPACE;
}

/** Translate a volume path returned by Git back into Pi's host-path vocabulary. */
export function fromDockerWorkspacePath(localCwd: string, containerPath: string): string {
  if (containerPath === CONTAINER_WORKSPACE) return resolve(localCwd);
  const prefix = `${CONTAINER_WORKSPACE}/`;
  if (!containerPath.startsWith(prefix)) {
    throw new Error("Docker returned a path outside the private workspace.");
  }
  return resolve(localCwd, ...containerPath.slice(prefix.length).split("/"));
}

/** Docker routing is enabled only for the explicit Windows Docker runner. */
export function dockerWorkspaceRoutingActive(): boolean {
  return isDockerHostWriteBlocked();
}

export function dockerWorkspaceWritable(): boolean {
  return isDockerPrivateCopyModeActive();
}

function shellQuote(value: string): string {
  // POSIX single-quote escaping. Tool parameters never contain NUL bytes.
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function compactDockerError(stderr: Buffer, exitCode: number | null): Error {
  const detail = stderr.toString("utf8").trim();
  return new Error(detail || `Docker workspace command exited with code ${exitCode ?? "unknown"}.`);
}

function workspaceGuard(containerPath: string, mode: "existing" | "write-target"): string {
  const target = shellQuote(containerPath);
  const source =
    mode === "existing"
      ? `resolved=$(realpath -e -- "$target_path")`
      : [
          'parent=$(dirname -- "$target_path")',
          'resolved_parent=$(realpath -e -- "$parent")',
          'if [ -e "$target_path" ] || [ -L "$target_path" ]; then',
          '  resolved=$(realpath -e -- "$target_path")',
          "else",
          '  resolved="$resolved_parent/$(basename -- \"$target_path\")"',
          "fi",
        ].join("\n");
  return [
    `target_path=${target}`,
    `workspace=${shellQuote(CONTAINER_WORKSPACE)}`,
    source,
    'case "$resolved" in',
    '  "$workspace"|"$workspace"/*) ;;',
    '  *) echo "PiWin Docker workspace path escapes /workspace" >&2; exit 64 ;;',
    "esac",
  ].join("\n");
}

/**
 * Execute one internal Docker workspace operation. It deliberately reuses the
 * exact restricted `docker run` profile used by bash, including the task
 * volume, disabled network by default, non-root user, and resource limits.
 */
export async function runDockerWorkspaceCommand(
  localCwd: string,
  command: string,
  options: { input?: Buffer; signal?: AbortSignal; auditLabel: string } = { auditLabel: "file" },
): Promise<DockerWorkspaceCommandResult> {
  if (!dockerWorkspaceRoutingActive()) {
    throw new Error("Docker workspace routing is not active.");
  }
  const invocation = resolveLocalPtyInvocation(command, localCwd);
  if (invocation.runner !== "docker") {
    throw new Error("Docker workspace routing selected a non-Docker runner.");
  }

  const result = await runAuditedCommand(
    {
      world: "local",
      runner: "docker",
      cwd: localCwd,
      command: `[docker-file:${options.auditLabel}]`,
    },
    () =>
      new Promise<DockerWorkspaceCommandResult>((resolveResult, reject) => {
        const child = spawn(invocation.file, invocation.args, {
          cwd: localCwd,
          windowsHide: true,
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        let overflow = false;
        let settled = false;

        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          options.signal?.removeEventListener("abort", abort);
          fn();
        };
        const abort = (): void => {
          child.kill();
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        const collect = (target: Buffer[]) => (chunk: Buffer): void => {
          outputBytes += chunk.length;
          if (outputBytes > MAX_OUTPUT_BYTES) {
            overflow = true;
            child.kill();
            return;
          }
          target.push(Buffer.from(chunk));
        };
        child.stdout.on("data", collect(stdout));
        child.stderr.on("data", collect(stderr));
        child.on("error", (error) => finish(() => reject(error)));
        child.on("close", (exitCode) =>
          finish(() => {
            if (options.signal?.aborted) {
              reject(new Error("Operation aborted"));
              return;
            }
            if (overflow) {
              reject(new Error("Docker workspace operation exceeded the 4 MiB output limit."));
              return;
            }
            resolveResult({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode });
          }),
        );
        if (options.input) child.stdin.end(options.input);
        else child.stdin.end();
      }),
  );
  return result;
}

async function requireDockerSuccess(
  localCwd: string,
  command: string,
  options: { input?: Buffer; signal?: AbortSignal; auditLabel: string },
): Promise<Buffer> {
  const result = await runDockerWorkspaceCommand(localCwd, command, options);
  if (result.exitCode !== 0) throw compactDockerError(result.stderr, result.exitCode);
  return result.stdout;
}

export async function dockerReadFile(localCwd: string, hostPath: string): Promise<Buffer> {
  const target = toDockerWorkspacePath(localCwd, hostPath);
  return requireDockerSuccess(localCwd, `${workspaceGuard(target, "existing")}\ncat -- "$resolved"`, {
    auditLabel: "read",
  });
}

export async function dockerAccess(localCwd: string, hostPath: string): Promise<void> {
  const target = toDockerWorkspacePath(localCwd, hostPath);
  await requireDockerSuccess(localCwd, `${workspaceGuard(target, "existing")}\ntest -r "$resolved"`, {
    auditLabel: "access",
  });
}

export async function dockerMkdir(localCwd: string, hostPath: string): Promise<void> {
  if (!dockerWorkspaceWritable()) {
    throw new Error("Docker read-only mode does not permit directory creation.");
  }
  const target = toDockerWorkspacePath(localCwd, hostPath);
  await requireDockerSuccess(
    localCwd,
    [
      `target_path=${shellQuote(target)}`,
      `workspace=${shellQuote(CONTAINER_WORKSPACE)}`,
      'resolved=$(realpath -m -- "$target_path")',
      'case "$resolved" in',
      '  "$workspace"|"$workspace"/*) ;;',
      '  *) echo "PiWin Docker workspace path escapes /workspace" >&2; exit 64 ;;',
      "esac",
      'mkdir -p -- "$resolved"',
    ].join("\n"),
    { auditLabel: "mkdir" },
  );
}

export async function dockerWriteFile(localCwd: string, hostPath: string, content: string): Promise<void> {
  if (!dockerWorkspaceWritable()) {
    throw new Error("Docker read-only mode does not permit file writes.");
  }
  const target = toDockerWorkspacePath(localCwd, hostPath);
  await requireDockerSuccess(localCwd, `${workspaceGuard(target, "write-target")}\ncat > "$resolved"`, {
    input: Buffer.from(content, "utf8"),
    auditLabel: "write",
  });
}

export async function dockerExists(localCwd: string, hostPath: string): Promise<boolean> {
  try {
    await dockerAccess(localCwd, hostPath);
    return true;
  } catch {
    return false;
  }
}

export async function dockerIsDirectory(localCwd: string, hostPath: string): Promise<boolean> {
  const target = toDockerWorkspacePath(localCwd, hostPath);
  const result = await runDockerWorkspaceCommand(localCwd, `${workspaceGuard(target, "existing")}\ntest -d "$resolved"`, {
    auditLabel: "stat",
  });
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw compactDockerError(result.stderr, result.exitCode);
}

export async function dockerReadDir(localCwd: string, hostPath: string): Promise<string[]> {
  const target = toDockerWorkspacePath(localCwd, hostPath);
  const output = await requireDockerSuccess(
    localCwd,
    `${workspaceGuard(target, "existing")}\ntest -d "$resolved" && find "$resolved" -mindepth 1 -maxdepth 1 -printf '%f\\0'`,
    { auditLabel: "readdir" },
  );
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

/** Return non-ignored tracked and untracked files from the private task copy. */
export async function dockerProjectFiles(localCwd: string, hostPath: string): Promise<string[]> {
  const target = toDockerWorkspacePath(localCwd, hostPath);
  const output = await requireDockerSuccess(
    localCwd,
    [
      workspaceGuard(target, "existing"),
      'if [ -d "$resolved" ]; then',
      '  relative_path=${resolved#"$workspace"/}',
      '  if [ "$resolved" = "$workspace" ]; then relative_path="."; fi',
      '  cd "$workspace"',
      '  if git ls-files -co --exclude-standard -z -- "$relative_path" 2>/dev/null; then exit 0; fi',
      // A read-only Git worktree can contain a host-only `.git` pointer. Keep
      // search inside Docker even when that pointer cannot be followed there.
      '  find "$relative_path" -type f ! -path "*/.git/*" ! -path "*/node_modules/*" -print0',
      "else",
      '  relative_path=${resolved#"$workspace"/}',
      '  printf "%s\\0" "$relative_path"',
      "fi",
    ].join("\n"),
    { auditLabel: "project-files" },
  );
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => fromDockerWorkspacePath(localCwd, `${CONTAINER_WORKSPACE}/${entry}`));
}

/** Run grep in the private volume against an already-validated list of paths. */
export async function dockerGrepFiles(
  localCwd: string,
  hostPaths: string[],
  options: { pattern: string; literal?: boolean; ignoreCase?: boolean; context?: number; signal?: AbortSignal },
): Promise<DockerWorkspaceCommandResult> {
  const paths = hostPaths.map((entry) => toDockerWorkspacePath(localCwd, entry));
  const grepOptions = [
    "-nH",
    options.literal ? "-F" : "-E",
    options.ignoreCase ? "-i" : "",
    options.context && options.context > 0 ? `-C${Math.floor(options.context)}` : "",
  ].filter(Boolean);
  const command = [
    "set +e",
    `xargs -0 -r grep ${grepOptions.join(" ")} -- ${shellQuote(options.pattern)}`,
    "status=$?",
    // GNU xargs uses 123 when grep returns 1 (no matches). Preserve grep's
    // conventional no-match exit code for the tool implementation.
    '[ "$status" -eq 123 ] && exit 1',
    'exit "$status"',
  ].join("\n");
  return runDockerWorkspaceCommand(localCwd, command, {
    input: Buffer.from(`${paths.join("\0")}\0`, "utf8"),
    signal: options.signal,
    auditLabel: "grep",
  });
}
