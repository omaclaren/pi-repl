import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupReplDelta } from "../index.ts";
import { LFORTRAN_PROMPT, createLfortranStatusFile, isLfortranEchoPrefix, lfortranInclude, prepareLfortranSubmission, readLfortranCompletion, stripLfortranEditorPosition } from "../shared/repl-lfortran.js";

function fixture(t) {
	const root = join(mkdtempSync(join(tmpdir(), "pi-repl-lfortran-")), "history");
	mkdirSync(root, { mode: 0o700 });
	t.after(() => rmSync(join(root, ".."), { recursive: true, force: true }));
	const statusFile = createLfortranStatusFile("pi-repl-lfortran", root);
	const line = (cell, status) => appendFileSync(statusFile, JSON.stringify({ cell, status }) + "\n");
	return { root, statusFile, line };
}

test("lfortran status file is private and named for its session", (t) => {
	const f = fixture(t);
	assert.match(f.statusFile, /\/pi-repl-lfortran-[0-9a-f-]{36}\.status\.jsonl$/);
	assert.equal(statSync(f.statusFile).mode & 0o777, 0o600);
	assert.equal(statSync(f.statusFile).size, 0);
});

test("lfortran completion is the first line written after the submission", (t) => {
	const f = fixture(t);
	f.line(1, "ok");
	const completion = prepareLfortranSubmission(f.statusFile);
	assert.equal(completion.offset, 1);
	assert.equal(readLfortranCompletion(completion), undefined);
	// A line still being written, without its newline, is not yet complete.
	appendFileSync(f.statusFile, '{"cell": 2, "status": "err');
	assert.equal(readLfortranCompletion(completion), undefined);
	appendFileSync(f.statusFile, 'or"}\n');
	assert.deepEqual(readLfortranCompletion(completion), { cell: 2, status: "error" });
	f.line(3, "ok");
	assert.deepEqual(readLfortranCompletion(completion), { cell: 2, status: "error" });
});

test("a malformed lfortran status line leaves the submission pending", (t) => {
	const f = fixture(t);
	const completion = prepareLfortranSubmission(f.statusFile);
	for (const text of ["not json", '{"cell": 0, "status": "ok"}', '{"cell": 1, "status": "done"}', '{"status": "ok"}']) {
		writeFileSync(f.statusFile, text + "\n");
		assert.equal(readLfortranCompletion(completion), undefined, text);
	}
});

test("lfortran status files that are not private are refused", (t) => {
	const f = fixture(t);
	chmodSync(f.statusFile, 0o644);
	assert.throws(() => prepareLfortranSubmission(f.statusFile), /cannot be read safely/);
	chmodSync(f.statusFile, 0o600);
	const link = join(f.root, "link.status.jsonl");
	symlinkSync(f.statusFile, link);
	assert.throws(() => prepareLfortranSubmission(link), /cannot be read safely/);
	const hard = join(f.root, "hard.status.jsonl");
	linkSync(f.statusFile, hard);
	assert.throws(() => prepareLfortranSubmission(f.statusFile), /cannot be read safely/);
	rmSync(hard);
	const completion = prepareLfortranSubmission(f.statusFile);
	chmodSync(f.root, 0o755);
	f.line(1, "ok");
	assert.equal(readLfortranCompletion(completion), undefined);
	chmodSync(f.root, 0o700);
	assert.deepEqual(readLfortranCompletion(completion), { cell: 1, status: "ok" });
});

test("lfortran include lines quote the path as a Fortran string", () => {
	assert.equal(lfortranInclude("/tmp/pi-rc-1/abc.f90"), "include '/tmp/pi-rc-1/abc.f90'");
	assert.equal(lfortranInclude("/tmp/it's/abc.f90"), "include '/tmp/it''s/abc.f90'");
	for (const path of ["/tmp/a\nb.f90", "/tmp/a\0b.f90", "/tmp/a\u2028b.f90"]) {
		assert.throws(() => lfortranInclude(path), /cannot contain/);
	}
	assert.throws(() => lfortranInclude("/tmp/\u03bb/abc.f90"), /must be ASCII/);
});

test("lfortran prompt rows with the editor's cursor position are prompts", () => {
	for (const row of [">>>", ">>>                1,1   ]", ">>> 12,345 ]"]) assert.match(row, LFORTRAN_PROMPT);
	for (const row of [">>> x                1,2   ]", ">>> unfinished", "1,1   ]"]) assert.doesNotMatch(row, LFORTRAN_PROMPT);
	assert.equal(stripLfortranEditorPosition("       1,83  ]"), "");
	assert.equal(stripLfortranEditorPosition("      1,88  ]syntax error: x"), "syntax error: x");
	assert.equal(stripLfortranEditorPosition(" K= 42"), " K= 42");
});

test("lfortran cleanup removes the include echo, its cursor position and the next prompt", () => {
	const include = lfortranInclude("/tmp/pi-rc-1/abc.f90");
	const prompt = ">>>                                      1,1   ]";
	assert.equal(cleanupReplDelta([`>>> ${include}       1,40  ]`, "K= 42", prompt, ""].join("\n"), include), "K= 42");
	// When the cursor position fills the row, the next output joins it.
	assert.equal(cleanupReplDelta([`>>> ${include}      1,40  ]syntax error: Newline is unexpected here`, " --> <cell 2>:1:20", prompt].join("\n"), include),
		"syntax error: Newline is unexpected here\n --> <cell 2>:1:20");
	// A long echo is cut at the edge of the row, without a cursor position.
	assert.equal(cleanupReplDelta([`>>> ${include}`.slice(0, 30), "K= 42", prompt].join("\n"), include), "K= 42");
	// User output that repeats the include line or a position is kept.
	assert.equal(cleanupReplDelta([`>>> ${include}       1,40  ]`, include, "   1,1   ]", prompt].join("\n"), include), `${include}\n   1,1   ]`);
});
