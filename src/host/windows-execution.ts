/**
 * Windows local-execution routing.
 *
 * Pi tools speak shell commands, while a Windows desktop may have three very
 * different execution environments. Keep the choice in one small module so
 * policy and audit layers can reason about the same runner identity later.
 *
 * Docker is deliberately opt-in. Its read-only mode mounts a workspace for
 * inspection; its writable mode uses a PiWin-created private task volume, so
 * it must never become the automatic fallback.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { dockerEgressInvocationArgs } from "./docker-egress";
import { resolveDockerCredentialValues, type DockerCredentialValue } from "./docker-credential-policy";
import { buildWslContainmentProbeArgs, readWslContainmentProbe } from "./wsl-containment";
import type {
  AppConfigPayload,
  DockerSandboxProfile,
  ExecutionEnvironmentPayload,
  ExecutionRunnerStatus,
  WslExecutionProfile,
  WslContainmentStatus,
  WindowsExecutionRunner,
} from "@shared/protocol";

export type WindowsRunnerKind = WindowsExecutionRunner;
export type LocalRunnerKind = WindowsRunnerKind | "posix";

export interface PtyInvocation {
  file: string;
  args: string[];
  runner: LocalRunnerKind;
  /** Optional docker.exe environment for one-shot approved credentials. */
  env?: NodeJS.ProcessEnv;
}

const RUNNER_ENV = "PIWIN_EXECUTION_RUNNER";
const WSL_DISTRIBUTION_ENV = "PIWIN_WSL_DISTRIBUTION";
const WSL_MOUNT_ROOT_ENV = "PIWIN_WSL_MOUNT_ROOT";
const DOCKER_IMAGE_ENV = "PIWIN_DOCKER_IMAGE";
const DOCKER_WORKSPACE_ACCESS_ENV = "PIWIN_DOCKER_WORKSPACE_ACCESS";
const DOCKER_WORKSPACE_VOLUME_ENV = "PIWIN_DOCKER_WORKSPACE_VOLUME";
const DOCKER_NETWORK_ENV = "PIWIN_DOCKER_NETWORK";
const DOCKER_MEMORY_ENV = "PIWIN_DOCKER_MEMORY";
const DOCKER_CPUS_ENV = "PIWIN_DOCKER_CPUS";
const DOCKER_PIDS_LIMIT_ENV = "PIWIN_DOCKER_PIDS_LIMIT";
// The private task workspace is a small Git repository. The full Bookworm
// image includes Git, unlike the slim image that was sufficient for the
// original command-only profile.
const DEFAULT_DOCKER_IMAGE = "node:22-bookworm";
const DEFAULT_DOCKER_MEMORY = "2g";
const DEFAULT_DOCKER_CPUS = "2";
const DEFAULT_DOCKER_PIDS_LIMIT = 128;

interface WslSettings {
  distribution?: string;
  mountRoot: string;
  error?: string;
}

interface WslProbe {
  available: boolean;
  detail: string;
}

const cachedWslProbes = new Map<string, WslProbe>();
const cachedWslContainmentProbes = new Map<string, WslContainmentStatus>();

function executableOnPath(name: string): boolean {
  if (process.platform !== "win32") return false;
  const entries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return entries.some((entry) => existsSync(join(entry, name)));
}

function configuredRunner(environment: NodeJS.ProcessEnv = process.env): "auto" | WindowsRunnerKind {
  const value = environment[RUNNER_ENV]?.trim().toLowerCase();
  if (value === "powershell" || value === "wsl" || value === "docker") return value;
  return "auto";
}

function validWslDistribution(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.length <= 120 && !/[\0\r\n]/.test(normalized) ? normalized : undefined;
}

function validWslMountRoot(value: string | undefined): string | undefined {
  const withForwardSlashes = value?.trim().replaceAll("\\", "/");
  const normalized = withForwardSlashes === "/" ? "/" : withForwardSlashes?.replace(/\/+$/, "");
  if (!normalized || !normalized.startsWith("/")) return undefined;
  if (normalized.split("/").some((segment) => segment === "..")) return undefined;
  return normalized.length <= 120 ? normalized : undefined;
}

function wslSettings(environment: NodeJS.ProcessEnv = process.env): WslSettings {
  const requestedDistribution = environment[WSL_DISTRIBUTION_ENV]?.trim();
  const requestedMountRoot = environment[WSL_MOUNT_ROOT_ENV]?.trim();
  if (requestedDistribution && !validWslDistribution(requestedDistribution)) {
    return { mountRoot: "/mnt", error: "PIWIN_WSL_DISTRIBUTION contains an invalid distribution name" };
  }
  if (requestedMountRoot && !validWslMountRoot(requestedMountRoot)) {
    return { mountRoot: "/mnt", error: "PIWIN_WSL_MOUNT_ROOT must be an absolute Linux path without .." };
  }
  return {
    distribution: validWslDistribution(requestedDistribution),
    mountRoot: validWslMountRoot(requestedMountRoot) ?? "/mnt",
  };
}

/** Apply desktop preferences to a new agent-process environment. */
export function applyExecutionConfig(
  environment: NodeJS.ProcessEnv,
  config: Pick<AppConfigPayload, "executionRunner" | "wslDistribution" | "wslMountRoot">,
): NodeJS.ProcessEnv {
  const next = { ...environment };
  if (config.executionRunner) next[RUNNER_ENV] = config.executionRunner;
  if (config.wslDistribution !== undefined) {
    const distribution = config.wslDistribution?.trim();
    if (distribution) next[WSL_DISTRIBUTION_ENV] = distribution;
    else delete next[WSL_DISTRIBUTION_ENV];
  }
  if (config.wslMountRoot !== undefined) {
    const mountRoot = config.wslMountRoot?.trim();
    if (mountRoot) next[WSL_MOUNT_ROOT_ENV] = mountRoot;
    else delete next[WSL_MOUNT_ROOT_ENV];
  }
  return next;
}

function validDockerMemory(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^\d+(?:\.\d+)?[bkmg]?$/.test(normalized) ? normalized : undefined;
}

function validDockerCpuCount(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || !/^\d+(?:\.\d+)?$/.test(normalized)) return undefined;
  return Number(normalized) > 0 ? normalized : undefined;
}

function validDockerPidsLimit(value: string | undefined): number | undefined {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The Docker runner is a command-execution boundary, not a claim that every
 * host-side Pi extension or file operation is sandboxed. Keep this profile
 * deterministic and opt-in: Docker is never selected by auto mode.
 */
export function getDockerSandboxProfile(): DockerSandboxProfile {
  const workspaceAccess =
    process.env[DOCKER_WORKSPACE_ACCESS_ENV]?.trim().toLowerCase() === "readwrite"
      ? "readwrite"
      : "readonly";
  const networkValue = process.env[DOCKER_NETWORK_ENV]?.trim().toLowerCase();
  // `allow` is retained as the documented compatibility spelling, but it no
  // longer means a raw bridge attachment. Both values select the allowlist
  // proxy boundary.
  const network = networkValue === "allow" || networkValue === "allowlist" ? "allowlist" : "none";
  const memory = validDockerMemory(process.env[DOCKER_MEMORY_ENV]) ?? DEFAULT_DOCKER_MEMORY;
  const cpus = validDockerCpuCount(process.env[DOCKER_CPUS_ENV]) ?? DEFAULT_DOCKER_CPUS;
  const pidsLimit = validDockerPidsLimit(process.env[DOCKER_PIDS_LIMIT_ENV]) ?? DEFAULT_DOCKER_PIDS_LIMIT;
  return {
    image: process.env[DOCKER_IMAGE_ENV]?.trim() || DEFAULT_DOCKER_IMAGE,
    workspaceAccess,
    network,
    memory,
    cpus,
    pidsLimit,
  };
}

/** A Docker read-only profile also disables host-side Pi write/edit tools. */
export function isDockerReadOnlyProfileActive(): boolean {
  return process.platform === "win32" && configuredRunner() === "docker" && getDockerSandboxProfile().workspaceAccess === "readonly";
}

/** True only for the write-capable profile that must use a private task volume. */
export function isDockerPrivateCopyModeActive(): boolean {
  return process.platform === "win32" && configuredRunner() === "docker" && getDockerSandboxProfile().workspaceAccess === "readwrite";
}

/** Pi file tools must not write the host whenever Docker is the selected runner. */
export function isDockerHostWriteBlocked(): boolean {
  return process.platform === "win32" && configuredRunner() === "docker";
}

function privateWorkspaceVolume(): string | undefined {
  const value = process.env[DOCKER_WORKSPACE_VOLUME_ENV]?.trim();
  return value && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value) ? value : undefined;
}

/**
 * Docker silently creates a missing named volume when `docker run --mount` is
 * used. Check first so an imported/discarded task cannot accidentally resume
 * in an empty replacement volume from an old host process.
 */
function requireExistingWorkspaceVolume(errorMessage: string): string {
  const volume = privateWorkspaceVolume();
  if (!volume) {
    throw new Error(errorMessage);
  }
  const checked = spawnSync("docker.exe", ["volume", "inspect", volume], {
    encoding: "utf8",
    timeout: 2_500,
    windowsHide: true,
  });
  if (checked.status !== 0) {
    throw new Error(errorMessage);
  }
  return volume;
}

function requirePrivateWorkspaceVolume(): string {
  return requireExistingWorkspaceVolume(
    "Docker writable mode requires a PiWin guarded task worktree. Open a new task worktree, then start the agent there.",
  );
}

function requireReadonlyCredentialSnapshotVolume(): string {
  return requireExistingWorkspaceVolume(
    "Docker read-only credential-safe snapshot is not ready. Restart the PiWin agent session.",
  );
}

function wslArgs(settings: WslSettings): string[] {
  return settings.distribution ? ["--distribution", settings.distribution] : [];
}

function probeWsl(environment: NodeJS.ProcessEnv = process.env): WslProbe {
  const settings = wslSettings(environment);
  const cacheKey = `${settings.distribution ?? "<default>"}\n${settings.mountRoot}\n${settings.error ?? ""}`;
  const cached = cachedWslProbes.get(cacheKey);
  if (cached) return cached;
  if (settings.error) {
    const probe = { available: false, detail: settings.error };
    cachedWslProbes.set(cacheKey, probe);
    return probe;
  }
  if (!executableOnPath("wsl.exe")) {
    const probe = {
      available: false,
      detail: "WSL command was not found",
    };
    cachedWslProbes.set(cacheKey, probe);
    return probe;
  }

  const distributions = spawnSync("wsl.exe", ["-l", "-q"], {
    encoding: "utf8",
    timeout: 1_500,
    windowsHide: true,
  });
  const distributionNames = distributions.stdout?.replaceAll("\0", "").trim();
  if (distributions.status !== 0 || !distributionNames) {
    const probe = {
      available: false,
      detail: "Install a WSL2 Linux distribution with `wsl --install`",
    };
    cachedWslProbes.set(cacheKey, probe);
    return probe;
  }
  const knownDistributions = distributionNames.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  if (settings.distribution && !knownDistributions.includes(settings.distribution)) {
    const probe = {
      available: false,
      detail: `WSL distribution “${settings.distribution}” was not found`,
    };
    cachedWslProbes.set(cacheKey, probe);
    return probe;
  }

  // Listing distributions alone is not enough: a partially initialized WSL
  // setup can list Ubuntu but hang as soon as it starts a Linux command. Auto
  // mode must prove that a minimal command completes before routing agent tools
  // to WSL, otherwise PowerShell is the predictable Windows fallback.
  const readiness = spawnSync(
    "wsl.exe",
    [...wslArgs(settings), "--exec", "sh", "-lc", "printf 'piwin-wsl-ready:%s' \"$(uname -r)\""],
    {
    encoding: "utf8",
    timeout: 2_500,
    windowsHide: true,
    },
  );
  const kernel = readiness.stdout?.trim().replace(/^piwin-wsl-ready:/, "");
  if (readiness.status === 0 && kernel && /wsl2/i.test(kernel)) {
    const distribution = settings.distribution ? `WSL2 ${settings.distribution}` : "default WSL2 distribution";
    const probe = {
      available: true,
      detail: `${distribution} · workspace drives map below ${settings.mountRoot}`,
    };
    cachedWslProbes.set(cacheKey, probe);
    return probe;
  }

  const probe = {
    available: false,
    detail: "A WSL distribution was found, but its WSL2 readiness test did not finish; auto mode will use PowerShell",
  };
  cachedWslProbes.set(cacheKey, probe);
  return probe;
}

function wslReady(environment: NodeJS.ProcessEnv = process.env): boolean {
  return probeWsl(environment).available;
}

/**
 * A capability diagnostic only. The Bubblewrap profile is deliberately not a
 * selectable Agent runner until all built-in file tools use the same private
 * WSL copy and a reviewed patch-import hand-off exists.
 */
function probeWslContainment(environment: NodeJS.ProcessEnv = process.env): WslContainmentStatus {
  const settings = wslSettings(environment);
  const cacheKey = `${settings.distribution ?? "<default>"}\n${settings.mountRoot}\n${settings.error ?? ""}`;
  const cached = cachedWslContainmentProbes.get(cacheKey);
  if (cached) return cached;
  if (!probeWsl(environment).available) {
    const probe = { available: false, detail: "WSL2 must be ready before Bubblewrap containment can be checked" };
    cachedWslContainmentProbes.set(cacheKey, probe);
    return probe;
  }
  const result = spawnSync(
    "wsl.exe",
    [...wslArgs(settings), "--exec", "bwrap", ...buildWslContainmentProbeArgs(settings.mountRoot)],
    { encoding: "utf8", timeout: 2_500, windowsHide: true },
  );
  const probe = readWslContainmentProbe(result.stdout, result.status);
  cachedWslContainmentProbes.set(cacheKey, probe);
  return probe;
}

function compactProcessError(value: string | undefined): string | undefined {
  const compact = value?.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(0, 160) : undefined;
}

function checkPowerShell(environment: NodeJS.ProcessEnv = process.env): ExecutionRunnerStatus {
  const shell = environment.PIWIN_SHELL || "powershell.exe";
  const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
    encoding: "utf8",
    timeout: 2_000,
    windowsHide: true,
  });
  const version = result.stdout?.trim();
  if (result.status === 0 && version) {
    return { kind: "powershell", available: true, detail: `PowerShell ${version}` };
  }
  return {
    kind: "powershell",
    available: false,
    detail: compactProcessError(result.stderr) || `Unable to start ${shell}`,
  };
}

function checkDocker(): ExecutionRunnerStatus {
  if (!executableOnPath("docker.exe")) {
    return { kind: "docker", available: false, detail: "Docker Desktop command was not found" };
  }
  const result = spawnSync("docker.exe", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    timeout: 2_500,
    windowsHide: true,
  });
  const version = result.stdout?.trim();
  if (result.status === 0 && version) {
    const profile = getDockerSandboxProfile();
    const workspace =
      profile.workspaceAccess === "readonly"
        ? "read-only workspace"
        : "private writable task copy";
    const network = profile.network === "none" ? "network disabled" : "allowlist proxy";
    return {
      kind: "docker",
      available: true,
      detail: `Docker daemon ${version} · ${workspace} · ${network} · ${profile.memory} / ${profile.cpus} CPU / ${profile.pidsLimit} PIDs`,
    };
  }
  return {
    kind: "docker",
    available: false,
    detail: compactProcessError(result.stderr) || "Docker Desktop daemon is not running",
  };
}

/** Map a Windows drive path to the selected WSL automount root. */
export function windowsPathToWsl(cwd: string, mountRoot = "/mnt"): string {
  const match = /^([a-z]):[\\/](.*)$/i.exec(cwd);
  if (!match) return cwd.replaceAll("\\", "/");
  return `${mountRoot}/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

function powerShellInvocation(command: string, environment: NodeJS.ProcessEnv = process.env): PtyInvocation {
  return {
    file: environment.PIWIN_SHELL || "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-Command", command],
    runner: "powershell",
  };
}

function wslInvocation(command: string, cwd: string, environment: NodeJS.ProcessEnv = process.env): PtyInvocation {
  const settings = wslSettings(environment);
  if (settings.error) throw new Error(settings.error);
  return {
    file: "wsl.exe",
    args: [...wslArgs(settings), "--cd", windowsPathToWsl(cwd, settings.mountRoot), "--", "bash", "-lc", command],
    runner: "wsl",
  };
}

function dockerInvocation(
  command: string,
  credentials: DockerCredentialValue[] = [],
): PtyInvocation {
  const profile = getDockerSandboxProfile();
  const workspaceMount =
    profile.workspaceAccess === "readonly"
      ? [
          "type=volume",
          `src=${requireReadonlyCredentialSnapshotVolume()}`,
          "dst=/workspace",
          "readonly",
        ]
      : (() => {
          const volume = requirePrivateWorkspaceVolume();
          return ["type=volume", `src=${volume}`, "dst=/workspace"];
        })();
  return {
    file: "docker.exe",
    args: [
      "run",
      "--rm",
      "-i",
      "--init",
      "--workdir",
      "/workspace",
      ...(profile.network === "none" ? ["--network", "none"] : dockerEgressInvocationArgs()),
      // Docker does not inherit the host environment. Only the explicit
      // names passed by the approved credential tool are forwarded below.
      ...credentials.flatMap(({ name }) => ["--env", name]),
      "--env",
      "HOME=/tmp",
      "--env",
      "GIT_CONFIG_NOSYSTEM=1",
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
      "--user",
      "node",
      "--mount",
      workspaceMount.join(","),
      profile.image,
      "sh",
      "-lc",
      command,
    ],
    runner: "docker",
    ...(credentials.length > 0
      ? { env: { ...process.env, ...Object.fromEntries(credentials.map(({ name, value }) => [name, value])) } }
      : {}),
  };
}

/**
 * Build a one-shot Docker command that receives only explicitly allowlisted,
 * human-approved environment variables. Values are inherited by docker.exe
 * with `--env NAME`, so secret bytes are never put in the command line.
 */
export function resolveDockerCredentialInvocation(
  command: string,
  _cwd: string,
  credentialNames: string[],
): PtyInvocation {
  if (process.platform !== "win32" || configuredRunner() !== "docker") {
    throw new Error("Temporary credential injection is available only in the Windows Docker runner.");
  }
  return dockerInvocation(command, resolveDockerCredentialValues(credentialNames));
}

/** Resolve a runner without constructing a command or touching Docker volumes. */
export function effectiveLocalRunner(environment: NodeJS.ProcessEnv = process.env): LocalRunnerKind {
  if (process.platform !== "win32") return "posix";
  const requested = configuredRunner(environment);
  if (requested === "docker" || requested === "wsl" || requested === "powershell") return requested;
  return wslReady(environment) ? "wsl" : "powershell";
}

/** PowerShell executes directly in the Windows user environment, never in a sandbox. */
export function hostPowerShellApprovalRule(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  if (effectiveLocalRunner(environment) !== "powershell") return undefined;
  return "Windows PowerShell will run directly on the host user environment (not inside Docker or a WSL sandbox).";
}

/**
 * Route a local tool command. On Windows, auto prefers WSL2 because Pi's
 * built-in bash tools generate POSIX commands. When WSL2 is absent we retain a
 * useful PowerShell fallback. Explicit requests never silently downgrade.
 */
export function resolveLocalPtyInvocation(command: string, cwd: string): PtyInvocation {
  if (process.platform !== "win32") {
    return { file: "/bin/sh", args: ["-c", command], runner: "posix" };
  }

  const runner = effectiveLocalRunner();
  if (runner === "docker") return dockerInvocation(command);
  if (runner === "wsl") return wslInvocation(command, cwd);
  return powerShellInvocation(command);
}

/** A side-effect-free diagnostic suitable for a future Windows setup screen. */
export function inspectWindowsRunners(environment: NodeJS.ProcessEnv = process.env): ExecutionRunnerStatus[] {
  if (process.platform !== "win32") {
    return [
      { kind: "powershell", available: false, detail: "Only available on Windows" },
      { kind: "wsl", available: false, detail: "Only available on Windows" },
      { kind: "docker", available: false, detail: "Only available on Windows" },
    ];
  }
  const wsl = probeWsl(environment);
  return [
    checkPowerShell(environment),
    {
      kind: "wsl",
      available: wsl.available,
      detail: wsl.detail,
    },
    checkDocker(),
  ];
}

/** Inspect the selected runner and its prerequisites for the setup screen. */
export function inspectExecutionEnvironment(environment: NodeJS.ProcessEnv = process.env): ExecutionEnvironmentPayload {
  const requestedRunner = configuredRunner(environment);
  const runners = inspectWindowsRunners(environment);
  const settings = wslSettings(environment);
  const effectiveRunner = effectiveLocalRunner(environment);
  return {
    platform: process.platform,
    configuredRunner: requestedRunner,
    effectiveRunner,
    runners,
    wsl: process.platform === "win32"
      ? {
          distribution: settings.distribution,
          mountRoot: settings.mountRoot,
        } satisfies WslExecutionProfile
      : undefined,
    wslContainment: process.platform === "win32" ? probeWslContainment(environment) : undefined,
    dockerSandbox: process.platform === "win32" ? getDockerSandboxProfile() : undefined,
  };
}
