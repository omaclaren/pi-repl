# Changelog

All notable changes to `pi-repl` are documented here.

## [Unreleased]

### Added
- Add protocol-v1 clean records owned by the exact tmux session lifetime, discovered through first-writer-wins tmux metadata and stored as private bounded atomic snapshots.
- Synchronize compatible-client code, lifecycle status, and captured output bidirectionally with `pi-studio` while keeping both extensions independently usable.
- Serialize compatible `pi-repl` and Studio sends with a cross-client lease held from pre-send capture through completion capture, retaining it after caller timeout or abort until the runtime marker or exact-session shutdown.
- Expose clean-record identity, path, count, recent entries, and warnings through `/repl` status and `repl_status` details.
- Add `/repl export [target]` for no-clobber canonical Markdown exports in Pi's current working directory.

### Changed
- Keep the raw tmux pane/history mirror explicitly separate from the clean compatible-client record; direct pane typing is retained as raw history rather than heuristically parsed into entries.

## [0.3.1]

### Changed
- Migrate Pi development and runtime dependencies to the current `@earendil-works` package scope.

## [0.3.0]

### Added
- Add shared Haskell (GHCi) and Clojure REPL support.
