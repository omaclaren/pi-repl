import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	REPL_SESSION_RECORD_ID_OPTION,
	REPL_SESSION_RECORD_PROTOCOL,
	REPL_SESSION_RECORD_ROOT_KEY_OPTION,
	REPL_SESSION_RECORD_VERSION,
	REPL_SESSION_RECORD_VERSION_OPTION,
	acquireReplSessionSendLease,
	bindReplSessionRecordRoot,
	classifyReplSessionRecordRoot,
	clearReplSessionRecord,
	createReplSessionRecordId,
	ensureReplSessionRecord,
	getReplSessionRecordPath,
	getReplSessionRecordRootKey,
	isValidReplSessionRecordId,
	isValidReplSessionRecordRootKey,
	readReplSessionRecord,
	readReplSessionRecordRootKey,
	readReplSessionRecordStrict,
	renderReplSessionRecordMarkdown,
	replSessionRecordRootKeyFor,
	upsertReplSessionRecordEntry,
	verifyReplSessionRecordRoot,
} from "../shared/repl-session-record.js";

function withTempRoot(run) {
	const root = mkdtempSync(join(tmpdir(), "pi-repl-record-test-"));
	return Promise.resolve(run(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

function identity(overrides = {}) {
	return {
		sessionName: "pi-repl-python",
		tmuxSessionId: "$7",
		tmuxSessionCreatedAt: 1_700_000_000,
		runtime: "ipython",
		...overrides,
	};
}

test("shared REPL protocol uses stable tmux option names and record IDs", () => {
	assert.equal(REPL_SESSION_RECORD_ID_OPTION, "@pi_repl_record_id");
	assert.equal(REPL_SESSION_RECORD_VERSION_OPTION, "@pi_repl_record_version");
	const recordId = createReplSessionRecordId();
	assert.equal(isValidReplSessionRecordId(recordId), true);
	assert.equal(isValidReplSessionRecordId("../../unsafe"), false);
});

test("shared REPL records are private, versioned, updateable snapshots", async () => withTempRoot((root) => {
	const recordId = createReplSessionRecordId();
	const initial = ensureReplSessionRecord(recordId, identity(), { root });
	assert.equal(initial.protocol, REPL_SESSION_RECORD_PROTOCOL);
	assert.equal(initial.version, REPL_SESSION_RECORD_VERSION);
	assert.deepEqual(initial.entries, []);

	const first = upsertReplSessionRecordEntry(recordId, identity(), {
		id: "studio:request-1",
		requestId: "request-1",
		origin: "pi-studio",
		mode: "literate",
		label: "current python chunk",
		prose: "Fit the model.",
		code: "x = 41\nx + 1",
		status: "sending",
	}, { root, origin: "pi-studio" });
	assert.equal(first.entry.origin, "pi-studio");
	assert.equal(first.entry.status, "sending");

	upsertReplSessionRecordEntry(recordId, identity(), {
		...first.entry,
		output: "42",
		status: "captured",
		completedAt: Date.now(),
	}, { root, origin: "pi-studio" });
	upsertReplSessionRecordEntry(recordId, identity(), {
		id: "pi-repl:request-2",
		origin: "pi-repl",
		mode: "agent",
		label: "Pi",
		code: "print(x)",
		output: "41",
		status: "captured",
	}, { root, origin: "pi-repl" });

	const record = readReplSessionRecord(recordId, identity(), { root });
	assert.ok(record);
	assert.equal(record.entries.length, 2);
	assert.equal(record.entries[0].output, "42");
	assert.equal(record.entries[1].origin, "pi-repl");
	assert.equal(JSON.parse(readFileSync(getReplSessionRecordPath(recordId, { root }), "utf8")).recordId, recordId);

	if (process.platform !== "win32") {
		assert.equal(statSync(root).mode & 0o777, 0o700);
		assert.equal(statSync(getReplSessionRecordPath(recordId, { root })).mode & 0o777, 0o600);
	}

	const markdown = renderReplSessionRecordMarkdown(record);
	assert.match(markdown, /^# Shared REPL Record/m);
	assert.match(markdown, /- Origin: pi-studio/);
	assert.match(markdown, /- Origin: pi-repl/);
	assert.match(markdown, /```python\nx = 41/);
	assert.match(markdown, /typed directly into an attached tmux pane/);

	const cleared = clearReplSessionRecord(recordId, identity(), { root });
	assert.deepEqual(cleared.entries, []);
	assert.equal(cleared.droppedEntries, 2);
}));

test("shared REPL records refuse hard-linked sidecars", async () => withTempRoot((root) => {
	const recordId = createReplSessionRecordId();
	ensureReplSessionRecord(recordId, identity(), { root });
	linkSync(getReplSessionRecordPath(recordId, { root }), join(root, "linked-record.json"));
	assert.throws(
		() => readReplSessionRecord(recordId, identity(), { root }),
		/unsafe hard-link count/,
	);
}));

test("shared REPL records require and preserve exact tmux session identity", async () => withTempRoot((root) => {
	assert.throws(
		() => ensureReplSessionRecord(createReplSessionRecordId(), identity({ tmuxSessionId: "" }), { root }),
		/valid tmux session ID/,
	);
	assert.throws(
		() => ensureReplSessionRecord(createReplSessionRecordId(), identity({ tmuxSessionCreatedAt: 0 }), { root }),
		/valid tmux session creation time/,
	);
	const recordId = createReplSessionRecordId();
	ensureReplSessionRecord(recordId, identity(), { root });
	assert.throws(
		() => readReplSessionRecord(recordId, identity({ tmuxSessionId: "$8" }), { root }),
		/different tmux session ID/,
	);
	assert.throws(
		() => readReplSessionRecord(recordId, identity({ tmuxSessionCreatedAt: 1_700_000_001 }), { root }),
		/different tmux session lifetime/,
	);
}));

test("shared REPL send leases serialize compatible clients", async () => withTempRoot(async (root) => {
	const recordId = createReplSessionRecordId();
	ensureReplSessionRecord(recordId, identity(), { root });
	const first = await acquireReplSessionSendLease(recordId, { root, owner: "pi-studio", waitMs: 500 });
	const immediateStartedAt = Date.now();
	await assert.rejects(
		acquireReplSessionSendLease(recordId, { root, owner: "pi-repl-immediate", waitMs: 0 }),
		/busy in another compatible client/,
	);
	assert.ok(Date.now() - immediateStartedAt < 500, "a zero-wait lease should fail immediately");
	let secondAcquired = false;
	const secondPromise = acquireReplSessionSendLease(recordId, { root, owner: "pi-repl", waitMs: 1_500 })
		.then((lease) => {
			secondAcquired = true;
			return lease;
		});
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(secondAcquired, false);
	await first.release();
	const second = await secondPromise;
	assert.equal(secondAcquired, true);
	await second.release();
}));

// A session's record-directory key as tmux holds it: set only when unset, as `set-option -o`.
function keyStore() {
	const store = { key: undefined, sets: 0 };
	store.tmux = {
		readKey: async () => store.key,
		setKeyIfAbsent: async (key) => {
			store.sets += 1;
			if (store.key === undefined) store.key = key;
		},
	};
	return store;
}

// Every path under a directory, with its mode and size: what a reader must leave as it found it.
function snapshot(dir) {
	if (!existsSync(dir)) return null;
	const out = [];
	const walk = (path) => {
		const info = lstatSync(path);
		out.push(`${path} ${info.mode.toString(8)} ${info.size}`);
		if (info.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
	};
	walk(dir);
	return out;
}

test("the record-directory key is v1: and the SHA-256 of the directory's device and inode", () => {
	assert.equal(REPL_SESSION_RECORD_ROOT_KEY_OPTION, "@pi_repl_record_root_key");
	// The protocol's test vectors.
	assert.equal(replSessionRecordRootKeyFor(0n, 0n), "v1:ac72368a586a18c19088393573ce0307");
	assert.equal(replSessionRecordRootKeyFor(16777232n, 1234567n), "v1:1e42c564492d3e74e2ef33a98ea2fc21");
	assert.equal(replSessionRecordRootKeyFor(16777232, 1234567), "v1:1e42c564492d3e74e2ef33a98ea2fc21");
	assert.equal(replSessionRecordRootKeyFor(2n ** 64n - 1n, 2n ** 63n + 5n), "v1:eb75db16e5ba9caa199d69d116a8ac77");
	assert.throws(() => replSessionRecordRootKeyFor(2 ** 60, 1), /exact integers/);
	assert.throws(() => replSessionRecordRootKeyFor(-1, 0), /non-negative integers/);
	assert.throws(() => replSessionRecordRootKeyFor("1", 2), /non-negative integers/);
	for (const valid of ["v1:ac72368a586a18c19088393573ce0307"]) assert.equal(isValidReplSessionRecordRootKey(valid), true);
	for (const invalid of [undefined, "", "v1:AC72368A586A18C19088393573CE0307", "v2:ac72368a586a18c19088393573ce0307", "v1:ac72368a586a18c1", " v1:ac72368a586a18c19088393573ce0307"]) {
		assert.equal(isValidReplSessionRecordRootKey(invalid), false, String(invalid));
	}
});

test("a record directory has one key however it is spelled, and readers never create it", async () => withTempRoot((base) => {
	const root = join(base, "records");
	assert.equal(readReplSessionRecordRootKey({ root }), null);
	assert.equal(existsSync(root), false, "a reader's key creates no directory");
	const key = getReplSessionRecordRootKey({ root });
	const info = statSync(root, { bigint: true });
	assert.equal(key, replSessionRecordRootKeyFor(info.dev, info.ino));
	assert.equal(statSync(root).mode & 0o777, 0o700);
	assert.equal(readReplSessionRecordRootKey({ root }), key);
	// Another spelling of the same directory, through a symlinked parent.
	symlinkSync(base, join(base, "alias"));
	assert.equal(readReplSessionRecordRootKey({ root: join(base, "alias", "records") }), key);
	// A replaced directory is another directory.
	renameSync(root, join(base, "old-records"));
	assert.notEqual(getReplSessionRecordRootKey({ root }), key);
	// Readers check the root as writers leave it, and change nothing.
	chmodSync(root, 0o755);
	assert.throws(() => readReplSessionRecordRootKey({ root }), /not private \(mode 0700\)/);
	assert.equal(statSync(root).mode & 0o777, 0o755);
	assert.throws(() => readReplSessionRecordRootKey({ root: join(base, "alias") }), /not a real directory/);
}));

test("a strict read of a record refuses what writers would repair, and writes nothing", async () => withTempRoot((root) => {
	const recordId = createReplSessionRecordId();
	assert.equal(readReplSessionRecordStrict(recordId, identity(), { root: join(root, "none") }), null);
	assert.equal(existsSync(join(root, "none")), false);
	assert.equal(readReplSessionRecordStrict(recordId, identity(), { root }), null);
	ensureReplSessionRecord(recordId, identity(), { root });
	upsertReplSessionRecordEntry(recordId, identity(), { id: "pi-repl:a", origin: "pi-repl", mode: "agent", label: "Pi", code: "1", status: "captured" }, { root });
	assert.equal(readReplSessionRecordStrict(recordId, identity(), { root }).entries.length, 1);
	assert.equal(readReplSessionRecordStrict(recordId, identity({ runtime: "unknown" }), { root }).entries.length, 1, "the runtime isn't part of the session's identity");
	assert.throws(() => readReplSessionRecordStrict(recordId, identity({ tmuxSessionId: "$8" }), { root }), /another tmux session or session lifetime/);
	assert.throws(() => readReplSessionRecordStrict(recordId, identity({ tmuxSessionCreatedAt: 1_700_000_001 }), { root }), /another tmux session or session lifetime/);
	assert.throws(() => readReplSessionRecordStrict(recordId, identity({ sessionName: "pi-repl-julia" }), { root }), /another tmux session or session lifetime/);
	const path = getReplSessionRecordPath(recordId, { root });
	const before = snapshot(root);
	chmodSync(path, 0o644);
	assert.throws(() => readReplSessionRecordStrict(recordId, identity(), { root }), /not private \(mode 0600\)/);
	assert.equal(statSync(path).mode & 0o777, 0o644, "a strict read never changes a mode");
	chmodSync(path, 0o600);
	linkSync(path, join(root, "linked"));
	assert.throws(() => readReplSessionRecordStrict(recordId, identity(), { root }), /unsafe hard-link count/);
	rmSync(join(root, "linked"));
	renameSync(path, join(root, "elsewhere.json"));
	symlinkSync(join(root, "elsewhere.json"), path);
	assert.throws(() => readReplSessionRecordStrict(recordId, identity(), { root }), /not a regular file/);
	rmSync(path);
	renameSync(join(root, "elsewhere.json"), path);
	assert.deepEqual(snapshot(root), before, "strict reads take no lock and leave nothing behind");
}));

test("writers set the record-directory key before the record, and the key that sticks decides", async () => withTempRoot(async (base) => {
	const rootA = join(base, "a");
	const rootB = join(base, "b");
	const session = { sessionName: "pi-repl-python", recordId: undefined, identity: identity() };
	// Fresh metadata: set, then read back.
	const fresh = keyStore();
	const bound = await bindReplSessionRecordRoot(fresh.tmux, session, { root: rootA });
	assert.deepEqual(bound, { ok: true, key: getReplSessionRecordRootKey({ root: rootA }), adopted: false });
	assert.equal(fresh.key, bound.key);
	assert.deepEqual(await bindReplSessionRecordRoot(fresh.tmux, session, { root: rootA }), bound);
	assert.equal(fresh.sets, 1, "a matching key isn't set again");
	// Two writers with one directory agree; with two directories, one is refused.
	const same = keyStore();
	const agreed = await Promise.all([bindReplSessionRecordRoot(same.tmux, session, { root: rootA }), bindReplSessionRecordRoot(same.tmux, session, { root: rootA })]);
	assert.ok(agreed.every((result) => result.ok));
	const split = keyStore();
	const raced = await Promise.all([bindReplSessionRecordRoot(split.tmux, session, { root: rootA }), bindReplSessionRecordRoot(split.tmux, session, { root: rootB })]);
	assert.equal(raced.filter((result) => result.ok).length, 1);
	assert.match(raced.find((result) => !result.ok).reason, /^pi-repl-python's shared record is in a different or replaced record directory, not this terminal's \(.*\)\. Use it from a terminal with the same temporary directory \(TMPDIR\)/);
	// A malformed key is refused and left as it is.
	const malformed = keyStore();
	malformed.key = "v2:something";
	assert.match((await bindReplSessionRecordRoot(malformed.tmux, session, { root: rootA })).reason, /record-directory key \(@pi_repl_record_root_key\) isn't one this version understands/);
	assert.equal(malformed.key, "v2:something");
	assert.equal(malformed.sets, 0);
	// A read that fails is the caller's to report: nothing is set.
	const failing = keyStore();
	failing.tmux.readKey = async () => { throw new Error("pi-repl-python changed while its record-directory key was read."); };
	await assert.rejects(bindReplSessionRecordRoot(failing.tmux, session, { root: rootA }), /changed while/);
	assert.equal(failing.sets, 0);
}));

test("a writer adopts metadata older clients made only from a record its own directory holds", async () => withTempRoot(async (base) => {
	const rootA = join(base, "a");
	const rootB = join(base, "b");
	const recordId = createReplSessionRecordId();
	ensureReplSessionRecord(recordId, identity(), { root: rootA });
	const session = { sessionName: "pi-repl-python", recordId, identity: identity() };
	// Another directory without the record: refused, and nothing is claimed or created.
	const elsewhere = keyStore();
	const refused = await bindReplSessionRecordRoot(elsewhere.tmux, session, { root: rootB });
	assert.equal(refused.ok, false);
	assert.match(refused.reason, /^pi-repl-python's record isn't in this terminal's record directory \(.*\), and the session has no record-directory key to say which directory holds it/);
	assert.equal(elsewhere.key, undefined);
	assert.equal(existsSync(rootB), false, "no directory or empty record is made to claim the session");
	// A record of another lifetime, or one that isn't private, doesn't qualify.
	ensureReplSessionRecord(recordId, identity({ tmuxSessionCreatedAt: 1_600_000_000 }), { root: rootB });
	assert.match((await bindReplSessionRecordRoot(elsewhere.tmux, session, { root: rootB })).reason, /record in this terminal's record directory can't be checked \(.*another tmux session or session lifetime\.\)/);
	chmodSync(getReplSessionRecordPath(recordId, { root: rootA }), 0o644);
	assert.match((await bindReplSessionRecordRoot(elsewhere.tmux, session, { root: rootA })).reason, /can't be checked \(.*not private/);
	assert.equal(elsewhere.key, undefined);
	chmodSync(getReplSessionRecordPath(recordId, { root: rootA }), 0o600);
	// The directory that holds it adopts, and from then on the other is refused.
	const adopted = await bindReplSessionRecordRoot(elsewhere.tmux, session, { root: rootA });
	assert.deepEqual(adopted, { ok: true, key: getReplSessionRecordRootKey({ root: rootA }), adopted: true });
	assert.equal(elsewhere.key, adopted.key);
	assert.match((await bindReplSessionRecordRoot(elsewhere.tmux, session, { root: rootB })).reason, /different or replaced record directory/);
}));

test("at use, a writer finds a replaced or unkeyed directory, and creates nothing", async () => withTempRoot(async (base) => {
	const root = join(base, "records");
	const store = keyStore();
	await bindReplSessionRecordRoot(store.tmux, { sessionName: "pi-repl-python", identity: identity() }, { root });
	assert.equal((await verifyReplSessionRecordRoot(store.tmux, "pi-repl-python", { root })).ok, true);
	renameSync(root, join(base, "cleaned"));
	assert.match((await verifyReplSessionRecordRoot(store.tmux, "pi-repl-python", { root })).reason, /different or replaced record directory/);
	assert.equal(existsSync(root), false, "the check at use doesn't recreate the directory");
	mkdirSync(root, { mode: 0o700 });
	assert.match((await verifyReplSessionRecordRoot(store.tmux, "pi-repl-python", { root })).reason, /different or replaced record directory/);
	store.key = undefined;
	assert.match((await verifyReplSessionRecordRoot(store.tmux, "pi-repl-python", { root })).reason, /record-directory key couldn't be set or has gone/);
	assert.equal(store.sets, 1);
}));

test("readers classify a session's key and never adopt it", async () => withTempRoot((base) => {
	const root = join(base, "records");
	assert.equal(classifyReplSessionRecordRoot(undefined, { root }), "unverified");
	assert.equal(classifyReplSessionRecordRoot("", { root }), "malformed");
	assert.equal(classifyReplSessionRecordRoot("v1:ac72368a586a18c19088393573ce0307", { root }), "different", "a reader without a directory can't hold the session's record");
	assert.equal(existsSync(root), false);
	const key = getReplSessionRecordRootKey({ root });
	assert.equal(classifyReplSessionRecordRoot(key, { root }), "verified");
	assert.equal(classifyReplSessionRecordRoot("v1:ac72368a586a18c19088393573ce0307", { root }), "different");
}));

test("a strict read checks the record as stored, and refuses a FIFO without waiting on it", async () => withTempRoot((root) => {
	const recordId = createReplSessionRecordId();
	const path = getReplSessionRecordPath(recordId, { root });
	const stored = (changes) => {
		rmSync(path, { force: true });
		const record = { protocol: REPL_SESSION_RECORD_PROTOCOL, version: REPL_SESSION_RECORD_VERSION, recordId, session: identity(), revision: 1, createdAt: 1, updatedAt: 1, clearedAt: null, droppedEntries: 0, entries: [], ...changes };
		writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
	};
	stored({});
	assert.equal(readReplSessionRecordStrict(recordId, identity(), { root }).entries.length, 0);
	// Normalising would round the creation time or trim the name into a match.
	stored({ session: identity({ tmuxSessionCreatedAt: 1_700_000_000.9 }) });
	assert.throws(() => readReplSessionRecordStrict(recordId, identity(), { root }), /another tmux session or session lifetime/);
	stored({ session: identity({ sessionName: " pi-repl-python" }) });
	assert.throws(() => readReplSessionRecordStrict(recordId, identity(), { root }), /another tmux session or session lifetime/);
	stored({ session: [identity()] });
	assert.throws(() => readReplSessionRecordStrict(recordId, identity(), { root }), /another tmux session or session lifetime/);
	// Normalising would make up an entry from an array.
	stored({ entries: [[]] });
	assert.throws(() => readReplSessionRecordStrict(recordId, identity(), { root }), /not a record with a list of entries/);
	stored({ entries: [null] });
	assert.throws(() => readReplSessionRecordStrict(recordId, identity(), { root }), /not a record with a list of entries/);
	rmSync(path);
	const fifo = spawnSync("mkfifo", ["-m", "600", path]);
	if (fifo.status !== 0) return;
	const startedAt = Date.now();
	assert.throws(() => readReplSessionRecordStrict(recordId, identity(), { root }), /not a regular file/);
	assert.ok(Date.now() - startedAt < 1_000, "a FIFO is refused at once");
}));

test("adoption checks the record before it creates or repairs a record directory", async () => withTempRoot(async (base) => {
	const root = join(base, "records");
	const recordId = createReplSessionRecordId();
	const session = { sessionName: "pi-repl-python", recordId, identity: identity() };
	const store = keyStore();
	// No directory: refused, and none is made.
	assert.match((await bindReplSessionRecordRoot(store.tmux, session, { root })).reason, /record isn't in this terminal's record directory/);
	assert.equal(existsSync(root), false);
	// A directory that isn't private: refused, and left as it is, though it holds the record.
	ensureReplSessionRecord(recordId, identity(), { root });
	chmodSync(root, 0o755);
	assert.match((await bindReplSessionRecordRoot(store.tmux, session, { root })).reason, /can't be checked \(Shared REPL record root is not private \(mode 0700\)/);
	assert.equal(statSync(root).mode & 0o777, 0o755);
	assert.equal(store.key, undefined);
	assert.equal(store.sets, 0);
	// A writer with a key to check doesn't create its directory either.
	const keyed = keyStore();
	keyed.key = "v1:ac72368a586a18c19088393573ce0307";
	assert.match((await bindReplSessionRecordRoot(keyed.tmux, { sessionName: "pi-repl-python", identity: identity() }, { root: join(base, "fresh") })).reason, /different or replaced record directory/);
	assert.equal(existsSync(join(base, "fresh")), false);
}));
