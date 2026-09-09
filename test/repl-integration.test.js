import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { acquireReplSessionSendLease, readReplSessionRecord, upsertReplSessionRecordEntry } from "../shared/repl-session-record.js";

const exec = promisify(execFile);
const originalEnv = { TMPDIR: process.env.TMPDIR, PI_REPL_CONTROL_ROOT: process.env.PI_REPL_CONTROL_ROOT, SHELL: process.env.SHELL, PI_REPL_ECHO_MODE: process.env.PI_REPL_ECHO_MODE };
const root = mkdtempSync(join(tmpdir(), "pi-repl-integration-"));
process.env.TMPDIR = root;
process.env.PI_REPL_CONTROL_ROOT = join(root, "controls");
process.env.SHELL = "/bin/sh";
delete process.env.PI_REPL_ECHO_MODE;
const available = process.platform !== "win32" && spawnSync("tmux", ["-V"]).status === 0;
const optionalRuntimes = new Set((process.env.PI_REPL_TEST_RUNTIMES || "").split(","));

after(() => {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

function binary(command) {
	const result = spawnSync("/bin/sh", ["-c", 'command -v "$1"', "sh", command], { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : null;
}
function quote(text) { return `'${text.replace(/'/g, `'"'"'`)}'`; }
async function eventually(check, timeout = 15000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 75));
	}
	throw new Error("Timed out waiting for isolated REPL test condition");
}

async function fixture(t, { index = 0, runtime = "python", controlName } = {}) {
	if (!available) { t.skip("tmux is required for local integration tests"); return null; }
	const command = runtime === "r" ? "R" : runtime === "python" ? "python3" : runtime === "ruby" ? "irb" : runtime === "java" ? "jshell" : runtime;
	let executable = binary(command);
	if (!executable) { t.skip(`${command} is not installed`); return null; }
	if (runtime === "julia") {
		// Resolve juliaup's selected binary before isolating HOME; do not create
		// a new Julia installation/configuration in the test's temporary home.
		const resolved = spawnSync(executable, ["--startup-file=no", "--history-file=no", "-e", "print(joinpath(Sys.BINDIR, Base.julia_exename()))"], { encoding: "utf8", timeout: 15000 });
		assert.equal(resolved.status, 0, resolved.stderr);
		executable = resolved.stdout.trim();
	}
	const cwd = mkdtempSync(join(root, "case-"));
	const home = join(cwd, "home");
	const bin = join(cwd, "bin");
	mkdirSync(home);
	mkdirSync(bin);
	// macOS /etc/profile resets PATH in the login shell used by the extension.
	// Restore our isolated launchers afterwards so runtime flags really apply.
	writeFileSync(join(home, ".profile"), `export PATH=${quote(`${bin}:${process.env.PATH}`)}\n`);
	const flags = {
		python: "-I -q -i", ipython: "--no-banner --no-confirm-exit --simple-prompt --HistoryManager.enabled=False",
		julia: "--startup-file=no --history-file=no -i", r: "--vanilla --quiet", ghci: "-ignore-dot-ghci -v0", clojure: "",
		ruby: "-f --noreadline", java: `-J-Duser.home=${quote(home)} -J-Djava.util.prefs.userRoot=${quote(join(home, "java-prefs"))}`,
	}[runtime];
	const launcher = runtime === "r" ? "R" : runtime === "ruby" ? "irb" : runtime === "java" ? "jshell" : runtime;
	writeFileSync(join(bin, launcher), `#!/bin/sh\nexec ${quote(executable)} ${flags} "$@"\n`, { mode: 0o700 });
	// A distinct socket/server and empty config: never target the user's tmux.
	const socket = `pi-repl-test-${process.pid}-${randomUUID()}`;
	const config = join(cwd, "tmux.conf");
	writeFileSync(config, `set -g base-index ${index}\nset -g pane-base-index ${index}\nset -g history-limit 10000\nset -g default-shell /bin/sh\n`);
	const env = { ...process.env, HOME: home, SHELL: "/bin/sh", PATH: `${bin}:${process.env.PATH}`, IPYTHONDIR: join(home, ".ipython") };
	delete env.TMUX;
	delete env.TMUX_PANE;
	delete env.PYTHONSTARTUP;
	delete env.JULIA_PROJECT;
	delete env.RUBYOPT;
	delete env.RUBYLIB;
	delete env.IRBRC;
	delete env.JAVA_TOOL_OPTIONS;
	delete env.JDK_JAVA_OPTIONS;
	delete env._JAVA_OPTIONS;
	const tmuxArgs = ["-L", socket, "-f", config];
	const calls = [];
	const tools = new Map();
	const commands = new Map();
	const notifications = [];
	let afterEnter;
	const pi = {
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: (name, definition) => commands.set(name, definition),
		async exec(command, args, options) {
			calls.push({ command, args: [...args] });
			try {
				const result = await exec(command, command === "tmux" ? [...tmuxArgs, ...args] : args, {
					cwd: options.cwd, env, timeout: options.timeout, maxBuffer: 8 * 1024 * 1024,
				});
				if (command === "tmux" && args[0] === "send-keys" && afterEnter) await afterEnter();
				return { ...result, code: 0, killed: false };
			} catch (error) {
				return { stdout: error.stdout || "", stderr: error.stderr || error.message, code: error.code || 1, killed: Boolean(error.killed) };
			}
		},
	};
	const ctx = { cwd, hasUI: true, ui: { notify: (message, level) => notifications.push({ message, level }) } };
	process.env.PI_REPL_CONTROL_ROOT = join(root, controlName ?? 'controls space "quoted" #{raise} λ');
	// Fresh module preferences/config for each independent test extension.
	const { default: register } = await import(`../index.ts?fixture=${randomUUID()}`);
	register(pi);
	async function tmux(...args) {
		return (await exec("tmux", [...tmuxArgs, ...args], { env, cwd, timeout: 10000 })).stdout.trim();
	}
	t.after(async () => {
		await tmux("kill-server").catch(() => undefined);
		const result = spawnSync("tmux", ["-L", socket, "list-sessions"]);
		assert.notEqual(result.status, 0, "isolated test server must be stopped");
	});
	const sessionName = `pi-repl-${runtime === "ipython" ? "python" : runtime}`;
	const target = runtime === "ipython" ? "python" : runtime;
	const repl = (args) => commands.get("repl").handler(args, ctx);
	const send = (code, options = {}, signal) => tools.get("repl_send").execute(randomUUID(), { code, target, ...options }, signal, undefined, ctx);
	const status = (options = {}) => tools.get("repl_status").execute(randomUUID(), { target, ...options }, undefined, undefined, ctx);
	await repl(runtime);
	assert.equal(notifications.some((n) => n.level === "error" || n.level === "warning"), false, JSON.stringify(notifications));
	const prompt = { python: />>>/, ipython: /In \[\d+\]:/, julia: /julia>/, r: /(^|\n)>/, ghci: /ghci>/, clojure: /user=>/, ruby: /irb\(.*\).*?>/, java: /jshell>/ }[runtime];
	let startupOutput = "";
	try {
		await eventually(async () => {
			startupOutput = await tmux("capture-pane", "-p", "-t", `${sessionName}:^`);
			return prompt.test(startupOutput);
		}, 30000);
	} catch (error) {
		throw new Error(`${runtime} startup failed: ${startupOutput}`, { cause: error });
	}
	return { cwd, calls, notifications, tmux, sessionName, target, repl, send, status, onEnter: (callback) => { afterEnter = callback; } };
}

test("Summary is the default pane display; command and per-send overrides still work", { timeout: 30000 }, async (t) => {
	const f = await fixture(t);
	if (!f) return;
	await f.repl("echo");
	assert.match(f.notifications.at(-1).message, /REPL submission echo: summary/);
	const code = "for i in range(1, 6):\n    print(i)";
	const result = await f.send(code);
	assert.equal(result.details.echoMode, "summary");
	assert.ok(result.details.submissionAnchorId);
	assert.match(result.content[0].text, /Output:\n1\n2\n3\n4\n5/);
	assert.doesNotMatch(result.content[0].text, /──|│/);
	const historyPath = (await f.status()).details.python.historyPath;
	await eventually(() => readFileSync(historyPath, "utf8").includes(`── done · ${result.details.submissionAnchorId} ──`));
	assert.match(readFileSync(historyPath, "utf8"), /│ for i in range\(1, 6\):\n│     print\(i\)\n── output ──/);

	const quiet = await f.send("print('quiet')", { echoMode: "off" });
	assert.equal(quiet.details.echoMode, "off");
	assert.equal(quiet.details.submissionAnchorId, undefined);
	assert.equal((await f.send("print('default again')")).details.echoMode, "summary");
	try {
		await f.repl("echo off");
		assert.equal((await f.send("print('quiet by command')")).details.echoMode, "off");
		assert.equal((await f.send("print('one summary')", { echoMode: "summary" })).details.echoMode, "summary");
		assert.equal((await f.send("print('still quiet')")).details.echoMode, "off");
		await f.repl("echo full");
		assert.equal((await f.send("print('explicit full')")).details.echoMode, "full");
	} finally {
		await f.repl("echo summary");
	}
});

for (const index of [0, 1]) {
	test(`Python lifecycle, private history, clean records and export with tmux indexes ${index}`, { timeout: 45000 }, async (t) => {
		const f = await fixture(t, { index });
		if (!f) return;
		assert.equal(await f.tmux("display-message", "-p", "-t", `${f.sessionName}:^`, "#{window_index}.#{pane_index}"), `${index}.${index}`);
		let status = (await f.status()).details.python;
		assert.equal(status.running, true);
		assert.ok(status.recordId, JSON.stringify(status));
		assert.match(status.recordId, /^[a-f0-9]{32}$/);
		assert.equal(statSync(status.historyPath).mode & 0o777, 0o600);
		assert.equal(statSync(dirname(status.historyPath)).mode & 0o777, 0o700);
		const firstHistory = status.historyPath;
		const firstRecord = status.recordId;
		const result = await f.send("pi_test_x = 40\nprint(pi_test_x + 2)", { echoMode: "summary" });
		assert.match(result.content[0].text, /Output:\n42/);
		assert.doesNotMatch(result.content[0].text, /──|│/);
		status = (await f.status()).details.python;
		assert.equal(status.recordEntries.length, 1);
		assert.equal(status.recordEntries[0].output, "42");
		assert.equal(status.recordEntries[0].status, "captured");
		await eventually(() => readFileSync(firstHistory, "utf8").includes("── done ·"));
		assert.match(readFileSync(firstHistory, "utf8"), /pi_test_x = 40/);

		// A compatible Studio writer can use the same sidecar without a dependency on Studio.
		const record = readReplSessionRecord(firstRecord);
		const lease = await acquireReplSessionSendLease(firstRecord, { owner: "pi-studio:test", waitMs: 0 });
		try {
			upsertReplSessionRecordEntry(firstRecord, record.session, { id: "studio:test-note", origin: "pi-studio", mode: "literate", status: "note", prose: "A Studio note" });
		} finally { await lease.release(); }
		assert.equal((await f.status()).details.python.recordEntries.at(-1).origin, "pi-studio");
		await f.repl("export python");
		await f.repl("export python");
		const exports = readdirSync(f.cwd).filter((file) => file.endsWith(".md"));
		assert.equal(exports.length, 2);
		const markdown = readFileSync(join(f.cwd, exports[0]), "utf8");
		assert.match(markdown, /Origin: pi-repl/);
		assert.match(markdown, /Origin: pi-studio/);
		assert.match(markdown, /typed directly into an attached tmux pane/);

		// Renumbering and an unrelated active window must not redirect a send.
		await f.tmux("move-window", "-s", `${f.sessionName}:^`, "-t", `${f.sessionName}:7`);
		await f.tmux("new-window", "-t", `${f.sessionName}:8`, "sleep 60");
		assert.match((await f.send("print(pi_test_x + 3)")).content[0].text, /Output:\n43/);
		const historyBeforeRestart = readFileSync(firstHistory, "utf8");
		await f.repl("stop python");
		assert.equal((await f.status()).details.python.running, false);
		await f.repl("python");
		status = (await f.status()).details.python;
		assert.notEqual(status.historyPath, firstHistory);
		assert.notEqual(status.recordId, firstRecord);
		assert.equal(readFileSync(firstHistory, "utf8").startsWith(historyBeforeRestart), true);
		assert.equal(status.recordEntries.length, 0);
	});
}

test("a send pins its pane ID even if a lower-numbered window appears during execution", { timeout: 30000 }, async (t) => {
	const f = await fixture(t, { index: 1 });
	if (!f) return;
	f.onEnter(async () => {
		f.onEnter(undefined);
		await f.tmux("new-window", "-t", `${f.sessionName}:0`, "sleep 60");
	});
	const result = await f.send("import time\ntime.sleep(0.5)\nprint('pinned pane')");
	assert.match(result.content[0].text, /Output:\npinned pane/);
});

test("concurrent submissions capture only their own output and recover after runtime errors", { timeout: 30000 }, async (t) => {
	const f = await fixture(t);
	if (!f) return;
	const [first, second] = await Promise.all([
		f.send("import time\ntime.sleep(0.5)\nprint('first submission')"),
		f.send("print('second submission')"),
	]);
	assert.match(first.content[0].text, /Output:\nfirst submission/);
	assert.doesNotMatch(first.content[0].text, /second submission/);
	assert.match(second.content[0].text, /Output:\nsecond submission/);
	assert.doesNotMatch(second.content[0].text, /first submission/);
	const error = await f.send("raise ValueError('python-test-error')", { echoMode: "full" });
	assert.match(error.content[0].text.split("Output:\n")[1], /ValueError: python-test-error/);
	assert.match((await f.send("print('recovered')")).content[0].text, /Output:\nrecovered/);
});

test("default-session lookup and stop never match a longer session-name prefix", { timeout: 30000 }, async (t) => {
	const f = await fixture(t);
	if (!f) return;
	const other = `${f.sessionName}-other`;
	await f.tmux("rename-session", "-t", f.sessionName, other);
	assert.equal((await f.status()).details.python.running, false);
	await f.repl("stop python");
	assert.equal(await f.tmux("has-session", "-t", other), "");
});

for (const mode of ["timeout", "abort", "session-ended"]) {
	test(`${mode} retains the send lease and controls until execution settles`, { timeout: 30000 }, async (t) => {
		const f = await fixture(t);
		if (!f) return;
		const recordId = (await f.status()).details.python.recordId;
		const abort = new AbortController();
		if (mode !== "timeout") f.onEnter(() => { abort.abort(); });
		const request = f.send(`import time\ntime.sleep(${mode === "session-ended" ? 30 : 2.5})\nprint('late result')`, { timeoutMs: 1000 }, abort.signal);
		await assert.rejects(request, mode === "timeout" ? /Timed out waiting/ : /aborted/);
		f.onEnter(undefined);
		assert.ok(readdirSync(process.env.PI_REPL_CONTROL_ROOT).some((file) => file.endsWith(".py")));
		await assert.rejects(acquireReplSessionSendLease(recordId, { owner: "pi-studio:test", waitMs: 0 }), /busy in another compatible client/);
		if (mode === "session-ended") {
			await f.tmux("kill-session", "-t", f.sessionName);
			// A same-name replacement must not keep the old lifetime's lease alive.
			await f.tmux("new-session", "-d", "-s", f.sessionName, "sleep 60");
		}
		await eventually(async () => {
			try {
				const lease = await acquireReplSessionSendLease(recordId, { waitMs: 0 });
				await lease.release();
				return true;
			} catch (error) {
				if (/busy/.test(error.message)) return false;
				throw error;
			}
		});
		assert.equal(readdirSync(process.env.PI_REPL_CONTROL_ROOT).length, 0);
		if (mode !== "session-ended") {
			const result = await f.send("print('next request')");
			assert.match(result.content[0].text, /Output:\nnext request/);
			assert.doesNotMatch(result.content[0].text, /late result/);
		}
	});
}

const runtimeCases = [
	["ipython", "pi_test_x = 41\nprint(pi_test_x + 1)", "raise ValueError('runtime-test-error')"],
	["julia", "pi_test_x = 41\nprintln(pi_test_x + 1)", 'error("runtime-test-error")'],
	["r", "pi_test_x <- 41\nprint(pi_test_x + 1)", 'stop("runtime-test-error")'],
	["ghci", "let pi_test_x = 41\nprint (pi_test_x + 1)", 'error "runtime-test-error"'],
	["clojure", "(def pi-test-x 41)\n(println (+ pi-test-x 1))", '(throw (Exception. "runtime-test-error"))'],
	["ruby", "pi_test_x = 41\nputs pi_test_x + 1", "raise 'runtime-test-error'"],
	["java", "int pi_test_x = 41;\nSystem.out.println(pi_test_x + 1);", 'throw new RuntimeException("runtime-test-error");'],
];
for (const [runtime, code, errorCode] of runtimeCases) {
	test(`${runtime} multiline wrapper, display cleanup and runtime errors`, {
		timeout: 60000,
		skip: !(optionalRuntimes.has("all") || optionalRuntimes.has(runtime)) && "set PI_REPL_TEST_RUNTIMES=all to include installed optional runtimes",
	}, async (t) => {
		const f = await fixture(t, { index: 1, runtime });
		if (!f) return;
		for (const echoMode of ["off", "summary", "full"]) {
			const result = await f.send(code, { echoMode });
			assert.match(result.content[0].text.split("Output:\n")[1], /42/, await f.tmux("capture-pane", "-p", "-J", "-t", `${f.sessionName}:^`, "-S", "-80"));
			assert.doesNotMatch(result.content[0].text, /──|│/);
		}
		if (runtime === "julia") {
			const literal = await f.send('println(raw"literal $value and λ")', { echoMode: "full" });
			assert.match(literal.content[0].text.split("Output:\n")[1], /literal \$value and λ/);
			assert.doesNotMatch(literal.content[0].text, /──|│/);
		}
		const result = await f.send(errorCode, { echoMode: "full" });
		assert.match(result.content[0].text.split("Output:\n")[1], /runtime-test-error/);
		assert.doesNotMatch(result.content[0].text, /──|│/);
		assert.equal(readdirSync(process.env.PI_REPL_CONTROL_ROOT).length, 0);
	});
}

for (const runtime of ["ruby", "java"]) {
	for (const index of [0, 1]) {
		test(`${runtime} lifecycle, direct interaction, aliases, private records and export at index ${index}`, {
			timeout: 60000,
			skip: !(optionalRuntimes.has("all") || optionalRuntimes.has(runtime)),
		}, async (t) => {
			const f = await fixture(t, { runtime, index });
			if (!f) return;
			const alias = runtime === "ruby" ? "IRB" : "JShell";
			let status = (await f.status({ target: alias })).details[runtime];
			assert.equal(status.running, true);
			assert.equal(status.runtime, runtime);
			assert.match(status.recordId, /^[a-f0-9]{32}$/);
			assert.equal(statSync(status.historyPath).mode & 0o777, 0o600);
			const firstRecord = status.recordId;
			const firstHistory = status.historyPath;
			await f.send(runtime === "ruby" ? "pi_value = 41" : "int pi_value = 41;", { target: alias });
			const next = await f.send(runtime === "ruby" ? "pi_value + 1" : "System.out.println(pi_value + 1);");
			assert.match(next.content[0].text.split("Output:\n")[1], /42/);
			const direct = runtime === "ruby" ? 'pi_human_value = pi_value + 10; puts "direct-ready"' : 'int pi_human_value = pi_value + 10;';
			await f.tmux("send-keys", "-t", `${f.sessionName}:^`, "-l", direct);
			await f.tmux("send-keys", "-t", `${f.sessionName}:^`, "C-m");
			const shared = await f.send(runtime === "ruby" ? "pi_human_value" : "System.out.println(pi_human_value);");
			assert.match(shared.content[0].text.split("Output:\n")[1], /51/);
			assert.doesNotMatch(shared.content[0].text, /──|│|=> nil/);
			status = (await f.status()).details[runtime];
			assert.equal(status.recordEntries.length, 3);
			assert.equal(status.recordEntries.at(-1).status, "captured");
			assert.match(status.recordEntries.at(-1).output, /51/);
			await eventually(() => readFileSync(firstHistory, "utf8").includes(`── done · ${shared.details.submissionAnchorId} ──`));
			await f.repl(`status ${runtime}`);
			assert.match(f.notifications.at(-1).message, /session is running/);
			await f.repl(`attach ${runtime}`);
			assert.match(f.notifications.at(-1).message, new RegExp(`tmux attach -t ${f.sessionName}`));
			await f.repl(`export ${runtime}`);
			const exported = readdirSync(f.cwd).find((file) => file.endsWith(".md"));
			assert.match(readFileSync(join(f.cwd, exported), "utf8"), new RegExp("```" + runtime));
			assert.equal(readdirSync(process.env.PI_REPL_CONTROL_ROOT).length, 0);
			await f.repl(`stop ${runtime}`);
			assert.equal((await f.status()).details[runtime].running, false);
			await f.repl(runtime);
			status = (await f.status()).details[runtime];
			assert.notEqual(status.recordId, firstRecord);
			assert.notEqual(status.historyPath, firstHistory);
			assert.equal(status.recordEntries.length, 0);
		});
	}
}

test("ruby preserves interpolation, literal hashes, Unicode, escapes and error recovery", {
	timeout: 60000, skip: !(optionalRuntimes.has("all") || optionalRuntimes.has("ruby")),
}, async (t) => {
	const f = await fixture(t, { runtime: "ruby", index: 1 });
	if (!f) return;
	const cases = [
		['pi_name = "world"\nputs "hello #{pi_name}"', "hello world"],
		["puts '#{1 + 2} #@ivar #$gvar'", "#{1 + 2} #@ivar #$gvar"],
		['@pi_ivar = "instance"\n$pi_gvar = "global"\nputs "#@pi_ivar #$pi_gvar"', "instance global"],
		['puts "λ 🧪 \\"quoted\\" \\\\path"', 'λ 🧪 "quoted" \\path'],
		['print "no newline"', "no newline"],
	];
	for (const echoMode of ["off", "summary", "full"]) {
		for (const [code, expected] of cases) {
			const result = await f.send(code, { echoMode });
			assert.equal(result.content[0].text.split("Output:\n")[1], expected);
		}
	}
	const syntaxError = await f.send("def broken(", { timeoutMs: 3000 });
	assert.match(syntaxError.content[0].text.split("Output:\n")[1], /SyntaxError|syntax error/);
	assert.match((await f.send('puts "recovered"')).content[0].text, /Output:\nrecovered/);
	assert.equal(readdirSync(process.env.PI_REPL_CONTROL_ROOT).length, 0);
});

test("java preserves top-level snippets and completes after rejected or unfinished input", {
	timeout: 60000, skip: !(optionalRuntimes.has("all") || optionalRuntimes.has("java")),
}, async (t) => {
	const f = await fixture(t, { runtime: "java", index: 1 });
	if (!f) return;
	const cases = [
		['import java.time.LocalDate;\nSystem.out.println(LocalDate.of(2026, 1, 2));', /2026-01-02/],
		['int twice(int x) {\n    return 2 * x;\n}', /\(no output\)/],
		['System.out.println(twice(21));', /42/],
		['class PiBox {\n    int value = 17;\n}\nSystem.out.println(new PiBox().value);', /17/],
		['int pi_counter = 0;\n++pi_counter', /\(no output\)/],
		['System.out.println(pi_counter);', /1/],
		['System.out.println("λ 🧪 \\"quoted\\" \\\\path");', /λ 🧪 "quoted" \\path/],
		['System.out.print("no newline");', /no newline/],
	];
	for (const [code, expected] of cases) {
		const result = await f.send(code);
		assert.match(result.content[0].text.split("Output:\n")[1], expected);
		assert.doesNotMatch(result.content[0].text, /──|│/);
	}
	for (const code of ['int broken = ;', 'int unfinished =', '/* unfinished comment', '"unfinished string']) {
		const result = await f.send(code, { timeoutMs: 3000 });
		assert.equal(result.details.runtime, "java");
		assert.doesNotMatch(result.content[0].text, /──|│/);
		if (code === 'int broken = ;') assert.match(result.content[0].text.split("Output:\n")[1], /Error:/);
		const recovered = await f.send("System.out.println(twice(21));");
		assert.match(recovered.content[0].text.split("Output:\n")[1], /42/);
		assert.equal(readdirSync(process.env.PI_REPL_CONTROL_ROOT).length, 0);
	}
});

test("java refuses line breaks in command paths before submission and releases its lease", {
	timeout: 30000, skip: !(optionalRuntimes.has("all") || optionalRuntimes.has("java")),
}, async (t) => {
	const f = await fixture(t, { runtime: "java", controlName: "controls\ninvalid" });
	if (!f) return;
	const recordId = (await f.status()).details.java.recordId;
	const callsBefore = f.calls.length;
	await assert.rejects(f.send("System.out.println(42);"), /JShell control paths cannot contain line breaks/);
	assert.equal(f.calls.slice(callsBefore).some((call) => call.args[0] === "paste-buffer"), false);
	assert.equal(readdirSync(process.env.PI_REPL_CONTROL_ROOT).length, 0);
	const lease = await acquireReplSessionSendLease(recordId, { waitMs: 0 });
	await lease.release();
});

for (const runtime of ["ruby", "java"]) {
	for (const mode of ["timeout", "abort"]) {
		test(`${runtime} ${mode} holds the lease until code actually finishes`, {
			timeout: 60000, skip: !(optionalRuntimes.has("all") || optionalRuntimes.has(runtime)),
		}, async (t) => {
			const f = await fixture(t, { runtime });
			if (!f) return;
			const recordId = (await f.status()).details[runtime].recordId;
			const abort = new AbortController();
			if (mode === "abort") f.onEnter(() => abort.abort());
			const slow = runtime === "ruby" ? 'sleep 2.5\nputs "late result"' : 'Thread.sleep(2500);\nSystem.out.println("late result");';
			await assert.rejects(f.send(slow, { timeoutMs: 1000 }, abort.signal), mode === "abort" ? /aborted/ : /Timed out waiting/);
			f.onEnter(undefined);
			await assert.rejects(acquireReplSessionSendLease(recordId, { waitMs: 0 }), /busy/);
			assert.ok(readdirSync(process.env.PI_REPL_CONTROL_ROOT).some((file) => file.endsWith(runtime === "ruby" ? ".rb" : ".java")));
			await eventually(async () => {
				try {
					const lease = await acquireReplSessionSendLease(recordId, { waitMs: 0 });
					await lease.release();
					return true;
				} catch (error) {
					if (/busy/.test(error.message)) return false;
					throw error;
				}
			});
			assert.equal(readdirSync(process.env.PI_REPL_CONTROL_ROOT).length, 0);
			const next = await f.send(runtime === "ruby" ? 'puts "next request"' : 'System.out.println("next request");');
			assert.match(next.content[0].text, /next request/);
			assert.doesNotMatch(next.content[0].text, /late result/);
		});
	}
}
