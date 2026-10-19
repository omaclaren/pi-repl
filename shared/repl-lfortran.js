import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { createPrivateReplHistoryFile } from "./repl-history.js";

// LFortran started with `--status-file PATH` writes one JSON line to PATH as
// each cell finishes, after the cell's output: {"cell": 3, "status": "error"}.
// The session's file is recorded in this tmux option when pi-repl starts it.
export const LFORTRAN_STATUS_OPTION = "@pi_repl_lfortran_status_path";
export const LFORTRAN_STATUS_MAX_BYTES = 16 * 1024 * 1024;

function privateStat(path, directory = false) {
	const s = lstatSync(path, { bigint: true });
	if (!(directory ? s.isDirectory() : s.isFile()) || s.isSymbolicLink()
		|| s.uid !== BigInt(process.getuid()) || (s.mode & 0o777n) !== (directory ? 0o700n : 0o600n)
		|| (!directory && s.nlink !== 1n)) throw new Error(`Unsafe LFortran status path: ${path}`);
	return s;
}

/** A private, empty status file for a new session, next to its raw history log. */
export function createLfortranStatusFile(sessionName, root) {
	return createPrivateReplHistoryFile(sessionName, root, "status.jsonl");
}

// A Fortran character constant, in which a doubled quote stands for itself.
// The prompt's editor drops characters outside ASCII as they are typed.
export function lfortranInclude(path) {
	if (/[\x00-\x1f\x7f\u2028\u2029]/.test(path)) throw new Error("LFortran include paths cannot contain control characters, line breaks or NUL bytes.");
	if (/[^\x20-\x7e]/.test(path)) throw new Error("LFortran's prompt drops characters outside ASCII, so its control path must be ASCII; no code was sent.");
	return `include '${path.replace(/'/g, "''")}'`;
}

// The editor draws only the part of a long line that fits its row, and then
// no cursor position: such a row is the echo cut short.
export function isLfortranEchoPrefix(row, submissionLine) {
	const text = row.trimEnd();
	return text.length >= ">>> include '".length && `>>> ${submissionLine}`.startsWith(text);
}

// Complete lines only: LFortran ends each line with a newline, so a line
// without one is still being written. Unreadable or unsafe files read as
// undefined.
function readStatusLines(statusFile) {
	let fd;
	try {
		privateStat(dirname(statusFile), true);
		const before = privateStat(statusFile);
		if (before.size > BigInt(LFORTRAN_STATUS_MAX_BYTES)) return undefined;
		fd = openSync(statusFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const opened = fstatSync(fd, { bigint: true });
		if (opened.dev !== before.dev || opened.ino !== before.ino) return undefined;
		const buffer = Buffer.alloc(Number(opened.size));
		const count = readSync(fd, buffer, 0, buffer.length, 0);
		const lines = buffer.subarray(0, count).toString("utf8").split("\n");
		lines.pop();
		return lines;
	} catch { return undefined; }
	finally { if (fd !== undefined) closeSync(fd); }
}

/** Remembers how many cells had finished before this submission. */
export function prepareLfortranSubmission(statusFile) {
	const lines = readStatusLines(statusFile);
	if (!lines) throw new Error("The LFortran session's status file cannot be read safely; no code was sent.");
	return { statusFile, offset: lines.length };
}

// The first line written after the submission. A malformed line leaves it
// pending, as a missing one does. The line carries no input, so a cell typed
// at the terminal that was still running when this one was sent would be
// taken for it; keys typed while this one runs wait for it to finish.
export function readLfortranCompletion(completion) {
	const lines = readStatusLines(completion.statusFile);
	if (!lines || lines.length <= completion.offset) return undefined;
	try {
		const value = JSON.parse(lines[completion.offset]);
		if (Number.isInteger(value?.cell) && value.cell > 0 && (value.status === "ok" || value.status === "error")) {
			return { cell: value.cell, status: value.status };
		}
	} catch { /* Pending, like a missing line. */ }
	return undefined;
}

// The input editor draws the cursor position at the right edge of the prompt
// row, as in `>>> x = 1        1,6   ]`.
export const LFORTRAN_PROMPT = /^>>>(?:\s+\d+,\d+\s+\])?\s*$/;
export function stripLfortranEditorPosition(text) {
	return text.replace(/^\s+\d+,\d+\s+\]/, "");
}
