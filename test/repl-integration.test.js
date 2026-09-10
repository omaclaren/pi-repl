import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { acquireReplSessionSendLease, readReplSessionRecord, upsertReplSessionRecordEntry } from "../shared/repl-session-record.js";
import { createReplSubmissionDisplay } from "../shared/repl-submission-display.js";
import { gnuplotStringLiteral } from "../shared/repl-gnuplot.js";
import { createTestTmux, readProcessTable } from "./helpers/repl-test-tmux.js";

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

async function fixture(t, { index = 0, runtime = "python", controlName, startWithTool = false, concurrentStart = false } = {}) {
	if (!available) { t.skip("tmux is required for local integration tests"); return null; }
	const command = runtime === "r" ? "R" : runtime === "python" ? "python3" : runtime === "ruby" ? "irb" : runtime === "java" ? "jshell" : runtime === "octave" ? "octave-cli" : runtime;
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
		octave: "--no-init-file --no-history --no-line-editing", matlab: "", gnuplot: "-d",
	}[runtime];
	const launcher = runtime === "r" ? "R" : runtime === "ruby" ? "irb" : runtime === "java" ? "jshell" : runtime === "octave" ? "octave-cli" : runtime;
	// A distinct socket/server and empty config: never target the user's tmux.
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
	if (runtime === "gnuplot") {
		env.GNUTERM = "dumb";
		env.QT_QPA_PLATFORM = "offscreen";
		delete env.GNUPLOT_LIB;
		delete env.GNUPLOT_DRIVER_DIR;
		delete env.GNUHELP;
	}
	if (runtime === "matlab") {
		env.MATLAB_PREFDIR = join(home, "matlab-prefs");
		delete env.MATLABPATH;
		// Shadow a user startup script in this isolated working directory.
		writeFileSync(join(cwd, "startup.m"), "");
	}
	const tmuxHarness = createTestTmux(t, { cwd, env, config, trackDetachedGnuplot: runtime === "gnuplot" });
	writeFileSync(join(bin, launcher), `#!/bin/sh\n${tmuxHarness.launcherPrologue}exec ${quote(executable)} ${flags} "$@"\n`, { mode: 0o700 });
	const calls = [];
	const tools = new Map();
	const commands = new Map();
	const notifications = [];
	let afterEnter;
	let beforeStop;
	const pi = {
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: (name, definition) => commands.set(name, definition),
		async exec(command, args, options) {
			calls.push({ command, args: [...args] });
			try {
				if (command === "tmux" && args[0] === "if-shell" && beforeStop) await beforeStop();
				const execOptions = { cwd: options.cwd, env, timeout: options.timeout, maxBuffer: 8 * 1024 * 1024 };
				const result = command === "tmux" ? await tmuxHarness.run(args, execOptions) : await exec(command, args, execOptions);
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
		return (await tmuxHarness.run(args)).stdout.trim();
	}
	const sessionName = `pi-repl-${runtime === "ipython" ? "python" : runtime}`;
	const target = runtime === "ipython" ? "python" : runtime;
	const repl = (args) => commands.get("repl").handler(args, ctx);
	const send = (code, options = {}, signal) => tools.get("repl_send").execute(randomUUID(), { code, target, ...options }, signal, undefined, ctx);
	const status = (options = {}) => tools.get("repl_status").execute(randomUUID(), { target, ...options }, undefined, undefined, ctx);
	const start = (options = {}, signal) => tools.get("repl_start").execute(randomUUID(), { runtime, ...options }, signal, undefined, { cwd });
	if (concurrentStart) {
		const results = await Promise.all([start(), start()]);
		assert.equal(results.filter((result) => result.details.created).length, 1);
		assert.equal(results.filter((result) => result.details.reused).length, 1);
		assert.equal(results[0].details.session.recordId, results[1].details.session.recordId);
		assert.equal(results[0].details.session.historyPath, results[1].details.session.historyPath);
		assert.ok(results.every((result) => result.details.ready));
	} else if (startWithTool) {
		const result = await start();
		assert.equal(result.details.created, true);
		assert.equal(result.details.ready, true, result.content[0].text);
		assert.equal(result.details.session.recordEntryCount, 0, "readiness must not execute a probe");
		assert.equal(realpathSync(result.details.session.currentPath), realpathSync(cwd));
		assert.equal(result.details.attachCommand, `tmux attach -t ${sessionName}`);
	} else {
		await repl(runtime);
	}
	assert.equal(notifications.some((n) => n.level === "error" || n.level === "warning"), false, JSON.stringify(notifications));
	const prompt = { python: />>>/, ipython: /In \[\d+\]:/, julia: /julia>/, r: /(^|\n)>/, ghci: /ghci>/, clojure: /user=>/, ruby: /irb\(.*\).*?>/, java: /jshell>/, octave: /octave:\d+>/, matlab: /(^|\n)>>/, gnuplot: /gnuplot>/ }[runtime];
	let startupOutput = "";
	try {
		await eventually(async () => {
			startupOutput = await tmux("capture-pane", "-p", "-t", `${sessionName}:^`);
			return prompt.test(startupOutput);
		}, 30000);
	} catch (error) {
		throw new Error(`${runtime} startup failed: ${startupOutput}`, { cause: error });
	}
	return { cwd, calls, notifications, tmux, sessionName, target, repl, send, status, start, owned: () => tmuxHarness.owned(), cleanup: () => tmuxHarness.cleanup(), onEnter: (callback) => { afterEnter = callback; }, onBeforeStop: (callback) => { beforeStop = callback; } };
}

async function assertCompletionGap(f, result) {
	const marker = `── done · id: ${result.details.submissionAnchorId} ──`;
	let physical = "";
	await eventually(async () => {
		physical = await f.tmux("capture-pane", "-p", "-t", `${f.sessionName}:^`, "-S", "-150");
		const index = physical.lastIndexOf(marker);
		return index >= 0 && physical.slice(index + marker.length).startsWith("\n\n");
	}, 5000).catch((error) => { throw new Error(`Missing trailing display gap:\n${physical}`, { cause: error }); });
}

function assertCorrelatedControlFiles(files, entryId) {
	assert.equal(typeof entryId, "string");
	assert.ok(entryId.length > 0);
	assert.ok(files.length > 0);
	const { anchorId } = createReplSubmissionDisplay({ entryId });
	const pattern = new RegExp(`^${anchorId}-[a-f0-9]{16}\\.[A-Za-z0-9]{1,8}$`);
	for (const file of files) assert.match(file, pattern);
	return anchorId;
}

async function assertVerifiedStop(f) {
	const status = (await f.status()).details[f.target];
	const roots = new Set((await f.tmux("list-panes", "-s", "-t", `=${f.sessionName}`, "-F", "#{pane_pid}")).split("\n").map(Number));
	const before = await readProcessTable();
	let changed;
	do {
		changed = false;
		for (const p of before) if (roots.has(p.ppid) && !roots.has(p.pid)) { roots.add(p.pid); changed = true; }
	} while (changed);
	const tracked = before.filter((p) => roots.has(p.pid));
	const history = readFileSync(status.historyPath, "utf8");
	const callCount = f.calls.length;
	await f.repl(`stop ${f.target}`);
	assert.ok(f.calls.slice(callCount).every((call) => !["send-keys", "paste-buffer", "load-buffer", "pipe-pane", "kill-server"].includes(call.args[0])), "stop must not inject runtime input, disable history early, or stop the server");
	assert.equal(f.notifications.at(-1).level, "info", JSON.stringify(f.notifications.at(-1)));
	assert.match(f.notifications.at(-1).message, /Verified owned runtime processes exited/);
	assert.equal((await f.status()).details[f.target].running, false);
	// Inspect before the independent test teardown runs: it must not mask a
	// production stop that only closes tmux and leaks its runtime children.
	const after = await readProcessTable();
	for (const old of tracked) assert.ok(!after.some((p) => p.pid === old.pid && p.startedAt === old.startedAt && !p.state.startsWith("Z")), `surviving production-stop PID ${old.pid}`);
	assert.ok(readFileSync(status.historyPath, "utf8").startsWith(history));
	assert.equal(readReplSessionRecord(status.recordId).entries.length, status.recordEntryCount);
}

test("production stop reaps resistant runtime children in all selected panes and preserves another session", { timeout: 30000 }, async (t) => {
	const f = await fixture(t, { index: 1 });
	if (!f) return;
	const source = join(f.cwd, "stubborn-stop.mjs");
	writeFileSync(source, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
process.on('SIGHUP', () => {}); process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
if (process.argv[2] !== 'child') spawn(process.execPath, [process.argv[1], 'child'], { stdio: 'inherit' });
writeFileSync(${JSON.stringify(f.cwd)} + '/' + (process.argv[2] || 'parent') + '.ready', String(process.pid));
`);
	await f.tmux("new-window", "-t", `${f.sessionName}:7`, `exec ${quote(process.execPath)} ${quote(source)}`);
	await eventually(() => readdirSync(f.cwd).includes("child.ready"));
	const other = `${f.sessionName}-other`;
	await f.tmux("new-session", "-d", "-s", other, "sleep 60");
	const identity = await f.tmux("display-message", "-p", "-t", `${other}:^`, "#{session_id}|#{pane_id}|#{pane_pid}");
	await assertVerifiedStop(f);
	assert.match(f.notifications.at(-1).message, /Cleaned up/);
	assert.equal(await f.tmux("display-message", "-p", "-t", `${other}:^`, "#{session_id}|#{pane_id}|#{pane_pid}"), identity);
});

for (const race of [false, true]) {
	test(`production stop refuses windows linked to another session${race ? " during final stop check" : ""}`, { timeout: 30000 }, async (t) => {
		const f = await fixture(t);
		if (!f) return;
		const other = `${f.sessionName}-other`;
		await f.tmux("new-session", "-d", "-s", other, "sleep 60");
		const link = () => f.tmux("link-window", "-s", `${f.sessionName}:^`, "-t", `${other}:8`);
		if (race) f.onBeforeStop(async () => { f.onBeforeStop(undefined); await link(); });
		else await link();
		const original = await f.tmux("display-message", "-p", "-t", `${f.sessionName}:^`, "#{session_id}|#{pane_pid}");
		await f.repl("stop python");
		assert.equal(f.notifications.at(-1).level, "error");
		assert.match(f.notifications.at(-1).message, race ? /tmux refused/ : /linked to another session/);
		assert.equal(await f.tmux("display-message", "-p", "-t", `${f.sessionName}:^`, "#{session_id}|#{pane_pid}"), original);
		assert.equal(await f.tmux("has-session", "-t", `=${other}`), "");
		// Unlink the intentionally shared window before using repl_send: its
		// separate record protocol does not support ambiguous linked panes.
		await f.tmux("unlink-window", "-t", `${other}:8`);
		assert.match((await f.send("print('still here')")).content[0].text, /Output:\nstill here/);
	});
}

test("production stop does not kill a same-name replacement created after preflight", { timeout: 30000 }, async (t) => {
	const f = await fixture(t);
	if (!f) return;
	let replacement;
	f.onBeforeStop(async () => {
		f.onBeforeStop(undefined);
		await f.tmux("kill-session", "-t", `=${f.sessionName}`);
		replacement = await f.start();
		await f.send("pi_replacement_value = 42");
	});
	await f.repl("stop python");
	assert.equal(f.notifications.at(-1).level, "error");
	assert.equal((await f.status()).details.python.recordId, replacement.details.session.recordId);
	assert.match((await f.send("print(pi_replacement_value)")).content[0].text, /Output:\n42/);
});

test("ghci production stop verifies a busy runtime exits and releases retained controls and lease", {
	timeout: 30000, skip: !(optionalRuntimes.has("all") || optionalRuntimes.has("ghci")),
}, async (t) => {
	const f = await fixture(t, { runtime: "ghci" });
	if (!f) return;
	const recordId = (await f.status()).details.ghci.recordId;
	const abort = new AbortController();
	f.onEnter(() => abort.abort());
	await assert.rejects(f.send('Control.Concurrent.threadDelay 30000000 >> print 42', {}, abort.signal), /aborted/);
	f.onEnter(undefined);
	await assertVerifiedStop(f);
	await eventually(async () => {
		try { const lease = await acquireReplSessionSendLease(recordId, { waitMs: 0 }); await lease.release(); return true; }
		catch (error) { if (/busy/.test(error.message)) return false; throw error; }
	});
	assert.equal(readdirSync(process.env.PI_REPL_CONTROL_ROOT).length, 0);
});

test("plain source containing the output divider survives narrow-pane display cleanup", { timeout: 30000 }, async (t) => {
	const f = await fixture(t);
	if (!f) return;
	await f.tmux("resize-window", "-t", `${f.sessionName}:^`, "-x", "48");
	const code = 'pi_literal = """first\n── output ──\n│ literal pipe\nlast"""\nprint(pi_literal)';
	const expected = "first\n── output ──\n│ literal pipe\nlast";
	for (const echoMode of ["summary", "full"]) {
		const result = await f.send(code, { echoMode });
		assert.equal(result.content[0].text.split("Output:\n")[1], expected);
		const record = readReplSessionRecord((await f.status()).details.python.recordId);
		assert.equal(record.entries.at(-1).output, expected);
		const pane = await f.tmux("capture-pane", "-p", "-J", "-t", `${f.sessionName}:^`, "-S", "-150");
		assert.ok(pane.includes(`── pi-repl · input · 5 lines · id: ${result.details.submissionAnchorId} ──\n${code}\n── output ──`), pane);
		await assertCompletionGap(f, result);
	}
});

test("Summary is the default pane display; command and per-send overrides still work", { timeout: 30000 }, async (t) => {
	const f = await fixture(t);
	if (!f) return;
	await f.repl("echo");
	assert.match(f.notifications.at(-1).message, /REPL submission echo: summary/);
	const code = "for i in range(1, 6):\n    print(i)";
	const result = await f.send(code);
	assert.equal(result.details.echoMode, "summary");
	assert.ok(result.details.submissionAnchorId);
	await assertCompletionGap(f, result);
	assert.match(result.content[0].text, /Output:\n1\n2\n3\n4\n5/);
	assert.doesNotMatch(result.content[0].text, /──|│/);
	const historyPath = (await f.status()).details.python.historyPath;
	await eventually(() => readFileSync(historyPath, "utf8").includes(`── done · id: ${result.details.submissionAnchorId} ──`));
	assert.match(readFileSync(historyPath, "utf8"), /\n\n── pi-repl · input · 2 lines · id: [a-f0-9]{12} ──\nfor i in range\(1, 6\):\n    print\(i\)\n── output ──\n1\n2\n3\n4\n5\n── done/);

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
		const full = await f.send("print('explicit full')");
		assert.equal(full.details.echoMode, "full");
		await assertCompletionGap(f, full);
		const failure = await f.send("raise ValueError('footer gap error')");
		assert.match(failure.content[0].text, /ValueError: footer gap error/);
		await assertCompletionGap(f, failure);
	} finally {
		await f.repl("echo summary");
	}
});

for (const index of [0, 1]) {
	test(`Python lifecycle, private history, clean records and export with tmux indexes ${index}`, { timeout: 45000 }, async (t) => {
		const f = await fixture(t, { index, startWithTool: index === 1 });
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

test("concurrent repl_start calls create one session and preserve state when another interpreter is requested", { timeout: 30000 }, async (t) => {
	const f = await fixture(t, { index: 1, concurrentStart: true });
	if (!f) return;
	await f.send("pi_start_value = 41\nprint(pi_start_value)");
	await f.tmux("send-keys", "-t", `${f.sessionName}:^`, "-l", "pi_direct_start_value = pi_start_value + 1");
	await f.tmux("send-keys", "-t", `${f.sessionName}:^`, "Enter");
	await eventually(async () => (await f.tmux("capture-pane", "-p", "-t", `${f.sessionName}:^`)).endsWith(">>>"));
	const before = (await f.status()).details.python;
	await eventually(() => readFileSync(before.historyPath, "utf8").includes("pi_direct_start_value ="));
	const history = readFileSync(before.historyPath, "utf8");
	const calls = f.calls.length;
	const result = await f.start({ runtime: "ipython" });
	assert.equal(result.details.runtime, "python");
	assert.equal(result.details.ready, true);
	assert.equal(result.details.session.recordId, before.recordId);
	assert.equal(result.details.session.historyPath, before.historyPath);
	assert.equal(result.details.session.recordEntryCount, before.recordEntryCount);
	assert.equal(readFileSync(before.historyPath, "utf8"), history);
	assert.ok(f.calls.slice(calls).every((call) => !["new-session", "pipe-pane", "set-option", "send-keys", "load-buffer"].includes(call.args[0])));
	assert.match((await f.send("print(pi_direct_start_value)")).content[0].text, /Output:\n42/);
});

test("repl_start leaves unfinished direct input alone and can confirm readiness once the human finishes", { timeout: 30000 }, async (t) => {
	const f = await fixture(t, { startWithTool: true });
	if (!f) return;
	await f.tmux("send-keys", "-t", `${f.sessionName}:^`, "-l", "for pi_start_i in [42]:");
	await f.tmux("send-keys", "-t", `${f.sessionName}:^`, "Enter");
	await eventually(async () => (await f.tmux("capture-pane", "-p", "-t", `${f.sessionName}:^`)).endsWith("..."));
	const before = await f.tmux("capture-pane", "-p", "-t", `${f.sessionName}:^`);
	const calls = f.calls.length;
	const result = await f.start({ timeoutMs: 1000 });
	assert.equal(result.details.ready, false);
	assert.equal(result.details.reused, true);
	assert.equal(await f.tmux("capture-pane", "-p", "-t", `${f.sessionName}:^`), before);
	assert.ok(f.calls.slice(calls).every((call) => !["new-session", "pipe-pane", "set-option", "send-keys", "load-buffer", "kill-session"].includes(call.args[0])));
	await f.tmux("send-keys", "-t", `${f.sessionName}:^`, "-l", "    print(pi_start_i)");
	await f.tmux("send-keys", "-t", `${f.sessionName}:^`, "Enter", "Enter");
	assert.equal((await f.start()).details.ready, true);
	assert.match((await f.send("print(pi_start_i)")).content[0].text, /Output:\n42/);
});

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
	const otherIdentity = await f.tmux("display-message", "-p", "-t", `${other}:^`, "#{session_id}");
	const started = await f.start();
	assert.equal(started.details.created, true);
	assert.equal(started.details.ready, true);
	assert.equal(await f.tmux("display-message", "-p", "-t", `${other}:^`, "#{session_id}"), otherIdentity);
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
		const retained = readdirSync(process.env.PI_REPL_CONTROL_ROOT);
		assert.ok(retained.some((file) => file.endsWith(".py")));
		assertCorrelatedControlFiles(retained, readReplSessionRecord(recordId).entries.at(-1).id);
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

for (const runtime of ["octave", "matlab"]) {
	const options = { timeout: 90000, skip: !(optionalRuntimes.has("all") || optionalRuntimes.has(runtime)) };
	test(`${runtime} preserves base workspace, ans, direct input, cwd/path and script/function semantics`, options, async (t) => {
		const f = await fixture(t, { runtime, startWithTool: true, controlName: "m controls 'quotes' \\\u03bb" });
		if (!f) return;
		const output = async (code, extra = {}) => (await f.send(code, extra)).content[0].text.split("Output:\n")[1];
		assert.equal((await output("pi_value=40; ans=123; pi_repl_error=17; pi_repl_guard=18; pi_repl_status=19; pi_repl_column='user';", { echoMode: "off" })).trim(), "(no output)");
		await f.tmux("send-keys", "-t", `${f.sessionName}:^`, "-l", "pi_value=pi_value+2;");
		await f.tmux("send-keys", "-t", `${f.sessionName}:^`, "Enter");
		await eventually(async () => /(?:octave:\d+>|>>)\s*$/.test(await f.tmux("capture-pane", "-p", "-t", `${f.sessionName}:^`)));
		assert.match(await output("fprintf('%d %d %d %d %d %s\\n',pi_value,ans,pi_repl_error,pi_repl_guard,pi_repl_status,pi_repl_column);"), /42 123 17 18 19 user/);
		assert.match(await output("6*7"), /ans\s*=\s*42/);
		assert.match(await output("fprintf('ans-now=%d\\n',ans);"), /ans-now=42/);
		assert.match(await output("fprintf('λ 🧪 100%% \\n');"), /λ 🧪 100%/);
		assert.match(await output("error('current-error')"), /current-error/);
		const syntax = await output("if");
		assert.match(syntax, /Error:|error:/);
		assert.doesNotMatch(syntax, /current-error|uint8\(/);
		assert.equal((await output("return; error('must-not-run')")).trim(), "(no output)");
		const work = join(f.cwd, "work space λ");
		mkdirSync(work);
		writeFileSync(join(work, "pi_script.m"), "script_value=21;\n");
		writeFileSync(join(work, "pi_twice.m"), "function y=pi_twice(x)\ny=2*x;\nend\n");
		const mquote = (value) => `'${value.replaceAll("'", "''")}'`;
		assert.doesNotMatch(await output(`cd(${mquote(work)}); addpath(${mquote(f.cwd)}); run('pi_script.m');`), /Error:/);
		assert.match(await output("fprintf('function=%d\\n',pi_twice(script_value));"), /function=42/);
		assert.match(await output(`fprintf('cwd=%d path=%d\\n',strcmp(pwd,${mquote(realpathSync(work))}),~isempty(strfind(path,${mquote(f.cwd)})));`), /cwd=1 path=1/);
		assert.match(await output("clear all; final_value=42; fprintf('clear-done\\n');"), /clear-done/);
		assert.match(await output("fprintf('survives=%d\\n',final_value); fprintf('names=%s\\n',strjoin(sort(who()),','));"), /survives=42\nnames=final_value/);
		await f.repl(`export ${runtime}`);
		const record = readReplSessionRecord((await f.status()).details[f.target].recordId);
		assert.ok(record.entries.every((entry) => entry.runtime === runtime));
		assert.match(readFileSync(join(f.cwd, readdirSync(f.cwd).find((name) => name.endsWith(".md"))), "utf8"), new RegExp('```' + runtime));
		await assertVerifiedStop(f);
	});

	test(`${runtime} full display, unterminated output and optional figure export`, options, async (t) => {
		const f = await fixture(t, { runtime });
		if (!f) return;
		const code = [...Array.from({ length: 12 }, (_, i) => `% comment ${i}`), "fprintf('no newline');"].join("\n");
		const result = await f.send(code, { echoMode: "full" });
		assert.equal(result.content[0].text.split("Output:\n")[1].trim(), "no newline");
		const pane = await f.tmux("capture-pane", "-p", "-J", "-t", `${f.sessionName}:^`, "-S", "-200");
		assert.match(pane, /no newline\n── done/);
		const fallback = await f.send("pi_saved_path=getenv('PATH'); setenv('PATH','/missing-pi-test'); fprintf('fallback');");
		assert.equal(fallback.content[0].text.split("Output:\n")[1].trim(), "fallback");
		await f.send("setenv('PATH',pi_saved_path); clear pi_saved_path;");
		let graphics = true;
		if (runtime === "octave") {
			graphics = /headless=1/.test((await f.send("fprintf('headless=%d\\n',any(strcmp(available_graphics_toolkits(),'gnuplot')));")).content[0].text);
			if (graphics) assert.doesNotMatch((await f.send("graphics_toolkit('gnuplot');")).content[0].text.split("Output:\n")[1], /Error:/);
		}
		if (graphics) {
			const image = join(f.cwd, "figure.png");
			const result = await f.send(`figure('visible','off'); ${runtime === "octave" ? "graphics_toolkit(gcf,'gnuplot'); " : ""}plot(1:3,[1 4 9]); print(gcf,'${image}','-dpng'); close(gcf);`, { timeoutMs: 30000 });
			assert.doesNotMatch(result.content[0].text.split("Output:\n")[1], /Error:/);
			assert.deepEqual(readFileSync(image).subarray(0,8), Buffer.from([137,80,78,71,13,10,26,10]));
		} else t.diagnostic("No gnuplot toolkit for invisible Octave figure export; native figure windows are not opened by this test.");
		await assertVerifiedStop(f);
	});

	for (const mode of ["timeout", "abort", "interrupt", "exit"]) {
		test(`${runtime} ${mode} settles controls and lease`, options, async (t) => {
			const f = await fixture(t, { runtime });
			if (!f) return;
			const id = (await f.status()).details[f.target].recordId;
			const abort = new AbortController();
			if (mode === "abort") f.onEnter(() => abort.abort());
			if (mode === "interrupt") f.onEnter(async () => {
				await eventually(() => readdirSync(f.cwd).includes("started"));
				await f.tmux("send-keys", "-t", `${f.sessionName}:^`, "C-c");
			});
			const code = mode === "exit" ? "exit" : `fclose(fopen('started','w')); pause(${mode === "interrupt" ? 30 : 2.5}); fprintf('settled\\n');`;
			const request = f.send(code, { timeoutMs: mode === "timeout" ? 1000 : 15000 }, abort.signal);
			if (mode === "interrupt") await request;
			else if (mode === "exit") {
				// MATLAB may run onCleanup before its pane closes. Either an
				// observed completion or a session-ended error is valid here.
				await request.catch((error) => assert.match(error.message, /session ended/));
				await eventually(async () => !(await f.status()).details[f.target].running);
			} else await assert.rejects(request, mode === "abort" ? /aborted/ : /Timed out/);
			f.onEnter(undefined);
			if (mode === "timeout" || mode === "abort") {
				const retained = readdirSync(process.env.PI_REPL_CONTROL_ROOT);
				assert.ok(retained.filter((name) => name.endsWith(".m")).length >= 2);
				assertCorrelatedControlFiles(retained, readReplSessionRecord(id).entries.at(-1).id);
				await assert.rejects(acquireReplSessionSendLease(id, { waitMs: 0 }), /busy/);
			}
			await eventually(async () => {
				try { const lease = await acquireReplSessionSendLease(id, { waitMs: 0 }); await lease.release(); return true; }
				catch (error) { if (/busy/.test(error.message)) return false; throw error; }
			});
			assert.equal(readdirSync(process.env.PI_REPL_CONTROL_ROOT).length, 0);
			if (mode !== "exit") {
				assert.match((await f.send("fprintf('recovered\\n');")).content[0].text, /Output:\nrecovered/);
				await assertVerifiedStop(f);
			}
		});
	}
}

const runtimeCases = [
	["python", "pi_test_x = 41\nprint(pi_test_x + 1)", "raise ValueError('runtime-test-error')"],
	["ipython", "pi_test_x = 41\nprint(pi_test_x + 1)", "raise ValueError('runtime-test-error')"],
	["julia", "pi_test_x = 41\nprintln(pi_test_x + 1)", 'error("runtime-test-error")'],
	["r", "pi_test_x <- 41\nprint(pi_test_x + 1)", 'stop("runtime-test-error")'],
	["ghci", "let pi_test_x = 41\nprint (pi_test_x + 1)", 'error "runtime-test-error"'],
	["clojure", "(def pi-test-x 41)\n(println (+ pi-test-x 1))", '(throw (Exception. "runtime-test-error"))'],
	["ruby", "pi_test_x = 41\nputs pi_test_x + 1", "raise 'runtime-test-error'"],
	["java", "int pi_test_x = 41;\nSystem.out.println(pi_test_x + 1);", 'throw new RuntimeException("runtime-test-error");'],
	["octave", "pi_test_x = 41;\nfprintf('%d\\n', pi_test_x + 1);", "error('runtime-test-error');"],
	["matlab", "pi_test_x = 41;\nfprintf('%d\\n', pi_test_x + 1);", "error('runtime-test-error');"],
	["gnuplot", "pi_test_x = 41\nprint pi_test_x + 1", 'exit error "runtime-test-error"'],
];
for (const [runtime, code, errorCode] of runtimeCases) {
	test(`${runtime} multiline wrapper, display cleanup and runtime errors`, {
		timeout: 60000,
		skip: runtime !== "python" && !(optionalRuntimes.has("all") || optionalRuntimes.has(runtime)) && "set PI_REPL_TEST_RUNTIMES=all to include installed optional runtimes",
	}, async (t) => {
		const f = await fixture(t, { index: 1, runtime, startWithTool: true });
		if (!f) return;
		for (const echoMode of ["off", "summary", "full"]) {
			// Exercise both wrapped and unwrapped R loader echoes.
			if (runtime === "r" && echoMode === "full") await f.tmux("resize-window", "-t", `${f.sessionName}:^`, "-x", "320");
			let allocated = [];
			f.onEnter(() => { allocated = readdirSync(process.env.PI_REPL_CONTROL_ROOT); });
			const result = await f.send(code, { echoMode });
			f.onEnter(undefined);
			const family = allocated.filter((name) => !name.endsWith(".txt"));
			const anchorId = assertCorrelatedControlFiles(family, result.details.recordEntryId);
			const sources = family.filter((name) => !name.endsWith(".done"));
			assert.equal(sources.length, { ghci: 3, java: 2, octave: 2, matlab: 2, gnuplot: 3 }[runtime] ?? 1, "all source, guard and driver files must share the prefix");
			const pasteFiles = allocated.filter((name) => name.endsWith(".txt"));
			assert.equal(pasteFiles.length, 1);
			assert.match(pasteFiles[0], /^[a-f0-9]{16}\.txt$/, "transient paste-buffer files remain unlabelled");
			assert.equal(result.details.submissionAnchorId, echoMode === "off" ? undefined : anchorId);
			assert.equal(readdirSync(process.env.PI_REPL_CONTROL_ROOT).length, 0);
			const pane = await f.tmux("capture-pane", "-p", "-J", "-t", `${f.sessionName}:^`, "-S", "-80");
			if (runtime === "python" || runtime === "julia") assert.ok(pane.includes(sources[0]), pane);
			assert.match(result.content[0].text.split("Output:\n")[1], /42/, pane);
			assert.doesNotMatch(result.content[0].text, /──|│/);
			if (echoMode !== "off") {
				const begin = `── pi-repl · input · 2 lines · id: ${result.details.submissionAnchorId} ──`;
				assert.ok(pane.includes(begin), pane);
				const latest = pane.slice(pane.lastIndexOf(begin));
				assert.ok(latest.startsWith(`${begin}\n${code}\n── output ──\n`), latest);
				// -J joins soft-wrapped rows, including an empty row after a
				// wrapped R loader. Check physical rows for visual spacing.
				const physical = await f.tmux("capture-pane", "-p", "-t", `${f.sessionName}:^`, "-S", "-150");
				assert.match(physical.slice(0, physical.lastIndexOf(begin)), /\n\n$/, physical);
				if (runtime !== "ghci") assert.doesNotMatch(latest, /\n\n── done/, latest);
				await assertCompletionGap(f, result);
			} else {
				assert.doesNotMatch(pane, /── pi-repl|── output ──|── done/);
			}
		}
		const beforeReuse = (await f.status()).details[f.target];
		const callCount = f.calls.length;
		const reused = await f.start();
		assert.equal(reused.details.created, false);
		assert.equal(reused.details.reused, true);
		assert.equal(reused.details.ready, true, reused.content[0].text);
		assert.equal(reused.details.session.recordId, beforeReuse.recordId);
		assert.equal(reused.details.session.historyPath, beforeReuse.historyPath);
		assert.equal(reused.details.session.recordEntryCount, beforeReuse.recordEntryCount);
		assert.ok(f.calls.slice(callCount).every((call) => !["new-session", "pipe-pane", "set-option", "send-keys", "load-buffer"].includes(call.args[0])));
		if (runtime === "julia") {
			const literal = await f.send('println(raw"literal $value and λ")', { echoMode: "full" });
			assert.match(literal.content[0].text.split("Output:\n")[1], /literal \$value and λ/);
			assert.doesNotMatch(literal.content[0].text, /──|│/);
		}
		const result = await f.send(errorCode, { echoMode: "full" });
		assert.match(result.content[0].text.split("Output:\n")[1], /runtime-test-error/);
		await assertCompletionGap(f, result);
		assert.doesNotMatch(result.content[0].text, /──|│/);
		assert.equal(readdirSync(process.env.PI_REPL_CONTROL_ROOT).length, 0);
		assert.ok(readReplSessionRecord((await f.status()).details[f.target].recordId).entries.every((entry) => entry.runtime === runtime), "record entries must retain their real runtime");
		await assertVerifiedStop(f);
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
			await eventually(() => readFileSync(firstHistory, "utf8").includes(`── done · id: ${shared.details.submissionAnchorId} ──`));
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

test("ghci completes malformed source, including unterminated multiline blocks, and releases the lease", {
	timeout: 60000, skip: !(optionalRuntimes.has("all") || optionalRuntimes.has("ghci")),
}, async (t) => {
	const f = await fixture(t, { runtime: "ghci", index: 1 });
	if (!f) return;
	const recordId = (await f.status()).details.ghci.recordId;
	await f.send("let pi_ghci_value = 41");
	const malformed = [
		["let broken =", /parse error/],
		["print (", /parse error/],
		[":{\nlet unfinished = 1", /unterminated multiline command/],
		["let pi_before_bad = 17\n:{\nlet unfinished = 1", /unterminated multiline command/],
		[':cmd Prelude.return ":{\\nlet unfinished = 1"', /unterminated multiline command/],
		["{- unfinished comment", /unterminated/],
	];
	for (const echoMode of ["off", "summary", "full"]) {
		for (const [code, expected] of malformed) {
			// A driver without the intermediate guard skips completion on :{.
			// Preserve native errors and partial execution, not repaired source.
			const result = await f.send(code, { echoMode, timeoutMs: 3000 });
			assert.match(result.content[0].text.split("Output:\n")[1], expected);
			assert.doesNotMatch(result.content[0].text, /──|│/);
			assert.equal(readdirSync(process.env.PI_REPL_CONTROL_ROOT).length, 0);
			const lease = await acquireReplSessionSendLease(recordId, { waitMs: 0 });
			await lease.release();
		}
		const recovered = await f.send(":{\nlet pi_ghci_twice x =\n      2 * x\n:}\nprint (pi_ghci_twice (pi_ghci_value - 20))", { echoMode });
		assert.equal(recovered.content[0].text.split("Output:\n")[1], "42");
	}
	assert.equal((await f.send("print pi_before_bad")).content[0].text.split("Output:\n")[1], "17");
	const queued = await f.send(':cmd Prelude.return "Control.Concurrent.threadDelay 300000 >> putStrLn \\"queued result\\""');
	assert.equal(queued.content[0].text.split("Output:\n")[1], "queued result");
	const status = (await f.status()).details.ghci;
	assert.equal(status.running, true);
	assert.ok(status.recordEntries.every((entry) => entry.status === "captured"));
});

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
		['puts "=> nil"', "=> nil"],
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

for (const runtime of ["ghci", "ruby", "java"]) {
	test(`${runtime} compact display preserves non-newline output and user blank lines`, {
		timeout: 60000, skip: !(optionalRuntimes.has("all") || optionalRuntimes.has(runtime)),
	}, async (t) => {
		const f = await fixture(t, { runtime, index: 1 });
		if (!f) return;
		const cases = [
			['puts "42"', 'System.out.println("42");', "42\n", 'putStrLn "42"'],
			['print "no newline"', 'System.out.print("no newline");', "no newline\n", 'putStr "no newline"'],
			['$stderr.print "stderr tail"', 'System.err.print("stderr tail");', "stderr tail\n", 'System.IO.hPutStr System.IO.stderr "stderr tail"'],
			['print "λ 🧪"', 'System.out.print("λ 🧪");', "λ 🧪\n", 'putStr "λ 🧪"'],
			[`print "${"x".repeat(80)}"`, `System.out.print("${"x".repeat(80)}");`, "x".repeat(80) + "\n", `putStr "${"x".repeat(80)}"`],
			['print "first\\n\\nlast\\n\\n"', 'System.out.print("first\\n\\nlast\\n\\n");', "first\n\nlast\n\n", 'putStr "first\\n\\nlast\\n\\n"'],
			['nil', ';', "", 'let pi_quiet = 1'],
		];
		for (const echoMode of ["summary", "full"]) {
			for (const [ruby, java, expected, ghci] of cases) {
				const result = await f.send({ ruby, java, ghci }[runtime], { echoMode });
				assert.equal(result.content[0].text.split("Output:\n")[1], expected.trim() || "(no output)");
				const pane = await f.tmux("capture-pane", "-p", "-J", "-t", `${f.sessionName}:^`, "-S", "-1000");
				const begin = `── pi-repl · input · 1 line · id: ${result.details.submissionAnchorId} ──`;
				const latest = pane.slice(pane.lastIndexOf(begin));
				assert.match(pane.slice(0, pane.lastIndexOf(begin)), /\n\n$/, pane);
				const bodyStart = latest.indexOf("── output ──\n") + "── output ──\n".length;
				const bodyEnd = latest.lastIndexOf(`── done · id: ${result.details.submissionAnchorId} ──`);
				assert.equal(latest.slice(bodyStart, bodyEnd), expected, latest);
			}
		}
		if (runtime === "ruby") {
			await f.send('system("sh", "-c", "exit 7")');
			const status = await f.send('puts "child status: #{$?.exitstatus}"');
			assert.equal(status.content[0].text.split("Output:\n")[1], "child status: 7");
		}
		assert.equal(readdirSync(process.env.PI_REPL_CONTROL_ROOT).length, 0);
	});

	for (const failure of ["unavailable", "timeout"]) {
		test(`${runtime} footer falls back safely when its cursor query is ${failure}`, {
			timeout: 30000, skip: !(optionalRuntimes.has("all") || optionalRuntimes.has(runtime)),
		}, async (t) => {
			const f = await fixture(t, { runtime });
			if (!f) return;
			const realTmux = binary("tmux");
			const pidPath = join(f.cwd, "query.pid");
			// Only the runtime's own query sees TMUX_PANE. Harness calls still
			// reach the real tmux on this fixture's isolated server.
			writeFileSync(join(f.cwd, "bin", "tmux"), `#!/bin/sh\nif [ -n "\${TMUX_PANE:-}" ]; then\n  echo $$ > ${quote(pidPath)}\n  ${failure === "timeout" ? 'exec /bin/sleep 10' : 'exit 23'}\nfi\nexec ${quote(realTmux)} "$@"\n`, { mode: 0o700 });
			const code = { ruby: 'print "query fallback"', java: 'System.out.print("query fallback");', ghci: 'putStr "query fallback"' }[runtime];
			const result = await f.send(code, { timeoutMs: 4000 });
			assert.equal(result.content[0].text.split("Output:\n")[1], "query fallback");
			const pane = await f.tmux("capture-pane", "-p", "-J", "-t", `${f.sessionName}:^`, "-S", "-80");
			assert.match(pane, /── output ──\nquery fallback\n── done/);
			await assertCompletionGap(f, result);
			const pid = Number(readFileSync(pidPath, "utf8").trim());
			assert.ok(Number.isSafeInteger(pid) && pid > 0);
			await eventually(() => {
				try { process.kill(pid, 0); return false; }
				catch (error) { if (error.code === "ESRCH") return true; throw error; }
			});
			assert.equal(readdirSync(process.env.PI_REPL_CONTROL_ROOT).length, 0);
		});
	}
}

test("ghci shell fallback preserves the footer gap if Node cannot start", {
	timeout: 30000, skip: !(optionalRuntimes.has("all") || optionalRuntimes.has("ghci")),
}, async (t) => {
	const f = await fixture(t, { runtime: "ghci" });
	if (!f) return;
	const result = await f.send('import qualified System.Environment\nSystem.Environment.setEnv "NODE_OPTIONS" "--pi-repl-invalid-test-option"\nputStr "shell fallback"');
	assert.equal(result.content[0].text.split("Output:\n")[1], "shell fallback");
	await assertCompletionGap(f, result);
	await f.send('System.Environment.unsetEnv "NODE_OPTIONS"');
	assert.equal(readdirSync(process.env.PI_REPL_CONTROL_ROOT).length, 0);
});

test("ruby suppresses only its loader result and restores manual echo and custom predicates", {
	timeout: 60000, skip: !(optionalRuntimes.has("all") || optionalRuntimes.has("ruby")),
}, async (t) => {
	const f = await fixture(t, { runtime: "ruby", index: 1 });
	if (!f) return;
	const capture = () => f.tmux("capture-pane", "-p", "-J", "-t", `${f.sessionName}:^`, "-S", "-1000");
	for (const echoMode of ["off", "summary", "full"]) {
		assert.equal((await f.send("40 + 2", { echoMode })).content[0].text.split("Output:\n")[1], "42");
		await f.send("nil", { echoMode });
	}
	await f.send("def broken(");
	await f.send('raise "intentional echo test"');
	assert.doesNotMatch(await capture(), /^=>\s*nil$/m);
	assert.equal((await f.send('puts IRB.CurrentContext.singleton_class.instance_methods(false).include?(:echo?)')).content[0].text.split("Output:\n")[1], "false");
	async function direct(code) {
		const before = await capture();
		const start = before.lastIndexOf("\n") + 1;
		await f.tmux("send-keys", "-t", `${f.sessionName}:^`, "-l", code);
		await f.tmux("send-keys", "-t", `${f.sessionName}:^`, "C-m");
		let tail;
		await eventually(async () => {
			tail = (await capture()).slice(start);
			return tail.includes(code) && /^irb\(.*\)[:\d]+>\s*$/.test(tail.split("\n").at(-1));
		});
		return tail;
	}
	assert.match(await direct("4321 + 1"), /=> 4322/);
	assert.match(await direct("nil"), /=> nil/);
	await f.send("IRB.CurrentContext.echo = false");
	assert.doesNotMatch(await direct("7654 + 1"), /=> 7655/);
	assert.equal((await f.send("puts IRB.CurrentContext.echo?")).content[0].text.split("Output:\n")[1], "false");
	await f.send("IRB.CurrentContext.echo = true");
	await f.send("echo_owner = IRB.CurrentContext\ndef echo_owner.echo?; @echo; end\npi_echo_original = echo_owner.method(:echo?)\nnil");
	assert.equal((await f.send("puts(pi_echo_original == IRB.CurrentContext.method(:echo?))")).content[0].text.split("Output:\n")[1], "true");
	assert.match(await direct("8765 + 1"), /=> 8766/);
});

test("ghci echoes one loader only and completes after queued code", {
	timeout: 60000, skip: !(optionalRuntimes.has("all") || optionalRuntimes.has("ghci")),
}, async (t) => {
	const f = await fixture(t, { runtime: "ghci", index: 1 });
	if (!f) return;
	const historyPath = (await f.status()).details.ghci.historyPath;
	let sends = 0;
	for (const echoMode of ["off", "summary", "full"]) {
		const result = await f.send('let pi_quiet_value = 41\nprint (pi_quiet_value + 1)', { echoMode });
		sends++;
		assert.equal(result.content[0].text.split("Output:\n")[1], "42");
		const pane = await f.tmux("capture-pane", "-p", "-J", "-t", `${f.sessionName}:^`, "-S", "-1000");
		assert.equal((pane.match(/^ghci> :script /gm) || []).length, sends, pane);
		assert.doesNotMatch(pane, /^ghci> :!|^ghci> :cmd/m);
		if (echoMode !== "off") await eventually(() => readFileSync(historyPath, "utf8").includes(`── done · id: ${result.details.submissionAnchorId} ──`));
	}
	assert.equal((readFileSync(historyPath, "utf8").match(/^ghci> :script /gm) || []).length, sends);
	// Normal queued commands must finish before completion; a :cmd queue
	// containing both source and completion would complete too early.
	const queued = await f.send(':cmd Prelude.return "Control.Concurrent.threadDelay 300000 >> print (pi_quiet_value + 2)"');
	assert.equal(queued.content[0].text.split("Output:\n")[1], "43");
	// :quit stops the current source script, as in native :script; it must
	// neither execute the remaining source nor prevent driver completion.
	await f.send("let pi_before_quit = 11\n:quit\nlet pi_after_quit = 12");
	assert.equal((await f.send("print pi_before_quit")).content[0].text.split("Output:\n")[1], "11");
	assert.match((await f.send("print pi_after_quit")).content[0].text.split("Output:\n")[1], /not in scope/);
	assert.equal((await f.send(":set +m\nlet pi_auto =\n      17\n\nprint pi_auto")).content[0].text.split("Output:\n")[1], "17");
	assert.equal((await f.send("print pi_auto")).content[0].text.split("Output:\n")[1], "17");
	assert.equal(readdirSync(process.env.PI_REPL_CONTROL_ROOT).length, 0);
});

test("java echoes only one loader command per send in every display mode", {
	timeout: 60000, skip: !(optionalRuntimes.has("all") || optionalRuntimes.has("java")),
}, async (t) => {
	const f = await fixture(t, { runtime: "java", index: 1 });
	if (!f) return;
	const historyPath = (await f.status()).details.java.historyPath;
	let sends = 0;
	for (const echoMode of ["off", "summary", "full"]) {
		const result = await f.send('System.out.println("one loader");', { echoMode });
		sends++;
		assert.equal(result.content[0].text.split("Output:\n")[1], "one loader");
		const pane = await f.tmux("capture-pane", "-p", "-J", "-t", `${f.sessionName}:^`, "-S", "-1000");
		assert.equal((pane.match(/^jshell> \/open /gm) || []).length, sends, pane);
		if (echoMode !== "off") {
			assert.ok(pane.includes(`── done · id: ${result.details.submissionAnchorId} ──`));
			await eventually(() => readFileSync(historyPath, "utf8").includes(`── done · id: ${result.details.submissionAnchorId} ──`));
		} else {
			assert.doesNotMatch(pane, /── pi-repl|── done/);
		}
		assert.equal(readdirSync(process.env.PI_REPL_CONTROL_ROOT).length, 0);
	}
	const record = (await f.status()).details.java;
	assert.equal(record.recordEntryCount, sends);
	assert.ok(record.recordEntries.every((entry) => entry.output === "one loader"));
	assert.equal((readFileSync(historyPath, "utf8").match(/^jshell> \/open /gm) || []).length, sends);
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
	for (const code of ['int broken = ;', 'int unfinished =', '/* unfinished comment', '"unfinished string', 'int incomplete(int x) {']) {
		const result = await f.send(code, { timeoutMs: 3000 });
		assert.equal(result.details.runtime, "java");
		assert.doesNotMatch(result.content[0].text, /──|│/);
		if (code === 'int broken = ;') assert.match(result.content[0].text.split("Output:\n")[1], /Error:/);
		const recovered = await f.send("System.out.println(twice(21));");
		assert.match(recovered.content[0].text.split("Output:\n")[1], /42/);
		assert.equal(readdirSync(process.env.PI_REPL_CONTROL_ROOT).length, 0);
	}
});

test("java driver stops with an explicit /exit and releases both files and its lease", {
	timeout: 30000, skip: !(optionalRuntimes.has("all") || optionalRuntimes.has("java")),
}, async (t) => {
	const f = await fixture(t, { runtime: "java" });
	if (!f) return;
	const recordId = (await f.status()).details.java.recordId;
	await assert.rejects(f.send("/exit", { timeoutMs: 5000 }), /REPL session ended/);
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
	assert.equal((await f.status()).details.java.running, false);
});

for (const runtime of ["ghci", "java", "gnuplot"]) {
	test(`${runtime} refuses line breaks in command paths before submission and releases its lease`, {
		timeout: 30000, skip: !(optionalRuntimes.has("all") || optionalRuntimes.has(runtime)),
	}, async (t) => {
		const f = await fixture(t, { runtime, controlName: "controls\ninvalid" });
		if (!f) return;
		const recordId = (await f.status()).details[runtime].recordId;
		const callsBefore = f.calls.length;
		await assert.rejects(f.send(runtime === "java" ? "System.out.println(42);" : "print 42"), /control paths cannot contain line breaks/);
		assert.equal(f.calls.slice(callsBefore).some((call) => call.args[0] === "paste-buffer"), false);
		assert.equal(readdirSync(process.env.PI_REPL_CONTROL_ROOT).length, 0);
		const lease = await acquireReplSessionSendLease(recordId, { waitMs: 0 });
		await lease.release();
	});
}

for (const runtime of ["ghci", "ruby", "java"]) {
	for (const mode of (runtime === "ghci" ? ["timeout", "abort", "session-ended"] : ["timeout", "abort"])) {
		test(`${runtime} ${mode} holds the lease until code actually finishes`, {
			timeout: 60000, skip: !(optionalRuntimes.has("all") || optionalRuntimes.has(runtime)),
		}, async (t) => {
			const f = await fixture(t, { runtime });
			if (!f) return;
			const recordId = (await f.status()).details[runtime].recordId;
			const abort = new AbortController();
			if (mode !== "timeout") f.onEnter(() => abort.abort());
			const slow = { ruby: 'sleep 2.5\nputs "late result"', java: 'Thread.sleep(2500);\nSystem.out.println("late result");', ghci: `Control.Concurrent.threadDelay ${mode === "session-ended" ? 30000000 : 2500000} >> putStrLn "late result"` }[runtime];
			await assert.rejects(f.send(slow, { timeoutMs: 1000 }, abort.signal), mode !== "timeout" ? /aborted/ : /Timed out waiting/);
			f.onEnter(undefined);
			await assert.rejects(acquireReplSessionSendLease(recordId, { waitMs: 0 }), /busy/);
			const retained = readdirSync(process.env.PI_REPL_CONTROL_ROOT).filter((file) => file.endsWith({ ruby: ".rb", java: ".java", ghci: ".ghci" }[runtime]));
			assert.equal(retained.length, { ruby: 1, java: 2, ghci: 3 }[runtime]);
			assertCorrelatedControlFiles(retained, readReplSessionRecord(recordId).entries.at(-1).id);
			for (const file of retained) assert.equal(statSync(join(process.env.PI_REPL_CONTROL_ROOT, file)).mode & 0o777, 0o600);
			if (mode === "session-ended") {
				await f.tmux("kill-session", "-t", f.sessionName);
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
				const next = await f.send({ ruby: 'puts "next request"', java: 'System.out.println("next request");', ghci: 'putStrLn "next request"' }[runtime]);
				assert.match(next.content[0].text, /next request/);
				assert.doesNotMatch(next.content[0].text, /late result/);
			}
		});
	}
}

const gnuplotTestOptions = { timeout: 60000, skip: !(optionalRuntimes.has("all") || optionalRuntimes.has("gnuplot")) };
const outputOf = (result) => result.content[0].text.split("Output:\n")[1];

async function assertGnuplotSettled(recordId) {
	await eventually(async () => {
		try { const lease = await acquireReplSessionSendLease(recordId, { waitMs: 0 }); await lease.release(); return true; }
		catch (error) { if (/busy/.test(error.message)) return false; throw error; }
	});
	assert.equal(readdirSync(process.env.PI_REPL_CONTROL_ROOT).length, 0);
}

test("gnuplot native state, direct edits, literal paths, plots, records and exports", gnuplotTestOptions, async (t) => {
	const f = await fixture(t, { runtime: "gnuplot", controlName: "gnuplot 'single''pair' \"quoted\" `touch GNUPLOT_INJECTED` $(touch GNUPLOT_INJECTED) # @missing \\ λ" });
	if (!f) return;
	const status = (await f.status()).details.gnuplot;
	assert.equal(status.runtime, "gnuplot");
	assert.equal(statSync(status.historyPath).mode & 0o777, 0o600);
	const capture = () => f.tmux("capture-pane", "-p", "-J", "-t", `${f.sessionName}:^`, "-S", "-200");
	await f.send('a = 0.2\nf(x) = exp(-a*x)*sin(5*x)\nset term dumb size 55,15\nset title "Native gnuplot"\nplot [0:20] f(x)');
	await f.tmux("send-keys", "-t", `${f.sessionName}:^`, "-l", 'a = 0.4; print "human-ready"');
	await f.tmux("send-keys", "-t", `${f.sessionName}:^`, "C-m");
	await eventually(async () => /\nhuman-ready\ngnuplot>/.test(await capture()));
	assert.equal(outputOf(await f.send("print a\nprint f(0)")), "0.4\n0.0");
	assert.match(outputOf(await f.send("replot")), /Native gnuplot/);
	const literal = "literal '' `touch GNUPLOT_INJECTED` @missing $value \\ λ 🧪";
	assert.equal(outputOf(await f.send(`print ${gnuplotStringLiteral(literal)}`, { echoMode: "full" })), literal);
	assert.equal(existsSync(join(f.cwd, "GNUPLOT_INJECTED")), false);
	const svg = join(f.cwd, "native 'λ'.svg");
	await f.send(`set term push\nset term svg size 640,360\nset output ${gnuplotStringLiteral(svg)}\nreplot\nunset output\nset term pop`);
	assert.match(readFileSync(svg, "utf8"), /<svg[\s>]/);
	assert.match(readFileSync(svg, "utf8"), /Native gnuplot/);
	assert.match(outputOf(await f.send("show terminal")), /dumb/);
	const final = (await f.status()).details.gnuplot;
	assert.equal(final.recordId, status.recordId);
	assert.ok(final.recordEntries.every((entry) => entry.runtime === "gnuplot"));
	assert.ok(final.recordEntries.every((entry) => !/human-ready/.test(entry.code)));
	await eventually(() => readFileSync(status.historyPath, "utf8").includes("human-ready"));
	await f.repl("export gnuplot");
	const exported = readdirSync(f.cwd).find((file) => file.endsWith(".md"));
	assert.match(readFileSync(join(f.cwd, exported), "utf8"), /```gnuplot/);
	await assertGnuplotSettled(status.recordId);
	await assertVerifiedStop(f);
});

test("gnuplot preserves print/output destinations, table mode, settings and native error status", gnuplotTestOptions, async (t) => {
	const f = await fixture(t, { runtime: "gnuplot" });
	if (!f) return;
	const printFile = join(f.cwd, "user-print.txt"), plotFile = join(f.cwd, "user-plot.txt"), tableFile = join(f.cwd, "user-table.txt");
	const beforeFile = join(f.cwd, "before.gp"), afterFile = join(f.cwd, "after.gp");
	await f.send(`set print ${gnuplotStringLiteral(printFile)}\nset output ${gnuplotStringLiteral(plotFile)}\nset title 'keep title'\nset logscale x\nset label 3 'keep label'\nsave set ${gnuplotStringLiteral(beforeFile)}`);
	assert.equal(outputOf(await f.send('print "first"')), "(no output)");
	assert.equal(outputOf(await f.send('print "second"', { echoMode: "off" })), "(no output)");
	await f.send(`save set ${gnuplotStringLiteral(afterFile)}`);
	assert.equal(readFileSync(afterFile, "utf8"), readFileSync(beforeFile, "utf8"));
	await f.send(`set table ${gnuplotStringLiteral(tableFile)}\nplot [1:3] x`);
	await f.send('print "third"');
	await f.send('plot [1:3] 2*x\nunset table\nset print\nunset output');
	assert.equal(readFileSync(printFile, "utf8"), "first\nsecond\nthird\n");
	assert.doesNotMatch(readFileSync(plotFile, "utf8") + readFileSync(tableFile, "utf8"), /──|pi-repl|done/);
	assert.match(readFileSync(tableFile, "utf8"), /2\*x/);
	await f.send('system "exit 7"');
	assert.equal(outputOf(await f.send("print GPVAL_SYSTEM_ERRNO")), "7");
	await f.send("print undefined_state_probe");
	assert.equal(outputOf(await f.send("print GPVAL_ERRNO")), "1");
	assert.match(outputOf(await f.send("print GPVAL_ERRMSG")), /undefined variable: undefined_state_probe/);
	await assertVerifiedStop(f);
});

test("gnuplot display preserves literal markers, Unicode and native output spacing", gnuplotTestOptions, async (t) => {
	const f = await fixture(t, { runtime: "gnuplot" });
	if (!f) return;
	const cases = [
		['print "42"', "42\n"],
		['system "printf \'no newline\'"', "no newline\n"],
		['print "λ 🧪"', "λ 🧪\n"],
		[`print "${"x".repeat(80)}"`, "x".repeat(80) + "\n"],
		['print "first\\n\\nlast\\n"', "first\n\nlast\n\n"],
		['print "── output ──"', "── output ──\n"],
		['answer = 42', ""],
	];
	for (const echoMode of ["summary", "full"]) {
		for (const [code, expected] of cases) {
			const result = await f.send(code, { echoMode });
			assert.equal(outputOf(result), expected.trim() || "(no output)");
			const pane = await f.tmux("capture-pane", "-p", "-J", "-t", `${f.sessionName}:^`, "-S", "-150");
			const begin = `── pi-repl · input · 1 line · id: ${result.details.submissionAnchorId} ──`;
			const latest = pane.slice(pane.lastIndexOf(begin));
			const start = latest.indexOf("── output ──\n") + "── output ──\n".length;
			const end = latest.lastIndexOf(`── done · id: ${result.details.submissionAnchorId} ──`);
			assert.equal(latest.slice(start, end), expected);
			await assertCompletionGap(f, result);
		}
	}
	await f.tmux("resize-window", "-t", `${f.sessionName}:^`, "-x", "48");
	const literal = await f.send('$text << EOD\nfirst\n── output ──\n│ literal pipe\nlast\nEOD\nprint $text', { echoMode: "full" });
	assert.equal(outputOf(literal), "first\n── output ──\n│ literal pipe\nlast");
	await assertVerifiedStop(f);
});

test("gnuplot malformed and nested scripts recover without rollback or helper variables", gnuplotTestOptions, async (t) => {
	const f = await fixture(t, { runtime: "gnuplot" });
	if (!f) return;
	const recordId = (await f.status()).details.gnuplot.recordId;
	const nested = join(f.cwd, "nested 'λ'.gp");
	writeFileSync(nested, 'nested_value = 17\nexit error "nested-error"\nnested_value = 99\n');
	const failures = [
		["a = (", /invalid expression/],
		['do for [i=1:2] {\nprint i', /missing block terminator/],
		['print "unterminated', /unterminated|invalid|expecting/],
		['a = 5\nprint missing_value\na = 6', /undefined variable/],
		[`load ${gnuplotStringLiteral(nested)}`, /nested-error/],
	];
	for (const echoMode of ["off", "summary", "full"]) {
		for (const [code, expected] of failures) {
			const result = await f.send(code, { echoMode, timeoutMs: 3000 });
			assert.match(outputOf(result), expected);
			if (echoMode !== "off") await assertCompletionGap(f, result);
			await assertGnuplotSettled(recordId);
		}
		assert.equal(outputOf(await f.send("print a\nprint nested_value", { echoMode })), "5\n17");
	}
	await f.send("a=8\nexit\na=9");
	assert.equal(outputOf(await f.send("print a")), "8");
	await f.send("reset session");
	assert.equal(outputOf(await f.send('print exists("a")\nprint exists("nested_value")')), "0\n0");
	const variables = outputOf(await f.send("show variables"));
	assert.doesNotMatch(variables, /pi_repl|__pi|sourceFile|guardFile|ending|writable/);
	await f.send('$data << EOD\n1 2\n2 4\nEOD\nplot $data using 1:2');
	await assertVerifiedStop(f);
});

for (const mode of ["timeout", "abort", "interrupt", "pause-input", "stop"]) {
	test(`gnuplot ${mode} retains controls and lease until native completion or verified exit`, gnuplotTestOptions, async (t) => {
		const f = await fixture(t, { runtime: "gnuplot" });
		if (!f) return;
		const recordId = (await f.status()).details.gnuplot.recordId;
		const abort = new AbortController();
		if (["abort", "interrupt", "stop"].includes(mode)) f.onEnter(() => abort.abort());
		const code = mode === "pause-input" ? 'pause -1 "waiting-for-human"\nfinished = 42' : `print "started-native-work"\npause ${["interrupt", "stop"].includes(mode) ? 30 : 2.5}\nfinished = 42`;
		await assert.rejects(f.send(code, { timeoutMs: 1000 }, abort.signal), ["abort", "interrupt", "stop"].includes(mode) ? /aborted/ : /Timed out waiting/);
		f.onEnter(undefined);
		await assert.rejects(acquireReplSessionSendLease(recordId, { waitMs: 0 }), /busy/);
		const controls = readdirSync(process.env.PI_REPL_CONTROL_ROOT);
		assert.equal(controls.filter((file) => file.endsWith(".gp")).length, 2);
		assert.equal(controls.filter((file) => file.endsWith(".cjs")).length, 1);
		assert.equal(controls.some((file) => file.endsWith(".done")), false);
		assertCorrelatedControlFiles(controls, readReplSessionRecord(recordId).entries.at(-1).id);
		for (const file of controls) assert.equal(statSync(join(process.env.PI_REPL_CONTROL_ROOT, file)).mode & 0o777, 0o600);
		if (mode === "stop") await assertVerifiedStop(f);
		if (mode === "interrupt" || mode === "pause-input") {
			await eventually(async () => (await f.tmux("capture-pane", "-p", "-J", "-t", `${f.sessionName}:^`, "-S", "-80")).includes(mode === "interrupt" ? "── output ──\nstarted-native-work" : "── output ──\nwaiting-for-human"));
			await f.tmux("send-keys", "-t", `${f.sessionName}:^`, mode === "interrupt" ? "C-c" : "C-m");
		}
		await assertGnuplotSettled(recordId);
		if (mode !== "stop") {
			assert.equal(outputOf(await f.send('print exists("finished")')), mode === "interrupt" ? "0" : "1");
			await assertVerifiedStop(f);
		}
	});
}

test("gnuplot explicit process exit releases private controls and lease", gnuplotTestOptions, async (t) => {
	const f = await fixture(t, { runtime: "gnuplot" });
	if (!f) return;
	const recordId = (await f.status()).details.gnuplot.recordId;
	try { await f.send("exit gnuplot", { timeoutMs: 5000 }); }
	catch (error) { assert.match(error.message, /REPL session ended/); }
	await eventually(async () => !(await f.status()).details.gnuplot.running);
	await assertGnuplotSettled(recordId);
});

async function qtPlotOrSkip(t, f) {
	const unavailable = /unknown or ambiguous terminal|could not connect to display|Could not.*plugin/i;
	let text;
	try { text = outputOf(await f.send('set term qt\nplot sin(x)', { timeoutMs: 5000 })); }
	catch (error) {
		if (!unavailable.test(error.message)) throw error;
		text = error.message;
	}
	if (unavailable.test(text)) {
		await assertVerifiedStop(f);
		t.skip("Qt offscreen backend is unavailable; no runtime/backend configuration was repaired");
		return false;
	}
	assert.doesNotMatch(text, /error|failed|not initialized/i);
	return true;
}

test("gnuplot Qt graphics child survives sends/errors and exits with verified stop", gnuplotTestOptions, async (t) => {
	const f = await fixture(t, { runtime: "gnuplot" });
	if (!f) return;
	const identity = (p) => `${p.pid}:${p.uid}:${p.startedAt}`;
	// Independent private-cwd rescue discovers Qt even after startDetached
	// reparents it and creates a new process group. It does NOT read markers.
	const before = new Set((await f.owned()).map(identity));
	if (!await qtPlotOrSkip(t, f)) return;
	const graphics = (await f.owned()).filter((p) => !before.has(identity(p)));
	assert.ok(graphics.length > 0, "native graphics must create an owned child, not merely reuse the pre-existing runtime");
	assert.match(outputOf(await f.send("print undefined_with_graphics", { timeoutMs: 3000 })), /undefined variable/);
	assert.match(outputOf(await f.send("print 42\nreplot", { timeoutMs: 3000 })).trim(), /^42(?:\nThis plugin does not support raise\(\))*$/);
	const after = new Set((await f.owned()).map(identity));
	assert.ok(graphics.some((p) => after.has(identity(p))), "the graphics child must survive later sends, unlike a short-lived producer");
	await assertVerifiedStop(f);
	// Before the independent hook can rescue anything, verify PRODUCTION
	// stop reaped these exact detached lifetimes too, not just tmux children.
	const stopped = new Set((await readProcessTable()).filter((p) => !p.state.startsWith("Z")).map(identity));
	assert.ok(graphics.every((p) => !stopped.has(identity(p))), "production stop leaked a detached graphics helper");
	assert.ok(graphics.every((p) => !existsSync(join(root, `qtgnuplot${p.pid}`))), "production stop left an owned Qt socket before test cleanup");
});

test("gnuplot Qt stop preserves another server's marked helper and live state", gnuplotTestOptions, async (t) => {
	const a = await fixture(t, { runtime: "gnuplot" });
	if (!a) return;
	const b = await fixture(t, { runtime: "gnuplot" });
	if (!b) return;
	await b.send("keep = 93");
	if (!await qtPlotOrSkip(t, a) || !await qtPlotOrSkip(t, b)) return;
	const identity = (p) => `${p.pid}:${p.uid}:${p.startedAt}`;
	const protectedIds = (await b.owned()).map(identity);
	assert.notEqual(await a.tmux("show-options", "-qv", "-t", a.sessionName, "@pi_repl_gnuplot_owner"), await b.tmux("show-options", "-qv", "-t", b.sessionName, "@pi_repl_gnuplot_owner"));
	await assertVerifiedStop(a);
	const alive = new Set((await readProcessTable()).filter((p) => !p.state.startsWith("Z")).map(identity));
	assert.ok(protectedIds.every((id) => alive.has(id)), "another server's owned lifetimes must survive");
	assert.match(outputOf(await b.send("print keep\nreplot")).trim(), /^93(?:\nThis plugin does not support raise\(\))*$/);
	await assertVerifiedStop(b);
});

test("gnuplot Qt legacy stop warns and independent teardown rescues the unmarked helper", gnuplotTestOptions, async (t) => {
	const f = await fixture(t, { runtime: "gnuplot" });
	if (!f) return;
	const identity = (p) => `${p.pid}:${p.uid}:${p.startedAt}`;
	const before = new Set((await f.owned()).map(identity));
	if (!await qtPlotOrSkip(t, f)) return;
	const graphics = (await f.owned()).filter((p) => !before.has(identity(p)));
	assert.ok(graphics.length);
	// Remove only this disposable session's authority, simulating an old
	// session. Its inherited environment alone is not permission to adopt it.
	await f.tmux("set-option", "-u", "-t", f.sessionName, "@pi_repl_gnuplot_owner");
	await f.repl("stop gnuplot");
	assert.equal(f.notifications.at(-1).level, "warning");
	assert.match(f.notifications.at(-1).message, /Detached.*cannot be verified/);
	let alive = new Set((await readProcessTable()).filter((p) => !p.state.startsWith("Z")).map(identity));
	assert.ok(graphics.some((p) => alive.has(identity(p))), "unproven detached helper should not be guessed and killed");
	await f.cleanup(); // same independent path registered before launch
	alive = new Set((await readProcessTable()).filter((p) => !p.state.startsWith("Z")).map(identity));
	assert.ok(graphics.every((p) => !alive.has(identity(p))), "independent rescue must not rely on production markers");
});
