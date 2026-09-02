/**
 * Structural shell-risk analysis for the PiWin execution gate.
 *
 * The primary implementation uses the tree-sitter Bash grammar through WASM.
 * It walks commands nested in substitutions/subshells, keeps pipeline
 * membership, and re-parses `sh -c` payloads. A small lexical fallback keeps
 * the policy gate useful if a packaged grammar cannot be loaded; it is never
 * presented as an isolation boundary (Docker/worktree controls provide that).
 */
import { createRequire } from "node:module";
import { basename, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import type { ShellRiskCategory } from "@shared/protocol";

interface SyntaxNodeLike {
  type: string;
  text: string;
  children: SyntaxNodeLike[];
}

export interface ParsedShellCommand {
  name: string;
  args: string[];
  nested: boolean;
  /** Commands joined by the same shell pipeline have the same id. */
  pipeline: number | undefined;
}

export interface ShellRiskHit {
  category: ShellRiskCategory;
  detail: string;
}

export interface ShellRiskAnalysis {
  commands: ParsedShellCommand[];
  risks: ShellRiskHit[];
  /** True only if the WASM grammar was unavailable or rejected the command. */
  usedFallback: boolean;
}

const NESTED_CONTEXTS = new Set(["command_substitution", "subshell", "process_substitution"]);
const ARGUMENT_NODES = new Set([
  "word",
  "string",
  "raw_string",
  "ansi_c_string",
  "concatenation",
  "number",
  "simple_expansion",
  "expansion",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const WRAPPERS = new Set([
  "env",
  "command",
  "nice",
  "ionice",
  "nohup",
  "setsid",
  "stdbuf",
  "timeout",
  "time",
  "xargs",
  "exec",
  "builtin",
]);
const PRIVILEGE_COMMANDS = new Set(["sudo", "su", "doas", "pkexec", "runuser", "setpriv", "chroot"]);
const DELETE_COMMANDS = new Set(["rm", "rmdir", "unlink", "shred", "del", "erase", "rd", "remove-item"]);
const DOWNLOAD_COMMANDS = new Set([
  "curl",
  "wget",
  "aria2c",
  "invoke-webrequest",
  "iwr",
  "irm",
  "start-bitstransfer",
]);
const EXECUTION_COMMANDS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "pwsh",
  "powershell",
  "cmd",
  "python",
  "python3",
  "node",
  "deno",
  "iex",
  "invoke-expression",
]);
const DIRECT_NETWORK_COMMANDS = new Set([
  ...DOWNLOAD_COMMANDS,
  "ssh",
  "scp",
  "sftp",
  "ftp",
  "rsync",
  "nc",
  "ncat",
  "netcat",
  "ping",
  "dig",
  "nslookup",
  "host",
]);

const trimQuotes = (value: string): string => value.trim().replace(/^['"]+|['"]+$/g, "");
const commandBase = (name: string): string => basename(name.replace(/\\/g, "/")).toLowerCase();

function parseCommandNode(node: SyntaxNodeLike, nested: boolean, pipeline: number | undefined): ParsedShellCommand {
  let name = "";
  const args: string[] = [];
  for (const child of node.children ?? []) {
    if (child.type === "command_name" && !name) name = trimQuotes(child.text);
    else if (ARGUMENT_NODES.has(child.type)) args.push(trimQuotes(child.text));
  }
  return { name, args, nested, pipeline };
}

function extractCommands(root: SyntaxNodeLike): ParsedShellCommand[] {
  const commands: ParsedShellCommand[] = [];
  let nextPipeline = 1;
  const walk = (node: SyntaxNodeLike, nested: boolean, inheritedPipeline: number | undefined): void => {
    const inNestedContext = nested || NESTED_CONTEXTS.has(node.type);
    const pipeline = node.type === "pipeline" ? nextPipeline++ : inheritedPipeline;
    if (node.type === "command") commands.push(parseCommandNode(node, inNestedContext, pipeline));
    for (const child of node.children ?? []) walk(child, inNestedContext, pipeline);
  };
  walk(root, false, undefined);
  return commands.filter((command) => command.name.length > 0);
}

function shellScript(command: ParsedShellCommand): string | undefined {
  if (!SHELLS.has(commandBase(command.name))) return undefined;
  let acceptsCommand = false;
  for (const arg of command.args) {
    if (arg.startsWith("-")) {
      if (arg.includes("c")) acceptsCommand = true;
      continue;
    }
    return acceptsCommand ? arg : undefined;
  }
  return undefined;
}

function commandChain(command: ParsedShellCommand): { heads: string[]; head: string; args: string[] } {
  let head = commandBase(command.name);
  let args = command.args;
  const heads: string[] = [];
  for (let hop = 0; hop < 8; hop += 1) {
    heads.push(head);
    // A privilege launcher invokes the command that follows it just like an
    // execution wrapper does. Keep its own name in `heads` so escalation is
    // still reported while deletion/network checks see the effective command.
    if (!WRAPPERS.has(head) && !PRIVILEGE_COMMANDS.has(head)) return { heads, head, args };
    const index = args.findIndex((arg) => !/^(?:-|[A-Za-z_]\w*=|\d+$)/.test(arg));
    if (index < 0) return { heads, head, args };
    head = commandBase(args[index]);
    args = args.slice(index + 1);
  }
  return { heads, head, args };
}

function privilegeEscalation(command: ParsedShellCommand): string | undefined {
  return commandChain(command).heads.find((head) => PRIVILEGE_COMMANDS.has(head));
}

function isDestructive(command: ParsedShellCommand): boolean {
  const effective = commandChain(command);
  const { head } = effective;
  if (DELETE_COMMANDS.has(head)) return true;
  if (head !== "git") return false;
  const [operation, ...rest] = effective.args.map((arg) => arg.toLowerCase());
  return operation === "clean" || (operation === "reset" && rest.includes("--hard"));
}

function isNetworkCommand(command: ParsedShellCommand): boolean {
  const effective = commandChain(command);
  const { head } = effective;
  if (DIRECT_NETWORK_COMMANDS.has(head)) return true;
  const operation = effective.args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
  if (head === "git") return ["clone", "fetch", "pull", "push", "ls-remote", "submodule"].includes(operation ?? "");
  if (["npm", "pnpm", "yarn", "bun"].includes(head)) {
    return ["install", "add", "ci", "update", "upgrade", "publish", "audit"].includes(operation ?? "");
  }
  if (["pip", "pip3", "poetry", "uv"].includes(head)) {
    return ["install", "download", "update", "publish", "sync"].includes(operation ?? "");
  }
  return false;
}

function isWorkspacePath(token: string, workspace: string): boolean {
  const value = trimQuotes(token);
  if (!value || value.startsWith("-") || value.includes("=") || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true;
  // Docker's first-party tools always place the isolated task copy here.
  if (value === "/workspace" || value.startsWith("/workspace/")) return true;
  const candidate = isAbsolute(value) || win32.isAbsolute(value)
    ? value
    : resolve(workspace, value);
  const rel = relative(workspace, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel) && !win32.isAbsolute(rel));
}

function hasWorkspaceEscape(command: ParsedShellCommand, workspace: string): boolean {
  return [command.name, ...command.args].some((token) => !isWorkspacePath(token, workspace));
}

function fallbackScan(source: string): ParsedShellCommand[] {
  const segments: { text: string; pipeline: number | undefined }[] = [];
  let buffer = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let pipeline: number | undefined;
  let nextPipeline = 1;
  const flush = (): void => {
    const text = buffer.trim();
    if (text) segments.push({ text, pipeline });
    buffer = "";
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      buffer += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      buffer += char;
      escaped = true;
      continue;
    }
    if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote === char ? undefined : char;
      buffer += char;
      continue;
    }
    if (!quote && char === "|") {
      flush();
      pipeline ??= nextPipeline++;
      if (source[index + 1] === "|") {
        pipeline = undefined;
        index += 1;
      }
      continue;
    }
    if (!quote && (char === ";" || char === "\n" || (char === "&" && source[index + 1] !== "&"))) {
      flush();
      pipeline = undefined;
      continue;
    }
    if (!quote && char === "&" && source[index + 1] === "&") {
      flush();
      pipeline = undefined;
      index += 1;
      continue;
    }
    buffer += char;
  }
  flush();
  return segments.map(({ text, pipeline: segmentPipeline }) => {
    const words = text.match(/(?:[^\s'"\\]|\\.|'(?:[^']*)'|"(?:[^"\\]|\\.)*")+/g) ?? [];
    const [name = "", ...args] = words.map(trimQuotes);
    return { name, args, nested: false, pipeline: segmentPipeline };
  }).filter((command) => command.name.length > 0);
}

interface Parser {
  parse(command: string): ParsedShellCommand[];
}

let parserPromise: Promise<Parser | undefined> | undefined;

async function loadParser(): Promise<Parser | undefined> {
  try {
    const { Parser: TreeSitterParser, Language } = await import("web-tree-sitter");
    const require = createRequire(import.meta.url);
    const coreWasm = require.resolve("web-tree-sitter/tree-sitter.wasm");
    const bashWasm = require.resolve("tree-sitter-bash/tree-sitter-bash.wasm");
    await TreeSitterParser.init({ locateFile: () => coreWasm });
    const language = await Language.load(bashWasm);
    const parser = new TreeSitterParser();
    parser.setLanguage(language);
    return {
      parse(command: string): ParsedShellCommand[] {
        const tree = parser.parse(command);
        return tree ? extractCommands(tree.rootNode as unknown as SyntaxNodeLike) : [];
      },
    };
  } catch {
    return undefined;
  }
}

function expandShellScripts(parse: (command: string) => ParsedShellCommand[], commands: ParsedShellCommand[], depth = 0): ParsedShellCommand[] {
  if (depth >= 3) return commands;
  const expanded: ParsedShellCommand[] = [];
  for (const command of commands) {
    expanded.push(command);
    const script = shellScript(command);
    if (!script) continue;
    try {
      expanded.push(...expandShellScripts(
        parse,
        parse(script).map((inner) => ({ ...inner, nested: true })),
        depth + 1,
      ));
    } catch {
      // The outer shell invocation remains covered even if its payload is invalid.
    }
  }
  return expanded;
}

function detectRisks(commands: ParsedShellCommand[], workspace: string): ShellRiskHit[] {
  const risks = new Map<ShellRiskCategory, string>();
  const commandGroups = new Map<number, ParsedShellCommand[]>();
  for (const command of commands) {
    if (isDestructive(command)) risks.set("deletion", `删除操作：${commandBase(command.name)}`);
    const escalation = privilegeEscalation(command);
    if (escalation) risks.set("privilegeEscalation", `提权操作：${escalation}`);
    if (hasWorkspaceEscape(command, workspace)) risks.set("workspaceEscape", "命令参数越过当前项目工作区");
    if (isNetworkCommand(command)) risks.set("network", `联网命令：${commandBase(command.name)}`);
    if (command.pipeline !== undefined) {
      const group = commandGroups.get(command.pipeline) ?? [];
      group.push(command);
      commandGroups.set(command.pipeline, group);
    }
  }
  for (const group of commandGroups.values()) {
    if (group.some((command) => DOWNLOAD_COMMANDS.has(commandBase(command.name)))
      && group.some((command) => EXECUTION_COMMANDS.has(commandBase(command.name)))) {
      risks.set("downloadExecution", "下载内容通过管道交给解释器执行");
    }
  }
  return [...risks.entries()].map(([category, detail]) => ({ category, detail }));
}

/** Parse a shell command and classify its execution behavior before it runs. */
export async function analyzeShellRisks(command: string, workspace: string): Promise<ShellRiskAnalysis> {
  parserPromise ??= loadParser();
  const parser = await parserPromise;
  if (parser) {
    try {
      const commands = expandShellScripts((source) => parser.parse(source), parser.parse(command));
      return { commands, risks: detectRisks(commands, workspace), usedFallback: false };
    } catch {
      // Fall through to a conservative lexical scan below.
    }
  }
  const commands = fallbackScan(command);
  return { commands, risks: detectRisks(commands, workspace), usedFallback: true };
}
