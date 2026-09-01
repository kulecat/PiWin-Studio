# Windows port baseline

## First implementation slice

- Add an NSIS Windows packaging target (`pnpm dist:win`).
- Open interactive user terminals with PowerShell by default.
- Execute local one-shot agent commands through PowerShell instead of
  `/bin/sh`.
- Discover Chrome or Edge from standard Windows installation locations.
- Preserve macOS-specific Seatbelt behavior only on macOS; Windows does not
  claim equivalent local containment.

## Execution routing

`src/host/windows-execution.ts` is the single source of truth for local tool
execution on Windows:

- `auto` (the default) selects WSL2 when `wsl.exe` is available, preserving
  the POSIX shell semantics expected by Pi tools; otherwise it uses PowerShell.
- Set `PIWIN_EXECUTION_RUNNER=powershell`, `wsl`, or `docker` to choose a
  runner explicitly.
- Docker is never selected automatically. In its default read-only profile it
  mounts the active worktree at `/workspace`; writable mode instead requires a
  fresh PiWin-managed task worktree and uses a private Docker volume. Configure
  its image with `PIWIN_DOCKER_IMAGE`.
- The **Settings → Local execution environment** page probes the live
  PowerShell version, installed WSL distribution, and Docker daemon before it
  displays the effective runner. An explicitly selected unavailable runner is
  shown as unavailable rather than silently falling back.

## Docker restricted command profile

When `PIWIN_EXECUTION_RUNNER=docker` is selected, PiWin runs each agent shell
command in a disposable Docker container. The default profile is deliberately
conservative:

- the container root filesystem is read-only; `/tmp`, `/var/tmp`, and the
  `node` home directory are disposable tmpfs mounts;
- in `readonly` mode, the only host mount is the active workspace at
  `/workspace`, mounted read-only;
- in `readwrite` mode, there is no writable host mount: commands receive only
  a task-specific Docker volume at `/workspace`;
- network access is disabled by default;
- all Linux capabilities are dropped, privilege escalation is disabled, and
  the IPC namespace is isolated;
- the default limits are 2 GB memory, 2 CPUs, and 128 processes.

Set these environment variables before launching PiWin Studio:

```powershell
$env:PIWIN_EXECUTION_RUNNER = "docker"
$env:PIWIN_DOCKER_WORKSPACE_ACCESS = "readonly" # default; readwrite needs a fresh PiWin task
$env:PIWIN_DOCKER_NETWORK = "none"              # set allow only when needed
$env:PIWIN_DOCKER_MEMORY = "2g"
$env:PIWIN_DOCKER_CPUS = "2"
$env:PIWIN_DOCKER_PIDS_LIMIT = "128"
```

`readonly` is the default: it mounts the workspace read-only and makes PiWin's
`write` / `edit` tools reject changes. `readwrite` starts a private Docker copy
for a fresh guarded task; it never grants a container a writable host mount.
The default image is `node:22-bookworm` because this workflow needs Git. A
custom `PIWIN_DOCKER_IMAGE` must provide `sh`, `git`, and a non-root `node`
user (UID 1000).

This is a **command-execution** boundary, not a claim that all Agent behavior
is isolated. PiWin's host process still loads trusted Pi extensions and serves
some file operations. Host `write` / `edit` are deliberately blocked whenever
Docker is selected; a later phase will route all first-party file operations
through the same private task boundary.

## Guarded Git task worktrees

PiWin creates a new task only when the primary worktree is clean. Each task is
created under `~/.piwin/task-worktrees/` on a `piwin/task/*` branch; the primary
working copy is never the task directory. Local-only task metadata is stored in
the repository's Git common directory as `piwin-tasks.json`, not in source
control.

The lifecycle is deliberately explicit:

1. **Active** — the agent works only in the task worktree.
2. **Prepare review** — PiWin commits the task's current changes to an isolated
   review snapshot on the task branch.
3. **Merge** — after a human confirmation, PiWin merges only that exact review
   commit. It refuses when the task changed after review, the primary worktree
   is dirty, the target branch changed, or the target commit moved.
4. **Discard** — deleting a task containing changes requires a separate explicit
   confirmation. The task branch and its worktree are then removed together.

### Docker-private writable task workflow

When `PIWIN_EXECUTION_RUNNER=docker` and
`PIWIN_DOCKER_WORKSPACE_ACCESS=readwrite` are selected, opening a fresh guarded
task creates a named Docker volume. PiWin seeds it once from the task worktree
through a read-only bootstrap mount, removes the copied `.git` pointer, and
creates an independent Git baseline inside the volume. Every later command
mounts only that volume at `/workspace`; it has no host task directory mount.

The task chip reports Docker-only changes and offers two explicit actions:

1. **Import patch** — PiWin extracts a binary-safe Git patch (including new,
   non-ignored files), checks it against the still-clean host task with
   `git apply --check`, asks for confirmation, applies it, and removes the
   private volume.
2. **Discard Docker copy** — deletes the private volume. A changed copy needs
   its own confirmation.

PiWin refuses to prepare review or merge while a private copy remains. It also
refuses to create a private copy from a dirty or already-committed task, and
refuses to mix an imported patch with host-side task changes. This makes the
patch import the explicit hand-off between execution and human review. An old
chat process cannot recreate a removed volume: it is stopped at the next Docker
command, so after import the user should prepare review and then create a new
task for additional work.

This does not make arbitrary extensions, MCP tools, or host-side `read` tools
sandboxed. Those routes remain the next containment phase.

## Execution audit log

Each agent host appends one JSON Lines file per session at
`.piwin/audit/<chat-id>.jsonl` in the active workspace. Set
`PIWIN_AUDIT_DIR` before launch to store these files elsewhere.

Each entry includes the timestamp, workspace, local/VM world, runner,
command program name, command byte length, SHA-256 command fingerprint,
timeout, duration, exit result, and a hash-chain link to the preceding entry.
Raw command text is intentionally not stored because shell commands often
contain tokens or credentials.

The same per-session file also records `allow / ask / deny` policy decisions
and budget stops. Their UI detail is represented by byte length and a SHA-256
fingerprint, not copied verbatim into the audit file.

The log is append-only from PiWin's perspective and its hash chain can reveal
accidental truncation or reordering. It is not a tamper-proof security ledger:
a user with filesystem access can edit it. Checkpoint references will be added
with the recovery layer.

## Remaining security boundary work

The Docker restricted command profile is the first Windows containment layer.
Native PowerShell and WSL2 are convenience runners and must always be visibly
marked as host execution in the UI and audit log. Docker task-private copies
now provide the writable-command boundary; network allowlists, credential
isolation, and all-file-tool routing remain planned.
