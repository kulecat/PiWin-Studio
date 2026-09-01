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

## Planned security boundary

Windows containment will be added through explicit WSL2 and Docker runners.
Native PowerShell is a convenience runner and must always be visibly marked as
host execution in the UI and audit log.
