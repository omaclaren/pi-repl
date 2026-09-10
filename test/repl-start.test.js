import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import register from "../index.ts";

const originalTmp = process.env.TMPDIR;
const root = mkdtempSync(join(tmpdir(), "pi-repl-start-"));
process.env.TMPDIR = root;
after(() => {
	if (originalTmp === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmp;
	rmSync(root, { recursive: true, force: true });
});

const runtimes = [
	["python", "python", ">>>"], ["ipython", "ipython", "In [1]:"],
	["julia", "julia", "julia>"], ["r", "R", ">"], ["ghci", "ghci", "ghci>"],
	["clojure", "clojure", "user=>"], ["ruby", "irb", "irb(main):001:0>"], ["java", "jshell", "jshell>"],
	["octave", "octave-cli --quiet --interactive", "octave:1>"], ["matlab", "matlab -nodesktop -nosplash", ">>"],
	["gnuplot", "gnuplot", "gnuplot>"],
];

function fixture({ runtime = "python", exists = false, prompt = ">>>", ...options } = {}) {
	const tools = new Map(), commands = new Map(), calls = [], notifications = [];
	const sessionName = `pi-repl-${runtime === "ipython" ? "python" : runtime}`;
	// Invalid legacy record metadata is deliberately left untouched, keeping
	// these portable routing tests independent of shared-record disk fixtures.
	const metadata = new Map([["@pi_repl_record_id", "invalid-legacy-id"], ["@pi_repl_runtime", runtime]]);
	const state = { exists, runtime, prompt, sessionName, id: "$7", createdAt: 123, ...options };
	register({
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: (name, command) => commands.set(name, command),
		async exec(command, args) {
			calls.push({ command, args: [...args] });
			const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
			const fail = (stderr = "test: missing session") => ({ code: 1, stdout: "", stderr });
			if (command !== "tmux") return state.noTmux ? fail() : ok();
			if (args[0] === "has-session") return state.exists ? ok() : fail();
			if (args[0] === "new-session") {
				if (state.raceWinner) {
					state.exists = true;
					return fail("duplicate session");
				}
				if (state.createFailure) return fail("permission denied");
				if (state.exists) return fail("duplicate session");
				state.exists = !state.dieAfterCreate;
				state.afterCreate?.();
				return ok(state.id);
			}
			if (args[0] === "list-panes") return state.exists ? ok("1\t1\t%9") : fail();
			if (args[0] === "display-message") {
				if (args.at(-1) === "#{cursor_y}") return ok("3");
				return ok(`${sessionName}\t${state.id}\t${state.createdAt}\t${runtime}\t${root}`);
			}
			if (args[0] === "capture-pane") {
				if (args.includes("-E")) {
					state.onPrompt?.();
					return ok(Array.isArray(state.prompt) ? (state.prompt.length > 1 ? state.prompt.shift() : state.prompt[0]) : state.prompt);
				}
				return ok(state.tail ?? "test banner\nold prompt >>>");
			}
			if (args[0] === "show-options") return metadata.has(args.at(-1)) ? ok(metadata.get(args.at(-1))) : fail();
			if (args[0] === "set-option") { metadata.set(args.at(-2), args.at(-1)); return ok(); }
			if (args[0] === "pipe-pane") return state.historyFailure ? fail("pipe failure") : ok();
			throw new Error(`Unexpected tmux mutation: ${args.join(" ")}`);
		},
	});
	const ctx = { cwd: root, hasUI: true, ui: { notify: (message, level) => notifications.push({ message, level }) } };
	return {
		tools, state, metadata, calls, notifications,
		start: (params = { runtime }, signal) => tools.get("repl_start").execute("test", params, signal, undefined, { cwd: root }),
		command: (args, name = "repl") => commands.get(name).handler(args, ctx),
	};
}

for (const [runtime, executable, prompt] of runtimes) {
	test(`repl_start creates ${runtime} and commands reuse the same session without mutations`, async () => {
		const f = fixture({ runtime, prompt });
		const result = await f.start();
		assert.equal(result.details.created, true);
		assert.equal(result.details.reused, false);
		assert.equal(result.details.ready, true);
		assert.equal(result.details.runtime, runtime);
		assert.equal(result.details.session.running, true);
		assert.equal(result.details.session.currentPath, root);
		assert.equal(result.details.attachCommand, `tmux attach -t ${f.state.sessionName}`);
		assert.match(result.content[0].text, /normal prompt observed/);
		const launch = f.calls.find((call) => call.args[0] === "new-session");
		assert.ok(launch.args.includes(f.state.sessionName));
		assert.ok(launch.args.includes(root));
		assert.match(launch.args.at(-1), new RegExp(` -i -l -c '${executable}${runtime === "matlab" ? " -sd " : "'$"}`));
		const pipe = f.calls.find((call) => call.args[0] === "pipe-pane");
		assert.ok(pipe.args.includes("%9"));
		assert.ok(pipe.args.at(-1).includes(f.state.sessionName));
		assert.ok(f.calls.filter((call) => call.args[0] === "set-option").every((call) => call.args.includes("$7")));
		const metadata = [...f.metadata];
		const count = f.calls.length;
		const again = await f.start();
		assert.equal(again.details.reused, true);
		assert.equal(again.details.created, false);
		await f.command(runtime === "clojure" ? "clj" : runtime, "lab");
		assert.match(f.notifications.at(-1).message, /already running; reused without restarting/);
		assert.deepEqual([...f.metadata], metadata);
		assert.ok(f.calls.slice(count).every((call) => !["new-session", "pipe-pane", "set-option", "send-keys", "load-buffer"].includes(call.args[0])));
	});
}

test("repl_start requires a canonical explicit runtime; no send auto-start or destructive tools", async () => {
	const f = fixture();
	const schema = f.tools.get("repl_start").parameters;
	assert.ok(schema.required.includes("runtime"));
	assert.deepEqual(schema.properties.runtime.enum, runtimes.map(([runtime]) => runtime));
	assert.equal(schema.properties.runtime.anyOf, undefined);
	for (const runtime of [undefined, "", "bun", "unknown", "irb", "jshell"]) {
		await assert.rejects(f.start({ runtime }), /explicit supported runtime/);
	}
	assert.equal(f.calls.length, 0);
	assert.deepEqual([...f.tools.keys()].sort(), ["repl_send", "repl_start", "repl_status"]);
	await assert.rejects(f.tools.get("repl_send").execute("test", { code: "print(1)" }, undefined, undefined, { cwd: root }), /No default/);
	assert.equal(f.calls.some((call) => call.args[0] === "new-session"), false);
});

test("existing Python/IPython runtime, cwd, logging and metadata survive a different interpreter request", async () => {
	const f = fixture({ runtime: "ipython", exists: true, prompt: "In [42]:" });
	f.metadata.set("@pi_repl_history_path", "/existing/history.log");
	const before = [...f.metadata];
	const result = await f.start({ runtime: "python" });
	assert.equal(result.details.requestedRuntime, "python");
	assert.equal(result.details.runtime, "ipython");
	assert.equal(result.details.target, "python");
	assert.equal(result.details.ready, true);
	assert.match(result.content[0].text, /existing session reports ipython/);
	assert.deepEqual([...f.metadata], before);
	assert.equal(result.details.session.historyPath, "/existing/history.log");
	assert.equal(f.calls.some((call) => ["new-session", "set-option", "pipe-pane"].includes(call.args[0])), false);
});

test("Python frontend prompts are recognised despite aliases or missing legacy runtime metadata", async () => {
	for (const [runtime, prompt] of [["python", "In [3]:"], ["ipython", ">>>"]]) {
		for (const legacy of [false, true]) {
			const f = fixture({ runtime, exists: true, prompt });
			if (legacy) f.metadata.delete("@pi_repl_runtime");
			const before = [...f.metadata];
			const result = await f.start();
			assert.equal(result.details.ready, true);
			assert.deepEqual([...f.metadata], before);
		}
	}
});

test("a concurrent creator is reused without replacing its interpreter or history", async () => {
	const f = fixture({ raceWinner: true });
	f.metadata.set("@pi_repl_history_path", "/winner/history.log");
	const result = await f.start();
	assert.equal(result.details.created, false);
	assert.equal(result.details.reused, true);
	assert.equal(result.details.session.historyPath, "/winner/history.log");
	assert.equal(f.calls.some((call) => ["set-option", "pipe-pane"].includes(call.args[0])), false);
});

test("repl_start reports missing tmux, failed creation and early runtime exit as errors", async () => {
	for (const [options, error] of [
		[{ noTmux: true }, /tmux was not found/],
		[{ createFailure: true }, /Failed to create.*permission denied/],
		[{ dieAfterCreate: true }, /session ended while waiting/],
	]) {
		const f = fixture(options);
		await assert.rejects(f.start(), error);
		assert.equal(f.calls.some((call) => call.args[0] === "kill-session"), false);
	}
});

test("history setup warnings are visible without failing an otherwise ready session", async () => {
	const f = fixture({ historyFailure: true });
	const result = await f.start();
	assert.equal(result.details.ready, true);
	assert.match(result.details.warnings.join("\n"), /pipe failure/);
	assert.match(result.content[0].text, /pipe failure/);
});

test("startup waits through a process/banner/continuation until a normal cursor-row prompt", async () => {
	const f = fixture({ runtime: "ipython", prompt: ["IPython 9", "   ...:", "In [1]:"] });
	const result = await f.start();
	assert.equal(result.details.ready, true);
	assert.equal(f.calls.filter((call) => call.args[0] === "capture-pane" && call.args.includes("-E")).length, 3);
});

for (const [runtime, prompt] of [["python", ""], ["ruby", "irb(main):001:1>"], ["ruby", "irb(main):001:0*"], ["ghci", "ghci|"], ["java", "   ...>"], ["r", "+"], ["julia", "custom-prompt:"], ["octave", ">"], ["matlab", "K>>"], ["matlab", ">> unfinished"], ["gnuplot", "more>"], ["gnuplot", "gnuplot> unfinished"]]) {
	test(`${runtime} unconfirmed prompt ${JSON.stringify(prompt)} times out without sending input or stopping`, async () => {
		const f = fixture({ runtime, prompt, exists: true, tail: runtimes.find(([name]) => name === runtime)[2] });
		const result = await f.start({ runtime, timeoutMs: 1000 });
		assert.equal(result.details.ready, false);
		assert.equal(result.details.reused, true);
		assert.match(result.content[0].text, /Readiness: unconfirmed/);
		assert.match(result.content[0].text, /left running/);
		assert.equal(f.state.exists, true);
		assert.equal(f.calls.some((call) => ["new-session", "set-option", "pipe-pane", "send-keys", "load-buffer", "kill-session"].includes(call.args[0])), false);
	});
}

test("a slow newly created session survives timeout and a later start only reuses it", async () => {
	const f = fixture({ prompt: "starting..." });
	const result = await f.start({ runtime: "python", timeoutMs: 1000 });
	assert.equal(result.details.created, true);
	assert.equal(result.details.ready, false);
	assert.equal(f.state.exists, true);
	const historyPath = result.details.session.historyPath;
	f.state.prompt = ">>>";
	const later = await f.start();
	assert.equal(later.details.created, false);
	assert.equal(later.details.ready, true);
	assert.equal(later.details.session.historyPath, historyPath);
	assert.equal(f.calls.filter((call) => call.args[0] === "new-session").length, 1);
});

test("unknown or wrong-family runtime metadata does not establish readiness or get overwritten", async () => {
	for (const runtime of ["unknown-runtime", "ruby"]) {
		const f = fixture({ exists: true });
		f.metadata.set("@pi_repl_runtime", runtime);
		const result = await f.start({ runtime: "python", timeoutMs: 1000 });
		assert.equal(result.details.ready, false);
		assert.equal(f.metadata.get("@pi_repl_runtime"), runtime);
		assert.equal(f.calls.some((call) => call.args[0] === "set-option"), false);
	}
});

test("cancellation before launch does nothing; cancellation after launch or during wait leaves the session intact", async () => {
	for (const stage of ["before", "created", "waiting"]) {
		const abort = new AbortController();
		const f = fixture({
			prompt: "starting...",
			afterCreate: stage === "created" ? () => abort.abort() : undefined,
			onPrompt: stage === "waiting" ? () => abort.abort() : undefined,
		});
		if (stage === "before") abort.abort();
		await assert.rejects(f.start({ runtime: "python" }, abort.signal), /REPL start aborted.*left running/);
		assert.equal(f.state.exists, stage !== "before");
		if (stage === "before") assert.equal(f.calls.length, 0);
		assert.equal(f.calls.some((call) => ["kill-session", "send-keys", "respawn-pane"].includes(call.args[0])), false);
	}
});

test("a changed session lifetime during the readiness wait is not silently adopted", async () => {
	const f = fixture({ prompt: "starting...", exists: true });
	let count = 0;
	f.state.onPrompt = () => { if (++count === 1) f.state.createdAt += 1; };
	await assert.rejects(f.start(), /session.*changed while waiting/);
	assert.equal(f.calls.some((call) => call.args[0] === "new-session"), false);
});

test("repl_start bounds status text even with a huge single-line pane capture", async () => {
	const f = fixture({ exists: true, tail: "🧪".repeat(20000) });
	const result = await f.start();
	assert.ok(Buffer.byteLength(result.content[0].text) <= DEFAULT_MAX_BYTES);
	assert.ok(result.content[0].text.split("\n").length <= DEFAULT_MAX_LINES);
	assert.equal(result.details.truncation.truncated, true);
	assert.match(result.content[0].text, /Status text truncated/);
});
