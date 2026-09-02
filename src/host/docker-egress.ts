/**
 * Docker allowlist egress for Windows.
 *
 * The agent container joins an `--internal` network, so it has no direct
 * default route to the internet. The short-lived proxy container is the only
 * peer on that network and has a second, ordinary bridge attachment for
 * outbound traffic. Keeping the enforcement point inside Docker avoids a
 * Windows-host proxy becoming reachable from unrestricted host processes.
 */
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { appendNetworkAudit } from "./audit";

const ALLOWLIST_ENV = "PIWIN_DOCKER_NETWORK_ALLOWLIST";
const PROXY_IMAGE_ENV = "PIWIN_DOCKER_PROXY_IMAGE";
const PROXY_ALIAS = "piwin-egress-proxy";
const MANAGED_LABEL = "io.piwin.egress-managed";
const DEFAULT_PROXY_IMAGE = "node:22-bookworm";

interface EgressRuntime {
  proxyName: string;
  networkName: string;
  allowlist: string[];
  logFollower?: ChildProcess;
}

let active: EgressRuntime | undefined;

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function isAllowlistEntry(value: string): boolean {
  // Exact DNS names and a single left-most wildcard only. IP literals and
  // localhost are intentionally excluded: they are common SSRF destinations.
  return /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(value);
}

/** Parse, normalise, and deduplicate the process-wide Docker allowlist. */
export function getDockerNetworkAllowlist(): string[] {
  const values = (process.env[ALLOWLIST_ENV] ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
  const invalid = values.filter((value) => !isAllowlistEntry(value));
  if (invalid.length > 0) {
    throw new Error(
      `${ALLOWLIST_ENV} contains invalid host entries: ${invalid.join(", ")}. Use comma-separated DNS names such as registry.npmjs.org or *.githubusercontent.com.`,
    );
  }
  return [...new Set(values)];
}

function proxyImage(): string {
  return process.env[PROXY_IMAGE_ENV]?.trim() || DEFAULT_PROXY_IMAGE;
}

function compactDockerError(stderr: string): Error {
  return new Error(stderr.replace(/\s+/g, " ").trim().slice(0, 500) || "Docker egress operation failed.");
}

function docker(args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker.exe", args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      else reject(compactDockerError(Buffer.concat(stderr).toString("utf8")));
    });
  });
}

async function managedObjectExists(kind: "container" | "network", name: string): Promise<boolean> {
  const format =
    kind === "container"
      ? `{{ index .Config.Labels "${MANAGED_LABEL}" }}`
      : `{{ index .Labels "${MANAGED_LABEL}" }}`;
  try {
    return (await docker([kind, "inspect", "--format", format, name])).trim() === "true";
  } catch (error) {
    if (/no such|not found/i.test(error instanceof Error ? error.message : String(error))) return false;
    throw error;
  }
}

async function cleanupManagedRuntime(proxyName: string, networkName: string): Promise<void> {
  if (await managedObjectExists("container", proxyName)) {
    await docker(["rm", "-f", proxyName], 30_000).catch(() => undefined);
  }
  if (await managedObjectExists("network", networkName)) {
    await docker(["network", "rm", networkName], 30_000).catch(() => undefined);
  }
}

const proxyProgram = String.raw`
const http = require("node:http");
const net = require("node:net");
const dns = require("node:dns").promises;
const allowlist = (process.env.PIWIN_ALLOWLIST || "").split(",").filter(Boolean);
const audit = (entry) => console.log("PIWIN_PROXY_AUDIT " + JSON.stringify(entry));
const normalize = (host) => String(host || "").toLowerCase().replace(/\.$/, "");
const allowed = (host) => allowlist.some((entry) => entry.startsWith("*.") ? host.endsWith("." + entry.slice(2)) : host === entry);
const publicV4 = (address) => {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) return false;
  const p = address.split(".").map(Number);
  if (p.some((n) => n < 0 || n > 255)) return false;
  if (p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224) return false;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false;
  if (p[0] === 169 && p[1] === 254) return false;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
  if (p[0] === 192 && (p[1] === 0 || p[1] === 168)) return false;
  if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return false;
  return true;
};
const publicAddress = async (host) => {
  const records = await dns.lookup(host, { all: true, verbatim: true });
  const selected = records.find((record) => record.family === 4 && publicV4(record.address));
  if (!selected) throw new Error("no_public_ipv4");
  return selected.address;
};
const splitAuthority = (authority, fallback) => {
  const value = String(authority || "");
  const match = /^([^:]+)(?::(\d+))?$/.exec(value);
  if (!match) return undefined;
  const port = Number(match[2] || fallback);
  return Number.isInteger(port) && (port === 80 || port === 443) ? { host: normalize(match[1]), port } : undefined;
};
const reject = (res, status, host, port, method, reason) => {
  audit({ action: "denied", host, port, method, reason });
  if (res.writeHead) res.writeHead(status, { "content-type": "text/plain" });
  res.end("PiWin Docker egress denied: " + reason + "\n");
};
const allowTarget = async (host, port, method, res) => {
  if (!host || !allowed(host)) { reject(res, 403, host, port, method, "host_not_allowlisted"); return undefined; }
  try { return await publicAddress(host); }
  catch { reject(res, 403, host, port, method, "non_public_or_unresolved_address"); return undefined; }
};
const server = http.createServer(async (req, res) => {
  let target;
  try { target = new URL(req.url); } catch { reject(res, 400, "", 0, req.method || "HTTP", "invalid_proxy_url"); return; }
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const host = normalize(target.hostname);
  if ((target.protocol !== "http:" && target.protocol !== "https:") || (port !== 80 && port !== 443)) {
    reject(res, 403, host, port, req.method || "HTTP", "unsupported_protocol_or_port"); return;
  }
  const address = await allowTarget(host, port, req.method || "HTTP", res);
  if (!address) return;
  const headers = { ...req.headers, host: target.host, connection: "close" };
  const upstream = http.request({ hostname: address, port, path: target.pathname + target.search, method: req.method, headers, agent: false }, (upstreamRes) => {
    audit({ action: "allowed", host, port, method: req.method || "HTTP", statusCode: upstreamRes.statusCode || 0 });
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on("error", () => reject(res, 502, host, port, req.method || "HTTP", "upstream_error"));
  req.pipe(upstream);
});
server.on("connect", async (req, client, head) => {
  const target = splitAuthority(req.url, 443);
  if (!target) { audit({ action: "denied", host: "", port: 0, method: "CONNECT", reason: "unsupported_port" }); client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
  const address = await allowTarget(target.host, target.port, "CONNECT", { end: (text) => client.end("HTTP/1.1 403 Forbidden\r\ncontent-length: " + Buffer.byteLength(text) + "\r\n\r\n" + text) });
  if (!address) return;
  const upstream = net.connect({ host: address, port: target.port });
  upstream.once("connect", () => {
    audit({ action: "allowed", host: target.host, port: target.port, method: "CONNECT" });
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client); client.pipe(upstream);
  });
  upstream.on("error", () => { audit({ action: "denied", host: target.host, port: target.port, method: "CONNECT", reason: "upstream_error" }); client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); });
});
server.listen(3128, "0.0.0.0", () => console.log("PIWIN_PROXY_READY"));
`;

async function waitForProxyReady(proxyName: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const logs = await docker(["logs", proxyName]).catch(() => "");
    if (logs.includes("PIWIN_PROXY_READY")) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const logs = await docker(["logs", proxyName]).catch(() => "");
  throw new Error(`PiWin Docker egress proxy did not become ready. ${logs.slice(0, 500)}`);
}

function startAuditFollower(runtime: EgressRuntime): void {
  const child = spawn("docker.exe", ["logs", "--follow", runtime.proxyName], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  runtime.logFollower = child;
  let pending = "";
  child.stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("PIWIN_PROXY_AUDIT ")) continue;
      try {
        const event = JSON.parse(line.slice("PIWIN_PROXY_AUDIT ".length)) as {
          action?: "allowed" | "denied";
          host?: string;
          port?: number;
          method?: string;
          reason?: string;
          statusCode?: number;
        };
        if (
          (event.action !== "allowed" && event.action !== "denied") ||
          typeof event.host !== "string" ||
          typeof event.port !== "number" ||
          !Number.isInteger(event.port) ||
          typeof event.method !== "string"
        ) {
          continue;
        }
        appendNetworkAudit({
          decision: event.action,
          host: event.host,
          port: event.port,
          method: event.method,
          reason: typeof event.reason === "string" ? event.reason : undefined,
          statusCode:
            typeof event.statusCode === "number" && Number.isInteger(event.statusCode)
              ? event.statusCode
              : undefined,
        });
      } catch {
        // The proxy is a best-effort audit producer; malformed log output must
        // never make an agent command fail.
      }
    }
  });
}

/** Create a per-agent proxy and its private Docker network before tool calls. */
export async function ensureDockerEgressProxy(sessionId: string): Promise<void> {
  const allowlist = getDockerNetworkAllowlist();
  if (allowlist.length === 0) {
    throw new Error(
      `${ALLOWLIST_ENV} is required when PIWIN_DOCKER_NETWORK=allow. Example: registry.npmjs.org,api.github.com`,
    );
  }
  const suffix = stableId(sessionId);
  const proxyName = `piwin-egress-proxy-${suffix}`;
  const networkName = `piwin-egress-net-${suffix}`;
  if (
    active?.proxyName === proxyName &&
    active.allowlist.join(",") === allowlist.join(",")
  ) {
    return;
  }
  await stopDockerEgressProxy();
  await cleanupManagedRuntime(proxyName, networkName);

  const runtime: EgressRuntime = { proxyName, networkName, allowlist };
  try {
    await docker([
      "network",
      "create",
      "--driver",
      "bridge",
      "--internal",
      "--label",
      `${MANAGED_LABEL}=true`,
      networkName,
    ]);
    await docker([
      "run",
      "-d",
      "--rm",
      "--init",
      "--name",
      proxyName,
      "--label",
      `${MANAGED_LABEL}=true`,
      "--network",
      "bridge",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=64m",
      "--tmpfs",
      "/home/node:rw,nosuid,nodev,size=64m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--pids-limit",
      "64",
      "--memory",
      "256m",
      "--memory-swap",
      "256m",
      "--cpus",
      "0.5",
      "--user",
      "node",
      "--env",
      `PIWIN_ALLOWLIST=${allowlist.join(",")}`,
      proxyImage(),
      "node",
      "-e",
      proxyProgram,
    ]);
    await waitForProxyReady(proxyName);
    await docker(["network", "connect", "--alias", PROXY_ALIAS, networkName, proxyName]);
    active = runtime;
    startAuditFollower(runtime);
  } catch (error) {
    await cleanupManagedRuntime(proxyName, networkName);
    throw error;
  }
}

/** Docker run arguments for a workload confined to the proxy-only network. */
export function dockerEgressInvocationArgs(): string[] {
  if (!active) {
    throw new Error("Docker allowlist egress is not ready. Restart the PiWin agent session.");
  }
  const proxyUrl = `http://${PROXY_ALIAS}:3128`;
  return [
    "--network",
    active.networkName,
    "--env",
    `HTTP_PROXY=${proxyUrl}`,
    "--env",
    `HTTPS_PROXY=${proxyUrl}`,
    "--env",
    `ALL_PROXY=${proxyUrl}`,
    "--env",
    `http_proxy=${proxyUrl}`,
    "--env",
    `https_proxy=${proxyUrl}`,
    "--env",
    `all_proxy=${proxyUrl}`,
    "--env",
    "NO_PROXY=localhost,127.0.0.1,::1",
  ];
}

/** Stop and remove only the proxy/network created by this PiWin host process. */
export async function stopDockerEgressProxy(): Promise<void> {
  const runtime = active;
  active = undefined;
  if (!runtime) return;
  runtime.logFollower?.kill();
  await cleanupManagedRuntime(runtime.proxyName, runtime.networkName);
}
