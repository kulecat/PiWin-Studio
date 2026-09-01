/**
 * Windows local-execution routing.
 *
 * Pi tools speak shell commands, while a Windows desktop may have three very
 * different execution environments. Keep the choice in one small module so
 * policy and audit layers can reason about the same runner identity later.
 *
 * Docker is deliberately opt-in: selecting it mounts a workspace into a
 * container, so it must never become the automatic fallback.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import type {
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
    return { kind: "docker", available: true, detail: `Docker daemon ${version} (explicit opt-in)` };
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
  const image = process.env[DOCKER_IMAGE_ENV] || "node:22-bookworm-slim";
  return {
    file: "docker.exe",
    args: [
      "run",
      "--rm",
      "-i",
      "--workdir",
      "/workspace",
      "--mount",
      `type=bind,src=${cwd},dst=/workspace`,
      image,
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
  return { platform: process.platform, configuredRunner: requestedRunner, effectiveRunner, runners };
}
