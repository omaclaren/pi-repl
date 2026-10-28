import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HelperClient } from "../shared/repl-jupyter-helper.js";
import {
	JUPYTER_OWNER_ENV, JUPYTER_SEND_PATH, LAUNCH_FILE, createSessionDir, findMarkedJupyterProcesses, personCommand, preflightLfortran, readReadyMarker,
	readSessionIdentity, removeSessionDir, sessionDirOwnedBy, startJupyterSession, stopVerifiedJupyterSession, validSessionDir, waitForJupyterReady,
} from "../shared/repl-jupyter-session.js";
import { SessionStopProcesses, readStopProcessTable } from "../shared/repl-session-stop.js";
import { REAL_LFORTRAN, defer, lfortranFixture, sleep, until } from "./helpers/repl-test-lfortran.js";

const uid = process.getuid();
let submissions = 0;

/** The isolated fixture, with the session's start and stop bound to it. */
function sessionFixture(t, options) {
	const f = lfortranFixture(t, options);
	if (!f) return null;
	return {
		...f,
		start: (overrides = {}) => startJupyterSession({ tmux: f.tmux, cwd: f.base, lfortran: f.lfortran, shell: "/bin/sh", root: f.root, timeoutMs: 20_000, ...overrides }),
		stop: (overrides = {}) => stopVerifiedJupyterSession({ tmux: f.tmux, root: f.root, graceMs: 300, ...overrides }),
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

test("a session directory is new, private, short and claimed; only its own launch's files are removed with it", (t) => {
	const root = mkdtempSync("/tmp/pi-rj-dir-");
	defer(t, () => rmSync(root, { recursive: true, force: true }));
	const owner = "a".repeat(32);
	const dir = createSessionDir({ root, uid, owner });
	assert.match(dir, new RegExp(`^${root}/pi-rj-${uid}/[0-9a-f]{8}$`));
	assert.ok(join(dir, "h.sock").length < 104);
	for (const path of [dir, join(root, `pi-rj-${uid}`)]) assert.equal(lstatSync(path).mode & 0o777, 0o700, path);
	assert.equal(readFileSync(join(dir, LAUNCH_FILE), "utf8"), `${owner}\n`);
	assert.notEqual(createSessionDir({ root, uid, owner }), dir);
	assert.equal(validSessionDir(dir, { root, uid }), true);
	assert.equal(validSessionDir(join(root, "elsewhere"), { root, uid }), false);
	assert.equal(validSessionDir(dir, { root, uid: uid + 1 }), false);
	assert.ok(sessionDirOwnedBy(dir, owner, { root, uid }));
	assert.equal(sessionDirOwnedBy(dir, "b".repeat(32), { root, uid }), null);

	for (const name of ["k.json", "ready.json", "kernel.log", "helper.pid", "kernel.pid", `out-${"a".repeat(32)}.txt`, "notes.txt"]) writeFileSync(join(dir, name), "x");
	symlinkSync("/etc/hosts", join(dir, "h.sock"));
	// Another launch's marker, or a directory replaced since it was checked, leaves everything alone.
	assert.match(removeSessionDir(dir, { root, uid, owner: "b".repeat(32) })[0], /isn't this session's/);
	assert.match(removeSessionDir(dir, { root, uid, owner, expected: { dev: -1, ino: -1 } })[0], /isn't this session's/);
	assert.ok(existsSync(join(dir, "k.json")));
	const warnings = removeSessionDir(dir, { root, uid, owner, expected: sessionDirOwnedBy(dir, owner, { root, uid }) });
	// What can't be removed is left where it was, in DIR.
	assert.equal(warnings.length, 2, warnings.join("\n"));
	assert.match(warnings.join("\n"), /notes\.txt: pi-repl didn't make it/);
	assert.match(warnings.join("\n"), /h\.sock: it isn't a file or socket/);
	assert.ok(existsSync(join(dir, "notes.txt")) && lstatSync(join(dir, "h.sock")).isSymbolicLink());
	assert.equal(existsSync(join(dir, "k.json")) || existsSync(join(dir, "kernel.pid")) || existsSync(join(dir, LAUNCH_FILE)), false);

	// A directory that isn't private any more is left alone.
	const open = createSessionDir({ root, uid, owner });
	writeFileSync(join(open, "k.json"), "x");
	chmodSync(open, 0o755);
	assert.match(removeSessionDir(open, { root, uid, owner })[0], /left alone/);
	assert.ok(existsSync(join(open, "k.json")));
	assert.throws(() => createSessionDir({ root, uid }), /owner marker/);

	// DIR replaced after it was checked and before it was taken: the replacement is put back, untouched.
	const first = createSessionDir({ root, uid, owner });
	const checked = sessionDirOwnedBy(first, owner, { root, uid });
	const replace = (path, marker) => {
		renameSync(path, `${path}.moved`);
		mkdirSync(path, { mode: 0o700 });
		writeFileSync(join(path, LAUNCH_FILE), `${marker}\n`);
		writeFileSync(join(path, "k.json"), "theirs");
	};
	const swapped = removeSessionDir(first, { root, uid, owner, expected: checked, hooks: { beforeRename: () => replace(first, "b".repeat(32)) } });
	assert.match(swapped[0], /isn't this session's/);
	assert.equal(readFileSync(join(first, "k.json"), "utf8"), "theirs");
	// DIR's path reused once it was taken: only the taken directory is emptied, and the new one at the path is left alone.
	const second = createSessionDir({ root, uid, owner });
	writeFileSync(join(second, "k.json"), "ours");
	const removed = removeSessionDir(second, { root, uid, owner, expected: sessionDirOwnedBy(second, owner, { root, uid }), hooks: { afterRename: () => {
		mkdirSync(second, { mode: 0o700 });
		writeFileSync(join(second, LAUNCH_FILE), `${"b".repeat(32)}\n`);
		writeFileSync(join(second, "k.json"), "theirs");
	} } });
	assert.deepEqual(removed, []);
	assert.equal(readFileSync(join(second, "k.json"), "utf8"), "theirs");
	assert.deepEqual(readdirSync(join(root, `pi-rj-${uid}`)).filter((name) => name.startsWith(".removing-")), [], "the taken directory is gone");
	// Changed while it was being emptied: the removal stops.
	const third = createSessionDir({ root, uid, owner });
	for (const name of ["k.json", "kernel.log", "ready.json"]) writeFileSync(join(third, name), "x");
	const stopped = removeSessionDir(third, { root, uid, owner, expected: sessionDirOwnedBy(third, owner, { root, uid }), hooks: { afterRename: (taken) => {
		renameSync(taken, `${taken}.elsewhere`);
		mkdirSync(taken, { mode: 0o700 });
		writeFileSync(join(taken, "k.json"), "theirs");
	} } });
	assert.match(stopped.join("\n"), /changed while it was being removed/);
});

/**
 * The verified stop against a fake tmux and process table, so that a test
 * can change things exactly during a marker scan: the person's pane %1, the
 * helper's %2, and the kernel 1003, the helper's child, which the kill leaves
 * running.
 */
function fakeStop({ onMarked, incomplete = false } = {}) {
	const owner = "a".repeat(32);
	const birth = "Wed Oct 28 10:00:00 2026";
	const proc = (pid, extra = {}) => ({ pid, ppid: 900, pgid: pid, uid, tty: "ttys100", startedAt: birth, state: "S", ...extra });
	const session = (name, id, marker) => [name, id, "1800000000", "lfortran", JUPYTER_SEND_PATH, marker, "", "", "%1", "%2"].join("\t");
	const state = {
		owner,
		sessions: [session("pi-repl-lfortran", "$1", owner)],
		panes: [["%1", 1001, "/dev/ttys100", "@1", 0], ["%2", 1002, "/dev/ttys101", "@2", 1]],
		table: [proc(900, { ppid: 1, tty: "??" }), proc(1001), proc(1002, { tty: "ttys101" }), proc(1003, { ppid: 1002, tty: "??" }), proc(9999, { ppid: 1, tty: "??" })],
		calls: [], signals: [], marked: 0, killed: false,
		share() { state.sessions.push(session("elsewhere", "$9", owner)); },
	};
	const tmux = async (args) => {
		state.calls.push(args[0]);
		if (args[0] === "list-sessions") return { code: 0, stdout: state.sessions.join("\n") + "\n", stderr: "" };
		if (args[0] === "list-panes") return { code: 0, stdout: state.panes.map(([paneId, pid, tty, windowId, windowIndex]) => [900, "$1", "pi-repl-lfortran", "1800000000", paneId, pid, tty, "0", windowId, windowIndex, 0, "0", "", ""].join("\t")).join("\n") + "\n", stderr: "" };
		if (args[0] === "if-shell") {
			// The kill ends the panes' processes; the detached kernel goes on.
			state.killed = true;
			state.sessions = state.sessions.filter((row) => !row.startsWith("pi-repl-lfortran\t"));
			state.panes = [];
			state.table = state.table.filter((p) => p.pid !== 1001 && p.pid !== 1002);
			return { code: 0, stdout: "", stderr: "" };
		}
		throw new Error(`unexpected tmux ${args[0]}`);
	};
	const stop = () => stopVerifiedJupyterSession({
		tmux, currentPid: 9999, uid, graceMs: 0, termMs: 0, killMs: 10,
		snapshot: async () => state.table.map((p) => ({ ...p })),
		signal: (pid, value) => { state.signals.push({ pid, value }); state.table = state.table.filter((p) => p.pid !== pid); },
		findMarked: async (table) => {
			onMarked?.(state, ++state.marked);
			return { marked: table.filter((p) => p.pid === 1003), incomplete };
		},
	});
	return { state, stop, tmux };
}

test("stop rechecks births after its marker scans, and the marker's owner before each signal", async () => {
	// A pane's process replaced during the second marker scan, before the kill.
	const reborn = fakeStop({ onMarked: (state, call) => {
		if (call === 2) state.table = state.table.map((p) => (p.pid === 1001 ? { ...p, startedAt: "Wed Oct 28 11:00:00 2026" } : p));
	} });
	await assert.rejects(reborn.stop(), /changed during process inspection; nothing was stopped/);
	assert.equal(reborn.state.calls.includes("if-shell"), false, "nothing was killed");

	// The marker shared during the last scan before a signal: no signal is sent.
	const shared = fakeStop({ onMarked: (state, call) => { if (state.killed && call === 4) state.share(); } });
	await assert.rejects(shared.stop(), /shared with another session/);
	assert.deepEqual(shared.state.signals, []);

	// Untouched, it stops the kernel too.
	const plain = fakeStop();
	const result = await plain.stop();
	assert.deepEqual(plain.state.signals, [{ pid: 1003, value: "SIGTERM" }]);
	assert.equal(result.verified, true);
});

test("a stop whose search was incomplete says it is partial", async () => {
	const f = fakeStop({ incomplete: true });
	const result = await f.stop();
	assert.equal(result.verified, false);
	assert.match(result.warnings.join("\n"), /too many detached processes[\s\S]*may still be running/);
	const { stopLfortranSession } = await import("../shared/repl-lfortran.js");
	const again = fakeStop({ incomplete: true });
	const told = await stopLfortranSession({ tmux: again.tmux, stop: () => again.stop() });
	assert.match(told.text, /^Partly stopped the shared LFortran session[\s\S]*couldn't confirm that the session's helper and kernel ended too/);
	assert.doesNotMatch(told.text, /Its prompt, helper and kernel exited/);
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

	// Through another login shell, the waiter and its arguments arrive unchanged: spaces, quotes and all.
	if (existsSync("/bin/zsh")) {
		const odd = mkdtempSync(join(root, "d it's \"odd\"-"));
		writeFileSync(join(odd, "ready.json"), JSON.stringify({ state: "ready" }));
		const zsh = await new Promise((resolve) => execFile("/bin/sh", ["-c", personCommand({ shell: "/bin/zsh", dir: odd, lfortran: fake })], { env: { ...env, ZDOTDIR: root }, timeout: 10_000 }, (error, stdout) => resolve({ code: error?.code ?? 0, stdout })));
		assert.equal(zsh.code, 0, zsh.stdout);
		assert.ok(zsh.stdout.includes(`lfortran --connect ${odd}/k.json`), zsh.stdout);
	}
});

test("the marked processes are found among DIR's PIDs, detached lfortran processes and orphans since the session began, by their marker alone", async (t) => {
	const root = mkdtempSync("/tmp/pi-rj-mark-");
	defer(t, () => rmSync(root, { recursive: true, force: true }));
	const dir = join(root, "d");
	mkdirSync(dir, { mode: 0o700 });
	writeFileSync(join(dir, "helper.pid"), "101\n");
	// Before ready.json, the kernel is named by kernel.pid alone.
	writeFileSync(join(dir, "kernel.pid"), "102\n");
	const owner = "e".repeat(32);
	const proc = (pid, extra = {}) => ({ pid, ppid: 1, pgid: pid, uid, tty: "??", startedAt: "Wed Oct 28 10:00:00 2026", state: "S", ...extra });
	const since = Date.UTC(2026, 9, 28, 9, 0, 0) / 1000;
	const table = [proc(101, { ppid: 50 }), proc(102, { ppid: 50 }), proc(103, { ppid: 50 }), proc(104, { ppid: 50 }), proc(105, { uid: uid + 1 }),
		// Orphans: one since the session began, one from before it, and one with a terminal.
		proc(106), proc(107, { startedAt: "Wed Oct 28 08:00:00 2026" }), proc(108, { tty: "ttys001" })];
	const list = async () => ({ code: 0, stdout: `  103 ${uid} /opt/bin/lfortran\n  104 ${uid} /usr/bin/python3\n  105 ${uid + 1} /opt/bin/lfortran\n` });
	const inspected = [];
	const markers = new Map([[101, owner], [102, owner], [103, "f".repeat(32)], [106, owner]]);
	const readMarkers = async (pids, { variable }) => {
		assert.equal(variable, JUPYTER_OWNER_ENV);
		inspected.push(...pids);
		return pids.map((pid) => ({ pid, owner: markers.get(pid) ?? null }));
	};
	const found = await findMarkedJupyterProcesses(table, { owner, dir, lfortran: "/somewhere/lfortran", uid, since, list, readMarkers });
	assert.deepEqual(found.marked.map((p) => p.pid).sort(), [101, 102, 106]);
	assert.equal(found.incomplete, false);
	assert.deepEqual(inspected.sort(), [101, 102, 103, 106], "only this user's candidates are inspected");
	// A process that can't be inspected is refused while it lives; one that ended meanwhile isn't a failure.
	const unreadable = async (pids) => pids.map((pid) => ({ pid, error: "unavailable" }));
	await assert.rejects(findMarkedJupyterProcesses(table, { owner, dir, lfortran: null, uid, list, readMarkers: unreadable, snapshot: async () => table }), /PID 101; refusing unverified cleanup/);
	const ended = table.filter((p) => p.pid !== 101 && p.pid !== 102).concat([proc(102, { state: "Z" })]);
	assert.deepEqual((await findMarkedJupyterProcesses(table, { owner, dir, lfortran: null, uid, list, readMarkers: unreadable, snapshot: async () => ended })).marked, []);
	// Too many candidates to inspect: the search says it's incomplete rather than empty.
	const crowd = Array.from({ length: 1100 }, (_, i) => proc(2000 + i));
	const batches = [];
	const crowded = await findMarkedJupyterProcesses(crowd, { owner, dir: null, lfortran: null, uid, since, list, readMarkers: async (pids) => { batches.push(pids.length); return pids.map((pid) => ({ pid, owner: null })); } });
	assert.equal(crowded.incomplete, true);
	assert.ok(batches.every((size) => size <= 128));
});

test("a marked process brings its descendants, which stay known once they're reparented", () => {
	const proc = (pid, extra = {}) => ({ pid, ppid: 1, pgid: pid, uid, tty: "??", startedAt: "Wed Oct 28 10:00:00 2026", state: "S", ...extra });
	const pane = { serverPid: 900, sessionId: "$1", sessionName: "pi-repl-lfortran", createdAt: "1", paneId: "%1", pid: 1001, tty: "/dev/ttys100", dead: "1", windowId: "@1", windowIndex: 0, paneIndex: 0, linked: "0" };
	const table = [proc(900, { tty: "??" }), proc(500), proc(501, { ppid: 500 }), proc(502, { ppid: 501 })];
	const tracker = new SessionStopProcesses({ table, panes: [pane], selected: [pane], currentPid: 9999, uid, retained: new Set(["%1"]), label: "LFortran" });
	tracker.rememberMarked([table[1]], table, []);
	// The kernel ends; its child and grandchild are adopted by PID 1.
	const later = [proc(900, { tty: "??" }), proc(501), proc(502, { ppid: 501 })];
	assert.deepEqual(tracker.refresh(later, []).map((p) => p.pid).sort(), [501, 502]);
});

test("readiness needs the helper and kernel ready now, and the person's pane live with its prompt", async (t) => {
	const root = mkdtempSync("/tmp/pi-rj-ready-");
	defer(t, () => rmSync(root, { recursive: true, force: true }));
	const owner = "c".repeat(32);
	writeFileSync(join(root, "ready.json"), JSON.stringify({ protocol: 1, launchId: owner, state: "ready" }));
	const identity = { sessionId: "$1", dir: root, owner, personPane: "%1" };
	const helperIn = (state) => async () => ({ request: async () => ({ protocol: 1, launchId: owner, state }), close() {} });
	const tmuxWith = (dead) => async (args) => args[0] === "list-panes" ? { code: 0, stdout: `%1\t${dead}\n`, stderr: "" } : { code: 0, stdout: "banner\n>>> \n", stderr: "" };
	const deadline = () => Date.now() + 400;
	const exited = await waitForJupyterReady({ tmux: tmuxWith("0"), identity, deadline: deadline(), connect: helperIn("kernel-exited"), pollMs: 20 });
	assert.deepEqual([exited.ready, exited.failure], [false, "the kernel has already exited"]);
	const ended = await waitForJupyterReady({ tmux: tmuxWith("1"), identity, deadline: deadline(), connect: helperIn("ready"), pollMs: 20 });
	assert.deepEqual([ended.ready, ended.prompt, ended.promptEnded], [false, false, true], "a dead pane's last text isn't a prompt");
	const ready = await waitForJupyterReady({ tmux: tmuxWith("0"), identity, deadline: deadline(), connect: helperIn("ready"), pollMs: 20 });
	assert.equal(ready.ready, true);
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

test("stop refuses added, moved or missing panes and a shared marker, keeps a directory that isn't its launch's, and leaves another session alone", async (t) => {
	const f = sessionFixture(t);
	if (!f) return;
	const started = await f.start();
	assert.ok(started.ready);
	const split = await f.tmux(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", started.personPane, "sleep 60"]);
	await assert.rejects(f.stop(), /panes aren't the ones pi-repl made[\s\S]*Nothing was stopped/);
	assert.equal((await runCell(started, "print:untouched")).output.text, "untouched");
	await f.tmux(["kill-pane", "-t", split.stdout.trim()]);

	// A marker that another session also carries is ambiguous.
	const other = (await f.tmux(["new-session", "-d", "-P", "-F", "#{session_id}", "-s", "elsewhere", "sleep 60"])).stdout.trim();
	await f.tmux(["set-option", "-t", other, "@pi_repl_jupyter_owner", started.owner]);
	await assert.rejects(f.stop(), /shared with another session/);
	await f.tmux(["set-option", "-u", "-t", other, "@pi_repl_jupyter_owner"]);
	assert.equal((await runCell(started, "print:still untouched")).output.text, "still untouched");

	// A directory that no longer names this launch is neither read nor removed; the session still stops.
	writeFileSync(join(started.dir, LAUNCH_FILE), `${"d".repeat(32)}\n`);
	const result = await f.stop();
	assert.match(result.warnings.join("\n"), /doesn't name this session's launch/);
	assert.ok(existsSync(join(started.dir, "kernel.log")));

	// A pinned pane moved to another session leaves the topology incomplete.
	const moved = await f.start();
	assert.ok(moved.ready);
	await f.tmux(["move-pane", "-d", "-s", moved.helperPane, "-t", `${other}:`]);
	await assert.rejects(f.stop(), /some are missing, moved or added[\s\S]*Nothing was stopped/);
	await f.tmux(["kill-session", "-t", other]);
	await f.tmux(["kill-session", "-t", moved.sessionId]);

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
