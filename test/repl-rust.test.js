import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	RUST_PROMPT, createRustLaunch, isRustPromptRow, prepareRustCell, removeRustConfigDir, rowsFromRustEcho,
	rustCellMarker, rustCellOutput, rustCellProgress, rustEchoState, rustPasteState, rustWatchStep, sttyReadArgs, sttyShowsRawMode,
} from "../shared/repl-rust.js";

const marker = rustCellMarker("0123456789ab");

test("a Rust cell gets the marker line, \\n line endings and no trailing blank lines", () => {
	assert.equal(marker, "// pi-repl 0123456789ab");
	assert.equal(prepareRustCell("let a = 1;\r\nlet b = 2;\r\n\r\n", "0123456789ab"), `${marker}\nlet a = 1;\nlet b = 2;`);
	assert.equal(prepareRustCell("\tlet s = \"é\";  ", "0123456789ab"), `${marker}\n\tlet s = "é";`);
});

test("a Rust cell that a paste would turn into terminal input is refused before anything is made", () => {
	for (const code of ["let a = 1;\u001b[201~", "a\u0000b", "a\u0003", "a\u009bb", "a b"]) {
		assert.throws(() => prepareRustCell(code, "0123456789ab"), /control characters/);
	}
	assert.throws(() => prepareRustCell(" \n\t", "0123456789ab"), /non-empty code/);
	assert.throws(() => prepareRustCell("x".repeat(1024 * 1024 + 1), "0123456789ab"), /1 MiB/);
});

test("evcxr's prompt rows: empty, or with something typed, but not indented code", () => {
	for (const row of [">>", ">> ", ">> let x = 1;"]) assert.equal(isRustPromptRow(row), true, row);
	for (const row of ["", "    >> 2;", "x >> 2", ">>2", "Error: x"]) assert.equal(isRustPromptRow(row), false, row);
	assert.equal(RUST_PROMPT.test(">> "), true);
	assert.equal(RUST_PROMPT.test(">> let x"), false);
});

test("the echo is found from the last row showing the cell's marker at the prompt", () => {
	const capture = `>> ${marker}\nold\n>> 1 + 1\n2\n>> ${marker}\nlet a = 1;\n>> \n\n`;
	assert.deepEqual(rowsFromRustEcho(capture, marker), [`>> ${marker}`, "let a = 1;", ">> ", "", ""]);
	assert.equal(rowsFromRustEcho(">> other\n", marker), undefined);
});

test("the echo state tells a drawn paste from a partial one, someone's typing and any change", () => {
	const cell = `${marker}\nfn f() -> u32 {\n\t1\n}`;
	assert.equal(rustEchoState([`>> ${marker}`, "fn f() -> u32 {", "\t1", "}", "", ""], cell), "drawn");
	assert.equal(rustEchoState([`>> ${marker}`, "fn f() -> u32 {", "", ""], cell), "partial");
	assert.equal(rustEchoState([`>> ${marker}`, "fn f() -> u", ""], cell), "partial");
	assert.equal(rustEchoState(undefined, cell), "partial");
	// Exact: a tab drawn as spaces, or text after the cell, is a change.
	assert.equal(rustEchoState([`>> ${marker}`, "fn f() -> u32 {", "    1", "}"], cell), "different");
	assert.equal(rustEchoState([`>> ${marker}`, "fn f() -> u32 {", "\t1", "}", "x"], cell), "different");
	// A half-typed line puts its text before the paste on the prompt row.
	assert.equal(rustPasteState(`>> let half = 1${marker}\nfn f() -> u32 {\n\t1\n}\n`, marker, cell), "different");
	assert.equal(rustPasteState(">> \n", marker, cell), "partial");
	assert.equal(rustPasteState(`>> ${marker}\nfn f() -> u32 {\n\t1\n}\n\n`, marker, cell), "drawn");
});

test("whitespace in strings and the line after a comment must match exactly (Astra's review, issue 3)", () => {
	const spaced = prepareRustCell('let s = "a b";', "0123456789ab");
	assert.equal(rustEchoState([`>> ${marker}`, 'let s = "ab";'], spaced), "different");
	assert.equal(rustEchoState([`>> ${marker}`, 'let s = "a  b";'], spaced), "different");
	assert.equal(rustEchoState([`>> ${marker}`, 'let s = "a b";'], spaced), "drawn");
	const commented = prepareRustCell("// note\nlet x = 1;", "0123456789ab");
	assert.equal(rustEchoState([`>> ${marker}`, "// notelet x = 1;"], commented), "different");
	assert.equal(rustEchoState([`>> ${marker}`, "// note let x = 1;", ""], commented), "different");
});

test("a cell's progress is judged by what follows its echo, so a bare >> line in it can't stop completion (issue 2)", () => {
	const cell = prepareRustCell("let n = 8\n>>\n1;\nn", "0123456789ab");
	const echo = [`>> ${marker}`, "let n = 8", ">>", "1;", "n"];
	assert.equal(rustCellProgress([...echo, "", ""], cell), "waiting");
	assert.equal(rustCellProgress([...echo, "4", ""], cell), "other");
	assert.equal(rustCellProgress([...echo, "4", ">> ", "", ""], cell), "finished");
	assert.equal(rustCellOutput([...echo, "4", ">> ", "", ""], cell), "4");
	// The echo as sent, or nothing to judge by.
	assert.equal(rustCellProgress([`>> ${marker}`, "let n = 9", ">>", "1;", "n", ">> "], cell), "unknown");
	assert.equal(rustCellProgress(undefined, cell), "unknown");
});

test("the watcher presses Enter only into its own unfinished cell, never into someone's next input (issue 1)", () => {
	const cell = prepareRustCell("1 + 1", "0123456789ab");
	const echo = [`>> ${marker}`, "1 + 1"];
	// The cell finished and the person has started a multi-line cell at the new prompt.
	const human = [...echo, "2", ">> fn later() {", "    let human_value = 7;", ""];
	assert.equal(rustCellProgress(human, cell), "finished");
	assert.equal(rustCellOutput(human, cell), "2");
	// The person typing on the unfinished cell's continuation row: not ours to send.
	assert.equal(rustCellProgress([...echo, "  let human_value = 7;", ""], cell), "other");
	const step = (fields) => rustWatchStep({ raw: true, progress: "waiting", cursorPrompt: false, sawCooked: false, waitingMs: 0, extraEnters: 0, ...fields });
	assert.equal(step({ progress: "other", waitingMs: 60_000 }), "wait");
	assert.equal(step({ progress: "unknown", waitingMs: 60_000 }), "wait");
	assert.equal(step({ waitingMs: 999 }), "wait");
	assert.equal(step({ waitingMs: 1_000 }), "enter");
	assert.equal(step({ waitingMs: 399, extraEnters: 1 }), "wait");
	assert.equal(step({ waitingMs: 400, extraEnters: 1 }), "enter");
	assert.equal(step({ waitingMs: 60_000, extraEnters: 2 }), "wait");
	// Completion needs raw mode, and a prompt after the echo, or with the echo gone, a cell seen running.
	assert.equal(step({ progress: "finished" }), "done");
	assert.equal(step({ progress: "finished", raw: false }), "wait");
	assert.equal(step({ progress: "unknown", cursorPrompt: true }), "wait");
	assert.equal(step({ progress: "unknown", cursorPrompt: true, sawCooked: true }), "done");
	assert.equal(step({ progress: "other", cursorPrompt: true, sawCooked: true }), "wait");
});

test("a finished cell's output is the rows after its echo, up to evcxr's current prompt", () => {
	const cell = `${marker}\nlet q = 5;\nq * 2`;
	const rows = (...tail) => [`>> ${marker}`, "let q = 5;", "q * 2", ...tail];
	assert.equal(rustCellOutput(rows("10", ">> ", "", ""), cell), "10");
	assert.equal(rustCellOutput(rows(">> "), cell), "");
	// Someone has started typing at the new prompt: that isn't output.
	assert.equal(rustCellOutput(rows("10", ">> let y"), cell), "10");
	assert.equal(rustCellOutput(rows("10", ">> fn h() {", "    1"), cell), "10");
	// A queued cell of the person's ran first: it stays, as for the other runtimes.
	assert.equal(rustCellOutput(rows("10", ">> 3 + 4", "7", ">> "), cell), "10\n>> 3 + 4\n7");
	assert.equal(rustCellOutput(rows("Error: x", "   ╭─[ command:1:1 ]", "───╯", ">>"), cell), "Error: x\n   ╭─[ command:1:1 ]\n───╯");
	assert.equal(rustCellOutput([">> other", "10", ">> "], cell), undefined);
	assert.equal(rustCellOutput(undefined, cell), undefined);
});

test("stty output: raw mode is -icanon, on macOS and Linux", () => {
	assert.equal(sttyShowsRawMode("lflags: -icanon -isig -iexten -echo -echoe echok echoke\n\t-echonl echoctl"), true);
	assert.equal(sttyShowsRawMode("lflags: icanon isig iexten echo echoe -echok echoke"), false);
	assert.equal(sttyShowsRawMode("isig -icanon iexten -echo echoe echok"), true);
	assert.equal(sttyShowsRawMode(""), false);
	assert.deepEqual(sttyReadArgs("/dev/ttys009", "darwin"), ["-f", "/dev/ttys009", "-a"]);
	assert.deepEqual(sttyReadArgs("/dev/pts/3", "linux"), ["-F", "/dev/pts/3", "-a"]);
});

function withTmpdir(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-repl-rust-test-"));
	const original = process.env.TMPDIR;
	process.env.TMPDIR = root;
	t.after(() => {
		if (original === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = original;
		rmSync(root, { recursive: true, force: true });
	});
	return root;
}

test("the launch script copies the person's startup files and history, then runs evcxr with the private folder", (t) => {
	const root = withTmpdir(t);
	const launch = createRustLaunch("linux");
	assert.equal(launch.dir.startsWith(join(root, "pi-repl-rust-")), true);
	assert.equal(statSync(launch.dir).mode & 0o777, 0o700);
	assert.equal(launch.command, `exec /bin/sh '${launch.script}'`);
	const home = join(root, "home");
	const settings = join(home, "settings");
	mkdirSync(settings, { recursive: true });
	writeFileSync(join(settings, "init.evcxr"), ":opt 1\n");
	writeFileSync(join(settings, "prelude.rs"), "let from_prelude = 11;\n");
	writeFileSync(join(settings, "history.txt"), "1 + 1\n");
	writeFileSync(join(settings, "other.txt"), "not copied\n");
	const bin = join(root, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "evcxr"), '#!/bin/sh\necho "dir=$EVCXR_CONFIG_DIR"\nls "$EVCXR_CONFIG_DIR"\n', { mode: 0o700 });
	const run = (env) => execFileSync("/bin/sh", [launch.script], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...env }, encoding: "utf8" });
	assert.equal(run({ EVCXR_CONFIG_DIR: settings }), `dir=${launch.dir}\nhistory.txt\ninit.evcxr\npi-repl-launch.sh\nprelude.rs\n`);
	assert.equal(readFileSync(join(launch.dir, "prelude.rs"), "utf8"), "let from_prelude = 11;\n");
	// Without EVCXR_CONFIG_DIR, evcxr's own default on Linux; missing files are skipped.
	rmSync(join(launch.dir, "prelude.rs"));
	mkdirSync(join(home, ".config", "evcxr"), { recursive: true });
	writeFileSync(join(home, ".config", "evcxr", "prelude.rs"), "let linux = 1;\n");
	run({});
	assert.equal(readFileSync(join(launch.dir, "prelude.rs"), "utf8"), "let linux = 1;\n");
	const mac = createRustLaunch("darwin");
	assert.match(readFileSync(mac.script, "utf8"), /src="\$\{EVCXR_CONFIG_DIR:-\$HOME\/Library\/Application Support\/evcxr\}"/);
});

test("only a settings folder this module made is removed", (t) => {
	const root = withTmpdir(t);
	const launch = createRustLaunch();
	assert.equal(removeRustConfigDir(launch.dir), true);
	assert.equal(existsSync(launch.dir), false);
	const other = mkdtempSync(join(root, "someone-else-"));
	assert.equal(removeRustConfigDir(other), false);
	const nested = join(root, "nested");
	mkdirSync(nested);
	const deep = mkdtempSync(join(nested, "pi-repl-rust-"));
	assert.equal(removeRustConfigDir(deep), false);
	const target = mkdtempSync(join(root, "target-"));
	const link = join(root, "pi-repl-rust-link");
	symlinkSync(target, link);
	assert.equal(removeRustConfigDir(link), false);
	assert.equal(existsSync(target), true);
	for (const value of [undefined, "", 7]) assert.equal(removeRustConfigDir(value), false);
});
