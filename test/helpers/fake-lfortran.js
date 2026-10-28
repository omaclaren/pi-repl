// A stand-in for LFortran main's command line, for the session tests; run it
// through a `lfortran` wrapper that execs node on it.
//   --help, kernel --help, --version   what the preflight looks for
//   kernel -f FILE [--managed]         the fake kernel (fake-kernel-process.js)
//   --connect FILE                     a prompt: `>>> `, each line run as a cell, its output printed
// FAKE_LFORTRAN_NO_CONNECT=1 leaves --connect out of --help.
import { JupyterClient, readConnectionFile, waitForExecution } from "../../shared/repl-jupyter.js";

const args = process.argv.slice(2);
if (args[0] === "--version") {
	console.log("LFortran version: 0.0.0-fake");
} else if (args[0] === "--help") {
	console.log(`Usage: lfortran [OPTIONS] [SUBCOMMAND]\n${process.env.FAKE_LFORTRAN_NO_CONNECT ? "" : "  --connect TEXT         Run the prompt in the Jupyter kernel of the connection FILE\n"}  kernel                 Run in Jupyter kernel mode.`);
} else if (args[0] === "kernel" && args[1] === "--help") {
	console.log("  -f TEXT REQUIRED       The kernel connection file\n  --managed              Stop when the last client disconnects");
} else if (args[0] === "kernel") {
	await import("./fake-kernel-process.js");
} else if (args[0] === "--connect") {
	const file = args[1];
	const client = await JupyterClient.connect(readConnectionFile(file), { timeoutMs: 10_000 });
	process.stdout.write(`  * Others can join with \`lfortran --connect ${file}\`\n>>> `);
	let pending = "";
	let queue = Promise.resolve();
	process.stdin.on("data", (chunk) => {
		pending += chunk.toString("utf8");
		let newline;
		while ((newline = pending.search(/\r?\n|\r/)) >= 0) {
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1).replace(/^\n/, "");
			queue = queue.then(async () => {
				if (line.trim()) {
					const request = client.prepareExecute(line);
					const done = waitForExecution(client, request, { timeoutMs: 10_000 });
					client.post("shell", request);
					const { iopub } = await done;
					const text = iopub.filter((m) => m.header.msg_type === "stream").map((m) => m.content.text).join("");
					if (text) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
				}
				process.stdout.write(">>> ");
			});
		}
	});
	process.stdin.on("end", () => queue.then(() => { client.close(); process.exit(0); }));
} else {
	console.error(`fake lfortran: unknown arguments ${JSON.stringify(args)}`);
	process.exit(2);
}
