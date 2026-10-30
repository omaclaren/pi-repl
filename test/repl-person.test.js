import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
	DEFAULT_PERSON_NAME,
	clearPersonName,
	formatPersonNameStatus,
	getPersonSettingPath,
	personRequestId,
	readPersonSetting,
	resolvePersonName,
	savePersonName,
	validatePersonName,
} from "../shared/repl-person.js";

function withConfig(run) {
	const root = mkdtempSync(join(tmpdir(), "pi-repl-person-test-"));
	return Promise.resolve(run({ XDG_CONFIG_HOME: join(root, "config") }, root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("the setting lives under XDG_CONFIG_HOME when it is absolute, else ~/.config", () => {
	assert.equal(getPersonSettingPath({ XDG_CONFIG_HOME: "/cfg" }), "/cfg/pi-repl/person.json");
	assert.equal(getPersonSettingPath({ XDG_CONFIG_HOME: "relative" }), join(homedir(), ".config", "pi-repl", "person.json"));
	assert.equal(getPersonSettingPath({}), join(homedir(), ".config", "pi-repl", "person.json"));
});

test("names are trimmed, at most 80 characters, and without control characters", () => {
	assert.deepEqual(validatePersonName("  Sam Smith "), { name: "Sam Smith" });
	assert.deepEqual(validatePersonName("é".repeat(80)), { name: "é".repeat(80) });
	assert.deepEqual(validatePersonName("🙂".repeat(80)), { name: "🙂".repeat(80) }, "characters, not UTF-16 units");
	assert.match(validatePersonName("x".repeat(81)).error, /longer than 80/);
	assert.match(validatePersonName("   ").error, /empty/);
	assert.match(validatePersonName(42).error, /text/);
	for (const bad of ["Sam\nSmith", "Sam\u0007", "Sam\u2028Smith", "\u202eSam", "Sam\u2066x"]) {
		assert.match(validatePersonName(bad).error, /control characters/, JSON.stringify(bad));
	}
	// Every bidirectional control, U+061C included.
	for (const code of [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
		assert.match(validatePersonName(`Sam${String.fromCodePoint(code)}`).error ?? "", /control characters/, code.toString(16));
	}
});

test("the name comes from PI_REPL_USER_NAME, then the setting, then User", () => withConfig((env) => {
	assert.deepEqual(resolvePersonName(env), { name: DEFAULT_PERSON_NAME, source: "default", path: getPersonSettingPath(env), warning: undefined });
	savePersonName("Sam", env);
	assert.deepEqual(resolvePersonName(env), { name: "Sam", source: "setting", path: getPersonSettingPath(env), warning: undefined });
	assert.deepEqual(resolvePersonName({ ...env, PI_REPL_USER_NAME: " Alex " }), { name: "Alex", source: "environment", path: getPersonSettingPath(env), saved: "Sam", warning: undefined });
	// A blank variable is unset; an invalid one is ignored, with a warning.
	assert.equal(resolvePersonName({ ...env, PI_REPL_USER_NAME: "  " }).name, "Sam");
	const invalid = resolvePersonName({ ...env, PI_REPL_USER_NAME: "a\nb" });
	assert.equal(invalid.name, "Sam");
	assert.equal(invalid.source, "setting");
	assert.match(invalid.warning, /^PI_REPL_USER_NAME was ignored: the name has control characters\.$/);
}));

test("reading never writes, and a setting that can't be used gives a warning and User", () => withConfig((env) => {
	const path = getPersonSettingPath(env);
	assert.deepEqual(readPersonSetting(env), { path });
	assert.equal(existsSync(join(env.XDG_CONFIG_HOME, "pi-repl")), false, "a read creates nothing");
	mkdirSync(join(env.XDG_CONFIG_HOME, "pi-repl"), { recursive: true });
	for (const [text, why] of [["{", /isn't valid JSON/], ["[]", /isn't an object with a name/], ["{}", /a name must be text/], ['{"name":"x\\u0000"}', /control characters/]]) {
		writeFileSync(path, text);
		const resolved = resolvePersonName(env);
		assert.equal(resolved.name, DEFAULT_PERSON_NAME);
		assert.equal(resolved.source, "default");
		assert.match(resolved.warning, why);
		assert.equal(readFileSync(path, "utf8"), text, "a read leaves the file as it was");
	}
}));

test("saving replaces the file atomically with mode 0600; an invalid name is refused; clearing removes it", () => withConfig((env) => {
	const path = getPersonSettingPath(env);
	assert.throws(() => savePersonName("\u202eevil", env), /^Error: Not saved: the name has control characters\.$/);
	assert.equal(existsSync(path), false);
	assert.deepEqual(savePersonName("  Sam ", env), { name: "Sam", path });
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { name: "Sam" });
	if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
	writeFileSync(path, '{"name":"Old"}');
	chmodSync(path, 0o644);
	// The old file is replaced, not rewritten in place: a descriptor opened before still reads it.
	const oldFd = openSync(path, "r");
	try {
		savePersonName("Sam Smith", env);
		assert.equal(readFileSync(oldFd, "utf8"), '{"name":"Old"}');
	} finally {
		closeSync(oldFd);
	}
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { name: "Sam Smith" });
	if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(join(env.XDG_CONFIG_HOME, "pi-repl")), ["person.json"], "no temporary file is left");
	assert.deepEqual(clearPersonName(env), { path, removed: true });
	assert.deepEqual(clearPersonName(env), { path, removed: false });
	assert.equal(resolvePersonName(env).name, DEFAULT_PERSON_NAME);
}));

test("a person's request ID names its channel and what was sent, and is unique", () => {
	assert.match(personRequestId("pi", "send"), /^pi:send:[0-9a-f-]{36}$/);
	assert.match(personRequestId("cli", "env"), /^cli:env:[0-9a-f-]{36}$/);
	assert.notEqual(personRequestId("pi", "send"), personRequestId("pi", "send"));
	assert.throws(() => personRequestId("studio", "send"), /Unknown person channel/);
	assert.throws(() => personRequestId("pi", "note"), /Unknown person request/);
});

test("the status says which name is used, where it comes from, and what the environment hides", () => {
	const path = "/cfg/pi-repl/person.json";
	assert.equal(formatPersonNameStatus({ name: "User", source: "default", path }, "/repl name"),
		'Your sends are recorded as "User": no name is set.\nSet one with /repl name <name>. It\'s saved in /cfg/pi-repl/person.json, for everyone on this account without PI_REPL_USER_NAME.');
	assert.equal(formatPersonNameStatus({ name: "Sam", source: "setting", path }, "agent-repl name"),
		'Your sends are recorded as "Sam", saved in /cfg/pi-repl/person.json for everyone on this account without PI_REPL_USER_NAME.\nChange it with agent-repl name <name>, or remove it with agent-repl name --clear.');
	assert.equal(formatPersonNameStatus({ name: "Alex", source: "environment", path, saved: "Sam" }, "/repl name"),
		'Your sends are recorded as "Alex", from PI_REPL_USER_NAME.\nThe saved name, "Sam" (/cfg/pi-repl/person.json), applies where PI_REPL_USER_NAME isn\'t set.');
	assert.equal(formatPersonNameStatus({ name: "Alex", source: "environment", path }, "/repl name"),
		'Your sends are recorded as "Alex", from PI_REPL_USER_NAME.\nNo name is saved in /cfg/pi-repl/person.json.');
	assert.match(formatPersonNameStatus({ name: "User", source: "default", path, warning: "W." }, "/repl name"), /\nW\.$/);
});
