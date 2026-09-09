import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const processKey = (p) => `${p.pid}:${p.uid}:${p.startedAt}`;
const live = (p) => Boolean(p && !p.state.startsWith("Z"));
const fingerprintFormat = "#{pid}|#{session_id}|#{session_name}|#{session_created}|#{W:#{window_id}:#{window_linked}:#{P:#{pane_id}:#{pane_pid}:#{pane_dead};};}";
const paneFormat = "#{pid}\t#{session_id}\t#{session_name}\t#{session_created}\t#{pane_id}\t#{pane_pid}\t#{pane_tty}\t#{pane_dead}\t#{window_id}\t#{window_index}\t#{pane_index}\t#{window_linked}\t#{@pi_repl_record_id}";

export function parseStopProcessTable(text) {
	return text.split("\n").filter((line) => line.trim()).map((line) => {
		const f = line.trim().split(/\s+/);
		if (f.length !== 11 || !f.slice(0, 4).every((v) => /^\d+$/.test(v) && Number.isSafeInteger(Number(v)))) throw new Error("Could not parse process ownership data; refusing unsafe shutdown.");
		return { pid: Number(f[0]), ppid: Number(f[1]), pgid: Number(f[2]), uid: Number(f[3]), tty: f[4], startedAt: f.slice(5, 10).join(" "), state: f[10] };
	});
}

export async function readStopProcessTable() {
	const result = await exec("ps", ["-axo", "pid=,ppid=,pgid=,uid=,tty=,lstart=,stat="], {
		env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: 3000, maxBuffer: 4 * 1024 * 1024,
	});
	return parseStopProcessTable(result.stdout);
}

function parsePanes(text) {
	return text.split("\n").filter((line) => line.trim()).map((line) => {
		const f = line.split("\t");
		if (f.length !== 13 || !/^\d+$/.test(f[0]) || !/^\$\d+$/.test(f[1]) || !/^\d+$/.test(f[3]) ||
			!/^%\d+$/.test(f[4]) || !/^\d+$/.test(f[5]) || !/^\/dev\//.test(f[6]) || !/^[01]$/.test(f[7]) ||
			!/^@\d+$/.test(f[8]) || !/^\d+$/.test(f[9]) || !/^\d+$/.test(f[10]) || !/^[01]$/.test(f[11])) {
			throw new Error("Could not identify tmux pane ownership; refusing unsafe shutdown.");
		}
		return { serverPid: Number(f[0]), sessionId: f[1], sessionName: f[2], createdAt: f[3], paneId: f[4], pid: Number(f[5]), tty: f[6].slice(5), dead: f[7], windowId: f[8], windowIndex: Number(f[9]), paneIndex: Number(f[10]), linked: f[11], recordId: f[12] };
	});
}

async function readPanes(tmux) {
	const result = await tmux(["list-panes", "-a", "-F", paneFormat]);
	if (result.code !== 0) {
		if (/no server running|(?:error connecting|failed to connect).*?(?:No such file|Connection refused)/i.test(result.stderr)) return [];
		throw new Error(`Could not inspect tmux while verifying shutdown: ${result.stderr.trim() || `exit ${result.code}`}`);
	}
	return parsePanes(result.stdout);
}

function fingerprint(panes) {
	const first = panes[0];
	let windows = "", previousWindow;
	for (const p of [...panes].sort((a, b) => a.windowIndex - b.windowIndex || a.paneIndex - b.paneIndex)) {
		if (p.windowId !== previousWindow) {
			if (previousWindow) windows += ";";
			windows += `${p.windowId}:${p.linked}:`;
			previousWindow = p.windowId;
		}
		windows += `${p.paneId}:${p.pid}:${p.dead};`;
	}
	return `${first.serverPid}|${first.sessionId}|${first.sessionName}|${first.createdAt}|${windows};`;
}

function closure(table, roots) {
	const ids = new Set(roots);
	let changed;
	do {
		changed = false;
		for (const p of table) if (ids.has(p.ppid) && !ids.has(p.pid)) { ids.add(p.pid); changed = true; }
	} while (changed);
	return ids;
}

function protectedProcesses(table, panes, currentPid, serverPid) {
	// Never include the server as an ownership root: its children include
	// other REPLs, attached clients and unrelated history loggers.
	const ids = closure(table, [currentPid, ...panes.filter((p) => p.dead === "0").map((p) => p.pid)]);
	const byPid = new Map(table.map((p) => [p.pid, p]));
	let p = byPid.get(currentPid);
	const visited = new Set();
	while (p && !visited.has(p.pid)) { visited.add(p.pid); ids.add(p.pid); p = byPid.get(p.ppid); }
	ids.add(0); ids.add(1); ids.add(serverPid);
	for (const pane of panes) ids.add(pane.serverPid);
	return ids;
}

/** Snapshot-based, session-scoped counterpart to the independent test tracker. */
export class SessionStopProcesses {
	constructor({ table, panes, selected, currentPid, uid }) {
		this.owned = new Map();
		this.groups = new Map();
		this.uid = uid;
		this.currentPid = currentPid;
		this.serverPid = selected[0].serverPid;
		this.issues = new Set();
		const otherPanes = panes.filter((p) => p.sessionId !== selected[0].sessionId);
		const protectedIds = protectedProcesses(table, otherPanes, currentPid, this.serverPid);
		const roots = [];
		for (const pane of selected) {
			if (pane.linked !== "0" || otherPanes.some((p) => p.paneId === pane.paneId)) throw new Error("A REPL window is linked to another session. Unlink it before stopping; nothing was stopped.");
			const p = table.find((candidate) => candidate.pid === pane.pid);
			if (pane.dead !== "0" || !live(p) || p.tty !== pane.tty || p.pgid !== p.pid) {
				throw new Error(`Cannot verify the runtime owner of pane ${pane.paneId}; nothing was stopped. Inspect dead or detached panes manually.`);
			}
			if (protectedIds.has(p.pid) || p.uid !== uid) throw new Error("REPL ownership overlaps Pi, another session or another user; nothing was stopped.");
			roots.push(p.pid);
			this.groups.set(p.pgid, p);
		}
		const ids = closure(table, roots);
		for (const p of table) {
			if (ids.has(p.pid) || (this.groups.has(p.pgid) && p.tty === this.groups.get(p.pgid).tty)) {
				if (protectedIds.has(p.pid) || p.uid !== uid) throw new Error("Runtime descendants overlap protected processes; nothing was stopped.");
				this.owned.set(processKey(p), p);
			}
		}
	}

	refresh(table, panes) {
		const protectedIds = protectedProcesses(table, panes, this.currentPid, this.serverPid);
		const byPid = new Map(table.map((p) => [p.pid, p]));
		const known = table.filter((p) => this.owned.has(processKey(p)));
		const ids = closure(table, known.filter((p) => !protectedIds.has(p.pid)).map((p) => p.pid));
		for (const [pgid, leader] of this.groups) {
			const currentLeader = byPid.get(leader.pid);
			const members = table.filter((p) => p.pgid === pgid && live(p));
			if (currentLeader && processKey(currentLeader) !== processKey(leader)) continue; // recycled leader
			// Do not adopt new processes solely because they share a stale
			// numeric PGID. Require continuity through a known live member.
			if (known.some((p) => live(p) && p.pgid === pgid && !protectedIds.has(p.pid))) {
				for (const p of members) ids.add(p.pid);
			} else if (members.some((p) => !this.owned.has(processKey(p)))) {
				this.issues.add(`Unconfirmed survivors in former pane group ${pgid}; manual inspection is required.`);
			}
		}
		for (const p of table) {
			if (!ids.has(p.pid) && !this.owned.has(processKey(p))) continue;
			if (protectedIds.has(p.pid) || p.uid !== this.uid) {
				if (live(p)) this.issues.add(`PID ${p.pid} now overlaps a protected process/session; it was not signalled.`);
				continue;
			}
			this.owned.set(processKey(p), p);
		}
		return table.filter((p) => this.owned.has(processKey(p)) && live(p) && !protectedIds.has(p.pid) && p.uid === this.uid);
	}
}

/** Explicit stop only. Never used by send, startup, reload, or shutdown hooks. */
export async function stopVerifiedReplSession({ tmux, sessionName, snapshot = readStopProcessTable, signal = (pid, value) => process.kill(pid, value), currentPid = process.pid, uid = process.getuid?.(), graceMs = 500, termMs = 1000, killMs = 2000 }) {
	if (typeof uid !== "number" || !/^pi-repl-(python|julia|r|ghci|clojure|ruby|java)$/.test(sessionName)) throw new Error("Verified REPL shutdown requires a supported local Unix session.");
	const panes = await readPanes(tmux);
	const selected = panes.filter((p) => p.sessionName === sessionName);
	if (!selected.length) throw new Error("The selected session ended or changed before shutdown; no processes were signalled.");
	const original = selected[0];
	const table = await snapshot();
	const server = table.find((p) => p.pid === original.serverPid);
	if (!live(server) || server.uid !== uid) throw new Error("Cannot verify the local tmux server owner; nothing was stopped.");
	const tracker = new SessionStopProcesses({ table, panes, selected, currentPid, uid });
	const originalFingerprint = fingerprint(selected);
	const repeatPanes = await readPanes(tmux);
	const repeatSelected = repeatPanes.filter((p) => p.sessionId === original.sessionId);
	const repeatTable = await snapshot();
	if (!repeatSelected.length || fingerprint(repeatSelected) !== originalFingerprint ||
		!repeatTable.some((p) => processKey(p) === processKey(server)) ||
		selected.some((pane) => !repeatTable.some((p) => p.pid === pane.pid && tracker.owned.has(processKey(p))))) {
		throw new Error("Session ownership changed while preparing shutdown; nothing was stopped.");
	}
	// This comparison and kill execute in the same tmux command queue: a
	// changed/replaced session or newly linked/added pane cannot slip between
	// the final topology check and kill-session. No runtime input is injected.
	let condition = `#{==:${fingerprintFormat},${originalFingerprint}}`;
	if (/^[a-f0-9]{32}$/.test(original.recordId)) condition = `#{&&:${condition},#{==:#{@pi_repl_record_id},${original.recordId}}}`;
	const stopped = await tmux(["if-shell", "-F", "-t", original.sessionId, condition, `kill-session -t '${original.sessionId}'`, "display-message -p PI_REPL_STOP_CHANGED"]);
	if (stopped.code !== 0 || stopped.stdout.includes("PI_REPL_STOP_CHANGED")) throw new Error(`tmux refused or could not complete the stop; no follow-up signals were sent. ${stopped.stderr.trim() || stopped.stdout.trim()}`);

	const signals = [];
	async function inspect() {
		const currentPanes = await readPanes(tmux);
		const currentTable = await snapshot();
		const sameServer = currentTable.some((p) => processKey(p) === processKey(server));
		if (sameServer && currentPanes.some((p) => p.serverPid === original.serverPid && p.sessionId === original.sessionId && p.createdAt === original.createdAt)) throw new Error("The original tmux session still exists; no follow-up signals were sent.");
		return tracker.refresh(currentTable, currentPanes);
	}
	async function wait(ms) {
		const deadline = Date.now() + ms;
		while (true) {
			const remaining = await inspect();
			if (!remaining.length || Date.now() >= deadline) return remaining;
			await sleep(100);
		}
	}
	async function sendVerified(p, value) {
		// Fresh pane protection + fresh process birth identity before every
		// individual signal, including KILL escalation. No pkill/group kills.
		const remaining = await inspect();
		if (!remaining.some((candidate) => processKey(candidate) === processKey(p))) return;
		try { signal(p.pid, value); signals.push({ pid: p.pid, signal: value }); }
		catch (error) {
			if (error.code !== "ESRCH") tracker.issues.add(`Could not send ${value} to verified PID ${p.pid}: ${error.message}`);
		}
	}
	try {
		let remaining = await wait(graceMs);
		for (const p of remaining) await sendVerified(p, "SIGTERM");
		remaining = await wait(termMs);
		const deadline = Date.now() + killMs;
		while (remaining.length && Date.now() < deadline) {
			for (const p of remaining) await sendVerified(p, "SIGKILL");
			remaining = await wait(100);
		}
		if (remaining.length) tracker.issues.add(`Surviving verified PIDs: ${remaining.map((p) => p.pid).join(", ")}.`);
		if (tracker.issues.size) throw new Error([...tracker.issues].join(" "));
		return { sessionName, processCount: tracker.owned.size, signals };
	} catch (error) {
		throw new Error(`Stop requested for ${sessionName}, but runtime cleanup could not be fully verified: ${error.message} Inspect remaining processes manually; logs and clean records were preserved.`, { cause: error });
	}
}
