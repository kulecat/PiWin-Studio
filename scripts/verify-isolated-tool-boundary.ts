/**
 * Regression check for the third-party tool boundary.
 *
 * In a Docker private-copy or Bubblewrap WSL task, Pi resource discovery must
 * not load external extension/MCP modules. `ask` may still make a PiWin-owned
 * host tool eligible for a human-approved call, but it must never weaken the
 * resource-loader boundary.
 */
import {
  allowExternalDockerTools,
  dockerHostToolsBoundaryActive,
  getDockerHostToolsMode,
} from "../src/host/docker-host-tools";
import {
  allowExternalWslTools,
  getWslHostToolsMode,
  wslHostToolsBoundaryActive,
} from "../src/host/wsl-host-tools";

const keys = [
  "PIWIN_EXECUTION_RUNNER",
  "PIWIN_DOCKER_WORKSPACE_ACCESS",
  "PIWIN_DOCKER_HOST_TOOLS",
  "PIWIN_WSL_CONTAINMENT",
  "PIWIN_WSL_PRIVATE_WORKSPACE",
  "PIWIN_WSL_HOST_TOOLS",
] as const;
const original = new Map(keys.map((key) => [key, process.env[key]]));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Isolated tool boundary smoke failed: ${message}`);
}

try {
  process.env.PIWIN_EXECUTION_RUNNER = "docker";
  process.env.PIWIN_DOCKER_WORKSPACE_ACCESS = "readwrite";
  process.env.PIWIN_DOCKER_HOST_TOOLS = "ask";
  assert(dockerHostToolsBoundaryActive(), "Docker private workspace boundary was not active");
  assert(getDockerHostToolsMode() === "ask", "Docker ask compatibility mode was not read");
  assert(!allowExternalDockerTools(), "Docker ask mode must not load extension/MCP modules");

  process.env.PIWIN_EXECUTION_RUNNER = "wsl";
  process.env.PIWIN_WSL_CONTAINMENT = "1";
  process.env.PIWIN_WSL_PRIVATE_WORKSPACE = "/home/hp/.piwin/task-sandboxes/00000000-0000-4000-8000-000000000000";
  process.env.PIWIN_WSL_HOST_TOOLS = "ask";
  assert(wslHostToolsBoundaryActive(), "WSL private workspace boundary was not active");
  assert(getWslHostToolsMode() === "ask", "WSL ask compatibility mode was not read");
  assert(!allowExternalWslTools(), "WSL ask mode must not load extension/MCP modules");

  process.stdout.write("ISOLATED_TOOL_BOUNDARY_SMOKE_OK\n");
} finally {
  for (const key of keys) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
