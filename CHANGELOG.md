# Changelog

All notable changes to `pi-repl` are documented here.

## [Unreleased]

### Added
- Each session records which directory holds its clean record, as the tmux option `@pi_repl_record_root_key`: a hash of the directory's device and inode, not a path. A send from a terminal whose record directory is a different one, such as one with another `TMPDIR`, or has been replaced, is refused before anything is sent, rather than kept in a second record under a second lease. The key is set before a new session's record ID. For a session an older client made, it's set only by a terminal whose directory already holds that session's record. Sends check it again after waiting for the lease. A malformed key is refused and left as it is. The key applies even when the session's other record metadata can't be used, and a failed read of that metadata refuses rather than counting as none.
- The shared record module exports the key and its checks for other clients: `getReplSessionRecordRootKey`, `readReplSessionRecordRootKey`, `readReplSessionRecordStrict`, `bindReplSessionRecordRoot`, `verifyReplSessionRecordRoot`, `classifyReplSessionRecordRoot` and `describeReplSessionRecordRoot`. The protocol document describes the key, with test vectors, as a version 1 convention.

### Changed
- `/repl status`, `repl_status` and `/repl export` only read. They no longer set a session's record metadata or create its record, and they read the record without changing its mode. Status says when a session's record directory isn't verified yet, or is a different one.

## [0.11.6] — 2026-10-30

### Added
- LFortran's session has a clean record, as the other runtimes' sessions do. The helper writes an entry for each cell sent through pi-repl, the agent's and `/repl send lfortran`'s, with the sender's label, mode and request ID: `sent` until the cell finishes, then `captured`, or `error` if its outcome couldn't be confirmed. A failed cell keeps its output with a last line saying it failed, and a cell LFortran skipped after an earlier failure says so. Writes are queued off the helper's protocol reader, a finished entry is never changed back, and a failed write is a warning in status. `/repl status lfortran` shows the record, and `/repl export lfortran` writes it as Markdown. Cells run at the person's prompt aren't recorded.
- `/repl send lfortran` records under the person's name, with a `pi:send:` request ID, as `/repl send` does for the other runtimes. `sendLfortranForHost` sends a person's LFortran cell for a host that prints the result, under the host's request ID and label, such as agent-repl's `cli:send:`.

### Fixed
- A send from a nested tool call, whose ID holds a character an entry ID can't, such as `call_parent/1`, gets a stable entry ID of its own (`recordEntryKey`), from which its control files and pane anchor are named too. Before, the record gave its entry a random ID, so the pane's anchor and the entry didn't match. The entry's `requestId` is the call's own.

## [0.11.5] — 2026-10-30

### Added
- `/repl name [name|--clear]` shows, saves or removes the name a person's sends are recorded under. It's the account's shared setting, `person.json` in `$XDG_CONFIG_HOME/pi-repl/` or `~/.config/pi-repl/`, saved atomically with mode 0600 and never written on read. `PI_REPL_USER_NAME` overrides it, and without either the name is `User`. Names are trimmed, at most 80 characters, without control characters. A setting that can't be used gives a warning, and `User`.
- `resolvePersonName`, `savePersonName`, `clearPersonName`, `formatPersonNameStatus` and `personRequestId` are exported, so a host such as agent-repl records its own person commands the same way.

### Changed
- Pi's `/repl send` and `/repl env` record the person's name as the entry's label, with request IDs `pi:send:<uuid>` and `pi:env:<uuid>` in place of `command:send:` and `command:env:`. Readers show these as "<name> · via Pi", and older entries as `User`. Agent tool sends are unchanged. LFortran's `/repl send lfortran` keeps its label for now.
- The record protocol states the route rule (`mode: "agent"` for an agent's tool, `raw` and `literate` for a person's command or editor), the person prefixes for Pi, the terminal and Pi Studio, and how readers show who sent an entry. These are conventions within version 1, with no new fields.

## [0.11.4] — 2026-10-30

### Changed
- When Pi's `/repl send` outlasts its wait, its result is posted into the conversation when the code finishes, as an on-time result is (it starts no turn), and `/repl env` shows its result as a notice then. The notice when the command stops waiting is now a warning, worded for the person, and says the result will follow. The agent's text leaves out pane text that the start of a prompt already showed it while the code ran. A result that arrives while a prompt's pane text is prepared waits, up to 10 seconds, for that run to start, so the two don't overlap. If a later send or prompt reported the pane to the agent meanwhile, the result keeps that newer view and still tells the output, noting that it may already have been shown. Nothing is posted into a conversation that has been replaced; the result is in the record. Hosts without messages keep the error notice.

### Fixed
- The start of an agent's run no longer puts back its older view of a pane when a send advanced that view while the prompt was prepared; that send's output was then reported again. Each view now records when its capture began, and only a later capture replaces it.

## [0.11.3] — 2026-10-30

### Changed
- An agent's send that outlasts its wait, and Pi's `/repl send` and `/repl env`, are now settled by an owner as `sendAndSettle`'s sends are. When the wait runs out, or the call is aborted after the code was pasted, the send still returns an error. The error now says not to send the code again, whether it has finished or may still be running, and whether its output will be recorded, with its record and entry IDs; for an agent, it adds that the output will appear with its next send's pane text. The entry stays `sending` until the code finishes, when the owner captures the output from the original pane, records it and releases the session. Before, the entry became `timeout` at once and the late output was never recorded. A send whose first record write failed is still settled, with no entry to update. Agent sends still run without a lease when the session has no usable record: "recorded or not sent" applies to `sendAndSettle`.
- Session status (`repl_status`, `/repl status`, and so `agent-repl status`) says which send holds a session's lease, since when, and whether the next send will treat it as abandoned.

### Added
- `drainSettlingSends()` and `settlingSendCount()`, so a host can wait before it exits for the sends it is settling, and for those still inside their callers' waits, which may yet hand over.

### Fixed
- A cell that finishes just as an agent's send stops waiting is captured and recorded; before, its output was lost and the lease released.
- A settling send's session counts as ended when a new tmux server has reused its session ID, which happens after the old server exits.

## [0.11.2] — 2026-10-30

### Added
- `sendAndSettle`, for a host whose sender waits until its send is done, such as agent-repl's command line. It makes a person's send that is recorded or not sent at all: if the session's record can't be used, the lease isn't free in time, or the entry can't be written, nothing is sent. Once the code is sent, it settles before returning, however long the code runs. It holds the session's lease until the code has finished and its output is captured and recorded, so no other send can take the late output as its own. Only a verified end of the session, or of C++'s native pane, releases an unfinished send; a failed inspection or a missing file doesn't. Pi's `/repl send` and the agent tools are unchanged for now.
- `formatReplCommandContent`, `buildReplEnvInspectionCode` and `formatReplEnvResult` are exported, so a host can print a send's or `/repl env`'s result as pi-repl does.

### Changed
- A send that is aborted before its code reaches the pane now sends nothing. The abort is checked just before the paste; before, a send aborted while it prepared was still pasted.

## [0.11.1] — 2026-10-29

### Fixed
- `/repl attach lfortran` no longer says that what's typed in the pane goes to the agent. Unlike the other runtimes' panes, LFortran's isn't read: the agent sees only its own cells' output.

### Changed
- `/repl send lfortran` and `/repl input`: the hint for answering a READ from Pi now comes after the result's code block, so a host such as agent-repl can reword it without changing the cell's code and output.

## [0.11.0] — 2026-10-29

### Added
- Experimental LFortran (Fortran) sessions, which need LFortran's `main` branch. `/repl lfortran`, or `repl_start` with `runtime: "lfortran"`, starts `pi-repl-lfortran`: you work at LFortran's own prompt (`lfortran --connect`), and pi's cells go to the same kernel through a helper that holds pi-repl's Jupyter connection, so both share one set of variables. `repl_send`, `repl_status`, `/repl send`, `/repl status`, `/repl attach` and `/repl stop` take `lfortran`. A READ in one of pi's cells is answered with the new `repl_input` tool, or with `/repl input <text>`. There's no clean record or export for it yet; the README lists what else it doesn't do yet.
- `/repl send [runtime]` runs your own code, on the lines below it, in a running session, as `repl_send` runs the agent's. The result goes into the conversation as a message, which the agent sees at its next turn with any pane text it hadn't seen; it starts no turn. Pi shows the code and the end of the output, and Ctrl+O shows the rest.

## [0.10.5] — 2026-10-21

### Fixed
- GHCi, Octave and MATLAB: the footer's Node helper is now stopped after 5 s by a small Node supervisor, from pi-studio 0.11.0, instead of perl's `alarm`. A Node startup hook (`NODE_OPTIONS`) that caught SIGALRM held the send for as long as it stalled. The supervisor runs without `NODE_OPTIONS` and kills its query with SIGKILL, which can't be caught. The helper no longer needs perl.

### Added
- `shared/repl-cursor-column.js` exports `CURSOR_COLUMN_SUPERVISOR`, so pi-studio can use the same supervisor.

## [0.10.4] — 2026-10-21

### Fixed
- Echo Off: output that doesn't end its line is no longer lost, or followed by pi-repl's loader line in the next result. With no footer in Off, the REPL's prompt followed such output on the same row, and the clean record took the row for a prompt:
  - Python returned `midline>>> `;
  - R, GHCi, Clojure, Octave and gnuplot lost the output;
  - Python's, R's and gnuplot's next results started with the loader line.

  Off now ends a line that output left open, as C++ already did, and prints no display; if the cursor column can't be checked, it adds a newline. Ruby's Off no longer adds a blank line after every send. Found by pi-studio's review.
- GHCi: the footer's Node helper now runs with a five-second alarm timeout, as the Octave and MATLAB helpers do. A Node startup hook (`NODE_OPTIONS`) that kept Node running or blocked it no longer leaves the send unfinished. If Node can't start, the line is still ended. Ctrl-C while the footer waits no longer leaves the send unfinished: GHCi passed it to the footer's shell, which stopped before writing the done file.
- Java: the done file is written from an outer `finally`, so a footer that throws, for example from a replaced `System.out`, no longer leaves the send unfinished.

## [0.10.3] — 2026-10-20

### Fixed
- gnuplot: stopping a session no longer fails on a Mac that runs processes as `nobody`. macOS lists them with UID −2, which the helper-process check refused to parse, so every stop of a gnuplot session with an ownership marker failed before anything was signalled ("Could not parse gnuplot process candidates"). Found by pi-studio's review.

## [0.10.2] — 2026-10-20

### Added
- `stopVerifiedReplSession` takes an optional `isGnuplotSession` predicate, so a host such as pi-studio that names its own sessions can have its gnuplot sessions' marked Qt helpers cleaned up. It must return `true`; pi-repl's default still matches only `pi-repl-gnuplot`, so its behaviour is unchanged.

## [0.10.1] — 2026-10-20

### Fixed
- Ruby: Ctrl-C while a send's footer waits for the cursor column no longer leaves the send unfinished. irb raises `IRB::Abort`, which is not a `StandardError`, so the wrapper skipped writing its done file; the done file is now written from an `ensure` block even when the footer is interrupted.
- Octave: stopping a session no longer leaves an `octave-workspace` file in its working directory. Octave now starts with its workspace dump on SIGHUP and SIGTERM turned off.
- The "Launch method" line shows the start command shell-quoted, as it is run.
- Octave and MATLAB: the footer's Node helper now runs with a five-second alarm timeout, as the other runtimes' helpers have had a 5 s limit since 0.8.6. A Node startup hook (`NODE_OPTIONS`) that kept Node running or blocked it left the send unfinished. The helper runs under `/bin/sh`, stopped after 5 s by perl's `alarm` (without perl, the footer just ends the line), and passes the column through a temporary file.
- Octave: Ctrl-C while a send's footer waits no longer leaves the send unfinished. It interrupted Octave's cleanup action before the done file was written; the footer now runs inside `unwind_protect`, whose cleanup writes it. An interrupt during that write itself can still lose it.

## [0.10.0] — 2026-10-20

### Added
- In Pi, the agent is told what its REPL panes showed since it last saw them before it plans: when a run starts, a message with that text is added, for the sessions it has started or sent to, within 6,000 characters and 3 seconds in all; panes left out or not checked in time are named. It counts as seen once the run starts, so the next send doesn't repeat it, and nothing is added when nothing changed. Prompts sent while the agent is working join the run without a new message. `PI_REPL_PANE_ACTIVITY=send` keeps the 0.9.0 behaviour of reporting only in send results; `off` still stops both. Attach instructions say which applies, and that the text reaches the model provider.

### Fixed
- A tmux command killed at its timeout counts as failed even when it reports exit code 0, so a timed-out pane capture is no longer taken as an empty pane.

## [0.9.0] — 2026-10-20

### Added
- `repl_send` starts its result with the pane text the agent has not seen since its own last send: typing at the prompt, other clients' sends, and late or background output. Each agent process keeps its own view, which only its sends advance, anchored on each send's unique loader line. `repl_status` previews the same text. Reports are bounded, labelled as untrusted terminal text, and stay out of the clean record. Attach instructions mention it, and `PI_REPL_PANE_ACTIVITY=off` turns it off.

## [0.8.6] — 2026-10-19

### Fixed
- The 0.8.4 done-marker footer no longer waits without limit for its helper. In Julia and R, a Node startup hook (`NODE_OPTIONS`) that kept Node running held the cell's completion indefinitely. Node now exits as soon as the query has run, and every wrapper limits the helper to 5 s.
- In Clojure, an interrupt while the footer waits no longer leaves the tmux query running. The wait goes on, and the interrupt is restored afterwards.

## [0.8.5] — 2026-10-19

### Fixed
- Julia no longer leaves copies of a wrapped submission line in the output. In a pane narrower than the `include(...)` line, such as a detached session's default 80 columns, Julia redrew the line for each pasted character, and the copies stayed in the clean output. pi-repl now sends Julia a bracketed paste.

## [0.8.4] — 2026-10-19

### Fixed
- In the Summary and Full displays, output that doesn't end its line no longer runs into the done marker in Python, IPython, Julia, R and Clojure. The marker then stayed in the clean output, as in `c── done · id: … ──`. These wrappers now check the cursor column first, as the GHCi, Ruby and Java ones do.

## [0.8.3] — 2026-10-19

### Fixed
- pi-repl works when the locale is not UTF-8, for example with `LANG` unset. tmux printed the tabs in its pane listings as `_`, so commands failed with "no panes found"; pi-repl now passes `-u` to tmux.

## [0.8.2] — 2026-10-19

### Added
- `stopVerifiedReplSession` takes an optional `sessionNamePattern`, so a host such as pi-studio can stop its own sessions with the same verification. By default it still accepts only pi-repl's sessions; a global or sticky pattern is refused.

### Fixed
- IPython shows an expression's value once, as `Out[N]: …`. The wrapper used to print it again as a bare `repr`.
- Verified stop no longer refuses to run on macOS when a process of `nobody` (uid -2) is running.

## [0.8.1] — 2026-09-25

### Added
- Read the clean-record label for `repl_send` submissions from `PI_REPL_AGENT_LABEL` on each send, so a host running these tools outside Pi can record which agent sent them. Blank or unset values keep the `Pi` label; record and display formats are unchanged.

## [0.8.0] — 2026-09-17

### Added
- Add experimental `cpp`: a Cling-based C++ REPL with normal login-shell discovery, observational startup/reuse, command/tool routing, clean records/exports, submission displays and verified explicit stop.
- Evaluate C++ prompt groups using Cling's native validator/interpreter in the same process. Private framed requests and correlated replies distinguish native return, compilation failure, incomplete groups and C++ exceptions without feeding completion commands to stdin. Retain controls/leases through timeout or cancellation; native exit/crashes/busy Ctrl-C may end the workspace, with no restart or replay.
- Add portable control/identity/routing tests and isolated native checks, including an optional one-rank PETSc persistent-object regression. Cling/PETSc are not installed or bundled by the extension. Cling 1.3 on ARM64 macOS is the tested configuration; other builds/platforms remain experimental.

### Fixed
- Handle a session disappearing between the status existence check and pane lookup during native exit. Confirm absence before reporting it stopped; keep live-session and ambiguous inspection errors visible.

## [0.7.0] — 2026-09-11

### Changed
- Raise the default Summary preview from 6 lines / 600 source characters to 20 lines / 2,000 characters. Full remains 40 lines / 4,000 characters; Off, execution, clean records and display/record identities are unchanged.

### Added
- Add standalone gnuplot sessions with command/tool routing, prompt readiness, persistent native state, direct terminal collaboration, clean records/exports and verified explicit stop. Launch the user's normal `gnuplot` command without selecting or repairing a plotting backend.
- Add private source/guard/pipe-producer submissions that complete after native return or error/interrupt unwinding, without queuing terminal input, adding gnuplot variables, or changing print/output/table settings and error status. Preserve correlated filenames, Summary/Off/Full displays, and controls/leases through timeout or abort.
- Add portable producer/quoting/routing tests and isolated gnuplot integration checks for state, hostile literal paths, errors, Ctrl-C, native pauses/exits, plotting, export and shutdown. Include optional Qt offscreen checks, skipped when that backend is unavailable.

### Fixed
- Preserve diagnostics and user output containing old control paths, loader-like expressions or preview-like comments in Off/Summary/Full mode. Remove only the current submission's anchored loader echo, and retain display boundaries while trimming native scaffolding so printed commands and prompt-looking output are not mistaken for control noise.
- Track new gnuplot sessions' detached interpreter/Qt helpers using an inherited launch marker plus UID/birth identity and protected-pane checks. Preserve other sessions, warn for older unmarked sessions, and never repair plotting configuration or adopt helpers by executable name alone.
- Remove stale Qt sockets only after verified process exit and fresh descriptor/inode/reference checks; leave uncertain files untouched with a warning. Native ownership inspection uses `/proc` on Linux or an existing isolated `python3` on macOS; socket inspection uses `lsof`.
- Register independent private-cwd provenance before launching test gnuplot sessions so failed Qt tests cannot silently leak detached helpers. Verify production cleanup before the rescue hook, including a second live Qt session and legacy-session handling.

## [0.6.1] — 2026-09-10

### Changed
- Prefix submission source, guard, driver and completion filenames with the same short ID used by their input/done markers. Keep independent 64-bit random allocation tokens, private/exclusive creation, timeout/abort retention, and cleanup of older unprefixed files. Off still suppresses display markers; transient paste-buffer names remain unprefixed. Record IDs, display hashes and the shared protocol are unchanged.

### Fixed
- Reject control-file extensions containing trailing line breaks, keeping allocated filenames consistent with the strict cleanup parser.

### Documentation
- Refresh the shared Julia REPL example with matching control-file IDs, and select light/dark screenshots automatically in the README.

## [0.6.0] — 2026-09-10

### Changed
- Show plain input previews without added vertical bars. Label the header `input`, put the line count before `id: <short hash>`, and label the matching completion ID too. Keep hash derivation and old-marker parsing compatible; match the known preview so marker-looking source lines are not confused with output.
- Add a blank line after the `done` anchor in Summary/Full mode across all REPLs, balancing the leading loader separator. Leave Off and native prompt settings unchanged; strip only the added display gap from clean output, preserving user whitespace and older captures.

### Added
- Add separate Octave (`octave-cli`) and licensed MATLAB terminal sessions, with command/tool routing, prompt readiness, persistent base workspaces, records/exports and verified explicit stop. MATLAB starts without the desktop in Pi's working directory; neither runtime silently substitutes for the other.
- Add private `.m` source/driver submissions with a function-local completion guard, preserving base variables and native `ans`/semicolon behaviour through error recovery, `clear all`, return and interruption. Keep Summary/Off/Full displays and controls/leases through timeout or abort; leave plotting native with explicit export.
- Add isolated Octave/MATLAB checks for direct input, Unicode/private paths, scripts/functions, cwd/path changes, clearing, interruption, exit, startup reuse and shutdown, plus optional headless figure export and portable routing/readiness/encoding tests.

### Fixed
- Record Ruby and Java submissions with their actual runtime instead of incorrectly falling through to the Python runtime label. Use the same explicit runtime selection for all non-Python targets.

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
