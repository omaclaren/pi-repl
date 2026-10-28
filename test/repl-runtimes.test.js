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
			if (command === "tmux") {
				assert.equal(args[0], "-u", `tmux without -u: ${args.join(" ")}`);
				args = args.slice(1);
			}
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

// The launch command as the shell sees it, matched literally.
const shellWord = (text) => `'${text.replace(/'/g, `'"'"'`)}'`;
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

for (const [runtime, alias, executable] of [["ruby", " IRB ", "irb"], ["java", " JShell ", "jshell"], ["octave", " OCTAVE ", "octave-cli --quiet --interactive --persist --eval 'sighup_dumps_octave_core(false); sigterm_dumps_octave_core(false);'"], ["matlab", " MATLAB ", "matlab -nodesktop -nosplash"], ["gnuplot", " GNUPLOT ", "gnuplot"], ["cpp", " CPP ", "cling"]]) {
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
		assert.match(launch.args.at(-1), new RegExp(runtime === "matlab" ? `'${literal(executable)} -sd ` : `${literal(shellWord(executable))}$`));
		const count = f.calls.length;
		await f.command(`${runtime} --name example`);
		assert.match(f.notifications.at(-1).message, /Named .* sessions are not implemented/);
		assert.equal(f.calls.slice(count).some((call) => call.args[0] === "new-session"), false);
	});
}

for (const outcome of ['ended', 'still-live', 'inspection-error']) {
	test(`status handles pane lookup racing native exit: ${outcome}`, async () => {
		const tools = new Map();
		let checks = 0;
		register({
			registerTool: (tool) => tools.set(tool.name, tool),
			registerCommand() {},
			async exec(command, args) {
				assert.equal(command, 'tmux');
				assert.equal(args[0], '-u');
				args = args.slice(1);
				if (args[0] === 'has-session') {
					if (!args.includes('=pi-repl-matlab')) return { code: 1, stdout: '', stderr: "can't find session" };
					checks++;
					if (checks === 1 || outcome === 'still-live') return { code: 0, stdout: '', stderr: '' };
					return { code: 1, stdout: '', stderr: outcome === 'ended' ? 'no server running on /tmp/test.sock' : 'error connecting to /tmp/test.sock (Permission denied)' };
				}
				if (args[0] === 'list-panes') return { code: 1, stdout: '', stderr: 'server exited unexpectedly' };
				assert.fail(`Unexpected mutation or inspection: ${args.join(' ')}`);
			},
		});
		const request = tools.get('repl_status').execute('exit-race', { target: 'matlab' }, undefined, undefined, { cwd: process.cwd() });
		if (outcome === 'ended') assert.equal((await request).details.matlab.running, false);
		else await assert.rejects(request, /Could not locate a REPL pane/);
		assert.equal(checks, 2);
	});
}

test("help and schemas advertise Ruby, Java, exports and existing echo controls", async () => {
	const f = fixture();
	await f.command("");
	const help = f.notifications.at(-1).message;
	for (const name of ["ruby", "java", "octave", "matlab", "gnuplot", "cpp"]) {
		assert.match(help, new RegExp(`/repl ${name}`));
		assert.match(f.tools.get("repl_send").parameters.properties.target.description, new RegExp(name));
	}
	assert.match(help, /\/repl echo \[off\|summary\|full\]/);
	assert.match(help, /\/repl export \[python\|julia\|r\|ghci\|clojure\|ruby\|java\|octave\|matlab\|gnuplot\|cpp\]/);
});

test("/repl send takes its target from the first line and the code from the lines below", async () => {
	const f = fixture();
	const sendsTo = async (args, session) => {
		await f.command(args);
		const { message, level } = f.notifications.at(-1);
		assert.equal(level, "error");
		assert.match(message, new RegExp(session), message);
	};
	for (const args of ["send", "send julia", "send\n   \n"]) {
		await f.command(args);
		assert.match(f.notifications.at(-1).message, /^Nothing to send\. Usage: \/repl send \[runtime\], with the code on the lines below it/);
	}
	await f.command("send print(1)");
	assert.match(f.notifications.at(-1).message, /^Unknown REPL for \/repl send: print\(1\)\. Usage:/);
	await f.command("send julia println(1)");
	assert.match(f.notifications.at(-1).message, /^Usage: \/repl send \[runtime\]/);
	await sendsTo("send\nprint(1)", "pi-repl-python");
	await sendsTo("send R\nprint(1)", "pi-repl-r");
	await sendsTo("send haskell\nprint 1", "pi-repl-ghci");
	await sendsTo("send\tgnuplot \r\nprint 1", "pi-repl-gnuplot");
	await f.command("");
	assert.match(f.notifications.at(-1).message, /\/repl send \[runtime\], with the code on the lines below it/);
});
