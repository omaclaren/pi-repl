import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { createDetachedGnuplotTestObserver } from "./repl-test-detached.js";

const exec = promisify(execFile);
const psColumns = "pid=,ppid=,pgid=,uid=,lstart=,stat=";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (text) => `'${text.replace(/'/g, `'"'"'`)}'`;
const key = (p) => `${p.pid}:${p.uid}:${p.startedAt}`;
const live = (p) => p && !p.state.startsWith("Z");

export function parseProcessTable(text) {
	return text.trim().split("\n").filter((line) => line.trim()).map((line) => {
		const fields = line.trim().split(/\s+/);
		assert.equal(fields.length, 10, `Unexpected ps row: ${line}`);
		const [pid, ppid, pgid, uid] = fields.slice(0, 4).map(Number);
		assert.ok([pid, ppid, pgid, uid].every(Number.isSafeInteger), `Invalid ps identity: ${line}`);
		return { pid, ppid, pgid, uid, startedAt: fields.slice(4, 9).join(" "), state: fields[9] };
	});
}

export async function readProcessTable() {
	// No command arguments or environment dumps: only lifecycle/ownership data.
	const result = await exec("ps", ["-axo", psColumns], {
		env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: 5000, maxBuffer: 4 * 1024 * 1024,
	});
	return parseProcessTable(result.stdout);
}

/** Test-only ownership registry. Never signal by executable name or bare PGID. */
export class OwnedTestProcesses {
	constructor({ ledgerPath, snapshot = readProcessTable, signal = (pid, value) => process.kill(pid, value), waitMs = 750, discoverDetached }) {
		this.ledgerPath = ledgerPath;
		this.snapshot = snapshot;
		this.signal = signal;
		this.waitMs = waitMs;
		this.owned = new Map();
		this.groups = new Map();
		this.signals = [];
		this.discoverDetached = discoverDetached;
	}

	remember(p) {
		assert.ok(p.pid > 1 && p.pid !== process.pid && p.uid === process.getuid(), "Refusing unowned/unsafe test process");
		this.owned.set(key(p), p);
		// tmux gives each pane its own process group. Retain that provenance
		// across parent exit/reparenting, but invalidate it if the leader PID
		// has been recycled. Signals still target revalidated individual PIDs.
		if (p.pgid === p.pid) this.groups.set(p.pgid, p);
	}

	async refresh(rootPids = []) {
		const table = await this.snapshot();
		const byPid = new Map(table.map((p) => [p.pid, p]));
		if (this.discoverDetached) for (const p of await this.discoverDetached(table)) this.remember(p);
		const ledger = parseProcessTable(readFileSync(this.ledgerPath, "utf8"));
		for (const recorded of ledger) {
			const current = byPid.get(recorded.pid);
			if (current && key(current) === key(recorded)) this.remember(current);
		}
		for (const pid of rootPids) {
			const p = byPid.get(pid);
			if (p) this.remember(p);
		}
		const ownedNow = new Set(table.filter((p) => this.owned.has(key(p))).map((p) => p.pid));
		for (const [pgid, leader] of this.groups) {
			const current = byPid.get(leader.pid);
			if (current && key(current) !== key(leader)) {
				this.groups.delete(pgid);
				continue;
			}
			for (const p of table) {
				if (p.pgid === pgid) { this.remember(p); ownedNow.add(p.pid); }
			}
		}
		// Learn descendants before a session/server is killed, while ancestry
		// is still available. Keep every lifetime, not just the newest pane.
		let changed;
		do {
			changed = false;
			for (const p of table) {
				if (!ownedNow.has(p.pid) && ownedNow.has(p.ppid)) {
					this.remember(p); ownedNow.add(p.pid); changed = true;
				}
			}
		} while (changed);
		return table.filter((p) => this.owned.has(key(p)) && live(p));
	}

	async send(p, signal) {
		// Check birth identity again immediately before every signal, including
		// escalation. PPID/PGID may change legitimately after parent exit.
		const current = (await this.snapshot()).find((candidate) => candidate.pid === p.pid);
		if (!live(current) || key(current) !== key(p)) return;
		assert.ok(this.owned.has(key(current)), "Refusing to signal an untracked process");
		try {
			this.signal(current.pid, signal);
			this.signals.push({ pid: current.pid, signal });
		} catch (error) {
			if (error.code !== "ESRCH") throw error;
		}
	}

	async settle(ms, full = false) {
		const deadline = Date.now() + ms;
		while (true) {
			const remaining = await this.refresh();
			if ((!remaining.length && !full) || Date.now() >= deadline) return remaining;
			await sleep(50);
		}
	}

	async terminate() {
		let remaining = await this.settle(this.discoverDetached ? 750 : 150, Boolean(this.discoverDetached)); // allow ordinary hangup and detached-launch settlement
		for (const p of remaining) await this.send(p, "SIGTERM");
		remaining = await this.settle(this.waitMs);
		const deadline = Date.now() + 3000;
		while (remaining.length && Date.now() < deadline) {
			for (const p of remaining) await this.send(p, "SIGKILL");
			remaining = await this.settle(100);
		}
		assert.deepEqual(remaining, [], "Owned test runtime processes survived teardown");
		return this.signals;
	}
}

export function createTestTmux(t, { cwd, env, config, trackDetachedGnuplot = false }) {
	// A short private -S path avoids Unix socket limits and leaves no stale
	// test sockets in the user's tmux directory. Only our directory is removed.
	const socketDir = mkdtempSync("/tmp/pi-repl-tmux-");
	const socketPath = join(socketDir, "server.sock");
	const ledgerPath = join(socketDir, "processes.log");
	writeFileSync(ledgerPath, "", { mode: 0o600, flag: "wx" });
	const processes = new OwnedTestProcesses({ ledgerPath, discoverDetached: trackDetachedGnuplot ? createDetachedGnuplotTestObserver(cwd) : undefined });
	const raw = (args, options = {}) => exec("tmux", [...(args[0] === "new-session" ? [] : ["-N"]), "-S", socketPath, "-f", config, ...args], {
		env, cwd, timeout: 10000, maxBuffer: 8 * 1024 * 1024, ...options,
	});
	async function observe() {
		let roots = [];
		try {
			const result = await raw(["display-message", "-p", "#{pid}"], { timeout: 3000 });
			assert.match(result.stdout.trim(), /^\d+$/);
			roots = [Number(result.stdout.trim())];
		} catch (error) {
			if (error.code !== 1) throw error; // no live server/session is normal
		}
		return processes.refresh(roots);
	}
	const creates = new Set(["new-session", "new-window", "split-window", "respawn-pane", "respawn-window"]);
	const destroys = new Set(["kill-server", "kill-session", "kill-window", "kill-pane", "respawn-pane", "respawn-window", "if-shell"]);
	let cleanupPromise;
	const harness = {
		socketPath, ledgerPath, processes,
		async owned() { await observe(); return processes.refresh(); },
		// A runtime can outlive a vanished pane before the next tmux inspection.
		// Record its identity before exec, including every restarted lifetime.
		launcherPrologue: `LC_ALL=C TZ=UTC ps -p "$$" -o ${psColumns} >> ${quote(ledgerPath)} || exit 1\n`,
		async run(args, options = {}) {
			if (destroys.has(args[0])) await observe();
			try { return await raw(args, options); }
			finally { if (creates.has(args[0])) await observe(); }
		},
		observe,
		cleanup() {
			cleanupPromise ??= (async () => {
				// Keep cleanup running even if a preliminary check fails, and
				// retain diagnostics/socket directory if verification fails.
				const errors = [];
				try { await observe(); } catch (error) { errors.push(error); }
				try { await raw(["kill-server"]); } catch (error) { if (error.code !== 1) errors.push(error); }
				try { await processes.terminate(); } catch (error) { errors.push(error); }
				try {
					await raw(["list-sessions"]);
					errors.push(new Error("Isolated test tmux server is still running"));
				} catch (error) { if (error.code !== 1) errors.push(error); }
				if (errors.length) throw new AggregateError(errors, `REPL test cleanup failed; diagnostics: ${socketDir}`);
				rmSync(socketDir, { recursive: true, force: true });
				return processes.signals;
			})();
			return cleanupPromise;
		},
	};
	// Register before launching anything, including setup that may fail.
	t.after(() => harness.cleanup());
	return harness;
}
