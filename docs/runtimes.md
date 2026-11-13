# Runtime notes

Each runtime takes submitted code in its own way, so that it runs in the same workspace as what you type in the terminal. These notes say what each runtime needs, how code is submitted and what to expect. The [README](../README.md) covers what the runtimes have in common, and [How pi-repl works](details.md) covers the record, the pane display and stopping.

## Python and IPython

Python and IPython share the `pi-repl-python` session: requesting the other interpreter while one is running keeps the one already running and reports the difference. `/repl env` shows which interpreter and environment the session is using; it's implemented for Python and IPython only. In plain Python, `print(...)` is the safest way to get values back.

## Haskell (GHCi)

Use normal interactive syntax, such as `let` bindings or `:{ ... :}` blocks for multiline declarations.

GHCi shows only the initial `:script` command. Three private scripts separate user source, an intermediate guard, and the outer completion driver. An unfinished `:{ … :}` block can stop a single nested driver; the guard absorbs that script failure so the outer driver still reaches completion. User source is not repaired or rewritten, queued user commands still finish first, and all three files remain private and retained until execution settles. GHCi control paths cannot contain line breaks.

## Clojure

Use normal interactive syntax, such as `let`, `def`/`defn`, or `do` forms for multiline code.

## Ruby and Java

Ruby requires `irb` on PATH. Submissions evaluate in the active IRB workspace, so variables and definitions are shared between agent sends and code you type directly. The last non-`nil` result is printed. A one-use IRB echo check suppresses only the loader's redundant `nil` result, restoring the original check before returning; manual expressions, manual `nil`, and the configured echo preference behave normally. User-printed `=> nil` text remains output. Source, paths and previews are encoded without prematurely expanding Ruby interpolation.

Java requires a JDK with `jshell` on PATH. Submissions use JShell's native `/open` command: imports, variables, methods and classes remain available across sends and direct terminal input. **Use `System.out.println(...)` for visible results**; `/open` executes bare expressions but does not echo their values. For example:

```java
int count = 41;
System.out.println(count + 1);
```

Java uses one outer driver file to load the source and then signal completion. The source remains in a separate private file so malformed input cannot swallow the driver's completion step, while the pane shows only the initial `/open` command. JShell control paths can contain spaces and quotes, but not line breaks. Submit complete snippets: JShell can reject or discard unfinished input rather than continue it in a later send. Evaluation is not transactional—valid snippets can run even if another snippet fails. JShell commands such as `/reset` and `/exit` change or end the live session; use them deliberately.

Both runtimes support the same private logs, clean records, exports, Summary/Off/Full displays, and timeout/abort lease handling as the existing runtimes. As with the other REPLs, wait for a normal prompt before sending code; do not send while a person is entering an unfinished interactive expression.

Ruby's one-use echo check preserves an existing singleton `echo?` method as well as ordinary IRB settings. If an unusual customised or frozen context refuses the hook, the wrapper keeps normal IRB behaviour rather than failing the submission.

## Octave and MATLAB

Octave requires `octave-cli` on PATH and starts with `--quiet --interactive`, turning off Octave's workspace dump on SIGHUP and SIGTERM so that stopping the session leaves no `octave-workspace` file behind. MATLAB requires a licensed installation with `matlab` on PATH; it starts with `-nodesktop -nosplash -sd <Pi working directory>`. These are separate persistent terminal sessions, not connections to an existing MATLAB desktop. Startup can take longer for MATLAB: request `repl_start` with `timeoutMs: 120000` if needed, and check `ready` before sending code.

Code evaluates in the **base workspace**, shared with direct terminal input. Variables, native semicolon/`ans` behaviour, working-directory changes and search-path changes persist. For example, either runtime can run:

```matlab
A = [2 1; 1 2];
disp(eig(A));
```

Send complete snippets. Run existing scripts or call functions on the current path; MATLAB function definitions belong in `.m` files rather than an `eval` submission. Syntax/runtime errors are printed and later sends can recover, but execution is not transactional: earlier effects are not undone. The completion guard lives outside the base workspace, so `clear`, `clear all`, `return` and Ctrl-C do not remove it. Clearing variables and ending the runtime with `exit` or `quit` are still deliberate state-changing actions. An exit may complete its guard before the pane closes, or be reported as a session-ended error.

A private `.m` driver loads the code and records completion without adding helper variables or changing `ans` in the base workspace. Unicode, quoting and line breaks are encoded safely. Both runtimes use the existing records, exports, Summary/Off/Full displays, retained timeout/abort controls, and verified explicit stop. They recognise the ordinary `octave:N>` and `>>` prompts; custom/debugger prompts are not treated as ready. This adds runtime support to `pi-repl`, not new MATLAB/Octave controls to `pi-studio`.

Graphics retain the runtime's normal behaviour and installed backends. Figures are not captured automatically. Export explicitly when needed, for example `print(gcf, 'figure.png', '-dpng')`. Headless Octave graphics depend on an appropriate toolkit; `octave-cli` does not repair a missing or broken Qt installation.

## gnuplot

gnuplot requires `gnuplot` on PATH. `/repl gnuplot` starts it through your normal interactive login shell, with its own `pi-repl-gnuplot` session. It is not a plotting backend for another REPL. Startup files, terminal selection, output destinations and plotting preferences retain their native behaviour; the extension does not add `-persist` or choose a graphics backend.

Variables, functions, data blocks and plotting state are shared with direct terminal input. For example:

```gnuplot
a = 0.2
f(x) = exp(-a*x)*sin(5*x)
plot [0:20] f(x)
```

Change `a` directly in the attached terminal, then ask Pi to `replot` in gnuplot. Use `print` for console values; a user-selected `set print` destination is respected, so an empty tool result can be normal. Figures are not captured automatically. Export explicitly when wanted, selecting an installed file terminal and closing its output file afterwards. For example, with no output file currently open:

```gnuplot
set term push
set term svg size 640,360
set output 'figure.svg'
replot
unset output
set term pop
```

Submit complete native scripts. Commands run via `load`, not expression-by-expression emulation. Earlier effects survive a later error; syntax errors, nested load failures and Ctrl-C return control without resetting variables or settings. In a loaded script, `exit`/`quit` returns from that script; **`exit gnuplot` ends the process**. `reset` and `reset session` deliberately change state. Interactive waits such as `pause -1` remain genuine waits for the person at the terminal; do not request them accidentally.

A private `.gp` source and acknowledgment guard run through a short-lived Node pipe producer (`.cjs`). The producer uses pipe closure to detect native error/interrupt unwinding, rather than guessing from a prompt or queuing completion commands into terminal input. It does not introduce gnuplot helper variables or alter `set print`, terminal/output/table settings, or native error status. Display markers go to the terminal's stderr independently of `set print`. Paths support Unicode, quotes and shell metacharacters, but not line breaks or NUL bytes. Source/guard/driver files remain private and retained with the send lease through timeout/abort until completion or the exact session ends.

The normal `gnuplot>` prompt is recognised for startup readiness. Native graphics require a working installed terminal/backend; no backend repair or automatic window capture is performed. This support is in `pi-repl`, not new gnuplot controls in `pi-studio`.

New sessions inherit a random `PI_REPL_GNUPLOT_OWNER` launch marker, recorded separately in tmux as `@pi_repl_gnuplot_owner`. Qt deliberately detaches its helper and can keep windows alive after losing the interpreter connection. The marker lets explicit stop attribute that helper even after detachment, with the usual UID, process-birth and protected-pane checks. It changes no plotting settings, plugin paths, temporary-directory choices or startup files. Existing sessions are never retrofitted or restarted: without valid ownership metadata, stop warns that detached-helper cleanup cannot be verified and does not guess ownership.

On macOS, inspecting detached helpers requires an existing `python3` (isolated, standard-library-only native process inspection); Linux uses `/proc`. No unrelated environment values are returned. `lsof` identifies the helper's open socket files. After verified process exit, cleanup removes only unchanged, same-owner socket inodes with no remaining same-user process references; unavailable inspection or changed/in-use files produce a warning instead of deletion. Nothing is installed automatically.

Custom launchers must preserve the reserved marker. Do not copy it or manually share a marked Qt helper between sessions that need independent stops: the helper belongs to its creating session. External widgets, marker-stripping launchers and other untracked detached processes require manual management. Native `exit gnuplot`/persist behaviour is unchanged; helper cleanup runs only on an explicit `/repl stop`.

## C++ (experimental)

`cpp` is **a Cling-based C++ REPL**, with its own `pi-repl-cpp` session. Cling and its matching development headers must already be available through your normal interactive-login-shell command `cling`. No compiler installation, ROOT/Jupyter stack, alternate-install search or runtime substitution is performed. Native testing currently covers Cling 1.3 on ARM64 macOS; other builds and Linux remain unverified.

The tested ARM64 Sonoma Homebrew bottle retains a stale build-time resource path, even though ordinary code may still run. A user-configured `cling` launcher can invoke `<Cling prefix>/libexec/bin/cling` with `-resource-dir=<Cling prefix>/libexec/lib/clang/20` (the bottle's installed LLVM 20 resources), forwarding the original arguments. This corrects the startup diagnostic without patching the interpreter. Keep that configuration in your launcher, not in pi-repl; the extension does not repair runtimes or search for another installation.

```cpp
int count = 41;
int next_count(int n) {
  return n + 1;
}
printf("%d\n", next_count(count));
```

Submit **native C++ prompt groups**, not arbitrary translation units. Put a function's opening brace on its declaration line, as above: Cling's continuation rules decide how lines are grouped. Load ordinary definition/header files with `#include "my-definitions.hpp"` instead; these may use normal file formatting. Globals, objects, includes, loaded libraries and direct terminal edits persist in the same interpreter. Agent submissions reject Cling dot commands as C++; direct-terminal `.L`, `.q` and other native commands retain their normal behaviour. Use `/repl stop cpp` for managed shutdown.

Each send uses a private source (`.cpp`), length-framed request (`.req`) and ordinary definition/initializer driver (`.hxx`). One include is sent to the terminal; no completion command follows it into stdin. The in-session helper calls Cling's own `InputValidator` and `Interpreter::process`, catches C++ exceptions, and publishes a private correlated reply only after evaluator return and helper-local destruction. It neither wraps user declarations in its own function nor replays previous cells. The helper's reserved namespace is `pi_repl_cpp_v1`; do not redefine it or undo its declarations.

Earlier complete groups can execute before a later compile/link error or incomplete group. There is no transaction, rollback or automatic recovery from native undefined behaviour. `cppResult` in tool details reports native return (`0`), failure (`1`), incomplete input (`2`), standard/other C++ exception (`3`/`4`), or source/control I/O failure (`5`). A captured record is an output capture, not proof of successful computation: for example, a PETSc error return may coexist with `cppResult: 0`. Native diagnostics are retained.

Timeout and cancellation stop waiting, **not execution**. Controls and the send lease remain until a valid reply or the exact session ends; prompts and displayed markers cannot release them. `fgets`/`getline` remain real terminal reads—supply human input deliberately. Exit, crashes and busy Ctrl-C can destroy the workspace; there is no silent restart. If incompatible headers or a damaged helper prevent a reply, inspect the raw diagnostics and explicitly stop the session rather than send more code. Changed control files are left untouched during cleanup. With tmux `remain-on-exit`, a verified dead pane releases the send lease but its tmux session remains present; further sends are refused. The existing stop ownership checks can also refuse an already-dead pane whose runtime owner no longer exists—inspect/remove that retained pane manually rather than weakening ownership checks.

Summary/Full previews do not truncate execution; Off suppresses optional displays. Source is limited to 16 MiB per send (oversized input is rejected, never truncated). Control/include paths support Unicode, spaces and quotes, but not control characters/line breaks/NUL, or a path containing both `"` and `>`. The existing Node executable supplies a bounded cursor query for output spacing, including Off mode; streams and destinations are not replaced.

PETSc is optional, not a package dependency. The optional regression uses a matching real-double/int32 PETSc/MPI installation in one process/rank, retaining the same `Mat`, `Vec` and `KSP` objects through direct edits, compilation errors and library errors, then destroying/finalizing explicitly. Match architecture, MPI and scalar/integer configuration; multi-rank submission and collectives are untested. Do not reinitialize MPI after finalization.

## Rust (experimental)

`rust` is evcxr's own REPL, `evcxr` (from `cargo install evcxr_repl`), with its own `pi-repl-rust` session. evcxr compiles each cell with your Rust toolchain, so a cell takes a second or so, and the first one longer. It has been tested with evcxr 0.22.0 and with evcxr's `main` at 656cd7a, on ARM64 macOS; Linux is untested.

```rust
let count = 41;
fn next_count(n: i32) -> i32 {
    n + 1
}
next_count(count)
```

evcxr can't load a cell from a file and keep its variables, so pi-repl pastes each of Pi's cells whole at evcxr's prompt, bracketed, under a `// pi-repl <id>` comment line that marks it as Pi's. It sends only when evcxr is waiting at an empty prompt: the pane's terminal is in raw mode, which evcxr's line editor sets only while it waits for input, and the cursor's row is the prompt with nothing typed. Otherwise nothing is sent, and the result says whether a cell is running or something is typed. pi-repl presses Enter once the pane shows exactly the cell; if someone typed at the prompt as the paste landed, it leaves the paste unrun in the prompt's input and says so. A cell has finished when the terminal is back in raw mode with a prompt at the cursor. Nothing else is typed into the pane.

evcxr commands such as `:dep` and `:vars`, and `!` shell commands, work in a cell. A cell evcxr takes as unfinished, such as `fn f() {` without its closing brace, would leave evcxr waiting for the rest of it. pi-repl then presses Enter twice more, which makes evcxr pass the cell to rustc as it is, and rustc reports what's wrong; the result's last line says pi-repl did this.

Some limits come from evcxr:

- In evcxr 0.22.0, input that arrives while a cell runs, typing included, can be lost or leave the prompt one input behind. Don't type while a cell runs. The fix is on evcxr's `main` ([evcxr#526](https://github.com/evcxr/evcxr/pull/526), with rustyline 19) for its next release.
- Output from `print!` without a newline, or from a thread still running when its cell ends, can appear under a later cell.
- A cell that reads stdin waits for input typed in the pane.
- Ctrl-C during a cell, or `std::process::exit`, ends evcxr's worker process and loses the session's variables; evcxr carries on with an empty workspace, and nothing is replayed. A panic keeps them.
- Ctrl-C at an empty prompt arms evcxr's exit, and a second Ctrl-C in a row ends evcxr. pi-repl never sends Ctrl-C, and the session's `@pi_repl_send_path` keeps Pi Studio from pasting into it or sending it Ctrl-C.

evcxr runs with a private settings folder (`EVCXR_CONFIG_DIR`) in the temporary folder. When the session starts, it copies your `init.evcxr`, `prelude.rs` and `history.txt` into the folder, from `EVCXR_CONFIG_DIR` if you set it and from evcxr's usual folder otherwise, so your startup files apply and your history is there to recall. What is run in the session, Pi's cells included, is saved to the folder's history, not yours. `/repl stop rust` removes the folder; if evcxr exits on its own, the folder is left in the temporary folder.

Pi's cells are in the session's clean record, as the other runtimes' sends are, each with the output evcxr printed before its next prompt. Echo modes don't apply, since the pane shows each of Pi's cells in full.

## LFortran sessions (experimental)

`lfortran` shares one LFortran session between you and pi. It needs a build of LFortran's `main` branch with the shared session (`lfortran --connect` and `lfortran kernel --managed`), found as `lfortran` by your interactive login shell; no LFortran release has it yet. It has been tested with `main` at `edf73189fc` on ARM64 macOS.

`/repl lfortran`, or `repl_start` with `runtime: "lfortran"`, starts the `pi-repl-lfortran` tmux session. Its first window is LFortran's own prompt, `lfortran --connect`, where you work. The second runs pi-repl's helper, which starts LFortran's Jupyter kernel and sends pi's cells to it over its own connection, so nothing is pasted into your prompt. Your cells and pi's run in the same kernel and share variables and procedures:

```fortran
integer :: n = 41
print *, n + 1
```

Send complete Fortran: declarations, statements, or whole program units. The kernel runs one cell at a time, and pi-repl refuses to send a cell while one it sent is unresolved. Each result gives the cell's status from the kernel and its output. A send's timeout stops waiting, not the cell; `repl_status` with `target: "lfortran"` and the result's execution ID follows it. Your prompt shows pi's cells, marked `[other client]`, when you next press Enter there ([lfortran/lfortran#16303](https://github.com/lfortran/lfortran/issues/16303)).

When one of pi's cells reaches a READ, the result says so. Pi answers it with `repl_input`, and you can answer it from Pi with `/repl input <text>`; the text is sent as given, spaces included. pi-repl doesn't write answers to its files, but they go through Pi's conversation, so don't use them for secrets.

Some limits come from LFortran as it is now:

- A runtime error in any cell, such as an out-of-bounds index or `error stop`, ends the session for everyone.
- A cell's output arrives when the cell ends, not while it runs ([lfortran/lfortran#16182](https://github.com/lfortran/lfortran/issues/16182)).
- Nothing can interrupt a running cell ([lfortran/lfortran#16183](https://github.com/lfortran/lfortran/issues/16183)). Ctrl-C at your prompt during a cell ends your prompt but not the session; `/repl status lfortran` gives the command to rejoin.

And some features of the other runtimes aren't there yet:

- Cells you run at your prompt aren't in the clean record, as typing into the other runtimes' panes isn't. So the agent can't be told of them: it isn't shown your prompt's pane, and what it's told of the record can't include them.
- Echo modes don't apply: your prompt shows each of pi's cells in full.
- pi-studio lists the session but doesn't send to it. Its Interrupt sends Ctrl-C to your prompt.

The cells sent through pi-repl, the agent's and `/repl send lfortran`'s, are in the session's clean record, as the other runtimes' sends are. Each entry is `sent` until the cell finishes, then `captured`, or `error` if its outcome couldn't be confirmed. A cell that failed keeps its output, with a last line saying so. The agent is told of other clients' cells, such as another conversation's `/repl send lfortran` or `agent-repl send lfortran`, as of the other runtimes' sends ([details](details.md#record-entries)). `/repl status lfortran` shows where the record is, and `/repl export lfortran` writes it as Markdown.

`/repl stop lfortran` ends your prompt, the helper and the kernel, and checks that they have exited, which discards the session's state for everyone. On macOS the check needs an existing `python3`, as gnuplot's stop does.
