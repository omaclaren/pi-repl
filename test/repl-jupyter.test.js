import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FrameReader,
	JupyterClient,
	JupyterMessageError,
	JupyterSession,
	ZmtpError,
	ZmtpSocket,
	buildCommand,
	buildGreeting,
	encodeFrame,
	encodeMessage,
	parseCommand,
	parseGreeting,
	readConnectionFile,
	waitForExecution,
} from "../shared/repl-jupyter.js";
import { startFakeKernel } from "./helpers/fake-jupyter-kernel.js";

const frames = (reader) => {
	const out = [];
	for (let f; (f = reader.next());) out.push(f);
	return out;
};

/** A ZmtpSocket past its handshake, with a stand-in for its TCP socket. */
function readySocket(type = "DEALER", options = {}, { writableLength = 0 } = {}) {
	const socket = new ZmtpSocket(type, options);
	const written = [];
	socket.socket = { write: (data) => { written.push(Buffer.from(data)); return true; }, destroy() {}, cork() {}, uncork() {}, writableLength };
	socket.state = "ready";
	const events = { messages: [], closes: [] };
	socket.on("message", (m) => events.messages.push(m));
	socket.on("close", (e) => events.closes.push(e));
	return { socket, written, events };
}

test("the greeting and READY match RFC 23's bytes, not just a round trip", () => {
	const expected = Buffer.concat([
		Buffer.from([0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0x7f, 3, 0]),
		Buffer.from("NULL"), Buffer.alloc(16),
		Buffer.from([0]), Buffer.alloc(31),
	]);
	assert.ok(buildGreeting().equals(expected), "signature, version 3.0, NULL, as-server 0, filler");
	assert.deepEqual(parseGreeting(expected), { major: 3, minor: 0 });
	const ready = encodeFrame(buildCommand("READY", { "Socket-Type": "DEALER" }), { command: true });
	const literal = Buffer.concat([Buffer.from([0x04, 0x1c, 0x05]), Buffer.from("READY"), Buffer.from([0x0b]), Buffer.from("Socket-Type"), Buffer.from([0, 0, 0, 6]), Buffer.from("DEALER")]);
	assert.ok(ready.equals(literal));
	// A later version is accepted (RFC 23 asks for that); earlier ones and other mechanisms aren't.
	const later = Buffer.from(expected);
	later[11] = 1;
	assert.deepEqual(parseGreeting(later), { major: 3, minor: 1 });
	const unsigned = Buffer.from(expected);
	unsigned[0] = 0;
	assert.throws(() => parseGreeting(unsigned), /signature/);
	const old = Buffer.from(expected);
	old[10] = 2;
	assert.throws(() => parseGreeting(old), /ZMTP 2/);
	const curve = Buffer.from(expected);
	curve.fill(0, 12, 32);
	curve.write("CURVE", 12);
	assert.throws(() => parseGreeting(curve), /CURVE/);
});

test("frames are read whole however the bytes arrive, with 1- and 8-byte lengths", () => {
	const long = Buffer.alloc(300, 7);
	const wire = encodeMessage([Buffer.from("a"), long, Buffer.alloc(0)]);
	assert.deepEqual([...wire.subarray(0, 3)], [1, 1, 0x61]);
	assert.equal(wire[3], 0x03, "MORE and LONG on the long frame");
	for (const step of [1, 7, wire.length]) {
		const reader = new FrameReader();
		const got = [];
		for (let i = 0; i < wire.length; i += step) {
			reader.push(wire.subarray(i, i + step));
			got.push(...frames(reader));
		}
		assert.deepEqual(got.map((f) => [f.more, f.command, f.body.length]), [[true, false, 1], [true, false, 300], [false, false, 0]]);
		assert.ok(got[1].body.equals(long));
	}
});

test("a body in many small chunks after a split header is read in linear time", () => {
	const body = Buffer.alloc(200_000, 9);
	const wire = encodeFrame(body);
	const reader = new FrameReader();
	const started = performance.now();
	reader.push(wire.subarray(0, 4));
	assert.equal(reader.next(), null);
	for (let i = 4; i < wire.length; i++) {
		reader.push(wire.subarray(i, i + 1));
		if (i < wire.length - 1) assert.equal(reader.next(), null);
	}
	const frame = reader.next();
	assert.ok(frame.body.equals(body));
	// Quadratic copying would take minutes here.
	assert.ok(performance.now() - started < 3000, `took ${Math.round(performance.now() - started)} ms`);
});

test("a frame over the bound, reserved flags, and a command with MORE are refused", () => {
	const big = new FrameReader({ maxFrameBytes: 100 });
	big.push(encodeFrame(Buffer.alloc(101)));
	assert.throws(() => big.next(), ZmtpError);
	// A length of 2^40 is refused from its header alone, before any body arrives.
	const huge = new FrameReader();
	const header = Buffer.alloc(9);
	header[0] = 0x02;
	header.writeBigUInt64BE(2n ** 40n, 1);
	huge.push(header);
	assert.throws(() => huge.next(), /over the/);
	const reserved = new FrameReader();
	reserved.push(Buffer.from([0x08, 0]));
	assert.throws(() => reserved.next(), /reserved/);
	const command = new FrameReader();
	command.push(Buffer.from([0x05, 0]));
	assert.throws(() => command.next(), /MORE/);
});

test("a message is bounded in frames, and a frame by what is left of the message's budget", () => {
	// Empty frames with MORE carry no bytes; their number is still bounded.
	const many = readySocket("DEALER", { maxMessageFrames: 4 });
	many.socket.receive(Buffer.concat(Array.from({ length: 5 }, () => Buffer.from([0x01, 0]))));
	assert.equal(many.events.closes.length, 1);
	assert.match(many.events.closes[0].message, /more than 4 frames/);
	assert.equal(many.socket.frames.length, 0, "closing drops the frames held");
	// A frame announcing more than the message has left is refused from its header.
	const budget = readySocket("DEALER", { maxMessageBytes: 100 });
	budget.socket.receive(Buffer.concat([encodeFrame(Buffer.alloc(60), { more: true }), Buffer.from([0x00, 60])]));
	assert.match(budget.events.closes[0]?.message ?? "", /over the 40-byte bound/);
	const fine = readySocket("DEALER", { maxMessageBytes: 100 });
	fine.socket.receive(encodeMessage([Buffer.alloc(50), Buffer.alloc(50)]));
	assert.equal(fine.events.messages.length, 1);
});

test("the handshake is read however its bytes arrive, and a stalled peer times out", async (t) => {
	const { socket, written, events } = readySocket();
	socket.state = "greeting";
	const handshake = Buffer.concat([buildGreeting(), encodeFrame(buildCommand("READY", { "Socket-Type": "ROUTER" }), { command: true }), encodeMessage([Buffer.from("hi")])]);
	let ready = 0;
	socket.on("ready", () => ready++);
	for (const byte of handshake) socket.receive(Buffer.from([byte]));
	assert.equal(ready, 1);
	assert.equal(socket.peerSocketType, "ROUTER");
	assert.deepEqual(events.messages.map((m) => m.map(String)), [["hi"]]);
	assert.equal(parseCommand(written[0].subarray(2)).name, "READY", "our READY follows the peer's greeting");

	const kernel = await startFakeKernel({ stallChannels: ["iopub"] });
	t.after(() => kernel.close());
	const started = Date.now();
	await assert.rejects(JupyterClient.connect(kernel.connection, { timeoutMs: 500 }), /no handshake/);
	assert.ok(Date.now() - started < 3000);
});

test("a PING is answered with a PONG carrying its context", async (t) => {
	const { socket, written } = readySocket();
	socket.receive(encodeFrame(Buffer.concat([Buffer.from([4]), Buffer.from("PING"), Buffer.from([0, 10]), Buffer.from("ctx")]), { command: true }));
	assert.deepEqual(parseCommand(written[0].subarray(2)), { name: "PONG", properties: {} });
	assert.ok(written[0].subarray(2).equals(Buffer.concat([Buffer.from([4]), Buffer.from("PONG"), Buffer.from("ctx")])));

	const { kernel, client } = await connected(t);
	kernel.ping("shell", "abc");
	const peer = kernel.peers.shell[0];
	const deadline = Date.now() + 2000;
	while (peer.commands.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
	assert.ok(peer.commands[0]?.equals(Buffer.concat([Buffer.from([4]), Buffer.from("PONG"), Buffer.from("abc")])));
	assert.equal(client.lost, false);
});

test("a PONG to a peer that doesn't read is refused, closing the connection", () => {
	const { socket, written, events } = readySocket("DEALER", { maxWriteBytes: 8 }, { writableLength: 8 });
	socket.receive(encodeFrame(Buffer.concat([Buffer.from([4]), Buffer.from("PING"), Buffer.from([0, 10]), Buffer.from("ctx")]), { command: true }));
	assert.equal(written.length, 0);
	assert.match(events.closes[0]?.message ?? "", /PINGs but doesn't read/);
});

test("messages that came whole before a framing error are still delivered, however the bytes were split", () => {
	const good = encodeMessage([Buffer.from("first")]);
	const bad = Buffer.from([0x08, 0]);
	for (const chunks of [[Buffer.concat([good, bad])], [good, bad]]) {
		const { socket, events } = readySocket();
		const order = [];
		socket.on("message", () => order.push("message"));
		socket.on("close", () => order.push("close"));
		for (const chunk of chunks) socket.receive(chunk);
		assert.deepEqual(events.messages.map((m) => m.map(String)), [["first"]]);
		assert.deepEqual(order, ["message", "close"]);
		assert.match(events.closes[0].message, /reserved/);
	}
});

test("once() listeners run once, a failing listenerError handler stops nothing, and async failures are reported", async () => {
	const { socket } = readySocket();
	let once = 0, after = 0;
	socket.once("message", () => once++);
	socket.receive(encodeMessage([Buffer.from("a")]));
	socket.receive(encodeMessage([Buffer.from("b")]));
	assert.equal(once, 1);
	assert.equal(socket.listenerCount("message"), 1, "the once() listener removed itself, leaving readySocket's own");
	const reported = [];
	socket.on("listenerError", () => { throw new Error("handler bug"); });
	socket.on("listenerError", (error) => reported.push(error.message));
	socket.on("message", () => { throw new Error("sync bug"); });
	socket.on("message", async () => { throw new Error("async bug"); });
	socket.on("message", () => after++);
	const warnings = [];
	const onWarning = (warning) => warnings.push(warning.message);
	process.on("warning", onWarning);
	try {
		socket.receive(encodeMessage([Buffer.from("c")]));
		await new Promise((r) => setTimeout(r, 20));
	} finally {
		process.off("warning", onWarning);
	}
	assert.equal(after, 1, "listeners after the failing ones still ran");
	assert.deepEqual(reported.sort(), ["async bug", "sync bug"]);
	assert.ok(warnings.some((w) => /handler bug/.test(w)), "the failing listenerError handler became a warning");
});

test("a send with one frame over the per-frame bound is refused", () => {
	const { socket, written } = readySocket("DEALER", { maxFrameBytes: 4, maxMessageBytes: 100 });
	assert.throws(() => socket.send([Buffer.from("12345")]), /frame of 5 bytes/);
	assert.equal(written.length, 0);
});

test("frames after the reader drops consumed chunks are still read whole", () => {
	const reader = new FrameReader();
	const bodies = Array.from({ length: 3000 }, (_, i) => Buffer.from(`frame ${i}`));
	const wire = encodeMessage(bodies);
	const got = [];
	for (let i = 0; i < wire.length; i++) {
		reader.push(wire.subarray(i, i + 1));
		got.push(...frames(reader));
	}
	assert.equal(got.length, bodies.length);
	assert.ok(got.every((f, i) => f.body.equals(bodies[i])));
	assert.ok(reader.head < 1100, "the consumed slots were dropped");
});

test("a send over the bound, or to a peer that isn't reading, is refused before anything is written", () => {
	const tooBig = readySocket("DEALER", { maxMessageBytes: 10 });
	assert.throws(() => tooBig.socket.send([Buffer.alloc(20)]), /over the bound; nothing was sent/);
	assert.equal(tooBig.written.length, 0);
	const tooMany = readySocket("DEALER", { maxMessageFrames: 2 });
	assert.throws(() => tooMany.socket.send([Buffer.from("a"), Buffer.from("b"), Buffer.from("c")]), /3 frames/);
	const stuck = readySocket("DEALER", { maxWriteBytes: 100 }, { writableLength: 95 });
	assert.throws(() => stuck.socket.send([Buffer.alloc(10)]), /isn't reading, and nothing was sent/);
	assert.equal(stuck.written.length, 0);
	assert.equal(stuck.socket.state, "ready", "refusing doesn't close the connection");
	const fine = readySocket();
	fine.socket.send([Buffer.from("a"), Buffer.alloc(300)]);
	assert.ok(Buffer.concat(fine.written).equals(encodeMessage([Buffer.from("a"), Buffer.alloc(300)])));
});

test("READY's properties are read by lowercase name, and ERROR gives its reason", () => {
	const ready = parseCommand(buildCommand("READY", { "Socket-Type": "ROUTER", Identity: Buffer.from([0, 1, 2]) }));
	assert.equal(ready.name, "READY");
	assert.equal(ready.properties["socket-type"].toString(), "ROUTER");
	assert.deepEqual([...ready.properties.identity], [0, 1, 2]);
	const reason = Buffer.from("no");
	assert.deepEqual(parseCommand(Buffer.concat([Buffer.from([5]), Buffer.from("ERROR"), Buffer.from([reason.length]), reason])), { name: "ERROR", reason: "no" });
	const truncated = buildCommand("READY", { "Socket-Type": "ROUTER" }).subarray(0, 12);
	assert.throws(() => parseCommand(truncated), /malformed/);
});

test("messages are signed, and a changed part, another key or a missing part is refused", () => {
	const session = new JupyterSession({ key: "secret", username: "tester" });
	const message = session.message("execute_request", { code: "x = 1" }, { parent: { msg_id: "p" } });
	assert.equal(message.header.session, session.session);
	const wire = session.encode(message, [Buffer.from("topic")]);
	const decoded = session.decode(wire);
	assert.deepEqual(decoded.identities.map(String), ["topic"]);
	assert.deepEqual(decoded.content, { code: "x = 1" });
	assert.deepEqual(decoded.parent_header, { msg_id: "p" });

	const changed = [...wire];
	changed[changed.length - 1] = Buffer.from(JSON.stringify({ code: "x = 2" }));
	assert.throws(() => session.decode(changed), /bad signature/);
	assert.throws(() => new JupyterSession({ key: "other" }).decode(wire), /bad signature/);
	assert.throws(() => session.decode(wire.slice(0, -1)), /too few/);
	assert.throws(() => session.decode(wire.slice(2)), /delimiter/);
	const short = [...wire];
	short[2] = Buffer.from("abc");
	assert.throws(() => session.decode(short), JupyterMessageError);

	const unsigned = new JupyterSession({ key: "" });
	const plain = unsigned.encode(unsigned.message("status", { execution_state: "idle" }));
	assert.equal(plain[1].length, 0);
	assert.equal(unsigned.decode(plain).content.execution_state, "idle");
	assert.throws(() => session.decode(plain), /bad signature/);
	const notJson = session.encode(message);
	notJson[5] = Buffer.from("{");
	notJson[1] = Buffer.from(session.sign(notJson.slice(2, 6)));
	assert.throws(() => session.decode(notJson), /JSON/);
	assert.throws(() => new JupyterSession({ signatureScheme: "hmac-md5" }), /unsupported/);
});

test("headers need an ID, a type, a session and a version; binary buffers travel after the parts", () => {
	const session = new JupyterSession({ key: "k" });
	const resign = (header) => {
		const message = session.message("status", { execution_state: "idle" });
		message.header = header;
		return session.encode(message);
	};
	const good = session.message("status", {}).header;
	for (const header of [{ ...good, msg_id: "" }, { ...good, msg_type: "" }, (({ session: _, ...rest }) => rest)(good), (({ version: _, ...rest }) => rest)(good)]) {
		assert.throws(() => session.decode(resign(header)), /malformed header/);
	}
	// An unknown type and an empty parent are fine.
	assert.equal(session.decode(resign({ ...good, msg_type: "comm_open" })).header.msg_type, "comm_open");
	const withBuffers = session.message("comm_msg", { data: {} }, { buffers: [Buffer.from([1, 2, 3]), new Uint8Array([4])] });
	const decoded = session.decode(session.encode(withBuffers));
	assert.deepEqual(decoded.buffers.map((b) => [...b]), [[1, 2, 3], [4]]);
	assert.throws(() => session.encode({ ...withBuffers, buffers: ["text"] }), /bytes/);
});

test("connection files must be private, literal loopback TCP, with five distinct ports and a key", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-repl-jupyter-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const good = { transport: "tcp", ip: "127.0.0.1", shell_port: 5001, iopub_port: 5002, stdin_port: 5003, control_port: 5004, hb_port: 5005, signature_scheme: "hmac-sha256", key: "k", kernel_name: "fortran" };
	const write = (name, value, mode = 0o600) => {
		const path = join(dir, name);
		writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
		chmodSync(path, mode);
		return path;
	};
	const info = readConnectionFile(write("good.json", good));
	assert.deepEqual(info.ports, { shell: 5001, iopub: 5002, stdin: 5003, control: 5004, hb: 5005 });
	assert.equal(info.key, "k");
	assert.equal(info.kernelName, "fortran");
	assert.equal(readConnectionFile(write("v6.json", { ...good, ip: "::1" })).ip, "::1");
	assert.throws(() => readConnectionFile(write("open.json", good, 0o644)), /mode is 644/);
	const target = write("target.json", good);
	symlinkSync(target, join(dir, "link.json"));
	assert.throws(() => readConnectionFile(join(dir, "link.json")), /Unusable/);
	linkSync(target, join(dir, "hard.json"));
	assert.throws(() => readConnectionFile(target), /more than one link/);
	for (const ip of ["10.0.0.2", "127.0.0.300", "localhost", "127.1"]) {
		assert.throws(() => readConnectionFile(write(`ip-${ip}.json`, { ...good, ip })), /loopback/, ip);
	}
	assert.throws(() => readConnectionFile(write("ipc.json", { ...good, transport: "ipc" })), /transport/);
	assert.throws(() => readConnectionFile(write("dup.json", { ...good, hb_port: 5001 })), /same/);
	assert.throws(() => readConnectionFile(write("port.json", { ...good, stdin_port: 70000 })), /stdin_port/);
	assert.throws(() => readConnectionFile(write("scheme.json", { ...good, signature_scheme: "hmac-md5" })), /scheme/);
	assert.throws(() => readConnectionFile(write("nokey.json", { ...good, key: "" })), /no key/);
	assert.throws(() => readConnectionFile(write("text.json", "not json")), /isn't JSON/);
	assert.throws(() => readConnectionFile(write("big.json", " ".repeat(70_000))), /over/);
	// A FIFO with no writer is refused at once, not waited on.
	const fifo = join(dir, "fifo.json");
	execFileSync("mkfifo", [fifo]);
	chmodSync(fifo, 0o600);
	const started = Date.now();
	assert.throws(() => readConnectionFile(fifo), /regular file/);
	assert.ok(Date.now() - started < 1000);
});

async function connected(t, options, clientOptions) {
	const kernel = await startFakeKernel(options);
	let client;
	t.after(async () => {
		client?.close();
		await kernel.close();
	});
	client = await JupyterClient.connect(kernel.connection, { timeoutMs: 10_000, ...clientOptions });
	return { kernel, client };
}

const stdout = (iopub) => iopub.filter((m) => m.header.msg_type === "stream").map((m) => m.content.text).join("");
const run = (client, code, options) => {
	const request = client.prepareExecute(code);
	const done = waitForExecution(client, request, { timeoutMs: 5000, ...options });
	client.post("shell", request);
	return done;
};

test("a client connects, waits until the kernel is ready, and runs a cell", async (t) => {
	const { kernel, client } = await connected(t);
	assert.equal(client.kernelInfo.content.implementation, "fake");
	const { reply, iopub } = await run(client, "print:hello");
	assert.equal(reply.content.status, "ok");
	assert.equal(stdout(iopub), "hello");
	assert.deepEqual(iopub.map((m) => m.header.msg_type), ["status", "execute_input", "stream", "status"]);
	assert.equal(kernel.received.find((r) => r.message.header.msg_type === "execute_request").message.content.allow_stdin, true);
});

test("completion needs both the reply and the idle status, in either order, for this request", async (t) => {
	const { client } = await connected(t);
	const { reply, iopub } = await run(client, "reply-first");
	assert.equal(reply.content.status, "ok");
	assert.equal(iopub.at(-1).content.execution_state, "idle");
	const failed = await run(client, "fail");
	assert.equal(failed.reply.content.status, "error");
	assert.ok(failed.iopub.some((m) => m.header.msg_type === "error"));
	const aborted = await run(client, "abort");
	assert.equal(aborted.reply.content.status, "aborted");
	assert.deepEqual(aborted.iopub.map((m) => m.content.execution_state), ["busy", "idle"]);
	// Another request's idle doesn't finish this one.
	assert.equal(stdout((await run(client, "foreign-idle")).iopub), "real");
});

test("a READ asks this client, on a stdin socket with the shell's identity", async (t) => {
	const { kernel, client } = await connected(t);
	const asked = [];
	const request = client.prepareExecute("read");
	const done = waitForExecution(client, request, {
		timeoutMs: 5000,
		onInputRequest: (input) => {
			asked.push(input.parent_header.msg_id);
			client.input("42", input);
		},
	});
	client.post("shell", request);
	assert.equal(stdout((await done).iopub), "got 42");
	assert.deepEqual(asked, [request.header.msg_id]);
	const shell = kernel.received.find((r) => r.channel === "shell" && r.message.header.msg_type === "execute_request");
	const stdin = kernel.received.find((r) => r.channel === "stdin");
	assert.equal(stdin.identity, shell.identity);
	assert.equal(stdin.identity, client.identity.toString());
});

test("a listener or input callback that throws doesn't close the connection", async (t) => {
	const { client } = await connected(t);
	const errors = [];
	client.on("listenerError", (error, event) => errors.push([event, error.message]));
	client.on("message", () => { throw new Error("listener bug"); });
	assert.equal(stdout((await run(client, "print:still")).iopub), "still");
	assert.ok(errors.length > 0 && errors.every(([event, message]) => event === "message" && message === "listener bug"));
	assert.equal(client.lost, false);
	// Each answers first, so that the kernel's READ doesn't wait for ever behind the test.
	const answerThen = (error) => (input) => { client.input("1", input); throw error; };
	await assert.rejects(run(client, "read", { onInputRequest: answerThen(new Error("callback bug")) }), /callback bug/);
	await assert.rejects(run(client, "read", { onInputRequest: async (input) => answerThen(new Error("async callback bug"))(input) }), /async callback bug/);
	assert.equal(stdout((await run(client, "print:after")).iopub), "after");
	assert.equal(client.lost, false);
});

test("a timed-out wait reports what had arrived", async (t) => {
	const { client } = await connected(t);
	const error = await run(client, "sleep:600", { timeoutMs: 200 }).catch((e) => e);
	assert.match(error.message, /didn't finish within 200 ms/);
	assert.deepEqual(error.iopub.map((m) => m.header.msg_type), ["status", "execute_input"]);
	assert.equal(error.reply, null);
});

test("a badly signed message is dropped and counted, and the rest still arrive", async (t) => {
	const { client } = await connected(t);
	const dropped = [];
	client.on("dropped", (channel, error) => dropped.push([channel, error.message]));
	assert.equal(stdout((await run(client, "badsig")).iopub), "genuine");
	assert.deepEqual(dropped, [["iopub", "Jupyter: a message with a bad signature"]]);
	assert.equal(client.dropped, 1);
});

test("a large output arrives whole, as one message", async (t) => {
	const { client } = await connected(t);
	assert.equal(stdout((await run(client, "big:3000000", { timeoutMs: 10_000 })).iopub).length, 3_000_000);
});

test("readiness retries kernel_info_request until one has both its reply and its IOPub", async (t) => {
	const { kernel } = await connected(t, { ignoreFirstKernelInfoPublishes: 2 }, { readyAttemptMs: 100 });
	assert.ok(kernel.received.filter((r) => r.message.header.msg_type === "kernel_info_request").length >= 3);
});

test("a kernel_info_reply that comes after the next attempt still counts", async (t) => {
	const { kernel, client } = await connected(t, { delayFirstKernelInfoReplyMs: 400 }, { readyAttemptMs: 100 });
	const requests = kernel.received.filter((r) => r.message.header.msg_type === "kernel_info_request");
	assert.ok(requests.length >= 2);
	assert.equal(client.kernelInfo.parent_header.msg_id, requests[0].message.header.msg_id);
});

test("one channel ending loses the client; the others keep receiving until drainMs, then it closes", async (t) => {
	const { kernel, client } = await connected(t, {}, { drainMs: 300 });
	const events = [];
	client.on("channelClose", (channel) => events.push(`channelClose:${channel}`));
	client.on("close", () => events.push("close"));
	client.on("message", (channel, message) => { if (message.content.text === "during the drain") events.push(`message:${channel}`); });
	const dropped = Date.now();
	kernel.dropChannel("control");
	await new Promise((r) => setTimeout(r, 50));
	kernel.publish("stream", { name: "stdout", text: "during the drain" }, { msg_id: "someone-else" });
	const deadline = Date.now() + 3000;
	while (!client.closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
	const closedAfter = Date.now() - dropped;
	assert.deepEqual(events, ["channelClose:control", "message:iopub", ...events.slice(2)]);
	assert.equal(events.at(-1), "close");
	assert.equal(events.filter((e) => e === "close").length, 1);
	assert.ok(closedAfter >= 280, `closed after ${closedAfter} ms, before drainMs`);
	assert.throws(() => client.execute("print:x"), /closed/);
});

test("a channel lost during an execution fails it only if that channel still owes its part", async (t) => {
	// Idle, then IOPub's end, then the reply: the reply still completes it.
	const first = await connected(t);
	const request = first.client.prepareExecute("print:a");
	first.client.on("message", (channel, message) => {
		if (channel === "iopub" && message.parent_header.msg_id === request.header.msg_id && message.content.execution_state === "idle") first.kernel.dropChannel("iopub");
	});
	const done = waitForExecution(first.client, request, { timeoutMs: 5000 });
	first.client.post("shell", request);
	assert.equal((await done).reply.content.status, "ok");
	// Control lost mid-cell: shell and IOPub still bring both parts.
	const second = await connected(t);
	const pending = run(second.client, "sleep:300");
	await new Promise((r) => setTimeout(r, 50));
	second.kernel.dropChannel("control");
	assert.equal((await pending).reply.content.status, "ok");
	// Shell lost before the reply: it can't come.
	const third = await connected(t);
	const lost = run(third.client, "sleep:300");
	await new Promise((r) => setTimeout(r, 50));
	third.kernel.dropChannel("shell");
	await assert.rejects(lost, /closed during the execution/);
});

test("a thrown null, a frozen error or a failing predicate fails the wait, never succeeds it", async (t) => {
	const { client } = await connected(t);
	const answerThen = (thrown) => (input) => { client.input("1", input); throw thrown; };
	const nulled = await run(client, "read", { onInputRequest: answerThen(null) }).then(() => "resolved", (e) => e);
	assert.match(nulled.message, /onInputRequest failed: null/);
	const frozen = Object.freeze(new Error("frozen"));
	const started = Date.now();
	const failed = await run(client, "read", { onInputRequest: answerThen(frozen), timeoutMs: 5000 }).catch((e) => e);
	assert.match(failed.message, /onInputRequest failed: frozen/);
	assert.equal(failed.cause, frozen);
	assert.ok(Date.now() - started < 2000);
	assert.equal(stdout((await run(client, "print:after")).iopub), "after");
	const waiting = client.waitFor(() => { throw new Error("predicate bug"); }, 5000);
	client.execute("print:x");
	await assert.rejects(waiting, /predicate failed: predicate bug/);
});

test("waiting on a client that is already lost fails at once", async (t) => {
	const { client } = await connected(t);
	client.close();
	const started = Date.now();
	await assert.rejects(client.waitFor(() => true, 5000), /closed/);
	await assert.rejects(client.waitForReady({ timeoutMs: 5000 }), /closed/);
	await assert.rejects(waitForExecution(client, client.prepareExecute("print:x"), { timeoutMs: 5000 }), /closed/);
	assert.ok(Date.now() - started < 1000);
});

test("losing the kernel ends a pending execution, and the client closes once", async (t) => {
	const kernel = await startFakeKernel();
	t.after(() => kernel.close());
	const client = await JupyterClient.connect(kernel.connection, { timeoutMs: 10_000, drainMs: 100 });
	t.after(() => client.close());
	let closes = 0;
	client.on("close", () => closes++);
	const pending = run(client, "sleep:500", { timeoutMs: 10_000 });
	await new Promise((resolve) => setTimeout(resolve, 100));
	await kernel.close();
	await assert.rejects(pending, /closed during the execution/);
	const deadline = Date.now() + 2000;
	while (!client.closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
	assert.equal(closes, 1);
	assert.throws(() => client.execute("print:x"), /closed/);
});

test("a socket refuses a peer of the wrong type", async (t) => {
	const kernel = await startFakeKernel();
	t.after(() => kernel.close());
	const sub = new ZmtpSocket("SUB");
	await assert.rejects(sub.connect("127.0.0.1", kernel.ports.shell, { timeoutMs: 5000 }), /SUB socket can't talk to a ROUTER/);
});
