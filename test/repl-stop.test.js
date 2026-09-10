import test from "node:test";
import assert from "node:assert/strict";
import { parseStopProcessTable, stopVerifiedReplSession } from "../shared/repl-session-stop.js";

const birth = "Wed Sep 9 08:00:00 2026";
const later = "Wed Sep 9 08:01:00 2026";
const proc = (pid, extra = {}) => ({ pid, ppid: 900, pgid: pid, uid: 501, tty: "ttys100", startedAt: birth, state: "S", ...extra });
const pane = (extra = {}) => ({ serverPid: 900, sessionId: "$1", sessionName: "pi-repl-python", createdAt: "123", paneId: "%1", pid: 1001, tty: "/dev/ttys100", dead: "0", windowId: "@1", windowIndex: 1, paneIndex: 1, linked: "0", recordId: "a".repeat(32), ...extra });
const paneRow = (p) => [p.serverPid, p.sessionId, p.sessionName, p.createdAt, p.paneId, p.pid, p.tty, p.dead, p.windowId, p.windowIndex, p.paneIndex, p.linked, p.gnuplotOwner ?? "", p.recordId].join("\t");

function fixture(options = {}) {
	const protectedPane = pane({ sessionId: "$2", sessionName: "unrelated", paneId: "%2", pid: 2001, tty: "/dev/ttys200", windowId: "@2" });
	const sessionName = options.gnuplot ? "pi-repl-gnuplot" : "pi-repl-python";
	const owner = "c".repeat(32);
	const state = {
		markers: new Map(),
		panes: [pane({ sessionName, ...(options.gnuplot ? { gnuplotOwner: owner } : {}) }), protectedPane],
		table: [proc(900, { ppid: 1, tty: "??" }), proc(1001), proc(1002, { ppid: 1001, pgid: 1001 }), proc(2001, { tty: "ttys200" }), proc(9999, { ppid: 1, tty: "??" })],
		calls: [], signals: [], snapshots: 0, stopped: false, ...options,
	};
	async function tmux(args) {
		state.calls.push(args);
		if (args[0] === "list-panes") {
			if (state.stopped && state.inspectFailure) return { code: 1, stdout: "", stderr: "permission denied" };
			return { code: 0, stdout: state.panes.map(paneRow).join("\n") + "\n", stderr: "" };
		}
		assert.equal(args[0], "if-shell");
		assert.ok(args.includes("-F"));
		assert.equal(args.at(-2), "kill-session -t '$1'");
		assert.match(args[4], /#\{pid\}|#\{session_id\}/);
		if (state.guardChanged) return { code: 0, stdout: "PI_REPL_STOP_CHANGED", stderr: "" };
		if (state.killFailure) return { code: 1, stdout: "", stderr: "test kill failure" };
		state.stopped = true;
		if (!state.keepSession) state.panes = state.panes.filter((p) => p.sessionId !== "$1");
		state.afterStop?.();
		return { code: 0, stdout: "", stderr: "" };
	}
	return {
		state,
		stop: () => stopVerifiedReplSession({
			tmux, sessionName, currentPid: 9999, uid: 501, graceMs: 0, termMs: 0, killMs: 10,
			snapshotSockets: async () => [],
			findMarked: async (table, marker) => {
				state.onMarked?.(++state.markerReads || (state.markerReads = 1));
				if (state.markerFailure) throw new Error("ownership inspection failed");
				return table.filter((p) => state.markers.get(p.pid) === marker);
			},
			snapshot: async () => { state.onSnapshot?.(++state.snapshots); return state.table.map((p) => ({ ...p })); },
			signal: (pid, signal) => {
				state.signals.push({ pid, signal });
				if (state.signalFailure) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
				state.onSignal?.(pid, signal);
				if (signal === "SIGKILL") state.table = state.table.filter((p) => p.pid !== pid);
			},
		}),
	};
}

test("shutdown process parsing is locale-normalised and rejects malformed ownership data", () => {
	assert.deepEqual(parseStopProcessTable(" 1001 900 1001 501 ttys100 Wed Sep  9 08:00:00 2026 S\n"), [proc(1001)]);
	assert.throws(() => parseStopProcessTable("not ownership data"), /refusing unsafe shutdown/);
});

test("cooperative shutdown verifies exit without follow-up signals", async () => {
	const f = fixture();
	f.state.afterStop = () => { f.state.table = f.state.table.filter((p) => ![1001, 1002].includes(p.pid)); };
	const result = await f.stop();
	assert.equal(result.processCount, 2);
	assert.deepEqual(result.signals, []);
	assert.equal(f.state.panes[0].sessionName, "unrelated");
});

test("only confirmed runtime survivors and children receive TERM/KILL, never server or other session", async () => {
	const f = fixture();
	const result = await f.stop();
	assert.deepEqual(result.signals, [
		{ pid: 1001, signal: "SIGTERM" }, { pid: 1002, signal: "SIGTERM" },
		{ pid: 1001, signal: "SIGKILL" }, { pid: 1002, signal: "SIGKILL" },
	]);
	assert.deepEqual(f.state.table.map((p) => p.pid), [900, 2001, 9999]);
});

test("late children of a still-confirmed runtime are discovered during shutdown", async () => {
	const f = fixture();
	f.state.onSignal = (pid, signal) => { if (pid === 1001 && signal === "SIGTERM") f.state.table.push(proc(1003, { ppid: 1001, pgid: 1001 })); };
	const result = await f.stop();
	assert.equal(result.processCount, 3);
	assert.ok(result.signals.some((s) => s.pid === 1003 && s.signal === "SIGKILL"));
});

test("recycled process identities after tmux closes are left alone", async () => {
	const f = fixture();
	f.state.afterStop = () => { f.state.table = f.state.table.map((p) => [1001, 1002].includes(p.pid) ? { ...p, startedAt: later } : p); };
	await f.stop();
	assert.deepEqual(f.state.signals, []);
});

test("PID birth identity is rechecked after TERM before escalation", async () => {
	const f = fixture();
	f.state.onSignal = (pid, signal) => { if (signal === "SIGTERM") f.state.table = f.state.table.map((p) => p.pid === pid ? { ...p, startedAt: later } : p); };
	await f.stop();
	assert.ok(f.state.signals.every((s) => s.signal === "SIGTERM"));
});

for (const mode of ["foreign uid", "tty mismatch", "dead pane", "linked window", "caller inside REPL", "server identity changed", "root identity changed"]) {
	test(`${mode} refuses shutdown before any destructive action`, async () => {
		const f = fixture();
		if (mode === "foreign uid") f.state.table.find((p) => p.pid === 1001).uid = 502;
		if (mode === "tty mismatch") f.state.table.find((p) => p.pid === 1001).tty = "ttys999";
		if (mode === "dead pane") f.state.panes[0].dead = "1";
		if (mode === "linked window") f.state.panes[0].linked = "1";
		if (mode === "caller inside REPL") f.state.table.find((p) => p.pid === 9999).ppid = 1001;
		if (mode.endsWith("identity changed")) f.state.onSnapshot = (count) => { if (count === 2) f.state.table.find((p) => p.pid === (mode.startsWith("server") ? 900 : 1001)).startedAt = later; };
		await assert.rejects(f.stop(), /nothing was stopped/);
		assert.equal(f.state.calls.some((args) => args[0] === "if-shell"), false);
		assert.deepEqual(f.state.signals, []);
	});
}

for (const mode of ["guardChanged", "killFailure", "keepSession", "inspectFailure", "signalFailure"]) {
	test(`${mode} reports incomplete shutdown, not success`, async () => {
		const f = fixture({ [mode]: true });
		await assert.rejects(f.stop(), /could not complete|still exists|could not be fully verified/);
		if (mode !== "signalFailure") assert.deepEqual(f.state.signals, []);
	});
}

test("an owned process moved into another live pane is protected and reported, not killed", async () => {
	const f = fixture();
	f.state.afterStop = () => { f.state.panes.push(pane({ sessionId: "$3", sessionName: "moved" })); };
	await assert.rejects(f.stop(), /overlaps a protected process/);
	assert.deepEqual(f.state.signals, []);
});

test("same-name replacement session after stop is not targeted by escalation", async () => {
	const f = fixture();
	f.state.afterStop = () => {
		f.state.panes.push(pane({ sessionId: "$3", createdAt: "124", paneId: "%3", pid: 3001, windowId: "@3", tty: "/dev/ttys300" }));
		f.state.table.push(proc(3001, { tty: "ttys300", startedAt: later }));
	};
	await f.stop();
	assert.ok(f.state.table.some((p) => p.pid === 3001));
	assert.ok(!f.state.signals.some((s) => s.pid === 3001));
});

test("unknown orphan group members without identity continuity produce a warning, not a broad kill", async () => {
	const f = fixture();
	f.state.afterStop = () => {
		f.state.table = f.state.table.filter((p) => ![1001, 1002].includes(p.pid));
		f.state.table.push(proc(1003, { ppid: 1, pgid: 1001 }));
	};
	await assert.rejects(f.stop(), /Unconfirmed survivors/);
	assert.deepEqual(f.state.signals, []);
});

const qtOwner = "c".repeat(32);
function addQt(f, pid, marker = qtOwner) {
	f.state.table.push(proc(pid, { ppid: 1, pgid: pid - 1, tty: "??" }));
	f.state.markers.set(pid, marker);
}

test("gnuplot explicit stop tracks marked detached helpers and preserves unmarked/foreign helpers", async () => {
	const f = fixture({ gnuplot: true });
	addQt(f, 3001);
	addQt(f, 4001, "d".repeat(32));
	addQt(f, 5001, null);
	const result = await f.stop();
	assert.equal(result.processCount, 3);
	assert.deepEqual(result.warnings, []);
	assert.ok(result.signals.some((s) => s.pid === 3001 && s.signal === "SIGKILL"));
	assert.ok(!result.signals.some((s) => [4001, 5001].includes(s.pid)));
	assert.ok(f.state.calls.find((args) => args[0] === "if-shell")[4].includes("@pi_repl_gnuplot_owner"));
});

test("gnuplot discovers a late marked helper after tmux exits, without requiring ancestry", async () => {
	const f = fixture({ gnuplot: true });
	f.state.afterStop = () => addQt(f, 3001);
	const result = await f.stop();
	assert.ok(result.signals.some((s) => s.pid === 3001));
});

test("gnuplot helper PID reuse with a different marker is not adopted or signalled", async () => {
	const f = fixture({ gnuplot: true });
	addQt(f, 3001);
	f.state.afterStop = () => {
		f.state.table.find((p) => p.pid === 3001).startedAt = later;
		f.state.markers.set(3001, "d".repeat(32));
	};
	await f.stop();
	assert.ok(!f.state.signals.some((s) => s.pid === 3001));
});

for (const mode of ["shared marker", "protected process", "inspection failure"]) {
	test(`gnuplot ${mode} refuses shutdown without touching either session`, async () => {
		const f = fixture({ gnuplot: true });
		if (mode === "shared marker") f.state.panes[1].gnuplotOwner = qtOwner;
		if (mode === "protected process") f.state.markers.set(2001, qtOwner);
		if (mode === "inspection failure") f.state.markerFailure = true;
		await assert.rejects(f.stop(), /shared|protected|inspection failed/);
		assert.equal(f.state.stopped, false);
		assert.deepEqual(f.state.signals, []);
	});
}

test("gnuplot revalidates pane birth after slow helper inspection before closing tmux", async () => {
	const f = fixture({ gnuplot: true });
	f.state.onMarked = (count) => { if (count === 2) f.state.table.find((p) => p.pid === 1001).startedAt = later; };
	await assert.rejects(f.stop(), /changed during helper inspection/);
	assert.equal(f.state.stopped, false);
	assert.deepEqual(f.state.signals, []);
});

for (const marker of [undefined, "bad", qtOwner + "\n"]) {
	test(`gnuplot legacy/invalid marker ${JSON.stringify(marker)} warns instead of claiming Qt cleanup`, async () => {
		const f = fixture({ gnuplot: true });
		f.state.panes[0].gnuplotOwner = marker;
		addQt(f, 3001);
		if (marker?.includes("\n")) {
			await assert.rejects(f.stop(), /refusing unsafe shutdown/);
			assert.equal(f.state.stopped, false);
		} else {
			const result = await f.stop();
			assert.match(result.warnings.join("\n"), /Detached.*cannot be verified/);
		}
		assert.ok(!f.state.signals.some((s) => s.pid === 3001));
	});
}
