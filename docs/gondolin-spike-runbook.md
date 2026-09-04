# Gondolin/QEMU disposable spike runbook (P8)

Status: **preflight only; not a PiWin Studio execution profile.**

The upstream Pi containerization guide describes Gondolin as a local Linux
micro-VM extension. It requires Node.js 23.6+ and QEMU, routes built-in tools
and `!` commands into its VM, and mounts the current host directory at
`/workspace`. That final behavior is intentionally unsuitable for a guarded
PiWin task: guest edits would write through to the Windows checkout.

References:

- [Official Pi containerization guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md)
- [Official Gondolin example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/gondolin)

## Do not install automatically

This spike changes the Windows/WSL development environment and may download
hundreds of megabytes. PiWin only displays the preflight result. A person must
explicitly choose to install the dependencies, and must run the experiment in a
disposable repository rather than the PiWin source checkout.

For a WSL-side exploratory environment, install QEMU through Ubuntu's package
manager and install a current Node release through your normal approved Node
installation method. For a host-side official extension experiment, the Windows
PATH must contain `qemu-system-x86_64.exe` as well. Reopen PiWin Settings and
refresh the preflight after each change.

## Required acceptance checks before any product integration

1. The guest only sees a task-specific native private copy; it never gets a
   writable mount of the Windows worktree.
2. All `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, and `!` routes
   target the same guest/private copy.
3. Export a binary-safe patch and show its changed paths before a human imports
   it into the host task worktree. Import and discard must remain explicit.
4. A host/app crash reconnects to the same private copy without automatic
   import; its patch can still be previewed or discarded.
5. Default network is denied or is routed through a tested destination policy.
   Third-party extensions and MCP adapters remain disabled unless they have an
   independently reviewed routed design.
6. The disposable test proves a guest `write` cannot alter a sentinel file in
   the Windows checkout before the patch hand-off.

Until every check passes, record Gondolin only as a research reference in the
portfolio—not as an implemented PiWin sandbox.
