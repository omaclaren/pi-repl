# Changelog

All notable changes to `pi-repl` are documented here.

## [Unreleased]

## [0.4.1] — 2026-09-03

### Added
- Add deterministic raw-pane submission displays and alignment anchors across Python/IPython, Julia, R, GHCi, and Clojure, with privacy-conscious **Off** default, adaptive **Summary**, and bounded **Full** modes.
- Add `/repl echo [off|summary|full]`, per-send `echoMode`, and `PI_REPL_ECHO_MODE` startup configuration.

### Changed
- Keep ordinary panes quiet by default; opt-in Summary now shows short submissions in full, truncates longer ones after 6 lines or 600 source characters, and uses compact begin/completion anchors with a plain unanchored output divider instead of three metadata-heavy marker lines.
- Strip each request-specific header, source preview, divider, and footer from `repl_send` results and protocol-v1 clean records while retaining the optional display in raw tmux history for readability and future transcript alignment.
- Replace fixed global loader files such as `/tmp/pr.py` with compact collision-resistant files under the private per-user `/tmp/pi-rc-<user-key>` root also used by Studio. Request-unique names keep the independently installed clients from colliding; source files use mode `0600`, completed files are removed immediately, timeout/abort files remain only until the submission settles, and crash leftovers older than 24 hours are pruned on a later send.

## [0.4.0] — 2026-09-02

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
