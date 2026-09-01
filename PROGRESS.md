# PiWin Studio progress log

Last updated: 2026-09-01

## Product boundary

PiWin Studio is a Windows and WSL2-oriented desktop workbench for Pi coding
agents. It is derived from Bivor under the MIT License; this project retains
the upstream license and records provenance in
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

The independent focus of this adaptation is controlled execution on Windows:
PowerShell / WSL2 / Docker routing, permission-aware execution, auditability,
and recoverable worktree-based agent tasks.

## Completed

### 2026-09-01 — Baseline and provenance

- Added architecture and roadmap documents at the project workspace level.
- Confirmed the upstream source is MIT-licensed and added
  `THIRD_PARTY_NOTICES.md`.
- Updated both READMEs to identify PiWin Studio as a Windows/WSL2 adaptation,
  rather than representing the upstream macOS project as original work.

### 2026-09-01 — Windows compatibility slice

- Added `pnpm dist:win` and `pnpm dist:win:dir` scripts.
- Added an NSIS Windows target in `electron-builder.yml`.
- Changed interactive local terminals to use PowerShell on Windows.
- Changed one-shot local agent commands from `/bin/sh` to PowerShell on
  Windows.
- Added standard Windows Chrome and Edge installation locations to browser
  discovery.
- Kept macOS Seatbelt support macOS-only; Windows is not described as having
  equivalent host sandboxing.

### 2026-09-01 — Execution routing foundation

- Added `src/host/windows-execution.ts`.
- Supports PowerShell, WSL2, and explicit Docker invocations behind one PTY
  invocation contract.
- Default `auto` routing uses WSL2 only after a real Linux command completes;
  otherwise it falls back to PowerShell.
- Docker is never an automatic fallback because it mounts the active worktree.
- Added `PIWIN_EXECUTION_RUNNER` and `PIWIN_DOCKER_IMAGE` configuration
  variables.

### 2026-09-01 — Windows packaging verified

- Configured the builder to reuse the Electron runtime installed in
  `node_modules`, avoiding a second runtime download during packaging.
- Updated the pnpm build allowlist for the current pnpm format. Only
  `electron`, `esbuild`, and `node-pty` are allowed to run install-time build
  scripts.
- Successfully produced the unpacked Windows app at
  `dist/win-unpacked/PiWin Studio.exe`.
- Successfully produced the x64 NSIS installer. The current rebuild is
  version `0.1.2` so it upgrades the earlier `0.1.1` package.

### 2026-09-01 — Product branding cleanup

- Renamed user-visible application text from Bivor to PiWin Studio: macOS
  application-menu items, window/document titles, settings, sidebar, monitor,
  and notifications.
- Removed upstream Bivor release, website, repository, and issue links from
  PiWin Studio's About page, so they cannot be presented as PiWin resources.
- Retained upstream copyright and license provenance in the repository notices
  and documentation. Legacy local-storage key names remain only for settings
  compatibility and are never shown in the UI.

### 2026-09-01 — Runner health and command audit foundation

- Added **Settings → Local execution environment**, backed by a typed IPC
  endpoint. It live-checks PowerShell, installed WSL distributions, the Docker
  daemon, the configured runner, and the effective runner.
- Confirmed PowerShell 5.1 is available; Docker Desktop is absent.
- Added one hash-chained JSONL audit file per agent session under
  `.piwin/audit/` (or `PIWIN_AUDIT_DIR`). It records runner identity, command
  metadata/fingerprint, timeout, duration, exit result, and execution outcome
  without storing raw command text.
- Connected the existing `allow / ask / deny` guardrail events and budget
  stops to that same privacy-preserving audit chain.

### 2026-09-01 — WSL readiness fallback fix

- A local diagnostic found that `wsl.exe -l -q` lists Ubuntu, but a minimal
  Linux command does not return. The earlier check treated the listing as a
  usable WSL runner, which could leave agent calls waiting during WSL startup.
- `auto` mode now performs one short WSL command probe, caches its result, and
  selects PowerShell when that probe fails or times out. Explicit `wsl` mode
  remains available for users who have repaired their WSL setup.

### 2026-09-01 — Docker restricted command profile

- Added a Windows Docker execution profile that is opt-in through
  `PIWIN_EXECUTION_RUNNER=docker`; Docker is still never selected silently.
- The default profile has no network, a read-only container filesystem and
  workspace mount, dropped Linux capabilities, no-new-privileges, isolated
  IPC, a non-root `node` user, limited PIDs, memory and CPUs, and small
  writable temporary directories only. Workspace writes require an explicit
  `readwrite` setting before launch.
- The active profile is visible in **Settings → Local execution environment**.
  It can be configured before launch with `PIWIN_DOCKER_WORKSPACE_ACCESS`,
  `PIWIN_DOCKER_NETWORK`, `PIWIN_DOCKER_MEMORY`, `PIWIN_DOCKER_CPUS`, and
  `PIWIN_DOCKER_PIDS_LIMIT`.
- In the default read-only profile, direct local `write` and `edit` tools are
  rejected instead of silently writing to the host-mounted workspace.
- Documented the boundary precisely: this is restricted execution for Docker
  commands, not yet an all-tools sandbox. Custom extensions remain host-side;
  Git worktrees are still the planned isolation boundary for code changes.

### 2026-09-01 — Local Docker and WSL verification

- Installed Docker Desktop with the `desktop-linux` context and WSL2 backend;
  client and daemon both report version `29.7.2`.
- Ran the exact PiWin Docker restriction profile against the configured default
  `node:22-bookworm-slim` image. The process ran as `uid=1000(node)`, writes
  to the read-only workspace mount were blocked, `/tmp` remained writable,
  and DNS/network access was blocked.
- Completed Ubuntu provisioning and confirmed `wsl -d Ubuntu -- echo "WSL
  works"` succeeds. The previous auto-runner fallback diagnosis is now
  historical; restart PiWin to let a new process re-probe the usable runner.

### 2026-09-01 — Guarded task-worktree lifecycle

- Hardened the existing upstream worktree feature rather than creating a
  parallel implementation. New PiWin tasks use `piwin/task/*` branches under
  `~/.piwin/task-worktrees/` and record local-only metadata in the repository's
  Git common directory.
- Task creation now requires a clean primary worktree. A task records its base
  commit and merge target at creation time.
- Added the explicit lifecycle `active → review_ready → merged/discarded`.
  Preparing review creates an isolated snapshot commit on the task branch;
  merge requires a human confirmation and refuses if the task changed after
  review, the primary checkout is dirty, or the merge target moved.
- Replaced silent forced cleanup for PiWin-managed tasks with an explicit
  discard confirmation. The legacy `pi/*` cleanup path now refuses arbitrary
  branches and dirty worktrees.
- This is the review boundary only. Docker still does not have a writable
  private task checkout, and file-tool routing remains the next containment
  step.

### 2026-09-01 — Source-control baseline

- Initialized the local `main` branch and recorded the Bivor-derived PiWin
  Studio starting point with the upstream MIT license and provenance notices
  included.
- Published the `main` branch to
  `https://github.com/kulecat/PiWin-Studio.git`. The repository uses the
  local Windows proxy only for this Git remote; no source, dependency
  directory, build output, or local environment file was included in the
  commit.

## Verification completed

- `pnpm install --frozen-lockfile`
- `pnpm typecheck`
- `pnpm build`
- `pnpm exec electron-builder --win --dir --publish never`
- `pnpm exec electron-builder --win --publish never`
- `pnpm dist:win`
- Electron 43.4.0 runtime packaged for Windows x64.
- Built runner health UI and audit implementation with `pnpm build`.
- Rebuilt after the WSL readiness fallback change with `pnpm build`,
  `pnpm typecheck`, and `pnpm dist:win`.
- Verified the generated Docker command arguments with a compiled profile
  probe, including read-only mounts, default network denial, capabilities,
  privilege, IPC, and resource controls.
- Rebuilt after the Docker restricted command profile with `pnpm typecheck`,
  `pnpm build`, and `pnpm dist:win`.
- Verified Docker Desktop 29.7.2 with the actual restricted profile: non-root
  execution, read-only workspace, temporary writable path, and denied network.
- Ran a disposable Git-repository smoke test for guarded tasks: creation,
  review snapshot, rejection of post-review mutation, reviewed merge, and
  explicit cleanup all succeeded.
- Final installer SHA-256:
  `E4F8FCA910352227CF227887203F1223443876696775306DB698CDCDEC5354A9`
  (`PiWin Studio-0.1.5-win-x64.exe`, 133,898,147 bytes).

## Known limitations / blockers

- WSL now works, but it warns that a Windows `localhost` proxy is not mirrored
  into WSL NAT mode. This does not affect the verified Docker profile; configure
  a reachable proxy inside WSL only if a Linux-side tool needs outbound access.
- The generated installer is not Authenticode-signed. Windows may show an
  unknown-publisher warning until a release code-signing certificate is
  configured.
- The packaged desktop UI has not yet had a manual end-to-end smoke test on a
  clean user profile.
- The current local PowerShell runner is a convenience runner, not a security
  boundary. Docker now restricts routed commands, but writable private task
  checkouts, all file-tool routing, WSL2 containment, and path/network policy
  controls remain pending.

## Next work

1. Add checkpoint references and a read-only audit viewer.
2. Extend the existing allow / ask / deny gate with workspace-path and network
   destination rules.
3. Create a Docker-private checkout for each guarded task, then import a
   validated task patch into its host review worktree.
4. Route all first-party file operations through that same task boundary.
5. Run a Windows Gondolin/QEMU compatibility spike; only expose it as
   experimental after all built-in tool routes are verified.
6. Add the proxy-container allowlist and privacy-preserving network audit.
7. Add WSL2 containment profiles and explicit host-execution confirmation.
8. Persist isolated worktree tasks, checkpoints, merge state, and recovery
   information for multi-agent workflows.

## Working agreement

- Update this file whenever a milestone is completed, a verification result
  changes, or a new blocker is found.
- Preserve upstream copyright and license notices for reused code.
- Do not claim an unverified security guarantee or an unfinished feature in
  project documentation or resume material.
