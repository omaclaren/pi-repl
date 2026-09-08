import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPrivateReplHistoryFile } from "../shared/repl-history.js";

function fixture(t) {
	const parent = mkdtempSync(join(tmpdir(), "pi-history-test-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	return { parent, root: join(parent, "logs") };
}

test("raw logs are private and never truncate a same-name session's earlier log", (t) => {
	const { root } = fixture(t);
	const first = createPrivateReplHistoryFile("pi-repl-python", root);
	writeFileSync(first, "keep this history\n");
	const second = createPrivateReplHistoryFile("pi-repl-python", root);
	assert.notEqual(first, second);
	assert.equal(dirname(first), root);
	assert.equal(readFileSync(first, "utf8"), "keep this history\n");
	assert.equal(readFileSync(second, "utf8"), "");
	if (process.platform !== "win32") {
		assert.equal(statSync(root).mode & 0o777, 0o700);
		assert.equal(statSync(first).mode & 0o777, 0o600);
		assert.equal(statSync(second).mode & 0o777, 0o600);
	}
});

test("raw logs reject unsafe names, permissive roots and symlinked roots without altering them", (t) => {
	const { parent, root } = fixture(t);
	assert.throws(() => createPrivateReplHistoryFile("../../escape", root), /Invalid/);
	if (process.platform === "win32") return;
	mkdirSync(root, { mode: 0o700 });
	chmodSync(root, 0o755);
	assert.throws(() => createPrivateReplHistoryFile("pi-repl-python", root), /0700/);
	assert.equal(statSync(root).mode & 0o777, 0o755);
	const target = join(parent, "target");
	mkdirSync(target, { mode: 0o700 });
	const link = join(parent, "link");
	symlinkSync(target, link);
	assert.throws(() => createPrivateReplHistoryFile("pi-repl-python", link), /not a real directory/);
});
