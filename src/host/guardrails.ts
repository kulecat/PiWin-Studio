/**
 * Harness governance layer: a policy gate that constrains the whole agent
 * execution, independent of which resources are assembled.
 *
 * Implemented as a pi inline extension intercepting tool_call events:
 * - per-tool policy: allow / ask (human approval) / deny
 * - tree-sitter Bash risk analysis plus user command rules -> deny or ask
 * - budgets: max turns & tool calls per prompt, max session cost
 *
 * State is a mutable reference read on every event, so changes apply
 * immediately without session reload.
 */
import { randomUUID } from "node:crypto";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type {
  ApprovalRequestPayload,
  HarnessGuardrails,
  PolicyEventPayload,
} from "@shared/protocol";
import { analyzeShellRisks } from "./shell-risk";
import { currentWorld } from "./execution-world";
import { hostPowerShellApprovalRule } from "./windows-execution";

// TypeScript's `import type` must not erase the runtime default policy.
import { DEFAULT_SHELL_RISK_POLICIES as defaultShellRiskPolicies } from "@shared/protocol";

export const guardrails: HarnessGuardrails = {
  toolPolicies: {},
  shellRiskPolicies: { ...defaultShellRiskPolicies },
  commandRules: [],
};

/** Workspace whose project boundary structural Bash checks enforce. */
let guardrailWorkspace = process.cwd();

export function setGuardrailWorkspace(workspace: string): void {
  guardrailWorkspace = workspace;
}

export function setGuardrails(next: HarnessGuardrails): void {
  guardrails.toolPolicies = next.toolPolicies ?? {};
  guardrails.shellRiskPolicies = {
    ...defaultShellRiskPolicies,
    ...next.shellRiskPolicies,
  };
  guardrails.commandRules = next.commandRules ?? [];
  guardrails.maxTurnsPerPrompt = next.maxTurnsPerPrompt;
  guardrails.maxToolCallsPerPrompt = next.maxToolCallsPerPrompt;
  guardrails.maxSessionCostUsd = next.maxSessionCostUsd;
  guardrails.subagentMaxConcurrent = next.subagentMaxConcurrent;
  guardrails.subagentMaxTurns = next.subagentMaxTurns;
  guardrails.maxRepeatedToolCalls = next.maxRepeatedToolCalls;
}

interface GuardrailHooks {
  requestApproval(request: ApprovalRequestPayload): void;
  /** Tell the UI an approval is no longer pending (resolved/timed out/cancelled). */
  resolvedApproval(id: string): void;
  emitPolicyEvent(event: PolicyEventPayload): void;
  /** Current cumulative session cost in USD (from session stats). */
  getSessionCost(): number;
}

let hooks: GuardrailHooks | undefined;

export function setGuardrailHooks(h: GuardrailHooks): void {
  hooks = h;
}

const pendingApprovals = new Map<string, (approved: boolean) => void>();

export function resolveApproval(id: string, approved: boolean): void {
  pendingApprovals.get(id)?.(approved);
  pendingApprovals.delete(id);
}

/** Deny and clear all pending approvals (e.g. when the run is aborted). */
export function cancelPendingApprovals(): void {
  for (const [id, resolve] of pendingApprovals) {
    resolve(false);
    hooks?.resolvedApproval(id);
  }
  pendingApprovals.clear();
}

const emit = (kind: PolicyEventPayload["kind"], toolName: string, detail: string): void => {
  hooks?.emitPolicyEvent({ id: randomUUID(), time: Date.now(), kind, toolName, detail });
};

/**
 * A non-bypassable approval layer for capabilities that live outside the
 * Docker-private workspace. It intentionally sits beside user-editable
 * per-tool policies so changing a tool from `ask` to `allow` cannot remove
 * the Docker host boundary.
 */
let mandatoryApprovalTools = new Set<string>();
let mandatoryApprovalRule: string | undefined;

export function setMandatoryToolApprovalGate(
  toolNames: Iterable<string>,
  rule?: string,
): void {
  mandatoryApprovalTools = new Set(toolNames);
  mandatoryApprovalRule = rule;
}

export function recordMandatoryToolBoundary(detail: string): void {
  emit("blocked", "docker_host_tools", detail);
}

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/** 通用人工审批原语：任何模块都可请求用户批准（复用同一张审批卡）。 */
export async function requestHumanApproval(
  toolName: string,
  input: Record<string, unknown>,
  rule?: string,
): Promise<boolean> {
  const detail = summarizeInput(input);
  emit("asked", toolName, detail);
  const approved = await awaitApproval(toolName, input, rule);
  emit(approved ? "approved" : "denied", toolName, detail);
  return approved;
}

function awaitApproval(toolName: string, input: Record<string, unknown>, rule?: string): Promise<boolean> {
  const id = randomUUID();
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(id);
      hooks?.resolvedApproval(id);
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);
    pendingApprovals.set(id, (approved) => {
      clearTimeout(timer);
      resolve(approved);
    });
    hooks?.requestApproval({ id, toolName, input, rule });
  });
}

const summarizeInput = (input: Record<string, unknown>): string => {
  const s = JSON.stringify(input);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
};

type BashRequirement =
  | { action: "allow" }
  | { action: "ask"; label: string }
  | { action: "deny"; label: string };

/**
 * Checks custom regex rules against both the submitted command and every
 * command extracted from its syntax tree. Thus an existing `sudo` rule also
 * catches `bash -c 'sudo …'` or a nested substitution rather than only the
 * outer string.
 */
async function bashRequirement(command: string): Promise<BashRequirement> {
  const analysis = await analyzeShellRisks(command, guardrailWorkspace);
  const candidates = new Set([
    command,
    ...analysis.commands.map((item) => [item.name, ...item.args].join(" ")),
  ]);
  const askLabels: string[] = [];
  for (const rule of guardrails.commandRules) {
    let expression: RegExp;
    try {
      expression = new RegExp(rule.pattern);
    } catch {
      // Invalid user-provided regexes do not make an execution path fail open.
      continue;
    }
    if (![...candidates].some((candidate) => {
      expression.lastIndex = 0;
      return expression.test(candidate);
    })) continue;
    const label = rule.note ?? rule.pattern;
    if (rule.action === "deny") return { action: "deny", label: `命令规则「${label}」` };
    askLabels.push(`命令规则「${label}」`);
  }

  for (const risk of analysis.risks) {
    const action = guardrails.shellRiskPolicies?.[risk.category] ?? defaultShellRiskPolicies[risk.category];
    if (action === "deny") return { action: "deny", label: `结构化风险：${risk.detail}` };
    if (action === "ask") askLabels.push(`结构化风险：${risk.detail}`);
  }
  if (askLabels.length > 0) {
    const fallback = analysis.usedFallback ? "（Bash 语法解析回退）" : "";
    return { action: "ask", label: `${[...new Set(askLabels)].join("；")}${fallback}` };
  }
  return { action: "allow" };
}

/**
 * bash 命令级策略检查（命令规则 + bash 工具策略），供 code_run 等
 * 绕过 session 工具循环的内部调用复用——保证同一条策略门管住所有执行路径。
 */
export async function enforceBashPolicy(
  command: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const toolMode = guardrails.toolPolicies["bash"] ?? "allow";
  if (toolMode === "deny") {
    emit("blocked", "bash", `code_run 内联命令被工具策略拦截: ${command.slice(0, 120)}`);
    return { ok: false, reason: "Harness 策略禁止使用 bash。" };
  }
  const requirement = await bashRequirement(command);
  if (requirement.action === "deny") {
    emit("blocked", "bash", `${requirement.label} 拦截: ${command.slice(0, 120)}`);
    return { ok: false, reason: `Harness 策略禁止此命令（${requirement.label}）。` };
  }
  const hostRule = currentWorld() === "local" ? hostPowerShellApprovalRule() : undefined;
  if (toolMode === "ask" || requirement.action === "ask" || hostRule) {
    const approved = await requestHumanApproval(
      "bash",
      { command },
      hostRule ?? (requirement.action === "ask" ? requirement.label : "bash 工具策略"),
    );
    if (!approved) return { ok: false, reason: "用户拒绝了此命令。" };
  }
  return { ok: true };
}

/** Per-prompt counters, reset on each agent_start. */
let toolCallCount = 0;
let turnCount = 0;
/** 循环卫生：连续完全相同的 工具+参数 调用计数。 */
let lastCallSignature = "";
let repeatCount = 0;

export function createGuardrailExtension(): InlineExtension {
  return {
    name: "bivor-guardrails",
    factory: (api) => {
      api.on("agent_start", () => {
        toolCallCount = 0;
        turnCount = 0;
        lastCallSignature = "";
        repeatCount = 0;
      });

      api.on("turn_start", () => {
        turnCount += 1;
      });

      api.on("tool_call", async (event) => {
        const toolName = event.toolName;
        const input = event.input as Record<string, unknown>;

        // 1) budget: tool call count / turn count per prompt
        if (guardrails.maxToolCallsPerPrompt && toolCallCount >= guardrails.maxToolCallsPerPrompt) {
          emit("budget_stop", toolName, `已达单次任务工具调用上限 ${guardrails.maxToolCallsPerPrompt}`);
          return {
            block: true,
            terminate: true,
            reason: `Harness 预算约束：单次任务最多 ${guardrails.maxToolCallsPerPrompt} 次工具调用，已达上限。请总结当前进展并结束。`,
          };
        }
        if (guardrails.maxTurnsPerPrompt && turnCount > guardrails.maxTurnsPerPrompt) {
          emit("budget_stop", toolName, `已达单次任务轮次上限 ${guardrails.maxTurnsPerPrompt}`);
          return {
            block: true,
            terminate: true,
            reason: `Harness 预算约束：单次任务最多 ${guardrails.maxTurnsPerPrompt} 轮，已达上限。请总结当前进展并结束。`,
          };
        }
        // 2) budget: session cost
        if (guardrails.maxSessionCostUsd) {
          const cost = hooks?.getSessionCost() ?? 0;
          if (cost >= guardrails.maxSessionCostUsd) {
            emit("budget_stop", toolName, `会话成本 $${cost.toFixed(4)} 已达上限 $${guardrails.maxSessionCostUsd}`);
            return {
              block: true,
              terminate: true,
              reason: `Harness 预算约束：会话成本已达 $${guardrails.maxSessionCostUsd} 上限。请立即总结并结束。`,
            };
          }
        }

        toolCallCount += 1;

        // 3) loop hygiene：同一 工具+参数 被连续重复调用，通常意味着模型
        // 卡进了循环（dsh guard 的 loop-hygiene 思路）。熔断并提示换路。
        const maxRepeats = guardrails.maxRepeatedToolCalls ?? 3;
        if (maxRepeats > 0) {
          let signature: string;
          try {
            signature = `${toolName}:${JSON.stringify(input)}`;
          } catch {
            signature = `${toolName}:<unserializable>`;
          }
          if (signature === lastCallSignature) {
            repeatCount += 1;
            if (repeatCount >= maxRepeats) {
              emit("blocked", toolName, `连续第 ${repeatCount + 1} 次完全相同的调用，已熔断`);
              return {
                block: true,
                reason: `你已连续 ${repeatCount + 1} 次用完全相同的参数调用 ${toolName}，结果不会改变。请换一种方法，或向用户说明遇到的困难。`,
              };
            }
          } else {
            lastCallSignature = signature;
            repeatCount = 0;
          }
        }

        // 4) Bash uses a real syntax tree to expose nested commands, pipeline
        // downloads, privilege wrappers, project escapes, and network tools.
        // Legacy custom regex rules are applied to every extracted command too.
        let bashPolicy: BashRequirement = { action: "allow" };
        let hostPowerShellRule: string | undefined;
        if (toolName === "bash" && typeof input.command === "string") {
          bashPolicy = await bashRequirement(input.command);
          if (bashPolicy.action === "deny") {
            emit("blocked", toolName, `${bashPolicy.label} 拦截: ${input.command.slice(0, 120)}`);
            return {
              block: true,
              reason: `Harness 策略禁止此命令（${bashPolicy.label}）。请改用其他方式或询问用户。`,
            };
          }
          if (currentWorld() === "local") hostPowerShellRule = hostPowerShellApprovalRule();
        }

        // 5) per-tool policy
        const mode = guardrails.toolPolicies[toolName] ?? "allow";
        if (mode === "deny") {
          emit("blocked", toolName, `工具策略为 deny: ${summarizeInput(input)}`);
          return {
            block: true,
            reason: `Harness 策略禁止使用工具 ${toolName}。请改用其他方式完成任务。`,
          };
        }
        // Docker host-side tools always require their own approval. A user
        // policy may make a tool stricter (`deny` above), but may not relax
        // this boundary to `allow`. Do not show a duplicate generic `ask`
        // card for the same call.
        const mustAskForHostBoundary = mandatoryApprovalTools.has(toolName);
        if (mustAskForHostBoundary || mode === "ask" || bashPolicy.action === "ask" || hostPowerShellRule) {
          const approved = await requestHumanApproval(
            toolName,
            input,
            mustAskForHostBoundary
              ? mandatoryApprovalRule
              : hostPowerShellRule
                ? hostPowerShellRule
                : bashPolicy.action === "ask"
                  ? bashPolicy.label
                  : "工具策略",
          );
          if (approved) return undefined;
          return {
            block: true,
            reason: `用户拒绝了本次 ${toolName} 调用。请调整方案或询问用户。`,
          };
        }
        return undefined;
      });
    },
  };
}
