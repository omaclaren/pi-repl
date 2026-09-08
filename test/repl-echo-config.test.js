import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const script = `
import register from './index.ts';
let repl;
register({
  registerCommand(name, command) { if (name === 'repl') repl = command; },
  registerTool() {},
  exec() { throw new Error('Echo configuration must not execute shell commands'); },
});
await repl.handler('echo', { hasUI: false });
`;

for (const [value, expected] of [[undefined, "summary"], ["", "summary"], ["invalid", "summary"], [" off ", "off"], ["FULL", "full"]]) {
	test(`startup echo mode ${JSON.stringify(value) ?? "unset"} resolves to ${expected}`, () => {
		const env = { ...process.env };
		if (value === undefined) delete env.PI_REPL_ECHO_MODE;
		else env.PI_REPL_ECHO_MODE = value;
		const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
			cwd, env, encoding: "utf8", timeout: 15000,
		});
		assert.match(output, new RegExp(`REPL submission echo: ${expected}\\.`));
	});
}
