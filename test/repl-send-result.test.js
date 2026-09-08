import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { formatReplSendResult } from "../index.ts";

const details = {
	sessionName: "pi-repl-python", runtime: "python", timeoutMs: 20000,
	target: "python", echoMode: "off", submittedCode: "print(42)",
};

test("small send results retain their full code and output", () => {
	const result = formatReplSendResult("42", details);
	assert.equal(result.text, "Submitted code:\nprint(42)\n\nOutput:\n42");
	assert.equal(result.details.fullOutputPath, undefined);
});

for (const [name, code, output] of [
	["large submitted code", "# a comment\n".repeat(3000), "42"],
	["large output", "print('lots')", "result\n".repeat(4000)],
	["single-line Unicode source", "# " + "🧪".repeat(20000), "done"],
]) {
	test(`${name} cannot bypass the complete-response limits`, () => {
		const result = formatReplSendResult(output, { ...details, submittedCode: code });
		try {
			assert.ok(Buffer.byteLength(result.text, "utf8") <= DEFAULT_MAX_BYTES);
			assert.ok(result.text.split("\n").length <= DEFAULT_MAX_LINES);
			assert.match(result.text, /REPL response truncated/);
			assert.equal(result.details.truncation.truncated, true);
			const full = readFileSync(result.details.fullOutputPath, "utf8");
			assert.equal(full, `Submitted code:\n${code.trimEnd()}\n\nOutput:\n${output}`);
			if (process.platform !== "win32") {
				assert.equal(statSync(result.details.fullOutputPath).mode & 0o777, 0o600);
				assert.equal(statSync(dirname(result.details.fullOutputPath)).mode & 0o777, 0o700);
			}
		} finally {
			if (result.details.fullOutputPath) rmSync(dirname(result.details.fullOutputPath), { recursive: true, force: true });
		}
	});
}
