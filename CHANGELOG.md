# Changelog

All notable changes to `pi-repl` are documented here.

## [Unreleased]

## [0.5.0] — 2026-09-09

### Added
- Add `repl_start` with an explicit runtime, idempotent reuse, prompt-readiness polling, and structured status/attach details. Share startup with `/repl` and `/lab`; preserve existing interpreters, variables, working directories and history. Do not auto-start from `repl_send` or add destructive lifecycle tools.
- Add portable startup/failure/cancellation tests and isolated cross-runtime tool-start, concurrent-start and unfinished-direct-input checks.
- Add Ruby/irb and Java/JShell sessions, adapting Ifiht's contribution in [PR #2](https://github.com/omaclaren/pi-repl/pull/2). Include start/status/attach/stop commands, clean records and exports, and Summary/Off/Full displays.
- Add isolated Ruby/Java integration coverage for persistence across agent and direct terminal input, interpolation and Unicode, private paths, failed compilation, incomplete snippets, and timeout/abort cleanup. Add portable command/schema routing tests; no CI workflow.

### Fixed
- Verify runtime-process exit on explicit `/repl stop` and `/lab stop`. Snapshot only the selected session's owned panes/descendants; guard session identity and topology before tmux shutdown; revalidate survivors before individual TERM/KILL escalation. Refuse linked or unconfirmed panes, protect other sessions and the tmux server, preserve logs/records, and report incomplete cleanup instead of claiming success.
- Reap and verify owned integration-test runtime processes after tmux shutdown, including GHCi children surviving session replacement and ignoring hangup/TERM. Track pre-exec process identities and descendants, revalidate before individual TERM/KILL signals, and exercise failure-path cleanup without touching unrelated sessions. Allocate test sockets in private temporary directories and remove them after verified teardown.
- Require a recognised normal prompt on the cursor row before confirming startup readiness, rather than treating a running process or banner as ready. Wait up to 20 seconds by default; unconfirmed readiness leaves sessions running with a warning, while early runtime exit reports an error.
- Encode Ruby source and paths without premature interpolation, and evaluate in the active IRB workspace so agent sends share variables with direct input.
- Preserve JShell top-level declarations with native `/open` submissions and a separate completion file. Compilation failures no longer prevent completion; use `System.out.println(...)` for visible values because `/open` does not echo expression results.
- Escape literal `#` characters in tmux `load-buffer` paths instead of treating parts of a custom private control root as tmux formats.
- Preserve output or display headers joined to the echoed loader command, as can happen with R and long control paths.
- Restore isolated test launchers after login-shell profile initialization so their runtime flags and temporary-home settings are applied on macOS too.

### Changed
- Separate the loader command from a compact Summary/Full block with one leading blank line, rather than padding between input and output. Keep Off, program-printed blank lines, clean captured output and existing markers unchanged.
- Remove unconditional Ruby/Java footer padding using a bounded, read-only tmux cursor query. Preserve newline separation for unterminated stdout/stderr, fall back safely if the query fails, and leave output streams and Ruby's last child-process status intact.
- Hide GHCi's separate completion echo behind a source/guard/driver arrangement. The intermediate guard handles unfinished multiline input without skipping completion or running it ahead of queued user code. Retain all three private scripts through timeout/abort and clean them up on settlement or session exit.
- Suppress only Ruby's redundant loader-result echo with a one-use IRB predicate, restoring normal manual echo and custom predicates immediately. Preserve legitimate user-printed `=> nil` output instead of stripping it as control noise.
- Show only one Java `/open` command in the raw pane by loading source and signalling completion through a single outer driver. Keep the user source in its own file so compilation errors and incomplete input cannot absorb the completion step.

## [0.4.2] — 2026-09-09

### Fixed
- Resolve real tmux window/pane indexes instead of assuming `0.0`, and pin the pane ID throughout a send. Default-session lookups no longer match longer session-name prefixes.
- Allocate private, unique raw history logs for newly started sessions without truncating earlier logs. Legacy logs and running sessions are left untouched.
- Retain send leases against both the tmux lifetime and opaque record ID, so a fast tmux-server restart cannot keep an old lease alive by reusing an ID and timestamp.
- Escape Julia `$` interpolation in generated wrapper strings, including optional source previews and control-file paths.
- Bound the complete `repl_send` response, including submitted code, and save truncated responses privately.

### Changed
- Default submitted-code pane echo to **Summary** so short agent submissions are readable alongside their output. Keep **Off** for quiet operation, **Full** as an explicit opt-in, and honour environment, command and per-send overrides. The display format and shared-record protocol are unchanged.
- Refresh development dependencies to Pi 0.85.1 and the current `typebox` API, using a provider-compatible string enum for echo modes. Keep TypeScript on 5.9.
- Store transient tmux paste-buffer files in the private control directory too. Allow a validated `PI_REPL_CONTROL_ROOT` override for isolation.

### Added
- Local integration tests using isolated tmux servers, with optional checks for all supported runtimes. Cover indexes, pane capture, private history, records/exports, concurrent sends, runtime errors and timeout/abort cleanup. No CI workflow added.

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
