import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";
import vm from "node:vm";
import { JupyterClient, readConnectionFile, waitForExecution } from "../shared/repl-jupyter.js";
import { readReplSessionRecord, recordEntryKey } from "../shared/repl-session-record.js";
import { HelperClient, Journal, JupyterHelper, OutputBuffer, normalizeInputText, RecordWriter } from "../shared/repl-jupyter-helper.js";

const FAKE_PROCESS = fileURLToPath(new URL("./helpers/fake-kernel-process.js", import.meta.url));
const fakeKernel = (file) => [process.execPath, [FAKE_PROCESS, "kernel", "-f", file, "--managed"]];
const TERMINAL = new Set(["completed", "unconfirmed", "not-sent"]);
let submissions = 0;
const submissionId = () => `test-submission-${process.pid}-${++submissions}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition, { timeoutMs = 5000, what = "the condition" } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
		await sleep(10);
	}
}

/**
 * Registers a cleanup for test `t`. Cleanups run last first, after the test,
 * and each runs even if one before it failed or took over 10 s: node:test
 * runs after hooks first first, and skips the rest once one throws, which
 * would remove a session's directory before its helper is stopped, or not
 * stop it at all.
 */
function defer(t, cleanup) {
	if (!t.cleanups) {
		const cleanups = (t.cleanups = []);
		t.after(async () => {
			let failure;
			for (const run of cleanups.reverse()) {
				let timer;
				const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`A cleanup took over 10 s: ${run}`)), 10_000); });
				try { await Promise.race([run(), late]); } catch (error) { failure ??= error; } finally { clearTimeout(timer); }
			}
			if (failure) throw failure;
		});
	}
	t.cleanups.push(cleanup);
}

/** A private, short directory, as the session's DIR would be. */
function privateDir(t) {
	const dir = mkdtempSync("/tmp/pi-rj-test-");
	defer(t, () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
	return dir;
}

async function started(t, options = {}) {
	const dir = privateDir(t);
	const helper = new JupyterHelper({ dir, kernelCommand: fakeKernel, drainMs: 300, startTimeoutMs: 15_000, ...options });
	defer(t, () => helper.stop({ killKernel: true }));
	await helper.start();
	const client = await HelperClient.connect(helper.paths.socket);
	defer(t, () => client.close());
	const { lifetimeId } = await client.request("hello");
	return { dir, helper, client, lifetimeId };
}

/**
 * A helper whose kernel connection is a stub, so that a test can deliver the
 * kernel's messages in any order, and refuse writes.
 */
function stubbed(t, options = {}) {
	const dir = privateDir(t);
	const helper = new JupyterHelper({ dir, kernelCommand: fakeKernel, drainMs: 30, ...options });
	const sent = [];
	let ids = 0;
	const client = {
		lost: false,
		refuse: 0,
		refuseInput: 0,
		prepareExecute: (code) => ({ header: { msg_id: `request-${++ids}`, msg_type: "execute_request", session: "stub" }, content: { code } }),
		post(channel, message) {
			if (client.refuse > 0 && client.refuse--) throw new Error("the stub refused");
			sent.push({ channel, message });
			return message;
		},
		input(value, request) {
			if (client.refuseInput > 0 && client.refuseInput--) throw new Error("the stub refused");
			sent.push({ channel: "stdin", value, request });
		},
		close() { client.lost = true; },
	};
	Object.assign(helper, { client, state: "ready", admitting: true, kernelSession: "kernel" });
	defer(t, () => helper.stop());
	const deliver = (channel, msgType, content, parent) => helper.receive(channel, {
		header: { msg_id: `message-${++ids}`, msg_type: msgType, session: "kernel" },
		parent_header: parent ? { msg_id: parent, session: "stub" } : {},
		content,
	});
	const execute = (code = "x") => helper.execute({ lifetimeId: helper.lifetimeId, submissionId: submissionId(), code });
	const finish = (requestId, status = "ok") => {
		deliver("iopub", "status", { execution_state: "idle" }, requestId);
		deliver("shell", "execute_reply", { status }, requestId);
	};
	return { helper, client, sent, deliver, execute, finish, lifetimeId: helper.lifetimeId };
}

/** An OutputBuffer, and a promise of how its spool ends. */
function spooling(options) {
	let ended;
	const done = new Promise((resolve) => { ended = resolve; });
	const output = new OutputBuffer({ ...options, onSpool: (state) => ended(state) });
	return { output, done };
}

/** Executes and waits for a terminal state, or for a READ. */
async function runToEnd(client, lifetimeId, code, { untilInput = false } = {}) {
	let snapshot = await client.request("execute", { lifetimeId, submissionId: submissionId(), code });
	while (!TERMINAL.has(snapshot.state) && !(untilInput && snapshot.state === "waiting-input")) {
		snapshot = await client.request("wait", { executionId: snapshot.executionId, since: snapshot.version, timeoutMs: 5000 });
	}
	return snapshot;
}

test("normalizeInputText takes off one line ending and refuses anything that isn't one record", () => {
	assert.equal(normalizeInputText("42"), "42");
	assert.equal(normalizeInputText("42\n"), "42");
	assert.equal(normalizeInputText("42\r\n"), "42");
	assert.equal(normalizeInputText(""), "");
	assert.equal(normalizeInputText("  "), "  ");
	assert.equal(normalizeInputText("\n"), "");
	for (const bad of ["4\n2", "42\n\n", "42\r", "\x04", "a\x04b", 42]) assert.throws(() => normalizeInputText(bad), /record|string/, JSON.stringify(bad));
});

test("output is cleaned as a pane shows it, bounded in memory, and spooled in full", async (t) => {
	const dir = privateDir(t);
	const { output, done } = spooling({ maxMemoryBytes: 20, spoolPath: join(dir, "out.txt") });
	output.write("\x1b[1mbold\x1b[0m\n");
	output.write("50%\r");
	output.write("100%\n");
	output.write("a\x1b[3");
	output.write("1mb\n");
	output.write("after the bound\n");
	output.close();
	assert.equal(output.text(), "bold\n100%\nab\n");
	assert.equal(output.summary().truncated, true);
	assert.equal(output.summary().spool.state, "writing");
	assert.equal(output.summary().spool.full, false);
	assert.equal(await done, "complete");
	const expected = "bold\n100%\nab\nafter the bound\n";
	assert.equal(readFileSync(join(dir, "out.txt"), "utf8"), expected);
	assert.equal((lstatSync(join(dir, "out.txt")).mode & 0o777), 0o600);
	assert.deepEqual(output.summary().spool, { path: join(dir, "out.txt"), state: "complete", bytes: Buffer.byteLength(expected), capped: false, incomplete: false, full: true });
});

test("a carriage return goes back to the line's start and later text overwrites; erase-in-line erases", () => {
	const text = (...parts) => {
		const output = new OutputBuffer();
		for (const part of parts) output.write(part);
		output.close();
		return output.text();
	};
	assert.equal(text("abcdef\rxy\n"), "xycdef\n");
	assert.equal(text("abcdef\r", "xy\n"), "xycdef\n");
	assert.equal(text("abcdef\rxy\x1b[K\n"), "xy\n");
	assert.equal(text("abcdef\r\x1b[2Kxy\n"), "xy\n");
	assert.equal(text("abcdef\r\x1b[", "2K", "xy\n"), "xy\n");
	// A CRLF split by a message boundary is still one line break.
	assert.equal(text("abc\r", "\ndef"), "abc\ndef");
	assert.equal(text("50%\r100%\n"), "100%\n");
});

test("output bounds hold for unfinished escapes, unfinished lines, and the spool's bytes and queue", async (t) => {
	// An unfinished escape isn't held beyond its bound; the rest of it is dropped.
	const escape = new OutputBuffer({ maxMemoryBytes: 16 });
	escape.write("a\x1b[" + "1".repeat(100_000));
	assert.ok(escape.held.length <= 64);
	escape.write("1".repeat(1000));
	escape.write("2mb\n");
	escape.close();
	assert.equal(escape.text(), "ab\n");

	// A line without a break counts against the memory bound.
	const partial = new OutputBuffer({ maxMemoryBytes: 16 });
	partial.write("x".repeat(100));
	assert.equal(partial.text(), "x".repeat(16));
	assert.equal(partial.summary().truncated, true);

	// The spool's bound is in bytes, cut between characters.
	const dir = privateDir(t);
	const capped = spooling({ spoolPath: join(dir, "capped.txt"), maxSpoolBytes: 5 });
	capped.output.write("ééé\n");
	capped.output.close();
	assert.equal(await capped.done, "complete");
	assert.equal(readFileSync(join(dir, "capped.txt"), "utf8"), "éé");
	assert.equal(capped.output.summary().spool.capped, true);
	assert.equal(capped.output.summary().spool.bytes, 4);
	assert.equal(capped.output.summary().spool.full, false);

	// A spool the disk can't keep up with is left incomplete rather than queued without bound.
	const slow = spooling({ spoolPath: join(dir, "slow.txt"), spoolBudget: { pending: 0, max: 8 } });
	slow.output.write("1234\n");
	slow.output.write("5678\n");
	slow.output.close();
	assert.equal(await slow.done, "complete");
	assert.equal(readFileSync(join(dir, "slow.txt"), "utf8"), "1234\n");
	assert.equal(slow.output.summary().spool.incomplete, true);
	assert.equal(slow.output.summary().spool.full, false);

	// A spool that can't be written says so.
	const failing = spooling({ spoolPath: join(dir, "missing", "out.txt") });
	failing.output.write("x\n");
	failing.output.close();
	assert.equal(await failing.done, "failed");
	assert.match(failing.output.summary().spool.error, /ENOENT/);
	assert.equal(failing.output.summary().spool.full, false);

	// A spool the disk is too far behind to begin is reported too, without a file.
	const behind = new OutputBuffer({ spoolPath: join(dir, "behind.txt"), spoolBudget: { pending: 0, max: 2 } });
	behind.write("12345\n");
	assert.deepEqual(behind.summary().spool, { path: null, state: "none", bytes: 0, capped: false, incomplete: true, full: false });
	assert.equal(existsSync(join(dir, "behind.txt")), false);
});

test("a spool only ever removes the file it created itself", async (t) => {
	const dir = privateDir(t);
	// A file already at the spool's path is neither written nor removed.
	const existing = join(dir, "taken.txt");
	writeFileSync(existing, "someone else's\n");
	const taken = spooling({ spoolPath: existing });
	taken.output.write("x\n");
	assert.equal(await taken.done, "failed");
	assert.match(taken.output.summary().spool.error, /EEXIST/);
	assert.equal(taken.output.summary().spool.path, null);
	await taken.output.discard();
	assert.equal(readFileSync(existing, "utf8"), "someone else's\n");
	// Nor is a file put in its place after it was created.
	const path = join(dir, "replaced.txt");
	const replaced = spooling({ spoolPath: path });
	replaced.output.write("mine\n");
	unlinkSync(path);
	writeFileSync(path, "theirs\n");
	await replaced.output.discard();
	assert.equal(readFileSync(path, "utf8"), "theirs\n");
	// Its own file is removed, once closed.
	const own = join(dir, "own.txt");
	const mine = spooling({ spoolPath: own });
	mine.output.write("mine\n");
	assert.ok(existsSync(own), "the spool is created as output arrives");
	await mine.output.discard();
	assert.equal(existsSync(own), false);
});

test("kept text doesn't keep the large messages it came from alive", (t) => {
	v8.setFlagsFromString("--expose-gc");
	const gc = vm.runInNewContext("gc");
	const heap = () => {
		gc();
		gc();
		return process.memoryUsage().heapUsed;
	};
	const { deliver, execute } = stubbed(t, { output: { maxMemoryBytes: 1024 * 1024, maxSpoolBytes: 1024 } });
	const { requestId } = execute();
	// Flat 20 MiB strings, as a decoded message's would be.
	const big = () => Buffer.alloc(20 * 1024 * 1024, "x").toString("latin1");
	// In a function of its own, so that this test's frame doesn't still hold the last message when the heap is measured.
	const feed = () => {
		for (let i = 0; i < 3; i++) {
			// Another client's output, in the journal only; then this execution's, a long tail included.
			deliver("iopub", "stream", { name: "stdout", text: big() }, "another-clients-request");
			deliver("iopub", "stream", { name: "stdout", text: big() + "\n" + "t".repeat(100) }, requestId);
		}
	};
	const before = heap();
	feed();
	const grown = (heap() - before) / (1024 * 1024);
	assert.ok(grown < 20, `${grown.toFixed(1)} MiB kept after 120 MiB of messages`);
});

test("the journal keeps an oversized event as an omission, pages by cursor, and reports its gap", () => {
	const journal = new Journal("generation", { maxEvents: 5, maxBytes: 4096, maxEventBytes: 1024 });
	journal.append({ kind: "iopub", msgType: "stream", msgId: "m1", session: "k", parentId: "p1", parentSession: "c", text: "x".repeat(5000) });
	const [big] = journal.read(1).events;
	assert.match(big.omitted, /too large/);
	assert.deepEqual([big.msgType, big.msgId, big.session, big.parentId, big.parentSession], ["stream", "m1", "k", "p1", "c"]);
	assert.equal(big.text, undefined);
	for (let i = 0; i < 7; i++) journal.append({ kind: "notice", message: `n${i}` });
	const page = journal.read(1, 2);
	assert.deepEqual(page.gap, { from: 1, to: 3 });
	assert.deepEqual([page.tail, page.head, page.next], [4, 8, 9]);
	assert.deepEqual(page.events.map((e) => e.seq), [4, 5]);
	assert.equal(page.cursor, 6);
	assert.equal(page.more, true);
	const rest = journal.read(page.cursor, 10);
	assert.deepEqual(rest.events.map((e) => e.seq), [6, 7, 8]);
	assert.deepEqual([rest.cursor, rest.more, rest.gap], [9, false, null]);
	assert.deepEqual([journal.read(9).events.length, journal.read(9).cursor], [0, 9]);
	// A page stops at its byte bound, but has at least one event.
	assert.equal(journal.read(4, 10, 1).events.length, 1);
});

test("the helper starts the kernel, publishes ready.json and answers hello", async (t) => {
	const { helper, client, lifetimeId } = await started(t);
	const ready = JSON.parse(readFileSync(helper.paths.ready, "utf8"));
	assert.equal(ready.state, "ready");
	assert.equal(ready.lifetimeId, lifetimeId);
	assert.equal(ready.launchId, helper.launchId);
	assert.equal(ready.kernelPid, helper.kernel.pid);
	assert.ok(ready.kernelSession);
	for (const path of [helper.paths.ready, helper.paths.socket, helper.paths.connection, helper.paths.kernelLog, helper.paths.pid]) {
		assert.equal(lstatSync(path).mode & 0o777, 0o600, path);
	}
	assert.equal(readFileSync(helper.paths.pid, "utf8"), `${process.pid}\n`);
	const hello = await client.request("hello");
	assert.equal(hello.protocol, 1);
	assert.equal(hello.kernelSession, ready.kernelSession);
	assert.equal((await client.request("status")).state, "ready");
});

test("a cell runs to completion with its output and the reply's status, and its journal events can be found", async (t) => {
	const { client, lifetimeId } = await started(t);
	const done = await runToEnd(client, lifetimeId, "print:hello");
	assert.equal(done.state, "completed");
	assert.equal(done.status, "ok");
	assert.equal(done.output.text, "hello");
	const page = await client.request("journal", { since: done.journal.first, limit: 1000 });
	const own = page.events.filter((e) => e.seq <= done.journal.last && (e.parentId === done.requestId || e.executionId === done.executionId));
	assert.equal(own.length, done.journal.count);
	assert.ok(own.filter((e) => e.kind === "iopub").every((e) => e.msgId), "IOPub events carry their msg_id");
	const failed = await runToEnd(client, lifetimeId, "fail");
	assert.equal(failed.status, "error");
	assert.match(failed.output.text, /it failed/);
	const aborted = await runToEnd(client, lifetimeId, "abort");
	assert.equal(aborted.state, "completed");
	assert.equal(aborted.status, "aborted");
	assert.equal(aborted.started, false);
});

test("terminal output is cleaned: escapes, carriage returns, displays and clears", async (t) => {
	const { client, lifetimeId } = await started(t);
	const text = async (code) => (await runToEnd(client, lifetimeId, code)).output.text;
	assert.equal(await text("ansi"), "red warning\n");
	assert.equal(await text("cr"), "100%\n");
	assert.equal(await text("split-escape"), "ab\n");
	assert.equal(await text("display"), "[image/png output]\n42\n");
	assert.equal(await text("clear"), "x\n[output cleared]\ny\n");
});

test("a repeated submission returns its execution; other code under its ID is refused; lookup finds it", async (t) => {
	const { client, lifetimeId } = await started(t);
	const id = submissionId();
	const first = await client.request("execute", { lifetimeId, submissionId: id, code: "print:once" });
	const again = await client.request("execute", { lifetimeId, submissionId: id, code: "print:once" });
	assert.equal(again.executionId, first.executionId);
	await assert.rejects(client.request("execute", { lifetimeId, submissionId: id, code: "print:other" }), (e) => e.code === "submission-conflict");
	const found = await client.request("lookup", { submissionId: id });
	assert.equal(found.executionId, first.executionId);
	await assert.rejects(client.request("lookup", { submissionId: "never-submitted-id" }), (e) => e.code === "unknown-execution");
	await assert.rejects(client.request("execute", { lifetimeId, submissionId: "bad id!", code: "x" }), (e) => e.code === "invalid-request");
});

test("only one cell is unresolved at a time; status, wait and journal still answer", async (t) => {
	const { client, lifetimeId } = await started(t);
	const first = await client.request("execute", { lifetimeId, submissionId: submissionId(), code: "sleep:400" });
	const busy = await client.request("execute", { lifetimeId, submissionId: submissionId(), code: "print:x" }).catch((e) => e);
	assert.equal(busy.code, "busy");
	assert.equal(busy.details.executionId, first.executionId);
	assert.equal((await client.request("status")).current.executionId, first.executionId);
	assert.ok((await client.request("journal", { since: 1 })).events.length > 0);
	// Once it runs, nothing changes until it ends, so a short wait times out.
	let running = first;
	while (running.state !== "running") running = await client.request("wait", { executionId: first.executionId, since: running.version, timeoutMs: 5000 });
	await sleep(50);
	running = await client.request("lookup", { executionId: first.executionId });
	const waited = await client.request("wait", { executionId: first.executionId, since: running.version, timeoutMs: 50 });
	assert.equal(waited.timedOut, true);
	assert.equal(waited.state, "running");
	let done = waited;
	while (!TERMINAL.has(done.state)) done = await client.request("wait", { executionId: first.executionId, since: done.version, timeoutMs: 5000 });
	assert.equal(done.state, "completed");
	assert.equal((await runToEnd(client, lifetimeId, "print:next")).output.text, "next");
});

test("a request for another kernel lifetime is refused", async (t) => {
	const { client } = await started(t);
	await assert.rejects(client.request("execute", { lifetimeId: "not-this-kernel", submissionId: submissionId(), code: "print:x" }), (e) => e.code === "lifetime-changed");
	await assert.rejects(client.request("input", { lifetimeId: "not-this-kernel", token: "x", text: "1" }), (e) => e.code === "lifetime-changed");
});

test("a READ waits with a one-use token; bad answers are refused, and racing answers settle once", async (t) => {
	const { helper, client, lifetimeId } = await started(t);
	const waiting = await runToEnd(client, lifetimeId, "read", { untilInput: true });
	assert.equal(waiting.state, "waiting-input");
	assert.match(waiting.input.token, /^[0-9a-f]{32}$/);
	assert.equal(waiting.input.prompt, "? ");
	await assert.rejects(client.request("input", { lifetimeId, token: "0".repeat(32), text: "1" }), (e) => e.code === "invalid-token");
	await assert.rejects(client.request("input", { lifetimeId, token: waiting.input.token, text: "4\n2" }), (e) => e.code === "invalid-input" && !e.message.includes("4\n2"));
	await assert.rejects(client.request("input", { lifetimeId, token: waiting.input.token, text: "\x04" }), (e) => e.code === "invalid-input");
	// Still answerable after refused answers; two clients race for the token.
	const other = await HelperClient.connect(helper.paths.socket);
	defer(t, () => other.close());
	const answers = await Promise.allSettled([
		client.request("input", { lifetimeId, token: waiting.input.token, text: "42\r\n" }),
		other.request("input", { lifetimeId, token: waiting.input.token, text: "43" }),
	]);
	const won = answers.filter((a) => a.status === "fulfilled");
	assert.equal(won.length, 1);
	assert.equal(answers.find((a) => a.status === "rejected").reason.code, "invalid-token");
	let done = won[0].value;
	while (!TERMINAL.has(done.state)) done = await client.request("wait", { executionId: done.executionId, since: done.version, timeoutMs: 5000 });
	assert.match(done.output.text, /^got 4[23]$/);
	assert.equal(done.output.text, answers[0].status === "fulfilled" ? "got 42" : "got 43");
	// Empty and space-only answers are records.
	for (const [text, expected] of [["", "got "], ["  ", "got   "], ["s3cret-answer", "got s3cret-answer"]]) {
		const read = await runToEnd(client, lifetimeId, "read", { untilInput: true });
		let result = await client.request("input", { lifetimeId, token: read.input.token, text });
		while (!TERMINAL.has(result.state)) result = await client.request("wait", { executionId: result.executionId, since: result.version, timeoutMs: 5000 });
		assert.equal(result.output.text, expected);
	}
	const journal = await client.request("journal", { since: 1, limit: 1000 });
	// Input events carry no values: only their kind, event and execution.
	for (const event of journal.events.filter((e) => e.kind === "input")) assert.deepEqual(Object.keys(event).sort(), ["at", "event", "executionId", "kind", "seq"]);
	// An answer appears only where the program itself echoed it, in its output.
	const notOutput = journal.events.filter((e) => !(e.kind === "iopub" && e.msgType === "stream"));
	assert.ok(!JSON.stringify(notOutput).includes("s3cret-answer"), "the answer isn't journalled");
	assert.ok(journal.events.some((e) => e.msgType === "stream" && e.text === "got s3cret-answer"));
});

test("a READ outlives a client that leaves", async (t) => {
	const { helper, client, lifetimeId } = await started(t);
	const leaving = await HelperClient.connect(helper.paths.socket);
	const waiting = await leaving.request("execute", { lifetimeId, submissionId: submissionId(), code: "read" });
	let snapshot = waiting;
	while (snapshot.state !== "waiting-input") snapshot = await leaving.request("wait", { executionId: snapshot.executionId, since: snapshot.version, timeoutMs: 5000 });
	leaving.close();
	await sleep(200);
	const status = await client.request("status");
	assert.equal(status.current.state, "waiting-input");
	let done = await client.request("input", { lifetimeId, token: status.current.input.token, text: "7" });
	while (!TERMINAL.has(done.state)) done = await client.request("wait", { executionId: done.executionId, since: done.version, timeoutMs: 5000 });
	assert.equal(done.output.text, "got 7");
});

test("the kernel ending mid-cell: buffered output is drained, the cell is unconfirmed, and no more cells are taken", async (t) => {
	const { client, lifetimeId } = await started(t);
	const done = await runToEnd(client, lifetimeId, "exit:3");
	assert.equal(done.state, "unconfirmed");
	assert.equal(done.outcome.exit.code, 3);
	assert.equal(done.outcome.started, true);
	assert.equal(done.output.text, "dying\n");
	const status = await client.request("status");
	assert.equal(status.state, "kernel-exited");
	assert.equal(status.kernel.exit.code, 3);
	await assert.rejects(client.request("execute", { lifetimeId, submissionId: submissionId(), code: "print:x" }), (e) => e.code === "not-accepting");
	const journal = await client.request("journal", { since: 1, limit: 1000 });
	assert.ok(journal.events.some((e) => e.kind === "kernel" && e.event === "exited"));
});

test("the journal holds every received cell, other clients' too, and reports a gap once bounded", async (t) => {
	const { helper, client, lifetimeId } = await started(t, { journal: { maxEvents: 30 } });
	const other = await JupyterClient.connect(readConnectionFile(helper.paths.connection), { timeoutMs: 10_000 });
	defer(t, () => other.close());
	const request = other.prepareExecute("print:from another client");
	const done = waitForExecution(other, request, { timeoutMs: 5000 });
	other.post("shell", request);
	await done;
	await sleep(100);
	const first = await client.request("journal", { since: 1 });
	const input = first.events.find((e) => e.kind === "iopub" && e.msgType === "execute_input" && e.code === "print:from another client");
	assert.ok(input, "another client's cell is journalled");
	assert.equal(input.parentSession, other.session.session);
	assert.equal(input.parentId, request.header.msg_id);
	assert.ok(input.msgId);
	assert.ok(first.events.some((e) => e.msgType === "stream" && e.text === "from another client" && e.raw === true));
	for (let i = 0; i < 6; i++) await runToEnd(client, lifetimeId, `print:${i}`);
	const later = await client.request("journal", { since: 1 });
	assert.ok(later.gap && later.gap.from === 1 && later.gap.to === later.tail - 1, JSON.stringify(later.gap));
	assert.equal(later.generation, lifetimeId);
	const page = await client.request("journal", { since: later.tail, limit: 5 });
	assert.equal(page.events.length, 5);
	assert.equal(page.more, true);
	assert.equal(page.cursor, page.events.at(-1).seq + 1);
	await assert.rejects(client.request("journal", { since: 0 }), (e) => e.code === "invalid-request");
});

test("bad requests get errors, an oversized line closes the connection, and a client that doesn't read is dropped", async (t) => {
	const { helper, client, lifetimeId } = await started(t, { maxRequestBytes: 4096, maxClientBacklogBytes: 1024 * 1024 });
	const raw = net.createConnection(helper.paths.socket);
	await once(raw, "connect");
	let received = "";
	raw.setEncoding("utf8");
	raw.on("data", (chunk) => { received += chunk; });
	raw.write("not json\n");
	raw.write(JSON.stringify({ id: 1, op: "nope" }) + "\n");
	await sleep(100);
	const replies = received.trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(replies.map((r) => r.error.code), ["invalid-json", "unknown-op"]);
	const closed = once(raw, "close");
	raw.write("x".repeat(5000));
	await closed;

	// A complete line over the bound is refused too, and the bound is in bytes, not characters.
	for (const line of ["x".repeat(5000) + "\n", JSON.stringify({ id: 1, op: "hello", params: { pad: "é".repeat(3000) } }) + "\n"]) {
		const socket = net.createConnection(helper.paths.socket);
		await once(socket, "connect");
		let answer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => { answer += chunk; });
		const ended = once(socket, "close");
		socket.write(line);
		await ended;
		assert.equal(JSON.parse(answer.trim()).error.code, "request-too-large", `${line.length} characters`);
	}

	// A client that stops reading is dropped, and the others are still answered.
	await runToEnd(client, lifetimeId, "big:300000");
	const executionId = (await client.request("status")).current.executionId;
	const before = helper.connections.size;
	const stuck = net.createConnection(helper.paths.socket);
	defer(t, () => stuck.destroy());
	await once(stuck, "connect");
	stuck.pause();
	for (let i = 1; i <= 8; i++) stuck.write(JSON.stringify({ id: i, op: "lookup", params: { executionId } }) + "\n");
	const t0 = Date.now();
	assert.equal((await client.request("hello")).lifetimeId, lifetimeId);
	assert.ok(Date.now() - t0 < 1000);
	// A paused socket never reads to its end, so it never sees the close; the helper's side shows the drop.
	await until(() => helper.connections.size === before, { what: "the helper to drop the client that doesn't read" });
});

test("a wait ends with its connection, and connections beyond the bound are closed", async (t) => {
	const { helper, client, lifetimeId } = await started(t, { maxConnections: 4 });
	const running = await client.request("execute", { lifetimeId, submissionId: submissionId(), code: "sleep:1500" });
	const leaving = await HelperClient.connect(helper.paths.socket);
	const waiting = leaving.request("wait", { executionId: running.executionId, since: running.version + 100, timeoutMs: 60_000 }).catch((e) => e);
	await until(() => helper.waiters.size === 1, { what: "the wait" });
	leaving.close();
	assert.match((await waiting).message, /closed/);
	await until(() => helper.waiters.size === 0 && helper.connections.size === 1, { what: "the wait to end with its connection" });

	const others = await Promise.all([1, 2, 3].map(() => HelperClient.connect(helper.paths.socket)));
	defer(t, () => others.forEach((other) => other.close()));
	for (const other of others) await other.request("hello");
	const over = await HelperClient.connect(helper.paths.socket);
	defer(t, () => over.close());
	await assert.rejects(over.request("hello", {}, { timeoutMs: 2000 }), /closed/);
});

test("a client fails its requests, without throwing, on a malformed or oversized response; pending requests are bounded", async (t) => {
	const dir = privateDir(t);
	const path = join(dir, "fake.sock");
	const unprintable = { code: { toString: null }, message: { toString: null } };
	const replies = ["null\n", "x".repeat(2000) + "\n", JSON.stringify({ id: null, ok: false, error: unprintable }) + "\n", JSON.stringify({ id: 1, ok: false, error: unprintable }) + "\n"];
	let n = 0;
	const server = net.createServer((socket) => {
		let reply = replies[n++];
		socket.on("error", () => {});
		// Always reading, so that the server sees each client's end.
		socket.on("data", () => {
			if (reply) socket.write(reply);
			reply = null;
		});
	});
	await new Promise((resolve) => server.listen(path, resolve));
	defer(t, () => new Promise((resolve) => server.close(resolve)));
	// Each client is closed, or the server's close in the cleanup waits for it.
	const connect = async (options) => {
		const client = await HelperClient.connect(path, options);
		defer(t, () => client.close());
		return client;
	};
	const malformed = await connect();
	await assert.rejects(malformed.request("hello"), /malformed/);
	const oversized = await connect({ maxResponseBytes: 1024 });
	await assert.rejects(oversized.request("hello"), /over 1024 bytes/);
	// Error fields that aren't strings get fixed text, and nothing throws from the reader.
	const unreadable = await connect();
	await assert.rejects(unreadable.request("hello"), (e) => e.code === "error" && /refused a request/.test(e.message));
	const refused = await connect();
	await assert.rejects(refused.request("hello"), (e) => e.code === "error" && /refused the request/.test(e.message));
	const silent = await connect({ maxPending: 1 });
	const hanging = silent.request("hello", {}, { timeoutMs: 5000 }).catch((e) => e);
	await assert.rejects(silent.request("hello"), /Too many requests/);
	silent.close();
	assert.match((await hanging).message, /closed/);
});

test("an execution completes on its reply and idle in either order; an aborted reply, and an invalid one", async (t) => {
	const { helper, deliver, execute } = stubbed(t);
	const run = (order, status = "ok") => {
		const { executionId, requestId } = execute();
		deliver("iopub", "status", { execution_state: "busy" }, requestId);
		if (status !== "aborted") deliver("iopub", "execute_input", { code: "x", execution_count: 1 }, requestId);
		const parts = [() => deliver("iopub", "status", { execution_state: "idle" }, requestId), () => deliver("shell", "execute_reply", { status }, requestId)];
		if (order === "reply-first") parts.reverse();
		parts[0]();
		assert.equal(helper.lookup({ executionId }).state, "running", order);
		parts[1]();
		return helper.lookup({ executionId });
	};
	for (const order of ["idle-first", "reply-first"]) {
		const done = run(order);
		assert.deepEqual([done.state, done.status, done.started], ["completed", "ok", true], order);
	}
	const aborted = run("idle-first", "aborted");
	assert.deepEqual([aborted.state, aborted.status, aborted.started], ["completed", "aborted", false]);
	const invalid = run("idle-first", "maybe");
	assert.equal(invalid.state, "unconfirmed");
	assert.match(invalid.outcome.reason, /no valid status \(maybe\)/);
	// A settled execution without a spool being written answers a wait at once.
	const t0 = Date.now();
	const waited = await helper.wait({ executionId: invalid.executionId, since: invalid.version + 10, timeoutMs: 60_000 });
	assert.equal(waited.state, "unconfirmed");
	assert.ok(Date.now() - t0 < 1000);
});

test("a post the client refuses leaves the execution not-sent, and the session free", (t) => {
	const { client, execute, sent } = stubbed(t);
	client.refuse = 1;
	const refused = execute("print:x");
	assert.equal(refused.state, "not-sent");
	assert.match(refused.outcome.reason, /not sent: the stub refused/);
	assert.equal(sent.length, 0);
	const next = execute("print:y");
	assert.equal(next.state, "submitted");
	assert.equal(sent.length, 1);
});

test("a refused answer keeps its token; each READ of a cell gets its own", (t) => {
	const { helper, client, deliver, execute, sent, lifetimeId } = stubbed(t);
	const { executionId, requestId } = execute("read twice");
	deliver("iopub", "execute_input", { code: "read twice" }, requestId);
	deliver("stdin", "input_request", { prompt: "a? " }, requestId);
	const first = helper.lookup({ executionId }).input;
	client.refuseInput = 1;
	assert.throws(() => helper.input({ lifetimeId, token: first.token, text: "1" }), (e) => e.code === "input-not-sent");
	assert.equal(helper.lookup({ executionId }).input.token, first.token);
	// A token of the right length in characters but not in bytes is refused as a token.
	assert.throws(() => helper.input({ lifetimeId, token: "é".repeat(32), text: "1" }), (e) => e.code === "invalid-token");
	const answered = helper.input({ lifetimeId, token: first.token, text: "1" });
	assert.equal(answered.state, "running");
	assert.equal(answered.input, null);
	deliver("stdin", "input_request", { prompt: "b? " }, requestId);
	const second = helper.lookup({ executionId }).input;
	assert.notEqual(second.token, first.token);
	assert.equal(second.prompt, "b? ");
	assert.throws(() => helper.input({ lifetimeId, token: first.token, text: "2" }), (e) => e.code === "invalid-token");
	helper.input({ lifetimeId, token: second.token, text: "2" });
	assert.deepEqual(sent.filter((s) => s.channel === "stdin").map((s) => s.value), ["1", "2"]);
});

test("messages that arrive after the kernel's exit is known are still drained into the execution", async (t) => {
	const unfinished = stubbed(t, { drainMs: 50 });
	const a = unfinished.execute();
	unfinished.deliver("iopub", "execute_input", {}, a.requestId);
	unfinished.helper.kernelExited({ code: 3, signal: null });
	assert.equal(unfinished.helper.admitting, false);
	unfinished.deliver("iopub", "stream", { name: "stdout", text: "after the exit\n" }, a.requestId);
	await sleep(100);
	const lost = unfinished.helper.lookup({ executionId: a.executionId });
	assert.equal(lost.state, "unconfirmed");
	assert.equal(lost.output.text, "after the exit\n");
	assert.deepEqual([lost.outcome.exit.code, lost.outcome.started], [3, true]);

	// A reply and idle that come within the drain complete it.
	const finished = stubbed(t, { drainMs: 50 });
	const b = finished.execute();
	finished.deliver("iopub", "execute_input", {}, b.requestId);
	finished.helper.kernelExited({ code: 0, signal: null });
	finished.deliver("iopub", "stream", { name: "stdout", text: "done\n" }, b.requestId);
	finished.finish(b.requestId);
	await sleep(100);
	const done = finished.helper.lookup({ executionId: b.executionId });
	assert.deepEqual([done.state, done.status, done.output.text], ["completed", "ok", "done\n"]);
});

test("the connection lost, then the kernel's exit: the outcome stays unconfirmed and learns the exit", async (t) => {
	const { helper, deliver, execute } = stubbed(t, { drainMs: 30 });
	const { executionId, requestId } = execute();
	deliver("iopub", "execute_input", {}, requestId);
	helper.connectionEnded("shell", new Error("reset"));
	assert.equal(helper.state, "connection-lost");
	await sleep(80);
	const settled = helper.lookup({ executionId });
	assert.equal(settled.state, "unconfirmed");
	assert.equal(settled.outcome.exit, null);
	assert.match(settled.outcome.reason, /connection to the kernel was lost \(shell\)/);
	helper.kernelExited({ code: 1, signal: null });
	const later = helper.lookup({ executionId });
	assert.deepEqual([later.state, later.outcome.exit.code, later.outcome.reason], ["unconfirmed", 1, settled.outcome.reason]);
	assert.ok(later.version > settled.version);
	assert.equal(helper.status().state, "kernel-exited");

	// The other order: the exit first, then the connection's loss, changes nothing more.
	const other = stubbed(t, { drainMs: 30 });
	const second = other.execute();
	other.helper.kernelExited({ code: null, signal: "SIGSEGV" });
	other.helper.connectionEnded("iopub", null);
	assert.equal(other.helper.state, "kernel-exited");
	await sleep(80);
	const ended = other.helper.lookup({ executionId: second.executionId });
	assert.deepEqual([ended.state, ended.outcome.exit.signal, ended.outcome.started], ["unconfirmed", "SIGSEGV", false]);
});

test("messages for a settled execution are counted as late, and change nothing", (t) => {
	const { helper, deliver, execute, finish } = stubbed(t);
	const { executionId, requestId } = execute();
	deliver("iopub", "stream", { name: "stdout", text: "early\n" }, requestId);
	finish(requestId);
	const done = helper.lookup({ executionId });
	deliver("iopub", "stream", { name: "stdout", text: "late\n" }, requestId);
	deliver("shell", "execute_reply", { status: "error" }, requestId);
	const after = helper.lookup({ executionId });
	assert.equal(after.late, 2);
	assert.deepEqual([after.output.text, after.status, after.version], [done.output.text, "ok", done.version]);
	assert.ok(helper.journal.read(1).events.some((e) => e.msgType === "stream" && e.text === "late\n"), "the journal keeps it");
});

test("settled executions are kept within bounds; one no longer kept isn't run again", async (t) => {
	const { helper, deliver, finish, sent, lifetimeId } = stubbed(t, { retain: { executions: 2 } });
	const runs = [];
	for (let i = 0; i < 4; i++) {
		const submission = submissionId();
		const { executionId, requestId } = helper.execute({ lifetimeId, submissionId: submission, code: `print:${i}` });
		deliver("iopub", "stream", { name: "stdout", text: `${i}\n` }, requestId);
		const spool = join(helper.dir, `out-${executionId}.txt`);
		assert.ok(existsSync(spool), "the spool is created as output arrives");
		finish(requestId);
		runs.push({ submission, executionId, spool });
	}
	assert.equal(helper.retained.size, 2);
	assert.throws(() => helper.lookup({ executionId: runs[0].executionId }), (e) => e.code === "expired" && e.details.state === "completed");
	const before = sent.length;
	assert.throws(() => helper.execute({ lifetimeId, submissionId: runs[0].submission, code: "print:0" }), (e) => e.code === "expired");
	assert.throws(() => helper.execute({ lifetimeId, submissionId: runs[0].submission, code: "print:other" }), (e) => e.code === "submission-conflict");
	assert.equal(sent.length, before, "nothing was sent again");
	// Its spool file goes with it; a kept one stays.
	await until(() => !existsSync(runs[0].spool) && !existsSync(runs[1].spool), { what: "the spools to be removed" });
	await until(() => existsSync(runs[3].spool) && readFileSync(runs[3].spool, "utf8") === "3\n", { what: "the kept spool" });
	// Every submission ID is remembered, up to the session's limit.
	helper.maxSubmissions = helper.submissions.size;
	assert.throws(() => helper.execute({ lifetimeId, submissionId: submissionId(), code: "x" }), (e) => e.code === "session-limit");

	// The memory and spool bounds evict on their own too; the current execution is always kept.
	for (const retain of [{ bytes: 10 }, { spoolBytes: 3 }]) {
		const bounded = stubbed(t, { retain: { executions: 100, ...retain } });
		for (let i = 0; i < 2; i++) {
			const { requestId } = bounded.execute(`print:${i}`);
			bounded.deliver("iopub", "stream", { name: "stdout", text: `${i}\n` }, requestId);
			bounded.finish(requestId);
		}
		assert.equal(bounded.helper.retained.size, 1, JSON.stringify(retain));
		assert.equal(bounded.helper.current.state, "completed");
	}
});

test("messages with fields that can't be printed don't break an execution", (t) => {
	const { helper, deliver, execute, finish } = stubbed(t);
	const { executionId, requestId } = execute();
	const unprintable = { toString: null };
	deliver("iopub", "stream", { name: unprintable, text: unprintable }, requestId);
	deliver("iopub", "error", { ename: unprintable, evalue: unprintable, traceback: [unprintable] }, requestId);
	deliver("stdin", "input_request", { prompt: unprintable }, requestId);
	finish(requestId);
	const done = helper.lookup({ executionId });
	assert.equal(done.state, "completed");
	assert.equal(done.output.text, "[unprintable]\n[unprintable]\n");
	assert.equal(helper.counts.listenerErrors, 0);
});

test("stop waits for the socket's own close, and cuts short a spool still being written, saying so", async (t) => {
	const { helper } = await started(t);
	// A client that never ends its side holds the close for its 500 ms.
	const holding = net.createConnection({ path: helper.paths.socket, allowHalfOpen: true });
	defer(t, () => holding.destroy());
	await once(holding, "connect");
	await until(() => helper.connections.size === 2, { what: "the connection" });
	const closing = helper.closeServer();
	assert.equal(helper.closeServer(), closing, "a second close joins the first");
	const t0 = Date.now();
	await helper.stop();
	assert.ok(Date.now() - t0 >= 400, "stop waited for the close under way");
	assert.equal(existsSync(helper.paths.socket), false);

	const stub = stubbed(t, { spoolCloseMs: 100 });
	const { executionId, requestId } = stub.execute();
	stub.deliver("iopub", "stream", { name: "stdout", text: "x\n" }, requestId);
	// A spool whose end never comes.
	stub.helper.executions.get(executionId).output.spool.end = () => {};
	const result = await stub.helper.stop();
	assert.deepEqual(result.cleanup, { complete: true, cutSpools: 1 });
	const spool = stub.helper.lookup({ executionId }).output.spool;
	assert.deepEqual([spool.state, spool.full], ["failed", false]);
	assert.match(spool.error, /stopped before the spool was written/);
	assert.match(stub.helper.warnings.at(-1).message, /spool/);
});

test("startup reports ready only if, at that moment, the kernel is alive and its connection whole", async (t) => {
	// The kernel exits after the connection is made, before the socket listens.
	class ExitBeforeListening extends JupyterHelper {
		async listen() {
			process.kill(this.kernel.pid, "SIGKILL");
			await once(this.kernel, "exit");
			return super.listen();
		}
	}
	const exits = new ExitBeforeListening({ dir: privateDir(t), kernelCommand: fakeKernel, startTimeoutMs: 15_000 });
	defer(t, () => exits.stop({ killKernel: true }));
	await assert.rejects(exits.start(), /exited before it was ready \(signal SIGKILL\)/);
	assert.deepEqual([exits.state, exits.admitting], ["failed", false]);
	assert.equal(JSON.parse(readFileSync(exits.paths.ready, "utf8")).state, "failed");

	// The connection is lost as the socket starts listening; the socket is closed again.
	class LostWhileListening extends JupyterHelper {
		async listen() {
			this.client.sockets.shell.close();
			return super.listen();
		}
	}
	const loses = new LostWhileListening({ dir: privateDir(t), kernelCommand: fakeKernel, startTimeoutMs: 15_000 });
	defer(t, () => loses.stop({ killKernel: true }));
	await assert.rejects(loses.start(), /connection to the kernel was lost while listening/);
	assert.equal(JSON.parse(readFileSync(loses.paths.ready, "utf8")).state, "failed");
	assert.equal(existsSync(loses.paths.socket), false);

	// Stopping while it starts cancels the start.
	const stopped = new JupyterHelper({ dir: privateDir(t), kernelCommand: fakeKernel, startTimeoutMs: 15_000 });
	const starting = stopped.start().then(() => null, (error) => error);
	assert.equal((await stopped.stop({ killKernel: true })).kernel, "exited");
	assert.match((await starting).message, /stopped while it started/);
	assert.equal(stopped.state, "stopped");
});

test("a second helper for the same directory changes nothing of the first's", async (t) => {
	const { dir, helper, client, lifetimeId } = await started(t);
	const ready = readFileSync(helper.paths.ready, "utf8");
	const log = statSync(helper.paths.kernelLog);
	const second = new JupyterHelper({ dir, kernelCommand: fakeKernel, startTimeoutMs: 15_000 });
	await assert.rejects(second.start(), /isn't a new session directory/);
	await second.stop({ killKernel: true });
	assert.equal(second.kernel, undefined, "it started no kernel");
	assert.equal(readFileSync(helper.paths.ready, "utf8"), ready);
	assert.equal(statSync(helper.paths.kernelLog).ino, log.ino);
	assert.ok(lstatSync(helper.paths.socket).isSocket());
	assert.equal((await client.request("hello")).lifetimeId, lifetimeId);
	const fresh = await HelperClient.connect(helper.paths.socket);
	defer(t, () => fresh.close());
	assert.equal((await fresh.request("hello")).launchId, helper.launchId);
});

test("a directory with a helper's files left in it is refused and left as it was", async (t) => {
	const dir = privateDir(t);
	const stale = join(dir, "h.sock");
	// A listener killed before it can unlink its socket leaves a stale one.
	spawnSync(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(stale)}, () => process.kill(process.pid, "SIGKILL"))`]);
	assert.ok(lstatSync(stale).isSocket());
	const helper = new JupyterHelper({ dir, kernelCommand: fakeKernel });
	await assert.rejects(helper.start(), /isn't a new session directory: h\.sock exists/);
	await helper.stop();
	assert.ok(lstatSync(stale).isSocket());
	assert.equal(existsSync(join(dir, "ready.json")), false);
	assert.equal(existsSync(join(dir, "kernel.log")), false);
	// A dangling symbolic link counts as a file left there.
	const linked = privateDir(t);
	symlinkSync("/nonexistent-target", join(linked, "k.json"));
	const refused = new JupyterHelper({ dir: linked, kernelCommand: fakeKernel });
	await assert.rejects(refused.start(), /k\.json exists/);
	await refused.stop();
	assert.ok(lstatSync(join(linked, "k.json")).isSymbolicLink());
});

test("the kernel inherits the owner marker; stop escalates to SIGKILL and reports the kernel's end", async (t) => {
	const launchId = randomBytes(16).toString("hex");
	const helper = new JupyterHelper({
		dir: privateDir(t),
		launchId,
		kernelCommand: (file) => [process.execPath, [FAKE_PROCESS, "kernel", "-f", file, "--ignore-term"]],
		killTimeoutMs: 300,
		startTimeoutMs: 15_000,
	});
	defer(t, () => helper.stop({ killKernel: true }));
	await helper.start();
	assert.equal(JSON.parse(readFileSync(helper.paths.connection, "utf8")).owner, launchId);
	const client = await HelperClient.connect(helper.paths.socket);
	defer(t, () => client.close());
	const running = await client.request("execute", { lifetimeId: helper.lifetimeId, submissionId: submissionId(), code: "sleep:5000" });
	const waiting = client.request("wait", { executionId: running.executionId, since: running.version + 100, timeoutMs: 60_000 });
	await until(() => helper.waiters.size === 1, { what: "the wait" });
	const t0 = Date.now();
	const result = await helper.stop({ killKernel: true });
	// A wait is answered as the helper stops, with the execution's end.
	const answered = await waiting;
	assert.deepEqual([answered.state, answered.outcome.reason], ["unconfirmed", "the helper stopped"]);
	assert.equal(result.kernel, "exited");
	assert.equal(result.exit.signal, "SIGKILL");
	assert.deepEqual(result.cleanup, { complete: true, cutSpools: 0 });
	assert.ok(Date.now() - t0 >= 250, "SIGTERM was given its time first");
	assert.equal(existsSync(helper.paths.socket), false);
	assert.equal((await helper.stop({ killKernel: true })).kernel, "exited");
	assert.throws(() => new JupyterHelper({ dir: "/tmp", kernelCommand: fakeKernel, launchId: "not-a-marker" }), /32 lowercase hex/);
});

test("a kernel that fails to start makes start reject, with ready.json saying why", async (t) => {
	const dir = privateDir(t);
	const helper = new JupyterHelper({ dir, kernelCommand: () => [process.execPath, ["-e", "process.exit(5)"]], startTimeoutMs: 5000 });
	await assert.rejects(helper.start(), /exited before it was ready \(status 5\)/);
	await helper.stop();
	const ready = JSON.parse(readFileSync(join(dir, "ready.json"), "utf8"));
	assert.equal(ready.state, "failed");
	assert.match(ready.reason, /status 5/);
	assert.equal(existsSync(join(dir, "h.sock")), false);
});

test("the session directory must be private", async (t) => {
	const dir = privateDir(t);
	spawnSync("chmod", ["755", dir]);
	const helper = new JupyterHelper({ dir, kernelCommand: fakeKernel });
	await assert.rejects(helper.start(), /private directory/);
	assert.equal(existsSync(join(dir, "ready.json")), false, "a directory that isn't this launch's gets no marker");
});

/** A record.json for a writer, in a private directory of its own: { dir, path, recordId, root, identity, owner }. */
function recordFile(t, fields = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-repl-record-writer-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const named = {
		recordId: randomBytes(16).toString("hex"), root: join(dir, "records"), owner: randomBytes(16).toString("hex"),
		identity: { sessionName: "pi-repl-lfortran", tmuxSessionId: "$1", tmuxSessionCreatedAt: 1793317832, runtime: "lfortran" },
		...fields,
	};
	writeFileSync(join(dir, "record.json"), JSON.stringify(named), { mode: 0o600 });
	return { dir, path: join(dir, "record.json"), ...named };
}

const recordedCell = (fields = {}) => ({
	id: "e1", recordKey: "tool:abc", recordRequestId: "tool:abc", state: "running", label: "Claude Code", mode: "agent", code: "print *, 1",
	submittedAt: Date.now(), output: { text: () => fields.text ?? "", truncated: false }, ...fields,
});

test("the record writer writes an entry per execution in a thread of its own, and never changes a settled one back", async (t) => {
	const file = recordFile(t);
	const warnings = [];
	const writer = new RecordWriter(file.path, { owner: file.owner, warn: (message) => warnings.push(message) });
	t.after(() => writer.close(1000));
	const entries = () => readReplSessionRecord(file.recordId, file.identity, { root: file.root })?.entries ?? [];
	const entry = (id) => entries().find((e) => e.id === id);
	writer.queue(recordedCell());
	await writer.drain(5000);
	assert.deepEqual(["status", "completedAt", "mode", "label", "requestId", "runtime"].map((key) => entry("pi-repl:tool:abc")[key]), ["sent", null, "agent", "Claude Code", "tool:abc", "lfortran"]);
	writer.queue(recordedCell({ state: "completed", status: "error", reply: { status: "error", ename: "Error", evalue: "it failed" }, settledAt: Date.now(), text: "partial\n" }));
	await writer.drain(5000);
	assert.deepEqual([entry("pi-repl:tool:abc").status, entry("pi-repl:tool:abc").output], ["captured", "partial\n[The cell failed: Error: it failed]"]);
	assert.ok(entry("pi-repl:tool:abc").completedAt);
	// A settled entry is never changed back.
	writer.queue(recordedCell());
	await writer.drain(5000);
	assert.equal(entry("pi-repl:tool:abc").status, "captured");
	// Skipped and unconfirmed cells; a cell that wasn't sent isn't recorded.
	writer.queue(recordedCell({ id: "e2", recordKey: "tool:skipped", state: "completed", status: "aborted", reply: { status: "aborted" }, settledAt: Date.now() }));
	writer.queue(recordedCell({ id: "e3", recordKey: "tool:lost", state: "unconfirmed", outcome: { exit: { signal: "SIGSEGV" }, started: true }, settledAt: Date.now(), text: "before\n" }));
	writer.queue(recordedCell({ id: "e4", recordKey: "tool:refused", state: "not-sent" }));
	await writer.drain(5000);
	assert.equal(entry("pi-repl:tool:skipped").output, "Not run: a cell before it failed, so LFortran skipped it (stop_on_error).");
	assert.deepEqual([entry("pi-repl:tool:lost").status, entry("pi-repl:tool:lost").output], ["error", "before\n[Outcome unconfirmed: the kernel exited (signal SIGSEGV); it had started.]"]);
	assert.equal(entry("pi-repl:tool:refused"), undefined);
	assert.deepEqual(warnings, []);
});

test("the record writer never stalls the helper while another writer holds the record, and warns once when it can't write", async (t) => {
	const file = recordFile(t);
	const warnings = [];
	const writer = new RecordWriter(file.path, { owner: file.owner, warn: (message) => warnings.push(message) });
	t.after(() => writer.close(1000));
	// Another writer holds the record's lock, as Studio or pi-repl may.
	mkdirSync(file.root, { recursive: true, mode: 0o700 });
	const lock = join(file.root, `${file.recordId}.record.lock`);
	mkdirSync(lock, { mode: 0o700 });
	writeFileSync(join(lock, "owner.json"), JSON.stringify({ token: "other", pid: process.pid, createdAt: Date.now() }));
	writer.queue(recordedCell());
	const started = Date.now();
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.ok(Date.now() - started < 200, `a 25 ms timer took ${Date.now() - started} ms while the write waited`);
	rmSync(lock, { recursive: true, force: true });
	await writer.drain(10_000);
	assert.equal(readReplSessionRecord(file.recordId, file.identity, { root: file.root }).entries[0].status, "sent");
	assert.deepEqual(warnings, []);

	// A record it can't write to: one warning, until a write succeeds.
	const blocked = recordFile(t);
	writeFileSync(blocked.root, "");
	const failing = new RecordWriter(blocked.path, { owner: blocked.owner, warn: (message) => warnings.push(message) });
	t.after(() => failing.close(1000));
	failing.queue(recordedCell({ recordKey: "tool:f1" }));
	failing.queue(recordedCell({ recordKey: "tool:f2" }));
	await failing.drain(5000);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /^the shared record couldn't be written \(.+\); this cell's entry may be missing or out of date\.$/);
});

test("the record writer uses only record.json written for its launch, as a regular file, never following a link or blocking", async (t) => {
	const file = recordFile(t);
	const tried = async (path, owner, setup) => {
		const warnings = [];
		setup?.();
		const writer = new RecordWriter(path, { owner, warn: (message) => warnings.push(message) });
		t.after(() => writer.close(1000));
		writer.queue(recordedCell());
		await writer.drain(2000);
		return warnings;
	};
	assert.match((await tried(file.path, "another-launch"))[0], /^record\.json can't be used \(it was written for another launch\), so cells aren't recorded\.$/);
	const link = join(file.dir, "link.json");
	assert.match((await tried(link, file.owner, () => symlinkSync(file.path, link)))[0], /^record\.json can't be used/);
	const fifo = join(file.dir, "fifo.json");
	const made = spawnSync("mkfifo", [fifo]);
	if (made.status === 0) {
		const before = Date.now();
		assert.match((await tried(fifo, file.owner))[0], /^record\.json can't be used \(.*isn't a regular file/);
		assert.ok(Date.now() - before < 1000, "a FIFO doesn't block the read");
	}
	// Without record.json, nothing is written and nothing is said.
	assert.deepEqual(await tried(join(file.dir, "missing.json"), file.owner), []);
	assert.equal(readReplSessionRecord(file.recordId, file.identity, { root: file.root }), null);
});

test("a requestId names one cell's record entry: a second cell with it is refused before anything is sent", async (t) => {
	const { helper, sent, finish } = stubbed(t);
	helper.execute({ lifetimeId: helper.lifetimeId, submissionId: "first-cell-1", code: "print:a", requestId: "tool:same" });
	const posted = sent.length;
	assert.throws(() => helper.execute({ lifetimeId: helper.lifetimeId, submissionId: "second-cell-2", code: "print:b", requestId: "tool:same" }), (error) => error.code === "duplicate-request");
	assert.equal(sent.length, posted, "nothing was sent for the second cell");
	assert.throws(() => helper.execute({ lifetimeId: helper.lifetimeId, submissionId: "third-cell-3", code: "print:c", requestId: "line\nbreak" }), (error) => error.code === "invalid-request");
	assert.throws(() => helper.execute({ lifetimeId: helper.lifetimeId, submissionId: "third-cell-4", code: "print:c", requestId: " padded" }), (error) => error.code === "invalid-request");
	assert.throws(() => helper.execute({ lifetimeId: helper.lifetimeId, submissionId: "fourth-cell-4", code: "print:d", mode: "other" }), (error) => error.code === "invalid-request");
	// A request ID spelled like another's derived key belongs to a different cell: it isn't refused as a duplicate.
	finish(sent[0].message.header.msg_id);
	helper.execute({ lifetimeId: helper.lifetimeId, submissionId: "nested-cell-5", code: "print:e", requestId: "tool:call_parent/1" });
	finish(sent.at(-1).message.header.msg_id);
	const spelled = helper.execute({ lifetimeId: helper.lifetimeId, submissionId: "spelled-cell-6", code: "print:f", requestId: recordEntryKey("tool:call_parent/1") });
	assert.equal(spelled.state, "submitted");
});

test("a request ID an entry ID can't hold, such as a nested tool call's, gets a stable key of its own", () => {
	assert.equal(recordEntryKey("tool:call_1"), "tool:call_1");
	const nested = recordEntryKey("tool:call_parent/1");
	assert.match(nested, /^hashed:tool:call_parent_1\.[0-9a-f]{20}$/);
	assert.equal(recordEntryKey("tool:call_parent/1"), nested, "the same request ID, the same key");
	assert.notEqual(recordEntryKey("tool:call_parent_1"), nested, "IDs that read alike once made safe keep apart");
	// A request ID spelled like another's derived key is never taken as it is.
	assert.notEqual(recordEntryKey(nested), nested);
	assert.match(recordEntryKey(nested), /^hashed:hashed:tool:call_parent_1\.[0-9a-f]{20}\.[0-9a-f]{20}$/);
	const spelledLikeOldKey = nested.slice("hashed:".length);
	assert.equal(recordEntryKey(spelledLikeOldKey), spelledLikeOldKey, "without the prefix, it's an ordinary request ID");
	assert.notEqual(recordEntryKey(spelledLikeOldKey), nested);
	assert.notEqual(recordEntryKey("tool:a/b"), recordEntryKey("tool:a\\b"));
	assert.ok(`pi-repl:${recordEntryKey("x/".repeat(150))}`.length <= 240);
});
