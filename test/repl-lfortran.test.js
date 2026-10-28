// The lfortran runtime through pi-repl's own tools and /repl command, against
// an isolated tmux server and the fake lfortran, or PI_REPL_LFORTRAN.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { answerLfortranInput, formatExecution, lfortranStatus } from "../shared/repl-lfortran.js";
import { REAL_LFORTRAN, defer, lfortranFixture, until } from "./helpers/repl-test-lfortran.js";

const exec = promisify(execFile);
const TOKEN = /token='([0-9a-f]{32})'/;

/** pi-repl registered against the fixture: tmux goes to its server, other commands run in its environment. */
async function piFixture(t, options = {}) {
	const f = lfortranFixture(t, options);
	if (!f) return null;
	const tools = new Map(), commands = new Map(), notifications = [], messages = [];
	const pi = {
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: (name, definition) => commands.set(name, definition),
		on() {},
		sendMessage: (message, options) => messages.push({ message, options }),
		async exec(command, args, execOptions = {}) {
			if (command === "tmux") {
				assert.equal(args[0], "-u", `tmux without -u: ${args.join(" ")}`);
				args = args.slice(1);
			}
			try {
				const runOptions = { cwd: execOptions.cwd, env: f.env, timeout: execOptions.timeout, maxBuffer: 8 * 1024 * 1024 };
				const result = command === "tmux" ? await f.harness.run(args, runOptions) : await exec(command, args, runOptions);
				return { ...result, code: 0, killed: false };
			} catch (error) {
				return { stdout: error.stdout || "", stderr: error.stderr || error.message, code: error.code || 1, killed: Boolean(error.killed) };
			}
		},
	};
	const ctx = { cwd: f.base, hasUI: true, ui: { notify: (message, level) => notifications.push({ message, level }) } };
	const previousShell = process.env.SHELL;
	process.env.SHELL = "/bin/sh";
	defer(t, () => { if (previousShell === undefined) delete process.env.SHELL; else process.env.SHELL = previousShell; });
	const { default: register } = await import(`../index.ts?lfortran=${randomUUID()}`);
	register(pi);
	const tool = (name, params, signal) => tools.get(name).execute(randomUUID(), params, signal, undefined, ctx);
	const repl = async (args) => {
		const before = notifications.length;
		await commands.get("repl").handler(args, ctx);
		return notifications.slice(before);
	};
	// Whatever a test leaves running is stopped, through the verified stop.
	defer(t, () => repl("stop lfortran"));
	return {
		...f, tools, notifications, messages,
		start: (params = {}) => tool("repl_start", { runtime: "lfortran", timeoutMs: 30_000, ...params }),
		send: (code, params = {}, signal) => tool("repl_send", { code, target: "lfortran", ...params }, signal),
		input: (token, text, params = {}, signal) => tool("repl_input", { token, text, ...params }, signal),
		status: (params = {}) => tool("repl_status", params),
		tool,
		repl,
	};
}

const text = (result) => result.content.map((part) => part.text).join("");

test("/repl parses lfortran and input, keeping an answer's text exactly", async (t) => {
	const f = await piFixture(t);
	if (!f) return;
	assert.match((await f.repl("input"))[0].message, /Usage: \/repl input <token> <text>/);
	assert.match((await f.repl("status lfortran"))[0].message, /No shared LFortran session is running/);
	assert.match((await f.repl("help"))[0].message, /\/repl lfortran[\s\S]*\/repl input <token> <text>/);
	assert.ok(f.tools.has("repl_input"));
	assert.ok(f.tools.get("repl_start").parameters.properties.runtime.enum.includes("lfortran"));
	await assert.rejects(f.send("print:x"), /No shared LFortran session is running/);
});

test("/repl send lfortran runs the code below it, and a READ it asks is answered with /repl input", async (t) => {
	const f = await piFixture(t);
	if (!f) return;
	assert.match((await f.repl("send lfortran\nprint:x"))[0].message, /No shared LFortran session is running/);
	await f.start();
	assert.deepEqual(await f.repl("send lfortran\nprint:hello"), []);
	const [{ message, options }] = f.messages;
	assert.equal(message.customType, "pi-repl-send");
	assert.equal(message.display, true);
	assert.deepEqual(options, { triggerTurn: false });
	assert.match(message.content, /^\/repl send to pi-repl-lfortran:\n\n```\nCompleted\.\nExecution: [0-9a-f]{32}\n\nSubmitted code:\nprint:hello\n\nOutput:\nhello\n```$/);
	assert.equal(message.details.state, "completed");
	await f.repl("send LFortran\nread");
	const reading = f.messages.at(-1).message.content;
	const token = TOKEN.exec(reading)[1];
	assert.ok(reading.endsWith(`\n\nTo answer it from here: /repl input ${token} <text>\n\`\`\``), reading);
	await f.repl(`input ${token} 7`);
	assert.match(f.messages.at(-1).message.content, /^\/repl input answered a READ in pi-repl-lfortran:[\s\S]*Output:\ngot 7\n```$/);
});

test("repl_start, repl_send, a READ answered with repl_input and /repl input, repl_status, and /repl stop", async (t) => {
	const f = await piFixture(t);
	if (!f) return;
	const started = await f.start();
	assert.equal(started.details.ready, true, text(started));
	assert.match(text(started), /Started the shared LFortran session: pi-repl-lfortran[\s\S]*LFortran version: 0\.0\.0-fake[\s\S]*Readiness: the helper and kernel are ready/);
	assert.match(text(await f.start()), /already running; reused/);

	const hello = await f.send("print:hello");
	assert.match(text(hello), /^Completed\.\nExecution: [0-9a-f]{32}\n\nSubmitted code:\nprint:hello\n\nOutput:\nhello$/);
	assert.equal(hello.details.state, "completed");
	assert.match(text(await f.send("fail")), /^Completed, with an error[\s\S]*it failed/);

	const reading = await f.send("read");
	assert.match(text(reading), /Waiting for input: the cell's READ asks "\? "[\s\S]*repl_input token='[0-9a-f]{32}'/);
	assert.equal(reading.details.state, "waiting-input");
	const answered = await f.input(TOKEN.exec(text(reading))[1], "42\n");
	assert.match(text(answered), /^Completed\.[\s\S]*Output:\ngot 42$/);
	await assert.rejects(f.input(TOKEN.exec(text(reading))[1], "43"), /doesn't answer a READ that is waiting/);

	// /repl input passes the text on exactly, its leading spaces too, and posts the result to the conversation.
	const again = await f.send("read");
	assert.deepEqual(await f.repl(`input ${TOKEN.exec(text(again))[1]}   spaced`), []);
	assert.match(f.messages.at(-1).message.content, /^\/repl input answered a READ in pi-repl-lfortran:\n\n```\nCompleted\.[\s\S]*Output:\ngot   spaced\n```$/);

	// A cell that outlasts the wait goes on, and can be looked up exactly; meanwhile, another is refused.
	const slow = await f.send("sleep:1500", { timeoutMs: 1000 });
	assert.match(text(slow), /^Still running after 1 s\. It goes on[\s\S]*Look it up with repl_status target='lfortran' execution='[0-9a-f]{32}'/);
	await assert.rejects(f.send("print:x"), /Another LFortran cell is still unresolved[\s\S]*execution='[0-9a-f]{32}'/);
	await until(async () => /^Completed\./.test(text(await f.status({ target: "lfortran", execution: slow.details.executionId }))), { what: "the slow cell to finish" });
	assert.match(text(await f.status({ execution: slow.details.submissionId })), /^Completed\./, "a submission ID finds it too");
	await assert.rejects(f.status({ target: "lfortran", execution: "pi-never-sent-1234" }), /No cell with that ID reached this LFortran session/);
	await assert.rejects(f.status({ target: "python", execution: slow.details.executionId }), /for LFortran cells/);
	const status = text(await f.status({ target: "lfortran" }));
	assert.match(status, /The person's prompt: at LFortran's prompt[\s\S]*The helper and kernel: ready/);
	assert.match(text(await f.status()), /Shared LFortran session: pi-repl-lfortran/);

	// Cancelled before it starts: nothing is sent, and no READ is answered.
	const before = (await f.status({ target: "lfortran" })).details.lfortran.current.executionId;
	await assert.rejects(f.send("print:never", { }, AbortSignal.abort()), /Cancelled before anything was sent/);
	assert.equal((await f.status({ target: "lfortran" })).details.lfortran.current.executionId, before);
	const waiting = await f.send("read");
	await assert.rejects(f.input(TOKEN.exec(text(waiting))[1], "1", {}, AbortSignal.abort()), /Cancelled before anything was sent[\s\S]*the READ still waits/);
	// A wait leaves no listeners on the signal it was given.
	const controller = new AbortController();
	assert.match(text(await f.input(TOKEN.exec(text(waiting))[1], "5", {}, controller.signal)), /got 5/);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	await f.send("sleep:300", {}, controller.signal);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);

	// Every status is bounded, the overview too.
	await f.send("big:300000");
	const overview = text(await f.status());
	assert.ok(Buffer.byteLength(overview) <= DEFAULT_MAX_BYTES, `${Buffer.byteLength(overview)} bytes`);
	assert.match(overview, /REPL response truncated/);

	const [stopped] = await f.repl("stop lfortran");
	assert.equal(stopped.level, "info", stopped.message);
	assert.match(stopped.message, /Stopped the shared LFortran session/);
	await assert.rejects(f.send("print:x"), /No shared LFortran session is running/);
});

test("a cell that ends the kernel: its outcome is unconfirmed, the session says it's over, and it still stops", async (t) => {
	const f = await piFixture(t);
	if (!f) return;
	assert.equal((await f.start()).details.ready, true);
	const ended = await f.send("exit:3");
	assert.match(text(ended), /^Outcome unconfirmed: the kernel exited \(status 3\) before the cell's result was confirmed\. It had started[\s\S]*The kernel has ended, so the session is over for everyone[\s\S]*Output:\ndying$/);
	await assert.rejects(f.send("print:x"), /isn't taking cells: its kernel has exited/);
	assert.match(text(await f.status({ target: "lfortran" })), /The kernel has exited \(status 3\): the session is over for everyone/);
	const [stopped] = await f.repl("stop lfortran");
	assert.match(stopped.message, /Stopped the shared LFortran session/);
});

test("an outcome says only what's known: the kernel's exit, a lost connection, an invalid reply, a failed wait, and the spool", () => {
	const base = { executionId: "e".repeat(32), output: { text: "partial\n" } };
	const lost = formatExecution({ ...base, state: "unconfirmed", outcome: { kind: "connection-lost", reason: "the connection to the kernel was lost (shell)", exit: null, started: false } });
	assert.match(lost, /no evidence it started[\s\S]*may have run/);
	assert.match(lost, /Whether the kernel and the person's prompt are still running isn't known/);
	assert.doesNotMatch(lost, /over for everyone|hadn't started/);
	const exited = formatExecution({ ...base, state: "unconfirmed", outcome: { kind: "connection-lost", reason: "the connection to the kernel was lost (shell)", exit: { code: 1, signal: null }, started: true } });
	assert.match(exited, /the kernel exited \(status 1\)[\s\S]*over for everyone/);
	const invalid = formatExecution({ ...base, state: "unconfirmed", outcome: { kind: "invalid-reply", reason: "the kernel's execute_reply had no valid status (maybe)", exit: null, started: true } });
	assert.match(invalid, /whether it succeeded isn't known[\s\S]*may still be usable/);
	assert.doesNotMatch(invalid, /over for everyone/);
	const failedWait = formatExecution({ ...base, state: "running", waitFailed: "The connection to the helper closed." }, { timeoutMs: 20_000 });
	assert.match(failedWait, /The cell was taken \(it is running\), but waiting for it failed[\s\S]*isn't resent[\s\S]*execution='e{32}'/);
	const spool = (fields) => formatExecution({ ...base, state: "completed", status: "ok", output: { text: "x", truncated: true, spool: { path: "/d/out.txt", ...fields } } });
	assert.match(spool({ state: "writing" }), /still being written to \/d\/out\.txt/);
	assert.match(spool({ state: "complete", full: true }), /The full received output is in \/d\/out\.txt/);
	assert.match(spool({ state: "complete", full: false, capped: true }), /Part of the rest is in \/d\/out\.txt; the file reached its size limit/);
	assert.match(spool({ state: "failed", error: "ENOSPC" }), /writing the rest to a file failed \(ENOSPC\)/);
});

test("recovery messages say only what's known: an expired cell's last state, and an answer whose delivery is unknown", async (t) => {
	const dir = mkdtempSync("/tmp/pi-rj-fh-");
	defer(t, () => rmSync(dir, { recursive: true, force: true }));
	const owner = "b".repeat(32);
	// A helper that answers hello, says a cell is no longer kept, and drops the connection mid-answer.
	const server = net.createServer((socket) => {
		let buffered = "";
		socket.on("error", () => {});
		socket.on("data", (chunk) => {
			buffered += chunk;
			let newline;
			while ((newline = buffered.indexOf("\n")) >= 0) {
				const request = JSON.parse(buffered.slice(0, newline));
				buffered = buffered.slice(newline + 1);
				if (request.op === "hello") socket.write(JSON.stringify({ id: request.id, ok: true, result: { protocol: 1, launchId: owner, lifetimeId: "c".repeat(32), state: "ready" } }) + "\n");
				else if (request.op === "lookup") socket.write(JSON.stringify({ id: request.id, ok: false, error: { code: "expired", message: "gone", executionId: "e".repeat(32), state: "not-sent", status: null } }) + "\n");
				else socket.destroy();
			}
		});
	});
	await new Promise((resolve) => server.listen(join(dir, "h.sock"), resolve));
	defer(t, () => new Promise((resolve) => server.close(resolve)));
	const tmux = async (args) => args[0] === "list-sessions"
		? { code: 0, stdout: ["pi-repl-lfortran", "$1", "1800000000", "lfortran", "jupyter-helper", owner, dir, "", "%1", "%2"].join("\t") + "\n", stderr: "" }
		: { code: 1, stdout: "", stderr: "not in this test" };
	await assert.rejects(lfortranStatus({ tmux, execution: "e".repeat(32) }), (error) => /no longer keeps that cell's output; its last state was not-sent/.test(error.message) && !/\bran\b/.test(error.message));
	await assert.rejects(answerLfortranInput({ tmux, token: "d".repeat(32), text: "1" }), (error) => /whether the answer arrived isn't known[\s\S]*if the READ still waits with this token, the answer didn't arrive\. If it doesn't, that alone doesn't show the answer arrived/.test(error.message) && !/can't be used again|if not, it did/.test(error.message));
});

test("with LFortran: repl_start, repl_send, and a READ through repl_input", { skip: !REAL_LFORTRAN && "set PI_REPL_LFORTRAN" }, async (t) => {
	const f = await piFixture(t, { real: true });
	if (!f) return;
	const started = await f.start({ timeoutMs: 60_000 });
	assert.equal(started.details.ready, true, text(started));
	assert.match(text(await f.send("integer :: k = 6\nprint *, k * 7")), /^Completed\.[\s\S]*Output:\n\s*42\s*$/);
	const reading = await f.send("integer :: n\nread *, n\nprint *, n + 1");
	assert.match(text(reading), /Waiting for input/);
	assert.match(text(await f.input(TOKEN.exec(text(reading))[1], "9")), /Output:\n\s*10\s*$/);
	const [stopped] = await f.repl("stop lfortran");
	assert.match(stopped.message, /Stopped the shared LFortran session/);
});
