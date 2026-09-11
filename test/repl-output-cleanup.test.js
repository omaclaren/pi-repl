import test from "node:test";
import assert from "node:assert/strict";
import { cleanupReplDelta } from "../index.ts";
import { buildGnuplotSubmissionLine } from "../shared/repl-gnuplot.js";
import { createReplSubmissionDisplay } from "../shared/repl-submission-display.js";

const gnuplotLoader = buildGnuplotSubmissionLine("/tmp/pi-repl-cocoa-check/controls/driver.cjs");
const displayFor = (mode) => createReplSubmissionDisplay({ entryId: "cleanup-regression", origin: "pi-repl", code: "print value", mode });
function capture(output, { mode, loader = gnuplotLoader, prompt = "gnuplot>", echo = true, nativeResult } = {}) {
	const display = displayFor(mode);
	const text = [
		...(echo ? [`${prompt} ${loader}`] : []), ...display.prefixLines,
		output, ...display.suffixLines, ...(nativeResult ? [nativeResult] : []), prompt,
	].join("\n");
	return cleanupReplDelta(text, loader, undefined, undefined, display);
}

for (const mode of ["off", "summary", "full"]) {
	test(`${mode}: retain diagnostics and user text resembling old loader hints`, () => {
		const outputs = [
			'         "/tmp/pi-repl-cocoa-check/controls/source.gp" line 1: undefined variable: missing_value',
			'Error: cannot read /tmp/pi-repl-custom/quoted \'λ\' file',
			...['/tmp/pr.py', '/tmp/jr.jl', '/tmp/rr.R', '/tmp/gr.ghci', '/tmp/cr.clj', 'control.py'].map(path => `Error in ${path}: meaningful diagnostic`),
			'exec(open("user-data.py").read())', 'run_cell(open("user-data.py").read())',
			'include("user-data.jl")', 'source("user-data.R")', ':script user-data.ghci', '(load-file "user-data.clj")',
			'eval(fileread(\'user-data.m\'));', ':pi-repl/silent',
			'# pi-repl: user text', '-- pi-repl: user text', ';; pi-repl: user text',
			`Error invoking ${gnuplotLoader}: meaningful diagnostic`,
			gnuplotLoader,
		];
		for (const output of outputs) {
			assert.equal(capture(output, { mode }), output, `lost output: ${output}`);
		}
	});

	test(`${mode}: a diagnostic containing the exact loader is not itself an echo`, () => {
		const output = `Error invoking ${gnuplotLoader}: meaningful diagnostic`;
		assert.equal(capture(output, { mode, echo: false }), output);
	});

	test(`${mode}: only the Clojure submission's one native result is stripped`, () => {
		const loader = '(do (load-file "/tmp/pc/source.clj") :pi-repl/silent)';
		assert.equal(capture(":pi-repl/silent", { mode, loader, prompt: "user=>", nativeResult: ":pi-repl/silent" }), ":pi-repl/silent");
	});
}

for (const [prompt, loader] of [
	[">>>", 'exec(open("/tmp/pc/source.py").read(),globals())'],
	["In [7]:", 'exec(open("/tmp/pc/source.py").read(),globals())'],
	["julia>", 'include("/tmp/pc/source.jl")'],
	[">", 'source("/tmp/pc/source.R",local=.GlobalEnv)'],
	["ghci>", ':script "/tmp/pc/driver.ghci"'],
	["irb(main):001:0>", "load '/tmp/pc/source.rb'; nil"],
	["jshell>", "/open /tmp/pc/driver.java"],
	["octave:1>", "eval(fileread('/tmp/pc/driver.m'));"],
	[">>", "eval(fileread('/tmp/pc/driver.m'));"],
	["gnuplot>", gnuplotLoader],
]) {
	test(`${prompt}: remove only this submission's loader echo`, () => {
		for (const mode of ["off", "summary", "full"]) {
			assert.equal(capture("42", { mode, prompt, loader }), "42");
			// A repeated command in the payload must survive even without markers.
			assert.equal(capture(loader, { mode, prompt, loader }), loader);
		}
		// R/input editors can join output or the display header onto the echo.
		assert.equal(cleanupReplDelta(`${prompt} ${loader}  user output  \n${prompt}`, loader), "  user output  ");
		const display = displayFor("summary");
		const joined = [`${prompt} ${loader}${display.beginMarker}`, ...display.previewLines, display.outputMarker, "42", ...display.suffixLines, prompt].join("\n");
		assert.equal(cleanupReplDelta(joined, loader, undefined, undefined, display), "42");
	});
}

test("display boundaries protect prompt-looking payload and surrounding spaces", () => {
	const output = ">\n  /tmp/pi-repl-user/output  \n\nsource(\"data.R\")\ngnuplot>";
	for (const mode of ["summary", "full"]) assert.equal(capture(output, { mode }), output);
});

test("remove a supplied preview comment before the loader, not arbitrary comment-like output", () => {
	const loader = 'exec(open("/tmp/pc/source.py").read(),globals())';
	const preview = "# pi-repl: exact preview";
	const raw = [preview, `>>> ${loader}`, preview, ">>>"].join("\n");
	assert.equal(cleanupReplDelta(raw, loader, preview), preview);
});

test("legacy display and incomplete display prefixes still preserve diagnostics", () => {
	const display = displayFor("summary");
	const output = 'Error: source("/tmp/pi-repl-data/file.R")';
	const legacy = { ...display,
		beginMarker: `── pi-repl submitted · 1 line · ${display.anchorId} ──`,
		outputMarker: `── pi-repl output · ${display.anchorId} ──`,
		endMarker: `── pi-repl complete · ${display.anchorId} ──`,
	};
	legacy.prefixLines = [legacy.beginMarker, "│ print value", legacy.outputMarker];
	legacy.suffixLines = [legacy.endMarker];
	for (const [shown, prefix] of [[legacy, legacy.prefixLines], [display, display.prefixLines.slice(0, -1)]]) {
		const raw = [`gnuplot> ${gnuplotLoader}`, ...prefix, output, ...shown.suffixLines, "gnuplot>"].join("\n");
		assert.equal(cleanupReplDelta(raw, gnuplotLoader, undefined, undefined, shown), output);
	}
});
