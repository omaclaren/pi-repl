import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

test("pi-repl publishes a versioned clean record through tmux metadata", () => {
	assert.match(source, /REPL_SESSION_RECORD_ID_OPTION/);
	assert.match(source, /REPL_SESSION_RECORD_VERSION_OPTION/);
	assert.match(source, /set-option", "-qo"/);
	assert.match(source, /#\{session_id\}\\t#\{session_created\}/);
	assert.match(source, /ensureReplSessionRecord\(/);
	assert.match(source, /recordEntries: .*recordTail/);
});

test("repl_send holds the shared lease across execution and records its result", () => {
	assert.match(source, /acquireReplSessionSendLease\(/);
	assert.match(source, /owner: `pi-repl:/);
	assert.match(source, /const execution = await runReplCode\(pi, params, ctx, signal\)/);
	assert.match(source, /const sessionTarget = sessionInfo\.tmuxSessionId \|\| sessionName/);
	assert.match(source, /changed while repl_send was waiting to execute/);
	assert.match(source, /runReplCode\(pi, params, ctx, signal, identity, \(state\)/);
	assert.match(source, /pasteTextToTmuxPane\(pi, sessionTarget/);
	assert.match(source, /status: "captured"/);
	assert.match(source, /retainReplSendLeaseUntilSubmissionSettles/);
	assert.match(source, /!submissionState\.completionObserved/);
	assert.match(source, /await lease\.release\(\)\.catch/);
});

test("/repl export writes the canonical record without clobbering a file", () => {
	assert.match(source, /case "export":/);
	assert.match(source, /readReplSessionRecord\(/);
	assert.match(source, /renderReplSessionRecordMarkdown\(/);
	assert.match(source, /flag: "wx"/);
});
