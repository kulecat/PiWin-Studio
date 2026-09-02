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
import type {
  DockerSandboxProfile,
  ExecutionEnvironmentPayload,
  ExecutionRunnerStatus,
  WindowsExecutionRunner,
} from "@shared/protocol";

export type WindowsRunnerKind = WindowsExecutionRunner;
export type LocalRunnerKind = WindowsRunnerKind | "posix";

export interface PtyInvocation {
  file: string;
  args: string[];
  runner: LocalRunnerKind;
}

const RUNNER_ENV = "PIWIN_EXECUTION_RUNNER";
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

interface WslProbe {
  available: boolean;
  detail: string;
}

let cachedWslProbe: WslProbe | undefined;

function executableOnPath(name: string): boolean {
  if (process.platform !== "win32") return false;
  const entries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return entries.some((entry) => existsSync(join(entry, name)));
}

function configuredRunner(): "auto" | WindowsRunnerKind {
  const value = process.env[RUNNER_ENV]?.trim().toLowerCase();
  if (value === "powershell" || value === "wsl" || value === "docker") return value;
  return "auto";
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
function requirePrivateWorkspaceVolume(): string {
  const volume = privateWorkspaceVolume();
  if (!volume) {
    throw new Error(
      "Docker writable mode requires a PiWin guarded task worktree. Open a new task worktree, then start the agent there.",
    );
  }
  const checked = spawnSync("docker.exe", ["volume", "inspect", volume], {
    encoding: "utf8",
    timeout: 2_500,
    windowsHide: true,
  });
  if (checked.status !== 0) {
    throw new Error(
      "This Docker private task copy has already been imported or discarded. Prepare review, then create a new task before running more Docker commands.",
    );
  }
  return volume;
}

function probeWsl(): WslProbe {
  if (cachedWslProbe) return cachedWslProbe;
  if (!executableOnPath("wsl.exe")) {
    return (cachedWslProbe = {
      available: false,
      detail: "WSL command was not found",
    });
  }

  const distributions = spawnSync("wsl.exe", ["-l", "-q"], {
    encoding: "utf8",
    timeout: 1_500,
    windowsHide: true,
  });
  const distributionNames = distributions.stdout?.replaceAll("\0", "").trim();
  if (distributions.status !== 0 || !distributionNames) {
    return (cachedWslProbe = {
      available: false,
      detail: "Install a WSL2 Linux distribution with `wsl --install`",
    });
  }

  // Listing distributions alone is not enough: a partially initialized WSL
  // setup can list Ubuntu but hang as soon as it starts a Linux command. Auto
  // mode must prove that a minimal command completes before routing agent tools
  // to WSL, otherwise PowerShell is the predictable Windows fallback.
  const readiness = spawnSync("wsl.exe", ["--exec", "sh", "-lc", "printf piwin-wsl-ready"], {
    encoding: "utf8",
    timeout: 2_500,
    windowsHide: true,
  });
  if (readiness.status === 0 && readiness.stdout?.trim() === "piwin-wsl-ready") {
    return (cachedWslProbe = {
      available: true,
      detail: "WSL2 runner for POSIX agent commands",
    });
  }

  return (cachedWslProbe = {
    available: false,
    detail: "A WSL distribution was found, but its test command did not finish; auto mode will use PowerShell",
  });
}

function wslReady(): boolean {
  return probeWsl().available;
}

function compactProcessError(value: string | undefined): string | undefined {
  const compact = value?.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(0, 160) : undefined;
}

function checkPowerShell(): ExecutionRunnerStatus {
  const shell = process.env.PIWIN_SHELL || "powershell.exe";
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

function windowsPathToWsl(cwd: string): string {
  const match = /^([a-z]):[\\/](.*)$/i.exec(cwd);
  if (!match) return cwd.replaceAll("\\", "/");
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

function powerShellInvocation(command: string): PtyInvocation {
  return {
    file: process.env.PIWIN_SHELL || "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-Command", command],
    runner: "powershell",
  };
}

function wslInvocation(command: string, cwd: string): PtyInvocation {
  return {
    file: "wsl.exe",
    args: ["--cd", windowsPathToWsl(cwd), "--", "bash", "-lc", command],
    runner: "wsl",
  };
}

function dockerInvocation(command: string, cwd: string): PtyInvocation {
  const profile = getDockerSandboxProfile();
  const workspaceMount =
    profile.workspaceAccess === "readonly"
      ? ["type=bind", `src=${cwd}`, "dst=/workspace", "readonly"]
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
  };
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

  const requested = configuredRunner();
  if (requested === "docker") return dockerInvocation(command, cwd);
  if (requested === "wsl") return wslInvocation(command, cwd);
  if (requested === "powershell") return powerShellInvocation(command);

  return wslReady()
    ? wslInvocation(command, cwd)
    : powerShellInvocation(command);
}

/** A side-effect-free diagnostic suitable for a future Windows setup screen. */
export function inspectWindowsRunners(): ExecutionRunnerStatus[] {
  if (process.platform !== "win32") {
    return [
      { kind: "powershell", available: false, detail: "Only available on Windows" },
      { kind: "wsl", available: false, detail: "Only available on Windows" },
      { kind: "docker", available: false, detail: "Only available on Windows" },
    ];
  }
  const wsl = probeWsl();
  return [
    checkPowerShell(),
    {
      kind: "wsl",
      available: wsl.available,
      detail: wsl.detail,
    },
    checkDocker(),
  ];
}

/** Inspect the selected runner and its prerequisites for the setup screen. */
export function inspectExecutionEnvironment(): ExecutionEnvironmentPayload {
  const requestedRunner = configuredRunner();
  const runners = inspectWindowsRunners();
  const wslAvailable = runners.find((runner) => runner.kind === "wsl")?.available ?? false;
  const effectiveRunner =
    process.platform !== "win32"
      ? "posix"
      : requestedRunner === "auto"
        ? wslAvailable
          ? "wsl"
          : "powershell"
        : requestedRunner;
  return {
    platform: process.platform,
    configuredRunner: requestedRunner,
    effectiveRunner,
    runners,
    dockerSandbox: process.platform === "win32" ? getDockerSandboxProfile() : undefined,
  };
}
