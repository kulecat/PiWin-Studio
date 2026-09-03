/**
 * Boundary for tools that are not routed through PiWin's Docker-private
 * workspace. Keep this separate from command routing: a tool can be useful,
 * but still execute on the host and therefore need an explicit trust decision.
 */
import { isDockerHostWriteBlocked } from "./windows-execution";

export type DockerHostToolsMode = "deny" | "ask";

const DOCKER_HOST_TOOLS_ENV = "PIWIN_DOCKER_HOST_TOOLS";

/** These tools operate only on PiWin's Docker-private task workspace. */
const DOCKER_VOLUME_TOOL_NAMES = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
  // These only inspect or update the session's own tool directory; they do
  // not execute a host capability by themselves.
  "tool_search",
  "tool_activate",
  // It has its own mandatory per-call credential approval and executes in the
  // same private Docker workspace; it is not a host-side capability.
  "docker_credential_exec",
]);

export function dockerHostToolsBoundaryActive(): boolean {
  return isDockerHostWriteBlocked();
}

/**
 * `deny` is deliberately the default: Pi resource extensions can execute
 * JavaScript while loading, before a tool-call approval could be shown.
 * `ask` is an opt-in for extensions whose source the user has already
 * reviewed and trusted.
 */
export function getDockerHostToolsMode(): DockerHostToolsMode {
  return process.env[DOCKER_HOST_TOOLS_ENV]?.trim().toLowerCase() === "ask" ? "ask" : "deny";
}

export function isDockerVolumeTool(name: string): boolean {
  return DOCKER_VOLUME_TOOL_NAMES.has(name);
}

/**
 * Whether Pi's resource loader may load external extensions / MCP adapters.
 *
 * `ask` is deliberately not enough to load third-party code here. An
 * extension can run arbitrary JavaScript while Pi discovers it, before any
 * tool-call approval exists. Isolated task profiles therefore quarantine all
 * external resource packages; `ask` only affects separately registered PiWin
 * host tools, whose actual calls still require approval.
 */
export function allowExternalDockerTools(): boolean {
  return !dockerHostToolsBoundaryActive();
}

/** Prevent the model from bypassing the default boundary via tool_activate. */
export function canAgentActivateDockerTool(name: string): boolean {
  return (
    !dockerHostToolsBoundaryActive() ||
    getDockerHostToolsMode() === "ask" ||
    isDockerVolumeTool(name)
  );
}
