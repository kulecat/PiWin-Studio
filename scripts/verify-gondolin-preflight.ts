/** P8 contract: the QEMU probe is diagnostic-only and cannot enable a sandbox profile. */
import { inspectExecutionEnvironment } from "../src/host/windows-execution";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Gondolin preflight smoke failed: ${message}`);
}

const report = inspectExecutionEnvironment();
assert(report.platform === "win32", "this Windows-only check must run on Windows");
assert(report.gondolin, "Windows execution inspection omitted Gondolin preflight");
assert(report.gondolin.safeProfileAvailable === false, "an upstream QEMU probe must not expose a writable Gondolin runner");
assert(
  report.gondolin.prerequisites.map((item) => item.id).join(",") === "host_node,host_qemu,wsl_node,wsl_qemu,wsl_kvm",
  "Gondolin preflight prerequisite set changed unexpectedly",
);
process.stdout.write("GONDOLIN_PREFLIGHT_SMOKE_OK\n");
