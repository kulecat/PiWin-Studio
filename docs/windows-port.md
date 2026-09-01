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
- Docker is never selected automatically. It runs the command with the active
  worktree mounted at `/workspace`; configure its image with
  `PIWIN_DOCKER_IMAGE`.
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
- the only host mount is the active workspace at `/workspace`;
- network access is disabled by default;
- all Linux capabilities are dropped, privilege escalation is disabled, and
  the IPC namespace is isolated;
- the default limits are 2 GB memory, 2 CPUs, and 128 processes.

Set these environment variables before launching PiWin Studio:

```powershell
$env:PIWIN_EXECUTION_RUNNER = "docker"
$env:PIWIN_DOCKER_WORKSPACE_ACCESS = "readonly" # default; set readwrite only when needed
$env:PIWIN_DOCKER_NETWORK = "none"              # set allow only when needed
$env:PIWIN_DOCKER_MEMORY = "2g"
$env:PIWIN_DOCKER_CPUS = "2"
$env:PIWIN_DOCKER_PIDS_LIMIT = "128"
```

`readonly` is the default: it mounts the workspace read-only and makes PiWin's
`write` / `edit` tools reject changes. Set `readwrite` only for a task that
needs to edit its selected workspace. It is not rollback protection by itself:
use the guarded Git task flow below for that boundary.

This is a **command-execution** boundary, not a claim that all Agent behavior
is isolated. PiWin's host process still loads trusted Pi extensions and serves
some file operations. A later phase will route all file operations through the
same boundary and pair Docker with a private task checkout.

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

This phase establishes the human review boundary. It does **not** yet give a
Docker container a writable task checkout, and it does not make arbitrary
extensions or MCP tools sandboxed.

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
marked as host execution in the UI and audit log. Docker task-private
checkouts, network allowlists, credential isolation, and all-file-tool routing
remain planned.
