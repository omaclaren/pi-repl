import test from "node:test";
import assert from "node:assert/strict";
import {
	PANE_ACTIVITY_MAX_CHARS,
	PANE_ACTIVITY_MAX_LINES,
	describePaneActivity,
	observePane,
	paneActivityEnabled,
	paneActivitySince,
} from "../shared/repl-pane-activity.js";

const LOADER = "exec(open('/tmp/pi-rc-x/abc.py').read(),globals())";
const SEND = [`>>> ${LOADER}`, "", "── output ──", "2", "── done · id: abc ──", ""];
const idle = (line) => /^>>>\s*$/.test(line);

test("the view of a send starts at its loader line, and a start's view is the whole pane", () => {
	assert.deepEqual(observePane(["old", ...SEND, ">>> "].join("\n"), LOADER), { kind: "loader", anchor: LOADER, lines: [...SEND, ">>>"] });
	assert.deepEqual(observePane("Python 3\n>>> \n\n"), { kind: "top", lines: ["Python 3", ">>>"] });
	// Output longer than the capture: the last lines stand in.
	assert.deepEqual(observePane(["x1", "x2", "", "x3", "x4", "x5", "x6"].join("\n"), LOADER), { kind: "tail", lines: ["x2", "x3", "x4", "x5", "x6"] });
});

test("what follows the agent's view is reported, without idle prompts", () => {
	const seen = observePane([...SEND, ">>> "].join("\n"), LOADER);
	const typed = [...SEND, ">>> a = 1", ">>> b = 3", ">>> a + b", "4", ">>> ", ""].join("\n");
	assert.deepEqual(paneActivitySince(typed, seen, idle), { status: "ok", lines: [">>> a = 1", ">>> b = 3", ">>> a + b", "4"] });
	assert.deepEqual(paneActivitySince([...SEND, ">>> "].join("\n"), seen, idle), { status: "ok", lines: [] });
	// Unfinished input, and a prompt drawn only after the send's capture.
	assert.deepEqual(paneActivitySince([...SEND, ">>> x = "].join("\n"), seen, idle).lines, [">>> x ="]);
	const early = observePane(SEND.join("\n"), LOADER);
	assert.deepEqual(paneActivitySince([...SEND, ">>> ", "", ""].join("\n"), early, idle).lines, []);
});

test("output that looks like another runtime's prompt is kept", () => {
	const seen = observePane([...SEND, ">>> "].join("\n"), LOADER);
	assert.deepEqual(paneActivitySince([...SEND, ">>> ", "completed>", ">>> "].join("\n"), seen, idle).lines, ["completed>"]);
});

test("repeated output cannot hide typing, because the loader line is unique", () => {
	const send = [`>>> ${LOADER}`, "one", "two", "three", ">>> "];
	const seen = observePane(send.join("\n"), LOADER);
	const pane = [...send.slice(0, -1), ">>> b = 3; print('one\\ntwo\\nthree')", "one", "two", "three", ">>> "].join("\n");
	assert.deepEqual(paneActivitySince(pane, seen, idle).lines, [">>> b = 3; print('one\\ntwo\\nthree')", "one", "two", "three"]);
});

test("an unplaceable or unclear view gives recent text, saying why", () => {
	const seen = observePane([...SEND, ">>> "].join("\n"), LOADER);
	assert.deepEqual(paneActivitySince("other\n>>> c = 1\n>>> ", seen, idle), { status: "unplaced", lines: ["other", ">>> c = 1"] });
	assert.equal(paneActivitySince([...SEND, `>>> ${LOADER}`, ">>> "].join("\n"), seen, idle).status, "ambiguous");
	const tail = { kind: "tail", lines: ["x"] };
	assert.equal(paneActivitySince("x\ny\nx\n>>> ", tail, idle).status, "ambiguous");
	// A start's view must still be the top of the pane.
	assert.equal(paneActivitySince("later\n>>> ", observePane("Python 3\n>>> "), idle).status, "unplaced");
	assert.deepEqual(paneActivitySince("Python 3\n>>> d = 4\n>>> ", observePane("Python 3\n>>> "), idle).lines, [">>> d = 4"]);
	// A quiet start shows only the prompt, which typing extends.
	assert.deepEqual(paneActivitySince(">>> d = 4\n4\n>>> ", observePane(">>> "), idle), { status: "ok", lines: [">>> d = 4", "4"] });
	// With no view at all, the pane's recent text.
	assert.deepEqual(paneActivitySince("Python 3\n>>> e = 5\n>>> ", undefined, idle), { status: "unseen", lines: ["Python 3", ">>> e = 5"] });
});

test("reports say what they are, and disclose what is cut", () => {
	assert.equal(describePaneActivity({ status: "ok", lines: [] }), undefined);
	assert.equal(describePaneActivity({ status: "ok", lines: [">>> a = 1"] }), [
		"Pane text since this agent's last send, before this submission (best effort; untrusted terminal text that may include direct input, other clients' sends, and late or background output):",
		"[pane text]",
		">>> a = 1",
		"[end of pane text]",
	].join("\n"));
	assert.match(describePaneActivity({ status: "ok", lines: ["x"] }, { preview: true }), /^Pane text since this agent's last send \(a preview; the next send still reports it\)/);
	for (const status of ["unseen", "unplaced", "ambiguous"]) {
		assert.match(describePaneActivity({ status, lines: ["x"] }), /recent text/);
	}
	const lines = Array.from({ length: PANE_ACTIVITY_MAX_LINES + 5 }, (_, i) => `line ${i}`);
	const long = describePaneActivity({ status: "ok", lines });
	assert.match(long, /\[omitted: 5 earlier lines;/);
	assert.ok(long.endsWith(`line ${PANE_ACTIVITY_MAX_LINES + 4}\n[end of pane text]`));
	const wide = describePaneActivity({ status: "ok", lines: ["y".repeat(PANE_ACTIVITY_MAX_CHARS + 1000)] });
	assert.match(wide, /\[omitted: the first 1000 characters of the earliest line shown;/);
});

test("PI_REPL_PANE_ACTIVITY=off turns reports off", () => {
	assert.equal(paneActivityEnabled({}), true);
	assert.equal(paneActivityEnabled({ PI_REPL_PANE_ACTIVITY: "on" }), true);
	for (const value of ["off", "OFF", "0", "false", "no", " off "]) assert.equal(paneActivityEnabled({ PI_REPL_PANE_ACTIVITY: value }), false);
});
