import test from "node:test";
import assert from "node:assert/strict";
import register from "../index.ts";

function fixture() {
	const tools = new Map();
	const commands = new Map();
	const calls = [];
	const notifications = [];
	register({
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: (name, command) => commands.set(name, command),
		async exec(command, args) {
			calls.push({ command, args });
			return { code: command === "tmux" ? 1 : 0, stdout: "", stderr: "test: no session" };
		},
	});
	const ctx = { cwd: process.cwd(), hasUI: true, ui: { notify: (message, level) => notifications.push({ message, level }) } };
	return {
		tools, calls, notifications,
		command: (args, name = "repl") => commands.get(name).handler(args, ctx),
		status: (target) => tools.get("repl_status").execute("test", { target }, undefined, undefined, ctx),
		send: (target) => tools.get("repl_send").execute("test", { target, code: "test" }, undefined, undefined, ctx),
	};
}

for (const [runtime, alias, executable] of [["ruby", " IRB ", "irb"], ["java", " JShell ", "jshell"]]) {
	test(`${runtime} command and tool routing never fall back to Python`, async () => {
		const f = fixture();
		for (const target of [runtime, alias]) {
			const result = await f.status(target);
			assert.match(result.content[0].text, new RegExp(`pi-repl-${runtime}`));
			assert.equal(result.details[runtime].running, false);
			assert.equal(result.details[runtime].recordEntryCount, 0);
			assert.deepEqual(result.details[runtime].recordEntries, []);
			await assert.rejects(f.send(target), new RegExp(`pi-repl-${runtime}`));
		}
		for (const action of ["status", "attach", "export", "stop"]) {
			await f.command(`${action} ${runtime.toUpperCase()}`, "lab");
			assert.match(f.notifications.at(-1).message, new RegExp(`pi-repl-${runtime}`));
			assert.doesNotMatch(f.notifications.at(-1).message, /Unknown/);
		}
		await f.command(runtime);
		const launch = f.calls.find((call) => call.args[0] === "new-session");
		assert.ok(launch);
		assert.ok(launch.args.includes(`pi-repl-${runtime}`));
		assert.match(launch.args.at(-1), new RegExp(`'${executable}'$`));
		const count = f.calls.length;
		await f.command(`${runtime} --name example`);
		assert.match(f.notifications.at(-1).message, /Named .* sessions are not implemented/);
		assert.equal(f.calls.slice(count).some((call) => call.args[0] === "new-session"), false);
	});
}

test("help and schemas advertise Ruby, Java, exports and existing echo controls", async () => {
	const f = fixture();
	await f.command("");
	const help = f.notifications.at(-1).message;
	for (const name of ["ruby", "java"]) {
		assert.match(help, new RegExp(`/repl ${name}`));
		assert.match(f.tools.get("repl_send").parameters.properties.target.description, new RegExp(name));
	}
	assert.match(help, /\/repl echo \[off\|summary\|full\]/);
	assert.match(help, /\/repl export \[python\|julia\|r\|ghci\|clojure\|ruby\|java\]/);
});
