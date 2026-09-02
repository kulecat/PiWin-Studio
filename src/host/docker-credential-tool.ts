/** One-shot, human-approved credential injection for the Docker runner. */
import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { appendCredentialAudit, runAuditedCommand } from "./audit";
import { resolveDockerCredentialValues } from "./docker-credential-policy";
import { requestHumanApproval } from "./guardrails";
import { resolveDockerCredentialInvocation } from "./windows-execution";

const MAX_OUTPUT_BYTES = 512 * 1024;

function redactKnownSecrets(text: string, credentials: { name: string; value: string }[]): string {
  let output = text;
  for (const { name, value } of credentials) {
    // Very short values create too many false positives; configured credentials
    // should be real tokens, not one-character test values.
    if (value.length >= 3) output = output.split(value).join(`[REDACTED:${name}]`);
  }
  return output;
}

async function runCredentialCommand(
  cwd: string,
  command: string,
  credentials: { name: string; value: string }[],
  signal?: AbortSignal,
): Promise<{ exitCode: number | null; output: string }> {
  const invocation = resolveDockerCredentialInvocation(
    command,
    cwd,
    credentials.map(({ name }) => name),
  );
  return runAuditedCommand(
    { world: "local", runner: "docker", cwd, command },
    () =>
      new Promise<{ exitCode: number | null; output: string }>((resolve, reject) => {
        const child = spawn(invocation.file, invocation.args, {
          cwd,
          windowsHide: true,
          env: invocation.env ?? process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const chunks: Buffer[] = [];
        let bytes = 0;
        let overflow = false;
        const collect = (chunk: Buffer): void => {
          bytes += chunk.length;
          if (bytes > MAX_OUTPUT_BYTES) {
            overflow = true;
            child.kill();
            return;
          }
          chunks.push(Buffer.from(chunk));
        };
        const abort = (): void => {
          child.kill();
        };
        signal?.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        child.on("error", (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        });
        child.on("close", (exitCode) => {
          signal?.removeEventListener("abort", abort);
          if (signal?.aborted) {
            reject(new Error("Operation aborted"));
            return;
          }
          if (overflow) {
            reject(new Error("Credential command output exceeded the 512 KiB safety limit."));
            return;
          }
          resolve({
            exitCode,
            output: redactKnownSecrets(Buffer.concat(chunks).toString("utf8"), credentials),
          });
        });
      }),
  );
}

/**
 * This is deliberately separate from bash: each execution gets fresh Docker
 * `--env NAME` flags and exits with that disposable container. A later bash
 * call cannot recover the credential.
 */
export function buildDockerCredentialExecTool(getCwd: () => string): ToolDefinition {
  return {
    name: "docker_credential_exec",
    label: "Docker 临时凭据执行",
    description:
      "仅在 Windows Docker 模式下，用已由用户配置的环境变量名临时运行一条命令。每次调用均须人工审批；凭据仅存在于本次容器进程，输出中的已知明文凭据会被遮蔽。",
    promptSnippet: "docker_credential_exec: 经人工审批，在一次 Docker 命令中临时注入已配置凭据",
    parameters: Type.Object({
      command: Type.String({ description: "在 Docker 私有工作区运行的一条 shell 命令" }),
      credentials: Type.Array(Type.String(), {
        description: "需要的已配置凭据环境变量名，例如 NPM_TOKEN；不得猜测或请求未配置名称",
        minItems: 1,
        maxItems: 8,
      }),
    }),
    execute: async (_id, params, signal) => {
      const input = params as { command: string; credentials: string[] };
      const credentials = resolveDockerCredentialValues(input.credentials);
      const names = credentials.map(({ name }) => name);
      const approved = await requestHumanApproval(
        "docker_credential_exec",
        { command: input.command, credentials: names },
        "Docker temporary credentials: inject only these names into one disposable container?",
      );
      if (!approved) {
        appendCredentialAudit({ decision: "denied", names });
        return {
          content: [{ type: "text", text: "用户拒绝了本次 Docker 临时凭据注入。" }],
          details: { credentialNames: names, approved: false },
        };
      }
      appendCredentialAudit({ decision: "approved", names });
      try {
        const result = await runCredentialCommand(getCwd(), input.command, credentials, signal);
        appendCredentialAudit({ decision: "executed", names, exitCode: result.exitCode });
        const header = result.exitCode === 0 ? "Command completed." : `Command exited with code ${result.exitCode ?? "unknown"}.`;
        return {
          content: [{ type: "text", text: `${header}\n${result.output}`.slice(0, MAX_OUTPUT_BYTES) }],
          details: { credentialNames: names, exitCode: result.exitCode, approved: true },
        };
      } catch (error) {
        appendCredentialAudit({ decision: "failed", names, exitCode: null });
        throw error;
      }
    },
  } as ToolDefinition;
}
