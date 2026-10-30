// The helper process of a shared session whose runtime is a Jupyter kernel,
// such as LFortran's (design: one helper per session, in the session's tmux).
// It starts the kernel as its own child, holds pi-repl's only Jupyter
// connection to it, and serves local clients (Pi, agent-repl, /repl commands)
// over a private Unix socket with JSON lines. It owns every execution and
// READ, so that they survive any client leaving; nothing is ever replayed.
//
//   PI_REPL_JUPYTER_OWNER=<32 hex> node repl-jupyter-helper.js --dir DIR --lfortran /abs/path/to/lfortran
//
// DIR is new for each launch, and the helper claims it before anything else.
// It holds k.json (the connection file), h.sock, ready.json, kernel.log,
// helper.pid, kernel.pid and output spools, and record.json, which the starter
// writes: where the session's shared clean record is, for the helper's entries.
// The helper runs until it is signalled; when the kernel ends it stays, to report.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, closeSync, constants, createWriteStream, fstatSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { JupyterClient, readConnectionFile } from "./repl-jupyter.js";
import { isValidReplSessionRecordId, recordEntryKey } from "./repl-session-record.js";

export const HELPER_PROTOCOL_VERSION = 1;
export const HELPER_FILES = { connection: "k.json", socket: "h.sock", ready: "ready.json", kernelLog: "kernel.log", pid: "helper.pid", kernelPid: "kernel.pid" };
// Written by the starter, before the helper claims DIR, and only read by the helper.
export const RECORD_FILE = "record.json";
const MAX_RECORD_FILE_BYTES = 64 * 1024;
const RECORD_WORKER = new URL("./repl-record-worker.js", import.meta.url);

/**
 * A small file of this user's in a private directory, read without following a
 * link or blocking: only a regular file with one link, of at most `maxBytes`.
 */
export function readPrivateFile(path, maxBytes) {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1) throw new Error(`${path} isn't a regular file of this user's with one link`);
		if (stat.size > maxBytes) throw new Error(`${path} is larger than ${maxBytes} bytes`);
		const buffer = Buffer.alloc(stat.size);
		const size = readSync(fd, buffer, 0, buffer.length, 0);
		return buffer.subarray(0, size).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/**
 * DIR/record.json, validated: { recordId, root, identity, owner }, written by
 * the starter for the launch whose owner marker is `owner`. Throws why not.
 */
export function readRecordFile(path, owner) {
	const read = JSON.parse(readPrivateFile(path, MAX_RECORD_FILE_BYTES));
	const identity = read?.identity;
	if (!isValidReplSessionRecordId(read?.recordId) || typeof read.root !== "string" || !read.root.startsWith("/")
		|| !identity || typeof identity.sessionName !== "string" || !/^\$\d+$/.test(identity.tmuxSessionId) || !Number.isSafeInteger(identity.tmuxSessionCreatedAt)) {
		throw new Error("it doesn't name a usable shared record");
	}
	if (read.owner !== owner) throw new Error("it was written for another launch");
	return { recordId: read.recordId, root: read.root, owner, identity: { sessionName: identity.sessionName, tmuxSessionId: identity.tmuxSessionId, tmuxSessionCreatedAt: identity.tmuxSessionCreatedAt, runtime: "lfortran" } };
}
const MAX_REQUEST_LINE_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_LINE_BYTES = 64 * 1024 * 1024;
const MAX_CODE_BYTES = 16 * 1024 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_CLIENT_BACKLOG_BYTES = 32 * 1024 * 1024;
const MAX_REQUESTS_IN_FLIGHT = 8;
const MAX_CONNECTIONS = 64;
const MAX_CLIENT_PENDING = 64;
const MAX_WAIT_MS = 10 * 60 * 1000;
const MAX_KERNEL_LOG_BYTES = 1024 * 1024;
const MAX_JOURNAL_TEXT = 64 * 1024;
const MAX_JOURNAL_FIELD = 256;
const MAX_JOURNAL_EVENT_BYTES = 256 * 1024;
const MAX_JOURNAL_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_SUBMISSIONS = 100_000;
const MAX_WARNINGS = 20;
// A longer line without a break is ended, so that one line can't grow without bound.
const MAX_LINE_CHARS = 1024 * 1024;
// A longer unfinished escape sequence isn't a real one; it is dropped.
const MAX_ESCAPE_CHARS = 64;
// Spool bytes accepted but not yet written, across a helper's executions.
const MAX_SPOOL_PENDING_BYTES = 64 * 1024 * 1024;
const RETAIN = { executions: 200, bytes: 64 * 1024 * 1024, spoolBytes: 512 * 1024 * 1024 };
const TERMINAL_STATES = new Set(["completed", "unconfirmed", "not-sent"]);
const REPLY_STATUSES = new Set(["ok", "error", "aborted"]);
const SUBMISSION_ID = /^[A-Za-z0-9_-]{8,128}$/;
// A shared-record request ID, as the other runtimes' sends use (`tool:<id>`, `command:send:<uuid>`):
// any text the record keeps whole. Its entry's key is derived from it (recordEntryKey).
const RECORD_REQUEST_ID = /^[^\r\n\0]{1,300}$/;
const RECORD_MODES = new Set(["agent", "raw", "literate"]);
const HEX_ID = /^[0-9a-f]{32}$/;

const randomId = () => randomBytes(16).toString("hex");
const byteLength = (value) => Buffer.byteLength(value, "utf8");
const hashCode = (code) => createHash("sha256").update(code, "utf8").digest("hex");
// A message that is larger than this has the current line copied off it, so that a short line doesn't keep it alive.
const DETACH_AFTER_CHARS = 64 * 1024;

/** The text of a value from a message, which can be anything JSON holds; never throws. */
function toText(value) {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	try {
		return String(value);
	} catch {
		return "[unprintable]";
	}
}

/**
 * A copy of `text` with storage of its own. V8 can back a slice, or a string
 * parsed out of a message, by the whole original, which a kept prefix would
 * then keep alive. UTF-16 keeps every code unit, unpaired surrogates too.
 */
const detach = (text) => Buffer.from(text, "utf16le").toString("utf16le");

const clip = (value, max = MAX_JOURNAL_FIELD) => {
	const text = toText(value);
	return detach(text.length > max ? text.slice(0, max) : text);
};

/** Whether anything is at `path`, a dangling symbolic link included. */
function pathExists(path) {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

/** The largest n' <= n at which `bytes` can be cut without splitting a UTF-8 character. */
function utf8Boundary(bytes, n) {
	if (n >= bytes.length) return bytes.length;
	while (n > 0 && (bytes[n] & 0xc0) === 0x80) n--;
	return n;
}

/** At most `max` bytes of `text`, cut between characters. */
function sliceBytes(text, max) {
	const bytes = Buffer.from(text, "utf8");
	return bytes.subarray(0, utf8Boundary(bytes, max)).toString("utf8");
}

export class HelperRequestError extends Error {
	constructor(code, message, details = {}) {
		super(message);
		this.code = code;
		this.details = details;
	}
}

/**
 * Splits a byte stream into lines, each bounded in bytes. `push` gives the
 * complete lines a chunk ends, and `overflow` once a line, complete or not, is
 * over the bound; the lines before it are still given.
 */
export class LineReader {
	constructor(maxLineBytes) {
		this.maxLineBytes = maxLineBytes;
		this.parts = [];
		this.length = 0;
	}

	push(chunk) {
		const lines = [];
		let start = 0;
		let newline;
		while ((newline = chunk.indexOf(10, start)) >= 0) {
			if (this.length + newline - start > this.maxLineBytes) return this.overflow(lines);
			this.parts.push(chunk.subarray(start, newline));
			lines.push(Buffer.concat(this.parts).toString("utf8"));
			this.parts = [];
			this.length = 0;
			start = newline + 1;
		}
		if (start < chunk.length) {
			this.length += chunk.length - start;
			if (this.length > this.maxLineBytes) return this.overflow(lines);
			this.parts.push(chunk.subarray(start));
		}
		return { lines, overflow: false };
	}

	overflow(lines) {
		this.parts = [];
		this.length = 0;
		return { lines, overflow: true };
	}
}

/**
 * The record that answers an input_request: exactly one trailing LF or CRLF
 * is removed; any other CR, LF or end-of-transmission (\x04) is refused, so
 * that one answer is always one record and never end of file. Spaces are
 * kept, and empty text is an empty record.
 */
export function normalizeInputText(text) {
	if (typeof text !== "string") throw new HelperRequestError("invalid-input", "Input text must be a string.");
	let value = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
	if (/[\r\n\x04]/.test(value)) throw new HelperRequestError("invalid-input", "Input is one record: no line breaks (other than one at the end) and no \\x04.");
	if (byteLength(value) > MAX_INPUT_BYTES) throw new HelperRequestError("invalid-input", "Input text is too long.");
	return value;
}

// Terminal output, as a pane would show it: a carriage return goes back to the
// line's start, and later text overwrites it; erase-in-line (CSI K) erases;
// SGR and other escape sequences are removed. A sequence that a message
// boundary splits is held until the next message, within a bound.
const TOKENS = /\x1b\[([0-?]*)[ -/]*([@-~])|\x1b[^[\r\n]?|\r\n|\n|\r/g;
const PARTIAL_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*)?$/;
const RELEASE_MATCH = /^/;

/**
 * Received output of one execution: cleaned text, bounded in memory, and a
 * spool file of up to `maxSpoolBytes`. The spool is `full` only once it has
 * been written completely, uncapped; `onSpool` hears when it finishes or fails.
 * Kept text is copied off the messages it came from, so that the memory bound
 * holds for what is actually retained.
 */
export class OutputBuffer {
	constructor({ maxMemoryBytes = 4 * 1024 * 1024, spoolPath, maxSpoolBytes = 64 * 1024 * 1024, spoolBudget, onSpool = () => {} } = {}) {
		this.lines = [];
		this.memoryBytes = 0;
		this.maxMemoryBytes = maxMemoryBytes;
		this.line = "";
		this.column = 0;
		this.held = "";
		this.skipping = false;
		this.truncated = false;
		this.receivedBytes = 0;
		this.spoolPath = spoolPath;
		this.maxSpoolBytes = maxSpoolBytes;
		this.spoolBudget = spoolBudget ?? { pending: 0, max: MAX_SPOOL_PENDING_BYTES };
		this.onSpool = onSpool;
		this.spooledBytes = 0;
		this.writtenBytes = 0;
		this.spool = null;
		this.spoolState = null;
		this.capped = false;
		this.incomplete = false;
		this.closed = false;
	}

	/** Adds stream text, in arrival order. */
	write(text) {
		const value = toText(text);
		this.receivedBytes += byteLength(value);
		let data = this.held + value;
		this.held = "";
		if (this.skipping) {
			// The rest of a sequence that was too long to hold, up to its final byte.
			data = data.slice(/^[0-?]*[ -/]*/.exec(data)[0].length);
			if (data) {
				this.skipping = false;
				if (/^[@-~]/.test(data)) data = data.slice(1);
			}
		}
		const partial = PARTIAL_ESCAPE.exec(data);
		if (partial) {
			data = data.slice(0, partial.index);
			if (partial[0].length <= MAX_ESCAPE_CHARS) this.held = detach(partial[0]);
			else this.skipping = true;
		}
		TOKENS.lastIndex = 0;
		let at = 0;
		let token;
		while ((token = TOKENS.exec(data))) {
			if (token.index > at) this.put(data.slice(at, token.index));
			this.control(token[0], token[1], token[2]);
			at = TOKENS.lastIndex;
		}
		if (at < data.length) this.put(data.slice(at));
		if (value.length > DETACH_AFTER_CHARS) {
			if (this.line) this.line = detach(this.line);
			// V8 keeps the subject of the last successful match alive; a match on "" lets this message go.
			RELEASE_MATCH.exec("");
		}
	}

	/** A whole block, such as an error's traceback, a result or a marker, on lines of its own. */
	block(text) {
		this.flushHeld();
		if (this.line) this.endLine();
		this.write(toText(text) + "\n");
	}

	control(token, parameter, final) {
		if (token === "\n" || token === "\r\n") this.endLine();
		else if (token === "\r") this.column = 0;
		else if (final === "K") {
			if (parameter === "" || parameter === "0") this.line = this.line.slice(0, this.column);
			else if (parameter === "1") this.line = " ".repeat(Math.min(this.column + 1, this.line.length)) + this.line.slice(this.column + 1);
			else if (parameter === "2") this.line = " ".repeat(this.column);
		}
		// Other sequences show nothing here.
	}

	/** Text without controls, written at the cursor, overwriting what is there. */
	put(text) {
		if (this.column === this.line.length) this.line += text;
		else this.line = this.line.slice(0, this.column) + text + this.line.slice(this.column + text.length);
		this.column += text.length;
		while (this.line.length > MAX_LINE_CHARS) {
			const rest = this.line.slice(MAX_LINE_CHARS);
			const column = this.column - MAX_LINE_CHARS;
			this.line = this.line.slice(0, MAX_LINE_CHARS);
			this.endLine();
			this.line = rest;
			this.column = Math.max(0, column);
		}
	}

	/** An escape left at the end shows nothing more: the line stays as it was. */
	flushHeld() {
		this.held = "";
		this.skipping = false;
	}

	/** Ends the current line; the last one, at close, keeps having no break if it had none. */
	endLine(newline = "\n") {
		const line = this.line + newline;
		this.line = "";
		this.column = 0;
		this.toSpool(line);
		if (this.truncated) return;
		const size = byteLength(line);
		if (this.memoryBytes + size > this.maxMemoryBytes) {
			this.truncated = true;
			return;
		}
		this.lines.push(detach(line));
		this.memoryBytes += size;
	}

	toSpool(text) {
		if (!this.spoolPath || this.capped || this.incomplete || (this.spoolState && this.spoolState !== "writing")) return;
		let data = Buffer.from(text, "utf8");
		const room = this.maxSpoolBytes - this.spooledBytes;
		if (data.length > room) {
			data = data.subarray(0, utf8Boundary(data, room));
			this.capped = true;
		}
		if (!data.length) return;
		// A disk that falls behind leaves the spool incomplete rather than queueing without bound.
		const budget = this.spoolBudget;
		if (budget.pending + data.length > budget.max) {
			this.incomplete = true;
			return;
		}
		if (!this.spool && !this.openSpool()) return;
		this.spooledBytes += data.length;
		budget.pending += data.length;
		this.spool.write(data, (error) => {
			budget.pending -= data.length;
			if (!error) this.writtenBytes += data.length;
		});
	}

	/**
	 * Creates the spool file, exclusively and at once, so that only a file
	 * created here, identified by its device and inode, is ever removed.
	 */
	openSpool() {
		this.spoolState = "writing";
		let fd;
		try {
			fd = openSync(this.spoolPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			const stat = fstatSync(fd);
			this.spoolFile = { dev: stat.dev, ino: stat.ino };
		} catch (error) {
			if (fd !== undefined) try { closeSync(fd); } catch {}
			this.spoolEnded("failed", error);
			return false;
		}
		this.spool = createWriteStream(this.spoolPath, { fd });
		this.spoolClosed = new Promise((resolve) => this.spool.once("close", resolve));
		this.spool.on("error", (error) => this.spoolEnded("failed", error));
		this.spool.on("finish", () => this.spoolEnded("complete"));
		return true;
	}

	spoolEnded(state, error) {
		if (this.spoolState !== "writing") return;
		this.spoolState = state;
		if (error) this.spoolError = clip(error.message, 1024);
		for (const resolve of this.spoolWaiters ?? []) resolve(state);
		this.spoolWaiters = null;
		this.onSpool(state, error);
	}

	/** Resolves once the spool is no longer being written: complete, failed, removed, or never begun. */
	whenSpooled() {
		if (this.spoolState !== "writing") return Promise.resolve(this.spoolState);
		return new Promise((resolve) => (this.spoolWaiters ??= []).push(resolve));
	}

	/** Resolves once the spool's file descriptor is closed, or at once if it never had one. */
	whenClosed() {
		return this.spoolClosed ?? Promise.resolve();
	}

	/** Stops a spool still being written, as failed; resolves once it is closed. */
	cut(reason) {
		if (this.spoolState === "writing") {
			this.spoolEnded("failed", new Error(reason));
			this.spool.destroy();
		}
		return this.whenClosed();
	}

	/** The text so far: whole lines, then as much of the current line as the bound allows. */
	text() {
		const whole = this.lines.join("");
		if (this.truncated) return whole;
		const room = this.maxMemoryBytes - this.memoryBytes;
		return whole + (byteLength(this.line) <= room ? this.line : sliceBytes(this.line, room));
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		this.flushHeld();
		if (this.line) this.endLine("");
		this.spool?.end();
	}

	/**
	 * For an execution no longer kept: closes the spool and, once it is
	 * closed, removes its file, only if the file there is still the one this
	 * buffer created. Resolves when that is done.
	 */
	discard() {
		this.close();
		this.lines = [];
		this.line = "";
		if (!this.spool) return Promise.resolve();
		this.spoolEnded("removed");
		this.spool.destroy();
		return this.whenClosed().then(() => {
			const owned = this.spoolFile;
			try {
				const stat = lstatSync(this.spoolPath);
				if (stat.dev === owned.dev && stat.ino === owned.ino) unlinkSync(this.spoolPath);
			} catch {}
		});
	}

	summary() {
		const partialOver = !this.truncated && byteLength(this.line) > this.maxMemoryBytes - this.memoryBytes;
		return {
			text: this.text(),
			receivedBytes: this.receivedBytes,
			truncated: this.truncated || partialOver,
			// A spool that was never opened, because the disk was behind or it couldn't be created, is reported too.
			spool: this.spoolState || this.incomplete || this.capped ? {
				path: this.spoolFile ? this.spoolPath : null,
				state: this.spoolState ?? "none",
				bytes: this.writtenBytes,
				capped: this.capped,
				incomplete: this.incomplete,
				full: this.spoolState === "complete" && !this.capped && !this.incomplete,
				...(this.spoolError ? { error: this.spoolError } : {}),
			} : null,
		};
	}
}

/**
 * A bounded, sequenced journal of received events within one kernel lifetime.
 * An event too large to keep is kept as an omission notice instead. Stream
 * text is kept raw, as received (escapes and CRs included), and needs
 * rendering as a terminal would; an execution's own output is cleaned.
 */
export class Journal {
	constructor(generation, { maxEvents = 10_000, maxBytes = 16 * 1024 * 1024, maxEventBytes = MAX_JOURNAL_EVENT_BYTES } = {}) {
		this.generation = generation;
		this.events = [];
		this.bytes = 0;
		this.next = 1;
		this.maxEvents = maxEvents;
		this.maxBytes = maxBytes;
		this.maxEventBytes = Math.min(maxEventBytes, maxBytes);
		this.dropped = 0;
	}

	append(event) {
		const seq = this.next++;
		let entry = { seq, at: Date.now(), ...event };
		let size = byteLength(JSON.stringify(entry));
		if (size > this.maxEventBytes) {
			// Its identifiers are kept, so that its execution can still be found.
			entry = { seq, at: entry.at, kind: clip(event.kind, 64), omitted: `too large to keep (${size} bytes)` };
			for (const key of ["msgType", "msgId", "session", "parentId", "parentSession", "executionId"]) {
				if (typeof event[key] === "string") entry[key] = clip(event[key]);
			}
			size = byteLength(JSON.stringify(entry));
		}
		this.events.push({ entry, size });
		this.bytes += size;
		// The newest event is always kept; it is bounded by maxEventBytes or is a small notice.
		while (this.events.length > this.maxEvents || (this.bytes > this.maxBytes && this.events.length > 1)) {
			this.bytes -= this.events.shift().size;
			this.dropped++;
		}
		return entry;
	}

	/**
	 * Events from `since` (inclusive), at most `limit` of them and about
	 * `maxBytes`, with any gap before the oldest kept. `cursor` is the `since`
	 * of the next page; `next` is the sequence the next event will get.
	 */
	read(since = 1, limit = 500, maxBytes = MAX_JOURNAL_PAGE_BYTES) {
		const tail = this.events.length ? this.events[0].entry.seq : this.next;
		const from = Math.max(since, tail);
		const events = [];
		let bytes = 0;
		for (let i = from - tail; i < this.events.length && events.length < limit; i++) {
			const { entry, size } = this.events[i];
			if (events.length && bytes + size > maxBytes) break;
			events.push(entry);
			bytes += size;
		}
		const cursor = events.length ? events.at(-1).seq + 1 : Math.min(from, this.next);
		return {
			generation: this.generation,
			tail,
			head: this.next - 1,
			next: this.next,
			cursor,
			gap: since < tail ? { from: since, to: tail - 1 } : null,
			events,
			more: cursor < this.next,
		};
	}
}

const truncate = (value, max = MAX_JOURNAL_TEXT) => {
	const text = toText(value);
	return text.length > max ? { text: detach(text.slice(0, max)), truncated: true } : { text: detach(text), truncated: false };
};

/** An IOPub message as the journal keeps it: no input values, bounded fields, raw stream text. */
function journalIopub(message) {
	const type = message.header.msg_type;
	const content = message.content ?? {};
	const event = {
		kind: "iopub",
		msgType: clip(type),
		msgId: clip(message.header.msg_id),
		session: clip(message.header.session),
		parentId: message.parent_header?.msg_id !== undefined ? clip(message.parent_header.msg_id) : null,
		parentSession: message.parent_header?.session !== undefined ? clip(message.parent_header.session) : null,
	};
	if (type === "status") event.state = clip(content.execution_state, 64);
	else if (type === "execute_input") Object.assign(event, { count: Number.isSafeInteger(content.execution_count) ? content.execution_count : null }, (({ text, truncated }) => ({ code: text, truncated }))(truncate(content.code)));
	else if (type === "stream") Object.assign(event, { name: clip(content.name, 64), raw: true }, truncate(content.text));
	else if (type === "error") Object.assign(event, { ename: clip(content.ename), evalue: truncate(content.evalue, 4096).text }, truncate(Array.isArray(content.traceback) ? content.traceback.map(toText).join("\n") : ""));
	else if (type === "execute_result" || type === "display_data") Object.assign(event, truncate(displayText(content.data)));
	return event;
}

function displayText(data) {
	if (!data || typeof data !== "object") return "";
	if (typeof data["text/plain"] === "string") return data["text/plain"];
	const mime = Object.keys(data)[0];
	return mime ? `[${clip(mime, 128)} output]` : "";
}

/** The text a settled execution leaves in the shared record: what was received, and what the status alone would lose. */
// A reply's text without the terminal colours and other control characters a kernel may give it.
function plainReplyText(text) {
	return typeof text === "string" ? text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b[^[\r\n]?/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim() : "";
}

function recordOutput(execution) {
	const received = execution.output.text().replace(/\n$/, "");
	const notes = [];
	if (execution.output.truncated) notes.push("[The output was cut here: more was received than the helper keeps in memory.]");
	if (execution.state === "completed" && execution.status === "aborted") return "Not run: a cell before it failed, so LFortran skipped it (stop_on_error).";
	if (execution.state === "completed" && execution.status === "error") {
		// The reply's message, which LFortran colours, only if the kept output doesn't hold all of it already, as it
		// does when LFortran writes the error to stderr or a kernel publishes it, and none of it was cut.
		const ename = plainReplyText(execution.reply?.ename);
		const evalue = plainReplyText(execution.reply?.evalue);
		const squash = (text) => text.replace(/\s+/g, " ").trim();
		const message = evalue && squash(received).includes(squash(evalue)) ? "" : evalue;
		notes.push(`[The cell failed${ename ? `: ${ename}${message ? `: ${message}` : "."}` : "."}]`);
	}
	if (execution.state === "unconfirmed") {
		const outcome = execution.outcome ?? {};
		const exit = outcome.exit ? (outcome.exit.signal ? `signal ${outcome.exit.signal}` : `status ${outcome.exit.code}`) : null;
		notes.push(`[Outcome unconfirmed: ${exit ? `the kernel exited (${exit})` : outcome.reason ?? "the connection to the kernel ended"}; ${outcome.started ? "it had started" : "there's no evidence it started"}.]`);
	}
	return [received, ...notes].filter(Boolean).join("\n");
}

/**
 * Writes the shared clean record's entries for this helper's executions, as
 * record.json says where: one entry each, `sent` until it settles, then
 * `captured` or, unconfirmed, `error`. A write takes the record's lock and
 * fsyncs, so it happens in a thread of its own (repl-record-worker.js), one at
 * a time: the protocol reader never waits for one. An entry's newest fields
 * are written together. A settled entry is never changed back: once queued,
 * nothing later for its key is. A failed write becomes a warning, once until a
 * write succeeds again; it never stops the helper.
 */
export class RecordWriter {
	constructor(path, { owner, warn, workerUrl = RECORD_WORKER }) {
		this.path = path;
		this.owner = owner;
		this.warn = warn;
		this.workerUrl = workerUrl;
		this.pending = new Map();
		this.settled = new Set();
		this.failing = false;
		this.config = undefined;
		this.worker = null;
		this.inFlight = null;
		this.seq = 0;
		this.idle = [];
	}

	/** record.json's recordId, root and identity, or null when the session has no record. */
	target() {
		if (this.config !== undefined) return this.config;
		let config = null;
		try {
			config = readRecordFile(this.path, this.owner);
		} catch (error) {
			if (error?.code !== "ENOENT") this.warn(`record.json can't be used (${error.message}), so cells aren't recorded.`);
		}
		this.config = config;
		return config;
	}

	/** Queues the execution's entry as it stands now. */
	queue(execution) {
		const key = execution.recordKey;
		if (!this.target() || execution.state === "not-sent" || this.settled.has(key)) return;
		const settled = TERMINAL_STATES.has(execution.state);
		if (settled) this.settled.add(key);
		this.pending.set(key, {
			id: `pi-repl:${key}`,
			requestId: execution.recordRequestId,
			origin: "pi-repl",
			label: execution.label || "LFortran cell",
			mode: execution.mode,
			code: execution.code,
			status: !settled ? "sent" : execution.state === "completed" ? "captured" : "error",
			output: settled ? recordOutput(execution) : "",
			createdAt: execution.submittedAt,
			completedAt: settled ? execution.settledAt : null,
		});
		this.pump();
	}

	pump() {
		if (this.inFlight || !this.pending.size) {
			if (!this.inFlight) this.wake();
			return;
		}
		const [key, entry] = this.pending.entries().next().value;
		this.pending.delete(key);
		try {
			this.worker ??= this.startWorker();
		} catch (error) {
			this.failed(error.message);
			this.pending.clear();
			this.wake();
			return;
		}
		this.inFlight = { seq: ++this.seq };
		const { recordId, identity, root } = this.config;
		this.worker.postMessage({ seq: this.inFlight.seq, recordId, identity, root, entry });
	}

	startWorker() {
		const worker = new Worker(this.workerUrl);
		worker.on("message", ({ seq, ok, error }) => {
			if (seq !== this.inFlight?.seq) return;
			this.inFlight = null;
			if (ok) this.failing = false;
			else this.failed(error);
			this.pump();
		});
		// The thread itself failing: nothing more is written, and that is said once.
		worker.on("error", (error) => this.lost(error.message));
		worker.on("exit", (code) => { if (this.worker === worker && !this.closed) this.lost(`it exited (${code})`); });
		// After the listeners, which would otherwise ref it again: the thread never keeps the helper alive.
		worker.unref();
		return worker;
	}

	failed(reason) {
		if (!this.failing) this.warn(`the shared record couldn't be written (${reason}); this cell's entry may be missing or out of date.`);
		this.failing = true;
	}

	lost(reason) {
		this.failed(`its writer stopped: ${reason}`);
		this.worker = null;
		this.inFlight = null;
		this.pending.clear();
		this.config = null;
		this.wake();
	}

	wake() {
		for (const resolve of this.idle.splice(0)) resolve();
	}

	/** Resolves when every queued entry has been written, or after `ms`. */
	drain(ms) {
		if (!this.inFlight && !this.pending.size) return Promise.resolve();
		return new Promise((resolve) => {
			const timer = setTimeout(resolve, ms);
			this.idle.push(() => { clearTimeout(timer); resolve(); });
		});
	}

	/** Writes what it can within `ms`, then stops the thread. */
	async close(ms) {
		await this.drain(ms);
		this.closed = true;
		await this.worker?.terminate().catch(() => {});
		this.worker = null;
	}
}

const delay = (ms) => {
	let timer;
	const promise = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
	return { promise, cancel: () => clearTimeout(timer) };
};

/**
 * A helper for one session. Usable in-process for tests; the CLI below runs
 * one per tmux session. `kernelCommand(connectionFile)` gives the kernel's
 * [command, args]; the kernel gets `launchId` as PI_REPL_JUPYTER_OWNER.
 */
export class JupyterHelper extends EventEmitter {
	constructor({ dir, kernelCommand, launchId = randomId(), drainMs = 2000, startTimeoutMs = 120_000, killTimeoutMs = 2000, spoolCloseMs = 1000, journal = {}, output = {}, retain = {}, maxSubmissions = MAX_SUBMISSIONS, maxRequestBytes = MAX_REQUEST_LINE_BYTES, maxClientBacklogBytes = MAX_CLIENT_BACKLOG_BYTES, maxConnections = MAX_CONNECTIONS, log = () => {} }) {
		super();
		if (!HEX_ID.test(launchId)) throw new Error("A launch ID (owner marker) is 32 lowercase hex characters.");
		this.dir = dir;
		this.paths = Object.fromEntries(Object.entries(HELPER_FILES).map(([key, name]) => [key, join(dir, name)]));
		this.kernelCommand = kernelCommand;
		this.launchId = launchId;
		this.lifetimeId = randomId();
		this.drainMs = drainMs;
		this.startTimeoutMs = startTimeoutMs;
		this.killTimeoutMs = killTimeoutMs;
		this.spoolCloseMs = spoolCloseMs;
		this.outputOptions = output;
		this.retainLimits = { ...RETAIN, ...retain };
		this.maxSubmissions = maxSubmissions;
		this.maxRequestBytes = maxRequestBytes;
		this.maxClientBacklogBytes = maxClientBacklogBytes;
		this.maxConnections = maxConnections;
		this.log = log;
		this.state = "starting";
		this.admitting = false;
		// Executions by ID: those kept in full, and small tombstones for those no longer kept.
		this.executions = new Map();
		this.retained = new Set();
		this.submissions = new Map();
		this.requests = new Map();
		this.current = null;
		this.waiters = new Map();
		this.journal = new Journal(this.lifetimeId, journal);
		this.spoolBudget = { pending: 0, max: output.maxSpoolPendingBytes ?? MAX_SPOOL_PENDING_BYTES };
		this.connections = new Set();
		// Spools of executions no longer kept, still being closed and removed.
		this.retiring = new Set();
		this.warnings = [];
		this.counts = { dropped: 0, listenerErrors: 0 };
		this.recordWriter = new RecordWriter(join(dir, RECORD_FILE), { owner: launchId, warn: (message) => this.warn(message) });
		// Each record entry's key, which only one execution may have.
		this.recordKeys = new Set();
	}

	/**
	 * Claims DIR, starts the kernel, connects, listens and publishes ready.json,
	 * all within `startTimeoutMs`. On failure it publishes the reason, if DIR
	 * is this launch's, and throws. It reports ready only if, at that moment,
	 * the kernel is alive and the connection whole. Started once; a second call
	 * gets the same start.
	 */
	start() {
		this.starting ??= this.run();
		return this.starting;
	}

	async run() {
		const deadline = Date.now() + this.startTimeoutMs;
		const remaining = () => Math.max(0, deadline - Date.now());
		try {
			if (this.stopping) throw new Error("The helper was stopped before it started.");
			checkPrivateDirectory(this.dir);
			this.claim();
			await this.startKernel();
			this.checkStarting("starting the kernel");
			const connection = await this.waitForConnectionFile(deadline);
			this.checkStarting("waiting for the connection file");
			// Listening before connecting, so that nothing during readiness is missed.
			const client = new JupyterClient(connection, { drainMs: Infinity, username: "pi-repl-helper" });
			this.client = client;
			client.on("message", (channel, message) => this.receive(channel, message));
			client.on("channelClose", (channel, error) => this.connectionEnded(channel, error));
			client.on("dropped", (channel, error) => this.dropped(channel, error));
			client.on("listenerError", (error, event) => this.listenerFailed(error, event));
			await client.open({ timeoutMs: remaining() });
			this.kernelSession = client.kernelInfo.header.session;
			this.checkStarting("connecting");
			await this.listen();
			// From this check to ready nothing else runs, so no exit or loss can come between.
			this.checkStarting("listening");
			this.state = "ready";
			this.admitting = true;
			this.journal.append({ kind: "kernel", event: "ready", kernelSession: clip(this.kernelSession) });
			this.publishReady({ state: "ready" });
			this.log(`ready: kernel ${this.kernel.pid}, socket ${this.paths.socket}`);
		} catch (error) {
			const reason = this.kernelExit && !this.stopping ? `The kernel exited before it was ready (${describeExit(this.kernelExit)}).` : error.message;
			if (this.state === "starting") this.state = "failed";
			this.failure = reason;
			this.client?.close();
			await this.closeServer();
			if (this.claimed) try { this.publishReady({ state: "failed", reason }); } catch {}
			throw reason === error.message ? error : new Error(reason, { cause: error });
		}
	}

	checkStarting(stage) {
		if (this.stopping) throw new Error("The helper was stopped while it started.");
		if (this.kernelExit) throw new Error(`The kernel exited before it was ready (${describeExit(this.kernelExit)}).`);
		if (this.client?.lost) throw new Error(`The connection to the kernel was lost while ${stage}.`);
	}

	/**
	 * DIR must be new: none of the helper's files there. kernel.log, created
	 * exclusively, is this launch's claim; a second helper given the same DIR
	 * stops before it changes anything. Then helper.pid names this process,
	 * for the person's window, which waits while it lives.
	 */
	claim() {
		for (const name of Object.values(HELPER_FILES)) {
			if (pathExists(join(this.dir, name))) throw new Error(`${this.dir} isn't a new session directory: ${name} exists.`);
		}
		try {
			this.logFd = openSync(this.paths.kernelLog, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		} catch (error) {
			if (error.code === "EEXIST") throw new Error(`${this.dir} isn't a new session directory: another helper claimed it.`);
			throw error;
		}
		this.claimed = true;
		const fd = openSync(this.paths.pid, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try { writeSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
	}

	startKernel() {
		const [command, args] = this.kernelCommand(this.paths.connection);
		const fd = this.logFd;
		let logged = 0;
		let logClosed = false;
		const closeLog = () => {
			if (logClosed) return;
			logClosed = true;
			try { closeSync(fd); } catch {}
		};
		const append = (chunk) => {
			if (logClosed || logged >= MAX_KERNEL_LOG_BYTES) return;
			const part = chunk.subarray(0, MAX_KERNEL_LOG_BYTES - logged);
			logged += part.length;
			try { writeSync(fd, part); } catch {}
		};
		return new Promise((resolve, reject) => {
			let child;
			try {
				// Its own process group and session, with no terminal: a signal to the
				// helper's pane doesn't reach it, and its output can't block it.
				child = spawn(command, args, { cwd: process.cwd(), detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_REPL_JUPYTER_OWNER: this.launchId } });
			} catch (error) {
				closeLog();
				return reject(new Error(`The kernel didn't start: ${error.message}`));
			}
			this.kernel = child;
			this.kernelGone = new Promise((done) => child.once("exit", done));
			// Named at once, so that a stop can find the kernel even if the helper ends before ready.json.
			if (child.pid) {
				try {
					const fd = openSync(this.paths.kernelPid, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
					try { writeSync(fd, `${child.pid}\n`); } finally { closeSync(fd); }
				} catch (error) {
					this.warn(`could not record the kernel's PID: ${error.message}`);
				}
			}
			child.stdout.on("data", append);
			child.stderr.on("data", append);
			child.once("spawn", () => {
				// When the helper saw the spawn; verified stop reads the OS's own start time.
				this.kernelSpawnedAt = Date.now();
				resolve();
			});
			child.once("error", (error) => {
				closeLog();
				reject(new Error(`The kernel didn't start: ${error.message}`));
			});
			child.once("exit", (code, signal) => this.kernelExited({ code, signal }));
			// The log is closed once the child's output has drained, not at its exit.
			child.once("close", closeLog);
		});
	}

	async waitForConnectionFile(deadline) {
		let lastError;
		while (Date.now() < deadline) {
			this.checkStarting("waiting for the connection file");
			if (pathExists(this.paths.connection)) {
				try {
					return readConnectionFile(this.paths.connection);
				} catch (error) {
					// It may still be being written.
					lastError = error;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw lastError ?? new Error(`The kernel wrote no connection file within ${this.startTimeoutMs} ms.`);
	}

	/** Listens on DIR/h.sock. Nothing is ever unlinked first: DIR was new when it was claimed. */
	async listen() {
		const server = net.createServer((socket) => this.serve(socket));
		// Connections beyond this are closed as they arrive.
		server.maxConnections = this.maxConnections;
		server.on("error", (error) => this.warn(`the local socket failed: ${error.message}`));
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.paths.socket, () => {
				server.off("error", reject);
				resolve();
			});
		});
		this.server = server;
		// The directory is 0700 already; the socket itself is narrowed too.
		chmodSync(this.paths.socket, 0o600);
	}

	/**
	 * Closes the local socket, which removes its file; clients get what was
	 * already written, and those still connected after 500 ms are cut off.
	 * Every caller waits for the same close.
	 */
	closeServer() {
		if (this.serverClosed) return this.serverClosed;
		const server = this.server;
		if (!server) return Promise.resolve();
		this.serverClosed = new Promise((resolve) => {
			const timer = setTimeout(() => { for (const socket of this.connections) socket.destroy(); }, 500);
			server.close(() => {
				clearTimeout(timer);
				resolve();
			});
			for (const socket of this.connections) socket.end();
		});
		return this.serverClosed;
	}

	publishReady(fields) {
		const value = JSON.stringify({
			protocol: HELPER_PROTOCOL_VERSION,
			launchId: this.launchId,
			lifetimeId: this.lifetimeId,
			helperPid: process.pid,
			kernelPid: this.kernel?.pid ?? null,
			kernelSession: this.kernelSession ?? null,
			connectionFile: this.paths.connection,
			socket: this.paths.socket,
			at: Date.now(),
			...fields,
		}) + "\n";
		const temporary = join(this.dir, `.ready-${randomBytes(6).toString("hex")}`);
		const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try { writeSync(fd, value); } finally { closeSync(fd); }
		renameSync(temporary, this.paths.ready);
	}

	warn(message) {
		const warning = { at: Date.now(), message: clip(message, 1024) };
		this.warnings.push(warning);
		if (this.warnings.length > MAX_WARNINGS) this.warnings.shift();
		this.journal.append({ kind: "notice", message: warning.message });
		this.log(`warning: ${warning.message}`);
	}

	dropped(channel, error) {
		this.counts.dropped++;
		this.warn(`a ${channel} message from the kernel was dropped: ${error?.message ?? error}`);
	}

	listenerFailed(error, event) {
		this.counts.listenerErrors++;
		this.warn(`handling a ${event} event failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	// --- Jupyter side ---

	receive(channel, message) {
		// During startup only the readiness probes' own messages come.
		if (this.state === "starting") return;
		const journalled = channel === "iopub" ? this.journal.append(journalIopub(message)) : null;
		const execution = this.byRequest(message.parent_header?.msg_id);
		if (!execution) return;
		if (journalled) this.noteEvent(execution, journalled);
		// A settled execution is fixed: later messages for it stay in the journal only.
		if (TERMINAL_STATES.has(execution.state)) {
			execution.late++;
			return;
		}
		const type = message.header.msg_type;
		const content = message.content ?? {};
		if (channel === "iopub") {
			if (type === "status") {
				// A kernel is busy with a request it aborts too; the cell itself ran only if its execute_input came.
				if (content.execution_state === "busy" && execution.state === "submitted") execution.state = "running";
				if (content.execution_state === "idle") execution.idle = true;
			} else if (type === "execute_input") {
				this.started(execution);
			} else if (type === "stream") {
				execution.output.write(toText(content.text));
			} else if (type === "error") {
				execution.output.block((Array.isArray(content.traceback) && content.traceback.length ? content.traceback.map(toText) : [`${toText(content.ename)}: ${toText(content.evalue)}`]).join("\n"));
			} else if (type === "execute_result" || type === "display_data") {
				execution.output.block(displayText(content.data));
			} else if (type === "clear_output") {
				execution.output.block("[output cleared]");
			}
		} else if (channel === "shell" && type === "execute_reply") {
			if (execution.reply) {
				execution.late++;
				return;
			}
			const { status, ename, evalue } = content;
			execution.reply = REPLY_STATUSES.has(status)
				? { status, ...(status === "error" ? { ename: clip(ename), evalue: clip(evalue, 4096) } : {}) }
				: { status: "invalid", received: clip(typeof status === "string" ? status : JSON.stringify(status ?? null), 64) };
		} else if (channel === "stdin" && type === "input_request") {
			// Only the request's header is kept: the answer's parent.
			execution.input = { token: randomId(), prompt: clip(content.prompt, 4096), password: Boolean(content.password), request: { header: message.header } };
			execution.state = "waiting-input";
			this.record(execution, { kind: "input", event: "requested", executionId: execution.id });
		}
		if (execution.reply && execution.idle) this.complete(execution);
		else this.changed(execution);
	}

	/** Settles an execution whose reply and idle have both come. */
	complete(execution) {
		if (execution.reply.status === "invalid") {
			execution.outcome = { kind: "invalid-reply", reason: `the kernel's execute_reply had no valid status (${execution.reply.received})`, exit: null, started: Boolean(execution.started) };
			this.settle(execution, "unconfirmed");
		} else {
			this.settle(execution, "completed");
		}
	}

	started(execution) {
		if (!execution.started) {
			execution.started = true;
			execution.startedAt = Date.now();
		}
		if (execution.state === "submitted") execution.state = "running";
	}

	byRequest(requestId) {
		const id = typeof requestId === "string" ? this.requests.get(requestId) : undefined;
		return id ? this.executions.get(id) : undefined;
	}

	/** A journal event of this execution's, noted so that a reader can find its events. */
	record(execution, event) {
		this.noteEvent(execution, this.journal.append(event));
	}

	noteEvent(execution, entry) {
		const range = execution.journal;
		range.first ??= entry.seq;
		range.last = entry.seq;
		range.count++;
	}

	kernelExited(exit) {
		this.kernelExit = { ...exit, at: Date.now() };
		this.journal.append({ kind: "kernel", event: "exited", exit: this.kernelExit });
		this.log(`kernel exited: ${describeExit(this.kernelExit)}`);
		// An execution settled when the connection was lost keeps its outcome; only its diagnostic learns of the exit.
		const last = this.current;
		if (this.state === "connection-lost" && last?.state === "unconfirmed" && last.outcome && !last.outcome.exit) {
			last.outcome = { ...last.outcome, exit: this.kernelExit };
			this.changed(last);
		}
		if (this.state !== "ready" && this.state !== "connection-lost") return;
		this.state = "kernel-exited";
		this.endAdmission("kernel-exited", `the kernel exited (${describeExit(this.kernelExit)})`);
	}

	connectionEnded(channel, error) {
		if (this.state !== "ready") return;
		this.state = "connection-lost";
		this.journal.append({ kind: "kernel", event: "connection-lost", channel, error: error ? clip(error.message, 1024) : null });
		this.endAdmission("connection-lost", `the connection to the kernel was lost (${channel})`);
	}

	/**
	 * No new executions. Messages already buffered are still received for
	 * `drainMs`; then an unresolved execution settles as completed, if both its
	 * reply and idle came, or unconfirmed. `kind` says why, for readers:
	 * kernel-exited, connection-lost, invalid-reply or helper-stopped.
	 */
	endAdmission(kind, reason) {
		if (this.ending || this.stopping) return;
		this.admitting = false;
		this.ending = setTimeout(() => {
			const execution = this.current;
			if (execution && !TERMINAL_STATES.has(execution.state)) {
				if (execution.reply && execution.idle) this.complete(execution);
				else {
					execution.outcome = { kind: this.kernelExit ? "kernel-exited" : kind, reason, exit: this.kernelExit ?? null, started: Boolean(execution.started) };
					this.settle(execution, "unconfirmed");
				}
			}
			this.client?.close();
		}, this.drainMs);
	}

	// --- Executions ---

	checkLifetime(lifetimeId) {
		if (lifetimeId !== this.lifetimeId) throw new HelperRequestError("lifetime-changed", "The kernel isn't the one this request was for; nothing was done.", { lifetimeId: this.lifetimeId });
	}

	expired(entry) {
		return new HelperRequestError("expired", "That execution is no longer kept; it isn't run again.", { executionId: entry.id, state: entry.state, status: entry.status });
	}

	execute({ lifetimeId, submissionId, code, label = "", ownerKey = "", mode = "raw", requestId }) {
		this.checkLifetime(lifetimeId);
		if (typeof submissionId !== "string" || !SUBMISSION_ID.test(submissionId)) throw new HelperRequestError("invalid-request", "A submissionId of 8–128 letters, digits, _ or - is needed.");
		if (!RECORD_MODES.has(mode)) throw new HelperRequestError("invalid-request", "mode is agent, raw or literate.");
		if (requestId !== undefined && (typeof requestId !== "string" || !RECORD_REQUEST_ID.test(requestId) || requestId.trim() !== requestId)) {
			throw new HelperRequestError("invalid-request", "A requestId is 1–300 characters, without line breaks, NUL, or space at either end.");
		}
		const recordKey = requestId === undefined ? undefined : recordEntryKey(requestId);
		if (typeof code !== "string" || byteLength(code) > MAX_CODE_BYTES) throw new HelperRequestError("invalid-request", "Code must be a string of at most 16 MiB.");
		const codeHash = hashCode(code);
		const existing = this.submissions.get(submissionId);
		if (existing) {
			const entry = this.executions.get(existing);
			if (entry.codeHash !== codeHash) throw new HelperRequestError("submission-conflict", "That submissionId was used for other code; nothing was sent.", { executionId: entry.id });
			if (entry.expired) throw this.expired(entry);
			return this.snapshot(entry);
		}
		if (!this.admitting) throw new HelperRequestError("not-accepting", `The session isn't accepting cells: ${this.state}.`, { state: this.state });
		if (recordKey !== undefined && this.recordKeys.has(recordKey)) throw new HelperRequestError("duplicate-request", "That requestId names another cell's record entry; nothing was sent.");
		if (this.current && !TERMINAL_STATES.has(this.current.state)) {
			throw new HelperRequestError("busy", "Another cell is still unresolved; wait for it first.", { executionId: this.current.id, state: this.current.state });
		}
		// Every submission ID is remembered for the kernel's lifetime, so that none runs twice.
		if (this.submissions.size >= this.maxSubmissions) throw new HelperRequestError("session-limit", `This session has taken its limit of ${this.maxSubmissions} cells; restart it to go on.`);
		const id = randomId();
		// The helper's own policy, whatever the caller wants: never silent, READs allowed, stop on error.
		const request = this.client.prepareExecute(code, { silent: false, storeHistory: true, allowStdin: true, stopOnError: true });
		const execution = {
			id, submissionId, code, codeHash, codeBytes: byteLength(code), label: String(label).slice(0, 200), ownerKey: String(ownerKey).slice(0, 256), mode, recordRequestId: requestId, recordKey: recordKey ?? `lfortran:${id}`,
			requestId: request.header.msg_id, state: "submitted", version: 1, started: false, idle: false, reply: null, input: null, outcome: null, late: 0,
			submittedAt: Date.now(), startedAt: null, settledAt: null, journal: { first: null, last: null, count: 0 },
			output: new OutputBuffer({ ...this.outputOptions, spoolPath: join(this.dir, `out-${id}.txt`), spoolBudget: this.spoolBudget, onSpool: (state, error) => this.spooled(execution, state, error) }),
		};
		this.executions.set(id, execution);
		this.retained.add(id);
		this.submissions.set(submissionId, id);
		this.recordKeys.add(execution.recordKey);
		this.requests.set(execution.requestId, id);
		this.current = execution;
		this.trim();
		try {
			this.client.post("shell", request);
		} catch (error) {
			// Refused before anything was written: the code wasn't sent.
			execution.outcome = { reason: `not sent: ${error.message}` };
			this.settle(execution, "not-sent");
			return this.snapshot(execution);
		}
		this.record(execution, { kind: "execution", event: "submitted", executionId: id, requestId: clip(execution.requestId), label: execution.label });
		this.recordWriter.queue(execution);
		this.changed(execution);
		return this.snapshot(execution);
	}

	spooled(execution, state, error) {
		if (state === "removed") return;
		if (state === "failed") this.warn(`the output spool of execution ${execution.id} failed: ${error?.message ?? "unknown error"}`);
		this.changed(execution);
	}

	/**
	 * Answers the current execution's READ. The token is taken before the
	 * write, so that a racing answer finds none; it is given back only if the
	 * answer was refused before anything was written. The value itself is
	 * never journalled or put in an error, though the program may echo it.
	 */
	input({ lifetimeId, token, text }) {
		this.checkLifetime(lifetimeId);
		const value = normalizeInputText(text);
		const execution = this.current;
		const pending = execution?.input;
		if (!pending || typeof token !== "string" || !HEX_ID.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(pending.token))) {
			throw new HelperRequestError("invalid-token", "That token doesn't answer a pending READ.");
		}
		execution.input = null;
		try {
			this.client.input(value, pending.request);
		} catch (error) {
			execution.input = pending;
			throw new HelperRequestError("input-not-sent", `The answer wasn't sent: ${error.message}`);
		}
		execution.state = execution.started ? "running" : "submitted";
		this.record(execution, { kind: "input", event: "answered", executionId: execution.id });
		this.changed(execution);
		return this.snapshot(execution);
	}

	settle(execution, state) {
		execution.state = state;
		execution.status = execution.reply?.status ?? null;
		execution.input = null;
		execution.settledAt = Date.now();
		execution.output.close();
		this.record(execution, { kind: "execution", event: state, executionId: execution.id, status: execution.status, outcome: execution.outcome });
		this.recordWriter.queue(execution);
		this.changed(execution);
		this.trim();
	}

	/**
	 * Keeps settled executions within the retention bounds, oldest first; the
	 * current one is always kept. One no longer kept leaves a tombstone, and
	 * its spool file is removed.
	 */
	trim() {
		const limits = this.retainLimits;
		const kept = [...this.retained].map((id) => this.executions.get(id));
		const size = (execution) => execution.codeBytes + execution.output.memoryBytes + byteLength(execution.output.line);
		let bytes = 0;
		let spoolBytes = 0;
		for (const execution of kept) {
			bytes += size(execution);
			spoolBytes += execution.output.spooledBytes;
		}
		for (const execution of kept) {
			if (this.retained.size <= limits.executions && bytes <= limits.bytes && spoolBytes <= limits.spoolBytes) break;
			if (execution === this.current || !TERMINAL_STATES.has(execution.state)) continue;
			bytes -= size(execution);
			spoolBytes -= execution.output.spooledBytes;
			this.evict(execution);
		}
	}

	evict(execution) {
		const tombstone = { id: execution.id, submissionId: execution.submissionId, codeHash: execution.codeHash, state: execution.state, status: execution.status ?? null, settledAt: execution.settledAt, expired: true };
		this.executions.set(execution.id, tombstone);
		this.retained.delete(execution.id);
		this.requests.delete(execution.requestId);
		const removed = execution.output.discard();
		this.retiring.add(removed);
		removed.finally(() => this.retiring.delete(removed));
		for (const waiter of [...(this.waiters.get(execution.id) ?? [])]) waiter.done(false);
	}

	changed(execution) {
		execution.version++;
		for (const waiter of [...(this.waiters.get(execution.id) ?? [])]) {
			if (execution.version > waiter.since) waiter.done(false);
		}
	}

	/**
	 * Resolves when the execution's version passes `since`, or after
	 * `timeoutMs`, with its snapshot. A settled execution changes again only
	 * while its spool is being written, so otherwise it answers at once. A
	 * wait made over a connection ends with that connection.
	 */
	wait({ executionId, since = 0, timeoutMs = 30_000 }, connection) {
		if (!Number.isSafeInteger(since) || since < 0) throw new HelperRequestError("invalid-request", "`since` is a version: an integer, 0 or more.");
		const execution = this.executions.get(executionId);
		if (!execution) throw new HelperRequestError("unknown-execution", "No such execution.");
		if (execution.expired) throw this.expired(execution);
		const quiet = TERMINAL_STATES.has(execution.state) && execution.output.spoolState !== "writing";
		if (execution.version > since || quiet) return this.snapshot(execution);
		return new Promise((resolve) => {
			const set = this.waiters.get(executionId) ?? new Set();
			this.waiters.set(executionId, set);
			const waiter = {
				since,
				finish: () => {
					clearTimeout(waiter.timer);
					set.delete(waiter);
					if (!set.size && this.waiters.get(executionId) === set) this.waiters.delete(executionId);
					connection?.waiters.delete(waiter);
				},
				done: (timedOut) => {
					waiter.finish();
					resolve({ ...this.snapshot(this.executions.get(executionId)), timedOut });
				},
				cancel: () => {
					waiter.finish();
					resolve(null);
				},
			};
			waiter.timer = setTimeout(() => waiter.done(true), Math.min(Math.max(0, Number(timeoutMs) || 0), MAX_WAIT_MS));
			set.add(waiter);
			connection?.waiters.add(waiter);
		});
	}

	lookup({ submissionId, executionId }) {
		const id = executionId ?? this.submissions.get(submissionId);
		const entry = id && this.executions.get(id);
		if (!entry) throw new HelperRequestError("unknown-execution", "No execution has that ID.");
		if (entry.expired) throw this.expired(entry);
		return this.snapshot(entry);
	}

	snapshot(execution) {
		if (execution.expired) return { executionId: execution.id, submissionId: execution.submissionId, state: execution.state, status: execution.status, settledAt: execution.settledAt, expired: true };
		return {
			executionId: execution.id,
			submissionId: execution.submissionId,
			requestId: execution.requestId,
			ownerKey: execution.ownerKey,
			label: execution.label,
			state: execution.state,
			status: execution.status ?? null,
			version: execution.version,
			started: execution.started,
			reply: execution.reply,
			input: execution.input ? { token: execution.input.token, prompt: execution.input.prompt, password: execution.input.password } : null,
			outcome: execution.outcome,
			late: execution.late,
			submittedAt: execution.submittedAt,
			startedAt: execution.startedAt,
			settledAt: execution.settledAt,
			// Where its journal events are: every one is within [first, last], parented by requestId or naming executionId.
			journal: { ...execution.journal },
			output: execution.output.summary(),
		};
	}

	status() {
		return {
			protocol: HELPER_PROTOCOL_VERSION,
			launchId: this.launchId,
			lifetimeId: this.lifetimeId,
			state: this.state,
			admitting: this.admitting,
			helperPid: process.pid,
			kernel: { pid: this.kernel?.pid ?? null, session: this.kernelSession ?? null, exit: this.kernelExit ?? null, droppedMessages: this.counts.dropped },
			listenerErrors: this.counts.listenerErrors,
			current: this.current ? this.snapshot(this.current) : null,
			executions: { retained: this.retained.size, submissions: this.submissions.size, maxSubmissions: this.maxSubmissions },
			journal: { generation: this.journal.generation, head: this.journal.next - 1, next: this.journal.next, dropped: this.journal.dropped },
			connections: this.connections.size,
			warnings: [...this.warnings],
		};
	}

	// --- Local clients ---

	serve(socket) {
		const connection = { socket, waiters: new Set(), inFlight: 0, closing: false };
		const reader = new LineReader(this.maxRequestBytes);
		this.connections.add(socket);
		const send = (value) => {
			if (socket.destroyed || socket.writableEnded) return;
			let line;
			try {
				line = JSON.stringify(value) + "\n";
			} catch (error) {
				line = JSON.stringify({ id: value.id ?? null, ok: false, error: { code: "internal", message: `The response couldn't be serialised: ${error.message}` } }) + "\n";
			}
			// A client that doesn't read is dropped rather than allowed to hold the helper back.
			if (socket.writableLength + byteLength(line) > this.maxClientBacklogBytes) return socket.destroy();
			socket.write(line);
		};
		const answer = (line) => {
			if (!line.trim()) return;
			let request;
			try {
				request = JSON.parse(line);
			} catch {
				return send({ id: null, ok: false, error: { code: "invalid-json", message: "A request isn't JSON." } });
			}
			const id = request !== null && typeof request === "object" && (typeof request.id === "number" || typeof request.id === "string") ? request.id : null;
			if (connection.inFlight >= MAX_REQUESTS_IN_FLIGHT) {
				return send({ id, ok: false, error: { code: "too-many-requests", message: "Too many requests at once on one connection." } });
			}
			connection.inFlight++;
			Promise.resolve()
				.then(() => this.handle(request, connection))
				.then(
					(result) => { if (result !== null) send({ id, ok: true, result }); },
					(error) => send({ id, ok: false, error: { ...(error instanceof HelperRequestError ? error.details : {}), code: error instanceof HelperRequestError ? error.code : "internal", message: String(error?.message ?? error) } }),
				)
				.finally(() => { connection.inFlight--; });
		};
		socket.on("data", (chunk) => {
			if (connection.closing) return;
			const { lines, overflow } = reader.push(chunk);
			for (const line of lines) answer(line);
			if (overflow) {
				connection.closing = true;
				send({ id: null, ok: false, error: { code: "request-too-large", message: `A request line is over ${this.maxRequestBytes} bytes.` } });
				socket.end(() => socket.destroy());
			}
		});
		socket.on("error", () => {});
		socket.on("close", () => {
			this.connections.delete(socket);
			for (const waiter of [...connection.waiters]) waiter.cancel();
		});
	}

	handle(request, connection) {
		if (request === null || typeof request !== "object") throw new HelperRequestError("invalid-request", "A request is a JSON object.");
		const params = request.params !== null && typeof request.params === "object" ? request.params : {};
		switch (request.op) {
			case "hello": return { protocol: HELPER_PROTOCOL_VERSION, launchId: this.launchId, lifetimeId: this.lifetimeId, state: this.state, helperPid: process.pid, kernelPid: this.kernel?.pid ?? null, kernelSession: this.kernelSession ?? null };
			case "status": return this.status();
			case "execute": return this.execute(params);
			case "input": return this.input(params);
			case "wait": return this.wait(params, connection);
			case "lookup": return this.lookup(params);
			case "journal": {
				const since = params.since ?? 1;
				const limit = params.limit ?? 500;
				if (!Number.isSafeInteger(since) || since < 1 || !Number.isSafeInteger(limit) || limit < 1) throw new HelperRequestError("invalid-request", "`since` and `limit` are integers, 1 or more.");
				return this.journal.read(since, Math.min(limit, 1000));
			}
			default: throw new HelperRequestError("unknown-op", `Unknown operation: ${clip(request.op, 64)}`);
		}
	}

	/**
	 * Stops listening and disconnects, once; an unresolved execution ends
	 * unconfirmed. The kernel is left to its own lifetime unless `killKernel`:
	 * then its process group gets SIGTERM, and SIGKILL if it hasn't exited
	 * within `killTimeoutMs`. Resolves with what became of the kernel, and
	 * `cleanup.complete`: whether every file the helper wrote is closed. The
	 * kernel and anything it started are reported apart: DIR can be removed
	 * only once both are known to be done with it.
	 */
	async stop({ killKernel = false } = {}) {
		this.stopped ??= this.shutdown();
		await this.stopped;
		const kernel = killKernel ? await this.killKernel() : { kernel: this.kernelState() };
		return { ...kernel, cleanup: { ...this.cleanup } };
	}

	async shutdown() {
		this.stopping = true;
		this.admitting = false;
		clearTimeout(this.ending);
		if (this.state !== "failed") this.state = "stopped";
		const execution = this.current;
		if (execution && !TERMINAL_STATES.has(execution.state)) {
			execution.outcome = { kind: "helper-stopped", reason: "the helper stopped", exit: this.kernelExit ?? null, started: Boolean(execution.started) };
			this.settle(execution, "unconfirmed");
		}
		for (const set of [...this.waiters.values()]) for (const waiter of [...set]) waiter.done(true);
		this.client?.close();
		// A start still under way gives up at its next check; it is let finish, so that nothing it opens stays open.
		await this.starting?.catch(() => {});
		// The waiters' answers are written before the connections end.
		await new Promise((resolve) => setImmediate(resolve));
		await this.closeServer();
		await this.closeSpools();
		// The entries of cells this stop settled are written, within a bound.
		await this.recordWriter.close(this.spoolCloseMs);
	}

	/**
	 * Closes every spool. Writes still under way get `spoolCloseMs` to finish;
	 * a spool still being written then is cut short, as failed, and reported.
	 */
	async closeSpools() {
		const outputs = [...this.retained].map((id) => this.executions.get(id).output);
		for (const output of outputs) output.close();
		const closed = () => Promise.all([...outputs.map((output) => output.whenClosed()), ...this.retiring]).then(() => true);
		const within = async (ms) => {
			const wait = delay(ms);
			const done = await Promise.race([closed(), wait.promise.then(() => false)]);
			wait.cancel();
			return done;
		};
		let cutSpools = 0;
		let complete = await within(this.spoolCloseMs);
		if (!complete) {
			for (const output of outputs) {
				if (output.spoolState !== "writing") continue;
				cutSpools++;
				output.cut("the helper stopped before the spool was written");
			}
			complete = await within(this.spoolCloseMs);
		}
		this.cleanup = { complete, cutSpools };
	}

	kernelState() {
		const child = this.kernel;
		if (!child?.pid) return "not-started";
		return child.exitCode !== null || child.signalCode !== null ? "exited" : "running";
	}

	async killKernel() {
		const child = this.kernel;
		// Only while the child is unreaped: after that its group ID could be reused.
		for (const signal of ["SIGTERM", "SIGKILL"]) {
			if (this.kernelState() !== "running") break;
			try {
				process.kill(-child.pid, signal);
			} catch (error) {
				if (error.code !== "ESRCH") return { kernel: "running", error: error.message };
			}
			const wait = delay(this.killTimeoutMs);
			await Promise.race([this.kernelGone, wait.promise]);
			wait.cancel();
		}
		const kernel = this.kernelState();
		return { kernel, ...(kernel === "exited" ? { exit: this.kernelExit ?? null } : {}) };
	}
}

function describeExit(exit) {
	if (!exit) return "running";
	return exit.signal ? `signal ${exit.signal}` : `status ${exit.code}`;
}

/** DIR must be a real, current-user-owned directory, mode 0700. */
export function checkPrivateDirectory(dir) {
	const stat = lstatSync(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
		throw new Error(`${dir} isn't a private directory of this user's (mode 0700).`);
	}
}

/**
 * A local client of a helper: requests matched by ID, bounded in number,
 * line size and queued bytes. A malformed or oversized response ends the
 * connection, failing every pending request.
 */
export class HelperClient {
	static connect(socketPath, { timeoutMs = 5000, ...options } = {}) {
		return new Promise((resolve, reject) => {
			const socket = net.createConnection(socketPath);
			const timer = setTimeout(() => { socket.destroy(); reject(new Error(`No helper answered on ${socketPath} within ${timeoutMs} ms.`)); }, timeoutMs);
			socket.once("connect", () => { clearTimeout(timer); resolve(new HelperClient(socket, options)); });
			socket.once("error", (error) => { clearTimeout(timer); reject(error); });
		});
	}

	constructor(socket, { maxResponseBytes = MAX_RESPONSE_LINE_BYTES, maxPending = MAX_CLIENT_PENDING, maxBacklogBytes = MAX_CLIENT_BACKLOG_BYTES } = {}) {
		this.socket = socket;
		this.pending = new Map();
		this.nextId = 1;
		this.maxPending = maxPending;
		this.maxBacklogBytes = maxBacklogBytes;
		this.reader = new LineReader(maxResponseBytes);
		socket.on("data", (chunk) => {
			if (this.failure) return;
			const { lines, overflow } = this.reader.push(chunk);
			for (const line of lines) {
				if (this.failure) return;
				let delivered;
				try {
					delivered = this.deliver(line);
				} catch {
					delivered = false;
				}
				if (!delivered) return this.fail(new Error("The helper sent a malformed response."));
			}
			if (overflow && !this.failure) this.fail(new Error(`A response from the helper was over ${maxResponseBytes} bytes.`));
		});
		socket.on("close", () => this.rejectAll(this.failure ?? new Error("The connection to the helper closed.")));
		socket.on("error", () => {});
	}

	/** Settles the request a response line answers; false if the line isn't a response. */
	deliver(line) {
		let response;
		try {
			response = JSON.parse(line);
		} catch {
			return false;
		}
		if (response === null || typeof response !== "object" || typeof response.ok !== "boolean") return false;
		// Only string fields are used; anything else in an error gets fixed text.
		const error = response.error !== null && typeof response.error === "object" ? response.error : {};
		const code = typeof error.code === "string" ? clip(error.code, 64) : "error";
		if (response.id === null && !response.ok) {
			// The helper couldn't read a request at all, so it can't say which.
			this.fail(new HelperRequestError(code, typeof error.message === "string" ? clip(error.message, 1024) : "The helper refused a request."));
			return true;
		}
		const waiter = this.pending.get(response.id);
		// Not pending: an answer that came after its request timed out.
		if (!waiter) return true;
		this.pending.delete(response.id);
		clearTimeout(waiter.timer);
		if (response.ok) {
			waiter.resolve(response.result);
		} else {
			waiter.reject(new HelperRequestError(code, typeof error.message === "string" ? error.message : "The helper refused the request.", error));
		}
		return true;
	}

	fail(error) {
		this.failure ??= error;
		this.socket.destroy();
		this.rejectAll(this.failure);
	}

	rejectAll(error) {
		for (const waiter of this.pending.values()) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.pending.clear();
	}

	request(op, params = {}, { timeoutMs = 60_000 } = {}) {
		if (this.failure || this.socket.destroyed) return Promise.reject(this.failure ?? new Error("The connection to the helper is closed."));
		if (this.pending.size >= this.maxPending) return Promise.reject(new Error(`Too many requests are waiting for the helper (${this.maxPending}).`));
		const id = this.nextId++;
		let line;
		try {
			line = JSON.stringify({ id, op, params }) + "\n";
		} catch (error) {
			return Promise.reject(error);
		}
		if (this.socket.writableLength + byteLength(line) > this.maxBacklogBytes) return Promise.reject(new Error("The helper isn't reading requests fast enough."));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`The helper didn't answer ${op} within ${timeoutMs} ms.`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.socket.write(line);
		});
	}

	close() {
		this.socket.end();
		this.socket.destroy();
	}
}

/** The CLI: one helper for one session, until signalled. */
async function main(argv) {
	const option = (name) => {
		const at = argv.indexOf(name);
		return at >= 0 ? argv[at + 1] : undefined;
	};
	const dir = option("--dir");
	const lfortran = option("--lfortran");
	const owner = process.env.PI_REPL_JUPYTER_OWNER;
	if (!dir || !lfortran || !HEX_ID.test(owner ?? "")) {
		process.stderr.write("usage: PI_REPL_JUPYTER_OWNER=<32 hex> repl-jupyter-helper.js --dir DIR --lfortran /abs/path/to/lfortran\n");
		process.exit(2);
	}
	const log = (line) => process.stderr.write(`pi-repl helper: ${line}\n`);
	const helper = new JupyterHelper({
		dir,
		launchId: owner,
		kernelCommand: (file) => [lfortran, ["kernel", "-f", file, "--managed"]],
		log,
	});
	let stopping = false;
	const shutdown = async (signal) => {
		if (stopping) return;
		stopping = true;
		log(`stopping (${signal})`);
		await helper.stop().catch(() => {});
		process.exit(0);
	};
	for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, () => shutdown(signal));
	try {
		await helper.start();
	} catch (error) {
		if (stopping) return;
		log(`failed to start: ${error.message}`);
		await helper.stop({ killKernel: true }).catch(() => {});
		process.exit(1);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
