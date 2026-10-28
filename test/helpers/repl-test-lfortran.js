// What the LFortran session tests share: an isolated tmux server, home and
// PATH with `lfortran` on it (the fake, or PI_REPL_LFORTRAN), and cleanups
// that run in the right order.
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestTmux } from "./repl-test-tmux.js";

export const FAKE_LFORTRAN = fileURLToPath(new URL("./fake-lfortran.js", import.meta.url));
export const REAL_LFORTRAN = process.env.PI_REPL_LFORTRAN;
export const tmuxAvailable = process.platform !== "win32" && spawnSync("tmux", ["-V"]).status === 0;
const quote = (text) => `'${text.replace(/'/g, `'"'"'`)}'`;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(condition, { timeoutMs = 10_000, what = "the condition" } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
		await sleep(50);
	}
}

/**
 * Registers a cleanup for test `t`. Cleanups run last first, each even if
 * another failed; node:test's own after hooks run first first, and stop at
 * the first that throws.
 */
export function defer(t, cleanup) {
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
 * An isolated tmux server, home and PATH, with `lfortran` on it. Every
 * lfortran process records itself in the harness's ledger first, so that one
 * left without its parent is still cleaned up. Null, after skipping, without tmux.
 */
export function lfortranFixture(t, { env: extra = {}, index = 0, real = false } = {}) {
	if (!tmuxAvailable) { t.skip("tmux is required"); return null; }
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
	return {
		base, root, env, tmux, harness, run, lfortran: join(bin, "lfortran"),
		windows: async () => (await tmux(["list-windows", "-t", "=pi-repl-lfortran", "-F", "#{window_index}\t#{window_active}\t#{pane_id}\t#{remain-on-exit}\t#{pane_dead}"])).stdout.trim().split("\n").map((line) => line.split("\t")),
		pane: async (paneId) => (await tmux(["capture-pane", "-p", "-t", paneId])).stdout,
	};
}
