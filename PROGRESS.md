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

### 2026-09-01 — Docker-private task copy and reviewed patch import

- Replaced the writable Docker host bind mount with a task-specific named
  Docker volume. Writable Docker sessions can start only from a clean, active
  PiWin-managed task worktree.
- PiWin seeds the volume once through a read-only bootstrap mount, removes the
  copied worktree `.git` pointer, and creates an independent Git baseline.
  Subsequent Docker commands mount only the private volume at `/workspace`.
- Added private-copy change preview plus explicit import/discard controls in
  the task review chip. Import exports a binary-safe Git patch (including new
  non-ignored files), runs `git apply --check` against the still-clean host
  task, requires confirmation, applies it, and retires the Docker volume.
- Review and merge now refuse an outstanding Docker copy; task discard also
  removes its associated volume after an explicit destructive confirmation.
- Host `write` / `edit` are blocked whenever Docker is selected, preventing
  those tools from bypassing the private-copy hand-off. Full first-party file
  routing remains a separate phase.

### 2026-09-02 — Unified Docker first-party file-tool routing

- Added `src/host/docker-workspace.ts`, a Docker-volume adapter shared by the
  Pi built-in `read`, `write`, `edit`, `grep`, `find`, and `ls` tools. These
  tools now use the same `/workspace` view as Docker `bash` commands.
- In writable Docker tasks, file operations reach only the task-specific named
  volume. The host worktree remains untouched until the existing reviewed patch
  import step. In Docker `readonly` mode, reads/searches use the read-only
  mount and writes fail at the Docker profile boundary.
- Enforced a path boundary before every operation: host paths must be below the
  active task worktree, then existing symlinks (or a write target's parent)
  must resolve below `/workspace`. Paths escaping the task are rejected.
- Added Docker-backed `grep`, `find`, and `ls` implementations so file search
  does not silently fall back to the host. `find` enumerates tracked and
  non-ignored untracked files from the private Git baseline; `grep` searches
  that same set inside Docker.
- Custom Pi extensions and MCP tools remain host-side. This milestone does not
  claim to sandbox third-party tools, model-provider traffic, or future plugin
  code.

### 2026-09-02 — Docker host-tool risk gate and audit

- Added `src/host/docker-host-tools.ts` to identify the seven first-party
  tools routed through PiWin's Docker-private workspace. In Docker's default
  `PIWIN_DOCKER_HOST_TOOLS=deny` mode, Pi's external extension/MCP packages
  are not loaded and all remaining host-side PiWin tools begin inactive.
- A person may manually enable a known host-side PiWin tool from the Tools UI;
  every subsequent call is forced through the guardrail approval card even if
  its configurable per-tool policy says `allow`. The existing `asked`,
  `approved`, and `denied` policy events are appended to the JSONL audit log.
- `tool_activate` cannot let the model bypass this default boundary. Setting
  `PIWIN_DOCKER_HOST_TOOLS=ask` is an explicit advanced opt-in for a
  pre-reviewed extension/MCP adapter: it remains inactive until enabled, and
  every actual call still requires approval. Extension code can run while it
  loads, so this is intentionally not a safe setting for unreviewed code.
- Docker task behavior remains unchanged: first-party code changes live only
  in the private volume until the user reviews and imports a patch. Network
  allowlists, destination-level auditing, and credential isolation are the
  next containment phase.

### 2026-09-02 — Docker network allowlist proxy and audit

- Added `src/host/docker-egress.ts`. With the default
  `PIWIN_DOCKER_NETWORK=none`, Docker remains fully disconnected. Setting
  `PIWIN_DOCKER_NETWORK=allow` (or `allowlist`) now requires a non-empty
  `PIWIN_DOCKER_NETWORK_ALLOWLIST`; it no longer gives the agent a raw bridge
  network.
- Each agent host creates a short-lived internal Docker network for its
  workload plus a separately constrained proxy container. The agent network
  has no direct internet route; the proxy is its only peer and has the sole
  external bridge attachment. Unsetting proxy environment variables cannot
  restore direct egress.
- The proxy accepts exact DNS names and left-most wildcards, rejects IP and
  localhost targets, permits only ports 80/443, and resolves an allowlisted
  host to a public IPv4 address before connecting. This prevents an allowlisted
  hostname from being used as a route to local, private, link-local, or Docker
  addresses.
- Added hash-chained `network_request` audit entries containing only host,
  port, method, allow/deny decision, fixed reason, and available HTTP status.
  URL paths, query strings, headers, bodies, and credentials are not logged.
- Ran a real Docker smoke test: an allowlisted `example.com` HTTPS CONNECT
  succeeded, `example.org` was denied, a direct public TCP connection from the
  internal agent network failed, and both proxy decisions appeared in the audit
  log. The test proxy container and internal network were removed afterwards.

### 2026-09-02 — Docker credential isolation and one-shot approval

- Added `src/host/docker-credential-policy.ts` and a read-only snapshot
  lifecycle in `src/host/docker-credentials.ts`. Docker readonly sessions no
  longer bind-mount the host worktree; each host creates a short-lived,
  filtered, Git-aware volume snapshot instead. The snapshot is removed when
  the agent host exits or initialization fails.
- Applied the same filter to writable task-volume bootstrap in
  `src/main/worktrees.ts`. `.env*`, package-manager and Git credential files,
  cloud/SSH/GnuPG directories, private-key formats, and `credentials.json`
  never enter either Docker workspace. Reinstallable dependencies and build
  artifacts are also excluded, avoiding large per-chat copies of `node_modules`.
- Docker containers receive no host environment variables by default. Added
  `docker_credential_exec`: the user must configure variable *names* in
  `PIWIN_DOCKER_CREDENTIAL_ALLOWLIST`, then approve each requested command.
  The selected values are supplied only to that disposable command's container
  through Docker's `--env NAME` mechanism; values are not put in command-line
  arguments and do not persist to later calls.
- Added redaction of known injected values in tool output and hash-chained
  `credential_access` audit entries containing names, approval/deny/execute
  decision and exit result only. Generic human approvals now emit the same
  existing policy audit events as guardrail approvals.
- Ran a real Docker smoke test with a temporary `.env` and `NPM_TOKEN`: the
  snapshot omitted `.env`, ordinary Docker commands saw no token, the approved
  one-shot command received it but returned `[REDACTED:NPM_TOKEN]`, audit
  contained the name but not the value, and the temporary volume was removed.

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
- Verified `node:22-bookworm` provides Git and the non-root `node` user needed
  for a private workspace.
- Ran a disposable Docker + Git smoke test: private volume creation, changed
  and newly added files (including an Agent-created private commit),
  confirmation-gated import, host `git apply` check, volume removal, review
  snapshot, merge, and task cleanup all succeeded.
- Verified the stale-volume guard: an old host process cannot cause Docker to
  auto-create an empty replacement volume after a private copy is imported or
  discarded.
- Ran a disposable private-volume file-tool smoke test: `mkdir`, `write`,
  `read`, directory listing, Git-aware file find, in-volume grep, host-path
  escape rejection, and confirmation that no test directory was written into
  the host worktree all passed (`DOCKER_FILE_TOOL_SMOKE_OK`).
- Verified the Docker file-search fallback for a worktree whose `.git` pointer
  cannot be resolved inside the container; it uses in-container `find` rather
  than falling back to the host (`DOCKER_PROJECT_FILES_FALLBACK_OK`).
- Final installer SHA-256:
  `1DDBA8DA6885131F0E35DCFEB94D677C29AFEB947A50E8BD1D3674403DE04915`
  (`PiWin Studio-0.1.6-win-x64.exe`, 133,910,613 bytes).

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
  boundary. Docker covers Pi's built-in command and file tools, but WSL2
  containment, network policy, and third-party extension/MCP routing remain
  pending.

## Next work

1. Add a Docker proxy sidecar with domain allowlists and privacy-preserving
   request audit, while keeping network disabled by default.
2. Add checkpoint references and a read-only audit viewer, including private
   patch-import lifecycle events.
3. Extend the existing allow / ask / deny gate with workspace-path and network
   destination rules.
4. Run a Windows Gondolin/QEMU compatibility spike; only expose it as
   experimental after all built-in tool routes are verified.
5. Add WSL2 containment profiles and explicit host-execution confirmation.
6. Persist isolated worktree tasks, checkpoints, merge state, and recovery
   information for multi-agent workflows.

## Working agreement

- Update this file whenever a milestone is completed, a verification result
  changes, or a new blocker is found.
- Preserve upstream copyright and license notices for reused code.
- Do not claim an unverified security guarantee or an unfinished feature in
  project documentation or resume material.
