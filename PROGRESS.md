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

### 2026-09-01 — Source-control baseline

- Initialized the local `main` branch and recorded the Bivor-derived PiWin
  Studio baseline in commit `ef0fbaa` with the upstream MIT license and
  provenance notices included.
- Configured `https://github.com/kulecat/PiWin-Studio.git` as `origin`.
  The first push is pending because this machine could not connect to
  `github.com:443`; no source, dependency directory, build output, or local
  environment file was included in the commit.

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
- Final installer SHA-256:
  `030895AD1167A0B8FB3B59220BA05F081FBA12E775F5E6737293AB0666399EF0`
  (`PiWin Studio-0.1.3-win-x64.exe`, 133,891,120 bytes).

## Known limitations / blockers

- This machine lists an Ubuntu WSL distribution, but a test Linux command does
  not finish. In auto mode PiWin now uses PowerShell until the local WSL setup
  is repaired. The WSL proxy warning should be investigated separately if WSL
  support is needed.
- Docker Desktop is not currently available on this machine, so the Docker
  runner has not yet been executed.
- The generated installer is not Authenticode-signed. Windows may show an
  unknown-publisher warning until a release code-signing certificate is
  configured.
- The packaged desktop UI has not yet had a manual end-to-end smoke test on a
  clean user profile.
- The current local PowerShell runner is a convenience runner, not a security
  boundary. The existing policy gate covers tools and commands, but WSL2/Docker
  containment and path/network policy controls are still pending.

## Next work

1. Add checkpoint references and a read-only audit viewer.
2. Extend the existing allow / ask / deny gate with workspace-path and network
   destination rules.
3. Add Docker/WSL2 containment profiles and make host execution explicit in
   the UI.
4. Persist isolated worktree tasks, checkpoints, merge state, and recovery
   information for multi-agent workflows.

## Working agreement

- Update this file whenever a milestone is completed, a verification result
  changes, or a new blocker is found.
- Preserve upstream copyright and license notices for reused code.
- Do not claim an unverified security guarantee or an unfinished feature in
  project documentation or resume material.
