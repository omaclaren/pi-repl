import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HelperClient } from "../shared/repl-jupyter-helper.js";
import {
	JUPYTER_OWNER_ENV, JUPYTER_SEND_PATH, createSessionDir, findMarkedJupyterProcesses, personCommand, preflightLfortran, readReadyMarker,
	readSessionIdentity, removeSessionDir, startJupyterSession, stopVerifiedJupyterSession, validSessionDir,
} from "../shared/repl-jupyter-session.js";
import { readStopProcessTable } from "../shared/repl-session-stop.js";
import { createTestTmux } from "./helpers/repl-test-tmux.js";

const FAKE_LFORTRAN = fileURLToPath(new URL("./helpers/fake-lfortran.js", import.meta.url));
const REAL_LFORTRAN = process.env.PI_REPL_LFORTRAN;
const available = process.platform !== "win32" && spawnSync("tmux", ["-V"]).status === 0;
const uid = process.getuid();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (text) => `'${text.replace(/'/g, `'"'"'`)}'`;
let submissions = 0;

async function until(condition, { timeoutMs = 10_000, what = "the condition" } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
		await sleep(50);
	}
}

/** Cleanups run last first, each even if another failed (node:test's own hooks run first first, and stop at a failure). */
function defer(t, cleanup) {
	if (!t.cleanups) {
		const cleanups = (t.cleanups = []);
		t.after(async () => {
			let failure;
			for (const run of cleanups.reverse()) {
				try {
					await run();
				} catch (error) {
					failure ??= error instanceof AggregateError ? new Error(`${error.message}: ${error.errors.map((e) => e.message).join("; ")}`, { cause: error }) : error;
				}
			}
			if (failure) throw failure;
		});
	}
	t.cleanups.push(cleanup);
}

/**
 * An isolated tmux server, home and PATH, with `lfortran` on it: the fake, or
 * PI_REPL_LFORTRAN. Every lfortran process records itself in the harness's
 * ledger first, so that one left without its parent is still cleaned up.
 */
function sessionFixture(t, { env: extra = {}, index = 0, real = false } = {}) {
	if (!available) { t.skip("tmux is required"); return null; }
	// Short, for the sockets under it.
	const base = mkdtempSync("/tmp/pi-rj-st-");
	defer(t, () => rmSync(base, { recursive: true, force: true }));
	const [home, bin, root] = ["home", "bin", "root"].map((name) => join(base, name));
	for (const dir of [home, bin, root]) mkdirSync(dir);
	writeFileSync(join(home, ".profile"), `export PATH=${quote(`${bin}:${process.env.PATH}`)}\n`);
	const config = join(base, "tmux.conf");
	writeFileSync(config, `set -g base-index ${index}\nset -g pane-base-index ${index}\nset -g default-shell /bin/sh\n`);
	const env = { ...process.env, HOME: home, SHELL: "/bin/sh", PATH: `${bin}:${process.env.PATH}`, ...extra };
	delete env.TMUX;
	delete env.TMUX_PANE;
	const harness = createTestTmux(t, { cwd: base, env, config });
	// Before the directory holding its config goes; its own hook then finds this done.
	defer(t, () => harness.cleanup());
	const target = real ? quote(REAL_LFORTRAN) : `${quote(process.execPath)} ${quote(FAKE_LFORTRAN)}`;
	writeFileSync(join(bin, "lfortran"), `#!/bin/sh\n${harness.launcherPrologue}exec ${target} "$@"\n`, { mode: 0o700 });
	const tmux = async (args) => {
		try {
			const result = await harness.run(args);
			return { code: 0, stdout: result.stdout, stderr: result.stderr };
		} catch (error) {
			return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
		}
	};
	const run = (file, args, { timeoutMs = 15_000 } = {}) => new Promise((resolve) => execFile(file, args, { env, cwd: base, timeout: timeoutMs }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr })));
	const lfortran = join(bin, "lfortran");
	return {
		base, root, tmux, harness, lfortran, run,
		start: (options = {}) => startJupyterSession({ tmux, cwd: base, lfortran, shell: "/bin/sh", root, timeoutMs: 20_000, ...options }),
		stop: (options = {}) => stopVerifiedJupyterSession({ tmux, root, graceMs: 300, ...options }),
		windows: async () => (await tmux(["list-windows", "-t", "=pi-repl-lfortran", "-F", "#{window_index}\t#{window_active}\t#{pane_id}\t#{remain-on-exit}\t#{pane_dead}"])).stdout.trim().split("\n").map((line) => line.split("\t")),
		pane: async (paneId) => (await tmux(["capture-pane", "-p", "-t", paneId])).stdout,
	};
}

/** Runs a cell through the session's helper. */
async function runCell(session, code) {
	const client = await HelperClient.connect(join(session.dir, "h.sock"));
	try {
		let snapshot = await client.request("execute", { lifetimeId: session.hello.lifetimeId, submissionId: `session-test-${process.pid}-${++submissions}`, code });
		while (!["completed", "unconfirmed", "not-sent"].includes(snapshot.state)) {
			snapshot = await client.request("wait", { executionId: snapshot.executionId, since: snapshot.version, timeoutMs: 10_000 });
		}
		return snapshot;
	} finally {
		client.close();
	}
}

const alive = async (pids) => {
	const table = await readStopProcessTable();
	return pids.filter((pid) => table.some((p) => p.pid === pid && !p.state.startsWith("Z")));
};

test("preflight finds lfortran through the login shell, and requires its shared session", async () => {
	const answers = new Map([
		["/bin/sh -i -l -c command -v lfortran", { code: 0, stdout: "some startup noise\n/usr/bin/true\n" }],
		["/usr/bin/true --help", { code: 0, stdout: "  --connect TEXT  Run the prompt in the kernel\n" }],
		["/usr/bin/true kernel --help", { code: 0, stdout: "  --managed  Stop when the last client disconnects\n" }],
		["/usr/bin/true --version", { code: 0, stdout: "LFortran version: 0.67.0\nPlatform: macOS\n" }],
	]);
	const run = async (file, args) => ({ stderr: "", ...(answers.get([file, ...args].join(" ")) ?? { code: 1, stdout: "" }) });
	const realTrue = (await import("node:fs")).realpathSync("/usr/bin/true");
	if (realTrue === "/usr/bin/true") {
		assert.deepEqual(await preflightLfortran({ shell: "/bin/sh", run }), { path: "/usr/bin/true", version: "LFortran version: 0.67.0" });
	}
	answers.set("/usr/bin/true --help", { code: 0, stdout: "no shared session here\n" });
	await assert.rejects(preflightLfortran({ shell: "/bin/sh", run }), /needs LFortran main after #16032/);
	answers.set("/bin/sh -i -l -c command -v lfortran", { code: 1, stdout: "" });
	await assert.rejects(preflightLfortran({ shell: "/bin/sh", run }), /wasn't found by your login shell/);
	answers.set("/bin/sh -i -l -c command -v lfortran", { code: 0, stdout: "alias lfortran=something\n" });
	await assert.rejects(preflightLfortran({ shell: "/bin/sh", run }), /wasn't found/);
});

test("a session directory is new, private and short; only its own files are removed with it", (t) => {
	const root = mkdtempSync("/tmp/pi-rj-dir-");
	defer(t, () => rmSync(root, { recursive: true, force: true }));
	const dir = createSessionDir({ root, uid });
	assert.match(dir, new RegExp(`^${root}/pi-rj-${uid}/[0-9a-f]{8}$`));
	assert.ok(join(dir, "h.sock").length < 104);
	for (const path of [dir, join(root, `pi-rj-${uid}`)]) assert.equal(lstatSync(path).mode & 0o777, 0o700, path);
	assert.notEqual(createSessionDir({ root, uid }), dir);
	assert.equal(validSessionDir(dir, { root, uid }), true);
	assert.equal(validSessionDir(join(root, "elsewhere"), { root, uid }), false);
	assert.equal(validSessionDir(dir, { root, uid: uid + 1 }), false);

	for (const name of ["k.json", "ready.json", "kernel.log", "helper.pid", `out-${"a".repeat(32)}.txt`, "notes.txt"]) writeFileSync(join(dir, name), "x");
	symlinkSync("/etc/hosts", join(dir, "h.sock"));
	const warnings = removeSessionDir(dir, { root, uid });
	assert.equal(warnings.length, 3, warnings.join("\n"));
	assert.match(warnings.join("\n"), /notes\.txt: pi-repl didn't make it/);
	assert.match(warnings.join("\n"), /h\.sock: it isn't a file or socket/);
	assert.ok(existsSync(join(dir, "notes.txt")) && lstatSync(join(dir, "h.sock")).isSymbolicLink());
	assert.equal(existsSync(join(dir, "k.json")), false);

	// A directory that isn't private any more is left alone.
	const open = createSessionDir({ root, uid });
	writeFileSync(join(open, "k.json"), "x");
	chmodSync(open, 0o755);
	assert.match(removeSessionDir(open, { root, uid })[0], /left alone/);
	assert.ok(existsSync(join(open, "k.json")));
});

test("the person's window waits for the helper, then becomes LFortran's prompt, or says why not", async (t) => {
	const root = mkdtempSync("/tmp/pi-rj-wait-");
	defer(t, () => rmSync(root, { recursive: true, force: true }));
	const fake = join(root, "lfortran");
	writeFileSync(fake, '#!/bin/sh\necho "lfortran $*"\n', { mode: 0o700 });
	const env = { ...process.env, HOME: root };
	const wait = (dir, timeout = 10_000) => new Promise((resolve) => execFile("/bin/sh", ["-c", personCommand({ shell: "/bin/sh", dir, lfortran: fake })], { env, timeout }, (error, stdout) => resolve({ code: error?.code ?? 0, stdout })));
	const ready = (dir, fields) => writeFileSync(join(dir, "ready.json"), JSON.stringify({ protocol: 1, launchId: "x", ...fields }) + "\n");

	// It waits while the helper lives, however long, and then joins.
	const joined = mkdtempSync(join(root, "a-"));
	writeFileSync(join(joined, "helper.pid"), `${process.pid}\n`);
	const joining = wait(joined);
	await sleep(700);
	ready(joined, { state: "ready" });
	const { code, stdout } = await joining;
	assert.equal(code, 0);
	assert.match(stdout, new RegExp(`lfortran --connect ${joined}/k.json`));

	const failed = mkdtempSync(join(root, "b-"));
	ready(failed, { state: "failed", reason: "The kernel exited before it was ready (status 5)." });
	const refusal = await wait(failed);
	assert.equal(refusal.code, 1);
	assert.match(refusal.stdout, /couldn't start it[\s\S]*status 5/);

	const gone = mkdtempSync(join(root, "c-"));
	writeFileSync(join(gone, "helper.pid"), "999999\n");
	const ended = await wait(gone);
	assert.equal(ended.code, 1);
	assert.match(ended.stdout, /helper ended before the session was ready/);
});

test("the marked processes are found among DIR's PIDs and detached lfortran processes, by their marker alone", async (t) => {
	const root = mkdtempSync("/tmp/pi-rj-mark-");
	defer(t, () => rmSync(root, { recursive: true, force: true }));
	const dir = join(root, "d");
	mkdirSync(dir, { mode: 0o700 });
	writeFileSync(join(dir, "helper.pid"), "101\n");
	writeFileSync(join(dir, "ready.json"), JSON.stringify({ helperPid: 101, kernelPid: 102 }));
	const owner = "e".repeat(32);
	const proc = (pid, extra = {}) => ({ pid, ppid: 1, pgid: pid, uid, tty: "??", startedAt: "Wed Oct 28 10:00:00 2026", state: "S", ...extra });
	const table = [proc(101), proc(102), proc(103), proc(104), proc(105, { uid: uid + 1 })];
	const list = async () => ({ code: 0, stdout: `  103 ${uid} /opt/bin/lfortran\n  104 ${uid} /usr/bin/python3\n  105 ${uid + 1} /opt/bin/lfortran\n` });
	const inspected = [];
	const markers = new Map([[101, owner], [102, owner], [103, "f".repeat(32)]]);
	const readMarkers = async (pids, { variable }) => {
		assert.equal(variable, JUPYTER_OWNER_ENV);
		inspected.push(...pids);
		return pids.map((pid) => ({ pid, owner: markers.get(pid) ?? null }));
	};
	const found = await findMarkedJupyterProcesses(table, { owner, dir, lfortran: "/somewhere/lfortran", uid, list, readMarkers });
	assert.deepEqual(found.map((p) => p.pid).sort(), [101, 102]);
	assert.deepEqual(inspected.sort(), [101, 102, 103], "only this user's candidates are inspected");
	// A process that can't be inspected is refused while it lives; one that ended meanwhile isn't a failure.
	const unreadable = async (pids) => pids.map((pid) => ({ pid, error: "unavailable" }));
	await assert.rejects(findMarkedJupyterProcesses(table, { owner, dir, lfortran: null, uid, list, readMarkers: unreadable, snapshot: async () => table }), /PID 101; refusing unverified cleanup/);
	const ended = table.filter((p) => p.pid !== 101 && p.pid !== 102).concat([proc(102, { state: "Z" })]);
	assert.deepEqual(await findMarkedJupyterProcesses(table, { owner, dir, lfortran: null, uid, list, readMarkers: unreadable, snapshot: async () => ended }), []);
});

test("start makes the person's window and the helper's, pins them, reports ready, and reuses the session", async (t) => {
	const f = sessionFixture(t, { index: 1 });
	if (!f) return;
	const preflight = await preflightLfortran({ shell: "/bin/sh", cwd: f.base, run: f.run });
	assert.equal(preflight.path, (await import("node:fs")).realpathSync(f.lfortran));
	const started = await f.start({ lfortran: preflight.path });
	defer(t, () => f.stop().catch(() => {}));
	assert.deepEqual([started.created, started.ready, started.prompt, started.failure], [true, true, true, null], JSON.stringify(started));
	assert.equal(started.hello.launchId, started.owner);
	const identity = await readSessionIdentity(f.tmux, "pi-repl-lfortran");
	assert.deepEqual([identity.runtime, identity.sendPath, identity.personPane, identity.helperPane], ["lfortran", JUPYTER_SEND_PATH, started.personPane, started.helperPane]);
	assert.match(identity.owner, /^[0-9a-f]{32}$/);
	assert.equal(validSessionDir(identity.dir, { root: f.root, uid }), true);
	// The person's window is the lowest-indexed and the selected one; both keep their panes.
	assert.deepEqual(await f.windows(), [["1", "1", started.personPane, "on", "0"], ["2", "0", started.helperPane, "on", "0"]]);
	assert.equal(readReadyMarker(started.dir).launchId, started.owner);

	// Cells from the agent, through the helper, and from the person, at the prompt.
	assert.equal((await runCell(started, "print:from the agent")).output.text, "from the agent");
	await f.tmux(["send-keys", "-t", started.personPane, "print:from the person", "Enter"]);
	await until(async () => /from the person\n>>>/.test(await f.pane(started.personPane)), { what: "the person's cell" });

	const again = await f.start({ lfortran: preflight.path });
	assert.deepEqual([again.created, again.ready, again.sessionId, again.owner], [false, true, started.sessionId, started.owner]);
	assert.equal((await f.windows()).length, 2, "a reuse adds no windows");
});

test("concurrent starts make one session, and both see it ready", async (t) => {
	const f = sessionFixture(t);
	if (!f) return;
	const results = await Promise.all([f.start(), f.start()]);
	defer(t, () => f.stop().catch(() => {}));
	assert.deepEqual(results.map((r) => r.created).sort(), [false, true]);
	assert.ok(results.every((r) => r.ready && r.owner === results[0].owner), JSON.stringify(results.map((r) => [r.ready, r.failure])));
	assert.equal((await f.windows()).length, 2);
	assert.equal(existsSync(join(f.root, `pi-rj-${uid}`)) && (await import("node:fs")).readdirSync(join(f.root, `pi-rj-${uid}`)).length, 1, "the loser's directory is removed");
});

test("stop ends the prompt, the helper and the kernel, even one left without its parent, and removes DIR", async (t) => {
	const f = sessionFixture(t);
	if (!f) return;
	const started = await f.start();
	assert.ok(started.ready);
	const { helperPid, kernelPid } = readReadyMarker(started.dir);
	assert.deepEqual(await alive([helperPid, kernelPid]), [helperPid, kernelPid]);
	const result = await f.stop();
	assert.equal(result.processCount >= 3, true, JSON.stringify(result));
	// The fake kernel isn't managed: once its helper has gone, it needs a signal.
	assert.ok(result.signals.some((s) => s.pid === kernelPid), JSON.stringify(result.signals));
	assert.deepEqual(await alive([helperPid, kernelPid]), []);
	assert.equal(await readSessionIdentity(f.tmux, "pi-repl-lfortran"), null);
	assert.equal(existsSync(started.dir), false);
	assert.deepEqual(result.warnings, []);
});

test("the person's prompt ending keeps its pane and the session; the session still stops", async (t) => {
	const f = sessionFixture(t);
	if (!f) return;
	const started = await f.start();
	assert.ok(started.ready);
	await f.tmux(["send-keys", "-t", started.personPane, "C-d"]);
	await until(async () => (await f.windows())[0][4] === "1", { what: "the person's pane to end" });
	// The kernel and the helper go on, and the agent can still send.
	assert.equal((await runCell(started, "print:still here")).output.text, "still here");
	const result = await f.stop();
	assert.equal(existsSync(started.dir), false);
	assert.deepEqual(result.warnings, []);
});

test("a helper that can't start the kernel: start says why, the person's window too, and the session still stops", async (t) => {
	const f = sessionFixture(t, { env: { FAKE_KERNEL_EXIT: "5" } });
	if (!f) return;
	const started = await f.start();
	assert.equal(started.ready, false);
	assert.match(started.failure, /status 5/);
	await until(async () => /couldn't start it[\s\S]*status 5/.test(await f.pane(started.personPane)), { what: "the person's window to say why" });
	await f.stop();
	assert.equal(await readSessionIdentity(f.tmux, "pi-repl-lfortran"), null);
	assert.equal(existsSync(started.dir), false);
});

test("stop refuses a session with a pane pi-repl didn't make, and one with no owner marker", async (t) => {
	const f = sessionFixture(t);
	if (!f) return;
	const started = await f.start();
	assert.ok(started.ready);
	const split = await f.tmux(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", started.personPane, "sleep 60"]);
	await assert.rejects(f.stop(), /panes that pi-repl didn't make; nothing was stopped/);
	assert.equal((await runCell(started, "print:untouched")).output.text, "untouched");
	await f.tmux(["kill-pane", "-t", split.stdout.trim()]);
	await f.stop();

	// A session of that name that pi-repl didn't start.
	await f.tmux(["new-session", "-d", "-s", "pi-repl-lfortran", "sleep 60"]);
	await assert.rejects(f.start({ timeoutMs: 500 }), /isn't a complete pi-repl LFortran session/);
	await assert.rejects(f.stop(), /no valid LFortran ownership marker/);
	assert.ok(await readSessionIdentity(f.tmux, "pi-repl-lfortran"), "it was left alone");
});

test("with LFortran: start, a cell from each side, and stop", { skip: !REAL_LFORTRAN && "set PI_REPL_LFORTRAN" }, async (t) => {
	const f = sessionFixture(t, { real: true });
	if (!f) return;
	const preflight = await preflightLfortran({ shell: "/bin/sh", cwd: f.base, run: f.run });
	const started = await f.start({ lfortran: preflight.path, timeoutMs: 60_000 });
	defer(t, () => f.stop().catch(() => {}));
	assert.ok(started.ready, JSON.stringify([started.failure, started.prompt, await f.pane(started.personPane)]));
	assert.match((await runCell(started, "integer :: k = 6\nprint *, k * 7")).output.text, /^\s*42\s*$/);
	await f.tmux(["send-keys", "-t", started.personPane, "print *, k + 1", "Enter"]);
	await until(async () => /\b7\b[\s\S]*>>>/.test((await f.pane(started.personPane)).split("print *, k + 1").at(-1) ?? ""), { timeoutMs: 30_000, what: "the person's cell" });
	const { helperPid, kernelPid } = readReadyMarker(started.dir);
	await f.stop();
	assert.deepEqual(await alive([helperPid, kernelPid]), []);
	assert.equal(existsSync(started.dir), false);
});
