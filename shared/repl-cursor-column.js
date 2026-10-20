// The Node script a REPL wrapper runs to learn the pane's cursor column, so
// that it ends a line before its footer only when output stopped mid-line. It
// prints the column, or exits non-zero; tmux gets 500 ms. process.exit ends
// Node even if a startup hook in NODE_OPTIONS would keep it running. Only the
// wrapper reads its output, so it never reaches the pane.
export const CURSOR_COLUMN_QUERY = 'let code = 1; try { require("node:fs").writeSync(1, require("node:child_process").execFileSync("tmux", ["-N", "display-message", "-p", "-t", process.env.TMUX_PANE, "#{cursor_x}"], { encoding: "utf8", timeout: 500, killSignal: "SIGKILL", maxBuffer: 128, stdio: ["ignore", "pipe", "ignore"] }).trim()); code = 0; } catch {} process.exit(code);';

const shellQuote = (value) => `'${value.replace(/'/g, `'"'"'`)}'`;

/**
 * A command that runs the query under /bin/sh, whatever the caller's shell
 * (MATLAB's system() uses $SHELL), for runtimes whose own process call can't
 * be bounded (Octave and MATLAB system()). Perl's alarm outlives its exec, so
 * it stops the helper itself after 5 s, with no process ID to reuse and no
 * watchdog left behind. The column passes through a temporary file, so a
 * child the helper leaves behind can't hold the caller's pipe open; the file
 * is removed even when the script is interrupted. The shell's messages are
 * discarded, and it exits only 0 or 1, so the caller never prints a signal
 * status. Without perl, exec fails and it exits 1.
 */
export function boundedCursorColumnCommand(nodePath) {
	const script = [
		"exec 2>/dev/null",
		"f=$(mktemp) || exit 1",
		// Ctrl-C reaches this shell too; the file goes either way.
		`trap 'rm -f "$f"' EXIT`,
		"trap 'exit 1' HUP INT TERM",
		`perl -e 'alarm shift; exec @ARGV or exit 1' 5 ${shellQuote(nodePath)} -e ${shellQuote(CURSOR_COLUMN_QUERY)} >"$f" </dev/null`,
		"s=$?",
		'cat "$f"',
		'[ "$s" = 0 ]',
	].join("; ");
	return `/bin/sh -c ${shellQuote(script)}`;
}
