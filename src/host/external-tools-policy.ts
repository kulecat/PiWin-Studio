/**
 * Third-party extension / MCP admission policy.
 *
 * `deny` is deliberately the default: resource modules may execute code while
 * being discovered, before a per-tool prompt exists. `ask` is an explicit
 * compatibility mode for packages a person has already reviewed; discovered
 * external tools start disabled and each call still enters the guardrail gate.
 */

export type ExternalToolsMode = "deny" | "ask";

export const EXTERNAL_TOOLS_MODE_ENV = "PIWIN_EXTERNAL_TOOLS_MODE";

const PIWIN_OWNED_TOOL_NAMES = new Set([
  "read", "write", "edit", "bash", "grep", "find", "ls",
  "memory_save", "subagent_run", "harness_propose",
  "vm_gui", "vm_file", "vm_screenshot",
  "code_run", "tool_search", "tool_activate",
  "web_search", "web_fetch", "browser", "deploy", "docker_credential_exec",
]);

interface ToolSession {
  getAllTools(): { name: string }[];
  getActiveToolNames(): string[];
  setActiveToolsByName(names: string[]): void;
}

export function getExternalToolsMode(environment: NodeJS.ProcessEnv = process.env): ExternalToolsMode {
  return environment[EXTERNAL_TOOLS_MODE_ENV]?.trim().toLowerCase() === "ask" ? "ask" : "deny";
}

/** True means no third-party extension/MCP module should be imported at all. */
export function denyExternalResourceLoading(environment: NodeJS.ProcessEnv = process.env): boolean {
  return getExternalToolsMode(environment) === "deny";
}

export function isPiWinOwnedTool(name: string): boolean {
  return PIWIN_OWNED_TOOL_NAMES.has(name);
}

/** Unknown tools are conservatively treated as third-party, including MCP tools. */
export function externalToolNames(session: ToolSession): string[] {
  return session.getAllTools().map((tool) => tool.name).filter((name) => !isPiWinOwnedTool(name));
}

/** In ask mode tools may be activated, but the host still requires a call approval. */
export function canAgentActivateExternalTool(name: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  return isPiWinOwnedTool(name) || getExternalToolsMode(environment) === "ask";
}

/** Remove third-party tools from the initial active set and return their names for call gating. */
export function applyExternalToolAdmission(session: ToolSession): string[] {
  if (getExternalToolsMode() !== "ask") return [];
  const external = externalToolNames(session);
  if (external.length > 0) {
    const blocked = new Set(external);
    session.setActiveToolsByName(session.getActiveToolNames().filter((name) => !blocked.has(name)));
  }
  return external;
}
