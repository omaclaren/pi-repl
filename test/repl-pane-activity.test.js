import test from "node:test";
import assert from "node:assert/strict";
import {
	PANE_ACTIVITY_MAX_LINES,
	decodePaneActivityMark,
	describePaneActivity,
	encodePaneActivityMark,
	markPaneActivity,
	paneActivitySince,
} from "../shared/repl-pane-activity.js";

const SEND = [
	">>> exec(open('/tmp/pi-rc-x/abc.py').read(),globals())",
	"",
	"── pi-repl · input · 1 line · id: abc ──",
	"print(2)",
	"── output ──",
	"2",
	"── done · id: abc ──",
	"",
];

test("a mark keeps the send's last lines and the prompt after them, if drawn", () => {
	assert.deepEqual(markPaneActivity([...SEND, ">>> ", "", ""].join("\n")), {
		anchor: ["── output ──", "2", "── done · id: abc ──"],
		prompt: ">>>",
	});
	// Captured before the REPL drew its next prompt.
	assert.deepEqual(markPaneActivity(SEND.join("\n")), { anchor: ["── output ──", "2", "── done · id: abc ──"], prompt: "" });
	assert.equal(markPaneActivity("\n\n"), undefined);
	// A quiet start leaves only the prompt, so activity counts from the top.
	const quiet = markPaneActivity(">>> \n\n");
	assert.deepEqual(quiet, { anchor: [], prompt: ">>>" });
	assert.deepEqual(paneActivitySince(">>> a = 1\n>>> a\n1\n>>> ", quiet).lines, [">>> a = 1", ">>> a", "1"]);
	assert.deepEqual(decodePaneActivityMark(encodePaneActivityMark(quiet)), quiet);
});

test("activity is what follows the mark, without idle prompts", () => {
	const mark = markPaneActivity([...SEND, ">>> "].join("\n"));
	const typed = [...SEND, ">>> a = 1", ">>> b = 3", ">>> a + b", "4", ">>> ", "", ""].join("\n");
	assert.deepEqual(paneActivitySince(typed, mark), { located: true, lines: [">>> a = 1", ">>> b = 3", ">>> a + b", "4"] });
	assert.deepEqual(paneActivitySince([...SEND, ">>> ", ""].join("\n"), mark), { located: true, lines: [] });
	// Input left unfinished at the prompt is reported too.
	assert.deepEqual(paneActivitySince([...SEND, ">>> x = "].join("\n"), mark).lines, [">>> x ="]);
});

test("a prompt drawn after the mark is not reported as activity", () => {
	const mark = markPaneActivity(SEND.join("\n"));
	assert.deepEqual(paneActivitySince([...SEND, "julia> ", ""].join("\n"), mark).lines, []);
	assert.deepEqual(paneActivitySince([...SEND, ">>> y = 2", ">>> "].join("\n"), mark).lines, [">>> y = 2"]);
});

test("the last place the mark appears counts, and a lost mark is reported as such", () => {
	const mark = { anchor: ["4"], prompt: ">>>" };
	assert.deepEqual(paneActivitySince(["4", ">>> z = 1", "4", ">>> "].join("\n"), mark).lines, []);
	assert.deepEqual(paneActivitySince("nothing like it\n>>> ", mark), { located: false, lines: [] });
	assert.match(describePaneActivity({ located: false, lines: [] }), /can't place/);
});

test("marks survive the tmux option round trip, and anything else is refused", () => {
	const mark = { anchor: ["── done · id: abc ──", "λ \"quoted\" #{raise}"], prompt: ">>>" };
	const encoded = encodePaneActivityMark(mark);
	assert.match(encoded, /^[A-Za-z0-9+/=]+$/);
	assert.deepEqual(decodePaneActivityMark(encoded), mark);
	for (const value of [undefined, "", "not base64 json", Buffer.from('{"anchor":[],"prompt":""}').toString("base64"), Buffer.from('{"anchor":[1],"prompt":""}').toString("base64")]) {
		assert.equal(decodePaneActivityMark(value), undefined);
	}
});

test("the report is bounded to the most recent lines", () => {
	assert.equal(describePaneActivity({ located: true, lines: [] }), undefined);
	const short = describePaneActivity({ located: true, lines: [">>> a = 1"] });
	assert.equal(short, "Since the last completed send, the pane shows (typed directly, another client's sends, or late output of a send that timed out):\n>>> a = 1");
	const lines = Array.from({ length: PANE_ACTIVITY_MAX_LINES + 5 }, (_, i) => `line ${i}`);
	const long = describePaneActivity({ located: true, lines });
	assert.match(long, /\[5 earlier lines omitted/);
	assert.ok(long.endsWith(`line ${PANE_ACTIVITY_MAX_LINES + 4}`));
	assert.ok(!long.includes("line 4\n"));
	const wide = describePaneActivity({ located: true, lines: ["x".repeat(3000), "y".repeat(3000)] });
	assert.ok(wide.endsWith("y".repeat(3000)) && !wide.includes("x".repeat(3000)));
});
