// The tmux side of a shared session whose runtime is a Jupyter kernel, such as
// LFortran's: finding lfortran, starting the session with the person's prompt
// and the helper (repl-jupyter-helper.js) in windows of their own, reading its
// identities back, and its verified stop. Callers pass `tmux(args)`, which
// resolves with { code, stdout, stderr }, as for repl-session-stop.js.
//
//   window 1, the person's:  a waiter, then `exec lfortran --connect DIR/k.json`
//   window 2, the helper's:  node repl-jupyter-helper.js --dir DIR --lfortran PATH
//                            └─ lfortran kernel -f DIR/k.json --managed

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HELPER_FILES, HELPER_PROTOCOL_VERSION, HelperClient, checkPrivateDirectory } from "./repl-jupyter-helper.js";
import { readOwnerMarkers } from "./repl-gnuplot-processes.js";
import { SessionStopProcesses, endVerifiedSurvivors, fingerprint, fingerprintFormat, live, processKey, readPanes, readStopProcessTable } from "./repl-session-stop.js";

export const LFORTRAN_SESSION_NAME = "pi-repl-lfortran";
export const JUPYTER_OWNER_ENV = "PI_REPL_JUPYTER_OWNER";
// Studio refuses to paste into a session with any value but "pane" here.
export const JUPYTER_SEND_PATH = "jupyter-helper";
export const JUPYTER_OPTIONS = {
	runtime: "@pi_repl_runtime",
	sendPath: "@pi_repl_send_path",
	owner: "@pi_repl_jupyter_owner",
	dir: "@pi_repl_jupyter_dir",
	lfortran: "@pi_repl_jupyter_lfortran",
	personPane: "@pi_repl_jupyter_person_pane",
	helperPane: "@pi_repl_jupyter_helper_pane",
};
// pi-repl's claim on a session directory: the launch's owner marker.
export const LAUNCH_FILE = "launch";
export const HELPER_SCRIPT = fileURLToPath(new URL("./repl-jupyter-helper.js", import.meta.url));
const OWNER = /^[0-9a-f]{32}$/;
const PANE = /^%\d+$/;
const WINDOW = /^@\d+$/;
const SESSION = /^\$\d+$/;
// LFortran's prompt: `>>> `, with the cursor's line and column at the right.
const PROMPT = /^>>>(?: |$)/;
const MAX_READY_BYTES = 64 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
export const defaultShell = () => process.env.SHELL?.trim() || "/bin/sh";

/** Runs a command; resolves with { code, stdout, stderr }, never rejects. */
export function runCommand(file, args, { cwd, timeoutMs = 15_000, env } = {}) {
	return new Promise((resolve) => {
		execFile(file, args, { cwd, env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? (error ? error.message : "")) });
		});
	});
}

/**
 * Finds `lfortran` as the person's login shell does, and checks that it has
 * the shared session (LFortran main after #16032): `--connect`, and
 * `kernel --managed`. Resolves with its real path, which the helper then
 * runs directly, so that its child is the kernel itself.
 */
export async function preflightLfortran({ shell = defaultShell(), cwd, run = runCommand, timeoutMs = 15_000 } = {}) {
	const found = await run(shell, ["-i", "-l", "-c", "command -v lfortran"], { cwd, timeoutMs });
	// An interactive shell's startup files can print too; the path is the last line.
	const printed = found.code === 0 ? found.stdout.trim().split("\n").at(-1).trim() : "";
	if (!printed.startsWith("/")) {
		throw new Error(`lfortran wasn't found by your login shell (\`${shell} -i -l -c 'command -v lfortran'\`). The LFortran session needs LFortran main after #16032 on your PATH.`);
	}
	let path;
	try {
		path = realpathSync(printed);
	} catch (error) {
		throw new Error(`lfortran was found at ${printed}, but it can't be resolved: ${error.message}`);
	}
	const help = await run(path, ["--help"], { cwd, timeoutMs });
	const kernelHelp = await run(path, ["kernel", "--help"], { cwd, timeoutMs });
	if (!/--connect\b/.test(help.stdout + help.stderr) || !/--managed\b/.test(kernelHelp.stdout + kernelHelp.stderr)) {
		throw new Error(`${path} has no shared session: the LFortran session needs LFortran main after #16032 (\`lfortran --connect\` and \`lfortran kernel --managed\`).`);
	}
	const version = await run(path, ["--version"], { cwd, timeoutMs });
	return { path, version: (version.stdout.trim().split("\n")[0] ?? "").trim() };
}

/**
 * A new private directory for one launch, short enough that DIR/h.sock fits
 * macOS's 104-byte socket paths: ROOT/pi-rj-<uid>/<8 hex>. Both levels are
 * real directories of this user's, mode 0700. DIR/launch, written
 * exclusively, binds it to its launch's owner marker: a stop removes only a
 * directory that names its own session's marker.
 */
export function createSessionDir({ root = "/tmp", uid = process.getuid(), owner }) {
	if (!OWNER.test(owner ?? "")) throw new Error("A session directory needs its launch's owner marker.");
	const parent = join(root, `pi-rj-${uid}`);
	try {
		mkdirSync(parent, { mode: 0o700 });
		chmodSync(parent, 0o700);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
	checkPrivateDirectory(parent);
	for (let attempt = 0; attempt < 8; attempt++) {
		const dir = join(parent, randomBytes(4).toString("hex"));
		try {
			mkdirSync(dir, { mode: 0o700 });
		} catch (error) {
			if (error.code === "EEXIST") continue;
			throw error;
		}
		chmodSync(dir, 0o700);
		checkPrivateDirectory(dir);
		const fd = openSync(join(dir, LAUNCH_FILE), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try { writeSync(fd, `${owner}\n`); } finally { closeSync(fd); }
		return dir;
	}
	throw new Error(`Could not make a new session directory in ${parent}.`);
}

/** Whether `dir` has the shape of one made by createSessionDir, and is still private. */
export function validSessionDir(dir, { root = "/tmp", uid = process.getuid() } = {}) {
	if (typeof dir !== "string" || dir !== join(root, `pi-rj-${uid}`, basename(dir)) || !/^[0-9a-f]{8}$/.test(basename(dir))) return false;
	try {
		checkPrivateDirectory(join(root, `pi-rj-${uid}`));
		checkPrivateDirectory(dir);
		return true;
	} catch {
		return false;
	}
}

/**
 * DIR's identity ({ dev, ino }) if it is a valid session directory whose
 * DIR/launch, a file of this user's read without following a link, names
 * `owner`; otherwise null.
 */
export function sessionDirOwnedBy(dir, owner, { root = "/tmp", uid = process.getuid() } = {}) {
	if (!OWNER.test(owner ?? "") || !validSessionDir(dir, { root, uid }) || readLaunch(dir, uid) !== owner) return null;
	try {
		const { dev, ino } = lstatSync(dir);
		return { dev, ino };
	} catch {
		return null;
	}
}

// The person's window: it waits for the helper, then becomes LFortran's own
// prompt. It has no fixed timeout: it waits while the helper named in
// DIR/helper.pid lives. POSIX sh without backslashes, so that any login shell
// passes it on unchanged.
const WAITER = `d=$1
lfortran=$2
pid=
echo "pi-repl: starting the shared LFortran session..."
while :; do
  if [ -f "$d/ready.json" ]; then
    if grep -q '"state":"ready"' "$d/ready.json"; then
      exec "$lfortran" --connect "$d/k.json"
    fi
    echo "pi-repl: the session's helper couldn't start it:"
    grep -o '"reason":"[^"]*"' "$d/ready.json"
    echo "Stop the session with /repl stop lfortran (agent-repl stop lfortran outside Pi)."
    exit 1
  fi
  if [ -z "$pid" ] && [ -s "$d/helper.pid" ]; then pid=$(cat "$d/helper.pid"); fi
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null && [ ! -f "$d/ready.json" ]; then
    echo "pi-repl: the session's helper ended before the session was ready."
    echo "Stop the session with /repl stop lfortran (agent-repl stop lfortran outside Pi)."
    exit 1
  fi
  sleep 0.2
done
`;
// What a new window holds until its pane is kept after its command ends
// (remain-on-exit) and its real command replaces it: nothing that can end first.
const PLACEHOLDER = "exec sleep 600";

/** The person's window's command: the login shell, then the waiter. */
export function personCommand({ shell = defaultShell(), dir, lfortran }) {
	return `${quote(shell)} -i -l -c ${quote(`exec /bin/sh -c ${quote(WAITER)} pi-repl-lfortran ${quote(dir)} ${quote(lfortran)}`)}`;
}

/** The helper's window's command: the login shell, so the kernel gets the person's environment, then the helper. */
export function helperCommand({ shell = defaultShell(), nodePath = process.execPath, helperScript = HELPER_SCRIPT, dir, lfortran }) {
	return `${quote(shell)} -i -l -c ${quote(`exec ${quote(nodePath)} ${quote(helperScript)} --dir ${quote(dir)} --lfortran ${quote(lfortran)}`)}`;
}

const IDENTITY_KEYS = Object.keys(JUPYTER_OPTIONS);
const IDENTITY_FORMAT = ["#{session_id}", "#{session_created}", ...IDENTITY_KEYS.map((key) => `#{${JUPYTER_OPTIONS[key]}}`)].join("\t");

/** Every session's identity as tmux holds it: its ID, creation time and the options pi-repl set. */
export async function readSessionIdentities(tmux) {
	// list-sessions, not display-message: given a name that matches nothing, display-message prints empty fields and succeeds.
	const result = await tmux(["list-sessions", "-F", `#{session_name}\t${IDENTITY_FORMAT}`]);
	if (result.code !== 0) return [];
	return result.stdout.split("\n").filter(Boolean).map((line) => {
		const [sessionName, ...fields] = line.split("\t");
		if (fields.length !== 2 + IDENTITY_KEYS.length || !SESSION.test(fields[0]) || !/^\d+$/.test(fields[1])) {
			throw new Error(`Could not read the identity of tmux session ${sessionName}.`);
		}
		const identity = { sessionName, sessionId: fields[0], createdAt: fields[1] };
		IDENTITY_KEYS.forEach((key, i) => { identity[key] = fields[2 + i]; });
		return identity;
	});
}

/** The session's identity, or null if there is no such session. */
export async function readSessionIdentity(tmux, sessionName) {
	return (await readSessionIdentities(tmux)).find((identity) => identity.sessionName === sessionName) ?? null;
}

const sameIdentity = (a, b) => Boolean(a && b) && ["sessionId", "createdAt", ...IDENTITY_KEYS].every((key) => a[key] === b[key]);

async function setOption(tmux, target, name, value, scope = []) {
	const result = await tmux(["set-option", "-q", ...scope, "-t", target, name, value]);
	return result.code === 0;
}

/** DIR/ready.json, if it's there and readable: never followed through a link, and bounded. */
export function readReadyMarker(dir) {
	let fd;
	try {
		fd = openSync(join(dir, HELPER_FILES.ready), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_READY_BYTES) return null;
		const buffer = Buffer.alloc(stat.size);
		const size = readSync(fd, buffer, 0, buffer.length, 0);
		const marker = JSON.parse(buffer.subarray(0, size).toString("utf8"));
		return marker !== null && typeof marker === "object" ? marker : null;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** The helper's hello, if it answers on DIR/h.sock as this launch's helper. */
export async function helloFrom(identity, { connect = HelperClient.connect, timeoutMs = 2000 } = {}) {
	const client = await connect(join(identity.dir, HELPER_FILES.socket), { timeoutMs });
	try {
		const hello = await client.request("hello", {}, { timeoutMs });
		if (hello?.protocol !== HELPER_PROTOCOL_VERSION) throw new Error(`The session's helper speaks protocol ${hello?.protocol}, not ${HELPER_PROTOCOL_VERSION}; it was left alone.`);
		if (hello.launchId !== identity.owner) throw new Error("The helper on this session's socket belongs to another launch; it was left alone.");
		return hello;
	} finally {
		client.close();
	}
}

/**
 * The person's pane: "prompt" if it is live with LFortran's prompt as its
 * last line, "busy" if it is live otherwise, "ended" if it is kept dead, or
 * "gone". Text left in a dead pane is no evidence of a prompt.
 */
export async function personPrompt(tmux, identity) {
	const panes = await tmux(["list-panes", "-s", "-t", identity.sessionId, "-F", "#{pane_id}\t#{pane_dead}"]);
	if (panes.code !== 0) return "gone";
	const dead = new Map(panes.stdout.trim().split("\n").map((line) => line.split("\t"))).get(identity.personPane);
	if (dead === undefined) return "gone";
	if (dead !== "0") return "ended";
	const captured = await tmux(["capture-pane", "-p", "-t", identity.personPane]);
	if (captured.code !== 0) return "busy";
	const last = captured.stdout.split("\n").map((line) => line.trimEnd()).filter(Boolean).at(-1) ?? "";
	return PROMPT.test(last) ? "prompt" : "busy";
}

/**
 * Waits, until `deadline`, for the helper of this launch to say that it and
 * the kernel are ready, and for the person's live prompt, both at once. A
 * helper that failed or a kernel that ended stops the wait. The banner
 * doesn't count: only the prompt does.
 */
export async function waitForJupyterReady({ tmux, identity, deadline, signal, connect, pollMs = 150 }) {
	let hello = null;
	let prompt = "busy";
	let failure = null;
	for (;;) {
		hello = null;
		if (identity.dir) {
			const marker = readReadyMarker(identity.dir);
			if (marker && marker.launchId !== identity.owner) failure = "ready.json names another launch";
			else if (marker?.state === "failed") failure = typeof marker.reason === "string" ? marker.reason : "the helper failed to start";
			else if (marker?.state === "ready") {
				try {
					hello = await helloFrom(identity, { connect });
					if (hello.state === "kernel-exited") failure = "the kernel has already exited";
					else if (hello.state === "connection-lost") failure = "the helper has lost its connection to the kernel";
					else if (hello.state !== "ready") failure = `the helper is ${hello.state}`;
				} catch (error) {
					if (/another launch|protocol/.test(error.message)) failure = error.message;
				}
			}
		}
		if (identity.personPane) prompt = await personPrompt(tmux, identity);
		if ((hello?.state === "ready" && prompt === "prompt") || failure || signal?.aborted || Date.now() >= deadline) break;
		await sleep(pollMs);
	}
	return { ready: !failure && hello?.state === "ready" && prompt === "prompt", hello, prompt: prompt === "prompt", promptEnded: prompt === "ended", failure };
}

/** A session that pi-repl started for LFortran: an owner marker and the person's pane at least. */
const complete = (identity) => identity.runtime === "lfortran" && OWNER.test(identity.owner) && Boolean(identity.dir) && PANE.test(identity.personPane);

/**
 * Starts the session, or reuses the one already there; only the process that
 * wins tmux's creation of the name sets it up, and a loser never adds windows.
 * Identities are recorded as each part appears, so that a start cut short can
 * still be inspected and stopped: the owner marker, DIR and the person's
 * pane, then the helper's. Each window holds a placeholder until its pane is
 * kept after it ends; then its command replaces it. Waits up to `timeoutMs`
 * for the helper and kernel to be ready and the person's prompt to show; a
 * session that isn't confirmed by then keeps starting. Cancelling stops the
 * waiting, never a session already created.
 */
export async function startJupyterSession({
	tmux, cwd, lfortran, shell = defaultShell(), nodePath = process.execPath, helperScript = HELPER_SCRIPT,
	sessionName = LFORTRAN_SESSION_NAME, root = "/tmp", uid = process.getuid(), timeoutMs = 60_000, signal, connect,
}) {
	const deadline = Date.now() + timeoutMs;
	const warnings = [];
	let identity = await readSessionIdentity(tmux, sessionName);
	let created = false;
	if (!identity) {
		if (signal?.aborted) throw new Error(`Starting ${sessionName} was cancelled before anything was created.`);
		const owner = randomBytes(16).toString("hex");
		const dir = createSessionDir({ root, uid, owner });
		const made = await tmux(["new-session", "-d", "-P", "-F", "#{session_id}\t#{window_id}\t#{pane_id}", "-s", sessionName, "-c", cwd, PLACEHOLDER]);
		if (made.code !== 0) {
			// Lost the race, or tmux refused: the directory holds only its claim, and is ours.
			try { unlinkSync(join(dir, LAUNCH_FILE)); rmdirSync(dir); } catch {}
			identity = await readSessionIdentity(tmux, sessionName);
			if (!identity) throw new Error(`Failed to create tmux session ${sessionName}: ${made.stderr.trim() || made.stdout.trim() || `exit code ${made.code}`}`);
		} else {
			const [sessionId, personWindow, personPane] = made.stdout.trim().split("\t");
			if (!SESSION.test(sessionId) || !WINDOW.test(personWindow) || !PANE.test(personPane)) {
				throw new Error(`Could not identify the new tmux session ${sessionName}; inspect it with repl_status. It has not been stopped.`);
			}
			created = true;
			// From here the setup is finished even if the caller cancels.
			const recorded = [
				await setOption(tmux, sessionId, JUPYTER_OPTIONS.owner, owner),
				await setOption(tmux, sessionId, JUPYTER_OPTIONS.dir, dir),
				await setOption(tmux, sessionId, JUPYTER_OPTIONS.lfortran, lfortran),
				await setOption(tmux, sessionId, JUPYTER_OPTIONS.personPane, personPane),
				await setOption(tmux, sessionId, JUPYTER_OPTIONS.sendPath, JUPYTER_SEND_PATH),
				await setOption(tmux, sessionId, JUPYTER_OPTIONS.runtime, "lfortran"),
			];
			if (recorded.includes(false)) throw new Error(`Could not record the identity of ${sessionName}; it can't be verified to stop. Inspect it with tmux; it has not been stopped.`);
			if (!(await setOption(tmux, personWindow, "remain-on-exit", "on", ["-w"]))) warnings.push("Could not keep the person's pane after its prompt ends (remain-on-exit).");
			const person = await tmux(["respawn-pane", "-k", "-t", personPane, "-c", cwd, personCommand({ shell, dir, lfortran })]);
			if (person.code !== 0) throw new Error(`Could not start the person's window in ${sessionName}: ${person.stderr.trim() || `exit code ${person.code}`}. Stop the session with /repl stop lfortran.`);
			const helper = await tmux(["new-window", "-d", "-a", "-t", personWindow, "-P", "-F", "#{window_id}\t#{pane_id}", "-c", cwd, PLACEHOLDER]);
			const [helperWindow, helperPane] = helper.stdout.trim().split("\t");
			if (helper.code !== 0 || !WINDOW.test(helperWindow ?? "") || !PANE.test(helperPane ?? "")) {
				throw new Error(`Could not start the helper's window in ${sessionName}: ${helper.stderr.trim() || `exit code ${helper.code}`}. The person's window waits; stop the session with /repl stop lfortran.`);
			}
			if (!(await setOption(tmux, sessionId, JUPYTER_OPTIONS.helperPane, helperPane))) throw new Error(`Could not record the helper's pane in ${sessionName}; it can't be verified to stop. It has not been stopped.`);
			if (!(await setOption(tmux, helperWindow, "remain-on-exit", "on", ["-w"]))) warnings.push("Could not keep the helper's pane if it ends (remain-on-exit).");
			const started = await tmux(["respawn-pane", "-k", "-t", helperPane, "-c", cwd, "-e", `${JUPYTER_OWNER_ENV}=${owner}`, helperCommand({ shell, nodePath, helperScript, dir, lfortran })]);
			if (started.code !== 0) throw new Error(`Could not start the helper in ${sessionName}: ${started.stderr.trim() || `exit code ${started.code}`}. The person's window waits; stop the session with /repl stop lfortran.`);
			// The person's window stays the selected one, and the lowest-indexed.
			await tmux(["select-window", "-t", personWindow]);
			identity = await readSessionIdentity(tmux, sessionName);
			if (!identity || identity.sessionId !== sessionId) throw new Error(`${sessionName} changed while it started; it has not been stopped.`);
		}
	}
	// A creator still setting up: its identity appears as each part does.
	while (!complete(identity) && !signal?.aborted && Date.now() < deadline) {
		if (identity.runtime && identity.runtime !== "lfortran") break;
		await sleep(100);
		identity = (await readSessionIdentity(tmux, sessionName)) ?? identity;
	}
	if (!complete(identity)) {
		throw new Error(identity.runtime && identity.runtime !== "lfortran"
			? `${sessionName} exists but runs ${identity.runtime}, not LFortran; it was left alone.`
			: `${sessionName} exists but isn't a complete pi-repl LFortran session yet (no owner marker, directory or pane); it was left alone. Inspect it with repl_status.`);
	}
	const readiness = await waitForJupyterReady({ tmux, identity, deadline, signal, connect });
	return { created, reused: !created, ...identity, ...readiness, warnings };
}

/**
 * Removes a stopped session's control files from DIR, and then DIR, but only
 * the directory `expected` names ({ dev, ino }), whose launch file names
 * `owner`. DIR is first renamed to a private name beside it, and checked
 * there, so that what is removed stays bound to that directory even if its
 * path is reused meanwhile; before each removal it is checked again, and the
 * removal stops if it has changed. Only the names pi-repl and the helper
 * write are removed, only regular files and sockets of this user's, and
 * nothing is followed through a link; the launch file goes last. What is
 * left stays under the private name, since moving it back could replace a
 * directory made at DIR's path since. Resolves with warnings for what stays.
 * `hooks` let tests act between the steps.
 */
export function removeSessionDir(dir, { root = "/tmp", uid = process.getuid(), owner, expected, hooks = {} } = {}) {
	const leftAlone = [`The session's directory ${dir} isn't this session's any more (or never was); it was left alone.`];
	const owned = sessionDirOwnedBy(dir, owner, { root, uid });
	if (!owned || (expected && (owned.dev !== expected.dev || owned.ino !== expected.ino))) return leftAlone;
	hooks.beforeRename?.();
	const retiring = join(dirname(dir), `.removing-${basename(dir)}-${randomBytes(4).toString("hex")}`);
	try {
		renameSync(dir, retiring);
	} catch (error) {
		return [`Could not remove ${dir}: ${error.message}`];
	}
	hooks.taken?.(retiring);
	const same = () => {
		try {
			const stat = lstatSync(retiring);
			return stat.isDirectory() && stat.dev === owned.dev && stat.ino === owned.ino;
		} catch {
			return false;
		}
	};
	if (!same() || readLaunch(retiring, uid) !== owner) {
		// Not the directory that was checked: it is put back, untouched, if nothing is at its path
		// now, as rename would replace an empty directory there. DIR's parent is private, so only
		// this user's own processes could make one meanwhile.
		try {
			lstatSync(dir);
		} catch (error) {
			if (error.code === "ENOENT") {
				try {
					renameSync(retiring, dir);
					return leftAlone;
				} catch {}
			}
		}
		return [`The directory at ${dir} was replaced as it was being removed, and isn't this session's; it is untouched, at ${retiring}, because something is at ${dir} now or it couldn't be moved back.`];
	}
	hooks.afterRename?.(retiring);
	const warnings = [];
	const known = new Set([...Object.values(HELPER_FILES), LAUNCH_FILE]);
	const names = readdirSync(retiring).sort((a, b) => (a === LAUNCH_FILE) - (b === LAUNCH_FILE));
	for (const name of names) {
		const path = join(retiring, name);
		if (!known.has(name) && !/^out-[0-9a-f]{32}\.txt$/.test(name) && !/^\.ready-[0-9a-f]{12}$/.test(name)) {
			warnings.push(`Left ${path}: pi-repl didn't make it.`);
			continue;
		}
		if (!same()) {
			warnings.push(`${dir} changed while it was being removed; the rest was left in ${retiring}.`);
			return warnings;
		}
		const stat = lstatSync(path);
		if ((!stat.isFile() && !stat.isSocket()) || stat.uid !== uid) {
			warnings.push(`Left ${path}: it isn't a file or socket of this user's.`);
			continue;
		}
		try { unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") warnings.push(`Could not remove ${path}: ${error.message}`); }
	}
	if (warnings.length) return [`${dir} was moved to ${retiring} to be removed; what was left stays there.`, ...warnings];
	try { rmdirSync(retiring); } catch (error) { if (error.code !== "ENOENT") warnings.push(`Could not remove ${retiring}: ${error.message}`); }
	return warnings;
}

/** DIR/launch's owner marker, read without following a link, if it is a small file of this user's. */
function readLaunch(dir, uid) {
	let fd;
	try {
		fd = openSync(join(dir, LAUNCH_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.uid !== uid || stat.size > 64) return null;
		const buffer = Buffer.alloc(64);
		return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("ascii").trim();
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** A PID in a file of DIR's, read without following a link. */
function pidFile(path) {
	let fd;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const buffer = Buffer.alloc(32);
		const text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("ascii").trim();
		return /^\d+$/.test(text) && Number(text) > 1 ? Number(text) : null;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** PIDs that DIR names: helper.pid, kernel.pid, and ready.json's helper and kernel. Candidates only, never authority. */
function pidsFromDir(dir) {
	const pids = new Set();
	const marker = readReadyMarker(dir);
	for (const value of [marker?.helperPid, marker?.kernelPid, pidFile(join(dir, HELPER_FILES.pid)), pidFile(join(dir, HELPER_FILES.kernelPid))]) {
		if (Number.isSafeInteger(value) && value > 1) pids.add(value);
	}
	return pids;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A process's start time, from ps's lstart in UTC, in seconds; NaN if it can't be read. */
function startedAtSeconds(startedAt) {
	const match = /^\w{3} (\w{3})\s+(\d+) (\d\d):(\d\d):(\d\d) (\d{4})$/.exec(startedAt ?? "");
	const month = match ? MONTHS.indexOf(match[1]) : -1;
	if (!match || month < 0) return Number.NaN;
	return Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])) / 1000;
}

const MARKER_BATCH = 128;
const MAX_MARKER_CANDIDATES = 1024;

/**
 * The live processes of this user's whose initial environment carries the
 * session's owner marker, among the candidates: the PIDs DIR names, detached
 * processes running lfortran, and detached processes left without a parent
 * (adopted by PID 1) since the session was created, which is what anything
 * the kernel started becomes once the kernel has gone. The marker alone
 * authorizes; names, PIDs and times only select what is inspected.
 * `incomplete` is set if there were too many candidates to inspect.
 */
export async function findMarkedJupyterProcesses(table, { owner, dir, lfortran, uid, since, list = runCommand, readMarkers = readOwnerMarkers, snapshot = readStopProcessTable }) {
	if (!OWNER.test(owner)) throw new Error("Invalid LFortran session ownership marker.");
	const candidates = new Set(dir ? pidsFromDir(dir) : []);
	if (lfortran) {
		const listing = await list("ps", ["-axo", "pid=,uid=,comm="], { timeoutMs: 3000 });
		if (listing.code !== 0) throw new Error("Could not list processes to find the LFortran kernel; refusing unverified cleanup.");
		for (const line of listing.stdout.split("\n")) {
			const match = /^\s*(\d+)\s+(-?\d+)\s+(.+)$/.exec(line);
			if (match && Number(match[2]) === uid && basename(match[3].trim()) === basename(lfortran)) candidates.add(Number(match[1]));
		}
	}
	if (Number.isFinite(since)) {
		for (const p of table) {
			if (p.uid === uid && p.ppid === 1 && /^\?+$/.test(p.tty) && live(p) && startedAtSeconds(p.startedAt) >= since - 2) candidates.add(p.pid);
		}
	}
	const byPid = new Map(table.map((p) => [p.pid, p]));
	const inspected = [...candidates].filter((pid) => byPid.get(pid)?.uid === uid && live(byPid.get(pid)));
	const incomplete = inspected.length > MAX_MARKER_CANDIDATES;
	const rows = [];
	for (let i = 0; i < Math.min(inspected.length, MAX_MARKER_CANDIDATES); i += MARKER_BATCH) {
		rows.push(...await readMarkers(inspected.slice(i, i + MARKER_BATCH), { variable: JUPYTER_OWNER_ENV, label: "LFortran" }));
	}
	const failed = rows.filter((row) => row.error);
	if (failed.length) {
		// A process that ended, or became a zombie, while it was inspected has no metadata left; that's no failure.
		const fresh = await snapshot();
		const known = (pid) => table.find((p) => p.pid === pid);
		const unread = failed.find((row) => fresh.some((p) => p.pid === row.pid && live(p) && processKey(p) === processKey(known(row.pid))));
		if (unread) throw new Error(`Could not inspect LFortran session ownership for PID ${unread.pid}; refusing unverified cleanup.`);
	}
	return { marked: rows.filter((row) => row.owner === owner && !row.gone && !row.error).map((row) => byPid.get(row.pid)).filter(Boolean), incomplete };
}

/** The owner-marker values safe to compare inside a tmux format. */
const formatSafe = (value) => /^[A-Za-z0-9_./%@$-]*$/.test(value);

/**
 * The explicit, verified stop of an LFortran session. Its panes must be
 * exactly the pinned ones, all of them; a dead pane is accepted only as a
 * pinned one, and its stale PID is never taken as an owner. Its owner marker
 * must be its own alone. The processes are the live panes' trees, and those
 * carrying the session's marker, with their descendants: the helper and the
 * kernel, even reparented. Nothing is signalled or disconnected until that is
 * verified, twice; then tmux kills the session only if its panes and identity
 * are unchanged, the survivors get SIGTERM and SIGKILL, each revalidated, and
 * once they are gone, DIR's control files are removed if DIR is still this
 * launch's. That ends the session for every client of the kernel, outside
 * tmux too.
 */
export async function stopVerifiedJupyterSession({
	tmux, sessionName = LFORTRAN_SESSION_NAME, root = "/tmp", snapshot = readStopProcessTable, signal = (pid, value) => process.kill(pid, value),
	currentPid = process.pid, uid = process.getuid?.(), graceMs = 500, termMs = 1000, killMs = 2000, findMarked = findMarkedJupyterProcesses,
}) {
	if (typeof uid !== "number") throw new Error("Verified REPL shutdown requires a supported local Unix session.");
	const identities = await readSessionIdentities(tmux);
	const identity = identities.find((candidate) => candidate.sessionName === sessionName);
	if (!identity) throw new Error("The selected session ended or changed before shutdown; no processes were signalled.");
	if (identity.runtime !== "lfortran" || !OWNER.test(identity.owner)) {
		throw new Error(`${sessionName} has no valid LFortran ownership marker, so it can't be verified; nothing was stopped. Inspect it with tmux.`);
	}
	const owner = identity.owner;
	// Another session with this marker would make the marker ambiguous.
	const guardOwner = (current) => {
		if (current.some((other) => other.owner === owner && (other.sessionId !== identity.sessionId || other.createdAt !== identity.createdAt))) {
			throw new Error("The LFortran session's ownership marker is shared with another session; refusing ambiguous cleanup. Nothing was stopped by this check.");
		}
	};
	guardOwner(identities);
	const warnings = [];
	const dirIdentity = identity.dir ? sessionDirOwnedBy(identity.dir, owner, { root, uid }) : null;
	const dir = dirIdentity ? identity.dir : null;
	if (identity.dir && !dir) warnings.push(`The session's directory ${identity.dir} doesn't name this session's launch, or isn't private; it was neither read nor removed.`);
	const pinned = [identity.personPane, identity.helperPane].filter((pane) => PANE.test(pane));
	const sessionPanes = (panes) => panes.filter((p) => p.sessionId === identity.sessionId);
	const panes = await readPanes(tmux);
	const selected = sessionPanes(panes);
	if (!selected.length || selected.some((p) => p.sessionName !== sessionName || p.createdAt !== identity.createdAt)) {
		throw new Error("The selected session ended or changed before shutdown; no processes were signalled.");
	}
	if (selected.length !== pinned.length || selected.some((p) => !pinned.includes(p.paneId))) {
		throw new Error(`${sessionName}'s panes aren't the ones pi-repl made: some are missing, moved or added. Nothing was stopped; inspect the session with tmux.`);
	}
	const original = selected[0];
	const table = await snapshot();
	const server = table.find((p) => p.pid === original.serverPid);
	if (!live(server) || server.uid !== uid) throw new Error("Cannot verify the local tmux server owner; nothing was stopped.");
	const retained = new Set(selected.filter((p) => p.dead !== "0").map((p) => p.paneId));
	const tracker = new SessionStopProcesses({ table, panes, selected, currentPid, uid, retained, label: "LFortran" });
	const others = (currentPanes) => currentPanes.filter((p) => p.sessionId !== original.sessionId);
	let incomplete = false;
	const rememberMarked = async (currentTable, currentPanes) => {
		const found = await findMarked(currentTable, { owner, dir, lfortran: identity.lfortran, uid, since: Number(identity.createdAt) });
		incomplete ||= found.incomplete;
		tracker.rememberMarked(found.marked, currentTable, others(currentPanes));
	};
	try {
		await rememberMarked(table, panes);
		const originalFingerprint = fingerprint(selected);
		const repeatPanes = await readPanes(tmux);
		const repeatTable = await snapshot();
		const repeatIdentities = await readSessionIdentities(tmux);
		guardOwner(repeatIdentities);
		const repeatSelected = sessionPanes(repeatPanes);
		if (!repeatSelected.length || fingerprint(repeatSelected) !== originalFingerprint || !sameIdentity(identity, repeatIdentities.find((candidate) => candidate.sessionId === identity.sessionId)) ||
			!repeatTable.some((p) => processKey(p) === processKey(server)) ||
			selected.filter((pane) => pane.dead === "0").some((pane) => !repeatTable.some((p) => p.pid === pane.pid && tracker.owned.has(processKey(p))))) {
			throw new Error("Session ownership changed while preparing shutdown; nothing was stopped.");
		}
		await rememberMarked(repeatTable, repeatPanes);
		// The marker readers take time: births, panes and the marker's sole owner are checked
		// again after them, from a fresh snapshot, before tmux acts.
		const freshPanes = await readPanes(tmux);
		const freshTable = await snapshot();
		guardOwner(await readSessionIdentities(tmux));
		const freshSelected = sessionPanes(freshPanes);
		if (!freshSelected.length || fingerprint(freshSelected) !== originalFingerprint || !freshTable.some((p) => live(p) && processKey(p) === processKey(server)) ||
			selected.filter((pane) => pane.dead === "0").some((pane) => !freshTable.some((p) => live(p) && p.pid === pane.pid && tracker.owned.has(processKey(p))))) {
			throw new Error("Session ownership changed during process inspection; nothing was stopped.");
		}
		// The descendants known now stay known after their parents go and they are reparented.
		tracker.refresh(freshTable, others(freshPanes));
	} catch (error) {
		if (/nothing was stopped|no signal was sent|Nothing was stopped/.test(error.message)) throw error;
		throw new Error(`${error.message} Nothing was stopped.`, { cause: error });
	}
	// The comparison and the kill run in the same tmux command queue, so a
	// changed or replaced session can't slip between them.
	const same = [`#{==:${fingerprintFormat},${fingerprint(selected)}}`, `#{==:#{${JUPYTER_OPTIONS.owner}},${owner}}`];
	for (const key of ["dir", "personPane", "helperPane"]) if (formatSafe(identity[key])) same.push(`#{==:#{${JUPYTER_OPTIONS[key]}},${identity[key]}}`);
	const condition = same.reduce((all, next) => `#{&&:${all},${next}}`);
	const stopped = await tmux(["if-shell", "-F", "-t", original.sessionId, condition, `kill-session -t '${original.sessionId}'`, "display-message -p PI_REPL_STOP_CHANGED"]);
	if (stopped.code !== 0 || stopped.stdout.includes("PI_REPL_STOP_CHANGED")) throw new Error(`tmux refused or could not complete the stop; no follow-up signals were sent. ${stopped.stderr.trim() || stopped.stdout.trim()}`);
	async function inspect() {
		const currentPanes = await readPanes(tmux);
		const currentTable = await snapshot();
		guardOwner(await readSessionIdentities(tmux));
		const sameServer = currentTable.some((p) => processKey(p) === processKey(server));
		if (sameServer && currentPanes.some((p) => p.serverPid === original.serverPid && p.sessionId === original.sessionId && p.createdAt === original.createdAt)) throw new Error("The original tmux session still exists; no follow-up signals were sent.");
		await rememberMarked(currentTable, currentPanes);
		return tracker.refresh(currentTable, currentPanes);
	}
	// Immediately before each signal: fresh births and pane protections, and the marker still this session's alone.
	const recheck = async () => {
		const freshPanes = await readPanes(tmux);
		guardOwner(await readSessionIdentities(tmux));
		return tracker.refresh(await snapshot(), freshPanes);
	};
	let signals;
	try {
		signals = await endVerifiedSurvivors({ tracker, inspect, recheck, signal, graceMs, termMs, killMs });
	} catch (error) {
		throw new Error(`Stop requested for ${sessionName}, but runtime cleanup could not be fully verified: ${error.message} Inspect remaining processes manually; its directory${dir ? ` (${dir})` : ""} and clean records were kept.`, { cause: error });
	}
	if (incomplete) {
		warnings.push(`There were too many detached processes to inspect them all for the session's marker, so its helper, kernel or what the kernel started may still be running. Its directory (${dir ?? "unknown"}) was kept.`);
	} else if (dir) {
		warnings.push(...removeSessionDir(dir, { root, uid, owner, expected: dirIdentity }));
	}
	// `verified`: every process found ended. Not so if the search was incomplete.
	return { sessionName, processCount: tracker.owned.size, signals, warnings, dir, verified: !incomplete };
}
