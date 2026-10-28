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
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
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
 * real directories of this user's, mode 0700.
 */
export function createSessionDir({ root = "/tmp", uid = process.getuid() } = {}) {
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

/**
 * The session's identity as tmux holds it: its ID, creation time and the
 * options pi-repl set. Null if there is no such session.
 */
export async function readSessionIdentity(tmux, sessionName) {
	// list-sessions, not display-message: given a name that matches nothing, display-message prints empty fields and succeeds.
	const result = await tmux(["list-sessions", "-F", `#{session_name}\t${IDENTITY_FORMAT}`]);
	if (result.code !== 0) return null;
	const row = result.stdout.split("\n").map((line) => line.split("\t")).find((fields) => fields[0] === sessionName);
	if (!row) return null;
	const fields = row.slice(1);
	if (fields.length !== 2 + IDENTITY_KEYS.length || !SESSION.test(fields[0]) || !/^\d+$/.test(fields[1])) {
		throw new Error(`Could not read the identity of tmux session ${sessionName}.`);
	}
	const identity = { sessionName, sessionId: fields[0], createdAt: fields[1] };
	IDENTITY_KEYS.forEach((key, i) => { identity[key] = fields[2 + i]; });
	return identity;
}

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

/** Whether the person's pane shows LFortran's prompt as its last line. */
export async function promptShown(tmux, paneId) {
	const result = await tmux(["capture-pane", "-p", "-t", paneId]);
	if (result.code !== 0) return false;
	const last = result.stdout.split("\n").map((line) => line.trimEnd()).filter(Boolean).at(-1) ?? "";
	return PROMPT.test(last);
}

/**
 * Waits, until `deadline`, for both the helper's hello for this launch and
 * the person's prompt. A helper that failed ends the wait at once. The banner
 * doesn't count: only the prompt does.
 */
export async function waitForJupyterReady({ tmux, identity, deadline, signal, connect, pollMs = 150 }) {
	let hello = null;
	let prompt = false;
	let failure = null;
	for (;;) {
		if (!hello && !failure && identity.dir) {
			const marker = readReadyMarker(identity.dir);
			if (marker && marker.launchId !== identity.owner) failure = "ready.json names another launch";
			else if (marker?.state === "failed") failure = typeof marker.reason === "string" ? marker.reason : "the helper failed to start";
			else if (marker?.state === "ready") {
				try {
					hello = await helloFrom(identity, { connect });
				} catch (error) {
					if (/another launch|protocol/.test(error.message)) failure = error.message;
				}
			}
		}
		if (!prompt && identity.personPane) prompt = await promptShown(tmux, identity.personPane);
		if ((hello && prompt) || failure || signal?.aborted || Date.now() >= deadline) break;
		await sleep(pollMs);
	}
	return { ready: Boolean(hello && prompt), hello, prompt, failure };
}

/** A session that pi-repl started for LFortran: an owner marker and the person's pane at least. */
const complete = (identity) => identity.runtime === "lfortran" && OWNER.test(identity.owner) && Boolean(identity.dir) && PANE.test(identity.personPane);

/**
 * Starts the session, or reuses the one already there; only the process that
 * wins tmux's creation of the name sets it up, and a loser never adds windows.
 * Identities are recorded as each part appears, so that a start cut short can
 * still be inspected and stopped: the owner marker, DIR and the person's
 * pane, then the helper's. Waits up to `timeoutMs` for the helper's hello and
 * the person's prompt; a session that isn't confirmed by then keeps starting.
 * Cancelling stops the waiting, never a session already created.
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
		const dir = createSessionDir({ root, uid });
		const owner = randomBytes(16).toString("hex");
		const made = await tmux(["new-session", "-d", "-P", "-F", "#{session_id}\t#{window_id}\t#{pane_id}", "-s", sessionName, "-c", cwd, personCommand({ shell, dir, lfortran })]);
		if (made.code !== 0) {
			// Lost the race, or tmux refused: the directory is empty and ours.
			try { rmdirSync(dir); } catch {}
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
			// The waiter waits for the helper, so nothing in the pane ends before this is set.
			const kept = await setOption(tmux, personWindow, "remain-on-exit", "on", ["-w"]);
			if (recorded.includes(false)) throw new Error(`Could not record the identity of ${sessionName}; it can't be verified to stop. Inspect it with tmux; it has not been stopped.`);
			if (!kept) warnings.push("Could not keep the person's pane after its prompt ends (remain-on-exit).");
			const helper = await tmux(["new-window", "-d", "-a", "-t", personWindow, "-P", "-F", "#{window_id}\t#{pane_id}", "-c", cwd, "-e", `${JUPYTER_OWNER_ENV}=${owner}`, helperCommand({ shell, nodePath, helperScript, dir, lfortran })]);
			const [helperWindow, helperPane] = helper.stdout.trim().split("\t");
			if (helper.code !== 0 || !WINDOW.test(helperWindow ?? "") || !PANE.test(helperPane ?? "")) {
				throw new Error(`Could not start the helper's window in ${sessionName}: ${helper.stderr.trim() || `exit code ${helper.code}`}. The person's window waits; stop the session with /repl stop lfortran.`);
			}
			if (!(await setOption(tmux, helperWindow, "remain-on-exit", "on", ["-w"]))) warnings.push("Could not keep the helper's pane if it ends (remain-on-exit).");
			if (!(await setOption(tmux, sessionId, JUPYTER_OPTIONS.helperPane, helperPane))) throw new Error(`Could not record the helper's pane in ${sessionName}; it can't be verified to stop. It has not been stopped.`);
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
 * Removes a stopped session's control files from DIR, and then DIR: only the
 * names the helper writes, and only regular files and sockets of this user's;
 * nothing is followed through a link. Resolves with warnings for what stays.
 */
export function removeSessionDir(dir, { root = "/tmp", uid = process.getuid() } = {}) {
	if (!validSessionDir(dir, { root, uid })) return [`The session's directory ${dir} isn't one pi-repl made, or isn't private any more; it was left alone.`];
	const warnings = [];
	const known = new Set(Object.values(HELPER_FILES));
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (!known.has(name) && !/^out-[0-9a-f]{32}\.txt$/.test(name) && !/^\.ready-[0-9a-f]{12}$/.test(name)) {
			warnings.push(`Left ${path}: pi-repl didn't make it.`);
			continue;
		}
		const stat = lstatSync(path);
		if ((!stat.isFile() && !stat.isSocket()) || stat.uid !== uid) {
			warnings.push(`Left ${path}: it isn't a file or socket of this user's.`);
			continue;
		}
		try { unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") warnings.push(`Could not remove ${path}: ${error.message}`); }
	}
	try { rmdirSync(dir); } catch (error) { if (error.code !== "ENOENT") warnings.push(`Could not remove ${dir}: ${error.message}`); }
	return warnings;
}

/** PIDs that DIR names: helper.pid, and ready.json's helper and kernel. Candidates only, never authority. */
function pidsFromDir(dir) {
	const pids = new Set();
	const marker = readReadyMarker(dir);
	for (const value of [marker?.helperPid, marker?.kernelPid]) if (Number.isSafeInteger(value) && value > 1) pids.add(value);
	let fd;
	try {
		fd = openSync(join(dir, HELPER_FILES.pid), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const buffer = Buffer.alloc(32);
		const text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("ascii").trim();
		if (/^\d+$/.test(text) && Number(text) > 1) pids.add(Number(text));
	} catch {
		// No helper.pid: the helper never claimed DIR.
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	return pids;
}

/**
 * The live processes of this user's whose initial environment carries the
 * session's owner marker, among the candidates: the PIDs DIR names, and
 * detached processes running lfortran. The marker alone authorizes; names and
 * PIDs only select what is inspected.
 */
export async function findMarkedJupyterProcesses(table, { owner, dir, lfortran, uid, list = runCommand, readMarkers = readOwnerMarkers, snapshot = readStopProcessTable }) {
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
	const inspected = [...candidates].filter((pid) => table.some((p) => p.pid === pid && p.uid === uid && live(p)));
	const rows = await readMarkers(inspected, { variable: JUPYTER_OWNER_ENV, label: "LFortran" });
	const failed = rows.filter((row) => row.error);
	if (failed.length) {
		// A process that ended, or became a zombie, while it was inspected has no metadata left; that's no failure.
		const fresh = await snapshot();
		const known = (pid) => table.find((p) => p.pid === pid);
		const unread = failed.find((row) => fresh.some((p) => p.pid === row.pid && live(p) && processKey(p) === processKey(known(row.pid))));
		if (unread) throw new Error(`Could not inspect LFortran session ownership for PID ${unread.pid}; refusing unverified cleanup.`);
	}
	return rows.filter((row) => row.owner === owner && !row.gone && !row.error).map((row) => table.find((p) => p.pid === row.pid)).filter(Boolean);
}

/**
 * The explicit, verified stop of an LFortran session. Its panes must be
 * exactly the pinned ones; a dead pane is accepted only as a pinned one, and
 * its stale PID is never taken as an owner. The processes are the live panes'
 * trees, and those carrying the session's owner marker: the helper and the
 * kernel, even reparented. Nothing is signalled or disconnected until that is
 * verified, twice; then tmux kills the session only if nothing changed, the
 * survivors get SIGTERM and SIGKILL, each revalidated, and once they are
 * gone, DIR's control files are removed. That ends the session for every
 * client of the kernel, outside tmux too.
 */
export async function stopVerifiedJupyterSession({
	tmux, sessionName = LFORTRAN_SESSION_NAME, root = "/tmp", snapshot = readStopProcessTable, signal = (pid, value) => process.kill(pid, value),
	currentPid = process.pid, uid = process.getuid?.(), graceMs = 500, termMs = 1000, killMs = 2000, findMarked = findMarkedJupyterProcesses,
}) {
	if (typeof uid !== "number") throw new Error("Verified REPL shutdown requires a supported local Unix session.");
	const identity = await readSessionIdentity(tmux, sessionName);
	if (!identity) throw new Error("The selected session ended or changed before shutdown; no processes were signalled.");
	if (identity.runtime !== "lfortran" || !OWNER.test(identity.owner)) {
		throw new Error(`${sessionName} has no valid LFortran ownership marker, so it can't be verified; nothing was stopped. Inspect it with tmux.`);
	}
	const owner = identity.owner;
	const warnings = [];
	const dir = identity.dir && validSessionDir(identity.dir, { root, uid }) ? identity.dir : null;
	if (identity.dir && !dir) warnings.push(`The session's directory ${identity.dir} isn't one pi-repl made, or isn't private any more; it was neither read nor removed.`);
	const pinned = new Set([identity.personPane, identity.helperPane].filter((pane) => PANE.test(pane)));
	const sessionPanes = (panes) => panes.filter((p) => p.sessionId === identity.sessionId);
	const panes = await readPanes(tmux);
	const selected = sessionPanes(panes);
	if (!selected.length || selected.some((p) => p.sessionName !== sessionName || p.createdAt !== identity.createdAt)) {
		throw new Error("The selected session ended or changed before shutdown; no processes were signalled.");
	}
	if (selected.some((p) => !pinned.has(p.paneId))) {
		throw new Error(`${sessionName} has panes that pi-repl didn't make; nothing was stopped. Close them, or inspect the session with tmux.`);
	}
	const original = selected[0];
	const table = await snapshot();
	const server = table.find((p) => p.pid === original.serverPid);
	if (!live(server) || server.uid !== uid) throw new Error("Cannot verify the local tmux server owner; nothing was stopped.");
	const retained = new Set(selected.filter((p) => p.dead !== "0").map((p) => p.paneId));
	const tracker = new SessionStopProcesses({ table, panes, selected, currentPid, uid, retained, label: "LFortran" });
	const others = (currentPanes) => currentPanes.filter((p) => p.sessionId !== original.sessionId);
	const rememberMarked = async (currentTable, currentPanes) => {
		const marked = await findMarked(currentTable, { owner, dir, lfortran: identity.lfortran, uid });
		tracker.rememberMarked(marked, currentTable, others(currentPanes));
	};
	try {
		await rememberMarked(table, panes);
		const originalFingerprint = fingerprint(selected);
		const repeatPanes = await readPanes(tmux);
		const repeatTable = await snapshot();
		const repeatIdentity = await readSessionIdentity(tmux, sessionName);
		const repeatSelected = sessionPanes(repeatPanes);
		if (!repeatSelected.length || fingerprint(repeatSelected) !== originalFingerprint || repeatIdentity?.owner !== owner || repeatIdentity.sessionId !== identity.sessionId ||
			!repeatTable.some((p) => processKey(p) === processKey(server)) ||
			selected.filter((pane) => pane.dead === "0").some((pane) => !repeatTable.some((p) => p.pid === pane.pid && tracker.owned.has(processKey(p))))) {
			throw new Error("Session ownership changed while preparing shutdown; nothing was stopped.");
		}
		await rememberMarked(repeatTable, repeatPanes);
	} catch (error) {
		if (/nothing was stopped|no signal was sent/.test(error.message)) throw error;
		throw new Error(`${error.message} Nothing was stopped.`, { cause: error });
	}
	// The comparison and the kill run in the same tmux command queue, so a
	// changed or replaced session can't slip between them.
	const condition = `#{&&:#{==:${fingerprintFormat},${fingerprint(selected)}},#{==:#{${JUPYTER_OPTIONS.owner}},${owner}}}`;
	const stopped = await tmux(["if-shell", "-F", "-t", original.sessionId, condition, `kill-session -t '${original.sessionId}'`, "display-message -p PI_REPL_STOP_CHANGED"]);
	if (stopped.code !== 0 || stopped.stdout.includes("PI_REPL_STOP_CHANGED")) throw new Error(`tmux refused or could not complete the stop; no follow-up signals were sent. ${stopped.stderr.trim() || stopped.stdout.trim()}`);
	async function inspect() {
		const currentPanes = await readPanes(tmux);
		const currentTable = await snapshot();
		const sameServer = currentTable.some((p) => processKey(p) === processKey(server));
		if (sameServer && currentPanes.some((p) => p.serverPid === original.serverPid && p.sessionId === original.sessionId && p.createdAt === original.createdAt)) throw new Error("The original tmux session still exists; no follow-up signals were sent.");
		await rememberMarked(currentTable, currentPanes);
		return tracker.refresh(currentTable, currentPanes);
	}
	const recheck = async () => tracker.refresh(await snapshot(), await readPanes(tmux));
	let signals;
	try {
		signals = await endVerifiedSurvivors({ tracker, inspect, recheck, signal, graceMs, termMs, killMs });
	} catch (error) {
		throw new Error(`Stop requested for ${sessionName}, but runtime cleanup could not be fully verified: ${error.message} Inspect remaining processes manually; its directory${dir ? ` (${dir})` : ""} and clean records were kept.`, { cause: error });
	}
	if (dir) warnings.push(...removeSessionDir(dir, { root, uid }));
	return { sessionName, processCount: tracker.owned.size, signals, warnings, dir };
}
