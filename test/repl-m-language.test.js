import test from "node:test";
import assert from "node:assert/strict";
import { mStringLiteral, buildMLanguageControlSource, buildMLanguageDriverSource, buildMLanguageFinish } from "../shared/repl-m-language.js";
import { CURSOR_COLUMN_QUERY, boundedCursorColumnCommand } from "../shared/repl-cursor-column.js";
import { createReplSubmissionDisplay } from "../shared/repl-submission-display.js";

test("M-language strings quote ASCII and encode newlines, backslashes and Unicode as UTF-8", () => {
	assert.equal(mStringLiteral("a'b%"), "'a''b%'");
	for (const value of ["line\nnext\r\n", "λ 🧪", "path\\with\\slashes", "'); error('injection'); %\n"]) {
		const literal = mStringLiteral(value);
		const numbers = literal.match(/uint8\(\[([\d ]*)\]\)/)?.[1].split(" ").map(Number);
		assert.deepEqual(Buffer.from(numbers), Buffer.from(value));
		assert.match(literal, /native2unicode.*'UTF-8'/);
	}
});

for (const runtime of ["octave", "matlab"]) {
	test(`${runtime} has a base evaluator and function-local completion guard without path/cwd mutation`, () => {
		const display = createReplSubmissionDisplay({ entryId: "m-test", origin: "pi-repl", code: "clear all; 6*7", mode: "summary" });
		const source = buildMLanguageControlSource("clear all; 6*7", display);
		const driver = buildMLanguageDriverSource(runtime, "/tmp/m 'quote'/123.m", "/tmp/123.done", display);
		assert.match(source, /evalin\('base'/);
		assert.match(source, /catch pi_repl_error/);
		assert.match(source, /pi_repl_error.message/);
		assert.match(driver, /onCleanup\(/);
		assert.match(driver, /@\(pi_repl_error,pi_repl_guard\)/);
		assert.doesNotMatch(source + driver, /\b(?:cd|addpath|assignin|restoredefaultpath)\(/);
		assert.doesNotMatch(source + driver, /lasterr/);
	});
}

test("Off completion contains no cursor query or display source", () => {
	const display = createReplSubmissionDisplay({ entryId: "m-off", origin: "pi-repl", code: "1", mode: "off" });
	const source = buildMLanguageControlSource("1", display);
	const driver = buildMLanguageDriverSource("matlab", "/tmp/123.m", "/tmp/123.done", display);
	assert.doesNotMatch(source, /fprintf\(1/);
	assert.doesNotMatch(driver, /system\(|cursor_x|──|native2unicode/);
	assert.match(driver, /fclose\(fopen/);
});

test("the footer's helper is bounded, and Octave writes the done file even if the footer is interrupted", () => {
	const display = createReplSubmissionDisplay({ entryId: "m-finish", origin: "pi-repl", code: "1", mode: "summary" });
	const command = boundedCursorColumnCommand("/opt/node's/bin/node");
	assert.match(command, /^\/bin\/sh -c '/);
	assert.match(command, /perl -e '"'"'alarm shift; exec @ARGV or exit 1'"'"' 5 /);
	assert.doesNotMatch(command, /kill -9|; kill /);
	assert.match(command, /trap '"'"'rm -f "\$f"'"'"' EXIT; trap '"'"'exit 1'"'"' HUP INT TERM/);
	assert.match(command, /\[ "\$s" = 0 \]'$/);
	assert.match(command, /process\.exit\(code\)/);
	assert.match(command, /\/opt\/node'"'"'"'"'"'"'"'"'s\/bin\/node/);
	assert.match(CURSOR_COLUMN_QUERY, /writeSync\(1,[\s\S]*process\.exit\(code\)/);
	const octave = buildMLanguageFinish("octave", "/tmp/123.done", display).split("\n");
	assert.equal(octave[0], "unwind_protect");
	assert.deepEqual(octave.slice(-3), ["unwind_protect_cleanup", "fclose(fopen('/tmp/123.done','w'));", "end_unwind_protect"]);
	assert.ok(octave.some((line) => line.includes("system(") && line.includes("/bin/sh -c")));
	// MATLAB has no unwind_protect, and completes its cleanup action anyway.
	const matlab = buildMLanguageFinish("matlab", "/tmp/123.done", display).split("\n");
	assert.ok(!matlab.some((line) => /unwind_protect/.test(line)));
	assert.equal(matlab.at(-1), "fclose(fopen('/tmp/123.done','w'));");
	// With the display off there is no footer to interrupt.
	const off = createReplSubmissionDisplay({ entryId: "m-finish-off", origin: "pi-repl", code: "1", mode: "off" });
	assert.equal(buildMLanguageFinish("octave", "/tmp/123.done", off), "fclose(fopen('/tmp/123.done','w'));");
});
