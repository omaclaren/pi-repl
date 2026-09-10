// Independent rescue/audit for native gnuplot_qt daemons. Do not reuse the
// production ownership-marker reader: it must not hide a bug in that reader.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export function createDetachedGnuplotTestObserver(cwd) {
	const root = realpathSync(cwd), initial = lstatSync(root), uid = process.getuid();
	assert.ok(initial.isDirectory() && initial.uid === uid && (initial.mode & 0o777) === 0o700, "Detached test scope must be a private directory");
	const created = Date.now();
	return async (table) => {
		const now = lstatSync(root);
		assert.ok(now.ino === initial.ino && now.dev === initial.dev && now.uid === uid && (now.mode & 0o777) === 0o700, "Detached test scope changed");
		const result = await exec("ps", ["-axo", "pid=,uid=,comm="], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
		const ids = result.stdout.split("\n").flatMap((line) => {
			const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
			return m && Number(m[2]) === uid && ["gnuplot", "gnuplot_qt"].includes(basename(m[3])) ? [Number(m[1])] : [];
		});
		const found = [];
		for (const p of table) {
			if (!ids.includes(p.pid) || p.uid !== uid || p.state.startsWith("Z") || Date.parse(`${p.startedAt} UTC`) < created - 1000) continue;
			let output;
			try {
				output = (await exec("lsof", ["-a", "-p", String(p.pid), "-d", "cwd", "-Fn"], { timeout: 3000, maxBuffer: 8192 })).stdout;
			} catch (error) {
				// A short-lived launcher can disappear between ps and lsof.
				const check = await exec("ps", ["-p", String(p.pid), "-o", "pid="], { timeout: 3000 }).catch((e) => { if (e.code === 1) return { stdout: "" }; throw e; });
				if (check.stdout.trim()) throw new Error(`Could not inspect detached test candidate ${p.pid}`, { cause: error });
				continue;
			}
			const paths = output.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
			if (paths.some((path) => path === root || path.startsWith(root + "/"))) found.push(p);
		}
		return found;
	};
}
