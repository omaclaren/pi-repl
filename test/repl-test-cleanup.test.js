import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createTestTmux, OwnedTestProcesses, parseProcessTable, readProcessTable } from "./helpers/repl-test-tmux.js";

const exec = promisify(execFile);
const unix = process.platform !== "win32";
const available = unix && spawnSync("tmux", ["-V"]).status === 0;
const uid = process.getuid?.() ?? 0;
const birth = "Wed Sep 9 08:00:00 2026";
const laterBirth = "Wed Sep 9 08:01:00 2026";
const proc = (pid, extra = {}) => ({ pid, ppid: 1, pgid: pid, uid, startedAt: birth, state: "S", ...extra });
const psRow = (p) => `${p.pid} ${p.ppid} ${p.pgid} ${p.uid} ${p.startedAt} ${p.state}\n`;
const quote = (text) => `'${text.replace(/'/g, `'"'"'`)}'`;

function registryFixture(t, initial = []) {
	const dir = mkdtempSync(join(tmpdir(), "pi-repl-cleanup-unit-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const ledgerPath = join(dir, "processes.log");
	writeFileSync(ledgerPath, "", { mode: 0o600 });
	const state = { table: initial, signals: [] };
	const registry = new OwnedTestProcesses({
		ledgerPath, waitMs: 0,
		snapshot: async () => state.table.map((p) => ({ ...p })),
		signal: (pid, signal) => {
			state.signals.push({ pid, signal });
			if (signal === "SIGKILL") state.table = state.table.filter((p) => p.pid !== pid);
		},
	});
	return { registry, state, ledger: (...entries) => writeFileSync(ledgerPath, entries.map(psRow).join("")) };
}

test("process identities parse ps spacing without reading arguments or environment", () => {
	assert.deepEqual(parseProcessTable(" 100 1 100 501 Wed Sep  9 08:00:00 2026 Ss+\n"), [proc(100, { uid: 501, state: "Ss+" })]);
	assert.deepEqual(parseProcessTable(""), []);
	assert.throws(() => parseProcessTable("100 not an identity"), /Unexpected ps row/);
});

test("runtime ledger recovers an orphan and SIGKILL escalation leaves unrelated processes alone", { skip: !unix }, async (t) => {
	const owned = proc(900001), unrelated = proc(900002);
	const f = registryFixture(t, [owned, unrelated]);
	f.ledger(owned);
	await f.registry.terminate();
	assert.deepEqual(f.state.signals, [{ pid: owned.pid, signal: "SIGTERM" }, { pid: owned.pid, signal: "SIGKILL" }]);
	assert.deepEqual(f.state.table, [unrelated]);
});

test("tracking retains old lifetimes, descendants and orphaned group members after parent exit", { skip: !unix }, async (t) => {
	const parent = proc(900001), child = proc(900002, { ppid: parent.pid, pgid: parent.pid });
	const f = registryFixture(t, [parent, child]);
	await f.registry.refresh([parent.pid]);
	const newOrphan = proc(900003, { pgid: parent.pid });
	const replacement = proc(900004, { startedAt: laterBirth });
	f.state.table = [{ ...child, ppid: 1 }, newOrphan, replacement];
	f.ledger(replacement);
	await f.registry.terminate();
	assert.deepEqual(new Set(f.state.signals.map((s) => s.pid)), new Set([child.pid, newOrphan.pid, replacement.pid]));
});

test("a recycled PID invalidates stale ledger entries and old process-group ownership", { skip: !unix }, async (t) => {
	const old = proc(900001), child = proc(900002, { pgid: old.pid });
	const f = registryFixture(t, [old]);
	f.ledger(old);
	await f.registry.refresh();
	f.state.table = [{ ...old, startedAt: laterBirth }, child];
	assert.deepEqual(await f.registry.refresh(), []);
	await f.registry.terminate();
	assert.deepEqual(f.state.signals, []);
});

test("signals revalidate birth identity immediately, including escalation after TERM", { skip: !unix }, async (t) => {
	const old = proc(900001);
	const f = registryFixture(t, [old]);
	f.ledger(old);
	await f.registry.refresh();
	f.state.table = [{ ...old, startedAt: laterBirth }];
	await f.registry.send(old, "SIGKILL");
	assert.deepEqual(f.state.signals, []);
	f.state.table = [old];
	f.registry.signal = (pid, signal) => {
		f.state.signals.push({ pid, signal });
		f.state.table = [{ ...old, startedAt: laterBirth }];
	};
	await f.registry.terminate();
	assert.deepEqual(f.state.signals, [{ pid: old.pid, signal: "SIGTERM" }]);
});

test("cleanup refuses unsafe ownership and treats exited zombies as non-running", { skip: !unix }, async (t) => {
	const f = registryFixture(t);
	for (const unsafe of [proc(1), proc(process.pid), proc(900001, { uid: uid + 1 })]) {
		assert.throws(() => f.registry.remember(unsafe), /unsafe test process/);
	}
	const zombie = proc(900002, { state: "Z" });
	f.state.table = [zombie];
	f.ledger(zombie);
	await f.registry.terminate();
	assert.deepEqual(f.state.signals, []);
});

test("cleanup surfaces signal failures rather than claiming success", { skip: !unix }, async (t) => {
	const p = proc(900001), f = registryFixture(t, [p]);
	f.ledger(p);
	f.registry.signal = () => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); };
	await assert.rejects(f.registry.terminate(), /permission denied/);
});

async function eventually(check) {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("Cleanup regression fixture did not become ready");
}

test("the registered teardown hook reaps a runtime even when test setup throws", { skip: !available, timeout: 30000 }, async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-repl-cleanup-live-"));
	const rescueLedger = join(cwd, "rescue.log");
	writeFileSync(rescueLedger, "", { mode: 0o600 });
	const rescue = new OwnedTestProcesses({ ledgerPath: rescueLedger });
	// Independent parent fallback, so a regression in the child hook cannot
	// leave the intentionally stubborn test process behind on this machine.
	t.after(() => rescue.terminate());
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const runtimeFile = join(cwd, "runtime.mjs");
	writeFileSync(runtimeFile, `import { writeFileSync } from 'node:fs';
process.on('SIGHUP', () => {}); process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
writeFileSync(${JSON.stringify(join(cwd, "ready"))}, String(process.pid));\n`);
	const worker = join(cwd, "failure.test.mjs");
	writeFileSync(worker, `
import test from 'node:test';
import { existsSync, writeFileSync } from 'node:fs';
import { createTestTmux } from ${JSON.stringify(new URL("./helpers/repl-test-tmux.js", import.meta.url).href)};
test('intentional setup failure', async (t) => {
  const cwd = ${JSON.stringify(cwd)};
  const env = { ...process.env, HOME: cwd, SHELL: '/bin/sh' };
  delete env.TMUX; delete env.TMUX_PANE;
  const config = cwd + '/tmux.conf';
  writeFileSync(config, 'set -g default-shell /bin/sh\\n');
  const h = createTestTmux(t, { cwd, env, config });
  const launcher = cwd + '/launcher.sh';
  writeFileSync(launcher, '#!/bin/sh\\n' + h.launcherPrologue +
    ${JSON.stringify(`LC_ALL=C TZ=UTC ps -p "$$" -o pid=,ppid=,pgid=,uid=,lstart=,stat= >> ${quote(rescueLedger)}\nexec ${quote(process.execPath)} ${quote(runtimeFile)}\n`)}, { mode: 0o700 });
  await h.run(['new-session', '-d', '-s', 'failure', ${JSON.stringify(quote(join(cwd, "launcher.sh")))}]);
  const end = Date.now() + 10000;
  while (!existsSync(cwd + '/ready')) {
    if (Date.now() > end) throw new Error('runtime startup failed');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('intentional setup failure after runtime launch');
});\n`);
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	await assert.rejects(exec(process.execPath, ["--test", worker], { cwd, env, timeout: 20000 }), (error) => {
		assert.equal(error.code, 1);
		assert.match(error.stdout, /intentional setup failure after runtime launch/);
		assert.doesNotMatch(error.stdout, /cleanup failed|hookFailed/);
		return true;
	});
	const recorded = parseProcessTable(readFileSync(rescueLedger, "utf8"));
	assert.equal(recorded.length, 1);
	const table = await readProcessTable();
	assert.ok(!table.some((p) => p.pid === recorded[0].pid && p.startedAt === recorded[0].startedAt && !p.state.startsWith("Z")));
});

for (const mode of ["server-exit", "session-replacement", "vanished-before-inspection"]) {
	test(`test cleanup reaps HUP/TERM-resistant runtimes and descendants after ${mode}`, { skip: !available, timeout: 30000 }, async (t) => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-repl-cleanup-live-"));
		const env = { ...process.env, HOME: cwd, SHELL: "/bin/sh" };
		delete env.TMUX; delete env.TMUX_PANE;
		const config = join(cwd, "tmux.conf");
		writeFileSync(config, "set -g default-shell /bin/sh\n");
		const harness = createTestTmux(t, { cwd, env, config });
		const protectedHarness = createTestTmux(t, { cwd, env, config });
		// Remove files only after process-aware hooks have run.
		t.after(() => rmSync(cwd, { recursive: true, force: true }));
		assert.equal(statSync(harness.ledgerPath).mode & 0o777, 0o600);
		assert.equal(statSync(join(harness.socketPath, "..")).mode & 0o777, 0o700);
		const source = join(cwd, "stubborn.mjs");
		writeFileSync(source, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
process.on('SIGHUP', () => {});
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
if (process.argv[2] !== 'child') spawn(process.execPath, [process.argv[1], 'child'], { stdio: 'inherit' });
writeFileSync(${JSON.stringify(cwd)} + '/' + (process.argv[2] || 'parent') + '.pid', String(process.pid));
`);
		const launcher = join(cwd, "launcher.sh");
		writeFileSync(launcher, `#!/bin/sh\n${harness.launcherPrologue}exec ${quote(process.execPath)} ${quote(source)}\n`, { mode: 0o700 });
		const startArgs = ["new-session", "-d", "-s", "owned", quote(launcher)];
		if (mode === "vanished-before-inspection") {
			// Bypass normal observation deliberately. Only the pre-exec ledger
			// can recover this runtime once its server/pane have already gone.
			await exec("tmux", ["-S", harness.socketPath, "-f", config, ...startArgs], { cwd, env });
		} else await harness.run(startArgs);
		await eventually(() => existsSync(join(cwd, "parent.pid")) && existsSync(join(cwd, "child.pid")));
		const pids = ["parent", "child"].map((name) => Number(readFileSync(join(cwd, name + ".pid"), "utf8")));
		const identities = (await readProcessTable()).filter((p) => pids.includes(p.pid));
		assert.equal(identities.length, 2);
		if (mode === "vanished-before-inspection") {
			await exec("tmux", ["-N", "-S", harness.socketPath, "kill-server"], { cwd, env });
		} else {
			await harness.run(mode === "session-replacement" ? ["kill-session", "-t", "=owned"] : ["kill-server"]);
		}
		// These really survive tmux shutdown; checking only list-sessions
		// would pass while the runtime remains alive (the GHCi regression).
		assert.ok((await readProcessTable()).some((p) => p.pid === pids[0] && p.state !== "Z"));
		if (mode === "session-replacement") await harness.run(["new-session", "-d", "-s", "owned", "sleep 60"]);
		await protectedHarness.run(["new-session", "-d", "-s", "unrelated", "sleep 60"]);
		const protectedPane = (await protectedHarness.run(["list-panes", "-a", "-F", "#{pane_pid}"])).stdout;
		const signals = await harness.cleanup();
		assert.ok(signals.some((s) => s.signal === "SIGKILL" && pids.includes(s.pid)), JSON.stringify(signals));
		const table = await readProcessTable();
		for (const identity of identities) {
			assert.ok(!table.some((p) => p.pid === identity.pid && p.startedAt === identity.startedAt && !p.state.startsWith("Z")), `surviving test runtime ${identity.pid}`);
		}
		assert.equal((await protectedHarness.run(["list-panes", "-a", "-F", "#{pane_pid}"])).stdout, protectedPane);
		assert.equal(existsSync(harness.socketPath), false);
		assert.equal(existsSync(harness.ledgerPath), false);
		await harness.cleanup(); // idempotent, including after ledger removal
	});
}
