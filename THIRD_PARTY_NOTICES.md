# Third-party notices

## Bivor

PiWin Studio is derived from [Bivor](https://github.com/ryanlab/bivor),
Copyright (c) 2026 ryanlab, distributed under the MIT License. The original
copyright notice and license are retained in [LICENSE](./LICENSE).

PiWin Studio's Windows packaging, Windows shell/browser compatibility, and
future execution-routing, policy, and recovery components are maintained as
separate changes on top of that upstream work.

## Pi Agent Harness

This application uses `@earendil-works/pi-coding-agent`, which is provided by
the [Pi Agent Harness](https://github.com/earendil-works/pi). Its license and
notices are distributed with the installed package.

## Bash syntax parser

The structural Bash policy uses `web-tree-sitter` and the
[`tree-sitter-bash`](https://github.com/tree-sitter/tree-sitter-bash) grammar.
Both are MIT licensed; their license notices are distributed with the installed
packages. PiWin loads the grammar's published WASM asset and does not include
or enable its optional native Node binding.
