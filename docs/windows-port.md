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

- `auto` selects WSL2 only after PiWin successfully runs a short command in a
  WSL2 kernel, preserving the POSIX shell semantics expected by Pi tools;
  otherwise it uses PowerShell.
- Set `PIWIN_EXECUTION_RUNNER=powershell`, `wsl`, or `docker` to choose a
  runner explicitly.
- **Settings → Local execution environment** can store an `auto`, WSL2, or
  PowerShell preference for *new* agent sessions. Leaving its first choice,
  **Use launch environment**, selected preserves an explicit startup profile
  such as `PIWIN_EXECUTION_RUNNER=docker`.
- A WSL profile may select `PIWIN_WSL_DISTRIBUTION` (or a saved distribution)
  and `PIWIN_WSL_MOUNT_ROOT` (or a saved mount root, default `/mnt`). PiWin
  validates the requested distribution, verifies it has a WSL2 kernel, and
  opens the task directory with `wsl.exe --cd`; for example,
  `E:\project` maps to `/mnt/e/project` with the default mount root.
- Docker is never selected automatically. In its default read-only profile it
  mounts the active worktree at `/workspace`; writable mode instead requires a
  fresh PiWin-managed task worktree and uses a private Docker volume. Configure
  its image with `PIWIN_DOCKER_IMAGE`.
- The **Settings → Local execution environment** page probes the live
  PowerShell version, installed WSL distribution, and Docker daemon before it
  displays the effective runner. An explicitly selected unavailable runner is
  shown as unavailable rather than silently falling back.

PowerShell is direct execution in the signed-in Windows user's environment,
not a sandbox. When it is the effective local runner, every agent `bash` call
(including `pi.bash(...)` within `code_run`) presents a human approval card
before execution. The approval decision and the resulting command execution
are both recorded in the existing per-session audit chain. Interactive user
terminals are intentionally outside this agent-tool guard.

## Experimental WSL2 containment spike

PiWin performs a capability diagnostic for
[Bubblewrap](https://github.com/containers/bubblewrap) inside the selected
WSL2 distribution. It is shown in **Settings → Local execution environment**
as **WSL2 Bubblewrap containment spike**. After an explicit WSL2 selection and
opt-in, it is an experimental sandbox setting for new guarded coding tasks.

The tested profile uses Bubblewrap's user, PID, IPC, UTS, mount, and network
namespaces, and prevents a process from creating further user namespaces. It
clears the inherited environment, provides only a read-only
Linux runtime, an empty `/etc`, temporary `/home` and `/tmp`, a new `/dev` and
`/proc`, and hides the configured Windows drive mount root. It has no default
network route. Its only intended project mount is `/workspace`, bound from a
**native WSL private task copy**; the builder rejects a task source below the
Windows mount root, so a writable profile cannot bind the Windows worktree.

PiWin has the lifecycle needed for a contained task copy: it seeds
`$HOME/.piwin/task-sandboxes/<task-id>` from a clean, guarded Git worktree,
filters Git metadata/common credential files/build artifacts, records the copy
locally, previews a binary Git patch, validates it against the host task, and
requires explicit confirmation before import or discard. Copy paths are
verified against the task UUID before any WSL-side deletion. Lifecycle events
appear in the local task audit ledger.

When **Settings → Local execution environment → Enable Bubblewrap containment
for new guarded WSL2 tasks** is saved with an explicit **WSL2** runner, a new
PiWin-managed task session activates this profile. It runs `bash`, `read`,
`write`, `edit`, `grep`, `find`, and `ls` through the same Bubblewrap
`/workspace`; file paths and symlink targets are checked there, and the task
chip exposes the human-confirmed WSL patch import/discard actions.

This is an experimental, opt-in boundary—not a blanket WSL sandbox. It only
accepts a clean, active PiWin task worktree, has no network route, and starts
with external extensions/MCP adapters disabled because they otherwise execute
in the Electron utility process outside Bubblewrap. This remains true even
when `PIWIN_WSL_HOST_TOOLS=ask` is set: `ask` can only permit a PiWin-owned
host-side tool through a per-call approval; it never loads third-party module
code. Ordinary WSL routing remains unchanged and host-adjacent.

If PiWin or Windows stops while a private copy exists, the guarded task record
persists both the WSL distribution and native copy path. From Mission Control,
choose **Continue task** for the orphaned task; PiWin reconnects to that exact
copy, preserves its un-imported patch, and again presents only the explicit
import/discard hand-off. It never automatically imports a patch after a
restart. A missing copy or mismatched WSL configuration remains a fail-closed
state that must be explicitly discarded.

The WSL profile deliberately has no network allowlist. A real 2026-09-03
Ubuntu/WSL2 probe verified that Bubblewrap's profile has no egress, and found
no `slirp4netns` or `pasta` helper installed. More importantly, rootless NAT
on its own would restore arbitrary direct egress, not enforce an HTTP(S)
destination allowlist. PiWin therefore does not add Bubblewrap's
`--share-net` option. For dependency installation or other controlled network
work, select Docker's already-tested proxy-allowlist profile; third-party tool
routes remain a separate boundary.

This scoped approach avoids changing the user's global `/etc/wsl.conf` drive
mount behavior, which is distribution-wide rather than task-scoped.

## Gondolin compatibility assessment (P4)

The official Pi Gondolin example is a useful tool-routing reference, but it is
not enabled as a PiWin profile. Its VM uses a direct `RealFSProvider` mount of
the host working directory, so guest writes immediately affect the host; that
does not meet PiWin's private-copy and reviewed-patch boundary. Its Node.js
requirement is met by this desktop's Node 24.15.0, but QEMU is not installed on
either Windows PATH or the provisioned Ubuntu WSL distribution. Ubuntu has
`/dev/kvm`, but no Node.js runtime for a WSL-native test. See
[the full assessment](./gondolin-evaluation.md) before attempting a dedicated
WSL/QEMU spike.

## Docker restricted command profile

When `PIWIN_EXECUTION_RUNNER=docker` is selected, PiWin runs each agent shell
command in a disposable Docker container. The default profile is deliberately
conservative:

- the container root filesystem is read-only; `/tmp`, `/var/tmp`, and the
  `node` home directory are disposable tmpfs mounts;
- in `readonly` mode, PiWin first creates a filtered, read-only task snapshot
  volume at `/workspace`; it never mounts the active host workspace into the
  command container;
- in `readwrite` mode, there is no writable host mount: commands receive only
  a task-specific Docker volume at `/workspace`;
- network access is disabled by default;
- when networking is explicitly enabled, the agent joins an internal Docker
  network with no direct internet route. Its only egress peer is a
  PiWin-created proxy, which permits configured DNS names only;
- all Linux capabilities are dropped, privilege escalation is disabled, and
  the IPC namespace is isolated;
- the default limits are 2 GB memory, 2 CPUs, and 128 processes.

Set these environment variables before launching PiWin Studio:

```powershell
$env:PIWIN_EXECUTION_RUNNER = "docker"
$env:PIWIN_DOCKER_WORKSPACE_ACCESS = "readonly" # default; readwrite needs a fresh PiWin task
$env:PIWIN_DOCKER_NETWORK = "none"              # set allow only when needed
$env:PIWIN_DOCKER_NETWORK_ALLOWLIST = "registry.npmjs.org,api.github.com"
$env:PIWIN_DOCKER_CREDENTIAL_ALLOWLIST = "NPM_TOKEN,GITHUB_TOKEN"
$env:PIWIN_DOCKER_MEMORY = "2g"
$env:PIWIN_DOCKER_CPUS = "2"
$env:PIWIN_DOCKER_PIDS_LIMIT = "128"
# External extension/MCP packages are never loaded in an isolated task. `ask`
# only permits individually approved PiWin-owned host tools.
$env:PIWIN_DOCKER_HOST_TOOLS = "deny"
```

`readonly` is the default: it mounts the workspace read-only. In Docker mode,
PiWin routes its first-party `bash`, `read`, `write`, `edit`, `grep`, `find`,
and `ls` tools through the same Docker workspace; write operations fail in the
read-only profile at the Docker boundary. `readwrite` starts a private Docker
copy for a fresh guarded task; it never grants a container a writable host
mount.
The default image is `node:22-bookworm` because this workflow needs Git. A
custom `PIWIN_DOCKER_IMAGE` must provide `sh`, `git`, `tar`, `grep`, `find`,
`realpath`, `xargs`, and a non-root `node` user (UID 1000).

### Network allowlist proxy

`PIWIN_DOCKER_NETWORK=none` remains the default. To permit a narrowly scoped
network task, set `PIWIN_DOCKER_NETWORK=allow` (or `allowlist`) **and** provide
one or more comma-separated DNS names in `PIWIN_DOCKER_NETWORK_ALLOWLIST`.
Exact names such as `registry.npmjs.org` and a left-most wildcard such as
`*.githubusercontent.com` are accepted. IP addresses, `localhost`, arbitrary
ports, and empty allowlists are rejected.

PiWin creates an ephemeral, internal Docker network for the agent and a
separate constrained proxy container. The agent has no direct default route;
only the proxy has an external bridge attachment. It resolves an allowlisted
name to a public IPv4 address before connecting, so a hostname cannot be used
to reach loopback, private, link-local, or Docker-internal addresses. Standard
`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` variables point at that proxy.
Unsetting those variables does not restore direct egress because the workload
is still attached only to the internal network.

The per-session JSONL audit includes one `network_request` entry per proxy
decision: DNS host, port, HTTP method, allow/deny decision, fixed denial reason
and, when available, HTTP status. It deliberately excludes URL paths, query
strings, headers, bodies, and credentials. The proxy and its internal network
are removed when the agent host shuts down.

### Credential isolation and one-shot injection

Docker never inherits the PiWin host's environment simply because it is a
child process: every container environment variable is an explicit `docker
run --env` argument. In addition, both the read-only snapshot and the writable
task-volume bootstrap exclude common credential paths before the agent starts:
`.env*`, `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`, `.aws`, `.ssh`,
`.gnupg`, private-key formats, and `credentials.json`. Reinstallable dependency
and build directories (`node_modules`, `.pnpm-store`, `out`, `dist`, etc.) are
also left out, keeping snapshots fast and source-focused. PiWin creates a new
Git baseline inside the resulting volume so Git-aware tools still work.

For the uncommon case where one command truly needs a secret, put only its
*name* in `PIWIN_DOCKER_CREDENTIAL_ALLOWLIST` before launching PiWin, for
example `NPM_TOKEN,GITHUB_TOKEN`. The agent can then request
`docker_credential_exec`; every request displays the command and requested
names in an approval card. After approval, the selected variables are supplied
only to that one disposable Docker container using `--env NAME` (the secret
bytes are not placed in the Docker command line). Later `bash` calls do not
retain them. Tool output redacts known injected values, and the audit records
the variable names and decision/exit result—never values.

This is a first-party **tool-execution** boundary, not a claim that all Agent
behavior is isolated. PiWin does not load external Pi extensions or MCP
adapters in any Docker private-workspace task, including when
`PIWIN_DOCKER_HOST_TOOLS=ask` is set. That closes the module-load-time escape
that a tool-call approval cannot cover. PiWin initially deactivates every
built-in host-side tool that is not routed through the private Docker
workspace; a manually enabled PiWin-owned host tool still needs approval for
every actual call and produces audit events. The seven volume-routed
file/command tools plus the tool-directory controls remain available.

A third-party MCP adapter that needs an isolated task workspace must implement
a reviewed Docker/WSL routing contract before it can be supported here.

The Docker file adapter permits only paths inside the active task worktree and
rejects symlink resolution outside `/workspace`.

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

### Recoverable review queue

Task metadata uses a versioned, local-only `piwin-tasks.json` record in the
repository's Git common directory. PiWin stores durable **created**, **review**,
**queued**, and **merged** commit checkpoints there, so Mission Control can
reopen an orphaned task after an app restart.

After the user confirms each task separately, **Add to merge queue** persists
its exact review commit. The queue only drains a safe prefix: the primary
checkout must be clean and still on the target branch, the task snapshot must
not have changed, and PiWin compares the files changed by the task with files
changed on the target since that task began. Any overlapping path, rewritten
history, branch mismatch, or Git merge error pauses the queue before merging;
PiWin never guesses a conflict resolution. Safe entries use an explicit
no-fast-forward merge commit in their recorded order.

For a task changed after review, **Restore latest checkpoint** first asks for a
separate destructive confirmation, then runs `git reset --hard` and removes
non-ignored untracked files with `git clean -fd` in that *task worktree only*.
It removes a queued entry and returns the task to review-ready state; it does
not delete a Docker private volume, which must still be imported or discarded
explicitly.

### Mission Control task ledger and path-claim warnings

Schema version 3 adds a bounded, local lifecycle event list to the same Git
common-directory metadata. Mission Control shows recent creation, review,
queue, pause, merge, checkpoint restore, path-claim, and discard events along
with each task's queue state and checkpoint count. This is a local operational
record, not a cloud service or a tamper-proof compliance log.

An operator may declare project-relative paths such as `src/ui` or
`docs/readme.md` for an active task. PiWin rejects absolute paths, drive
prefixes, and `..` segments, compares those claims and observed Git/untracked
changes across active tasks, and displays conservative directory/file overlap
warnings. Claims never lock files, prevent a Git operation, assign an agent, or
resolve a conflict; the guarded merge queue remains the enforcement boundary.

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

This does not make an opt-in extension or MCP tool sandboxed. Transport policy
beyond HTTP(S), credential brokers beyond one-shot environment injection, and
third-party tool routing remain later phases.

## Execution audit log

Each agent host appends one JSON Lines file per session at
`.piwin/audit/<chat-id>.jsonl` in the active workspace. Set
`PIWIN_AUDIT_DIR` before launch to store these files elsewhere.

Each command entry includes the timestamp, workspace, local/VM world, runner,
command program name, command byte length, SHA-256 command fingerprint,
timeout, duration, exit result, and a hash-chain link to the preceding entry.
Docker allowlist decisions appear as separate `network_request` entries and
record only host/port/method/decision metadata.
Temporary credential injection appears as `credential_access` entries with
variable names and decisions only.
Raw command text is intentionally not stored because shell commands often
contain tokens or credentials.

The same per-session file also records `allow / ask / deny` policy decisions,
including direct-PowerShell approvals, and budget stops. Their UI detail is
represented by byte length and a SHA-256 fingerprint, not copied verbatim into
the audit file.

The log is append-only from PiWin's perspective and its hash chain can reveal
accidental truncation or reordering. It is not a tamper-proof security ledger:
a user with filesystem access can edit it. Checkpoint references will be added
with the recovery layer.

## Structural Bash risk gate

PiWin applies a second, execution-independent policy pass to every first-party
`bash` call, including `pi.bash(...)` inside `code_run`. It parses Bash with the
WASM `tree-sitter-bash` grammar before the command is routed to PowerShell,
WSL2, Docker, or the cloud VM. The parser walks command substitutions,
subshells, pipelines, and `sh`/`bash -c` payloads (up to a bounded depth), so a
rule aimed at `sudo` also sees `env sudo ...` and `bash -c 'sudo ...'`.

The Harness governance drawer has separate `allow` / `ask` / `deny` controls
for these behavior classes:

- deletion and irreversible cleanup;
- privilege escalation, including common wrapper commands;
- a download piped directly into an interpreter;
- path arguments that leave the active project workspace; and
- commands that normally initiate network activity.

The conservative default asks for all but rejects “download then execute”.
Existing custom regex rules are retained and are now matched against both the
submitted line and each command extracted from the tree. A single approval
card records the applicable structural risks and/or custom rule.

The grammar is shipped as unpacked WASM with the Windows application; no native
`tree-sitter-bash` binding is built or permitted by the pnpm supply-chain
policy. If the grammar cannot load, PiWin keeps the gate alive with a smaller
quote-aware lexical scan and marks the approval reason as a parsing fallback.
This is defense in depth, not a sandbox: dynamically generated shell text,
scripts read from a file, and arbitrary PowerShell syntax cannot be fully
understood statically. Docker's private workspace, network proxy, credentials
filter, and human approvals remain the actual enforcement controls.

## Remaining security boundary work

The Docker restricted tool profile is the first Windows containment layer.
Native PowerShell and WSL2 are convenience runners, not containment profiles:
WSL2 receives a mapped host project directory and can access whatever the
chosen distribution/user can access. They must always be visibly marked as
host execution in the UI and audit log. Docker task-private copies now provide
a unified first-party file and command boundary plus a
domain-allowlisted HTTP(S) egress path and filtered credential-safe workspace;
third-party tool routing and durable recovery remain planned.
