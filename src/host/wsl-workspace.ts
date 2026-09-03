/**
 * Native WSL private-workspace adapter.
 *
 * A containment-enabled chat receives host paths from Pi's normal tool APIs,
 * but every operation below translates them into Bubblewrap's `/workspace`.
 * `resolveLocalPtyInvocation` starts Bubblewrap, so bash and file tools share
 * one native WSL task copy and cannot fall back to the Windows worktree.
 */
import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { runAuditedCommand } from "./audit";
import { isWslPrivateWorkspaceRoutingActive, resolveLocalPtyInvocation } from "./windows-execution";

const WSL_WORKSPACE = "/workspace";
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface WslWorkspaceCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
}

function isInsideWorkspace(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Translate a host-path tool parameter into the Bubblewrap workspace view. */
export function toWslWorkspacePath(localCwd: string, hostPath: string): string {
  const root = resolve(localCwd);
  const target = resolve(hostPath);
  if (!isInsideWorkspace(root, target)) {
    throw new Error("WSL sandbox file tools may only access the active task worktree.");
  }
  const rel = relative(root, target).split(sep).join("/");
  return rel ? `${WSL_WORKSPACE}/${rel}` : WSL_WORKSPACE;
}

/** Translate a path returned from the private Linux view back to Pi's host vocabulary. */
export function fromWslWorkspacePath(localCwd: string, workspacePath: string): string {
  if (workspacePath === WSL_WORKSPACE) return resolve(localCwd);
  const prefix = `${WSL_WORKSPACE}/`;
  if (!workspacePath.startsWith(prefix)) {
    throw new Error("WSL sandbox returned a path outside the private workspace.");
  }
  return resolve(localCwd, ...workspacePath.slice(prefix.length).split("/"));
}

export function wslWorkspaceRoutingActive(): boolean {
  return isWslPrivateWorkspaceRoutingActive();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commandError(stderr: Buffer, exitCode: number | null): Error {
  const detail = stderr.toString("utf8").trim();
  return new Error(detail || `WSL workspace command exited with code ${exitCode ?? "unknown"}.`);
}

function workspaceGuard(workspacePath: string, mode: "existing" | "write-target"): string {
  const target = shellQuote(workspacePath);
  const source =
    mode === "existing"
      ? 'resolved=$(realpath -e -- "$target_path")'
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
    `workspace=${shellQuote(WSL_WORKSPACE)}`,
    source,
    'case "$resolved" in',
    '  "$workspace"|"$workspace"/*) ;;',
    '  *) echo "PiWin WSL workspace path escapes /workspace" >&2; exit 64 ;;',
    "esac",
  ].join("\n");
}

/** Execute one audited internal command through the active Bubblewrap profile. */
export async function runWslWorkspaceCommand(
  localCwd: string,
  command: string,
  options: { input?: Buffer; signal?: AbortSignal; auditLabel: string },
): Promise<WslWorkspaceCommandResult> {
  if (!wslWorkspaceRoutingActive()) throw new Error("WSL private-workspace routing is not active.");
  const invocation = resolveLocalPtyInvocation(command, localCwd);
  if (invocation.runner !== "wsl") throw new Error("WSL workspace routing selected a non-WSL runner.");
  return runAuditedCommand(
    { world: "local", runner: "wsl", cwd: localCwd, command: `[wsl-file:${options.auditLabel}]` },
    () => new Promise<WslWorkspaceCommandResult>((resolveResult, reject) => {
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
      child.on("close", (exitCode) => finish(() => {
        if (options.signal?.aborted) return reject(new Error("Operation aborted"));
        if (overflow) return reject(new Error("WSL workspace operation exceeded the 4 MiB output limit."));
        resolveResult({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode });
      }));
      if (options.input) child.stdin.end(options.input);
      else child.stdin.end();
    }),
  );
}

async function requireSuccess(
  localCwd: string,
  command: string,
  options: { input?: Buffer; signal?: AbortSignal; auditLabel: string },
): Promise<Buffer> {
  const result = await runWslWorkspaceCommand(localCwd, command, options);
  if (result.exitCode !== 0) throw commandError(result.stderr, result.exitCode);
  return result.stdout;
}

export async function wslReadFile(localCwd: string, hostPath: string): Promise<Buffer> {
  const target = toWslWorkspacePath(localCwd, hostPath);
  return requireSuccess(localCwd, `${workspaceGuard(target, "existing")}\ncat -- "$resolved"`, { auditLabel: "read" });
}

export async function wslAccess(localCwd: string, hostPath: string): Promise<void> {
  const target = toWslWorkspacePath(localCwd, hostPath);
  await requireSuccess(localCwd, `${workspaceGuard(target, "existing")}\ntest -r "$resolved"`, { auditLabel: "access" });
}

export async function wslMkdir(localCwd: string, hostPath: string): Promise<void> {
  const target = toWslWorkspacePath(localCwd, hostPath);
  await requireSuccess(localCwd, [
    `target_path=${shellQuote(target)}`,
    `workspace=${shellQuote(WSL_WORKSPACE)}`,
    'resolved=$(realpath -m -- "$target_path")',
    'case "$resolved" in',
    '  "$workspace"|"$workspace"/*) ;;',
    '  *) echo "PiWin WSL workspace path escapes /workspace" >&2; exit 64 ;;',
    "esac",
    'mkdir -p -- "$resolved"',
  ].join("\n"), { auditLabel: "mkdir" });
}

export async function wslWriteFile(localCwd: string, hostPath: string, content: string): Promise<void> {
  const target = toWslWorkspacePath(localCwd, hostPath);
  await requireSuccess(localCwd, `${workspaceGuard(target, "write-target")}\ncat > "$resolved"`, {
    input: Buffer.from(content, "utf8"),
    auditLabel: "write",
  });
}

export async function wslExists(localCwd: string, hostPath: string): Promise<boolean> {
  try {
    await wslAccess(localCwd, hostPath);
    return true;
  } catch {
    return false;
  }
}

export async function wslIsDirectory(localCwd: string, hostPath: string): Promise<boolean> {
  const target = toWslWorkspacePath(localCwd, hostPath);
  const result = await runWslWorkspaceCommand(localCwd, `${workspaceGuard(target, "existing")}\ntest -d "$resolved"`, { auditLabel: "stat" });
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw commandError(result.stderr, result.exitCode);
}

export async function wslReadDir(localCwd: string, hostPath: string): Promise<string[]> {
  const target = toWslWorkspacePath(localCwd, hostPath);
  const output = await requireSuccess(
    localCwd,
    `${workspaceGuard(target, "existing")}\ntest -d "$resolved" && find "$resolved" -mindepth 1 -maxdepth 1 -printf '%f\\0'`,
    { auditLabel: "readdir" },
  );
  return output.toString("utf8").split("\0").filter(Boolean);
}

export async function wslProjectFiles(localCwd: string, hostPath: string): Promise<string[]> {
  const target = toWslWorkspacePath(localCwd, hostPath);
  const output = await requireSuccess(localCwd, [
    workspaceGuard(target, "existing"),
    'if [ -d "$resolved" ]; then',
    '  relative_path=${resolved#"$workspace"/}',
    '  if [ "$resolved" = "$workspace" ]; then relative_path="."; fi',
    '  cd "$workspace"',
    '  if git ls-files -co --exclude-standard -z -- "$relative_path" 2>/dev/null; then exit 0; fi',
    '  find "$relative_path" -type f ! -path "*/.git/*" ! -path "*/node_modules/*" -print0',
    "else",
    '  relative_path=${resolved#"$workspace"/}',
    '  printf "%s\\0" "$relative_path"',
    "fi",
  ].join("\n"), { auditLabel: "project-files" });
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => fromWslWorkspacePath(localCwd, `${WSL_WORKSPACE}/${entry}`));
}

export async function wslGrepFiles(
  localCwd: string,
  hostPaths: string[],
  options: { pattern: string; literal?: boolean; ignoreCase?: boolean; context?: number; signal?: AbortSignal },
): Promise<WslWorkspaceCommandResult> {
  const paths = hostPaths.map((entry) => toWslWorkspacePath(localCwd, entry));
  const grepOptions = [
    "-nH",
    options.literal ? "-F" : "-E",
    options.ignoreCase ? "-i" : "",
    options.context && options.context > 0 ? `-C${Math.floor(options.context)}` : "",
  ].filter(Boolean);
  return runWslWorkspaceCommand(localCwd, [
    "set +e",
    `xargs -0 -r grep ${grepOptions.join(" ")} -- ${shellQuote(options.pattern)}`,
    "status=$?",
    '[ "$status" -eq 123 ] && exit 1',
    'exit "$status"',
  ].join("\n"), {
    input: Buffer.from(`${paths.join("\0")}\0`, "utf8"),
    signal: options.signal,
    auditLabel: "grep",
  });
}
