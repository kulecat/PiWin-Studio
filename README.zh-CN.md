<p align="center">
  <img src="docs/logo.png" width="64" alt="PiWin Studio">
</p>

<h1 align="center">PiWin Studio</h1>

<p align="center">面向 Windows 和 WSL2 的 Pi coding agent 桌面工作台。</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <a href="THIRD_PARTY_NOTICES.md"><img alt="Upstream" src="https://img.shields.io/badge/derived%20from-Bivor-orange?style=flat-square" /></a>
</p>

<p align="center">
  <img alt="Electron" src="https://img.shields.io/badge/Electron-43-47848F?style=flat-square&logo=electron&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" />
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-10-F69220?style=flat-square&logo=pnpm&logoColor=white" />
  <img alt="Windows" src="https://img.shields.io/badge/Windows-0078D4?style=flat-square&logo=windows&logoColor=white" />
  <img alt="WSL2" src="https://img.shields.io/badge/WSL2-Linux-FCC624?style=flat-square&logo=linux&logoColor=black" />
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md"><b>简体中文</b></a>
</p>

<p align="center">
  <a href="#功能">功能</a> ·
  <a href="#安装">安装</a> ·
  <a href="#从源码开发">开发</a> ·
  <a href="#架构">架构</a> ·
  <a href="#许可">许可</a>
</p>

> **来源说明：**PiWin Studio 是基于 [Bivor](https://github.com/ryanlab/bivor) 开发的 Windows/WSL2 适配项目。Bivor 的版权归 ryanlab（Copyright (c) 2026 ryanlab）所有，使用 MIT 许可证；详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

**PiWin Studio** 是基于 [Pi Agent Harness](https://github.com/earendil-works/pi) 的桌面工作台。它保留 Bivor 的 Electron/Pi SDK 基础，并新增 Windows 打包、PowerShell 执行兼容、Docker 受限命令执行和审计层。

Windows 版本已提供 NSIS 打包目标、PowerShell 本机终端与单次命令执行器、标准 Windows Chrome/Edge 路径发现，以及默认禁网、资源限制、内置文件工具统一路由和私有任务副本补丁导入的显式 Docker 工具 profile。WSL2 隔离和可恢复多 Agent 工作流见 [docs/windows-port.md](docs/windows-port.md)。

每个会话都在独立的 Electron utility process 中运行 pi SDK（`AgentSessionRuntime`）。会话、认证、技能、提示模板、MCP 配置与 pi CLI 完全互通（`~/.pi/agent/`），终端与桌面端可以随时切换。

## 功能

### 核心对话与多任务

- **多任务并行** — 每个会话运行在独立 utility process 中,崩溃隔离、可独立中止
- **受控 Git worktree 任务** — 主工作区干净时才创建 `piwin/task/*` 任务分支；先冻结审核快照，再由人工确认合并，主分支变化或审核后再修改都会被拒绝
- **Docker 可写私有任务** — Docker 命令只写入任务专属 volume；PiWin 预览、校验并在人工确认后将补丁导入受控 worktree，之后才能审核
- **会话树与分叉** — 可视化历史树,任意消息处分叉(同文件保留全部历史,随时切回);任意用户消息「编辑并分叉」;被放弃分支的经验可由 LLM 总结后带入新分支
- **流式对话** — 思考过程折叠展示、Markdown 流式渲染 + shiki 双主题代码高亮、光标动画
- **工具调用可视化** — bash 输出流、read/grep/ls 结果、edit 内联 diff、write 文件预览,含运行中/成功/失败状态与分类配色
- **变更审查面板** — 基于 Git 基线,聚合会话内所有文件改动,逐文件展示 unified diff
- **检查点回滚** — 每次发送 prompt 前自动做 git 快照(`refs/pi-checkpoints/`,不动暂存区),可整体或按文件回滚到任意一轮之前
- **引导与追问** — agent 运行中可「立即引导(steer)」或「稍后追问(follow-up)」,队列可视化、一键清空
- **任务总览 Mission Control**(⌘O)— 卡片网格实时展示所有任务:状态、当前工具、内联审批、子 agent、tokens 与花费
- **图片输入** — 粘贴 / 拖拽 / 选择图片发送给多模态模型
- **`!` 终端与 `@` 文件引用** — 输入以 `!` 开头直接在会话 shell 中执行(输出记入 agent 上下文);输入 `@` 模糊搜索项目文件
- **搜索与导出** — 会话内搜索(⌘F)、跨会话全文搜索、导出 HTML / JSONL
- **自动命名、重试可视化、系统通知** — LLM 生成标题,限流自动重试不再像卡死,后台任务完成自动通知

### 运行预设

按会话选择 agent 的能力边界,预设同时约束工具与 UI:

| 预设 | 说明 |
|------|------|
| **日常** | 聊天 / 写作助手,无编码副作用;web 搜索、网页抓取、记忆 |
| **编码** | 完整 agent:全部工具、worktree、沙箱、harness |
| **审查** | 只读检索;护栏拒绝 write/edit/bash |
| **极简** | 仅 `bash` + `read` + `edit` |

### Harness 编排与治理

- **可视化装配画布** — agent 完整管线实时呈现:模型 → 系统提示词(含来源、AGENTS.md 组成、token 估算)→ 追加指令 → 工具 → 扩展 → 技能 → 提示模板
- **热编排** — 按会话开关技能 / 扩展、追加系统级指令,`session.reload()` 原地重组系统提示词,对话历史保留
- **护栏(Guardrails)** — 按工具 allow/ask/deny 策略、基于 AST 的 Bash 风险策略（删除、提权、下载后执行、工作区越界、联网）、同时作用于嵌套命令的自定义正则规则、预算(回合数 / 工具调用数 / 会话花费)、子 agent 限额、重复调用熔断;全部以内联审批卡片呈现
- **自调优** — agent 可通过 `harness_propose` 提出装配变更,审批后回合结束热生效
- **轨迹抽屉** — 逐模型步骤记录实际发送的装配快照与工具调用
- **工具渐进披露** — 工具过多时折叠为 `tool_search` / `tool_activate`,节省上下文
- **预设库** — 保存并复用 harness 配置

### Agent 能力

- **执行世界** — 内置 bash/read/write/edit 可在本地或云端 VM 中执行(`set_execution_world`)
- **云端 VM 沙箱(E2B)** — 完整桌面 VM,实时画面流、`vm_gui` 鼠标键盘控制、`vm_file` 文件传输、`vm_screenshot`
- **本地沙箱** — macOS seatbelt 配置:`off` / `workspace` / `strict`
- **受限 Docker 工具（Windows）** — 显式启用、默认禁网、容器根目录只读、移除 capabilities、进程/CPU/内存限制；`bash/read/write/edit/grep/find/ls` 共享经凭据过滤的只读或任务私有 volume，导入补丁并人工确认后才改宿主 worktree。可选联网强制经过域名白名单代理，并逐请求写入审计记录；凭据只能由用户批准后临时注入单次容器。宿主侧扩展/MCP 默认不加载；仅允许已审查的显式启用项逐次审批并记录审计日志
- **子 agent** — `subagent_run` 最多并行 4 个(可只读或绑定 VM),Dock 实时监控
- **浏览器** — puppeteer-core 驱动有头 Chrome/Edge,持久化用户配置
- **Web** — Tavily 驱动的 `web_search` + 免 key 的 `web_fetch`(网页转 markdown)
- **代码模式** — `code_run` 在 `node:vm` 中执行 JavaScript,内置 `pi.bash` / `pi.log`,与护栏、执行世界同规
- **部署** — 一条命令把工作区部署到 Vercel(默认 preview,自动排除密钥与 `.env`,需审批),另有完整部署运维面板(日志 / promote / 回滚 / 重新部署)
- **项目记忆** — agent 将长期记忆写入 `.pi/memory.md`,跨会话注入系统提示词

### 资源与互通

- **插件包管理** — 安装 / 卸载 / 批量更新 npm 与 git 插件包(全局或项目级),与 pi CLI 共享 `packages` 配置
- **技能与提示模板** — 列出全部来源(全局 / 项目 / 插件包),应用内新建(SKILL.md 脚手架)、编辑、删除
- **MCP** — 一键安装 `pi-mcp-adapter`,可视化查看已配置服务器,编辑全局 `mcp.json` / 项目 `.mcp.json`
- **CLI 互通** — 直接读写 pi 的 JSONL 会话文件(`~/.pi/agent/sessions/`);历史会话恢复、重命名、删除(移入废纸篓)
- **项目信任门控** — 加载 `.pi` 项目资源前须用户明确授权,对齐 pi CLI 安全模型

### 会话、模型与认证

- **模型管理** — pi SDK 全 provider 目录、思考等级切换、上下文用量、成本追踪、手动压缩
- **API key** — 写入 `~/.pi/agent/auth.json`,与 CLI 共用;`models.json` 支持自定义 provider / 中转
- **桌面端 OAuth** — 订阅账号(Claude Pro / ChatGPT / Copilot 等)在设置里直接完成浏览器授权,无需终端

### 定时任务与体验

- **定时任务** — 间隔 / 每日 / 每周自动运行 agent,后台执行或打开会话,完成后通知
- **终端** — 每会话多标签用户 PTY,另有可交互的 agent shell(agent 运行时你也能输入)
- **设计系统** — 暖色盘 Claude 风明 / 暗双主题(可跟随系统),衬线标题、精细动效
- **命令面板**(⌘K)、快捷键速查(⌘/)、用量仪表盘、国际化(English / 中文)

## 安装

从 [Releases](https://github.com/ryanlab/bivor/releases) 下载最新 DMG——Apple Silicon 选 `arm64`,Intel 机型选 `x64`。

> [!WARNING]
> 当前构建未签名（暂无 Apple 开发者证书）。首次启动请右键应用 → **打开**，或清除隔离属性：`xattr -cr /Applications/Bivor.app`。

## 从源码开发

要求:macOS(Apple Silicon 或 Intel)、Node.js ≥ 20、[pnpm](https://pnpm.io)。

```bash
git clone https://github.com/ryanlab/bivor.git
cd bivor
pnpm install
pnpm dev          # electron-vite dev(HMR)
pnpm typecheck
pnpm build        # 构建到 out/
pnpm dist:mac     # 打包 DMG + ZIP 到 dist/
```

### 配置

| 内容 | 位置 |
|------|------|
| 模型 API key / OAuth(与 pi CLI 共用) | `~/.pi/agent/auth.json`,可在设置中管理 |
| 自定义 provider / 中转 | `models.json`(兼容 pi CLI) |
| 会话(与 pi CLI 共用) | `~/.pi/agent/sessions/` |
| 应用配置(下列可选 key) | Electron `userData/bivor-config.json` |

可选集成,在设置中配置后启用对应工具:

- **E2B API key** — 云端 VM 沙箱(`E2B_API_KEY`)
- **Tavily API key** — `web_search`(`TAVILY_API_KEY`)
- **Vercel token** — 部署工具 + 部署面板(`VERCEL_TOKEN`、`VERCEL_TEAM_ID`)
- **`CHROME_PATH`** — 覆盖浏览器工具使用的浏览器路径

## 架构

```
┌─────────────┐  IPC   ┌──────────────┐  postMessage  ┌────────────────────┐
│  Renderer    │◄──────►│ Main process │◄─────────────►│ Utility process ×N │
│  React 19    │        │ 窗口/菜单/    │               │ pi SDK             │
│  zustand     │        │ 全局服务      │               │ AgentSessionRuntime│
└─────────────┘        └──────────────┘               └────────────────────┘
```

- `src/main/` — 窗口、菜单、chat 进程编排、全局服务(模型目录 / 认证 / OAuth / 会话列表 / worktree / 检查点 / 定时任务 / 终端)
- `src/host/` — agent 宿主:内嵌 pi SDK runtime,事件流裁剪转发,树导航,沙箱 / 护栏 / 子 agent / 浏览器 / web / 代码模式 / 部署 / 记忆
- `src/preload/` — contextBridge 类型化 API
- `src/renderer/` — React UI,事件流 reducer 在 `stores/app-store.ts`
- `src/shared/protocol.ts` — 三进程共享的类型化协议

## 测试

```bash
node scripts/sdk-smoke.mjs <provider>   # SDK 层冒烟
node scripts/e2e-cdp.mjs full "任务描述"  # CDP 驱动的真实 UI 端到端
node scripts/e2e-harness.mjs            # 资源中心 + harness 热编排验证
node scripts/shot.mjs out.png "js表达式"  # CDP 截图 / 状态注入
```

E2E 需要应用以 `--remote-debugging-port=9223` 启动。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

[MIT](LICENSE)
