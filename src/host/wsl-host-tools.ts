/**
 * WSL containment only covers PiWin's routed first-party workspace tools.
 * Extensions and MCP adapters execute in the Electron utility process unless
 * explicitly designed otherwise, so deny them by default in this profile.
 */
import { isWslPrivateWorkspaceRoutingActive } from "./windows-execution";

export type WslHostToolsMode = "deny" | "ask";

const WSL_HOST_TOOLS_ENV = "PIWIN_WSL_HOST_TOOLS";
const WSL_WORKSPACE_TOOL_NAMES = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
  "tool_search",
  "tool_activate",
]);

export function wslHostToolsBoundaryActive(): boolean {
  return isWslPrivateWorkspaceRoutingActive();
}

/** `ask` is an advanced opt-in for externally reviewed extensions only. */
export function getWslHostToolsMode(): WslHostToolsMode {
  return process.env[WSL_HOST_TOOLS_ENV]?.trim().toLowerCase() === "ask" ? "ask" : "deny";
}

export function isWslWorkspaceTool(name: string): boolean {
  return WSL_WORKSPACE_TOOL_NAMES.has(name);
}

export function allowExternalWslTools(): boolean {
  return !wslHostToolsBoundaryActive() || getWslHostToolsMode() === "ask";
}

export function canAgentActivateWslTool(name: string): boolean {
  return !wslHostToolsBoundaryActive() || getWslHostToolsMode() === "ask" || isWslWorkspaceTool(name);
}
