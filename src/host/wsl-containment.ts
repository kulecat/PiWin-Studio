/**
 * Experimental WSL2 containment building blocks.
 *
 * A regular `wsl.exe --cd <project>` process can see the user's mounted
 * Windows drives, so it is never a sandbox. This profile uses Bubblewrap in
 * the Linux distribution to create user, PID, IPC, UTS, mount, and network
 * namespaces. It hides the Windows mount root and binds exactly one *native
 * WSL private task copy* at `/workspace`.
 *
 * This module deliberately does not route Agent tools yet. Until bash and all
 * first-party file tools share the same private WSL task copy and patch-import
 * hand-off, exposing this as a product sandbox would be misleading.
 */

export type WslContainmentWorkspaceAccess = "readonly" | "readwrite";

export interface WslContainmentProfile {
  /** Absolute native-Linux task-copy path. Host DrvFs paths are rejected. */
  workspace: string;
  workspaceAccess: WslContainmentWorkspaceAccess;
  /** WSL's host-drive root, normally `/mnt`; it is hidden inside the profile. */
  windowsMountRoot?: string;
}

export interface WslContainmentProbe {
  available: boolean;
  detail: string;
}

export const WSL_CONTAINMENT_PROBE_MARKER = "PIWIN_WSL_CONTAINMENT_PROBE_OK";

function normalizeLinuxPath(value: string, label: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized.startsWith("/")) throw new Error(`${label} must be an absolute Linux path`);
  if (normalized.length > 4_096 || normalized.split("/").some((segment) => segment === "..")) {
    throw new Error(`${label} must not contain ..`);
  }
  return normalized === "/" ? "/" : normalized.replace(/\/+$/, "");
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function baseArgs(windowsMountRoot = "/mnt"): string[] {
  return [
    // `--unshare-all` includes a network namespace. Do not add `--share-net`
    // until a separately tested, allowlisted proxy path exists for WSL.
    "--unshare-all",
    "--unshare-user",
    "--die-with-parent",
    "--new-session",
    "--disable-userns",
    "--clearenv",
    // Runtime only: no host home, `/etc`, `/run`, or Windows mounts are
    // inherited. Ubuntu's /bin, /lib, and /lib64 are usr-merged.
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/sbin", "/sbin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--dir", "/etc",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--tmpfs", "/home",
    "--tmpfs", windowsMountRoot,
    "--setenv", "HOME", "/tmp",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "PATH", "/usr/bin:/bin",
    "--setenv", "LANG", "C.UTF-8",
  ];
}

/**
 * Build Bubblewrap arguments only. The caller must invoke `bwrap` inside the
 * selected WSL distribution; shell text is an argv value, not host-shell text.
 */
export function buildWslContainmentArgs(profile: WslContainmentProfile, command: string): string[] {
  const workspace = normalizeLinuxPath(profile.workspace, "WSL sandbox workspace");
  const windowsMountRoot = normalizeLinuxPath(profile.windowsMountRoot ?? "/mnt", "WSL Windows mount root");
  if (workspace === "/" || isWithin(workspace, windowsMountRoot)) {
    throw new Error("WSL sandbox workspace must be a private native-Linux path outside mounted Windows drives");
  }
  if (!command.trim()) throw new Error("WSL sandbox command must not be empty");

  return [
    ...baseArgs(windowsMountRoot),
    "--dir", "/workspace",
    profile.workspaceAccess === "readonly" ? "--ro-bind" : "--bind",
    workspace,
    "/workspace",
    "--chdir", "/workspace",
    "/bin/sh",
    "-lc",
    command,
  ];
}

/** A no-host-write capability probe; it is diagnostic-only, never an Agent session. */
export function buildWslContainmentProbeArgs(windowsMountRoot = "/mnt"): string[] {
  const mountRoot = normalizeLinuxPath(windowsMountRoot, "WSL Windows mount root");
  return [
    ...baseArgs(mountRoot),
    "--dir", "/workspace",
    "--tmpfs", "/workspace",
    "--chdir", "/workspace",
    "/bin/sh",
    "-lc",
    [
      "set -eu",
      "test ! -e /mnt/c",
      "test \"$HOME\" = /tmp",
      ": > /workspace/.piwin-probe",
      "rm /workspace/.piwin-probe",
      "if grep -qE '^[^[:space:]]+[[:space:]]+00000000[[:space:]]+' /proc/net/route; then exit 23; fi",
      `printf '${WSL_CONTAINMENT_PROBE_MARKER}\\n'`,
    ].join("; "),
  ];
}

export function readWslContainmentProbe(stdout: string | undefined, status: number | null): WslContainmentProbe {
  if (status === 0 && stdout?.trim() === WSL_CONTAINMENT_PROBE_MARKER) {
    return {
      available: true,
      detail: "Bubblewrap namespaces hide Windows mounts, use an empty environment, and have no default network route",
    };
  }
  return {
    available: false,
    detail: "Bubblewrap containment probe failed; WSL routing remains unsandboxed",
  };
}
