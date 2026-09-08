import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function getPrivateReplHistoryRoot() {
	const uid = typeof process.getuid === "function" ? process.getuid() : "user";
	return join(tmpdir(), `pi-repl-history-${uid}`);
}

/** Allocate a private raw log without reusing or truncating a prior session's log. */
export function createPrivateReplHistoryFile(sessionName, root = getPrivateReplHistoryRoot()) {
	if (typeof sessionName !== "string" || !/^[a-z0-9-]{1,100}$/.test(sessionName)) {
		throw new Error("Invalid REPL history session name.");
	}
	try {
		mkdirSync(root, { mode: 0o700 });
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
	}
	const info = lstatSync(root);
	if (!info.isDirectory() || info.isSymbolicLink()) {
		throw new Error(`REPL history root is not a real directory: ${root}`);
	}
	if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
		throw new Error(`REPL history root is not owned by the current user: ${root}`);
	}
	if (process.platform !== "win32" && (info.mode & 0o777) !== 0o700) {
		throw new Error(`REPL history root must have mode 0700: ${root}`);
	}

	// The random, exclusively created filename isolates session lifetimes and
	// tmux servers, even when their session names/IDs/creation seconds coincide.
	const path = join(root, `${sessionName}-${randomUUID()}.history.log`);
	closeSync(openSync(path, "wx", 0o600));
	return path;
}
