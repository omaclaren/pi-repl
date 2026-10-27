// A Jupyter client with no dependencies, for kernels that share a session with
// a person's own terminal, such as LFortran's built-in kernel
// (`lfortran kernel -f FILE`). It speaks the subset of ZeroMQ that a Jupyter
// client needs: ZMTP 3.0 with the NULL mechanism over TCP
// (https://rfc.zeromq.org/spec/23/), DEALER sockets for shell, control and
// stdin, and a SUB socket for IOPub. Shell and stdin share one Identity, so
// that the kernel's input_request for this client's cell reaches it. Messages
// follow the Jupyter messaging protocol, signed with HMAC-SHA256.
//
// A peer is untrusted until its messages are signed: framing is bounded in
// bytes and in frames before anything is checked, and an error in a listener
// is the listener's, never a reason to close a connection.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import net from "node:net";

export const JUPYTER_PROTOCOL_VERSION = "5.3";
export const ZMTP_GREETING_BYTES = 64;
// A cell's output can arrive as one message of tens of MiB (LFortran sends a
// cell's whole stdout at once), so frames and messages are bounded generously.
export const DEFAULT_MAX_FRAME_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_MESSAGE_BYTES = 512 * 1024 * 1024;
// A Jupyter message has its identities, the delimiter, the signature, four
// parts and any buffers.
export const DEFAULT_MAX_MESSAGE_FRAMES = 256;
// What may wait unsent before a send is refused: the peer isn't reading.
export const DEFAULT_MAX_WRITE_BYTES = 64 * 1024 * 1024;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_CONNECTION_FILE_BYTES = 64 * 1024;
const FLAG_MORE = 0x01, FLAG_LONG = 0x02, FLAG_COMMAND = 0x04;
const DELIMITER = Buffer.from("<IDS|MSG>");
// The socket types each of ours may talk to.
const PEER_TYPES = { DEALER: ["ROUTER", "DEALER"], SUB: ["PUB", "XPUB"] };
const CHANNELS = ["shell", "iopub", "stdin", "control"];

export class ZmtpError extends Error {}
export class JupyterMessageError extends Error {}

function frameHeader(size, { more = false, command = false } = {}) {
	const flags = (more ? FLAG_MORE : 0) | (command ? FLAG_COMMAND : 0);
	if (size <= 255) return Buffer.from([flags, size]);
	const header = Buffer.alloc(9);
	header[0] = flags | FLAG_LONG;
	header.writeBigUInt64BE(BigInt(size), 1);
	return header;
}

/** One ZMTP frame: its flags, a 1- or 8-byte length, and the body. */
export function encodeFrame(body, options) {
	const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
	return Buffer.concat([frameHeader(data.length, options), data]);
}

/** A multipart message: every frame but the last has MORE set. */
export function encodeMessage(frames) {
	return Buffer.concat(frames.map((frame, i) => encodeFrame(frame, { more: i < frames.length - 1 })));
}

/**
 * The 64-byte greeting of ZMTP 3.0. NULL has no roles, so as-server is 0
 * (RFC 23).
 */
export function buildGreeting() {
	const greeting = Buffer.alloc(ZMTP_GREETING_BYTES);
	greeting[0] = 0xff;
	greeting[9] = 0x7f;
	greeting[10] = 3;
	greeting[11] = 0;
	greeting.write("NULL", 12, "ascii");
	return greeting;
}

/** Accepts ZMTP 3.0 or later (RFC 23 asks a peer to accept higher versions) with NULL. */
export function parseGreeting(greeting) {
	if (greeting.length !== ZMTP_GREETING_BYTES || greeting[0] !== 0xff || (greeting[9] & 0x01) !== 0x01) {
		throw new ZmtpError("ZMTP: the peer's greeting has no ZMTP signature");
	}
	if (greeting[10] < 3) throw new ZmtpError(`ZMTP: the peer speaks ZMTP ${greeting[10]}, not 3`);
	const mechanism = greeting.subarray(12, 32).toString("latin1").replace(/\0+$/, "");
	if (mechanism !== "NULL") throw new ZmtpError(`ZMTP: the peer wants the ${JSON.stringify(mechanism)} mechanism, not NULL`);
	return { major: greeting[10], minor: greeting[11] };
}

/** A command's body: its name, then each property's name and value. */
export function buildCommand(name, properties = {}) {
	const parts = [Buffer.from([name.length]), Buffer.from(name, "ascii")];
	for (const [key, value] of Object.entries(properties)) {
		const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
		const size = Buffer.alloc(4);
		size.writeUInt32BE(data.length);
		parts.push(Buffer.from([key.length]), Buffer.from(key, "ascii"), size, data);
	}
	return Buffer.concat(parts);
}

/** A READY's properties, by lowercase name; an ERROR's reason; a PING's context. */
export function parseCommand(body) {
	if (body.length < 1 || body.length < 1 + body[0]) throw new ZmtpError("ZMTP: a malformed command");
	const name = body.subarray(1, 1 + body[0]).toString("latin1");
	let at = 1 + body[0];
	if (name === "ERROR") {
		const size = body[at] ?? 0;
		return { name, reason: body.subarray(at + 1, at + 1 + size).toString("utf8") };
	}
	if (name === "PING") {
		// A 2-byte TTL, then up to 16 bytes of context for the PONG (RFC 37).
		if (body.length < at + 2) throw new ZmtpError("ZMTP: a malformed PING");
		return { name, context: body.subarray(at + 2, at + 2 + 16) };
	}
	const properties = {};
	if (name === "READY") {
		while (at < body.length) {
			const keySize = body[at];
			if (at + 1 + keySize + 4 > body.length) throw new ZmtpError("ZMTP: a malformed READY property");
			const key = body.subarray(at + 1, at + 1 + keySize).toString("latin1").toLowerCase();
			at += 1 + keySize;
			const valueSize = body.readUInt32BE(at);
			at += 4;
			if (at + valueSize > body.length) throw new ZmtpError("ZMTP: a malformed READY property");
			properties[key] = body.subarray(at, at + valueSize);
			at += valueSize;
		}
	}
	return { name, properties };
}

/**
 * Collects a byte stream and takes whole ZMTP frames out of it. A frame's
 * header is read once, copying only its few bytes, so a body that arrives in
 * many small chunks costs time in proportion to its size; the body is copied
 * once. `limit` bounds the next frame's size and may change between frames.
 */
export class FrameReader {
	constructor({ maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
		this.chunks = [];
		this.head = 0;
		this.offset = 0;
		this.length = 0;
		this.limit = maxFrameBytes;
		this.pending = null;
	}

	push(chunk) {
		if (chunk.length === 0) return;
		this.chunks.push(chunk);
		this.length += chunk.length;
	}

	/** A copy of the first `n` bytes, which have arrived, without taking them; for small `n`. */
	copyFront(n) {
		const out = Buffer.alloc(n);
		let copied = 0;
		for (let i = this.head, offset = this.offset; copied < n; i++, offset = 0) {
			copied += this.chunks[i].copy(out, copied, offset, offset + n - copied);
		}
		return out;
	}

	/** Takes the first `n` bytes, which have arrived. */
	take(n) {
		if (n === 0) return Buffer.alloc(0);
		const first = this.chunks[this.head];
		let out;
		if (first.length - this.offset >= n) {
			out = first.subarray(this.offset, this.offset + n);
			this.advance(n);
		} else {
			out = Buffer.alloc(n);
			let copied = 0;
			while (copied < n) {
				const chunk = this.chunks[this.head];
				const count = chunk.copy(out, copied, this.offset, this.offset + n - copied);
				copied += count;
				this.advance(count);
			}
		}
		return out;
	}

	advance(n) {
		this.length -= n;
		this.offset += n;
		while (this.head < this.chunks.length && this.offset >= this.chunks[this.head].length) {
			this.offset -= this.chunks[this.head].length;
			this.chunks[this.head] = undefined;
			this.head++;
		}
		// Drop the consumed slots now and then, rather than shifting on every take.
		if (this.head > 1024 && this.head * 2 > this.chunks.length) {
			this.chunks = this.chunks.slice(this.head);
			this.head = 0;
		}
	}

	/** The greeting, once all 64 bytes have arrived, else null. */
	greeting() {
		return this.length >= ZMTP_GREETING_BYTES ? this.take(ZMTP_GREETING_BYTES) : null;
	}

	/** The next whole frame, or null. Throws on reserved flags or a frame over the limit. */
	next() {
		if (!this.pending) {
			if (this.length < 1) return null;
			const flags = this.copyFront(1)[0];
			if (flags & ~(FLAG_MORE | FLAG_LONG | FLAG_COMMAND)) throw new ZmtpError("ZMTP: reserved frame flags are set");
			const command = Boolean(flags & FLAG_COMMAND);
			if (command && flags & FLAG_MORE) throw new ZmtpError("ZMTP: a command frame has MORE set");
			const headerBytes = flags & FLAG_LONG ? 9 : 2;
			if (this.length < headerBytes) return null;
			const header = this.copyFront(headerBytes);
			const size = flags & FLAG_LONG ? header.readBigUInt64BE(1) : BigInt(header[1]);
			const limit = command ? MAX_COMMAND_BYTES : this.limit;
			if (size > BigInt(limit)) throw new ZmtpError(`ZMTP: a frame of ${size} bytes is over the ${limit}-byte bound`);
			this.take(headerBytes);
			this.pending = { more: Boolean(flags & FLAG_MORE), command, size: Number(size) };
		}
		if (this.length < this.pending.size) return null;
		const { more, command, size } = this.pending;
		this.pending = null;
		return { more, command, body: this.take(size) };
	}

	clear() {
		this.chunks = [];
		this.head = 0;
		this.offset = 0;
		this.length = 0;
		this.pending = null;
	}
}

const describeError = (value) => (value instanceof Error ? value.message : String(value));

/** Reports a listener's failure as "listenerError", or as a process warning if there is no one to tell. */
function reportListenerError(emitter, error, event) {
	if (event !== "listenerError" && emitter.listenerCount("listenerError") > 0) emitGuarded(emitter, "listenerError", error, event);
	else process.emitWarning(`A ${event} listener failed: ${error instanceof Error ? error.stack : String(error)}`, "JupyterListenerWarning");
}

/**
 * Calls each listener of `event` in turn, so that one that throws, or whose
 * promise rejects, neither stops the rest nor reaches the caller. rawListeners
 * keeps once()'s wrappers, which remove themselves as they run.
 */
function emitGuarded(emitter, event, ...args) {
	for (const listener of emitter.rawListeners(event)) {
		try {
			const result = listener.apply(emitter, args);
			if (result && typeof result.then === "function") result.then(undefined, (error) => reportListenerError(emitter, error, event));
		} catch (error) {
			reportListenerError(emitter, error, event);
		}
	}
}

/**
 * A ZMTP 3.0 client socket over TCP: DEALER or SUB. It emits "message" with
 * each multipart message's frames, and "close" once, with the error that
 * closed it, if any.
 */
export class ZmtpSocket extends EventEmitter {
	constructor(type, { identity, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES, maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES, maxMessageFrames = DEFAULT_MAX_MESSAGE_FRAMES, maxWriteBytes = DEFAULT_MAX_WRITE_BYTES } = {}) {
		super();
		if (!PEER_TYPES[type]) throw new ZmtpError(`ZMTP: unsupported socket type ${type}`);
		this.type = type;
		this.identity = identity === undefined ? undefined : Buffer.from(identity);
		this.reader = new FrameReader({ maxFrameBytes });
		this.maxFrameBytes = maxFrameBytes;
		this.maxMessageBytes = maxMessageBytes;
		this.maxMessageFrames = maxMessageFrames;
		this.maxWriteBytes = maxWriteBytes;
		this.state = "idle";
		this.frames = [];
		this.messageBytes = 0;
		this.peerSocketType = undefined;
	}

	/** Connects and completes the handshake within `timeoutMs`. */
	connect(host, port, { timeoutMs = 10_000 } = {}) {
		if (this.state !== "idle") return Promise.reject(new ZmtpError("ZMTP: the socket was already connected"));
		this.state = "greeting";
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => this.fail(new ZmtpError(`ZMTP: no handshake with ${host}:${port} within ${timeoutMs} ms`)), timeoutMs);
			const settle = (error) => {
				clearTimeout(timer);
				this.off("ready", onReady);
				this.off("close", onClose);
				if (error) reject(error); else resolve();
			};
			const onReady = () => settle();
			const onClose = (error) => settle(error ?? new ZmtpError(`ZMTP: ${host}:${port} closed during the handshake`));
			this.on("ready", onReady);
			this.on("close", onClose);
			this.socket = net.createConnection({ host, port });
			this.socket.setNoDelay(true);
			this.socket.on("connect", () => this.socket.write(buildGreeting()));
			this.socket.on("data", (chunk) => this.receive(chunk));
			this.socket.on("error", (error) => this.fail(error));
			this.socket.on("close", () => this.fail());
		});
	}

	receive(chunk) {
		if (this.state === "closed") return;
		// A framing error closes the socket, but only after the messages that
		// came whole before it, so that what is delivered doesn't depend on how
		// TCP split the bytes. What listeners do with a message is theirs.
		const messages = [];
		let failure;
		try {
			this.reader.push(chunk);
			if (this.state === "greeting") {
				const greeting = this.reader.greeting();
				if (!greeting) return;
				parseGreeting(greeting);
				const properties = { "Socket-Type": this.type };
				if (this.identity !== undefined) properties.Identity = this.identity;
				this.socket.write(encodeFrame(buildCommand("READY", properties), { command: true }));
				this.state = "handshake";
			}
			for (;;) {
				// The next frame may use only what is left of the message's budget.
				this.reader.limit = Math.min(this.maxFrameBytes, this.maxMessageBytes - this.messageBytes);
				const frame = this.reader.next();
				if (!frame) break;
				const message = this.frame(frame);
				if (message) messages.push(message);
			}
		} catch (error) {
			failure = error;
		}
		if (this.state === "ready" && this.readyPending) {
			this.readyPending = false;
			emitGuarded(this, "ready");
		}
		for (const message of messages) {
			if (this.state === "closed") break;
			emitGuarded(this, "message", message);
		}
		if (failure !== undefined) this.fail(failure);
	}

	/** Handles one frame; returns a message once its last frame has arrived. */
	frame({ more, command, body }) {
		if (this.state === "handshake") {
			if (!command) throw new ZmtpError("ZMTP: the peer sent a message before READY");
			const parsed = parseCommand(body);
			if (parsed.name === "ERROR") throw new ZmtpError(`ZMTP: the peer refused the handshake: ${parsed.reason}`);
			if (parsed.name !== "READY") throw new ZmtpError(`ZMTP: the peer sent ${parsed.name} before READY`);
			const peerType = parsed.properties["socket-type"]?.toString("latin1");
			if (!PEER_TYPES[this.type].includes(peerType)) throw new ZmtpError(`ZMTP: a ${this.type} socket can't talk to a ${peerType ?? "untyped"} socket`);
			this.peerSocketType = peerType;
			this.state = "ready";
			this.readyPending = true;
			return null;
		}
		if (command) {
			// A peer with ZMTP heartbeats (libzmq does, whatever version we
			// announce) closes a connection whose PINGs go unanswered.
			const parsed = parseCommand(body);
			if (parsed.name === "PING") {
				// A peer that sends PINGs but doesn't read the PONGs mustn't grow our queue.
				const pong = encodeFrame(Buffer.concat([Buffer.from([4]), Buffer.from("PONG"), parsed.context]), { command: true });
				if (this.socket.writableLength + pong.length > this.maxWriteBytes) throw new ZmtpError("ZMTP: the peer sends PINGs but doesn't read the PONGs");
				this.socket.write(pong);
			}
			return null;
		}
		if (this.frames.length >= this.maxMessageFrames) throw new ZmtpError(`ZMTP: a message of more than ${this.maxMessageFrames} frames`);
		this.messageBytes += body.length;
		this.frames.push(body);
		if (more) return null;
		const frames = this.frames;
		this.frames = [];
		this.messageBytes = 0;
		return frames;
	}

	/**
	 * Sends one multipart message, or throws without sending anything if the
	 * socket isn't ready, the message is over the bound, or the peer isn't
	 * reading. Once written, the message is Node's to deliver.
	 */
	send(frames) {
		if (this.state !== "ready") throw new ZmtpError("ZMTP: the socket isn't connected");
		const bodies = frames.map((frame) => (Buffer.isBuffer(frame) ? frame : Buffer.from(frame)));
		const size = bodies.reduce((sum, body) => sum + body.length + (body.length <= 255 ? 2 : 9), 0);
		const largest = Math.max(0, ...bodies.map((body) => body.length));
		if (largest > this.maxFrameBytes) throw new ZmtpError(`ZMTP: a frame of ${largest} bytes is over the ${this.maxFrameBytes}-byte bound; nothing was sent`);
		if (bodies.length > this.maxMessageFrames || size > this.maxMessageBytes) throw new ZmtpError(`ZMTP: a message of ${size} bytes in ${bodies.length} frames is over the bound; nothing was sent`);
		if (this.socket.writableLength + size > this.maxWriteBytes) throw new ZmtpError(`ZMTP: ${this.socket.writableLength} bytes already wait unsent; the peer isn't reading, and nothing was sent`);
		this.socket.cork();
		bodies.forEach((body, i) => {
			this.socket.write(frameHeader(body.length, { more: i < bodies.length - 1 }));
			if (body.length > 0) this.socket.write(body);
		});
		this.socket.uncork();
	}

	/** In ZMTP 3.0, a subscription is a message whose first byte is 1. */
	subscribe(prefix = "") {
		if (this.type !== "SUB") throw new ZmtpError("ZMTP: only a SUB socket subscribes");
		this.send([Buffer.concat([Buffer.from([1]), Buffer.from(prefix)])]);
	}

	fail(error) {
		if (this.state === "closed") return;
		this.state = "closed";
		this.frames = [];
		this.messageBytes = 0;
		this.reader.clear();
		this.socket?.destroy();
		emitGuarded(this, "close", error);
	}

	close() {
		this.fail();
	}
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isName = (value) => typeof value === "string" && value.length > 0;

/** Signs, builds and checks Jupyter messages for one client session. */
export class JupyterSession {
	constructor({ key = "", signatureScheme = "hmac-sha256", username = "pi-repl", session = randomUUID().replace(/-/g, "") } = {}) {
		if (signatureScheme !== "hmac-sha256") throw new JupyterMessageError(`Jupyter: unsupported signature scheme ${signatureScheme}`);
		this.key = Buffer.from(key, "utf8");
		this.username = username;
		this.session = session;
	}

	/** The hex HMAC-SHA256 of the four parts, or "" without a key. */
	sign(parts) {
		if (this.key.length === 0) return "";
		const hmac = createHmac("sha256", this.key);
		for (const part of parts) hmac.update(part);
		return hmac.digest("hex");
	}

	message(msgType, content = {}, { parent = {}, metadata = {}, buffers = [] } = {}) {
		return {
			header: { msg_id: randomUUID(), msg_type: msgType, username: this.username, session: this.session, date: new Date().toISOString(), version: JUPYTER_PROTOCOL_VERSION },
			parent_header: parent,
			metadata,
			content,
			buffers,
		};
	}

	/**
	 * The frames to send: any identities, the delimiter, the signature, the
	 * four parts and any binary buffers, which the signature doesn't cover.
	 */
	encode(message, identities = []) {
		const parts = [message.header, message.parent_header ?? {}, message.metadata ?? {}, message.content ?? {}].map((part) => Buffer.from(JSON.stringify(part)));
		const buffers = (message.buffers ?? []).map((buffer) => {
			if (!(buffer instanceof Uint8Array)) throw new JupyterMessageError("Jupyter: a message buffer must be bytes");
			return Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
		});
		return [...identities, DELIMITER, Buffer.from(this.sign(parts)), ...parts, ...buffers];
	}

	/** A received message, checked against its signature. Throws JupyterMessageError. */
	decode(frames) {
		const at = frames.findIndex((frame) => frame.equals(DELIMITER));
		if (at < 0) throw new JupyterMessageError("Jupyter: a message without the <IDS|MSG> delimiter");
		if (frames.length < at + 6) throw new JupyterMessageError("Jupyter: a message with too few parts");
		const signature = frames[at + 1];
		const parts = frames.slice(at + 2, at + 6);
		const expected = Buffer.from(this.sign(parts));
		if (signature.length !== expected.length || (expected.length > 0 && !timingSafeEqual(signature, expected))) {
			throw new JupyterMessageError("Jupyter: a message with a bad signature");
		}
		let header, parent, metadata, content;
		try {
			[header, parent, metadata, content] = parts.map((part) => JSON.parse(part.toString("utf8")));
		} catch {
			throw new JupyterMessageError("Jupyter: a message whose parts aren't JSON");
		}
		if (![header, parent, metadata, content].every(isObject)) throw new JupyterMessageError("Jupyter: a message part isn't a JSON object");
		// An empty parent is normal. This checks only what the client relies on,
		// not the whole schema: a header's ID, type, session and version.
		if (!isName(header.msg_id) || !isName(header.msg_type) || !isName(header.session) || !isName(header.version)) {
			throw new JupyterMessageError("Jupyter: a message with a malformed header");
		}
		return { identities: frames.slice(0, at), header, parent_header: parent, metadata, content, buffers: frames.slice(at + 6) };
	}
}

/** A literal loopback address: 127.x.y.z or ::1. A name such as localhost isn't resolved. */
const isLoopback = (ip) => (net.isIPv4(ip) && ip.startsWith("127.")) || (net.isIPv6(ip) && /^(?:0{0,4}:){2,7}0{0,3}1$|^::1$/i.test(ip));

/**
 * A kernel's connection file, checked: by default a single-link regular file
 * of this user's, mode 0600, at most 64 KiB, for TCP on a literal loopback
 * address with five distinct ports, HMAC-SHA256 and a key. It is opened
 * without blocking, so a FIFO is refused rather than waited on.
 */
export function readConnectionFile(path, { requirePrivate = true } = {}) {
	let fd;
	let text;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error("it isn't a regular file");
		if (requirePrivate) {
			if (stat.nlink !== 1) throw new Error("it has more than one link");
			if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("another user owns it");
			if ((stat.mode & 0o777) !== 0o600) throw new Error(`its mode is ${(stat.mode & 0o777).toString(8)}, not 600`);
		}
		if (stat.size > MAX_CONNECTION_FILE_BYTES) throw new Error(`it is over ${MAX_CONNECTION_FILE_BYTES} bytes`);
		const data = Buffer.alloc(stat.size);
		let read = 0;
		while (read < data.length) {
			const n = readSync(fd, data, read, data.length - read, read);
			if (n === 0) break;
			read += n;
		}
		text = data.subarray(0, read).toString("utf8");
	} catch (error) {
		throw new Error(`Unusable connection file ${path}: ${error.message}`);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	let info;
	try {
		info = JSON.parse(text);
	} catch {
		throw new Error(`Unusable connection file ${path}: it isn't JSON`);
	}
	const fail = (why) => { throw new Error(`Unusable connection file ${path}: ${why}`); };
	if (!isObject(info)) fail("it isn't a JSON object");
	if ((info.transport ?? "tcp") !== "tcp") fail(`its transport is ${info.transport}, not tcp`);
	if (typeof info.ip !== "string" || !isLoopback(info.ip)) fail(`its address ${info.ip} isn't a literal loopback address`);
	const ports = {};
	for (const channel of [...CHANNELS, "hb"]) {
		const port = info[`${channel}_port`];
		if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`its ${channel}_port is ${port}`);
		ports[channel] = port;
	}
	if (new Set(Object.values(ports)).size !== 5) fail("two of its ports are the same");
	if ((info.signature_scheme ?? "hmac-sha256") !== "hmac-sha256") fail(`its signature scheme is ${info.signature_scheme}`);
	if (typeof info.key !== "string" || info.key.length === 0) fail("it has no key");
	return { ip: info.ip, ports, key: info.key, signatureScheme: "hmac-sha256", kernelName: typeof info.kernel_name === "string" ? info.kernel_name : undefined };
}

/**
 * A Jupyter client: one connection to each of a kernel's shell, IOPub, stdin
 * and control channels. Events:
 *   "message" (channel, message)   each correctly signed message
 *   "dropped" (channel, error)     each message it rejects
 *   "channelClose" (channel, error)  a channel's connection ended
 *   "close" ()                     every channel has ended, or close() was called
 *   "listenerError" (error, event) a listener threw
 * Once a channel has ended the client is lost: it sends nothing more, and
 * never reconnects. Its other channels go on receiving, so that what the
 * kernel had already sent can still arrive, until they end too, `drainMs`
 * passes, or close() is called.
 */
export class JupyterClient extends EventEmitter {
	constructor(connection, { username = "pi-repl", session, drainMs = 1000, readyAttemptMs = 1000, maxFrameBytes, maxMessageBytes, maxMessageFrames, maxWriteBytes } = {}) {
		super();
		this.connection = connection;
		this.readyAttemptMs = readyAttemptMs;
		this.session = new JupyterSession({ key: connection.key, signatureScheme: connection.signatureScheme, username, session });
		this.identity = Buffer.from(randomBytes(16).toString("hex"));
		this.drainMs = drainMs;
		const options = { maxFrameBytes, maxMessageBytes, maxMessageFrames, maxWriteBytes };
		this.sockets = {
			shell: new ZmtpSocket("DEALER", { ...options, identity: this.identity }),
			stdin: new ZmtpSocket("DEALER", { ...options, identity: this.identity }),
			control: new ZmtpSocket("DEALER", { ...options, identity: Buffer.from(randomBytes(16).toString("hex")) }),
			iopub: new ZmtpSocket("SUB", options),
		};
		this.dropped = 0;
		this.ended = {};
		this.lost = false;
		this.closed = false;
		for (const [channel, socket] of Object.entries(this.sockets)) {
			socket.on("message", (frames) => this.receive(channel, frames));
			socket.on("close", (error) => this.channelEnded(channel, error));
		}
	}

	/** Connects every channel and waits until the kernel is ready, within `timeoutMs`. */
	static async connect(connection, { timeoutMs = 30_000, ...options } = {}) {
		const client = new JupyterClient(connection, options);
		try {
			await client.open({ timeoutMs });
			return client;
		} catch (error) {
			client.close();
			throw error;
		}
	}

	async open({ timeoutMs = 30_000 } = {}) {
		const deadline = Date.now() + timeoutMs;
		const { ip, ports } = this.connection;
		await Promise.all(CHANNELS.map((channel) => this.sockets[channel].connect(ip, ports[channel], { timeoutMs })));
		this.sockets.iopub.subscribe();
		this.kernelInfo = await this.waitForReady({ timeoutMs: Math.max(0, deadline - Date.now()), attemptMs: this.readyAttemptMs });
		return this.kernelInfo;
	}

	/**
	 * As jupyter_client's wait_for_ready: sends a kernel_info_request every
	 * `attemptMs` until one of them has both its reply and an IOPub message,
	 * since a kernel may start publishing to a new subscriber a little later.
	 * A reply or publication counts whenever it arrives, for any request sent.
	 * Resolves with that kernel_info_reply.
	 */
	waitForReady({ timeoutMs = 30_000, attemptMs = this.readyAttemptMs } = {}) {
		if (this.lost) return Promise.reject(new Error("Jupyter: the connection has closed"));
		const replies = new Map(), published = new Set(), sent = new Set();
		return new Promise((resolve, reject) => {
			let attempt;
			const deadline = setTimeout(() => finish(new Error(`Jupyter: the kernel wasn't ready within ${timeoutMs} ms`)), timeoutMs);
			const onMessage = (channel, message) => {
				const id = message.parent_header?.msg_id;
				if (!sent.has(id)) return;
				if (channel === "shell" && message.header.msg_type === "kernel_info_reply") replies.set(id, message);
				if (channel === "iopub") published.add(id);
				if (replies.has(id) && published.has(id)) finish(null, replies.get(id));
			};
			const onLost = () => finish(new Error("Jupyter: the kernel closed the connection before it was ready"));
			const finish = (error, reply) => {
				clearTimeout(deadline);
				clearTimeout(attempt);
				this.off("message", onMessage);
				this.off("channelClose", onLost);
				if (error) reject(error); else resolve(reply);
			};
			const request = () => {
				try {
					sent.add(this.send("shell", "kernel_info_request").header.msg_id);
				} catch (error) {
					return finish(error);
				}
				attempt = setTimeout(request, attemptMs);
			};
			this.on("message", onMessage);
			this.on("channelClose", onLost);
			request();
		});
	}

	/** Resolves with the first { channel, message } that `predicate` accepts. */
	waitFor(predicate, timeoutMs) {
		if (this.lost) return Promise.reject(new Error("Jupyter: the connection has closed"));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => finish(new Error("Jupyter: timed out waiting for a message")), timeoutMs);
			const onMessage = (channel, message) => {
				let accepted;
				try {
					accepted = predicate(channel, message);
				} catch (error) {
					return finish(new Error(`Jupyter: a waitFor predicate failed: ${describeError(error)}`, { cause: error }));
				}
				if (accepted) finish(null, { channel, message });
			};
			const onLost = () => finish(new Error("Jupyter: the connection closed"));
			const finish = (error, value) => {
				clearTimeout(timer);
				this.off("message", onMessage);
				this.off("channelClose", onLost);
				if (error) reject(error); else resolve(value);
			};
			this.on("message", onMessage);
			this.on("channelClose", onLost);
		});
	}

	/** A message for this client's session, built but not sent, so that a caller can register its ID first. */
	prepare(msgType, content = {}, { parent, metadata, buffers } = {}) {
		return this.session.message(msgType, content, { parent, metadata, buffers });
	}

	/** Sends a prepared message on `channel`; throws, having sent nothing, if it can't. */
	post(channel, message) {
		if (this.lost) throw new Error("Jupyter: the connection has closed");
		if (!this.sockets[channel] || channel === "iopub") throw new Error(`Jupyter: a client doesn't send on ${channel}`);
		this.sockets[channel].send(this.session.encode(message));
		return message;
	}

	/** Builds and sends a message on `channel`, and returns it. */
	send(channel, msgType, content = {}, options) {
		return this.post(channel, this.prepare(msgType, content, options));
	}

	/** An execute_request's message, built but not sent. */
	prepareExecute(code, { silent = false, storeHistory = true, allowStdin = true, stopOnError = true, userExpressions = {} } = {}) {
		return this.prepare("execute_request", { code, silent, store_history: storeHistory, user_expressions: userExpressions, allow_stdin: allowStdin, stop_on_error: stopOnError });
	}

	/** Builds and sends an execute_request, and returns it. */
	execute(code, options) {
		return this.post("shell", this.prepareExecute(code, options));
	}

	/** Answers an input_request with one record. */
	input(value, request) {
		return this.send("stdin", "input_reply", { value }, { parent: request.header });
	}

	receive(channel, frames) {
		if (this.closed) return;
		let message;
		try {
			message = this.session.decode(frames);
		} catch (error) {
			this.dropped++;
			emitGuarded(this, "dropped", channel, error);
			return;
		}
		emitGuarded(this, "message", channel, message);
	}

	channelEnded(channel, error) {
		if (this.ended[channel] !== undefined) return;
		this.ended[channel] = error ?? null;
		const first = !this.lost;
		this.lost = true;
		emitGuarded(this, "channelClose", channel, error);
		if (CHANNELS.every((name) => this.ended[name] !== undefined)) return this.finish();
		if (first && Number.isFinite(this.drainMs)) this.drainTimer = setTimeout(() => this.close(), this.drainMs);
	}

	finish() {
		if (this.closed) return;
		this.closed = true;
		this.lost = true;
		clearTimeout(this.drainTimer);
		emitGuarded(this, "close");
	}

	/** Closes every channel; nothing more is received or sent. */
	close() {
		if (this.closed) return;
		for (const socket of Object.values(this.sockets)) socket.close();
		this.finish();
	}
}

/**
 * For tests and simple callers, not for a long-lived collector: waits for an
 * execution's own execute_reply and its IOPub idle, in either order,
 * collecting at most `maxMessages` of its IOPub messages. Register it before
 * posting the request. Resolves with { reply, iopub }; rejects on a timeout,
 * too many messages, a failure of `onInputRequest`, or the loss of a channel
 * that still owes its part (shell the reply, IOPub the idle), with what had
 * arrived as the error's `reply` and `iopub`. While the client drains after
 * losing another channel, both parts can still arrive.
 */
export function waitForExecution(client, request, { timeoutMs = 60_000, onInputRequest, maxMessages = 10_000 } = {}) {
	const id = request.header.msg_id;
	const iopub = [];
	let reply = null, idle = false, settled = false, timer;
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			client.off("message", onMessage);
			client.off("channelClose", onLost);
			client.off("close", onClose);
		};
		const fail = (message, cause) => {
			if (settled) return;
			settled = true;
			cleanup();
			const error = new Error(message, cause === undefined ? undefined : { cause });
			error.reply = reply;
			error.iopub = iopub;
			reject(error);
		};
		const succeed = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve({ reply, iopub });
		};
		const callbackFailed = (cause) => fail(`Jupyter: onInputRequest failed: ${describeError(cause)}`, cause);
		const onMessage = (channel, message) => {
			if (message.parent_header?.msg_id !== id) return;
			if (channel === "iopub") {
				if (iopub.length >= maxMessages) return fail(`Jupyter: the execution sent more than ${maxMessages} IOPub messages`);
				iopub.push(message);
				if (message.header.msg_type === "status" && message.content.execution_state === "idle") idle = true;
			} else if (channel === "shell" && message.header.msg_type === "execute_reply") {
				reply = message;
			} else if (channel === "stdin" && message.header.msg_type === "input_request" && onInputRequest) {
				try {
					const result = onInputRequest(message);
					if (result && typeof result.then === "function") result.then(undefined, callbackFailed);
				} catch (error) {
					return callbackFailed(error);
				}
			}
			if (reply && idle) succeed();
		};
		const onLost = (channel) => {
			if ((channel === "shell" && !reply) || (channel === "iopub" && !idle)) fail("Jupyter: the connection closed during the execution");
		};
		const onClose = () => fail("Jupyter: the connection closed during the execution");
		if (client.lost) return fail("Jupyter: the connection has closed");
		timer = setTimeout(() => fail(`Jupyter: the execution didn't finish within ${timeoutMs} ms`), timeoutMs);
		client.on("message", onMessage);
		client.on("channelClose", onLost);
		client.on("close", onClose);
	});
}
