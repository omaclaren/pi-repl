# pi-repl

Minimal [pi](https://github.com/badlogic/pi-mono) extension for collaborative REPL sessions using tmux.

`pi-repl` starts a shared Python, IPython, Julia, R, Haskell (GHCi), Clojure, Ruby (irb), Java (JShell), Octave, or MATLAB REPL in tmux that you can attach to from another terminal window. You can work in the REPL directly, or ask pi to send and execute code there.

![Interacting with a shared Julia REPL](./shared-julia-repl.png)

*Interacting with a shared Julia REPL.*

## Current scope

Currently, `pi-repl` supports **Python/IPython**, **Julia**, **R**, **Haskell (GHCi)**, **Clojure**, **Ruby (irb)**, **Java (JShell)**, **Octave**, and **MATLAB**.

With `pi-repl` you can:

- start a shared REPL from pi
- attach to that REPL from another terminal window
- work in the REPL yourself as normal
- ask pi, in natural language, to run code in any supported shared REPL
- start, attach to, inspect, and stop a shared R REPL
- start, attach to, inspect, and stop a shared Haskell (GHCi) REPL
- start, attach to, inspect, and stop a shared Clojure, Ruby, Java, Octave, or MATLAB REPL
- let pi read the raw shared REPL transcript for extra context when needed
- keep a bounded clean record of compatible-client submissions and captured output, synchronized automatically with a compatible `pi-studio` using the same tmux session
- show bounded, request-specific submitted code and compact alignment anchors in the raw pane by default, with Summary previews, Off for quiet output, and Full as an explicit opt-in
- export that clean record as canonical Markdown
- check which shared REPL sessions are running
- inspect which Python interpreter and environment the shared Python/IPython REPL is using with `/repl env`
- stop the shared REPL when you are done

Use `/lab` as a short alias for `/repl`.

## Install

From npm:

```bash
pi install npm:pi-repl
```

From GitHub:

```bash
pi install https://github.com/omaclaren/pi-repl
```

Restart pi after installing.

## Commands

| Command | Description |
|---------|-------------|
| `/repl` | Show usage |
| `/lab` | Alias for `/repl` |
| `/repl python` | Start the shared Python/IPython session with `python` |
| `/repl ipython` | Start the shared Python/IPython session with `ipython` |
| `/repl julia` | Start the shared Julia session with `julia` |
| `/repl r` | Start the shared R session with `R` |
| `/repl ghci` | Start the shared Haskell (GHCi) session with `ghci` |
| `/repl clojure` | Start the shared Clojure session with `clojure` |
| `/repl ruby` | Start the shared Ruby session with `irb` |
| `/repl java` | Start the shared Java session with `jshell` |
| `/repl octave` | Start the shared Octave session with `octave-cli` |
| `/repl matlab` | Start the shared MATLAB terminal session |
| `/lab python` | Same as `/repl python` |
| `/lab ipython` | Same as `/repl ipython` |
| `/lab julia` | Same as `/repl julia` |
| `/lab r` | Same as `/repl r` |
| `/lab ghci` | Same as `/repl ghci` |
| `/lab clojure` | Same as `/repl clojure` |
| `/lab ruby` | Same as `/repl ruby` |
| `/lab java` | Same as `/repl java` |
| `/lab octave` | Same as `/repl octave` |
| `/lab matlab` | Same as `/repl matlab` |
| `/repl echo` | Show the current submitted-code pane-echo mode |
| `/repl echo off` | Disable submitted-code displays and raw-history anchors for new sends |
| `/repl echo summary` | Show short submissions in full, truncating after 6 lines or 600 source characters, with compact anchors (default) |
| `/repl echo full` | Show up to 40 lines or 4,000 source characters and anchors in persistent raw history |
| `/repl status` | Show running shared REPL sessions |
| `/repl status python` | Show status for the shared Python/IPython session |
| `/repl status julia` | Show status for the shared Julia session |
| `/repl status r` | Show status for the shared R session |
| `/repl status ghci` | Show status for the shared Haskell (GHCi) session |
| `/repl status clojure` | Show status for the shared Clojure session |
| `/repl status ruby` | Show status for the shared Ruby session |
| `/repl status java` | Show status for the shared Java session |
| `/repl status octave` | Show status for the shared Octave session |
| `/repl status matlab` | Show status for the shared MATLAB session |
| `/repl env` | Show which interpreter and environment the shared Python/IPython REPL is using |
| `/repl attach` | Show how to attach from a new terminal window |
| `/repl attach julia` | Show how to attach to the shared Julia session |
| `/repl attach r` | Show how to attach to the shared R session |
| `/repl attach ghci` | Show how to attach to the shared Haskell (GHCi) session |
| `/repl attach clojure` | Show how to attach to the shared Clojure session |
| `/repl attach ruby` | Show how to attach to the shared Ruby session |
| `/repl attach java` | Show how to attach to the shared Java session |
| `/repl attach octave` | Show how to attach to the shared Octave session |
| `/repl attach matlab` | Show how to attach to the shared MATLAB session |
| `/repl export` | Export the clean record when exactly one shared session is running |
| `/repl export python` | Export the shared Python/IPython clean record as canonical Markdown |
| `/repl export julia` | Export the shared Julia clean record as canonical Markdown |
| `/repl export r` | Export the shared R clean record as canonical Markdown |
| `/repl export ghci` | Export the shared Haskell (GHCi) clean record as canonical Markdown |
| `/repl export clojure` | Export the shared Clojure clean record as canonical Markdown |
| `/repl export ruby` | Export the shared Ruby clean record as canonical Markdown |
| `/repl export java` | Export the shared Java clean record as canonical Markdown |
| `/repl export octave` | Export the shared Octave clean record as canonical Markdown |
| `/repl export matlab` | Export the shared MATLAB clean record as canonical Markdown |
| `/repl stop` | Stop the shared session if only one is running |
| `/repl stop python` | Stop the shared Python/IPython session |
| `/repl stop julia` | Stop the shared Julia session |
| `/repl stop r` | Stop the shared R session |
| `/repl stop ghci` | Stop the shared Haskell (GHCi) session |
| `/repl stop clojure` | Stop the shared Clojure session |
| `/repl stop ruby` | Stop the shared Ruby session |
| `/repl stop java` | Stop the shared Java session |
| `/repl stop octave` | Stop the shared Octave session |
| `/repl stop matlab` | Stop the shared MATLAB session |

For R, both `/repl R` and `/repl r` work. The same applies to `/lab`, `/repl status`, `/repl attach`, `/repl export`, and `/repl stop`.

For Clojure, `/repl clojure` is canonical and `/repl clj` also works. The same applies to `/lab`, `/repl status`, `/repl attach`, `/repl export`, and `/repl stop`.

## Tools used by pi

`pi-repl` also exposes tools that pi can use internally. In normal use, you can ask pi to start a shared REPL or run code there, or use the `/repl` commands directly.

| Tool | Description |
|------|-------------|
| `repl_start` | Start or reuse a shared session with an explicit runtime; wait for a normal prompt and return status/attach details |
| `repl_status` | Inspect the state of supported shared REPL sessions |
| `repl_send` | Execute code in a running supported shared REPL session |

Notes:

- `repl_status` is what pi uses to check which shared REPL sessions are currently running
- while a shared REPL is running, `repl_status` exposes the versioned clean-record ID/path/count/tail and the separate raw session history path
- pi can use the clean entries when it needs compatible-client code/output boundaries, or read the raw history for context about direct pane interaction
- the relevant shared session must already be running and at a normal prompt before `repl_send`; it never auto-starts a missing session
- you can ask pi naturally to run code in Python, IPython, Julia, R, Haskell, Clojure, Ruby, Java, Octave, or MATLAB; pi chooses the tool parameters internally
- use `target: octave` or `target: matlab` for their separate sessions; they never substitute for one another
- `repl_status` and `repl_send` accept `target: ruby` or `target: irb`, and `target: java` or `target: jshell`; use the canonical `ruby` and `java` names in `/repl` commands and `repl_start`
- for plain Python, `print(...)` is the safest way to get values back reliably
- in Haskell (GHCi), use normal interactive syntax such as `let` bindings or `:{ ... :}` blocks for multiline declarations
- in Clojure, use normal interactive syntax such as `let`, `def`/`defn`, or `do` forms for multiline code
- tool output includes both the submitted code and the captured output; the complete response is limited to 2,000 lines or 50 KiB, with the full response saved to a private file when truncated
- `repl_send` accepts `echoMode: off|summary|full` for a single send; otherwise it uses `/repl echo`, initialized from `PI_REPL_ECHO_MODE` or Summary
- Full echo mode writes bounded submitted source code into persistent raw terminal history; Summary shows short submissions in full and truncates after 6 lines or 600 source characters

### Starting a session through pi

Ask, for example, “Start a shared Ruby REPL.” Pi can call:

```json
{ "runtime": "ruby", "timeoutMs": 20000 }
```

`repl_start` requires `runtime`: `python`, `ipython`, `julia`, `r`, `ghci`, `clojure`, `ruby`, `java`, `octave`, or `matlab`. It shares the `/repl` and `/lab` startup implementation: a detached tmux session, launched from Pi's working directory through your normal interactive login shell. It returns `created`/`reused`, `ready`, the requested and recorded runtimes, session status (including record/history paths), and an `attachCommand`. It does not open a terminal or attach a client automatically.

An existing session is reused without resetting variables, changing its working directory, replacing its history logger, or sending input. Python and IPython share `pi-repl-python`: requesting the other interpreter preserves the one already running and reports the difference. As with status inspection, legacy sessions can lazily acquire clean-record metadata; existing metadata is preserved.

Startup waits for a recognised normal prompt on the physical cursor row, not merely a running process, an old prompt in scrollback, or a startup banner. No probe code, Enter, Ctrl-C, or prompt-setting changes are sent. The default wait is 20 seconds; `timeoutMs` accepts 1,000–120,000 milliseconds for prompt polling, in addition to bounded tmux setup/inspection calls. If the prompt cannot be confirmed, the tool returns `ready: false` with status and a warning, leaving the session running. Busy sessions, unfinished direct input, and customised prompts can all produce this result; inspect the pane before sending code. Prompt detection is a snapshot, not a guarantee that another person cannot begin typing afterwards.

Missing tmux, failed creation, early runtime exit, and cancellation are reported as tool errors. Cancellation after creation leaves the session running too; inspect it with `repl_status`. Stopping or restarting remains an explicit user action. `repl_send` does not silently start, restart, or switch a REPL.

### Ruby and Java submissions

Ruby requires `irb` on PATH. Submissions evaluate in the active IRB workspace, so variables and definitions are shared between agent sends and code you type directly. The last non-`nil` result is printed. A one-use IRB echo check suppresses only the loader's redundant `nil` result, restoring the original check before returning; manual expressions, manual `nil`, and the configured echo preference behave normally. User-printed `=> nil` text remains output. Source, paths and previews are encoded without prematurely expanding Ruby interpolation.

Java requires a JDK with `jshell` on PATH. Submissions use JShell's native `/open` command: imports, variables, methods and classes remain available across sends and direct terminal input. **Use `System.out.println(...)` for visible results**; `/open` executes bare expressions but does not echo their values. For example:

```java
int count = 41;
System.out.println(count + 1);
```

Java uses one outer driver file to load the source and then signal completion. The source remains in a separate private file so malformed input cannot swallow the driver's completion step, while the pane shows only the initial `/open` command. JShell control paths can contain spaces and quotes, but not line breaks. Submit complete snippets: JShell can reject or discard unfinished input rather than continue it in a later send. Evaluation is not transactional—valid snippets can run even if another snippet fails. JShell commands such as `/reset` and `/exit` change or end the live session; use them deliberately.

Both runtimes support the same private logs, clean records, exports, Summary/Off/Full displays, and timeout/abort lease handling as the existing runtimes. As with the other REPLs, wait for a normal prompt before sending code; do not send while a person is entering an unfinished interactive expression.

### Octave and MATLAB submissions

Octave requires `octave-cli` on PATH and starts with `--quiet --interactive`. MATLAB requires a licensed installation with `matlab` on PATH; it starts with `-nodesktop -nosplash -sd <Pi working directory>`. These are separate persistent terminal sessions, not connections to an existing MATLAB desktop. Startup can take longer for MATLAB: request `repl_start` with `timeoutMs: 120000` if needed, and check `ready` before sending code.

Code evaluates in the **base workspace**, shared with direct terminal input. Variables, native semicolon/`ans` behaviour, working-directory changes and search-path changes persist. For example, either runtime can run:

```matlab
A = [2 1; 1 2];
disp(eig(A));
```

Send complete snippets. Run existing scripts or call functions on the current path; MATLAB function definitions belong in `.m` files rather than an `eval` submission. Syntax/runtime errors are printed and later sends can recover, but execution is not transactional: earlier effects are not undone. The completion guard lives outside the base workspace, so `clear`, `clear all`, `return` and Ctrl-C do not remove it. Clearing variables and ending the runtime with `exit` or `quit` are still deliberate state-changing actions. An exit may complete its guard before the pane closes, or be reported as a session-ended error.

A private `.m` driver loads the code and records completion without adding helper variables or changing `ans` in the base workspace. Unicode, quoting and line breaks are encoded safely. Both runtimes use the existing records, exports, Summary/Off/Full displays, retained timeout/abort controls, and verified explicit stop. They recognise the ordinary `octave:N>` and `>>` prompts; custom/debugger prompts are not treated as ready. This adds runtime support to `pi-repl`, not new MATLAB/Octave controls to `pi-studio`.

Graphics retain the runtime's normal behaviour and installed backends. Figures are not captured automatically. Export explicitly when needed, for example `print(gcf, 'figure.png', '-dpng')`. Headless Octave graphics depend on an appropriate toolkit; `octave-cli` does not repair a missing or broken Qt installation.

## Shared clean record

`pi-repl` remains independently usable and has no dependency on `pi-studio`. When a compatible `pi-studio` uses the same tmux REPL session, both clients automatically discover one session-owned clean record and see each other's submitted code and captured output.

Compatible clients publish a versioned opaque ID in tmux and store the bounded JSON snapshot in a private per-user temporary directory. The record is tied to the exact tmux session ID and creation time, uses atomic locked updates, and holds a shared send lease from pre-send capture through completion capture. If `repl_send` times out or is aborted after submission, that live client retains the lease until the runtime completion signal appears or the exact tmux session ends; caller cancellation does not stop code already running in the REPL. This serializes compatible Studio and `pi-repl` sends so they do not claim each other's output.

The clean record does **not** infer semantic boundaries for commands typed directly into an attached tmux pane. Direct interaction remains in the raw pane/history mirror. `/repl export [target]` writes the canonical clean-record Markdown to a new no-clobber file in Pi's current working directory; its metadata identifies entry origin, mode, status, runtime, and timestamp and states the direct-input limitation.

Existing sessions attach lazily. Unsupported versions and invalid or stale session identities are left untouched, with ordinary `pi-repl` behavior and raw history still available. See [`shared/REPL_SESSION_RECORD_PROTOCOL.md`](./shared/REPL_SESSION_RECORD_PROTOCOL.md) for protocol, safety, retention, and compatibility details.

### Submission display and alignment anchors

Pane echo, enabled in Summary mode by default, places one blank line before the compact begin anchor, separating the runtime loader command from the readable block. Submitted code, the plain `── output ──` divider, output and the completion anchor then follow without added internal padding. All runtimes add one display-only blank line after `done` too, separating the block from the returning prompt. Native prompt spacing is left unchanged. Blank lines printed by user code remain in the raw pane; display spacing does not change submitted code or clean captured output. The header reads `── pi-repl · input · 2 lines · id: 40c4561ef0f6 ──`, followed by plain code with its indentation and no added vertical bars. The same labelled ID appears after `done`. This is a stable 12-character hexadecimal hash derived from the Shared REPL Record entry ID: a correlation label for matching raw history to a recorded send, not a counter, timestamp or execution signal. Older marker formats remain readable. `repl_send` removes the exact header, source preview, divider, and footer from captured output and the clean record, while they remain in raw pane history.

Use `/repl echo off|summary|full` to change the default for the current Pi process, or set `PI_REPL_ECHO_MODE` before startup. A per-send `echoMode` overrides that default without changing it. **Summary** is the startup default: it shows short submissions in full, truncates after 6 lines or 600 source characters, and puts a plain output divider before runtime output. **Off** disables the optional display and alignment anchors for quiet output, although the REPL can still echo its unavoidable temporary-file control command. **Full** is an explicit opt-in that raises the bounds to 40 lines or 4,000 source characters. Terminal, line-separator, and bidirectional control characters are escaped in all visible previews.

GHCi, Ruby, Java, Octave and MATLAB use a read-only tmux cursor-column query, with a short timeout, to avoid adding an empty row before `done` while still separating it from output that has no trailing newline. If that query is unavailable, they fall back to the safe newline guard. Output streams and interactive echo settings are not replaced.

Both Summary and Full persist the displayed source in raw terminal history. Off suppresses this extra copy, not the submitted code already retained in tool results and the clean record. Explicit `PI_REPL_ECHO_MODE=off` settings are still honoured.

Runtime wrappers use compact request-unique paths such as `/tmp/pi-rc-<user-key>/<token>.py` instead of fixed global files such as `/tmp/pr.py`. The per-user root is current-user-owned mode `0700`, source files are mode `0600`, and files are removed after capture or by the timeout/abort watcher once execution settles. The short command remains readable while separate Pi processes, tmux servers, runtimes, and Studio sends cannot overwrite one another's control files.

GHCi shows only the initial `:script` command. Three private scripts separate user source, an intermediate guard, and the outer completion driver. An unfinished `:{ … :}` block can stop a single nested driver; the guard absorbs that script failure so the outer driver still reaches completion. User source is not repaired or rewritten, queued user commands still finish first, and all three files remain private and retained until execution settles. GHCi control paths cannot contain line breaks.

Ruby's one-use echo check preserves an existing singleton `echo?` method as well as ordinary IRB settings. If an unusual customised or frozen context refuses the hook, the wrapper keeps normal IRB behaviour rather than failing the submission.

These anchors are presentation and alignment evidence only. They do not make direct attached-pane input authoritative and never promote inferred raw history into protocol-v1 entries.

## Shared sessions

The default shared tmux session names are:

- `pi-repl-python` for Python/IPython
- `pi-repl-julia` for Julia
- `pi-repl-r` for R
- `pi-repl-ghci` for Haskell (GHCi)
- `pi-repl-clojure` for Clojure
- `pi-repl-ruby` for Ruby/irb
- `pi-repl-java` for Java/JShell
- `pi-repl-octave` for Octave
- `pi-repl-matlab` for MATLAB

Nonzero tmux `base-index` and `pane-base-index` settings are supported. `pi-repl` selects the lowest-indexed pane in the lowest-indexed window, then pins that pane's stable ID for each send so switching active windows cannot redirect its output capture.

The Python/IPython session can currently be launched in either:

- `python` mode
- `ipython` mode

## Stopping safely

`/repl stop [target]` and `/lab stop [target]` verify shutdown, rather than assuming that closing tmux also terminates its runtimes. The command snapshots the selected session's pane processes and descendants, checks local owner/start-time/terminal identities, and guards the final tmux operation against session replacement or changed pane topology. Linked windows are refused because another session still uses them.

After closing the selected session, it waits briefly for normal exit, sends TERM to confirmed survivors, and uses KILL only if those same owned processes still survive. Each signal rechecks process identity and protects live panes, Pi itself, and the tmux server. It never kills by runtime name or signals an entire process group. Success is reported only after verification; uncertain ownership, inspection failures or surviving processes produce an error requiring manual inspection. Dead/detached panes whose ownership cannot be established are refused before shutdown.

This is an explicit, state-discarding stop: save anything needed first. It sends no runtime exit command, Ctrl-C or other input into the pane, and leaves raw logs and clean records on disk. Other sessions are not stopped. No process cleanup runs automatically on startup, send, Pi reload or Pi exit. The checks require local Unix process inspection (macOS/Linux); missing inspection support fails closed. It is not a general orphan collector: processes already detached before inspection, or descendants that cannot be safely attributed after their parent exits, may require manual cleanup.

## Attaching

After running `/repl attach`, open a new terminal window and run the tmux command shown by pi. For example:

```bash
tmux attach -t pi-repl-python
```

## Example workflow

```text
/repl ipython
/repl env
/repl echo summary
/repl status
/repl attach

/repl julia
/repl status julia
/repl attach julia

/repl R
/repl status r
/repl attach r

/repl ghci
/repl status ghci
/repl attach ghci

/repl clojure
/repl status clojure
/repl attach clojure

/repl ruby
/repl status ruby
/repl attach ruby

/repl java
/repl status java
/repl attach java

/repl export python
```

Example requests once the REPL is running:

- `run print(sys.executable) in the shared Python REPL`
- `inspect the current globals in the shared Python REPL`
- `in the shared Julia REPL, load LinearAlgebra`
- `now find the eigenvalues of [2 1; 1 2] in the shared Julia REPL`
- `in the shared R REPL, run mean(c(1, 2, 3, 4))`
- `in the shared Haskell REPL, run map (+1) [1,2,3]`
- `in the shared Clojure REPL, run (map inc [1 2 3])`
- `in the shared Ruby REPL, run (1..3).map { |x| x + 1 }`
- `in the shared Java REPL, run System.out.println(1 + 2);`

## Notes

- `tmux` is required.
- Mainly tested on macOS. On Windows, use WSL, with Pi, tmux and the interpreters all running inside it.
- While a shared REPL is running, `pi-repl` keeps both the compatible-client clean record and a raw transcript log of the tmux pane output for that session.
- The raw transcript is plain text and may include prompts, echoed input, request-specific display anchors, output, direct pane interaction, and errors; it is not parsed into clean entries.
- Newly started sessions use unique mode-`0600` raw logs in the current-user-owned mode-`0700` directory `<os temporary directory>/pi-repl-history-<uid>/`. Restarting a session or using another tmux server does not truncate a previous log. Symlinked, foreign-owned, or permissive history roots are refused.
- Existing sessions and legacy `/tmp/pi-repl/*.history.log` files are left untouched. The new storage applies when you next start a REPL session; restarting a REPL discards its in-memory variables, so do this only when finished with that session. Logs are not automatically deleted.
- `/repl env` is currently implemented for Python/IPython only.

## Development and local checks

Development checks use Pi 0.85.x, its current `typebox` API, and Node.js 22.19 or later. TypeScript stays on 5.9 for this maintenance update.

```bash
npm ci
npm run typecheck
npm test
```

`npm test` runs unit tests plus local Python/tmux integration tests. Integration tests use dedicated tmux servers with empty configuration, temporary homes and private test files. Test sockets live in short, private temporary directories, not the user's tmux socket directory. Teardown verifies that both the servers and their owned runtime processes exit; it does not treat a vanished tmux session as sufficient. Tests do not attach to or send code to your existing REPLs. Tests requiring tmux or Python skip when those executables are unavailable; no CI service is required.

To exercise all installed runtimes, or just a selected subset:

```bash
PI_REPL_TEST_RUNTIMES=all npm test
PI_REPL_TEST_RUNTIMES=julia,r npm run test:integration
PI_REPL_TEST_RUNTIMES=ruby,java npm run test:integration
PI_REPL_TEST_RUNTIMES=octave,matlab npm run test:integration
```

The integration tests cover command/tool startup across runtimes, concurrent starts, state-preserving reuse, readiness timeout on unfinished direct input, nonzero indexes, pane selection, session restarts, raw-log permissions, clean records and exports, concurrent sends, timeout/abort leases, and runtime wrappers. Portable startup tests also cover explicit runtime validation, failures, cancellation, custom/continuation prompts, and bounded status output. Ruby/Java checks also cover shared direct input, interpolation, Unicode and quoted control paths, persistent declarations, malformed input and error recovery. Octave/MATLAB checks cover base-workspace and direct-input persistence, `ans`, scripts/functions, cwd/path changes, Unicode, syntax/runtime errors, clearing, return, interruption, exit, retained controls and figure-file export where a non-windowed backend is available. MATLAB tests need a working licence; they isolate preferences and startup files without changing the installed licence. Optional runtime tests are opt-in and skip missing executables. Julia tests resolve the existing juliaup-selected binary before isolating the test home.

Test launchers record PID/owner/start-time identities before executing a runtime. The test harness tracks server descendants and pane process groups across session replacement, then individually revalidates survivors before TERM/KILL cleanup. It never kills by executable name or signals a whole process group. The teardown hook is registered before launch, runs after setup failures too, verifies no owned runtime is still running, and removes its private socket directory only after successful cleanup. Regression tests cover ignored hangup/TERM, orphaned children, PID reuse, failed setup, and preservation of unrelated sessions. Production `/repl stop` tests independently verify runtime exit before test teardown, across all supported runtimes, including a busy GHCi session, resistant child processes, linked windows and same-name replacement races.

`PI_REPL_CONTROL_ROOT` optionally overrides the private runtime-control directory; it must be current-user-owned mode `0700`. Tests set it to their temporary directory so even stale-file cleanup stays isolated. This does not change the shared-record protocol or Studio's control-file location.

Before testing the checkout interactively, replace the npm package source with the absolute local repo path and restart Pi. Avoid loading both copies. Restart Pi after changing imported shared JavaScript helpers too: `/reload` can retain those modules in the current Pi/Jiti loader. Leave tmux REPLs running to preserve their state.

## Acknowledgements

Ruby and Java support builds on [Ifiht's contribution in PR #2](https://github.com/omaclaren/pi-repl/pull/2), adapted to the current execution, display and recording machinery.

## Related extensions

[`pi-interactive-shell`](https://github.com/nicobailon/pi-interactive-shell) offers related but distinct functionality for interactive CLI sessions in pi, including overlay-based interaction and user take-over. `pi-repl` is focused specifically on shared tmux-backed REPL sessions.

## License

MIT
