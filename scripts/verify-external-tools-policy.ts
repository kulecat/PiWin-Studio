/** Lightweight regression check for the P7 third-party admission boundary. */
import {
  applyExternalToolAdmission,
  canAgentActivateExternalTool,
  denyExternalResourceLoading,
  EXTERNAL_TOOLS_MODE_ENV,
  externalToolNames,
  getExternalToolsMode,
} from "../src/host/external-tools-policy";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`External tool policy smoke failed: ${message}`);
}

const previous = process.env[EXTERNAL_TOOLS_MODE_ENV];

try {
  delete process.env[EXTERNAL_TOOLS_MODE_ENV];
  assert(getExternalToolsMode() === "deny", "default policy must deny resource loading");
  assert(denyExternalResourceLoading(), "default policy must stop external module discovery");
  assert(!canAgentActivateExternalTool("mcp_filesystem"), "deny mode must not activate an unknown tool");

  process.env[EXTERNAL_TOOLS_MODE_ENV] = "ask";
  assert(getExternalToolsMode() === "ask", "ask configuration was not read");
  assert(!denyExternalResourceLoading(), "ask mode should permit already-reviewed resource loading");
  const active = ["read", "mcp_filesystem", "extension_publish"];
  const session = {
    getAllTools: () => active.map((name) => ({ name })),
    getActiveToolNames: () => [...active],
    setActiveToolsByName: (names: string[]) => {
      active.splice(0, active.length, ...names);
    },
  };
  assert(externalToolNames(session).join(",") === "mcp_filesystem,extension_publish", "unknown tools were not classified as external");
  const gated = applyExternalToolAdmission(session);
  assert(gated.join(",") === "mcp_filesystem,extension_publish", "ask mode did not return external gate names");
  assert(active.join(",") === "read", "external tools must start disabled in ask mode");
  assert(canAgentActivateExternalTool("mcp_filesystem"), "ask mode should allow explicit activation before its call approval");
  process.stdout.write("EXTERNAL_TOOL_POLICY_SMOKE_OK\n");
} finally {
  if (previous === undefined) delete process.env[EXTERNAL_TOOLS_MODE_ENV];
  else process.env[EXTERNAL_TOOLS_MODE_ENV] = previous;
}
