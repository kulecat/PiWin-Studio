# Gondolin compatibility assessment (P4)

Checked: 2026-09-03

## Decision

Do **not** enable the upstream Gondolin example as a PiWin Studio execution
profile yet. It is a valuable reference for complete first-party tool routing,
but its default workspace behavior is weaker than PiWin's guarded-task model:
it mounts the host working directory directly and guest file changes write
through to the host. PiWin's Docker and Bubblewrap profiles instead use a
private copy and a human-confirmed patch hand-off.

## What the official example does

Pi's [containerization guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md)
describes Gondolin as a local Linux micro-VM. The current example extension
overrides Pi's `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` tools,
and routes user `!` commands into the VM. It requires Node.js 23.6 or newer
and QEMU.

The example's source creates its VM with
`new RealFSProvider(localCwd)` mounted at `/workspace`. That is intentionally
convenient for ordinary local Pi usage, but it means a `write` in the guest
changes the host checkout immediately. The guide also states that extensions
run wherever the Pi process runs; a tool-routing extension does not contain
unrelated custom extension tools.

References:

- [Official containerization guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md)
- [Official Gondolin example source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/gondolin/index.ts)
- [Current example package definition](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/gondolin/package.json)

## This Windows machine's preflight

| Requirement | Result | Meaning |
| --- | --- | --- |
| Windows-host Node.js >= 23.6 | Node 24.15.0 | Satisfies the stated Node version requirement. |
| QEMU executable on Windows PATH | Missing | The desktop-host Pi extension cannot start the official VM here. |
| QEMU executable in Ubuntu WSL | Missing | A WSL-side spike cannot start yet either. |
| Node.js in Ubuntu WSL | Missing | A WSL-native Pi/Gondolin runtime is not ready. |
| `/dev/kvm` in Ubuntu WSL | Present | Hardware-acceleration capability exists for a future Linux-side experiment. |

No QEMU, Gondolin package, or third-party extension has been installed during
this assessment. Installing them is a system/dependency change that should be
done only for a dedicated spike, not inside a guarded agent task.

## Safe future spike

1. Install QEMU and Node >= 23.6 **inside Ubuntu WSL**, then run the upstream
   example in a disposable test repository; do not load it into PiWin's
   isolated agent host.
2. Replace Gondolin's direct `RealFSProvider(localCwd)` mount with a
   task-specific native private copy. The guest must never see the Windows
   checkout as a writable mount.
3. Reuse PiWin's existing binary-patch preview/import/discard hand-off rather
   than allowing the VM to write through to the host.
4. Keep all third-party Pi extensions and MCP adapters quarantined unless they
   themselves use a reviewed, routed adapter. Record VM start/stop, tool
   routing, and patch hand-off events in the session audit.

This is a separate implementation project. Until it passes the same
private-copy, no-host-write, network, recovery, and cleanup tests as the
existing Docker/WSL profiles, Gondolin should remain a research reference—not
a selectable PiWin Studio sandbox.
