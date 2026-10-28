// pi-repl's lfortran runtime: what its tools and commands do with the shared
// LFortran session, through the session's helper (repl-jupyter-session.js,
// repl-jupyter-helper.js). Each function resolves with { text, details } for
// the host to bound and show; `tmux(args)` resolves with { code, stdout, stderr }.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { HELPER_FILES, HELPER_PROTOCOL_VERSION, HelperClient } from "./repl-jupyter-helper.js";
import { LFORTRAN_SESSION_NAME, defaultShell, personPrompt, preflightLfortran, readReadyMarker, readSessionIdentity, runCommand, startJupyterSession, stopVerifiedJupyterSession } from "./repl-jupyter-session.js";

/** @typedef {(args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} Tmux */

const TERMINAL = new Set(["completed", "unconfirmed", "not-sent"]);
const OWNER = /^[0-9a-f]{32}$/;
const ATTACH = `tmux attach -t ${LFORTRAN_SESSION_NAME}`;
const STOP = "/repl stop lfortran (agent-repl stop lfortran outside Pi)";
const MAX_HELPER_WAIT_MS = 10 * 60 * 1000;

/** The lines the tools' guidance adds for LFortran. */
export const LFORTRAN_GUIDELINES = [
	"For LFortran use target='lfortran': LFortran's shared session, which the person joins with LFortran's own prompt. Send complete Fortran: declarations, statements, or whole program units. Its cells run one at a time, and only one of yours can be unresolved at once.",
	"In LFortran, a runtime error (an out-of-bounds index, `error stop`) ends the session for everyone, and nothing can interrupt a cell. A plain READ waits for its answer, given with repl_input, and ends the session if it gets end of file: prefer `iostat=` in READs.",
];

const lookup = (id) => `repl_status target='lfortran' execution='${id}'`;
const cancelled = (what) => new Error(`Cancelled before anything was sent: ${what}`);
const noSession = () => `No shared LFortran session is running (${LFORTRAN_SESSION_NAME}). Start one with repl_start runtime='lfortran', or /repl lfortran.`;

/**
 * Starts the session, or reuses the one running, and waits for the helper's
 * hello and LFortran's prompt. Only a new session needs lfortran found.
 * @param {{ tmux: Tmux, cwd: string, timeoutMs?: number, signal?: AbortSignal, shell?: string, run?: typeof runCommand }} options
 */
export async function startLfortranRuntime({ tmux, cwd, timeoutMs = 30_000, signal, shell = defaultShell(), run = runCommand }) {
	const existing = await readSessionIdentity(tmux, LFORTRAN_SESSION_NAME);
	const preflight = existing ? null : await preflightLfortran({ shell, cwd, run });
	const started = await startJupyterSession({ tmux, cwd, lfortran: preflight?.path ?? existing.lfortran, shell, timeoutMs, signal });
	const lines = [
		started.created ? `Started the shared LFortran session: ${LFORTRAN_SESSION_NAME}` : `The shared LFortran session is already running; reused without restarting it (${LFORTRAN_SESSION_NAME}).`,
		...(preflight ? [`LFortran: ${preflight.version || "version unknown"} (${preflight.path}).`] : []),
		"The person's window, the session's first, is LFortran's own prompt (lfortran --connect); the kernel and pi-repl's helper run in the second.",
		started.ready ? "Readiness: the helper and kernel are ready, and LFortran's prompt is shown." : started.failure ? `The session isn't usable: ${started.failure}. Stop it with ${STOP}.` : `Readiness: not confirmed within ${timeoutMs} ms (helper and kernel: ${started.hello?.state === "ready" ? "ready" : "not yet"}; the person's prompt: ${started.prompt ? "shown" : started.promptEnded ? "ended" : "not yet"}). The session keeps starting; check repl_status target='lfortran'.`,
		...started.warnings.map((warning) => `Warning: ${warning}`),
		`Attach: ${ATTACH}`,
	];
	return {
		text: lines.join("\n"),
		details: {
			runtime: "lfortran", sessionName: LFORTRAN_SESSION_NAME, created: started.created, reused: started.reused, ready: started.ready,
			helper: Boolean(started.hello), prompt: started.prompt, failure: started.failure, timeoutMs, attachCommand: ATTACH, warnings: started.warnings,
			...(preflight ? { lfortran: preflight.path, version: preflight.version } : {}),
		},
	};
}

/** Why the helper doesn't answer, as ready.json says if it can. */
function helperUnavailable(identity, error) {
	const marker = identity.dir ? readReadyMarker(identity.dir) : null;
	if (marker?.launchId === identity.owner && marker.state === "failed") return `The LFortran session couldn't start: ${marker.reason}. Stop it with ${STOP}.`;
	return `The LFortran session's helper isn't answering (${error?.message ?? "no answer"}), so cells can't be sent; nothing was sent. It may still be starting, or it has ended: check repl_status target='lfortran', or stop the session with ${STOP}.`;
}

/** The session's helper, as this launch's: { identity, client, hello }. Throws a message for the agent if there's none. */
async function connectHelper(tmux, signal, what) {
	if (signal?.aborted) throw cancelled(what);
	const identity = await readSessionIdentity(tmux, LFORTRAN_SESSION_NAME);
	if (!identity) throw new Error(noSession());
	if (identity.runtime !== "lfortran" || !OWNER.test(identity.owner) || !identity.dir) {
		throw new Error(`${LFORTRAN_SESSION_NAME} isn't a complete pi-repl LFortran session; it was left alone. Check it with repl_status target='lfortran'.`);
	}
	let client;
	try {
		client = await HelperClient.connect(join(identity.dir, HELPER_FILES.socket), { timeoutMs: 3000 });
	} catch (error) {
		throw new Error(helperUnavailable(identity, error));
	}
	try {
		const hello = await client.request("hello", {}, { timeoutMs: 3000 });
		if (hello?.protocol !== HELPER_PROTOCOL_VERSION) throw new Error(`The session's helper speaks protocol ${hello?.protocol}, not ${HELPER_PROTOCOL_VERSION} (pi-repl was upgraded while it ran); nothing was sent. Restart the session to use it.`);
		if (hello.launchId !== identity.owner) throw new Error("The helper on the session's socket isn't this session's; nothing was sent.");
		return { identity, client, hello };
	} catch (error) {
		client.close();
		throw error;
	}
}

/**
 * Waits for the execution's next state that the agent acts on: settled, or
 * waiting for input. Gives up waiting at `deadline` or on `signal`; the cell
 * goes on regardless.
 */
async function waitForTransition(client, snapshot, { deadline, signal }) {
	while (!TERMINAL.has(snapshot.state) && snapshot.state !== "waiting-input") {
		const remaining = deadline - Date.now();
		if (remaining <= 0 || signal?.aborted) return { ...snapshot, timedOut: true };
		let onAbort;
		const aborted = new Promise((resolve) => {
			onAbort = () => resolve(null);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		let next;
		try {
			next = await Promise.race([client.request("wait", { executionId: snapshot.executionId, since: snapshot.version, timeoutMs: Math.min(remaining, MAX_HELPER_WAIT_MS) }, { timeoutMs: remaining + 5000 }), aborted]);
		} catch (error) {
			// The cell was taken; only the waiting failed. What is known so far stands.
			return { ...snapshot, waitFailed: error.message };
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
		if (!next) return { ...snapshot, timedOut: true };
		snapshot = next;
	}
	return snapshot;
}

/** What an unconfirmed outcome establishes, and what it doesn't. */
function describeUnconfirmed(outcome) {
	const exit = outcome.exit ? (outcome.exit.signal ? `signal ${outcome.exit.signal}` : `status ${outcome.exit.code}`) : null;
	const started = outcome.started ? "It had started." : "There's no evidence it started (no execute_input came), but it may have run.";
	if (exit) {
		return [`Outcome unconfirmed: the kernel exited (${exit}) before the cell's result was confirmed. ${started} What it received is below.`,
			`The kernel has ended, so the session is over for everyone. Stop it with ${STOP}, and start a new one; nothing was resent.`];
	}
	if (outcome.kind === "invalid-reply") {
		return [`Outcome unconfirmed: ${outcome.reason}, so whether it succeeded isn't known. What it received is below.`, "The session may still be usable; check repl_status target='lfortran'."];
	}
	if (outcome.kind === "helper-stopped") {
		return [`Outcome unconfirmed: pi-repl's helper stopped before the cell's result came. ${started}`, "Whether the kernel goes on isn't known to pi-repl; check repl_status target='lfortran'."];
	}
	return [`Outcome unconfirmed: ${outcome.reason ?? "the helper's connection to the kernel ended"}. ${started} What it received is below.`,
		"Whether the kernel and the person's prompt are still running isn't known; pi-repl can't send to this session any more. Check repl_status target='lfortran' before stopping it: stopping ends it for everyone."];
}

/** The output's last words: how much of it is here, and where the rest is. */
function describeSpool(output) {
	const spool = output.spool;
	if (!spool) return "[Output truncated in memory; the rest wasn't kept.]";
	if (spool.state === "writing") return `[Output truncated in memory. The rest is still being written to ${spool.path}.]`;
	if (spool.full) return `[Output truncated in memory. The full received output is in ${spool.path} while the session runs.]`;
	if (spool.state === "complete") return `[Output truncated in memory. Part of the rest is in ${spool.path}; ${spool.capped ? "the file reached its size limit" : "the disk fell behind"}, so it isn't all there.]`;
	return `[Output truncated in memory; writing the rest to a file failed (${spool.error ?? "unknown error"}).]`;
}

/** A cell's state and output, for the agent: what happened, what to do next, then the output. */
export function formatExecution(snapshot, { code, timeoutMs } = {}) {
	const lines = [];
	const outcome = snapshot.outcome ?? {};
	if (snapshot.state === "completed" && snapshot.status === "aborted") {
		lines.push("Not run: a cell before it failed, so LFortran skipped it (stop_on_error).");
	} else if (snapshot.state === "completed") {
		lines.push(snapshot.status === "error" ? "Completed, with an error (see the output)." : "Completed.");
	} else if (snapshot.state === "unconfirmed") {
		lines.push(...describeUnconfirmed(outcome));
	} else if (snapshot.state === "not-sent") {
		lines.push(`Not sent: ${outcome.reason ?? "the helper refused it"}. Nothing ran.`);
	} else if (snapshot.state === "waiting-input") {
		const input = snapshot.input ?? {};
		lines.push(`Waiting for input: the cell's READ asks ${JSON.stringify(input.prompt ?? "")}${input.password ? " (a password)" : ""}.`);
		lines.push(`Answer it with repl_input token='${input.token}' and text set to one line; it waits for its answer, however long. Don't answer what you don't know: ask the person.`);
	} else if (snapshot.waitFailed) {
		lines.push(`The cell was taken (it is ${snapshot.state}), but waiting for it failed: ${snapshot.waitFailed}. It isn't resent; look it up with ${lookup(snapshot.executionId)}.`);
	} else if (timeoutMs === undefined) {
		lines.push(`${snapshot.state === "submitted" ? "Waiting to run" : "Running"}; it goes on, and nothing interrupts an LFortran cell. Look it up again with ${lookup(snapshot.executionId)}.`);
	} else {
		lines.push(`Still ${snapshot.state === "submitted" ? "waiting to run" : "running"} after ${Math.round(timeoutMs / 1000)} s. It goes on: nothing interrupts an LFortran cell, and it isn't resent. Look it up with ${lookup(snapshot.executionId)}.`);
	}
	lines.push(`Execution: ${snapshot.executionId}`);
	if (code !== undefined) lines.push("", "Submitted code:", code.trimEnd());
	const output = snapshot.output ?? {};
	lines.push("", "Output:", output.text ? output.text.replace(/\n$/, "") : "(no output)");
	if (output.truncated) lines.push(describeSpool(output));
	return lines.join("\n");
}

function executionDetails(snapshot, identity) {
	return {
		runtime: "lfortran", sessionName: LFORTRAN_SESSION_NAME, lifetimeId: snapshot.lifetimeId ?? null, executionId: snapshot.executionId, submissionId: snapshot.submissionId,
		state: snapshot.state, status: snapshot.status ?? null, timedOut: Boolean(snapshot.timedOut), outcome: snapshot.outcome ?? null,
		input: snapshot.input ? { token: snapshot.input.token, prompt: snapshot.input.prompt } : null,
		outputPath: snapshot.output?.spool?.full ? snapshot.output.spool.path : null, outputTruncated: Boolean(snapshot.output?.truncated),
		outputWriting: snapshot.output?.spool?.state === "writing" ? snapshot.output.spool.path : null,
		kernelSession: identity?.kernelSession ?? null,
	};
}

/**
 * Sends a cell and waits up to `timeoutMs` for it to settle or to ask for
 * input. A wait that runs out leaves the cell running; nothing is resent.
 * Resolves with the result's text, its details, and the output it holds.
 * @param {{ tmux: Tmux, code: string, timeoutMs?: number, signal?: AbortSignal, label?: string, ownerKey?: string }} options
 */
export async function sendLfortranCode({ tmux, code, timeoutMs = 20_000, signal, label = "", ownerKey = "" }) {
	if (typeof code !== "string" || !code.trim()) throw new Error("There's no LFortran code to send.");
	const deadline = Date.now() + timeoutMs;
	const { client, hello } = await connectHelper(tmux, signal, "the cell wasn't sent.");
	try {
		const submissionId = `pi-${randomBytes(12).toString("hex")}`;
		// After this, cancelling only stops the waiting.
		if (signal?.aborted) throw cancelled("the cell wasn't sent.");
		let snapshot;
		try {
			snapshot = await client.request("execute", { lifetimeId: hello.lifetimeId, submissionId, code, label, ownerKey }, { timeoutMs: 10_000 });
		} catch (error) {
			if (error.code === "busy") throw new Error(`Another LFortran cell is still unresolved (execution ${error.details?.executionId}, ${error.details?.state}); nothing was sent. Wait for it: look it up with ${lookup(error.details?.executionId)}${error.details?.state === "waiting-input" ? ", and answer its READ with repl_input" : ""}.`);
			if (error.code === "not-accepting") throw new Error(`The LFortran session isn't taking cells: ${error.details?.state === "kernel-exited" ? "its kernel has exited" : error.details?.state ?? error.message}. Nothing was sent. Stop it with ${STOP}, and start a new one.`);
			if (error.code) throw new Error(`The LFortran session refused the cell: ${error.message}`);
			// The request may have been written before the connection failed; never resend it.
			throw new Error(`The connection to the LFortran session's helper failed while sending (${error.message}). The cell may or may not have been taken; it won't be resent. Look it up with ${lookup(submissionId)}.`);
		}
		snapshot = await waitForTransition(client, snapshot, { deadline, signal });
		return { text: formatExecution(snapshot, { code, timeoutMs }), details: { ...executionDetails({ ...snapshot, lifetimeId: hello.lifetimeId }, hello), submittedCode: code, ...(snapshot.waitFailed ? { waitFailed: snapshot.waitFailed } : {}) }, output: snapshot.output?.text ?? "" };
	} finally {
		client.close();
	}
}

/**
 * Answers the current cell's READ with one record, and waits for what comes
 * next: its result, its next READ, or the end of the wait. Resolves as
 * sendLfortranCode does. With `waiting`, as for the person's /repl input,
 * the token may be left out to answer the READ that waits now, and the
 * details say whether that READ asked for a password.
 * @param {{ tmux: Tmux, token?: string, text: string, waiting?: boolean, timeoutMs?: number, signal?: AbortSignal }} options
 */
export async function answerLfortranInput({ tmux, token, text, waiting = false, timeoutMs = 20_000, signal }) {
	if (!waiting && (typeof token !== "string" || !token)) throw new Error("repl_input needs the token that the READ's result gave.");
	const deadline = Date.now() + timeoutMs;
	const { client, hello } = await connectHelper(tmux, signal, "the answer wasn't given, and the READ still waits.");
	try {
		if (signal?.aborted) throw cancelled("the answer wasn't given, and the READ still waits.");
		let password;
		if (waiting) {
			let pending;
			try {
				pending = (await client.request("status", {}, { timeoutMs: 3000 })).current?.input;
			} catch (error) {
				throw new Error(`The LFortran session's helper didn't say which READ waits (${error.message}). Nothing was sent.`);
			}
			if (!token && !pending) throw new Error("No READ from pi-repl is waiting in the LFortran session, so nothing was sent.");
			token ||= pending.token;
			password = pending?.token === token ? Boolean(pending.password) : null;
		}
		let snapshot;
		try {
			snapshot = await client.request("input", { lifetimeId: hello.lifetimeId, token, text }, { timeoutMs: 10_000 });
		} catch (error) {
			if (error.code === "invalid-token") throw new Error("That token doesn't answer a READ that is waiting: it was used already, or its cell has ended. Nothing was sent. Check repl_status target='lfortran'.");
			if (error.code === "invalid-input") throw new Error(`${error.message} Nothing was sent; the READ still waits for its token.`);
			if (error.code === "input-not-sent") throw new Error(`${error.message} The READ still waits for its token.`);
			if (error.code) throw new Error(`The LFortran session refused the answer: ${error.message}`);
			throw new Error(`The connection to the LFortran session's helper failed while answering (${error.message}), so whether the answer arrived isn't known. Check repl_status target='lfortran' before answering again: if the READ still waits with this token, the answer didn't arrive. If it doesn't, that alone doesn't show the answer arrived (the kernel may have ended, for one); the cell's state there says what is known.`);
		}
		snapshot = await waitForTransition(client, snapshot, { deadline, signal });
		const details = executionDetails({ ...snapshot, lifetimeId: hello.lifetimeId }, hello);
		return { text: formatExecution(snapshot, { timeoutMs }), details: waiting ? { ...details, answeredPassword: password } : details, output: snapshot.output?.text ?? "" };
	} finally {
		client.close();
	}
}

/**
 * The session's state: the person's prompt, the helper and kernel, and the
 * latest cell from pi-repl; or, given `execution` (an execution or
 * submission ID), that cell exactly.
 * @param {{ tmux: Tmux, execution?: string }} options
 */
export async function lfortranStatus({ tmux, execution }) {
	const identity = await readSessionIdentity(tmux, LFORTRAN_SESSION_NAME);
	if (!identity) return { text: noSession(), details: { runtime: "lfortran", sessionName: LFORTRAN_SESSION_NAME, running: false } };
	if (execution) {
		const { client } = await connectHelper(tmux);
		try {
			const found = await client.request("lookup", /^[0-9a-f]{32}$/.test(execution) ? { executionId: execution } : { submissionId: execution }, { timeoutMs: 3000 });
			return { text: formatExecution(found), details: { runtime: "lfortran", sessionName: LFORTRAN_SESSION_NAME, running: true, execution: executionDetails(found) } };
		} catch (error) {
			if (error.code === "unknown-execution") throw new Error(`No cell with that ID reached this LFortran session (${execution}); if a send failed before the helper took it, it didn't run here.`);
			if (error.code === "expired") throw new Error(`This session no longer keeps that cell's output; its last state was ${error.details?.state}${error.details?.status ? ` (${error.details.status})` : ""}. It won't be run again.`);
			throw error;
		} finally {
			client.close();
		}
	}
	const prompt = await personPrompt(tmux, identity);
	const lines = [`Shared LFortran session: ${LFORTRAN_SESSION_NAME}.`];
	lines.push(prompt === "gone" ? "- The person's prompt: its pane is gone." : prompt === "ended"
		? `- The person's prompt has ended; its pane is kept. They can rejoin with: lfortran --connect ${join(identity.dir, HELPER_FILES.connection)}`
		: `- The person's prompt: ${prompt === "prompt" ? "at LFortran's prompt" : "busy, or not at its prompt"} (the session's first window).`);
	let status = null;
	try {
		const { client } = await connectHelper(tmux);
		try { status = await client.request("status", {}, { timeoutMs: 3000 }); } finally { client.close(); }
	} catch (error) {
		lines.push(`- The helper: ${error.message}`);
	}
	if (status) {
		const exit = status.kernel?.exit;
		if (status.state === "ready") lines.push(`- The helper and kernel: ready (kernel PID ${status.kernel?.pid}).`);
		else if (status.state === "kernel-exited") lines.push(`- The kernel has exited (${exit?.signal ? `signal ${exit.signal}` : `status ${exit?.code}`}): the session is over for everyone. Stop it with ${STOP}.`);
		else if (status.state === "connection-lost") lines.push(`- The helper lost its connection to the kernel, so pi-repl can't send to this session any more. Whether the kernel and the person's prompt still run isn't known; stopping it with ${STOP} ends it for everyone.`);
		else lines.push(`- The helper: ${status.state}.`);
		for (const warning of status.warnings ?? []) lines.push(`- Warning: ${warning.message}`);
		if (status.current) lines.push("", "The latest cell from pi-repl:", formatExecution(status.current));
	}
	lines.push("", `Attach: ${ATTACH}`);
	return {
		text: lines.join("\n"),
		details: {
			runtime: "lfortran", sessionName: LFORTRAN_SESSION_NAME, running: true, personPrompt: prompt,
			helper: status ? status.state : "unavailable", kernel: status?.kernel ?? null, current: status?.current ? executionDetails(status.current, status) : null, attachCommand: ATTACH,
		},
	};
}

/**
 * The verified stop, as the person asked for it.
 * @param {{ tmux: Tmux, stop?: typeof stopVerifiedJupyterSession }} options
 */
export async function stopLfortranSession({ tmux, stop = stopVerifiedJupyterSession }) {
	const identity = await readSessionIdentity(tmux, LFORTRAN_SESSION_NAME);
	if (!identity) return { text: noSession(), details: { stopped: false, warnings: [] } };
	const result = await stop({ tmux });
	const cleaned = result.signals.length ? ` Cleaned up ${new Set(result.signals.map((entry) => entry.pid)).size} surviving process(es).` : "";
	const said = result.verified
		? `Stopped the shared LFortran session: ${LFORTRAN_SESSION_NAME}. Its prompt, helper and kernel exited, which ends the session for every client of the kernel.${cleaned}`
		: `Partly stopped the shared LFortran session: the tmux session ${LFORTRAN_SESSION_NAME} was removed, and the processes pi-repl found have ended${result.signals.length ? ` (${new Set(result.signals.map((entry) => entry.pid)).size} after a signal)` : ""}. It couldn't confirm that the session's helper and kernel ended too: check for them before starting a new one.`;
	return {
		text: `${said}${result.warnings.length ? `\n${result.warnings.join("\n")}` : ""}`,
		details: { stopped: true, ...result },
	};
}
