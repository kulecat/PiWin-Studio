/**
 * Credential-isolated read-only Docker workspace lifecycle.
 *
 * A host bind mount makes `.env` and private keys visible even when it is
 * read-only. PiWin therefore gives each read-only Docker chat a filtered,
 * short-lived volume snapshot instead. Writable task volumes use the same
 * filter in main/worktrees.ts.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { DockerSandboxProfile } from "@shared/protocol";
import { dockerFilteredWorkspaceCopyCommand } from "./docker-credential-policy";

const SNAPSHOT_LABEL = "io.piwin.readonly-snapshot";
const VOLUME_ENV = "PIWIN_DOCKER_WORKSPACE_VOLUME";

interface ReadonlySnapshot {
  volume: string;
  previousVolume: string | undefined;
}

let snapshot: ReadonlySnapshot | undefined;

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function docker(args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker.exe", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8").trim());
      else {
        const detail = Buffer.concat(stderr).toString("utf8").replace(/\s+/g, " ").trim();
        reject(new Error(detail.slice(0, 500) || "Docker credential snapshot operation failed."));
      }
    });
  });
}

async function isManagedSnapshot(volume: string): Promise<boolean> {
  try {
    const label = await docker([
      "volume",
      "inspect",
      "--format",
      `{{ index .Labels "${SNAPSHOT_LABEL}" }}`,
      volume,
    ]);
    return label === "true";
  } catch (error) {
    if (/no such|not found/i.test(error instanceof Error ? error.message : String(error))) return false;
    throw error;
  }
}

async function removeManagedSnapshot(volume: string): Promise<void> {
  if (!volume.startsWith("piwin-ro-")) return;
  if (!(await isManagedSnapshot(volume))) return;
  await docker(["volume", "rm", volume], 30_000).catch(() => undefined);
}

function readonlyBootstrap(profile: DockerSandboxProfile): string[] {
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

/** Prepare a filtered, Git-aware snapshot for a Docker readonly chat. */
export async function ensureDockerReadonlyCredentialSnapshot(
  sessionId: string,
  cwd: string,
  profile: DockerSandboxProfile,
): Promise<void> {
  if (profile.workspaceAccess !== "readonly") return;
  if (snapshot) return;
  const volume = `piwin-ro-${stableId(sessionId)}`;
  const previousVolume = process.env[VOLUME_ENV];
  await removeManagedSnapshot(volume);
  try {
    await docker(["volume", "create", "--label", `${SNAPSHOT_LABEL}=true`, volume]);
    const sourceMount = ["type=bind", `src=${cwd}`, "dst=/source", "readonly"].join(",");
    const workspaceMount = ["type=volume", `src=${volume}`, "dst=/workspace"].join(",");
    const bootstrap = [
      "set -eu",
      dockerFilteredWorkspaceCopyCommand("/source", "/workspace"),
      "git -C /workspace init -q",
      "git -C /workspace config user.name 'PiWin Studio'",
      "git -C /workspace config user.email 'piwin@desktop.local'",
      "git -C /workspace add -A",
      "git -C /workspace commit --allow-empty -qm 'PiWin readonly credential-safe base'",
      "chown -R 1000:1000 /workspace",
    ].join("; ");
    await docker(
      [
        "run",
        "--rm",
        "--init",
        ...readonlyBootstrap(profile),
        "--cap-add",
        "CHOWN",
        "--user",
        "root",
        "--mount",
        workspaceMount,
        "--mount",
        sourceMount,
        profile.image,
        "sh",
        "-lc",
        bootstrap,
      ],
      300_000,
    );
    process.env[VOLUME_ENV] = volume;
    snapshot = { volume, previousVolume };
  } catch (error) {
    await removeManagedSnapshot(volume);
    throw error;
  }
}

/** Remove this host's read-only snapshot; never touches writable task volumes. */
export async function releaseDockerReadonlyCredentialSnapshot(): Promise<void> {
  const active = snapshot;
  snapshot = undefined;
  if (!active) return;
  if (active.previousVolume === undefined) delete process.env[VOLUME_ENV];
  else process.env[VOLUME_ENV] = active.previousVolume;
  await removeManagedSnapshot(active.volume);
}
