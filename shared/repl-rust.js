// The Rust runtime: evcxr's own REPL in tmux. evcxr has no way to load a cell from
// a file that keeps its variables, so pi-repl pastes the whole cell at evcxr's
// prompt, bracketed, and presses Enter once the pane shows it exactly. It sends
// only when evcxr is waiting at an empty prompt, since input that arrives while a
// cell runs can be lost or put the prompt out of step (fixed in evcxr after 0.22.0).
// A cell has finished when the pane's terminal is back in raw mode, which evcxr's
// line editor (rustyline) sets only while it waits for input, and a prompt follows
// the cell's echo. Nothing else is typed into the pane.
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

/** evcxr's prompt with nothing typed at it. */
export const RUST_PROMPT = /(?:^|\n)>>[ \t]*$/;
/**
 * The session's @pi_repl_send_path. pi-studio pastes into a session, and sends it
 * Ctrl-C, only when that option is unset or "pane", so it leaves this one alone:
 * a Ctrl-C at evcxr's empty prompt arms its exit, and a second one ends evcxr.
 */
export const RUST_SEND_PATH = "pi-repl";
/** The session's private evcxr settings folder, removed when the session is stopped. */
export const RUST_CONFIG_OPTION = "@pi_repl_rust_config";
export const RUST_MAX_CELL_BYTES = 1024 * 1024;
const CONFIG_PREFIX = "pi-repl-rust-";

const quote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;

/** The comment line that starts each pasted cell: it marks the cell as pi's in the pane and anchors it there. */
export function rustCellMarker(anchorId) {
	return `// pi-repl ${anchorId}`;
}

/**
 * The text pasted for a cell: the marker line, then the code with line endings
 * made "\n" and trailing blank lines removed. Throws, sending nothing, if the
 * code holds characters a paste would turn into terminal input.
 */
export function prepareRustCell(code, anchorId) {
	const text = String(code).replace(/\r\n?/g, "\n").replace(/\s+$/, "");
	if (!text.trim()) throw new Error("repl_send requires non-empty code.");
	if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/.test(text)) {
		throw new Error("A Rust cell can't contain control characters other than tabs and line breaks; no code was sent.");
	}
	if (Buffer.byteLength(text) > RUST_MAX_CELL_BYTES) throw new Error("A Rust cell is limited to 1 MiB; no code was sent.");
	return `${rustCellMarker(anchorId)}\n${text}`;
}

/** Whether a pane row is evcxr's prompt, empty or with something typed at it. */
export function isRustPromptRow(line) {
	return /^>>(?: |$)/.test(String(line).trimEnd());
}

/** The pane's rows from this cell's echo on: from the last row showing its marker at the prompt. */
export function rowsFromRustEcho(capture, marker) {
	const lines = String(capture).replace(/\r/g, "").split("\n");
	const echo = `>> ${marker}`;
	const at = lines.findLastIndex((line) => line.trimEnd() === echo);
	return at >= 0 ? lines.slice(at) : undefined;
}

/**
 * Compares pane rows, from the echo's first row on, with the cell's lines, exactly:
 * the first row is ">> " and the marker. tmux's -J capture reproduces the echo as
 * drawn, tabs, spaces, wide text and wrapped lines included, so nothing is
 * normalised. Returns "drawn" with the number of echo rows when every line
 * matches; "partial" while the rows so far match and the first one that doesn't
 * is an unfinished prefix with only blank rows after it; "different" otherwise.
 */
function matchRustEcho(rows, cell) {
	const want = `>> ${cell}`.split("\n");
	for (let i = 0; i < want.length; i++) {
		const got = rows[i];
		if (got === want[i]) continue;
		const unfinished = (got === undefined || want[i].startsWith(got)) && rows.slice(i + 1).every((row) => !row.trim());
		return { state: unfinished ? "partial" : "different", end: i };
	}
	return { state: "drawn", end: want.length };
}

/**
 * How far the pane shows a pasted cell, before Enter: "drawn" when the rows from
 * its echo on are exactly ">> " and the cell, with only blank rows after;
 * "partial" while they are still being drawn; "different" otherwise, as when
 * someone typed at the prompt or changed the cell.
 */
export function rustEchoState(rows, cell) {
	if (!rows) return "partial";
	const echo = matchRustEcho(rows, cell);
	if (echo.state !== "drawn") return echo.state;
	return rows.slice(echo.end).every((row) => !row.trim()) ? "drawn" : "different";
}

/**
 * rustEchoState for the whole pane, as the paste lands. A marker drawn on a row
 * with other text, as after a half-typed line, means the prompt holds more than
 * the cell.
 */
export function rustPasteState(capture, marker, cell) {
	const rows = rowsFromRustEcho(capture, marker);
	if (rows) return rustEchoState(rows, cell);
	return String(capture).includes(marker) ? "different" : "partial";
}

/**
 * Where a submitted cell stands, from the pane's rows from its echo on, by
 * position: "finished" once a prompt row follows the echo, as evcxr draws one only
 * after the cell; "waiting" while only blank rows follow it, which with the
 * terminal in raw mode means evcxr is waiting for more of the cell; "other" when
 * something else follows, such as output, or someone's typing; "unknown" when the
 * echo isn't there as sent.
 */
export function rustCellProgress(rows, cell) {
	if (!rows) return "unknown";
	const echo = matchRustEcho(rows, cell);
	if (echo.state !== "drawn") return "unknown";
	const after = rows.slice(echo.end);
	if (after.some(isRustPromptRow)) return "finished";
	return after.every((row) => !row.trim()) ? "waiting" : "other";
}

/**
 * The completion watcher's decision on one reading: "done", "enter" to pass an
 * unfinished cell to rustc, or "wait". Only raw mode counts, as evcxr can draw its
 * prompt just before it reads input. An Enter is pressed only while the cell's
 * echo is intact with nothing but blank rows after it, so never into someone
 * else's input. Without the echo (scrolled away, or edited), a prompt at the
 * cursor counts once the cell has been seen running (cooked mode).
 */
export function rustWatchStep({ raw, progress, cursorPrompt, sawCooked, waitingMs, extraEnters }) {
	if (!raw) return "wait";
	if (progress === "finished") return "done";
	if (progress === "waiting") return extraEnters < 2 && waitingMs >= (extraEnters ? 400 : 1_000) ? "enter" : "wait";
	return progress === "unknown" && sawCooked && cursorPrompt ? "done" : "wait";
}

/**
 * A finished cell's output: the rows after its echo, up to the last prompt row,
 * which is evcxr's current prompt with whatever is being typed there. Undefined
 * when the rows don't start with the cell's echo.
 */
export function rustCellOutput(rows, cell) {
	if (!rows) return undefined;
	const echo = matchRustEcho(rows, cell);
	if (echo.state !== "drawn") return undefined;
	const after = rows.slice(echo.end);
	const prompt = after.findLastIndex(isRustPromptRow);
	const out = prompt >= 0 ? after.slice(0, prompt) : after;
	while (out.length && !out[out.length - 1].trim()) out.pop();
	while (out.length && !out[0].trim()) out.shift();
	return out.join("\n");
}

/** Whether `stty -a` output shows a terminal in raw (non-canonical) mode. */
export function sttyShowsRawMode(stdout) {
	return /(?:^|\s)-icanon(?:\s|$)/.test(String(stdout));
}

/** `stty` arguments that print a terminal's settings without changing them. */
export function sttyReadArgs(tty, platform = process.platform) {
	return [platform === "linux" ? "-F" : "-f", tty, "-a"];
}

/**
 * A private folder for the session's evcxr settings, and the script that starts
 * evcxr with it. The script copies the person's startup files (init.evcxr,
 * prelude.rs) and history into the folder, so they apply as usual, while the
 * agent's cells are saved to the folder's history, not the person's.
 */
export function createRustLaunch(platform = process.platform) {
	const dir = mkdtempSync(join(tmpdir(), CONFIG_PREFIX));
	chmodSync(dir, 0o700);
	const settings = platform === "darwin" ? "$HOME/Library/Application Support/evcxr" : "${XDG_CONFIG_HOME:-$HOME/.config}/evcxr";
	const script = join(dir, "pi-repl-launch.sh");
	writeFileSync(script, [
		"# pi-repl's Rust session: evcxr with a private settings folder. Your startup files",
		"# and history are copied in; the agent's cells are saved to this folder's history.",
		`dir=${quote(dir)}`,
		`src="\${EVCXR_CONFIG_DIR:-${settings}}"`,
		"for f in init.evcxr prelude.rs history.txt; do",
		'\tif [ -f "$src/$f" ]; then cp -p "$src/$f" "$dir/$f"; fi',
		"done",
		'EVCXR_CONFIG_DIR="$dir" exec evcxr',
		"",
	].join("\n"), { mode: 0o600 });
	return { dir, script, command: `exec /bin/sh ${quote(script)}` };
}

/**
 * Removes a session's settings folder, only if it is one this module made: in the
 * temporary folder, named with its prefix, a real folder owned by this user.
 * Returns whether it was removed.
 */
export function removeRustConfigDir(dir) {
	if (typeof dir !== "string" || !dir || !basename(dir).startsWith(CONFIG_PREFIX)) return false;
	try {
		if (realpathSync(dirname(dir)) !== realpathSync(tmpdir())) return false;
		const stat = lstatSync(dir);
		if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) return false;
		rmSync(dir, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}
