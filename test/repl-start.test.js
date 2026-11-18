import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import register from "../index.ts";

const originalTmp = process.env.TMPDIR;
const originalPython = process.env.PI_REPL_PYTHON;
const originalShell = process.env.SHELL;
const root = mkdtempSync(join(tmpdir(), "pi-repl-start-"));
process.env.TMPDIR = root;
delete process.env.PI_REPL_PYTHON;
// The login shell decides Python's command; these tests choose it.
process.env.SHELL = "/bin/sh";
after(() => {
	if (originalTmp === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmp;
	if (originalPython === undefined) delete process.env.PI_REPL_PYTHON;
	else process.env.PI_REPL_PYTHON = originalPython;
	if (originalShell === undefined) delete process.env.SHELL;
	else process.env.SHELL = originalShell;
	rmSync(root, { recursive: true, force: true });
});

// The launch command as the shell sees it, matched literally.
const shellWord = (text) => `'${text.replace(/'/g, `'"'"'`)}'`;
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const pythonFallback = "if command -v python >/dev/null 2>&1; then python; else python3; fi";
const runtimes = [
	["python", pythonFallback, ">>>"], ["ipython", "ipython", "In [1]:"],
	["julia", "julia", "julia>"], ["r", "R", ">"], ["ghci", "ghci", "ghci>"],
	["clojure", "clojure", "user=>"], ["ruby", "irb", "irb(main):001:0>"], ["java", "jshell", "jshell>"],
	["octave", "octave-cli --quiet --interactive --persist --eval 'sighup_dumps_octave_core(false); sigterm_dumps_octave_core(false);'", "octave:1>"], ["matlab", "matlab -nodesktop -nosplash", ">>"],
	["gnuplot", "gnuplot", "gnuplot>"], ["cpp", "cling", "[cling]$"], ["rust", "evcxr", ">>"],
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
			// Every tmux command needs -u, or a non-UTF-8 locale turns tabs into `_`.
			if (command === "tmux") {
				assert.equal(args[0], "-u", `tmux without -u: ${args.join(" ")}`);
				args = args.slice(1);
			}
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
				if (args.at(-1) === "#{pane_id}|#{pane_pid}|#{pane_dead}") return ok(`%9|123|${state.dead ? 1 : 0}`);
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

test('cpp startup refuses a retained dead pane even when its cursor still looks like a prompt', async () => {
	const f = fixture({ runtime: 'cpp', exists: true, prompt: '[cling]$', dead: true });
	await assert.rejects(f.start(), /session ended native execution/);
	assert.ok(f.calls.every((call) => !['new-session', 'send-keys', 'paste-buffer', 'respawn-pane'].includes(call.args[0])));
});

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
		if (runtime === "gnuplot") {
			const marker = f.metadata.get("@pi_repl_gnuplot_owner");
			assert.match(marker, /^[a-f0-9]{32}$/);
			assert.ok(launch.args.includes(`PI_REPL_GNUPLOT_OWNER=${marker}`));
		} else assert.equal(launch.args.includes("-e"), false);
		if (runtime === "rust") {
			// evcxr runs from a launch script, with a private settings folder in the temporary folder.
			const dir = f.metadata.get("@pi_repl_rust_config");
			assert.equal(dir.startsWith(join(root, "pi-repl-rust-")), true);
			assert.equal(statSync(dir).mode & 0o777, 0o700);
			assert.equal(f.metadata.get("@pi_repl_send_path"), "pi-repl");
			assert.match(launch.args.at(-1), new RegExp(` -i -l -c ${literal(shellWord(`exec /bin/sh ${shellWord(join(dir, "pi-repl-launch.sh"))}`))}$`));
			const script = readFileSync(join(dir, "pi-repl-launch.sh"), "utf8");
			assert.match(script, /for f in init\.evcxr prelude\.rs history\.txt; do/);
			assert.match(script, /EVCXR_CONFIG_DIR="\$dir" exec evcxr\n$/);
		} else assert.match(launch.args.at(-1), new RegExp(runtime === "matlab" ? ` -i -l -c '${literal(executable)} -sd ` : ` -i -l -c ${literal(shellWord(executable))}$`));
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

test("Python starts python, or python3 when there's no python", async () => {
	const f = fixture();
	const result = await f.start();
	assert.match(result.content[0].text, /uses python3 when there's no python\. Set PI_REPL_PYTHON to start another command\./);
	const command = f.calls.find((call) => call.args[0] === "new-session").args.at(-1).match(/ -i -l -c '([^']*)'$/)[1];
	assert.equal(command, pythonFallback);
	// Run in each POSIX shell installed here, finding only these stand-ins.
	const shells = ["/bin/sh", "bash", "zsh", "dash", "ksh"].map((shell) => spawnSync("/bin/sh", ["-c", 'command -v "$1"', "sh", shell], { encoding: "utf8" }).stdout.trim()).filter(Boolean);
	for (const shell of shells) {
		for (const [names, expected] of [[["python3"], "python3"], [["python", "python3"], "python"]]) {
			const bin = mkdtempSync(join(root, "bin-"));
			for (const name of names) writeFileSync(join(bin, name), `#!/bin/sh\necho ${name}\n`, { mode: 0o755 });
			const run = spawnSync(shell, ["-c", command], { env: { PATH: bin }, encoding: "utf8" });
			assert.equal(run.status, 0, `${shell}: ${run.stderr}`);
			assert.equal(run.stdout, `${expected}\n`, shell);
		}
	}
});

test("Python starts plain python under a login shell that isn't a POSIX shell, such as fish", async () => {
	try {
		for (const [shell, falls] of [["/opt/homebrew/bin/fish", false], ["/usr/bin/nu", false], ["/bin/zsh", true], ["/usr/local/bin/bash", true]]) {
			process.env.SHELL = shell;
			const f = fixture();
			const result = await f.start();
			const launch = f.calls.find((call) => call.args[0] === "new-session").args.at(-1);
			assert.match(launch, new RegExp(`^${literal(shellWord(shell))} -i -l -c ${literal(shellWord(falls ? pythonFallback : "python"))}$`));
			assert.equal(/uses python3 when there's no python/.test(result.content[0].text), falls, shell);
			assert.match(result.content[0].text, /Set PI_REPL_PYTHON to start another command\./);
		}
		// PI_REPL_PYTHON applies whatever the shell.
		process.env.SHELL = "/opt/homebrew/bin/fish";
		process.env.PI_REPL_PYTHON = "python3";
		const f = fixture();
		await f.start();
		assert.match(f.calls.find((call) => call.args[0] === "new-session").args.at(-1), / -i -l -c 'python3'$/);
	} finally {
		process.env.SHELL = "/bin/sh";
		delete process.env.PI_REPL_PYTHON;
	}
});

test("PI_REPL_PYTHON is the command that starts Python, and IPython is it with -m IPython", async () => {
	try {
		process.env.PI_REPL_PYTHON = "  uv run python  ";
		for (const [runtime, prompt, expected] of [["python", ">>>", "uv run python"], ["ipython", "In [1]:", "uv run python -m IPython"]]) {
			const f = fixture({ runtime, prompt });
			const result = await f.start();
			assert.match(f.calls.find((call) => call.args[0] === "new-session").args.at(-1), new RegExp(` -i -l -c ${literal(shellWord(expected))}$`));
			assert.match(result.content[0].text, /PI_REPL_PYTHON set this command\. It runs through your login shell/);
		}
		// A blank setting is no setting.
		process.env.PI_REPL_PYTHON = "   ";
		const blank = fixture();
		await blank.start();
		assert.match(blank.calls.find((call) => call.args[0] === "new-session").args.at(-1), new RegExp(` -i -l -c ${literal(shellWord(pythonFallback))}$`));
		// A session that ends at once says what PI_REPL_PYTHON started.
		for (const [runtime, said] of [["python", "starts `uv run python`."], ["ipython", "starts `uv run python -m IPython`, which needs IPython installed for that Python."]]) {
			process.env.PI_REPL_PYTHON = "uv run python";
			await assert.rejects(fixture({ runtime, dieAfterCreate: true }).start(), new RegExp(`session ended while waiting for pi-repl-python\\. .*PI_REPL_PYTHON is set, so it ${literal(said)}$`));
		}
		// A running session keeps its interpreter.
		process.env.PI_REPL_PYTHON = ".venv/bin/python";
		const running = fixture({ exists: true });
		assert.equal((await running.start()).details.reused, true);
		assert.equal(running.calls.some((call) => call.args[0] === "new-session"), false);
	} finally {
		delete process.env.PI_REPL_PYTHON;
	}
});

test("repl_start requires a canonical explicit runtime; no send auto-start or destructive tools", async () => {
	const f = fixture();
	const schema = f.tools.get("repl_start").parameters;
	assert.ok(schema.required.includes("runtime"));
	// LFortran's shared session starts through its own path, after the pane runtimes.
	assert.deepEqual(schema.properties.runtime.enum, [...runtimes.map(([runtime]) => runtime), "lfortran"]);
	assert.equal(schema.properties.runtime.anyOf, undefined);
	for (const runtime of [undefined, "", "bun", "unknown", "irb", "jshell"]) {
		await assert.rejects(f.start({ runtime }), /explicit supported runtime/);
	}
	assert.equal(f.calls.length, 0);
	// repl_input only answers an LFortran READ, and repl_history only reads; there is still no tool that stops or resets a session.
	assert.deepEqual([...f.tools.keys()].sort(), ["repl_history", "repl_input", "repl_send", "repl_start", "repl_status"]);
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

for (const [runtime, prompt] of [["python", ""], ["ruby", "irb(main):001:1>"], ["ruby", "irb(main):001:0*"], ["ghci", "ghci|"], ["java", "   ...>"], ["r", "+"], ["julia", "custom-prompt:"], ["octave", ">"], ["matlab", "K>>"], ["matlab", ">> unfinished"], ["gnuplot", "more>"], ["gnuplot", "gnuplot> unfinished"], ["cpp", "[cling]$ unfinished"], ["cpp", "[cling]$?"]]) {
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
