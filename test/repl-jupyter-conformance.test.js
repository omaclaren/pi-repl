// shared/repl-jupyter.js against real kernels. Opt-in:
//   PI_REPL_LFORTRAN=/path/to/lfortran   an LFortran with the shared session
//                                        (main after #16030 and #16032)
//   PI_REPL_IPYKERNEL_PYTHON=/path/to/python   a Python with ipykernel
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JupyterClient, readConnectionFile, waitForExecution } from "../shared/repl-jupyter.js";

const LFORTRAN = process.env.PI_REPL_LFORTRAN;
const IPYKERNEL_PYTHON = process.env.PI_REPL_IPYKERNEL_PYTHON;

async function until(check, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`timed out waiting for ${label}`);
}

/** Starts a kernel that writes `FILE` in a private directory, and connects a client. */
async function startKernel(t, command, args) {
	const dir = mkdtempSync(join(tmpdir(), "pi-repl-jupyter-kernel-"));
	const file = join(dir, "kernel.json");
	const child = spawn(command, args(file), { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "", spawnError = null;
	child.on("error", (error) => { spawnError = error; });
	child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
	const exited = new Promise((resolve) => {
		child.on("exit", (code, signal) => resolve({ code, signal }));
		child.on("error", () => resolve({ code: null, signal: null }));
	});
	t.after(async () => {
		// SIGTERM, then SIGKILL if the kernel hasn't exited within 5 s.
		if (child.exitCode === null && child.signalCode === null && !spawnError) {
			child.kill("SIGTERM");
			const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
			await exited;
			clearTimeout(timer);
		}
		rmSync(dir, { recursive: true, force: true });
	});
	await until(() => existsSync(file) || child.exitCode !== null || spawnError, 30_000, "the connection file");
	assert.equal(spawnError, null, `the kernel didn't start: ${spawnError?.message}`);
	assert.equal(child.exitCode, null, `the kernel exited: ${stderr}`);
	// The file is written once the kernel has bound its ports; a reader may see it while it is written.
	let connection;
	await until(() => {
		try { connection = readConnectionFile(file); return true; } catch { return false; }
	}, 10_000, "a complete connection file");
	const clients = [];
	const connect = async () => {
		const client = await JupyterClient.connect(connection, { timeoutMs: 30_000 });
		clients.push(client);
		return client;
	};
	t.after(() => { for (const client of clients) client.close(); });
	return { child, file, exited, connect };
}

const run = (client, code, options) => {
	const request = client.prepareExecute(code);
	const done = waitForExecution(client, request, { timeoutMs: 60_000, ...options });
	client.post("shell", request);
	return done;
};
const streamText = (iopub, name = "stdout") => iopub.filter((m) => m.header.msg_type === "stream" && m.content.name === name).map((m) => m.content.text).join("");
const result = (iopub) => iopub.find((m) => m.header.msg_type === "execute_result")?.content.data["text/plain"];

test("LFortran's built-in kernel: cells, a result, READ, errors and a second client", { skip: !LFORTRAN && "set PI_REPL_LFORTRAN" }, async (t) => {
	const kernel = await startKernel(t, LFORTRAN, (file) => ["kernel", "-f", file]);
	const a = await kernel.connect();
	const b = await kernel.connect();
	const seenByB = [];
	b.on("message", (channel, message) => { if (channel === "iopub" && message.header.msg_type === "execute_input") seenByB.push(message.content.code); });

	const printed = await run(a, "print *, 1 + 1");
	assert.equal(printed.reply.content.status, "ok");
	assert.match(streamText(printed.iopub), /^\s*2\s*$/);
	assert.equal(result((await run(a, "40 + 2")).iopub), "42");

	const asked = [];
	const read = await run(a, "integer :: k\nread(*,*) k\nprint *, 'got', k", {
		onInputRequest: (request) => {
			asked.push(request.parent_header.msg_id);
			a.input("7", request);
		},
	});
	assert.equal(asked.length, 1);
	assert.match(streamText(read.iopub), /got\s+7/);

	const failed = await run(a, "x = undefined_name");
	assert.equal(failed.reply.content.status, "error");
	assert.match(streamText(failed.iopub, "stderr"), /undefined_name/);

	// The other client's cells reach b on IOPub, and b's own state is shared.
	assert.ok(seenByB.includes("print *, 1 + 1"));
	assert.equal(result((await run(b, "k * 6")).iopub), "42");

	kernel.child.kill("SIGTERM");
	const exit = await Promise.race([kernel.exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 10_000).unref())]);
	assert.notEqual(exit, "timeout", "the kernel exits on SIGTERM within 10 s");
	assert.equal(existsSync(kernel.file), false, "the kernel removes the connection file it wrote");
});

test("ipykernel: cells, a result, input() and an error", { skip: !IPYKERNEL_PYTHON && "set PI_REPL_IPYKERNEL_PYTHON" }, async (t) => {
	const kernel = await startKernel(t, IPYKERNEL_PYTHON, (file) => ["-I", "-m", "ipykernel_launcher", "-f", file]);
	const client = await kernel.connect();
	const printed = await run(client, "print(1 + 1)");
	assert.equal(printed.reply.content.status, "ok");
	assert.equal(streamText(printed.iopub), "2\n");
	assert.equal(result((await run(client, "40 + 2")).iopub), "42");
	const read = await run(client, "x = input('? ')\nprint('got', x)", { onInputRequest: (request) => client.input("7", request) });
	assert.match(streamText(read.iopub), /got 7/);
	const failed = await run(client, "1 / 0");
	assert.equal(failed.reply.content.status, "error");
	assert.equal(failed.iopub.find((m) => m.header.msg_type === "error")?.content.ename, "ZeroDivisionError");
});

test("the helper with LFortran: a cell, a READ, another client's cell, and a runtime error ending the kernel", { skip: !LFORTRAN && "set PI_REPL_LFORTRAN" }, async (t) => {
	const { HelperClient, JupyterHelper } = await import("../shared/repl-jupyter-helper.js");
	const dir = mkdtempSync("/tmp/pi-rj-conf-");
	const helper = new JupyterHelper({ dir, kernelCommand: (file) => [LFORTRAN, ["kernel", "-f", file, "--managed"]], startTimeoutMs: 60_000 });
	t.after(async () => {
		await helper.stop({ killKernel: true });
		rmSync(dir, { recursive: true, force: true });
	});
	await helper.start();
	const client = await HelperClient.connect(helper.paths.socket);
	t.after(() => client.close());
	const { lifetimeId } = await client.request("hello");
	let n = 0;
	const settle = async (snapshot, untilInput = false) => {
		while (!["completed", "unconfirmed", "not-sent"].includes(snapshot.state) && !(untilInput && snapshot.state === "waiting-input")) {
			snapshot = await client.request("wait", { executionId: snapshot.executionId, since: snapshot.version, timeoutMs: 30_000 }, { timeoutMs: 40_000 });
		}
		return snapshot;
	};
	const run = (code, untilInput) => client.request("execute", { lifetimeId, submissionId: `conformance-${process.pid}-${++n}`, code }).then((s) => settle(s, untilInput));

	const printed = await run("print *, 6 * 7");
	assert.equal(printed.status, "ok");
	assert.match(printed.output.text, /^\s*42\s*$/);

	const waiting = await run("integer :: k\nread(*,*) k\nprint *, 'got', k", true);
	assert.equal(waiting.state, "waiting-input");
	const read = await settle(await client.request("input", { lifetimeId, token: waiting.input.token, text: "9\n" }));
	assert.equal(read.status, "ok");
	assert.match(read.output.text, /got\s+9/);

	const other = await JupyterClient.connect(readConnectionFile(helper.paths.connection), { timeoutMs: 30_000 });
	t.after(() => other.close());
	await run2(other, "print *, k + 1");
	const journal = await client.request("journal", { since: 1, limit: 1000 });
	assert.ok(journal.events.some((e) => e.kind === "iopub" && e.msgType === "execute_input" && e.code === "print *, k + 1" && e.parentSession === other.session.session));

	const crashed = await run("integer :: a(3), m\nm = 5\na(m) = 1");
	assert.equal(crashed.state, "unconfirmed");
	assert.equal(crashed.outcome.exit.code, 1);
	assert.equal((await client.request("status")).state, "kernel-exited");
});

async function run2(client, code) {
	const request = client.prepareExecute(code);
	const done = waitForExecution(client, request, { timeoutMs: 60_000 });
	client.post("shell", request);
	return done;
}
