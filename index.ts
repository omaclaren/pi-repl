import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	truncateTail,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SUPPORTED_RUNTIMES = ["julia", "python", "ipython", "r", "ghci", "clojure", "clj", "ruby", "java", "bun"] as const;
const DEFAULT_PYTHON_SESSION = "pi-repl-python";
const DEFAULT_JULIA_SESSION = "pi-repl-julia";
const DEFAULT_R_SESSION = "pi-repl-r";
const DEFAULT_GHCI_SESSION = "pi-repl-ghci";
const DEFAULT_CLOJURE_SESSION = "pi-repl-clojure";
const DEFAULT_RUBY_SESSION = "pi-repl-ruby";
const DEFAULT_JAVA_SESSION = "pi-repl-java";
const DEFAULT_CAPTURE_LINES = 20;
const DEFAULT_STARTUP_WAIT_MS = 5_000;
const DEFAULT_STARTUP_POLL_MS = 250;
const DEFAULT_REPL_SEND_TIMEOUT_MS = 20_000;
const MAX_REPL_SEND_TIMEOUT_MS = 120_000;
const REPL_SEND_POLL_MS = 100;
const REPL_SEND_CAPTURE_LINES = 5_000;
const REPL_CONTROL_ROOT = process.platform === "win32" ? tmpdir() : "/tmp";
const REPL_HISTORY_ROOT = join(REPL_CONTROL_ROOT, "pi-repl");
const REPL_HISTORY_FILTER_SCRIPT = String.raw`
let line = [];
let col = 0;
let pendingEscape = false;
let csi = null;
let osc = false;
let oscEsc = false;

function ensureCol() {
  while (line.length < col) line.push(' ');
}

function writeText(text) {
  for (const ch of text) {
    ensureCol();
    line[col] = ch;
    col += 1;
  }
}

function clearToEndOfLine() {
  line.length = Math.min(line.length, col);
}

function emitCurrentLine() {
  process.stdout.write(line.join('').replace(/[ \t]+$/g, '') + '\n');
  line = [];
  col = 0;
}

function firstParam(buffer) {
  const raw = buffer.split(';', 1)[0];
  const value = Number.parseInt(raw || '1', 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function handleCsi(finalChar, buffer) {
  const n = firstParam(buffer);
  if (finalChar === 'C') {
    col += n;
    return;
  }
  if (finalChar === 'D') {
    col = Math.max(0, col - n);
    return;
  }
  if (finalChar === 'G') {
    col = Math.max(0, n - 1);
    return;
  }
  if (finalChar === 'K') {
    const mode = buffer === '2' ? 2 : buffer === '1' ? 1 : 0;
    if (mode === 2) {
      line = [];
      col = 0;
      return;
    }
    if (mode === 1) {
      for (let i = 0; i < col; i += 1) line[i] = ' ';
      return;
    }
    clearToEndOfLine();
  }
}

function handleChar(ch) {
  if (osc) {
    if (oscEsc && ch === '\\') {
      osc = false;
      oscEsc = false;
      return;
    }
    oscEsc = ch === '\u001b';
    if (ch === '\u0007') {
      osc = false;
      oscEsc = false;
    }
    return;
  }

  if (csi !== null) {
    if (ch >= '@' && ch <= '~') {
      handleCsi(ch, csi);
      csi = null;
      return;
    }
    csi += ch;
    return;
  }

  if (pendingEscape) {
    pendingEscape = false;
    if (ch === '[') {
      csi = '';
      return;
    }
    if (ch === ']') {
      osc = true;
      oscEsc = false;
      return;
    }
    return;
  }

  if (ch === '\u001b') {
    pendingEscape = true;
    return;
  }
  if (ch === '\r') {
    col = 0;
    return;
  }
  if (ch === '\n') {
    emitCurrentLine();
    return;
  }
  if (ch === '\b' || ch === '\u007f') {
    col = Math.max(0, col - 1);
    return;
  }
  if (ch === '\t') {
    writeText('\t');
    return;
  }
  if (ch < ' ') {
    return;
  }
  writeText(ch);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  for (const ch of chunk) handleChar(ch);
});
process.stdin.on('end', () => {
  if (line.length > 0) {
    process.stdout.write(line.join('').replace(/[ \t]+$/g, '') + '\n');
  }
});
`;
const REPL_RUNTIME_OPTION = "@pi_repl_runtime";
const REPL_HISTORY_OPTION = "@pi_repl_history_path";

type SupportedRuntime = (typeof SUPPORTED_RUNTIMES)[number];
type PythonRuntime = "python" | "ipython";
type ClojureRuntime = "clojure" | "clj";
type ManagedRuntime = PythonRuntime | "julia" | "r" | "ghci" | ClojureRuntime | "ruby" | "java";
type ImplementedRuntime = PythonRuntime | "julia" | "r" | "ghci" | "clojure" | "ruby" | "java";
type SessionSelector = "python" | "julia" | "r" | "ghci" | "clojure" | "ruby" | "java";

type ReplCommand =
	| { action: "help" }
	| { action: "status"; runtime?: ManagedRuntime }
	| { action: "env"; runtime?: ManagedRuntime }
	| { action: "stop"; runtime?: ManagedRuntime }
	| { action: "attach"; runtime?: ManagedRuntime }
	| { action: "start"; runtime: SupportedRuntime; name?: string }
	| { action: "error"; message: string };

type SessionInfo = {
	sessionName: string;
	runtime?: string;
	historyPath?: string;
	currentCommand: string;
	currentPath: string;
	tail: string;
};

type ReplSendDetails = {
	sessionName: string;
	runtime: ImplementedRuntime;
	timeoutMs: number;
	target: SessionSelector;
	submittedCode: string;
	previewComment?: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
};

const REPL_SEND_PARAMS = Type.Object({
	code: Type.String({ description: "Python, IPython, Julia, R, GHCi, Ruby, Java, or Clojure code to execute in the shared REPL session." }),
	target: Type.Optional(
		Type.String({
			description: "Optional target REPL: python, julia, r, ghci, or clojure. If omitted, repl_send uses the shared Python/IPython session.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description: "Maximum time to wait for completion in milliseconds (default 20000).",
			minimum: 1000,
			maximum: MAX_REPL_SEND_TIMEOUT_MS,
		}),
	),
});

const REPL_STATUS_PARAMS = Type.Object({
	target: Type.Optional(
		Type.String({
			description: "Optional session target: python, julia, r, ghci, ruby, java, or clojure. If omitted, report all shared REPL sessions.",
		}),
	),
});

function tokenizeArgs(args: string): string[] {
	const parts = args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
	if (!parts) return [];

	return parts
		.map((token) => {
			if (
				(token.startsWith('"') && token.endsWith('"') && token.length >= 2) ||
				(token.startsWith("'") && token.endsWith("'") && token.length >= 2)
			) {
				return token.slice(1, -1);
			}
			return token;
		})
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
}

function isSupportedRuntime(value: string): value is SupportedRuntime {
	return SUPPORTED_RUNTIMES.includes(value as SupportedRuntime);
}

function isPythonRuntime(value: SupportedRuntime): value is PythonRuntime {
	return value === "python" || value === "ipython";
}

function isClojureRuntime(value: SupportedRuntime): value is ClojureRuntime {
	return value === "clojure" || value === "clj";
}

function isSessionTargetRuntime(value: string): value is ManagedRuntime {
	return value === "python" || value === "ipython" || value === "julia" || value === "r" || value === "ghci" || value === "clojure" || value === "clj" || value === "ruby" || value === "java";
}

function toSessionSelector(runtime: ManagedRuntime): SessionSelector {
	if (runtime === "julia") return "julia";
	if (runtime === "r") return "r";
	if (runtime === "ghci") return "ghci";
	if (runtime === "clojure" || runtime === "clj") return "clojure";
	if (runtime === "ruby") return "ruby";
	if (runtime === "java") return "java";
	return "python";
}

function getSessionNameForSelector(selector: SessionSelector): string {
	if (selector === "julia") return DEFAULT_JULIA_SESSION;
	if (selector === "r") return DEFAULT_R_SESSION;
	if (selector === "ghci") return DEFAULT_GHCI_SESSION;
	if (selector === "clojure") return DEFAULT_CLOJURE_SESSION;
	if (selector === "ruby") return DEFAULT_RUBY_SESSION;
	if (selector === "java") return DEFAULT_JAVA_SESSION;
	return DEFAULT_PYTHON_SESSION;
}

function getSessionHistoryPath(sessionName: string): string {
	return join(REPL_HISTORY_ROOT, `${sessionName}.history.log`);
}

function sanitizeNamePart(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
}

function buildSessionName(runtime: SupportedRuntime, name?: string): string {
	const base = `pi-repl-${runtime}`;
	if (!name) return base;

	const safeName = sanitizeNamePart(name);
	return safeName ? `${base}-${safeName}` : base;
}

function formatUsage(): string {
	return [
		"Usage:",
		"  /repl python",
		"  /repl ipython",
		"  /repl julia",
		"  /repl r",
		"  /repl ghci",
		"  /repl clojure",
		"  /repl ruby",
		"  /repl java",
		"  /repl status [python|julia|r|ghci|clojure|ruby|java]",
		"  /repl env [python]",
		"  /repl attach [python|julia|r|ghci|clojure|ruby|java]",
		"  /repl stop [python|julia|r|ghci|clojure|ruby|java]",
		"",
		"Supported runtimes right now: python, ipython, julia, r, ghci, clojure, ruby, java",
		"For R, both /repl R and /repl r work. The same applies to /lab, /repl status, /repl attach, and /repl stop.",
		"For Clojure, /repl clojure is canonical and /repl clj also works. The same applies to /lab, /repl status, /repl attach, and /repl stop.",
		"For Ruby, /repl ruby is the command. The Ruby REPL (irb) is invoked internally.",
		"For Java, /repl java is the command. The Java REPL (jshell) is invoked internally.",
		"",
		"Current real implementation:",
		"  - /repl python and /repl ipython manage the shared tmux session pi-repl-python",
		"  - /repl julia manages the shared tmux session pi-repl-julia",
		"  - /repl r manages the shared tmux session pi-repl-r",
		"  - /repl ghci manages the shared tmux session pi-repl-ghci",
		"  - /repl clojure and /repl clj manage the shared tmux session pi-repl-clojure",
		"  - /repl ruby manages the shared tmux session pi-repl-ruby",
		"  - /repl java manages the shared tmux session pi-repl-java",
		"  - /repl status, /repl attach, and /repl stop can target Python/IPython, Julia, R, GHCi, Clojure, Ruby, or Java",
		"  - /repl env inspects the shared Python/IPython session",
		"  - the repl_send tool can execute code in the shared Python/IPython, Julia, R, GHCi, Clojure, Ruby, or Java session",
		"",
		"Examples:",
		"  /repl ipython",
		"  /repl julia",
		"  /repl R",
		"  /repl ghci",
		"  /repl ruby",
		"  /repl java",
		"  /repl clojure",
		"  /repl status clojure",
		"  /repl attach",
	].join("\n");
}

function parseReplCommand(args: string): ReplCommand {
	const tokens = tokenizeArgs(args);
	if (tokens.length === 0) return { action: "help" };

	const [first, ...rest] = tokens;
	const firstLower = first.toLowerCase();

	if (["help", "-h", "--help", "?"].includes(firstLower)) {
		return { action: "help" };
	}

	if (firstLower === "status" || firstLower === "env" || firstLower === "stop" || firstLower === "attach") {
		if (rest.length > 1) {
			return {
				action: "error",
				message: `Unexpected arguments for /repl ${firstLower}: ${rest.join(" ")}`,
			};
		}

		if (rest.length === 1) {
			const selector = rest[0].toLowerCase();
			if (!isSessionTargetRuntime(selector)) {
				return {
					action: "error",
					message: `Unknown argument for /repl ${firstLower}: ${rest[0]}`,
				};
			}
			if (firstLower === "status") return { action: "status", runtime: selector };
			if (firstLower === "env") return { action: "env", runtime: selector };
			if (firstLower === "stop") return { action: "stop", runtime: selector };
			return { action: "attach", runtime: selector };
		}

		if (firstLower === "status") return { action: "status" };
		if (firstLower === "env") return { action: "env" };
		if (firstLower === "stop") return { action: "stop" };
		return { action: "attach" };
	}

	if (!isSupportedRuntime(firstLower)) {
		return {
			action: "error",
			message: `Unknown /repl subcommand or runtime: ${first}`,
		};
	}

	let name: string | undefined;

	for (let i = 0; i < rest.length; i++) {
		const token = rest[i];
		if (token === "--name" || token === "-n") {
			const value = rest[i + 1];
			if (!value) {
				return {
					action: "error",
					message: "Missing value for --name",
				};
			}
			name = value;
			i += 1;
			continue;
		}

		return {
			action: "error",
			message: `Unknown argument for /repl ${firstLower}: ${token}`,
		};
	}

	if (name !== undefined && sanitizeNamePart(name).length === 0) {
		return {
			action: "error",
			message: `Session name is empty after sanitization: ${name}`,
		};
	}

	return {
		action: "start",
		runtime: firstLower,
		name,
	};
}

async function commandExists(pi: ExtensionAPI, command: string, cwd: string): Promise<boolean> {
	const lookupCommand = process.platform === "win32" ? "where" : "which";
	try {
		const result = await pi.exec(lookupCommand, [command], { cwd, timeout: 2_000 });
		return result.code === 0;
	} catch {
		return false;
	}
}

async function execTmux(
	pi: ExtensionAPI,
	args: string[],
	cwd: string,
	timeout = 5_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const result = await pi.exec("tmux", args, { cwd, timeout });
	return {
		code: result.code ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
		return;
	}

	if (level === "error") {
		console.error(message);
		return;
	}

	console.log(message);
}

function formatAttachCommand(sessionName: string): string {
	return `tmux attach -t ${sessionName}`;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildRuntimeLaunchCommand(runtime: ManagedRuntime): string {
	if (runtime === "r") return "R";
	if (runtime === "clj" || runtime === "clojure") return "clojure";
	if (runtime === "ruby") return "irb";
	if (runtime === "java") return "jshell";
	return runtime;
}

function buildDefaultShellRuntimeCommand(runtime: ManagedRuntime): { shell: string; command: string } {
	const shell = process.env.SHELL?.trim() || "/bin/sh";
	const runtimeCommand = buildRuntimeLaunchCommand(runtime);
	return {
		shell,
		command: `${shellQuote(shell)} -i -l -c ${shellQuote(runtimeCommand)}`,
	};
}

function normalizePythonRuntime(info: SessionInfo | null): PythonRuntime {
	if (info?.runtime === "ipython") return "ipython";
	if (info?.tail.includes("IPython") || info?.tail.includes("In [")) return "ipython";
	return "python";
}

function clampReplSendTimeout(timeoutMs: number | undefined): number {
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
		return DEFAULT_REPL_SEND_TIMEOUT_MS;
	}

	return Math.max(1_000, Math.min(MAX_REPL_SEND_TIMEOUT_MS, Math.round(timeoutMs)));
}

function getPaneTarget(sessionName: string): string {
	return `${sessionName}:0.0`;
}

async function tmuxSessionExists(pi: ExtensionAPI, sessionName: string, cwd: string): Promise<boolean> {
	try {
		const result = await execTmux(pi, ["has-session", "-t", sessionName], cwd, 3_000);
		return result.code === 0;
	} catch {
		return false;
	}
}

async function setTmuxSessionOption(
	pi: ExtensionAPI,
	sessionName: string,
	optionName: string,
	value: string,
	cwd: string,
): Promise<boolean> {
	const result = await execTmux(pi, ["set-option", "-q", "-t", sessionName, optionName, value], cwd, 3_000);
	return result.code === 0;
}

async function readTmuxSessionOption(
	pi: ExtensionAPI,
	sessionName: string,
	optionName: string,
	cwd: string,
): Promise<string | undefined> {
	const result = await execTmux(pi, ["show-options", "-v", "-t", sessionName, optionName], cwd, 3_000);
	if (result.code !== 0) return undefined;

	const value = result.stdout.trim();
	return value || undefined;
}

async function enableSessionHistoryLogging(
	pi: ExtensionAPI,
	sessionName: string,
	cwd: string,
): Promise<{ historyPath?: string; warning?: string }> {
	const historyPath = getSessionHistoryPath(sessionName);
	mkdirSync(REPL_HISTORY_ROOT, { recursive: true });
	writeFileSync(historyPath, "", "utf-8");

	const pipeCommand = `${shellQuote(process.execPath)} -e ${shellQuote(REPL_HISTORY_FILTER_SCRIPT)} >> ${shellQuote(historyPath)}`;
	const result = await execTmux(pi, ["pipe-pane", "-o", "-t", getPaneTarget(sessionName), pipeCommand], cwd, 5_000);
	if (result.code !== 0) {
		const reason = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		return {
			warning: `History logging could not be enabled for ${sessionName}: ${reason}`,
		};
	}

	const stored = await setTmuxSessionOption(pi, sessionName, REPL_HISTORY_OPTION, historyPath, cwd);
	if (!stored) {
		return {
			historyPath,
			warning: `History logging is active for ${sessionName}, but the history path could not be recorded in tmux metadata.`,
		};
	}

	return { historyPath };
}

async function disableSessionHistoryLogging(pi: ExtensionAPI, sessionName: string, cwd: string): Promise<void> {
	await execTmux(pi, ["pipe-pane", "-t", getPaneTarget(sessionName)], cwd, 3_000).catch(() => undefined);
}

async function readSessionInfo(pi: ExtensionAPI, sessionName: string, cwd: string): Promise<SessionInfo | null> {
	if (!(await tmuxSessionExists(pi, sessionName, cwd))) return null;

	const target = getPaneTarget(sessionName);
	const summaryResult = await execTmux(
		pi,
		["display-message", "-p", "-t", target, "#{session_name}\t#{pane_current_command}\t#{pane_current_path}"],
		cwd,
		3_000,
	);
	const [resolvedSessionName = sessionName, currentCommand = "unknown", currentPath = cwd] = summaryResult.stdout
		.trim()
		.split("\t");

	const tailResult = await execTmux(pi, ["capture-pane", "-p", "-t", target, "-S", `-${DEFAULT_CAPTURE_LINES}`], cwd, 3_000);
	const runtime = await readTmuxSessionOption(pi, sessionName, REPL_RUNTIME_OPTION, cwd);
	const historyPath = await readTmuxSessionOption(pi, sessionName, REPL_HISTORY_OPTION, cwd);

	return {
		sessionName: resolvedSessionName,
		runtime,
		historyPath,
		currentCommand: currentCommand || "unknown",
		currentPath: currentPath || cwd,
		tail: tailResult.stdout.trim(),
	};
}

function formatAttachInstructions(sessionName: string): string {
	return [
		"To use the REPL directly, open a new terminal window and run:",
		formatAttachCommand(sessionName),
	].join("\n");
}

function formatSessionInfo(info: SessionInfo): string {
	const lines = [
		`Session: ${info.sessionName}`,
		...(info.runtime ? [`Runtime: ${info.runtime}`] : []),
		`Current command: ${info.currentCommand}`,
		`Path: ${info.currentPath}`,
		...(info.historyPath ? [`History log: ${info.historyPath}`] : []),
		"",
		formatAttachInstructions(info.sessionName),
	];

	if (info.tail) {
		lines.push("", "Recent pane output:", info.tail);
	}

	return lines.join("\n");
}

function getSessionDisplayName(selector: SessionSelector, info?: SessionInfo | null): string {
	if (selector === "julia") return "Julia";
	if (selector === "r") return "R";
	if (selector === "ghci") return "Haskell (GHCi)";
	if (selector === "clojure") return "Clojure";
	if (selector === "ruby") return "Ruby (irb)";
	if (selector === "java") return "Java (jshell)";
	if (info?.runtime === "ipython") return "Python/IPython";
	return "Python/IPython";
}

async function listRunningSharedSessions(
	pi: ExtensionAPI,
	cwd: string,
): Promise<Array<{ selector: SessionSelector; info: SessionInfo }>> {
	const sessions: Array<{ selector: SessionSelector; info: SessionInfo }> = [];
	const pythonInfo = await readSessionInfo(pi, DEFAULT_PYTHON_SESSION, cwd);
	if (pythonInfo) sessions.push({ selector: "python", info: pythonInfo });
	const juliaInfo = await readSessionInfo(pi, DEFAULT_JULIA_SESSION, cwd);
	if (juliaInfo) sessions.push({ selector: "julia", info: juliaInfo });
	const rInfo = await readSessionInfo(pi, DEFAULT_R_SESSION, cwd);
	if (rInfo) sessions.push({ selector: "r", info: rInfo });
	const ghciInfo = await readSessionInfo(pi, DEFAULT_GHCI_SESSION, cwd);
	if (ghciInfo) sessions.push({ selector: "ghci", info: ghciInfo });
	const clojureInfo = await readSessionInfo(pi, DEFAULT_CLOJURE_SESSION, cwd);
	if (clojureInfo) sessions.push({ selector: "clojure", info: clojureInfo });
	const rubyInfo = await readSessionInfo(pi, DEFAULT_RUBY_SESSION, cwd);
	if (rubyInfo) sessions.push({ selector: "ruby", info: rubyInfo });
	const javaInfo = await readSessionInfo(pi, DEFAULT_JAVA_SESSION, cwd);
	if (javaInfo) sessions.push({ selector: "java", info: javaInfo });
	return sessions;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPythonSessionInfo(
	pi: ExtensionAPI,
	cwd: string,
	shellPath: string,
	runtime: PythonRuntime,
): Promise<SessionInfo | null> {
	const deadline = Date.now() + DEFAULT_STARTUP_WAIT_MS;
	const shellName = shellPath.split("/").pop() ?? shellPath;
	let latestInfo: SessionInfo | null = null;

	while (Date.now() < deadline) {
		latestInfo = await readSessionInfo(pi, DEFAULT_PYTHON_SESSION, cwd);
		if (!latestInfo) return null;
		if (latestInfo.currentCommand !== shellName) return latestInfo;
		if (latestInfo.tail.includes(">>>")) return latestInfo;
		if (runtime === "ipython" && (latestInfo.tail.includes("IPython") || latestInfo.tail.includes("In ["))) {
			return latestInfo;
		}
		await sleep(DEFAULT_STARTUP_POLL_MS);
	}

	return latestInfo;
}

async function waitForJuliaSessionInfo(
	pi: ExtensionAPI,
	cwd: string,
	shellPath: string,
): Promise<SessionInfo | null> {
	const deadline = Date.now() + DEFAULT_STARTUP_WAIT_MS;
	const shellName = shellPath.split("/").pop() ?? shellPath;
	let latestInfo: SessionInfo | null = null;

	while (Date.now() < deadline) {
		latestInfo = await readSessionInfo(pi, DEFAULT_JULIA_SESSION, cwd);
		if (!latestInfo) return null;
		if (latestInfo.currentCommand !== shellName) return latestInfo;
		if (latestInfo.tail.includes("julia>")) return latestInfo;
		await sleep(DEFAULT_STARTUP_POLL_MS);
	}

	return latestInfo;
}

async function waitForRSessionInfo(
	pi: ExtensionAPI,
	cwd: string,
	shellPath: string,
): Promise<SessionInfo | null> {
	const deadline = Date.now() + DEFAULT_STARTUP_WAIT_MS;
	const shellName = shellPath.split("/").pop() ?? shellPath;
	let latestInfo: SessionInfo | null = null;

	while (Date.now() < deadline) {
		latestInfo = await readSessionInfo(pi, DEFAULT_R_SESSION, cwd);
		if (!latestInfo) return null;
		if (latestInfo.currentCommand !== shellName) return latestInfo;
		if (/(^|\n)>\s*$/.test(latestInfo.tail)) return latestInfo;
		await sleep(DEFAULT_STARTUP_POLL_MS);
	}

	return latestInfo;
}

async function waitForGhciSessionInfo(
	pi: ExtensionAPI,
	cwd: string,
	shellPath: string,
): Promise<SessionInfo | null> {
	const deadline = Date.now() + DEFAULT_STARTUP_WAIT_MS;
	const shellName = shellPath.split("/").pop() ?? shellPath;
	let latestInfo: SessionInfo | null = null;

	while (Date.now() < deadline) {
		latestInfo = await readSessionInfo(pi, DEFAULT_GHCI_SESSION, cwd);
		if (!latestInfo) return null;
		if (latestInfo.currentCommand !== shellName) return latestInfo;
		if (/(^|\n)(ghci>|Prelude>|\*?[A-Za-z0-9_.:]+>)\s*$/.test(latestInfo.tail)) return latestInfo;
		await sleep(DEFAULT_STARTUP_POLL_MS);
	}

	return latestInfo;
}

async function waitForClojureSessionInfo(
	pi: ExtensionAPI,
	cwd: string,
	shellPath: string,
): Promise<SessionInfo | null> {
	const deadline = Date.now() + DEFAULT_STARTUP_WAIT_MS;
	const shellName = shellPath.split("/").pop() ?? shellPath;
	let latestInfo: SessionInfo | null = null;

	while (Date.now() < deadline) {
		latestInfo = await readSessionInfo(pi, DEFAULT_CLOJURE_SESSION, cwd);
		if (!latestInfo) return null;
		if (latestInfo.currentCommand !== shellName) return latestInfo;
		if (/(^|\n)[^\s>]+=>\s*$/.test(latestInfo.tail)) return latestInfo;
		await sleep(DEFAULT_STARTUP_POLL_MS);
	}

	return latestInfo;
}

async function waitForRubySessionInfo(
	pi: ExtensionAPI,
	cwd: string,
	shellPath: string,
): Promise<SessionInfo | null> {
	const deadline = Date.now() + DEFAULT_STARTUP_WAIT_MS;
	const shellName = shellPath.split("/").pop() ?? shellPath;
	let latestInfo: SessionInfo | null = null;

	while (Date.now() < deadline) {
		latestInfo = await readSessionInfo(pi, DEFAULT_RUBY_SESSION, cwd);
		if (!latestInfo) return null;
		if (latestInfo.currentCommand !== shellName) return latestInfo;
		if (/irb\(.*\)[:\d]+[>*]\s*$/.test(latestInfo.tail)) return latestInfo;
		await sleep(DEFAULT_STARTUP_POLL_MS);
	}

	return latestInfo;
}

async function waitForJavaSessionInfo(
	pi: ExtensionAPI,
	cwd: string,
	shellPath: string,
): Promise<SessionInfo | null> {
	const deadline = Date.now() + DEFAULT_STARTUP_WAIT_MS;
	const shellName = shellPath.split("/").pop() ?? shellPath;
	let latestInfo: SessionInfo | null = null;

	while (Date.now() < deadline) {
		latestInfo = await readSessionInfo(pi, DEFAULT_JAVA_SESSION, cwd);
		if (!latestInfo) return null;
		if (latestInfo.currentCommand !== shellName) return latestInfo;
		if (/jshell>\s*$/.test(latestInfo.tail)) return latestInfo;
		await sleep(DEFAULT_STARTUP_POLL_MS);
	}

	return latestInfo;
}

type ReplControlPaths = {
	dir: string;
	sourceFile: string;
	doneFile: string;
};

function getReplControlPaths(sessionName: string): ReplControlPaths {
	if (sessionName === DEFAULT_PYTHON_SESSION) {
		return {
			dir: REPL_CONTROL_ROOT,
			sourceFile: join(REPL_CONTROL_ROOT, "pr.py"),
			doneFile: join(REPL_CONTROL_ROOT, "pr.py.done"),
		};
	}

	if (sessionName === DEFAULT_JULIA_SESSION) {
		return {
			dir: REPL_CONTROL_ROOT,
			sourceFile: join(REPL_CONTROL_ROOT, "jr.jl"),
			doneFile: join(REPL_CONTROL_ROOT, "jr.jl.done"),
		};
	}

	if (sessionName === DEFAULT_R_SESSION) {
		return {
			dir: REPL_CONTROL_ROOT,
			sourceFile: join(REPL_CONTROL_ROOT, "rr.R"),
			doneFile: join(REPL_CONTROL_ROOT, "rr.R.done"),
		};
	}

	if (sessionName === DEFAULT_GHCI_SESSION) {
		return {
			dir: REPL_CONTROL_ROOT,
			sourceFile: join(REPL_CONTROL_ROOT, "gr.ghci"),
			doneFile: join(REPL_CONTROL_ROOT, "gr.ghci.done"),
		};
	}

	if (sessionName === DEFAULT_CLOJURE_SESSION) {
		return {
			dir: REPL_CONTROL_ROOT,
			sourceFile: join(REPL_CONTROL_ROOT, "cr.clj"),
			doneFile: join(REPL_CONTROL_ROOT, "cr.clj.done"),
		};
	}

	if (sessionName === DEFAULT_RUBY_SESSION) {
		return {
			dir: REPL_CONTROL_ROOT,
			sourceFile: join(REPL_CONTROL_ROOT, "rr.rb"),
			doneFile: join(REPL_CONTROL_ROOT, "rr.rb.done"),
		};
	}

	if (sessionName === DEFAULT_JAVA_SESSION) {
		return {
			dir: REPL_CONTROL_ROOT,
			sourceFile: join(REPL_CONTROL_ROOT, "jr.java"),
			doneFile: join(REPL_CONTROL_ROOT, "jr.java.done"),
		};
	}

	const dir = join(REPL_CONTROL_ROOT, sessionName);
	return {
		dir,
		sourceFile: join(dir, "control.py"),
		doneFile: join(dir, "done.flag"),
	};
}

function buildPythonControlSource(runtime: PythonRuntime, code: string, doneFile: string): string {
	if (runtime === "ipython") {
		return [
			"from pathlib import Path as __pi_repl_path",
			"import traceback as __pi_repl_traceback",
			"try:",
			"    __pi_repl_ip = get_ipython()",
			"    if __pi_repl_ip is None:",
			"        raise RuntimeError('Expected IPython session, but get_ipython() returned None.')",
			`    __pi_repl_result = __pi_repl_ip.run_cell(${JSON.stringify(code)}, store_history=False)`,
			"    if getattr(__pi_repl_result, 'error_in_exec', None) is None and getattr(__pi_repl_result, 'result', None) is not None:",
			"        print(repr(__pi_repl_result.result))",
			"except Exception:",
			"    __pi_repl_traceback.print_exc()",
			"finally:",
			`    __pi_repl_path(${JSON.stringify(doneFile)}).write_text('done\\n', encoding='utf-8')`,
		].join("\n");
	}

	return [
		"from pathlib import Path as __pi_repl_path",
		"import traceback as __pi_repl_traceback",
		"try:",
		`    exec(compile(${JSON.stringify(code)}, '<pi-repl>', 'exec'), globals())`,
		"except Exception:",
		"    __pi_repl_traceback.print_exc()",
		"finally:",
		`    __pi_repl_path(${JSON.stringify(doneFile)}).write_text('done\\n', encoding='utf-8')`,
	].join("\n");
}

function buildJuliaControlSource(code: string, doneFile: string): string {
	return [
		"try",
		`    local __pi_result = Base.include_string(Main, ${JSON.stringify(code)}, "pi-repl")`,
		"    if !isnothing(__pi_result)",
		"        println(repr(__pi_result))",
		"    end",
		"catch e",
		"    Base.display_error(stderr, e, catch_backtrace())",
		"finally",
		`    write(${JSON.stringify(doneFile)}, "done\\n")`,
		"end",
	].join("\n");
}

function buildRControlSource(code: string, doneFile: string): string {
	return [
		"local({",
		`  .__pi_repl_done_file <- ${JSON.stringify(doneFile)}`,
		`  .__pi_repl_code <- ${JSON.stringify(code)}`,
		"  tryCatch({",
		"    .__pi_repl_exprs <- parse(text = .__pi_repl_code, keep.source = FALSE)",
		"    .__pi_repl_value <- NULL",
		"    .__pi_repl_visible <- FALSE",
		"    for (.__pi_repl_expr in .__pi_repl_exprs) {",
		"      .__pi_repl_result <- withVisible(eval(.__pi_repl_expr, envir = .GlobalEnv))",
		"      .__pi_repl_value <- .__pi_repl_result$value",
		"      .__pi_repl_visible <- isTRUE(.__pi_repl_result$visible)",
		"    }",
		"    if (.__pi_repl_visible) print(.__pi_repl_value)",
		"  }, error = function(e) {",
		"    .__pi_repl_call <- conditionCall(e)",
		"    if (is.null(.__pi_repl_call)) {",
		"      message(\"Error: \", conditionMessage(e))",
		"    } else {",
		"      message(\"Error in \", paste(deparse(.__pi_repl_call), collapse = \" \"), \": \", conditionMessage(e))",
		"    }",
		"  }, finally = {",
		"    writeLines(\"done\", .__pi_repl_done_file)",
		"  })",
		"})",
	].join("\n");
}

function buildGhciControlSource(code: string): string {
	return code.replace(/\r/g, "").trimEnd();
}

function buildRubyControlSource(code: string, doneFile: string): string {
	return [
		"begin",
		`  __pi_repl_code = ${JSON.stringify(code)}`,
		"  __pi_repl_result = eval(__pi_repl_code, TOPLEVEL_BINDING, '<pi-repl>', 1)",
		"  p __pi_repl_result unless __pi_repl_result.nil?",
		"rescue Exception => __pi_repl_e",
		"  $stderr.puts __pi_repl_e.full_message(highlight: false)",
		"ensure",
		`  File.write(${JSON.stringify(doneFile)}, "done\\n")`,
		"end",
	].join("\n");
}

function buildJavaControlSource(code: string, doneFile: string): string {
	return [
		"try {",
		...code.split("\n"),
		"} catch (Throwable __pi_e) {",
		"    __pi_e.printStackTrace();",
		"} finally {",
		`    java.nio.file.Files.write(java.nio.file.Paths.get(${JSON.stringify(doneFile)}), "done\\n".getBytes());`,
		"}",
	].join("\n");
}

function buildClojureControlSource(code: string, doneFile: string): string {
	return [
		"(let [code " + JSON.stringify(code) + "]",
		"  (try",
		"    (let [rdr (clojure.lang.LineNumberingPushbackReader. (java.io.StringReader. code))]",
		"      (loop [last-val nil has-val false]",
		"        (let [form (read rdr false :pi-repl/eof)]",
		"          (if (= form :pi-repl/eof)",
		"            (when (and has-val (some? last-val)) (prn last-val))",
		"            (recur (eval form) true)))))",
		"    (catch Throwable t",
		"      (#'clojure.main/repl-caught t))",
		"    (finally",
		`      (spit ${JSON.stringify(doneFile)} "done\\n"))))`,
	].join("\n");
}

function buildReplControlSource(runtime: ImplementedRuntime, code: string, doneFile: string): string {
	if (runtime === "julia") return buildJuliaControlSource(code, doneFile);
	if (runtime === "r") return buildRControlSource(code, doneFile);
	if (runtime === "ghci") return buildGhciControlSource(code);
	if (runtime === "clojure") return buildClojureControlSource(code, doneFile);
	if (runtime === "ruby") return buildRubyControlSource(code, doneFile);
	if (runtime === "java") return buildJavaControlSource(code, doneFile);
	return buildPythonControlSource(runtime, code, doneFile);
}

function buildReplSubmissionLine(runtime: ImplementedRuntime, sourceFile: string): string {
	const quotedPath = JSON.stringify(sourceFile);
	if (runtime === "julia") {
		return `include(${quotedPath})`;
	}
	if (runtime === "r") {
		return `source(${quotedPath},local=.GlobalEnv)`;
	}
	if (runtime === "ghci") {
		return `:script ${quotedPath}`;
	}
	if (runtime === "clojure") {
		return `(do (load-file ${quotedPath}) :pi-repl/silent)`;
	}
	if (runtime === "ruby") {
		return `load ${quotedPath}`;
	}
	if (runtime === "java") {
		return `/open ${sourceFile}`;
	}
	return `exec(open(${quotedPath}).read(),globals())`;
}

function buildReplPreviewComment(runtime: ImplementedRuntime, code: string): string | undefined {
	const normalized = code.replace(/\r/g, "").trimEnd();
	const lines = normalized.split("\n");
	if (lines.length === 1) {
		const oneLine = lines[0].trim().replace(/\s+/g, " ");
		if (oneLine.length > 0 && oneLine.length <= 80) {
			return undefined;
		}
	}
	const prefix = runtime === "ghci" ? "--" : runtime === "clojure" ? ";;" : runtime === "java" ? "//" : "#";
	return `${prefix} pi-repl: running ${lines.length}-line snippet`;
}

function buildReplCompletionLine(runtime: ImplementedRuntime, doneFile: string): string | undefined {
	if (runtime === "ghci") {
		return `:! touch ${shellQuote(doneFile)}`;
	}
	return undefined;
}

function buildSubmissionText(submissionLine: string, previewComment?: string, completionLine?: string): string {
	return [previewComment, submissionLine, completionLine].filter((value) => Boolean(value)).join("\n");
}

function prepareReplControlFiles(
	sessionName: string,
	runtime: ImplementedRuntime,
	code: string,
): { controlPaths: ReplControlPaths; submissionLine: string; completionLine?: string; previewComment?: string; submissionText: string } {
	const controlPaths = getReplControlPaths(sessionName);
	mkdirSync(controlPaths.dir, { recursive: true });
	try {
		unlinkSync(controlPaths.doneFile);
	} catch {
		// ignore if no previous done file exists
	}

	writeFileSync(controlPaths.sourceFile, buildReplControlSource(runtime, code, controlPaths.doneFile), "utf-8");
	const submissionLine = buildReplSubmissionLine(runtime, controlPaths.sourceFile);
	const completionLine = buildReplCompletionLine(runtime, controlPaths.doneFile);
	const previewComment = buildReplPreviewComment(runtime, code);
	return {
		controlPaths,
		submissionLine,
		completionLine,
		previewComment,
		submissionText: buildSubmissionText(submissionLine, previewComment, completionLine),
	};
}

async function pasteTextToTmuxPane(
	pi: ExtensionAPI,
	sessionName: string,
	cwd: string,
	text: string,
): Promise<void> {
	const bufferName = `pi-repl-${randomUUID()}`;
	const tempFile = join(REPL_CONTROL_ROOT, `${bufferName}.txt`);
	writeFileSync(tempFile, text, "utf-8");

	try {
		const loadResult = await execTmux(pi, ["load-buffer", "-b", bufferName, tempFile], cwd, 5_000);
		if (loadResult.code !== 0) {
			const reason = loadResult.stderr.trim() || loadResult.stdout.trim() || `exit code ${loadResult.code}`;
			throw new Error(`Failed to load tmux buffer: ${reason}`);
		}

		const pasteResult = await execTmux(pi, ["paste-buffer", "-d", "-b", bufferName, "-t", getPaneTarget(sessionName)], cwd, 5_000);
		if (pasteResult.code !== 0) {
			const reason = pasteResult.stderr.trim() || pasteResult.stdout.trim() || `exit code ${pasteResult.code}`;
			throw new Error(`Failed to paste tmux buffer: ${reason}`);
		}

		const enterResult = await execTmux(pi, ["send-keys", "-t", getPaneTarget(sessionName), "C-m"], cwd, 5_000);
		if (enterResult.code !== 0) {
			const reason = enterResult.stderr.trim() || enterResult.stdout.trim() || `exit code ${enterResult.code}`;
			throw new Error(`Failed to send Enter to tmux pane: ${reason}`);
		}
	} finally {
		try {
			unlinkSync(tempFile);
		} catch {
			// ignore cleanup errors
		}
		await execTmux(pi, ["delete-buffer", "-b", bufferName], cwd, 2_000).catch(() => undefined);
	}
}

async function capturePaneOutput(pi: ExtensionAPI, sessionName: string, cwd: string): Promise<string> {
	const result = await execTmux(
		pi,
		["capture-pane", "-p", "-t", getPaneTarget(sessionName), "-S", `-${REPL_SEND_CAPTURE_LINES}`],
		cwd,
		5_000,
	);
	if (result.code !== 0) {
		const reason = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		throw new Error(`Failed to capture tmux pane output: ${reason}`);
	}
	return result.stdout;
}

function stripBoundaryBlankLines(text: string): string {
	const lines = text.replace(/\r/g, "").split("\n");
	while (lines.length > 0 && lines[0] === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

function extractPaneDelta(before: string, after: string): string {
	const normalizedBefore = before.replace(/\r/g, "");
	const normalizedAfter = after.replace(/\r/g, "");

	if (normalizedAfter.startsWith(normalizedBefore)) {
		return normalizedAfter.slice(normalizedBefore.length);
	}

	const beforeLines = normalizedBefore.split("\n");
	const afterLines = normalizedAfter.split("\n");
	let index = 0;
	while (index < beforeLines.length && index < afterLines.length && beforeLines[index] === afterLines[index]) {
		index += 1;
	}
	return afterLines.slice(index).join("\n");
}

function cleanupReplDelta(delta: string, submissionLine: string, previewComment?: string, completionLine?: string): string {
	const lines = stripBoundaryBlankLines(delta).split("\n");
	const loaderHints = [submissionLine, "exec(open(", "run_cell(open(", "include(", "source(", ":script ", "load-file", "/open ", "/tmp/pr.py", "/tmp/jr.jl", "/tmp/rr.R", "/tmp/gr.ghci", "/tmp/cr.clj", "/tmp/rr.rb", "/tmp/jr.java", "/tmp/pi-repl", "control.py", ":pi-repl/silent"];
	const previewHints = previewComment ? [previewComment, "# pi-repl:", "-- pi-repl:", ";; pi-repl:"] : ["# pi-repl:", "-- pi-repl:", ";; pi-repl:"];

	while (lines.length > 0) {
		const first = lines[0]?.trim() ?? "";
		if (!first) {
			lines.shift();
			continue;
		}
		if (loaderHints.some((hint) => first.includes(hint))) {
			lines.shift();
			continue;
		}
		if (previewHints.some((hint) => first.includes(hint))) {
			lines.shift();
			continue;
		}
		if (
			/^\s*\.\.\.:/.test(first) ||
			/^>\s*$/.test(first) ||
			/^\+\s*$/.test(first) ||
			/^(ghci|Prelude|\*?[A-Za-z0-9_.:]+)>\s*$/.test(first) ||
			/^[^\s>]+=>\s*$/.test(first) ||
			/^irb\(.*\)[:\d]+[>*]\s*$/.test(first) ||
			/^jshell>\s*$/.test(first)
		) {
			lines.shift();
			continue;
		}
		break;
	}

	while (lines.length > 0) {
		const last = lines[lines.length - 1]?.trim() ?? "";
		if (
			!last ||
			(completionLine ? last.includes(completionLine) : false) ||
			/^>>>\s*$/.test(last) ||
			/^In \[\d+\]:\s*$/.test(last) ||
			/^\s*\.\.\.:\s*$/.test(last) ||
			/^julia>\s*$/.test(last) ||
			/^>\s*$/.test(last) ||
			/^\+\s*$/.test(last) ||
			/^(ghci|Prelude|\*?[A-Za-z0-9_.:]+)>\s*$/.test(last) ||
			/^[^\s>]+=>\s*$/.test(last) ||
			/^irb\(.*\)[:\d]+[>*]\s*$/.test(last) ||
			/^jshell>\s*$/.test(last) ||
			last === ":pi-repl/silent"
		) {
			lines.pop();
			continue;
		}
		break;
	}

	return stripBoundaryBlankLines(lines.join("\n"));
}

async function waitForReplDoneFile(
	pi: ExtensionAPI,
	sessionName: string,
	cwd: string,
	doneFile: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let latestCapture = "";

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error("repl_send was aborted.");
		}

		if (!(await tmuxSessionExists(pi, sessionName, cwd))) {
			throw new Error(`REPL session ended while waiting for output: ${sessionName}`);
		}

		if (existsSync(doneFile)) return;

		latestCapture = await capturePaneOutput(pi, sessionName, cwd);
		await sleep(REPL_SEND_POLL_MS);
	}

	const tail = truncateTail(latestCapture, {
		maxLines: 40,
		maxBytes: 8 * 1024,
	}).content.trim();
	const tailNote = tail ? `\n\nLatest pane output:\n${tail}` : "";
	throw new Error(
		`Timed out waiting for REPL output after ${timeoutMs}ms. The session may still be busy; attach with ${formatAttachCommand(sessionName)} or stop it with /repl stop.${tailNote}`,
	);
}

function normalizeReplSendTarget(target?: string): SessionSelector | undefined {
	const trimmed = target?.trim().toLowerCase();
	if (!trimmed) return undefined;
	if (trimmed === "python" || trimmed === "ipython") return "python";
	if (trimmed === "julia") return "julia";
	if (trimmed === "r") return "r";
	if (trimmed === "ghci" || trimmed === "haskell") return "ghci";
	if (trimmed === "clojure" || trimmed === "clj") return "clojure";
	if (trimmed === "ruby" || trimmed === "irb") return "ruby";
	if (trimmed === "java" || trimmed === "jshell") return "java";
	throw new Error(`Unknown repl_send target: ${target}`);
}

async function runReplCode(
	pi: ExtensionAPI,
	params: { code: string; target?: string; timeoutMs?: number },
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<{ output: string; details: ReplSendDetails }> {
	const code = params.code ?? "";
	if (!code.trim()) {
		throw new Error("repl_send requires non-empty code.");
	}

	const target = normalizeReplSendTarget(params.target) ?? "python";
	const sessionName = getSessionNameForSelector(target);

	if (!(await tmuxSessionExists(pi, sessionName, ctx.cwd))) {
		if (target === "julia") {
			throw new Error(
				`No default Julia REPL session is running (${DEFAULT_JULIA_SESSION}). Start one with /repl julia first.`,
			);
		}
		if (target === "r") {
			throw new Error(
				`No default R REPL session is running (${DEFAULT_R_SESSION}). Start one with /repl R or /repl r first.`,
			);
		}
		if (target === "ghci") {
			throw new Error(
				`No default Haskell (GHCi) REPL session is running (${DEFAULT_GHCI_SESSION}). Start one with /repl ghci first.`,
			);
		}
		if (target === "clojure") {
			throw new Error(
				`No default Clojure REPL session is running (${DEFAULT_CLOJURE_SESSION}). Start one with /repl clojure or /repl clj first.`,
			);
		}
		if (target === "ruby") {
			throw new Error(
				`No default Ruby REPL session is running (${DEFAULT_RUBY_SESSION}). Start one with /repl ruby first.`,
			);
		}
		if (target === "java") {
			throw new Error(
				`No default Java REPL session is running (${DEFAULT_JAVA_SESSION}). Start one with /repl java first.`,
			);
		}
		throw new Error(
			`No default Python/IPython REPL session is running (${DEFAULT_PYTHON_SESSION}). Start one with /repl python or /repl ipython first.`,
		);
	}

	const sessionInfo = await readSessionInfo(pi, sessionName, ctx.cwd);
	if (!sessionInfo) {
		if (target === "julia") {
			throw new Error(
				`Could not inspect the default Julia REPL session (${DEFAULT_JULIA_SESSION}). Start it again with /repl julia.`,
			);
		}
		if (target === "r") {
			throw new Error(
				`Could not inspect the default R REPL session (${DEFAULT_R_SESSION}). Start it again with /repl R or /repl r.`,
			);
		}
		if (target === "ghci") {
			throw new Error(
				`Could not inspect the default Haskell (GHCi) REPL session (${DEFAULT_GHCI_SESSION}). Start it again with /repl ghci.`,
			);
		}
		if (target === "clojure") {
			throw new Error(
				`Could not inspect the default Clojure REPL session (${DEFAULT_CLOJURE_SESSION}). Start it again with /repl clojure or /repl clj.`,
			);
		}
		if (target === "ruby") {
			throw new Error(
				`Could not inspect the default Ruby REPL session (${DEFAULT_RUBY_SESSION}). Start it again with /repl ruby.`,
			);
		}
		if (target === "java") {
			throw new Error(
				`Could not inspect the default Java REPL session (${DEFAULT_JAVA_SESSION}). Start it again with /repl java.`,
			);
		}
		throw new Error(
			`Could not inspect the default Python/IPython REPL session (${DEFAULT_PYTHON_SESSION}). Start it again with /repl python or /repl ipython.`,
		);
	}

	const runtime: ImplementedRuntime =
		target === "julia"
			? "julia"
			: target === "r"
				? "r"
				: target === "ghci"
					? "ghci"
					: target === "clojure"
						? "clojure"
						: target === "ruby"
							? "ruby"
							: target === "java"
								? "java"
								: normalizePythonRuntime(sessionInfo);
	const timeoutMs = clampReplSendTimeout(params.timeoutMs);
	const beforeCapture = await capturePaneOutput(pi, sessionName, ctx.cwd);
	const prepared = prepareReplControlFiles(sessionName, runtime, code);

	await pasteTextToTmuxPane(pi, sessionName, ctx.cwd, prepared.submissionText);
	await waitForReplDoneFile(
		pi,
		sessionName,
		ctx.cwd,
		prepared.controlPaths.doneFile,
		timeoutMs,
		signal,
	);
	const afterCapture = await capturePaneOutput(pi, sessionName, ctx.cwd);
	const delta = extractPaneDelta(beforeCapture, afterCapture);
	const output = cleanupReplDelta(delta, prepared.submissionLine, prepared.previewComment, prepared.completionLine);
	try {
		unlinkSync(prepared.controlPaths.doneFile);
	} catch {
		// ignore cleanup errors
	}

	return {
		output,
		details: {
			sessionName,
			runtime,
			target,
			timeoutMs,
			submittedCode: code,
			previewComment: prepared.previewComment,
		},
	};
}

function formatReplSendResult(output: string, details: ReplSendDetails): { text: string; details: ReplSendDetails } {
	const submittedCode = details.submittedCode.trimEnd();
	const outputText = output.trim() ? output : "(no output)";
	const truncation = truncateHead(outputText, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	let resultDetails: ReplSendDetails = details;
	let renderedOutput = truncation.content;

	if (truncation.truncated) {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-repl-output-"));
		const tempFile = join(tempDir, "output.txt");
		writeFileSync(tempFile, outputText, "utf-8");

		resultDetails = {
			...details,
			truncation,
			fullOutputPath: tempFile,
		};

		renderedOutput += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
		renderedOutput += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
		renderedOutput += ` Full output saved to: ${tempFile}]`;
	}

	const text = [
		"Submitted code:",
		submittedCode,
		"",
		"Output:",
		renderedOutput,
	].join("\n");

	return {
		text,
		details: resultDetails,
	};
}

async function executeReplSend(
	pi: ExtensionAPI,
	params: { code: string; target?: string; timeoutMs?: number },
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: ReplSendDetails }> {
	const execution = await runReplCode(pi, params, ctx, signal);
	const formatted = formatReplSendResult(execution.output, execution.details);

	return {
		content: [{ type: "text", text: formatted.text }],
		details: formatted.details,
	};
}

function buildReplEnvInspectionCode(): string {
	return [
		"import os, sys",
		"print(f'sys.executable={sys.executable}')",
		"print(f'sys.prefix={sys.prefix}')",
		"print(f'sys.base_prefix={getattr(sys, \"base_prefix\", sys.prefix)}')",
		"print(f'VIRTUAL_ENV={os.environ.get(\"VIRTUAL_ENV\") or \"\"}')",
		"print(f'CONDA_DEFAULT_ENV={os.environ.get(\"CONDA_DEFAULT_ENV\") or \"\"}')",
		"print(f'CONDA_PREFIX={os.environ.get(\"CONDA_PREFIX\") or \"\"}')",
		"print(f'PYENV_VERSION={os.environ.get(\"PYENV_VERSION\") or \"\"}')",
	].join("\n");
}

async function showDefaultPythonEnv(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	try {
		const execution = await runReplCode(
			pi,
			{
				code: buildReplEnvInspectionCode(),
				timeoutMs: 10_000,
			},
			ctx,
		);

		notify(
			ctx,
			[
				"Python/IPython REPL environment:",
				`Runtime: ${execution.details.runtime}`,
				`Session: ${execution.details.sessionName}`,
				"",
				execution.output.trim() || "(no output)",
			].join("\n"),
			"info",
		);
	} catch (error) {
		notify(ctx, error instanceof Error ? error.message : String(error), "error");
	}
}

async function startDefaultPythonSession(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runtime: PythonRuntime,
): Promise<void> {
	const exists = await tmuxSessionExists(pi, DEFAULT_PYTHON_SESSION, ctx.cwd);
	if (exists) {
		const info = await readSessionInfo(pi, DEFAULT_PYTHON_SESSION, ctx.cwd);
		const requestedLabel = runtime === "ipython" ? "IPython" : "Python";
		notify(
			ctx,
			info
				? `Default Python/IPython REPL session is already running (requested: ${requestedLabel}).\n\n${formatSessionInfo(info)}`
				: [
					"Default Python/IPython REPL session is already running.",
					"",
					"To use the REPL directly, open a new terminal window and run:",
					formatAttachCommand(DEFAULT_PYTHON_SESSION),
				].join("\n"),
			"info",
		);
		return;
	}

	const shellLaunch = buildDefaultShellRuntimeCommand(runtime);
	const createResult = await execTmux(
		pi,
		["new-session", "-d", "-s", DEFAULT_PYTHON_SESSION, "-c", ctx.cwd, shellLaunch.command],
		ctx.cwd,
		10_000,
	);
	if (createResult.code !== 0) {
		const reason = createResult.stderr.trim() || createResult.stdout.trim() || `exit code ${createResult.code}`;
		notify(ctx, `Failed to create tmux session ${DEFAULT_PYTHON_SESSION}: ${reason}`, "error");
		return;
	}

	const history = await enableSessionHistoryLogging(pi, DEFAULT_PYTHON_SESSION, ctx.cwd);
	await setTmuxSessionOption(pi, DEFAULT_PYTHON_SESSION, REPL_RUNTIME_OPTION, runtime, ctx.cwd);
	const info = await waitForPythonSessionInfo(pi, ctx.cwd, shellLaunch.shell, runtime);
	const replLabel = runtime === "ipython" ? "IPython" : "Python";

	if (history.warning) {
		notify(ctx, history.warning, "warning");
	}

	notify(
		ctx,
		[
			`Started default ${replLabel} REPL session: ${DEFAULT_PYTHON_SESSION}`,
			`Launch method: ${shellLaunch.shell} -i -l -c '${runtime}' inside tmux.`,
			"This is intended to respect your normal shell-level Python setup (aliases, pyenv/virtualenv/conda activation, shell init, etc.).",
			info
				? `\n${formatSessionInfo(info)}`
				: [
					"",
					"To use the REPL directly, open a new terminal window and run:",
					formatAttachCommand(DEFAULT_PYTHON_SESSION),
				].join("\n"),
		].join("\n"),
		"info",
	);
}

function formatNoSessionRunning(selector: SessionSelector): string {
	if (selector === "julia") {
		return [
			`No default Julia REPL session is running (${DEFAULT_JULIA_SESSION}).`,
			"Start one with /repl julia or /lab julia.",
		].join("\n");
	}

	if (selector === "r") {
		return [
			`No default R REPL session is running (${DEFAULT_R_SESSION}).`,
			"Start one with /repl R or /repl r, or /lab R or /lab r.",
		].join("\n");
	}

	if (selector === "ghci") {
		return [
			`No default Haskell (GHCi) REPL session is running (${DEFAULT_GHCI_SESSION}).`,
			"Start one with /repl ghci or /lab ghci.",
		].join("\n");
	}

	if (selector === "clojure") {
		return [
			`No default Clojure REPL session is running (${DEFAULT_CLOJURE_SESSION}).`,
			"Start one with /repl clojure or /repl clj, or /lab clojure or /lab clj.",
		].join("\n");
	}

	if (selector === "ruby") {
		return [
			`No default Ruby REPL session is running (${DEFAULT_RUBY_SESSION}).`,
			"Start one with /repl ruby or /lab ruby.",
		].join("\n");
	}

	if (selector === "java") {
		return [
			`No default Java REPL session is running (${DEFAULT_JAVA_SESSION}).`,
			"Start one with /repl java or /lab java.",
		].join("\n");
	}

	return [
		`No default Python/IPython REPL session is running (${DEFAULT_PYTHON_SESSION}).`,
		"Start one with /repl python, /repl ipython, /lab python, or /lab ipython.",
	].join("\n");
}

function buildReplStatusDetails(
	sessions: Array<{ selector: SessionSelector; info: SessionInfo }>,
): Record<string, unknown> {
	const python = sessions.find((session) => session.selector === "python")?.info;
	const julia = sessions.find((session) => session.selector === "julia")?.info;
	const r = sessions.find((session) => session.selector === "r")?.info;
	const ghci = sessions.find((session) => session.selector === "ghci")?.info;
	const clojure = sessions.find((session) => session.selector === "clojure")?.info;
	const ruby = sessions.find((session) => session.selector === "ruby")?.info;
	const java = sessions.find((session) => session.selector === "java")?.info;

	return {
		python: {
			running: Boolean(python),
			sessionName: python?.sessionName ?? DEFAULT_PYTHON_SESSION,
			runtime: python?.runtime ?? undefined,
			historyPath: python?.historyPath ?? undefined,
			historyLogging: Boolean(python?.historyPath),
			currentCommand: python?.currentCommand ?? undefined,
			currentPath: python?.currentPath ?? undefined,
			attachCommand: formatAttachCommand(DEFAULT_PYTHON_SESSION),
		},
		julia: {
			running: Boolean(julia),
			sessionName: julia?.sessionName ?? DEFAULT_JULIA_SESSION,
			runtime: julia?.runtime ?? undefined,
			historyPath: julia?.historyPath ?? undefined,
			historyLogging: Boolean(julia?.historyPath),
			currentCommand: julia?.currentCommand ?? undefined,
			currentPath: julia?.currentPath ?? undefined,
			attachCommand: formatAttachCommand(DEFAULT_JULIA_SESSION),
		},
		r: {
			running: Boolean(r),
			sessionName: r?.sessionName ?? DEFAULT_R_SESSION,
			runtime: r?.runtime ?? undefined,
			historyPath: r?.historyPath ?? undefined,
			historyLogging: Boolean(r?.historyPath),
			currentCommand: r?.currentCommand ?? undefined,
			currentPath: r?.currentPath ?? undefined,
			attachCommand: formatAttachCommand(DEFAULT_R_SESSION),
		},
		ghci: {
			running: Boolean(ghci),
			sessionName: ghci?.sessionName ?? DEFAULT_GHCI_SESSION,
			runtime: ghci?.runtime ?? undefined,
			historyPath: ghci?.historyPath ?? undefined,
			historyLogging: Boolean(ghci?.historyPath),
			currentCommand: ghci?.currentCommand ?? undefined,
			currentPath: ghci?.currentPath ?? undefined,
			attachCommand: formatAttachCommand(DEFAULT_GHCI_SESSION),
		},
		clojure: {
			running: Boolean(clojure),
			sessionName: clojure?.sessionName ?? DEFAULT_CLOJURE_SESSION,
			runtime: clojure?.runtime ?? undefined,
			historyPath: clojure?.historyPath ?? undefined,
			historyLogging: Boolean(clojure?.historyPath),
			currentCommand: clojure?.currentCommand ?? undefined,
			currentPath: clojure?.currentPath ?? undefined,
			attachCommand: formatAttachCommand(DEFAULT_CLOJURE_SESSION),
		},
		ruby: {
			running: Boolean(ruby),
			sessionName: ruby?.sessionName ?? DEFAULT_RUBY_SESSION,
			runtime: ruby?.runtime ?? undefined,
			historyPath: ruby?.historyPath ?? undefined,
			historyLogging: Boolean(ruby?.historyPath),
			currentCommand: ruby?.currentCommand ?? undefined,
			currentPath: ruby?.currentPath ?? undefined,
			attachCommand: formatAttachCommand(DEFAULT_RUBY_SESSION),
		},
		java: {
			running: Boolean(java),
			sessionName: java?.sessionName ?? DEFAULT_JAVA_SESSION,
			runtime: java?.runtime ?? undefined,
			historyPath: java?.historyPath ?? undefined,
			historyLogging: Boolean(java?.historyPath),
			currentCommand: java?.currentCommand ?? undefined,
			currentPath: java?.currentPath ?? undefined,
			attachCommand: formatAttachCommand(DEFAULT_JAVA_SESSION),
		},
		runningSessions: sessions.map((session) => ({
			target: session.selector,
			sessionName: session.info.sessionName,
			runtime: session.info.runtime,
			historyPath: session.info.historyPath,
			historyLogging: Boolean(session.info.historyPath),
			currentCommand: session.info.currentCommand,
			currentPath: session.info.currentPath,
			attachCommand: formatAttachCommand(session.info.sessionName),
		})),
	};
}

async function startDefaultJuliaSession(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const exists = await tmuxSessionExists(pi, DEFAULT_JULIA_SESSION, ctx.cwd);
	if (exists) {
		const info = await readSessionInfo(pi, DEFAULT_JULIA_SESSION, ctx.cwd);
		notify(
			ctx,
			info
				? `Default Julia REPL session is already running.\n\n${formatSessionInfo(info)}`
				: ["Default Julia REPL session is already running.", "", formatAttachInstructions(DEFAULT_JULIA_SESSION)].join("\n"),
			"info",
		);
		return;
	}

	const shellLaunch = buildDefaultShellRuntimeCommand("julia");
	const createResult = await execTmux(
		pi,
		["new-session", "-d", "-s", DEFAULT_JULIA_SESSION, "-c", ctx.cwd, shellLaunch.command],
		ctx.cwd,
		10_000,
	);
	if (createResult.code !== 0) {
		const reason = createResult.stderr.trim() || createResult.stdout.trim() || `exit code ${createResult.code}`;
		notify(ctx, `Failed to create tmux session ${DEFAULT_JULIA_SESSION}: ${reason}`, "error");
		return;
	}

	const history = await enableSessionHistoryLogging(pi, DEFAULT_JULIA_SESSION, ctx.cwd);
	await setTmuxSessionOption(pi, DEFAULT_JULIA_SESSION, REPL_RUNTIME_OPTION, "julia", ctx.cwd);
	const info = await waitForJuliaSessionInfo(pi, ctx.cwd, shellLaunch.shell);

	if (history.warning) {
		notify(ctx, history.warning, "warning");
	}

	notify(
		ctx,
		[
			`Started default Julia REPL session: ${DEFAULT_JULIA_SESSION}`,
			`Launch method: ${shellLaunch.shell} -i -l -c 'julia' inside tmux.`,
			info ? `\n${formatSessionInfo(info)}` : ["", formatAttachInstructions(DEFAULT_JULIA_SESSION)].join("\n"),
		].join("\n"),
		"info",
	);
}

async function startDefaultRSession(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const exists = await tmuxSessionExists(pi, DEFAULT_R_SESSION, ctx.cwd);
	if (exists) {
		const info = await readSessionInfo(pi, DEFAULT_R_SESSION, ctx.cwd);
		notify(
			ctx,
			info ? `Default R REPL session is already running.\n\n${formatSessionInfo(info)}` : ["Default R REPL session is already running.", "", formatAttachInstructions(DEFAULT_R_SESSION)].join("\n"),
			"info",
		);
		return;
	}

	const shellLaunch = buildDefaultShellRuntimeCommand("r");
	const createResult = await execTmux(pi, ["new-session", "-d", "-s", DEFAULT_R_SESSION, "-c", ctx.cwd, shellLaunch.command], ctx.cwd, 10_000);
	if (createResult.code !== 0) {
		const reason = createResult.stderr.trim() || createResult.stdout.trim() || `exit code ${createResult.code}`;
		notify(ctx, `Failed to create tmux session ${DEFAULT_R_SESSION}: ${reason}`, "error");
		return;
	}

	const history = await enableSessionHistoryLogging(pi, DEFAULT_R_SESSION, ctx.cwd);
	await setTmuxSessionOption(pi, DEFAULT_R_SESSION, REPL_RUNTIME_OPTION, "r", ctx.cwd);
	const info = await waitForRSessionInfo(pi, ctx.cwd, shellLaunch.shell);

	if (history.warning) {
		notify(ctx, history.warning, "warning");
	}

	notify(
		ctx,
		[
			`Started default R REPL session: ${DEFAULT_R_SESSION}`,
			`Launch method: ${shellLaunch.shell} -i -l -c 'R' inside tmux.`,
			info ? `\n${formatSessionInfo(info)}` : ["", formatAttachInstructions(DEFAULT_R_SESSION)].join("\n"),
		].join("\n"),
		"info",
	);
}

async function startDefaultGhciSession(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const exists = await tmuxSessionExists(pi, DEFAULT_GHCI_SESSION, ctx.cwd);
	if (exists) {
		const info = await readSessionInfo(pi, DEFAULT_GHCI_SESSION, ctx.cwd);
		notify(
			ctx,
			info ? `Default Haskell (GHCi) REPL session is already running.\n\n${formatSessionInfo(info)}` : ["Default Haskell (GHCi) REPL session is already running.", "", formatAttachInstructions(DEFAULT_GHCI_SESSION)].join("\n"),
			"info",
		);
		return;
	}

	const shellLaunch = buildDefaultShellRuntimeCommand("ghci");
	const createResult = await execTmux(pi, ["new-session", "-d", "-s", DEFAULT_GHCI_SESSION, "-c", ctx.cwd, shellLaunch.command], ctx.cwd, 10_000);
	if (createResult.code !== 0) {
		const reason = createResult.stderr.trim() || createResult.stdout.trim() || `exit code ${createResult.code}`;
		notify(ctx, `Failed to create tmux session ${DEFAULT_GHCI_SESSION}: ${reason}`, "error");
		return;
	}

	const history = await enableSessionHistoryLogging(pi, DEFAULT_GHCI_SESSION, ctx.cwd);
	await setTmuxSessionOption(pi, DEFAULT_GHCI_SESSION, REPL_RUNTIME_OPTION, "ghci", ctx.cwd);
	const info = await waitForGhciSessionInfo(pi, ctx.cwd, shellLaunch.shell);

	if (history.warning) {
		notify(ctx, history.warning, "warning");
	}

	notify(
		ctx,
		[
			`Started default Haskell (GHCi) REPL session: ${DEFAULT_GHCI_SESSION}`,
			`Launch method: ${shellLaunch.shell} -i -l -c 'ghci' inside tmux.`,
			info ? `\n${formatSessionInfo(info)}` : ["", formatAttachInstructions(DEFAULT_GHCI_SESSION)].join("\n"),
		].join("\n"),
		"info",
	);
}

async function startDefaultClojureSession(pi: ExtensionAPI, ctx: ExtensionCommandContext, requested: ClojureRuntime): Promise<void> {
	const exists = await tmuxSessionExists(pi, DEFAULT_CLOJURE_SESSION, ctx.cwd);
	if (exists) {
		const info = await readSessionInfo(pi, DEFAULT_CLOJURE_SESSION, ctx.cwd);
		notify(
			ctx,
			info ? `Default Clojure REPL session is already running (requested: ${requested}).\n\n${formatSessionInfo(info)}` : ["Default Clojure REPL session is already running.", "", formatAttachInstructions(DEFAULT_CLOJURE_SESSION)].join("\n"),
			"info",
		);
		return;
	}

	const shellLaunch = buildDefaultShellRuntimeCommand(requested);
	const createResult = await execTmux(pi, ["new-session", "-d", "-s", DEFAULT_CLOJURE_SESSION, "-c", ctx.cwd, shellLaunch.command], ctx.cwd, 10_000);
	if (createResult.code !== 0) {
		const reason = createResult.stderr.trim() || createResult.stdout.trim() || `exit code ${createResult.code}`;
		notify(ctx, `Failed to create tmux session ${DEFAULT_CLOJURE_SESSION}: ${reason}`, "error");
		return;
	}

	const history = await enableSessionHistoryLogging(pi, DEFAULT_CLOJURE_SESSION, ctx.cwd);
	await setTmuxSessionOption(pi, DEFAULT_CLOJURE_SESSION, REPL_RUNTIME_OPTION, "clojure", ctx.cwd);
	const info = await waitForClojureSessionInfo(pi, ctx.cwd, shellLaunch.shell);

	if (history.warning) {
		notify(ctx, history.warning, "warning");
	}

	notify(
		ctx,
		[
			`Started default Clojure REPL session: ${DEFAULT_CLOJURE_SESSION}`,
			`Launch method: ${shellLaunch.shell} -i -l -c 'clojure' inside tmux.`,
			"`clojure` is used under the hood because it is a cleaner non-rlwrap launcher for a shared tmux REPL. `/repl clj` is still accepted as an alias.",
			info ? `\n${formatSessionInfo(info)}` : ["", formatAttachInstructions(DEFAULT_CLOJURE_SESSION)].join("\n"),
		].join("\n"),
		"info",
	);
}

async function startDefaultRubySession(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const exists = await tmuxSessionExists(pi, DEFAULT_RUBY_SESSION, ctx.cwd);
	if (exists) {
		const info = await readSessionInfo(pi, DEFAULT_RUBY_SESSION, ctx.cwd);
		notify(
			ctx,
			info ? `Default Ruby REPL session is already running.\n\n${formatSessionInfo(info)}` : ["Default Ruby REPL session is already running.", "", formatAttachInstructions(DEFAULT_RUBY_SESSION)].join("\n"),
			"info",
		);
		return;
	}

	const shellLaunch = buildDefaultShellRuntimeCommand("ruby");
	const createResult = await execTmux(pi, ["new-session", "-d", "-s", DEFAULT_RUBY_SESSION, "-c", ctx.cwd, shellLaunch.command], ctx.cwd, 10_000);
	if (createResult.code !== 0) {
		const reason = createResult.stderr.trim() || createResult.stdout.trim() || `exit code ${createResult.code}`;
		notify(ctx, `Failed to create tmux session ${DEFAULT_RUBY_SESSION}: ${reason}`, "error");
		return;
	}

	const history = await enableSessionHistoryLogging(pi, DEFAULT_RUBY_SESSION, ctx.cwd);
	await setTmuxSessionOption(pi, DEFAULT_RUBY_SESSION, REPL_RUNTIME_OPTION, "ruby", ctx.cwd);
	const info = await waitForRubySessionInfo(pi, ctx.cwd, shellLaunch.shell);

	if (history.warning) {
		notify(ctx, history.warning, "warning");
	}

	notify(
		ctx,
		[
			`Started default Ruby REPL session: ${DEFAULT_RUBY_SESSION}`,
			`Launch method: ${shellLaunch.shell} -i -l -c 'irb' inside tmux.`,
			info ? `\n${formatSessionInfo(info)}` : ["", formatAttachInstructions(DEFAULT_RUBY_SESSION)].join("\n"),
		].join("\n"),
		"info",
	);
}

async function startDefaultJavaSession(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const exists = await tmuxSessionExists(pi, DEFAULT_JAVA_SESSION, ctx.cwd);
	if (exists) {
		const info = await readSessionInfo(pi, DEFAULT_JAVA_SESSION, ctx.cwd);
		notify(
			ctx,
			info ? `Default Java REPL session is already running.\n\n${formatSessionInfo(info)}` : ["Default Java REPL session is already running.", "", formatAttachInstructions(DEFAULT_JAVA_SESSION)].join("\n"),
			"info",
		);
		return;
	}

	const shellLaunch = buildDefaultShellRuntimeCommand("java");
	const createResult = await execTmux(pi, ["new-session", "-d", "-s", DEFAULT_JAVA_SESSION, "-c", ctx.cwd, shellLaunch.command], ctx.cwd, 10_000);
	if (createResult.code !== 0) {
		const reason = createResult.stderr.trim() || createResult.stdout.trim() || `exit code ${createResult.code}`;
		notify(ctx, `Failed to create tmux session ${DEFAULT_JAVA_SESSION}: ${reason}`, "error");
		return;
	}

	const history = await enableSessionHistoryLogging(pi, DEFAULT_JAVA_SESSION, ctx.cwd);
	await setTmuxSessionOption(pi, DEFAULT_JAVA_SESSION, REPL_RUNTIME_OPTION, "java", ctx.cwd);
	const info = await waitForJavaSessionInfo(pi, ctx.cwd, shellLaunch.shell);

	if (history.warning) {
		notify(ctx, history.warning, "warning");
	}

	notify(
		ctx,
		[
			`Started default Java REPL session: ${DEFAULT_JAVA_SESSION}`,
			`Launch method: ${shellLaunch.shell} -i -l -c 'jshell' inside tmux.`,
			info ? `\n${formatSessionInfo(info)}` : ["", formatAttachInstructions(DEFAULT_JAVA_SESSION)].join("\n"),
		].join("\n"),
		"info",
	);
}

async function showReplStatus(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	selector?: SessionSelector,
): Promise<void> {
	if (selector) {
		const sessionName = getSessionNameForSelector(selector);
		const info = await readSessionInfo(pi, sessionName, ctx.cwd);
		if (!info) {
			notify(ctx, formatNoSessionRunning(selector), "info");
			return;
		}

		notify(ctx, `${getSessionDisplayName(selector, info)} REPL session is running.\n\n${formatSessionInfo(info)}`, "info");
		return;
	}

	const running = await listRunningSharedSessions(pi, ctx.cwd);
	if (running.length === 0) {
		notify(
			ctx,
			"No shared REPL sessions are running. Start one with /repl python, /repl ipython, /repl julia, /repl R, /repl ghci, /repl clojure, or /repl ruby.",
			"info",
		);
		return;
	}

	if (running.length === 1) {
		const only = running[0];
		notify(ctx, `${getSessionDisplayName(only.selector, only.info)} REPL session is running.\n\n${formatSessionInfo(only.info)}`, "info");
		return;
	}

	const message = [
		"Shared REPL sessions are running:",
		"",
		...running.flatMap((session, index) => [
			`${getSessionDisplayName(session.selector, session.info)} session:`,
			formatSessionInfo(session.info),
			...(index < running.length - 1 ? [""] : []),
		]),
	].join("\n");
	notify(ctx, message, "info");
}

async function stopReplSession(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	selector?: SessionSelector,
): Promise<void> {
	if (!selector) {
		const running = await listRunningSharedSessions(pi, ctx.cwd);
		if (running.length === 0) {
			notify(
				ctx,
				"No shared REPL sessions are running. Start one with /repl python, /repl ipython, /repl julia, /repl R, /repl ghci, /repl clojure, /repl ruby, or /repl java.",
				"info",
			);
			return;
		}
		if (running.length > 1) {
			notify(
				ctx,
				[
					"Multiple shared REPL sessions are running.",
					"Use one of:",
					"/repl stop python",
					"/repl stop julia",
					"/repl stop r",
					"/repl stop ghci",
					"/repl stop clojure",
					"/repl stop ruby",
					"/repl stop java",
				].join("\n"),
				"warning",
			);
			return;
		}
		selector = running[0].selector;
	}

	const sessionName = getSessionNameForSelector(selector);
	const exists = await tmuxSessionExists(pi, sessionName, ctx.cwd);
	if (!exists) {
		notify(ctx, formatNoSessionRunning(selector), "info");
		return;
	}

	await disableSessionHistoryLogging(pi, sessionName, ctx.cwd);
	const result = await execTmux(pi, ["kill-session", "-t", sessionName], ctx.cwd, 5_000);
	if (result.code !== 0) {
		const reason = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		notify(ctx, `Failed to stop ${sessionName}: ${reason}`, "error");
		return;
	}

	const label = selector === "julia" ? "Julia" : selector === "r" ? "R" : selector === "ghci" ? "Haskell (GHCi)" : selector === "clojure" ? "Clojure" : selector === "ruby" ? "Ruby (irb)" : selector === "java" ? "Java (jshell)" : "Python/IPython";
	notify(ctx, `Stopped default ${label} REPL session: ${sessionName}`, "info");
}

async function attachReplSession(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	selector?: SessionSelector,
): Promise<void> {
	if (!selector) {
		const running = await listRunningSharedSessions(pi, ctx.cwd);
		if (running.length === 0) {
			notify(
				ctx,
				"No shared REPL sessions are running. Start one with /repl python, /repl ipython, /repl julia, /repl R, /repl ghci, /repl clojure, /repl ruby, or /repl java.",
				"info",
			);
			return;
		}
		if (running.length === 1) {
			selector = running[0].selector;
		} else {
			const message = [
				"Multiple shared REPL sessions are running.",
				"",
				"Open a new terminal window and run one of:",
				...running.map((session) => `${getSessionDisplayName(session.selector, session.info)}: ${formatAttachCommand(session.info.sessionName)}`),
			].join("\n");
			notify(ctx, message, "info");
			return;
		}
	}

	const sessionName = getSessionNameForSelector(selector);
	const exists = await tmuxSessionExists(pi, sessionName, ctx.cwd);
	if (!exists) {
		notify(ctx, formatNoSessionRunning(selector), "info");
		return;
	}

	const info = await readSessionInfo(pi, sessionName, ctx.cwd);
	if (info) {
		notify(ctx, formatAttachInstructions(info.sessionName), "info");
		return;
	}

	notify(ctx, formatAttachInstructions(sessionName), "info");
}

async function handleRepl(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parsed = parseReplCommand(args);

	if (parsed.action === "help") {
		notify(ctx, formatUsage(), "info");
		return;
	}

	if (parsed.action === "error") {
		notify(ctx, `${parsed.message}\n\n${formatUsage()}`, "error");
		return;
	}

	const hasTmux = await commandExists(pi, "tmux", ctx.cwd);
	if (!hasTmux) {
		notify(ctx, "tmux was not found on PATH. pi-repl requires tmux.", "error");
		return;
	}

	switch (parsed.action) {
		case "status":
			await showReplStatus(pi, ctx, parsed.runtime ? toSessionSelector(parsed.runtime) : undefined);
			return;
		case "env":
			if (parsed.runtime && !isPythonRuntime(parsed.runtime)) {
				notify(ctx, "Environment inspection is currently implemented only for the shared Python/IPython session.", "warning");
				return;
			}
			await showDefaultPythonEnv(pi, ctx);
			return;
		case "stop":
			await stopReplSession(pi, ctx, parsed.runtime ? toSessionSelector(parsed.runtime) : undefined);
			return;
		case "attach":
			await attachReplSession(pi, ctx, parsed.runtime ? toSessionSelector(parsed.runtime) : undefined);
			return;
		case "start": {
			if (isPythonRuntime(parsed.runtime)) {
				if (parsed.name) {
					notify(
						ctx,
						"Named Python/IPython sessions are not implemented yet. For now, use /repl python or /repl ipython with no --name.",
						"warning",
					);
					return;
				}

				await startDefaultPythonSession(pi, ctx, parsed.runtime);
				return;
			}

			if (parsed.runtime === "julia") {
				if (parsed.name) {
					notify(
						ctx,
						"Named Julia sessions are not implemented yet. For now, use /repl julia with no --name.",
						"warning",
					);
					return;
				}

				await startDefaultJuliaSession(pi, ctx);
				return;
			}

			if (parsed.runtime === "r") {
				if (parsed.name) {
					notify(ctx, "Named R sessions are not implemented yet. For now, use /repl R or /repl r with no --name.", "warning");
					return;
				}

				await startDefaultRSession(pi, ctx);
				return;
			}

			if (parsed.runtime === "ghci") {
				if (parsed.name) {
					notify(ctx, "Named GHCi sessions are not implemented yet. For now, use /repl ghci with no --name.", "warning");
					return;
				}

				await startDefaultGhciSession(pi, ctx);
				return;
			}

			if (isClojureRuntime(parsed.runtime)) {
				if (parsed.name) {
					notify(ctx, "Named Clojure sessions are not implemented yet. For now, use /repl clojure or /repl clj with no --name.", "warning");
					return;
				}

				await startDefaultClojureSession(pi, ctx, parsed.runtime);
				return;
			}

			if (parsed.runtime === "ruby") {
				if (parsed.name) {
					notify(ctx, "Named Ruby sessions are not implemented yet. For now, use /repl ruby with no --name.", "warning");
					return;
				}
			
				await startDefaultRubySession(pi, ctx);
				return;
			}

			if (parsed.runtime === "java") {
				if (parsed.name) {
					notify(ctx, "Named Java sessions are not implemented yet. For now, use /repl java with no --name.", "warning");
					return;
				}

				await startDefaultJavaSession(pi, ctx);
				return;
			}

			const sessionName = buildSessionName(parsed.runtime, parsed.name);
			const nameNote = parsed.name ? ` (from name: ${parsed.name})` : "";
			notify(
				ctx,
				[
					"Scaffold only: parsed REPL start request.",
					`Runtime: ${parsed.runtime}`,
					`tmux session: ${sessionName}${nameNote}`,
					"Only Python, IPython, Julia, R, GHCi, Clojure, Ruby, and Java session management are implemented so far.",
				].join("\n"),
				"info",
			);
			return;
		}
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("repl", {
		description: "Manage collaborative tmux-backed REPL sessions",
		handler: async (args, ctx) => {
			await handleRepl(pi, args, ctx);
		},
	});

	pi.registerCommand("lab", {
		description: "Alias for /repl",
		handler: async (args, ctx) => {
			await handleRepl(pi, args, ctx);
		},
	});

	pi.registerTool({
		name: "repl_status",
		label: "REPL Status",
		description: "Inspect shared REPL session state for Python/IPython, Julia, R, Haskell (GHCi), Clojure, Ruby, and Java.",
		promptSnippet: "Check whether the shared Python/IPython, Julia, R, Haskell (GHCi), Clojure, Ruby, and Java REPL sessions are running.",
		promptGuidelines: [
			"Use this tool before claiming whether a shared REPL is running, especially after a previous failure or status change.",
			"If the user asks specifically about Julia, use target='julia'. If they ask specifically about R, use target='r'. If they ask specifically about GHCi or Haskell, use target='ghci'. If they ask specifically about Clojure, use target='clojure'. If they ask specifically about Ruby or IRB, use target='ruby'. If they ask specifically about Java or jshell, use target='java'. If they ask specifically about Python or IPython, use target='python'.",
			"If you need context about prior direct REPL interaction, inspect repl_status details and read the session history file listed there.",
		],
		parameters: REPL_STATUS_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const targetRaw = typeof (params as { target?: string }).target === "string" ? (params as { target?: string }).target?.trim().toLowerCase() : undefined;
			let target: SessionSelector | undefined;
			if (targetRaw) {
				if (targetRaw === "julia") target = "julia";
				else if (targetRaw === "r") target = "r";
				else if (targetRaw === "ghci" || targetRaw === "haskell") target = "ghci";
				else if (targetRaw === "clojure" || targetRaw === "clj") target = "clojure";
				else if (targetRaw === "ruby" || targetRaw === "irb") target = "ruby";
				else if (targetRaw === "java" || targetRaw === "jshell") target = "java";
				else if (targetRaw === "python" || targetRaw === "ipython") target = "python";
				else throw new Error(`Unknown repl_status target: ${targetRaw}`);
			}

			const sessions = await listRunningSharedSessions(pi, ctx.cwd);
			const details = buildReplStatusDetails(sessions);

			if (target) {
				const sessionInfo = sessions.find((session) => session.selector === target)?.info;
				if (!sessionInfo) {
					return {
						content: [{ type: "text", text: formatNoSessionRunning(target) }],
						details,
					};
				}

				return {
					content: [{ type: "text", text: `${getSessionDisplayName(target, sessionInfo)} REPL session is running.\n\n${formatSessionInfo(sessionInfo)}` }],
					details,
				};
			}

			if (sessions.length === 0) {
				return {
					content: [{ type: "text", text: "No shared REPL sessions are running." }],
					details,
				};
			}

			if (sessions.length === 1) {
				const only = sessions[0];
				return {
					content: [{ type: "text", text: `${getSessionDisplayName(only.selector, only.info)} REPL session is running.\n\n${formatSessionInfo(only.info)}` }],
					details,
				};
			}

			return {
				content: [{
					type: "text",
					text: [
						"Shared REPL sessions are running:",
						"",
						...sessions.flatMap((session, index) => [
							`${getSessionDisplayName(session.selector, session.info)} session:`,
							formatSessionInfo(session.info),
							...(index < sessions.length - 1 ? [""] : []),
						]),
					].join("\n"),
				}],
				details,
			};
		},
	});

	pi.registerTool({
		name: "repl_send",
		label: "REPL Send",
		description: `Execute code in the shared default Python/IPython, Julia, R, Haskell (GHCi), Clojure, Ruby, or Java tmux REPL sessions (${DEFAULT_PYTHON_SESSION}, ${DEFAULT_JULIA_SESSION}, ${DEFAULT_R_SESSION}, ${DEFAULT_GHCI_SESSION}, ${DEFAULT_CLOJURE_SESSION}, ${DEFAULT_RUBY_SESSION}, ${DEFAULT_JAVA_SESSION}). Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first).`,
		promptSnippet: "Execute a small snippet in the shared Python/IPython, Julia, R, Haskell (GHCi), Clojure, Ruby, or Java REPL and return its output.",
		promptGuidelines: [
			"Use this tool only after a /repl python, /repl ipython, /repl julia, /repl R, /repl ghci, /repl clojure, /repl ruby, or /repl java session has been started.",
			"If the user asks to run code in Julia or in the shared Julia REPL, use target='julia'. If they ask to run code in R or in the shared R REPL, use target='r'. If they ask to run code in GHCi, Haskell, or the shared Haskell REPL, use target='ghci'. If they ask to run code in Clojure or in the shared Clojure REPL, use target='clojure'. If they ask to run code in Ruby or IRB or the shared Ruby REPL, use target='ruby'. If they ask to run code in Java or jshell or the shared Java REPL, use target='java'. Otherwise use the shared Python/IPython session.",
			"Use repl_status before claiming whether the shared REPL is active if there has been a prior failure or a possible state change.",
			"If you need context about prior direct REPL interaction, inspect repl_status details and read the session history file listed there.",
			"The session history file is raw tmux pane output, so expect prompts and echoed input as well as results.",
			"This is a shared long-lived session: inspect state before mutating it, and do not assume variables already exist.",
			"Keep snippets small. If you need a value back reliably, print it explicitly.",
			"In GHCi, use normal interactive syntax such as let-bindings or :{ ... :} blocks for multiline declarations.",
			"In Clojure, use normal interactive syntax such as let-bindings, def/defn, or do forms for multiline code.",
			"Avoid blocking interactive input() prompts or long-running code unless the user explicitly wants that.",
		],
		parameters: REPL_SEND_PARAMS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeReplSend(pi, params as { code: string; target?: string; timeoutMs?: number }, ctx, signal);
		},
	});
}
