// The Node script a REPL wrapper runs to learn the pane's cursor column, so
// that it ends a line before its footer only when output stopped mid-line. It
// prints the column, or exits non-zero; tmux gets 500 ms. process.exit ends
// Node even if a startup hook in NODE_OPTIONS would keep it running. Only the
// wrapper reads its output, so it never reaches the pane.
export const CURSOR_COLUMN_QUERY = 'let code = 1; try { require("node:fs").writeSync(1, require("node:child_process").execFileSync("tmux", ["-N", "display-message", "-p", "-t", process.env.TMUX_PANE, "#{cursor_x}"], { encoding: "utf8", timeout: 500, killSignal: "SIGKILL", maxBuffer: 128, stdio: ["ignore", "pipe", "ignore"] }).trim()); code = 0; } catch {} process.exit(code);';

const shellQuote = (value) => `'${value.replace(/'/g, `'"'"'`)}'`;

/**
 * A command that runs the query under /bin/sh, whatever the caller's shell
 * (MATLAB's system() uses $SHELL), and kills the helper after 5 s, for
 * runtimes whose own process call can't be bounded (Octave and MATLAB
 * system()). The column passes through a temporary file, so a child the
 * helper leaves behind can't hold the caller's pipe open. The shell's own
 * messages, such as the one for the killed watchdog, are discarded.
 */
export function boundedCursorColumnCommand(nodePath) {
	const script = [
		"exec 2>/dev/null",
		"f=$(mktemp) || exit 1",
		`${shellQuote(nodePath)} -e ${shellQuote(CURSOR_COLUMN_QUERY)} >"$f" 2>/dev/null </dev/null & p=$!`,
		'(sleep 5; kill -9 "$p") >/dev/null 2>&1 </dev/null & w=$!',
		'wait "$p"; s=$?',
		'kill "$w" 2>/dev/null',
		'cat "$f"; rm -f "$f"',
		'exit "$s"',
	].join("; ");
	return `/bin/sh -c ${shellQuote(script)}`;
}
