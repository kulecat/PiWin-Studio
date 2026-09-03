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

### 2026-09-02 — Structural Bash permission policy

- Added a WASM `web-tree-sitter` + `tree-sitter-bash` parser in
  `src/host/shell-risk.ts`. It structurally extracts commands in pipelines,
  substitutions, subshells and bounded `sh` / `bash -c` recursion before a
  first-party `bash` call is executed. Existing user command regexes now also
  apply to those extracted commands rather than only the outer string.
- Added independently configurable `allow` / `ask` / `deny` policies for
  deletion, privilege escalation (including common wrappers), download piped
  to an interpreter, project-workspace escape, and common network commands.
  Defaults ask for each behavior except download-to-execute, which is denied.
  These policies cover normal `bash` and `pi.bash(...)` inside `code_run`.
- Added the policies to the Harness governance drawer and made their decision
  text flow through the existing human approval card and hash-chained policy
  audit. The shipped package's optional native binding remains disabled by
  pnpm policy: PiWin uses only its published `.wasm` grammar.
- Kept a quote-aware lexical fallback if the grammar fails to load and labels
  that fallback in the approval request. This is a policy layer, not a claim
  of complete static analysis or a replacement for the Docker/worktree
  enforcement boundary.

### 2026-09-02 — Recoverable guarded task merge queue

- Extended the local-only Git-common-directory task store to schema version 2.
  Each guarded task now records durable created, review, queued, and merged Git
  checkpoints, plus queue state and a persisted pause reason. Existing version
  1 task metadata is normalized on read without changing user source files.
- Added a per-repository in-process merge lock and a queue whose entries are
  individually confirmed in the UI. It merges only a safe prefix in recorded
  order: the primary checkout must be clean and on the intended branch, the
  reviewed task must remain unchanged, and changed-file sets must not overlap
  with target changes since that task began. Overlap, rewritten history, target
  mismatch, or a Git failure pauses without attempting a guessed resolution.
- Added queue status, cancel-queue, and latest-checkpoint restore controls to
  the worktree review card. Restoring asks for a second destructive confirmation
  and resets only the task worktree, including non-ignored untracked files; a
  retained Docker-private copy must still be handled explicitly.
- Direct merge and task discard share the same per-repository lock, so a
  second window cannot race a queue update. Mission Control's existing orphan
  task reopening now operates on the durable checkpoint/queue metadata.

### 2026-09-02 — Mission Control task audit and path-conflict warnings

- Extended the local Git-common-directory task store to schema version 3 with
  a bounded local lifecycle event record. It tracks task creation, review
  snapshot, queue/pause/cancel, merge, checkpoint restore, path-claim update,
  and explicit discard. This is operational history, not a tamper-proof or
  remote audit service.
- Added a Mission Control task ledger that shows each persisted task's state,
  queue position/pause reason, checkpoint count, recent events, and detected
  Git/untracked paths. The existing orphan-worktree controls remain the direct
  recovery point for a task whose chat is not currently open.
- Added voluntary project-relative path claims. PiWin normalizes and validates
  claims, then conservatively reports file/directory-prefix overlap with other
  active tasks' claims and observed changes. It is an early warning only: it
  never locks a path, assigns work automatically, or replaces Git conflict
  handling.

### 2026-09-03 — Configurable WSL2 routing and PowerShell host gate

- Added a saved local execution preference for new agent sessions: preserve
  the launch environment, automatic selection, WSL2, or PowerShell. Keeping
  **Use launch environment** leaves an explicit Docker startup profile intact.
- A WSL2 preference can select a distribution and Windows-drive mount root.
  PiWin validates the selected distribution, requires a successful command in
  a real WSL2 kernel, and opens the workspace through `wsl.exe --cd` using a
  deterministic Windows-to-WSL path mapping.
- The active local runner is now a visible security decision: when it resolves
  to PowerShell, every agent `bash` call—including `pi.bash(...)` in code
  mode—requires human approval. The decision enters the existing policy audit,
  and the subsequent execution retains its normal runner audit record.
- This does **not** call WSL2 a sandbox. The selected Linux distribution still
  receives a mapped host project directory; Docker remains the first supported
  containment boundary for PiWin's first-party tools.

### 2026-09-03 — WSL2 Bubblewrap containment spike

- Added `src/host/wsl-containment.ts`, an unexposed Bubblewrap profile builder
  for a future WSL-native private task copy. The builder creates user, PID,
  IPC, UTS, mount, and network namespaces; blocks nested user namespaces;
  clears inherited environment;
  hides the Windows-drive mount root; and permits only one native-Linux
  workspace bind at `/workspace`. It rejects a task source under the Windows
  mount root, so a writable profile cannot directly bind the host worktree.
- Added a cached Settings diagnostic that exercises this boundary without an
  Agent session. It reports Bubblewrap namespace readiness but explicitly says
  that it is not a selectable sandbox profile.
- Kept the boundary honest: no Agent tool is routed through Bubblewrap yet.
  A private-copy lifecycle, full first-party file-tool routing, reviewed patch
  import, recovery, and an optional WSL network policy are prerequisites.

### 2026-09-03 — Native WSL private-copy hand-off backend

- Added a schema-v4 task record for a WSL private workspace. The copy is made
  only from a clean, active PiWin worktree and lives at
  `$HOME/.piwin/task-sandboxes/<task-id>` in the selected distribution, never
  on a mounted Windows drive.
- The one-time seed filters `.git`, common credential files/directories, and
  reinstallable/build artifacts. A private Git baseline supports binary diff
  preview, `git apply --check`, explicit confirmation before host import, and
  explicit confirmation before discarding changed work.
- WSL-side removal verifies that the persisted path exactly matches the active
  task UUID under PiWin's native base directory. Task review, merge, recovery,
  and deletion refuse or account for an outstanding WSL private copy. Mission
  Control now records create/import/discard lifecycle events.
- This is a backend hand-off, not a selectable WSL Agent sandbox: no Agent
  `bash` or file tool has been rerouted yet. That prevents a misleading state
  where commands would be isolated but file edits still target the host.

### 2026-09-03 — Experimental WSL Bubblewrap task profile

- Added an explicit Settings opt-in for new **WSL2** task sessions. It creates
  a native WSL private copy before the agent process starts, then passes only
  that copy to the selected distribution's Bubblewrap profile. Normal WSL2
  routing is unchanged.
- `bash`, `read`, `write`, `edit`, `grep`, `find`, and `ls` now share the
  profile's `/workspace`; host-path inputs are translated and bounded there,
  including symlink checks for existing and write-target paths. The profile
  hides Windows mount roots, clears its environment, and has no network route.
- Added WSL patch preview/import/discard IPC and the guarded-task chip UI.
  Import still performs `git apply --check` and asks for confirmation before
  touching the Windows task worktree.
- External extensions and MCP adapters are disabled by default because they
  execute in the Electron utility process, outside Bubblewrap. The advanced
  `PIWIN_WSL_HOST_TOOLS=ask` mode permits only explicitly activated, per-call
  human-approved tools and records the existing policy audit boundary.

### 2026-09-03 — P0/P1/P2 WSL containment verification

- **P0:** reran `pnpm typecheck` and `pnpm build`, then verified the provisioned
  Ubuntu distribution has Bubblewrap 0.11.1 available. This is a build and
  runtime prerequisite check; final visual/model-provider acceptance still
  belongs to a normal desktop-agent session.
- **P1:** added `pnpm verify:wsl-recovery`, a disposable real-WSL + Git smoke
  test. It creates a guarded task, edits only its native WSL private copy,
  calls the preparation path again to simulate an Electron restart, confirms
  the exact copy and un-imported patch are recovered, then explicitly discards
  it. The test passed as `WSL_PRIVATE_RECOVERY_SMOKE_OK`. Mission Control's
  existing orphan-task **Continue task** action is the user-facing resume
  entrypoint; no patch is imported automatically.
- **P2:** verified Bubblewrap's default WSL profile denies a real HTTPS
  attempt (`WSL_NETWORK_DEFAULT_DENY_OK`). Ubuntu currently lacks both
  `slirp4netns` and `pasta`; installing a rootless NAT helper would still be
  insufficient because it restores arbitrary direct egress rather than a
  mandatory destination allowlist. PiWin intentionally keeps WSL fully
  disconnected and does not add `--share-net`. Tasks that require controlled
  network access use the existing Docker proxy-allowlist profile instead.

### 2026-09-03 — P3 external MCP/extension quarantine

- Tightened the isolated Docker-private-copy and WSL Bubblewrap profiles:
  third-party Pi extensions and MCP adapters are now always excluded from
  resource loading, including when the legacy
  `PIWIN_DOCKER_HOST_TOOLS=ask` or `PIWIN_WSL_HOST_TOOLS=ask` compatibility
  setting is present. A per-tool approval cannot protect against JavaScript
  that executes while an extension module is being discovered.
- `ask` now applies only to PiWin's separately registered host-side tools.
  Those tools still start inactive, require an approval for every call, and
  retain the existing hash-chained audit events. The host also writes an
  `external_resources` policy event when it quarantines third-party code.
- Added an MCP Resources-page warning so saved configuration is not mistaken
  for code that will load in an isolated task. A future MCP integration must
  implement a reviewed Docker/WSL routing contract before it is admitted.
- Added and passed `pnpm verify:isolated-tools`
  (`ISOLATED_TOOL_BOUNDARY_SMOKE_OK`), confirming that Docker and WSL `ask`
  modes both keep the external resource loader closed.

### 2026-09-03 — P4 official Gondolin / QEMU assessment

- Read the current official Pi containerization guide and Gondolin example.
  Gondolin is useful reference architecture for routing all built-in tools and
  `!` commands to a local micro-VM, but its `RealFSProvider(localCwd)` mount
  writes through directly to the host checkout. It cannot be enabled as a
  PiWin sandbox without first replacing that mount with PiWin's native private
  task copy and reviewed patch hand-off.
- Preflight found Windows-host Node 24.15.0 (above Gondolin's Node 23.6+
  requirement), but no QEMU executable on Windows PATH or in Ubuntu WSL. WSL
  has `/dev/kvm`, but has neither Node.js nor QEMU, so no misleading partial
  Gondolin install or launch was attempted.
- Added `docs/gondolin-evaluation.md`, which records the source links,
  preflight evidence, and the safe future WSL/QEMU spike sequence.

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
- Ran a disposable Git-repository smoke test for the review queue: a safe
  sequence merged in recorded order; a same-file overlap paused before merge;
  a confirmation-gated checkpoint restore removed post-review untracked work;
  all temporary task worktrees were discarded afterwards
  (`WORKTREE_QUEUE_SMOKE_OK`).
- Ran a disposable Git-repository smoke test for the Mission Control task
  ledger: directory/file path-claim overlap, observed changed-path reporting,
  and durable creation/claim/review event records all passed
  (`TASK_GOVERNANCE_SMOKE_OK`).
- Ran a compiled WSL routing smoke test against the provisioned Ubuntu WSL2
  instance: saved config application, `E:\piwin-studio\bivor-main` to
  `/mnt/e/piwin-studio/bivor-main` mapping, WSL2 kernel readiness, and the
  PowerShell host-approval rule all passed (`WSL_ROUTING_SMOKE_OK`).
- Ran a compiled Bubblewrap containment smoke test inside Ubuntu WSL2. It
  verified the generated profile rejects a DrvFs workspace, hides `/mnt/c`,
  uses an empty temporary home/workspace, and has no default network route
  (`WSL_CONTAINMENT_SMOKE_OK`).
- Verified that the same profile can bind an existing native WSL directory at
  `/workspace` after the host `/home` has been hidden, while `/mnt/c` remains
  inaccessible (`WSL_PRIVATE_SOURCE_BIND_OK`).
- Ran a disposable native-WSL + Git smoke test against Ubuntu: credential
  filtering, native copy creation, untracked-file patch preview, confirmation
  gate, host `git apply` validation/import, WSL copy retirement, and task
  cleanup all passed (`WSL_PRIVATE_COPY_SMOKE_OK`).
- Ran an end-to-end Bubblewrap WSL tool-route smoke test against Ubuntu:
  `/workspace` mapping, no `/mnt/c`, empty `$HOME`, no default network route,
  credential filtering, private `write`/`read` with no host mutation,
  confirmation-gated patch import, and task cleanup all passed
  (`WSL_CONTAINMENT_INTEGRATION_SMOKE_OK`).
- Ran `pnpm verify:wsl-recovery` against real Ubuntu WSL2: a restart-style
  re-prepare reused the original native private copy and recovered its
  un-imported patch before explicit discard (`WSL_PRIVATE_RECOVERY_SMOKE_OK`).
- Rechecked that the Bubblewrap WSL profile rejects a live HTTPS request
  (`WSL_NETWORK_DEFAULT_DENY_OK`). The environment has no `slirp4netns` or
  `pasta`; PiWin intentionally does not weaken the profile with `--share-net`.
- Ran `pnpm verify:isolated-tools`: setting Docker or WSL host-tool mode to
  `ask` still leaves third-party extension/MCP resource loading disabled in an
  isolated private-workspace task (`ISOLATED_TOOL_BOUNDARY_SMOKE_OK`).
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

- WSL2 routing now works, but it warns that a Windows `localhost` proxy is not mirrored
  into WSL NAT mode. This does not affect the verified Docker profile; configure
  a reachable proxy inside WSL only if a Linux-side tool needs outbound access.
- The generated installer is not Authenticode-signed. Windows may show an
  unknown-publisher warning until a release code-signing certificate is
  configured.
- The packaged desktop UI has not yet had a manual end-to-end smoke test on a
  clean user profile.
- PowerShell requires agent-call approval but is still a convenience runner,
  not a security boundary. WSL2 routing also is not containment: it maps the
  host project into Linux. Docker covers Pi's built-in command and file tools;
  the experimental Bubblewrap profile now covers PiWin's first-party tools,
  but it intentionally has no WSL network allowlist and cannot safely route
  arbitrary third-party extension/MCP code. These packages are now quarantined
  in isolated sessions rather than merely approval-gated; a controlled adapter
  contract is still future work. Resume/import/discard recovery is available
  through the persisted guarded task record; a richer cross-task patch
  dashboard remains a possible UX enhancement.
- Gondolin is documented as a research reference only. This machine needs QEMU
  and Node.js inside Ubuntu WSL for a dedicated disposable-repository spike,
  followed by a private-copy provider rather than its default direct host mount.

### 2026-09-03 — P5 guarded multi-task coordination baseline

- Advanced the local Git-common-directory task ledger to schema version 5.
  Mission Control now persists a short task **owner / agent** label and optional
  role for active guarded worktrees, and records each change as a bounded
  lifecycle audit event. It is a durable allocation note, not a fabricated
  live-agent status or an automatic scheduler.
- Added **Export task audit**. It atomically creates a JSON hand-off under the
  Git common directory's `piwin-audit-exports/` folder with task state,
  checkpoints, merge queue, path claims, assignments, and events plus a
  SHA-256 payload digest. The export intentionally excludes source content,
  absolute repository/worktree paths, Docker volume identifiers, and native
  WSL private-copy paths. It remains a local, unsigned review artifact.
- Closed a composition gap: a child SDK `subagent_run` session cannot inherit
  PiWin's Docker-private-volume or WSL Bubblewrap tool routing, so it now
  refuses to start while either private-workspace boundary is active. Parallel
  isolated work uses separately guarded task worktrees instead, preserving
  independent checkpoints, conflict warnings, review, and explicit merge.
- Passed `pnpm typecheck` and the new disposable repository regression test
  `pnpm verify:task-governance` (`TASK_GOVERNANCE_P5_SMOKE_OK`). The isolated
  tool-boundary smoke remains in place for the extension/MCP resource boundary;
  the child-session refusal is covered by the host type/build checks.

## Next work

1. Add checkpoint references and a read-only audit viewer, including Docker
   private-patch lifecycle events and task-ledger links.
2. Add crash-recovery UI for interrupted WSL patch hand-offs and an
   independently tested opt-in WSL network allowlist; retain default denial.
3. Extend the non-Docker policy layer with destination-specific network rules
   and controlled routing for third-party extensions/MCP tools.
4. Run a Windows Gondolin/QEMU compatibility spike; only expose it as
   experimental after all built-in tool routes are verified.
5. Complete a manual desktop UI smoke test on a clean profile and establish a
   signed Windows release workflow.

## Working agreement

- Update this file whenever a milestone is completed, a verification result
  changes, or a new blocker is found.
- Preserve upstream copyright and license notices for reused code.
- Do not claim an unverified security guarantee or an unfinished feature in
  project documentation or resume material.
