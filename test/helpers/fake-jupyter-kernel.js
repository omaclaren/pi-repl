// A small Jupyter kernel for testing shared/repl-jupyter.js. Its ZMTP framing
// and message signing are written independently of the client's, so that a
// bug in the client's codec can't hide itself by matching the same bug here.
// Channels: shell, stdin and control are ROUTER, IOPub is PUB (it publishes
// only to subscribers), and heartbeat only accepts connections.
//
// execute_request code it understands:
//   print:<text>   a stdout stream of <text>
//   read           an input_request to the client, then "got <value>"
//   fail           an error, and an execute_reply with status "error"
//   big:<n>        a stdout stream of n "x"s
//   badsig         a stream with a bad signature, then a good one
//   reply-first    the execute_reply before the idle status
//   sleep:<ms>     waits before replying, without reading other requests
//   abort          an execute_reply with status "aborted", without running
//   foreign-idle   an idle status for another request, then "real" 100 ms later
//   ansi, cr, split-escape, display, clear   output for terminal-text cleaning
//   exit:<n>       "dying", then onExit(n), as a runtime error ends LFortran's kernel
import { createHmac, randomUUID } from "node:crypto";
import net from "node:net";

const DELIMITER = "<IDS|MSG>";

function frame(body, more, command = false) {
	const data = Buffer.from(body);
	const flags = (more ? 1 : 0) | (command ? 4 : 0);
	if (data.length < 256) return Buffer.concat([Buffer.from([flags, data.length]), data]);
	const header = Buffer.alloc(9);
	header[0] = flags | 2;
	header.writeUInt32BE(Math.floor(data.length / 2 ** 32), 1);
	header.writeUInt32BE(data.length % 2 ** 32, 5);
	return Buffer.concat([header, data]);
}

function readyCommand(socketType) {
	const value = Buffer.from(socketType);
	const size = Buffer.alloc(4);
	size.writeUInt32BE(value.length);
	return frame(Buffer.concat([Buffer.from([5]), Buffer.from("READY"), Buffer.from([11]), Buffer.from("Socket-Type"), size, value]), false, true);
}

function greeting() {
	const g = Buffer.alloc(64);
	g[0] = 0xff;
	g[9] = 0x7f;
	g[10] = 3;
	Buffer.from("NULL").copy(g, 12);
	return g;
}

/** One accepted connection: the handshake, then whole messages. */
class Peer {
	constructor(socket, socketType, onMessage, { stall = false } = {}) {
		this.socket = socket;
		this.commands = [];
		this.buffer = Buffer.alloc(0);
		this.state = "greeting";
		this.frames = [];
		this.identity = null;
		this.subscribed = false;
		this.onMessage = onMessage;
		socket.on("error", () => {});
		// A stalled peer accepts the connection and never greets.
		if (stall) return;
		socket.write(greeting());
		socket.on("data", (chunk) => {
			this.buffer = Buffer.concat([this.buffer, chunk]);
			this.pump(socketType);
		});
		socket.on("error", () => {});
	}

	pump(socketType) {
		if (this.state === "greeting") {
			if (this.buffer.length < 64) return;
			this.buffer = this.buffer.subarray(64);
			this.state = "handshake";
		}
		for (;;) {
			if (this.buffer.length < 2) return;
			const flags = this.buffer[0];
			const long = flags & 2;
			const headerSize = long ? 9 : 2;
			if (this.buffer.length < headerSize) return;
			const size = long ? this.buffer.readUInt32BE(1) * 2 ** 32 + this.buffer.readUInt32BE(5) : this.buffer[1];
			if (this.buffer.length < headerSize + size) return;
			const body = this.buffer.subarray(headerSize, headerSize + size);
			this.buffer = this.buffer.subarray(headerSize + size);
			if (flags & 4) {
				if (this.state === "handshake") {
					// READY: the Identity property, if any, then our own READY.
					let at = 1 + body[0];
					while (at < body.length) {
						const name = body.subarray(at + 1, at + 1 + body[at]).toString().toLowerCase();
						at += 1 + body[at];
						const valueSize = body.readUInt32BE(at);
						at += 4;
						if (name === "identity") this.identity = body.subarray(at, at + valueSize).toString();
						at += valueSize;
					}
					this.socket.write(readyCommand(socketType));
					this.state = "ready";
				} else {
					this.commands.push(Buffer.from(body));
				}
				continue;
			}
			this.frames.push(Buffer.from(body));
			if (flags & 1) continue;
			const frames = this.frames;
			this.frames = [];
			if (socketType === "PUB") {
				if (frames[0]?.[0] === 1) this.subscribed = true;
			} else {
				this.onMessage(this, frames);
			}
		}
	}

	send(frames) {
		this.socket.write(Buffer.concat(frames.map((f, i) => frame(f, i < frames.length - 1))));
	}
}

export async function startFakeKernel({ key = randomUUID(), ignoreFirstKernelInfoPublishes = 0, delayFirstKernelInfoReplyMs = 0, stallChannels = [], onExit } = {}) {
	const session = randomUUID();
	const sign = (parts) => createHmac("sha256", key).update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest("hex");
	const peers = { shell: [], stdin: [], control: [], iopub: [], hb: [] };
	const servers = {};
	const received = [];
	const pendingInput = new Map();
	let kernelInfoPublishes = 0;
	let queue = Promise.resolve();

	const build = (msgType, content, parent, { badSignature = false } = {}) => {
		const header = JSON.stringify({ msg_id: randomUUID(), msg_type: msgType, username: "kernel", session, date: new Date().toISOString(), version: "5.3" });
		const parts = [header, JSON.stringify(parent ?? {}), "{}", JSON.stringify(content)];
		return [DELIMITER, badSignature ? "0".repeat(64) : sign(parts), ...parts];
	};
	const publish = (msgType, content, parent, options) => {
		for (const peer of peers.iopub) if (peer.subscribed) peer.send([`kernel.${session}.${msgType}`, ...build(msgType, content, parent, options)]);
	};
	// A ROUTER takes the routing identity off before it sends, so it isn't on the wire.
	const reply = (peer, msgType, content, parent) => peer.send(build(msgType, content, parent));
	const decode = (frames) => {
		const at = frames.findIndex((f) => f.toString() === DELIMITER);
		const parts = frames.slice(at + 2, at + 6).map((f) => f.toString());
		if (frames[at + 1].toString() !== sign(parts)) return null;
		const [header, parent, metadata, content] = parts.map((p) => JSON.parse(p));
		return { header, parent, metadata, content };
	};

	const askInput = (identity, parent) => new Promise((resolve) => {
		const target = peers.stdin.find((p) => p.identity === identity);
		if (!target) return resolve(null);
		const request = build("input_request", { prompt: "? ", password: false }, parent);
		pendingInput.set(identity, resolve);
		target.send(request);
	});

	const execute = async (peer, message) => {
		const parent = message.header;
		const code = message.content.code;
		publish("status", { execution_state: "busy" }, parent);
		if (code === "abort") {
			reply(peer, "execute_reply", { status: "aborted" }, parent);
			publish("status", { execution_state: "idle" }, parent);
			return;
		}
		publish("execute_input", { code, execution_count: 1 }, parent);
		let status = "ok";
		if (code.startsWith("print:")) publish("stream", { name: "stdout", text: code.slice(6) }, parent);
		else if (code === "read") publish("stream", { name: "stdout", text: `got ${await askInput(peer.identity, parent)}` }, parent);
		else if (code === "fail") {
			status = "error";
			publish("error", { ename: "Error", evalue: "it failed", traceback: ["it failed"] }, parent);
		} else if (code.startsWith("big:")) publish("stream", { name: "stdout", text: "x".repeat(Number(code.slice(4))) }, parent);
		else if (code === "badsig") {
			publish("stream", { name: "stdout", text: "forged" }, parent, { badSignature: true });
			publish("stream", { name: "stdout", text: "genuine" }, parent);
		} else if (code.startsWith("sleep:")) await new Promise((r) => setTimeout(r, Number(code.slice(6))));
		else if (code === "ansi") publish("stream", { name: "stderr", text: "\x1b[31mred\x1b[0m warning\n" }, parent);
		else if (code === "cr") {
			publish("stream", { name: "stdout", text: "50%\r" }, parent);
			publish("stream", { name: "stdout", text: "100%\n" }, parent);
		} else if (code === "split-escape") {
			publish("stream", { name: "stdout", text: "a\x1b[3" }, parent);
			publish("stream", { name: "stdout", text: "1mb\n" }, parent);
		} else if (code === "display") {
			publish("display_data", { data: { "image/png": "iVBOR" }, metadata: {} }, parent);
			publish("execute_result", { data: { "text/plain": "42" }, metadata: {}, execution_count: 1 }, parent);
		} else if (code === "clear") {
			publish("stream", { name: "stdout", text: "x\n" }, parent);
			publish("clear_output", { wait: false }, parent);
			publish("stream", { name: "stdout", text: "y\n" }, parent);
		} else if (code.startsWith("exit:")) {
			publish("stream", { name: "stdout", text: "dying\n" }, parent);
			await new Promise((r) => setTimeout(r, 50));
			onExit?.(Number(code.slice(5)));
			return;
		} else if (code === "foreign-idle") {
			publish("status", { execution_state: "idle" }, { ...parent, msg_id: "another-request" });
			await new Promise((r) => setTimeout(r, 100));
			publish("stream", { name: "stdout", text: "real" }, parent);
		}
		const content = status === "ok" ? { status, execution_count: 1, user_expressions: {}, payload: [] } : { status, execution_count: 1, ename: "Error", evalue: "it failed", traceback: [] };
		if (code === "reply-first") {
			reply(peer, "execute_reply", content, parent);
			await new Promise((r) => setTimeout(r, 50));
			publish("status", { execution_state: "idle" }, parent);
		} else {
			publish("status", { execution_state: "idle" }, parent);
			await new Promise((r) => setTimeout(r, 20));
			reply(peer, "execute_reply", content, parent);
		}
	};

	const onShell = (peer, frames) => {
		const message = decode(frames);
		if (!message) return;
		received.push({ channel: "shell", identity: peer.identity, message });
		queue = queue.then(async () => {
			if (message.header.msg_type === "kernel_info_request") {
				// The first requests' publications can be left out, as a kernel
				// that starts publishing to a new subscriber late would; the
				// first reply can come late.
				const count = kernelInfoPublishes++;
				const publishes = count >= ignoreFirstKernelInfoPublishes;
				if (publishes) publish("status", { execution_state: "busy" }, message.header);
				if (count === 0 && delayFirstKernelInfoReplyMs) await new Promise((r) => setTimeout(r, delayFirstKernelInfoReplyMs));
				reply(peer, "kernel_info_reply", { status: "ok", protocol_version: "5.3", implementation: "fake" }, message.header);
				if (publishes) publish("status", { execution_state: "idle" }, message.header);
			} else if (message.header.msg_type === "execute_request") {
				await execute(peer, message);
			}
		});
	};
	const onStdin = (peer, frames) => {
		const message = decode(frames);
		if (!message) return;
		received.push({ channel: "stdin", identity: peer.identity, message });
		const resolve = pendingInput.get(peer.identity);
		if (resolve && message.header.msg_type === "input_reply") {
			pendingInput.delete(peer.identity);
			resolve(message.content.value);
		}
	};
	const handlers = { shell: [onShell, "ROUTER"], stdin: [onStdin, "ROUTER"], control: [(peer, frames) => received.push({ channel: "control", identity: peer.identity, message: decode(frames) }), "ROUTER"], iopub: [() => {}, "PUB"], hb: [() => {}, "REP"] };
	const ports = {};
	for (const [channel, [onMessage, socketType]] of Object.entries(handlers)) {
		const server = net.createServer((socket) => peers[channel].push(new Peer(socket, socketType, onMessage, { stall: stallChannels.includes(channel) })));
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		servers[channel] = server;
		ports[channel] = server.address().port;
	}
	return {
		connection: { ip: "127.0.0.1", ports, key, signatureScheme: "hmac-sha256" },
		key,
		ports,
		received,
		peers,
		publish,
		/** Sends a ZMTP PING to the clients connected to `channel`; their PONGs land in each peer's `commands`. */
		ping(channel, context) {
			const body = Buffer.concat([Buffer.from([4]), Buffer.from("PING"), Buffer.from([0, 100]), Buffer.from(context)]);
			for (const peer of peers[channel]) peer.socket.write(frame(body, false, true));
		},
		/** Ends every connection to `channel`, as if that channel had failed. */
		dropChannel(channel) {
			for (const peer of peers[channel]) peer.socket.destroy();
		},
		async close() {
			for (const list of Object.values(peers)) for (const peer of list) peer.socket.destroy();
			await Promise.all(Object.values(servers).map((server) => new Promise((resolve) => server.close(resolve))));
		},
	};
}
