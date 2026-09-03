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
	assert.match(source, /const execution = await runReplCode\(pi, params, ctx, signal, \{ submissionId \}\)/);
	assert.match(source, /const sessionTarget = sessionInfo\.tmuxSessionId \|\| sessionName/);
	assert.match(source, /changed while repl_send was waiting to execute/);
	assert.match(source, /runReplCode\(pi, params, ctx, signal, \{[\s\S]*?expectedSession: identity,[\s\S]*?onSubmissionStarted:/);
	assert.match(source, /pasteTextToTmuxPane\(pi, sessionTarget/);
	assert.match(source, /status: "captured"/);
	assert.match(source, /retainReplSubmissionUntilSettled/);
	assert.match(source, /!submissionState\.completionObserved/);
	assert.match(source, /await lease\.release\(\)\.catch/);
});

test("repl_send uses compact private request-unique control files and cleans them after settlement", () => {
	assert.match(source, /createPrivateReplControlFiles\(\{/);
	assert.match(source, /getReplControlExtension\(runtime\)/);
	assert.match(source, /cleanupPrivateReplControlFiles\(state\.prepared\.controlPaths\)/);
	assert.match(source, /retainReplSubmissionUntilSettled\(pi, submissionState, lease\)/);
	assert.doesNotMatch(source, /sourceFile: join\(REPL_CONTROL_ROOT, "pr\.py"\)/);
});

test("repl_send emits bounded pane echoes with clean-record-derived anchors", () => {
	assert.match(source, /createReplSubmissionDisplay\(\{/);
	assert.match(source, /entryId: details\.submissionId/);
	assert.match(source, /origin: "pi-repl"/);
	assert.match(source, /stripReplSubmissionDisplay\(delta, display\)/);
	assert.match(source, /submissionId = `pi-repl:\$\{metadata\.requestId\}`/);
	assert.match(source, /\/repl echo \[off\|summary\|full\]/);
	assert.match(source, /PI_REPL_ECHO_MODE/);
	assert.match(source, /Submitted-code display is off by default/);
	assert.match(source, /Full mode writes bounded submitted source code into persistent raw terminal history/);
	assert.match(source, /"capture-pane", "-J", "-p"/);
	assert.match(source, /captureContext\.prepared\.display/);
});

test("/repl export writes the canonical record without clobbering a file", () => {
	assert.match(source, /case "export":/);
	assert.match(source, /readReplSessionRecord\(/);
	assert.match(source, /renderReplSessionRecordMarkdown\(/);
	assert.match(source, /flag: "wx"/);
});
