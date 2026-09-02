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
import {
	REPL_SESSION_RECORD_ID_OPTION,
	REPL_SESSION_RECORD_VERSION,
	REPL_SESSION_RECORD_VERSION_OPTION,
	acquireReplSessionSendLease,
	createReplSessionRecordId,
	ensureReplSessionRecord,
	getReplSessionRecordPath,
	isValidReplSessionRecordId,
	readReplSessionRecord,
	renderReplSessionRecordMarkdown,
	upsertReplSessionRecordEntry,
} from "./shared/repl-session-record.js";

const SUPPORTED_RUNTIMES = ["julia", "python", "ipython", "r", "ghci", "clojure", "clj", "bun"] as const;
const DEFAULT_PYTHON_SESSION = "pi-repl-python";
const DEFAULT_JULIA_SESSION = "pi-repl-julia";
const DEFAULT_R_SESSION = "pi-repl-r";
const DEFAULT_GHCI_SESSION = "pi-repl-ghci";
const DEFAULT_CLOJURE_SESSION = "pi-repl-clojure";
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
type ManagedRuntime = PythonRuntime | "julia" | "r" | "ghci" | ClojureRuntime;
type ImplementedRuntime = PythonRuntime | "julia" | "r" | "ghci" | "clojure";
type SessionSelector = "python" | "julia" | "r" | "ghci" | "clojure";

type ReplCommand =
	| { action: "help" }
	| { action: "status"; runtime?: ManagedRuntime }
	| { action: "env"; runtime?: ManagedRuntime }
	| { action: "stop"; runtime?: ManagedRuntime }
	| { action: "attach"; runtime?: ManagedRuntime }
	| { action: "export"; runtime?: ManagedRuntime }
	| { action: "start"; runtime: SupportedRuntime; name?: string }
	| { action: "error"; message: string };

type SharedReplRecordEntry = {
	id: string;
	requestId: string;
	createdAt: number;
	updatedAt: number;
	completedAt: number | null;
	sessionName: string;
	runtime: string;
	origin: "pi-repl" | "pi-studio" | "unknown";
	label: string;
	mode: "raw" | "literate" | "agent";
	prose: string;
	code: string;
	output: string;
	status: "sending" | "sent" | "captured" | "timeout" | "error" | "note";
	skippedChunks: number;
};

type SessionInfo = {
	sessionName: string;
	tmuxSessionId: string;
	tmuxSessionCreatedAt: number;
	runtime?: string;
	historyPath?: string;
	recordId?: string;
	recordPath?: string;
	recordEntryCount?: number;
	recordTail?: SharedReplRecordEntry[];
	recordWarning?: string;
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
	recordId?: string;
	recordPath?: string;
	recordEntryId?: string;
	recordWarning?: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
};

const REPL_SEND_PARAMS = Type.Object({
	code: Type.String({ description: "Python, IPython, Julia, R, GHCi, or Clojure code to execute in the shared REPL session." }),
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
			description: "Optional session target: python, julia, r, ghci, or clojure. If omitted, report all shared REPL sessions.",
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
	return value === "python" || value === "ipython" || value === "julia" || value === "r" || value === "ghci" || value === "clojure" || value === "clj";
}

function toSessionSelector(runtime: ManagedRuntime): SessionSelector {
	if (runtime === "julia") return "julia";
	if (runtime === "r") return "r";
	if (runtime === "ghci") return "ghci";
	if (runtime === "clojure" || runtime === "clj") return "clojure";
	return "python";
}

function getSessionNameForSelector(selector: SessionSelector): string {
	if (selector === "julia") return DEFAULT_JULIA_SESSION;
	if (selector === "r") return DEFAULT_R_SESSION;
	if (selector === "ghci") return DEFAULT_GHCI_SESSION;
	if (selector === "clojure") return DEFAULT_CLOJURE_SESSION;
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
		"  /repl status [python|julia|r|ghci|clojure]",
		"  /repl env [python]",
		"  /repl attach [python|julia|r|ghci|clojure]",
		"  /repl export [python|julia|r|ghci|clojure]",
		"  /repl stop [python|julia|r|ghci|clojure]",
		"",
		"Supported runtimes right now: python, ipython, julia, r, ghci, clojure",
		"For R, both /repl R and /repl r work. The same applies to /lab, /repl status, /repl attach, /repl export, and /repl stop.",
		"For Clojure, /repl clojure is canonical and /repl clj also works. The same applies to /lab, /repl status, /repl attach, /repl export, and /repl stop.",
		"",
		"Current real implementation:",
		"  - /repl python and /repl ipython manage the shared tmux session pi-repl-python",
		"  - /repl julia manages the shared tmux session pi-repl-julia",
		"  - /repl r manages the shared tmux session pi-repl-r",
		"  - /repl ghci manages the shared tmux session pi-repl-ghci",
		"  - /repl clojure and /repl clj manage the shared tmux session pi-repl-clojure",
		"  - /repl status, /repl attach, /repl export, and /repl stop can target Python/IPython, Julia, R, GHCi, or Clojure",
		"  - /repl export writes the selected session's canonical clean record as Markdown",
		"  - /repl env inspects the shared Python/IPython session",
		"  - the repl_send tool can execute code in the shared Python/IPython, Julia, R, GHCi, or Clojure session",
		"",
		"Examples:",
		"  /repl ipython",
		"  /repl julia",
		"  /repl R",
		"  /repl ghci",
		"  /repl clojure",
		"  /repl status clojure",
		"  /repl export python",
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

	if (firstLower === "status" || firstLower === "env" || firstLower === "stop" || firstLower === "attach" || firstLower === "export") {
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
			if (firstLower === "export") return { action: "export", runtime: selector };
			return { action: "attach", runtime: selector };
		}

		if (firstLower === "status") return { action: "status" };
		if (firstLower === "env") return { action: "env" };
		if (firstLower === "stop") return { action: "stop" };
		if (firstLower === "export") return { action: "export" };
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

async function setTmuxSessionOptionIfAbsent(
	pi: ExtensionAPI,
	sessionName: string,
	optionName: string,
	value: string,
	cwd: string,
): Promise<boolean> {
	const result = await execTmux(pi, ["set-option", "-qo", "-t", sessionName, optionName, value], cwd, 3_000);
	return result.code === 0;
}

type ReplSessionIdentity = {
	sessionName: string;
	tmuxSessionId: string;
	tmuxSessionCreatedAt: number;
	runtime: string;
};

async function ensureTmuxSessionRecord(
	pi: ExtensionAPI,
	identity: ReplSessionIdentity,
	cwd: string,
): Promise<{
	recordId?: string;
	recordPath?: string;
	recordEntryCount?: number;
	recordTail?: SharedReplRecordEntry[];
	warning?: string;
}> {
	let recordId = await readTmuxSessionOption(pi, identity.sessionName, REPL_SESSION_RECORD_ID_OPTION, cwd);
	let version = await readTmuxSessionOption(pi, identity.sessionName, REPL_SESSION_RECORD_VERSION_OPTION, cwd);
	if (recordId && !isValidReplSessionRecordId(recordId)) {
		return { warning: `Shared REPL record metadata is invalid for ${identity.sessionName}; leaving it untouched.` };
	}
	if (!recordId) {
		const candidate = createReplSessionRecordId();
		if (!(await setTmuxSessionOptionIfAbsent(pi, identity.sessionName, REPL_SESSION_RECORD_ID_OPTION, candidate, cwd))) {
			return { warning: `Could not attach shared record metadata to ${identity.sessionName}.` };
		}
		recordId = await readTmuxSessionOption(pi, identity.sessionName, REPL_SESSION_RECORD_ID_OPTION, cwd);
	}
	if (!recordId || !isValidReplSessionRecordId(recordId)) {
		return { warning: `Could not read valid shared record metadata from ${identity.sessionName}.` };
	}
	if (!version) {
		await setTmuxSessionOptionIfAbsent(
			pi,
			identity.sessionName,
			REPL_SESSION_RECORD_VERSION_OPTION,
			String(REPL_SESSION_RECORD_VERSION),
			cwd,
		);
		version = await readTmuxSessionOption(pi, identity.sessionName, REPL_SESSION_RECORD_VERSION_OPTION, cwd);
	}
	if (version !== String(REPL_SESSION_RECORD_VERSION)) {
		return {
			recordId,
			warning: `Shared REPL record version ${version || "unknown"} is not supported by this pi-repl version.`,
		};
	}
	try {
		const record = ensureReplSessionRecord(recordId, identity);
		return {
			recordId,
			recordPath: getReplSessionRecordPath(recordId),
			recordEntryCount: record.entries.length,
			recordTail: record.entries.slice(-20) as SharedReplRecordEntry[],
		};
	} catch (error) {
		return {
			recordId,
			recordPath: getReplSessionRecordPath(recordId),
			warning: error instanceof Error ? error.message : String(error),
		};
	}
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
		["display-message", "-p", "-t", target, "#{session_name}\t#{session_id}\t#{session_created}\t#{pane_current_command}\t#{pane_current_path}"],
		cwd,
		3_000,
	);
	if (summaryResult.code !== 0) return null;
	const [
		resolvedSessionName = sessionName,
		tmuxSessionId = "",
		tmuxSessionCreatedRaw = "0",
		currentCommand = "unknown",
		currentPath = cwd,
	] = summaryResult.stdout.trim().split("\t");
	const tmuxSessionCreatedAt = Math.max(0, Math.floor(Number(tmuxSessionCreatedRaw) || 0));

	const tailResult = await execTmux(pi, ["capture-pane", "-p", "-t", target, "-S", `-${DEFAULT_CAPTURE_LINES}`], cwd, 3_000);
	const runtime = await readTmuxSessionOption(pi, sessionName, REPL_RUNTIME_OPTION, cwd);
	const historyPath = await readTmuxSessionOption(pi, sessionName, REPL_HISTORY_OPTION, cwd);
	const record = await ensureTmuxSessionRecord(pi, {
		sessionName: resolvedSessionName,
		tmuxSessionId,
		tmuxSessionCreatedAt,
		runtime: runtime || "unknown",
	}, cwd);

	return {
		sessionName: resolvedSessionName,
		tmuxSessionId,
		tmuxSessionCreatedAt,
		runtime,
		historyPath,
		recordId: record.recordId,
		recordPath: record.recordPath,
		recordEntryCount: record.recordEntryCount,
		recordTail: record.recordTail,
		recordWarning: record.warning,
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
	const latestRecordEntry = info.recordTail?.at(-1);
	const lines = [
		`Session: ${info.sessionName}`,
		...(info.runtime ? [`Runtime: ${info.runtime}`] : []),
		`Current command: ${info.currentCommand}`,
		`Path: ${info.currentPath}`,
		...(info.recordPath ? [`Clean shared record: ${info.recordPath} (${info.recordEntryCount ?? 0} entries)`] : []),
		...(latestRecordEntry ? [`Latest clean entry: ${latestRecordEntry.origin} · ${latestRecordEntry.label} · ${latestRecordEntry.status}`] : []),
		...(info.recordWarning ? [`Shared record warning: ${info.recordWarning}`] : []),
		...(info.historyPath ? [`Raw history log: ${info.historyPath}`] : []),
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

type ReplControlPaths = {
	dir: string;
	sourceFile: string;
	doneFile: string;
};

type ReplSubmissionState = {
	sessionName: string;
	sessionTarget: string;
	cwd: string;
	runtime: ImplementedRuntime;
	beforeCapture: string;
	prepared: ReturnType<typeof prepareReplControlFiles>;
	completionObserved: boolean;
};

function getReplControlPaths(sessionName: string): ReplControlPaths {
	if (sessionName === DEFAULT_PYTHON_SESSION) {
		return {
			dir: REPL_CONTROL_ROOT,
			sourceFile: join(REPL_CONTROL_ROOT, "pr.py"),
			doneFile: join(REPL_CONTROL_ROOT, "pr.done"),
		};
	}

	if (sessionName === DEFAULT_JULIA_SESSION) {
		return {
			dir: REPL_CONTROL_ROOT,
			sourceFile: join(REPL_CONTROL_ROOT, "jr.jl"),
			doneFile: join(REPL_CONTROL_ROOT, "jr.done"),
		};
	}

	if (sessionName === DEFAULT_R_SESSION) {
		return {
			dir: REPL_CONTROL_ROOT,
			sourceFile: join(REPL_CONTROL_ROOT, "rr.R"),
			doneFile: join(REPL_CONTROL_ROOT, "rr.done"),
		};
	}

	if (sessionName === DEFAULT_GHCI_SESSION) {
		return {
			dir: REPL_CONTROL_ROOT,
			sourceFile: join(REPL_CONTROL_ROOT, "gr.ghci"),
			doneFile: join(REPL_CONTROL_ROOT, "gr.done"),
		};
	}

	if (sessionName === DEFAULT_CLOJURE_SESSION) {
		return {
			dir: REPL_CONTROL_ROOT,
			sourceFile: join(REPL_CONTROL_ROOT, "cr.clj"),
			doneFile: join(REPL_CONTROL_ROOT, "cr.done"),
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
	const prefix = runtime === "ghci" ? "--" : runtime === "clojure" ? ";;" : "#";
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
	sessionTarget: string,
	cwd: string,
	text: string,
	onPasted?: () => void,
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

		const pasteResult = await execTmux(pi, ["paste-buffer", "-d", "-b", bufferName, "-t", getPaneTarget(sessionTarget)], cwd, 5_000);
		if (pasteResult.code !== 0) {
			const reason = pasteResult.stderr.trim() || pasteResult.stdout.trim() || `exit code ${pasteResult.code}`;
			throw new Error(`Failed to paste tmux buffer: ${reason}`);
		}
		onPasted?.();

		const enterResult = await execTmux(pi, ["send-keys", "-t", getPaneTarget(sessionTarget), "C-m"], cwd, 5_000);
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

async function capturePaneOutput(pi: ExtensionAPI, sessionTarget: string, cwd: string): Promise<string> {
	const result = await execTmux(
		pi,
		["capture-pane", "-p", "-t", getPaneTarget(sessionTarget), "-S", `-${REPL_SEND_CAPTURE_LINES}`],
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
	const loaderHints = [submissionLine, "exec(open(", "run_cell(open(", "include(", "source(", ":script ", "load-file", "/tmp/pr.py", "/tmp/jr.jl", "/tmp/rr.R", "/tmp/gr.ghci", "/tmp/cr.clj", "/tmp/pi-repl", "control.py", ":pi-repl/silent"];
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
			/^[^\s>]+=>\s*$/.test(first)
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
	sessionTarget: string,
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

		if (!(await tmuxSessionExists(pi, sessionTarget, cwd))) {
			throw new Error(`REPL session ended while waiting for output: ${sessionName}`);
		}

		if (existsSync(doneFile)) return;

		latestCapture = await capturePaneOutput(pi, sessionTarget, cwd);
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
	throw new Error(`Unknown repl_send target: ${target}`);
}

async function runReplCode(
	pi: ExtensionAPI,
	params: { code: string; target?: string; timeoutMs?: number },
	ctx: ExtensionContext,
	signal?: AbortSignal,
	expectedSession?: ReplSessionIdentity,
	onSubmissionStarted?: (state: ReplSubmissionState) => void,
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
		throw new Error(
			`Could not inspect the default Python/IPython REPL session (${DEFAULT_PYTHON_SESSION}). Start it again with /repl python or /repl ipython.`,
		);
	}

	if (
		expectedSession
		&& (
			sessionInfo.sessionName !== expectedSession.sessionName
			|| sessionInfo.tmuxSessionId !== expectedSession.tmuxSessionId
			|| sessionInfo.tmuxSessionCreatedAt !== expectedSession.tmuxSessionCreatedAt
		)
	) {
		throw new Error(`REPL session ${sessionName} changed while repl_send was waiting to execute.`);
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
						: normalizePythonRuntime(sessionInfo);
	const timeoutMs = clampReplSendTimeout(params.timeoutMs);
	const sessionTarget = sessionInfo.tmuxSessionId || sessionName;
	const beforeCapture = await capturePaneOutput(pi, sessionTarget, ctx.cwd);
	const prepared = prepareReplControlFiles(sessionName, runtime, code);
	const submissionState: ReplSubmissionState = {
		sessionName,
		sessionTarget,
		cwd: ctx.cwd,
		runtime,
		beforeCapture,
		prepared,
		completionObserved: false,
	};

	await pasteTextToTmuxPane(pi, sessionTarget, ctx.cwd, prepared.submissionText, () => onSubmissionStarted?.(submissionState));
	await waitForReplDoneFile(
		pi,
		sessionName,
		sessionTarget,
		ctx.cwd,
		prepared.controlPaths.doneFile,
		timeoutMs,
		signal,
	);
	submissionState.completionObserved = true;
	const afterCapture = await capturePaneOutput(pi, sessionTarget, ctx.cwd);
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

function sleepWithoutKeepingProcessAlive(ms: number): Promise<void> {
	return new Promise((resolveSleep) => {
		const timer = setTimeout(resolveSleep, ms);
		timer.unref?.();
	});
}

function retainReplSendLeaseUntilSubmissionSettles(
	pi: ExtensionAPI,
	state: ReplSubmissionState,
	lease: Awaited<ReturnType<typeof acquireReplSessionSendLease>>,
): void {
	// A timeout or abort only stops the caller's wait; it does not stop code that
	// is already running in the shared REPL. Keep the cross-client lease alive
	// until the wrapper's completion marker appears (or the exact tmux session
	// ends), so a later compatible send cannot be attributed to overlapping work.
	void (async () => {
		let missingChecks = 0;
		try {
			while (!existsSync(state.prepared.controlPaths.doneFile)) {
				try {
					if (await tmuxSessionExists(pi, state.sessionTarget, state.cwd)) {
						missingChecks = 0;
					} else {
						missingChecks += 1;
						if (missingChecks >= 3) return;
					}
				} catch {
					// A transient inspection failure must not make overlapping sends safe.
					missingChecks = 0;
				}
				await sleepWithoutKeepingProcessAlive(REPL_SEND_POLL_MS);
			}
			try {
				unlinkSync(state.prepared.controlPaths.doneFile);
			} catch {
				// Another cleanup path may already have removed the marker.
			}
		} finally {
			await lease.release().catch(() => undefined);
		}
	})();
}

async function runRecordedReplCode(
	pi: ExtensionAPI,
	params: { code: string; target?: string; timeoutMs?: number },
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	metadata: { requestId: string; label: string; mode: "raw" | "literate" | "agent" },
): Promise<{ output: string; details: ReplSendDetails }> {
	const target = normalizeReplSendTarget(params.target) ?? "python";
	const sessionName = getSessionNameForSelector(target);
	const sessionInfo = await readSessionInfo(pi, sessionName, ctx.cwd);
	if (!sessionInfo?.recordId || !sessionInfo.recordPath || sessionInfo.recordWarning) {
		const execution = await runReplCode(pi, params, ctx, signal);
		return {
			...execution,
			details: {
				...execution.details,
				recordWarning: sessionInfo?.recordWarning || "The tmux session has no compatible clean-record metadata; execution was not synchronized.",
			},
		};
	}

	const runtime: ImplementedRuntime = target === "julia"
		? "julia"
		: target === "r"
			? "r"
			: target === "ghci"
				? "ghci"
				: target === "clojure"
					? "clojure"
					: normalizePythonRuntime(sessionInfo);
	const identity: ReplSessionIdentity = {
		sessionName,
		tmuxSessionId: sessionInfo.tmuxSessionId,
		tmuxSessionCreatedAt: sessionInfo.tmuxSessionCreatedAt,
		runtime,
	};
	const timeoutMs = clampReplSendTimeout(params.timeoutMs);
	const lease = await acquireReplSessionSendLease(sessionInfo.recordId, {
		owner: `pi-repl:${metadata.requestId || process.pid}`,
		waitMs: timeoutMs,
		signal,
	});
	const submissionStateRef: { current: ReplSubmissionState | null } = { current: null };
	let recordEntry: SharedReplRecordEntry | null = null;
	let recordWarning = sessionInfo.recordWarning;
	try {
		try {
			const recorded = upsertReplSessionRecordEntry(sessionInfo.recordId, identity, {
				id: `pi-repl:${metadata.requestId}`,
				requestId: metadata.requestId,
				origin: "pi-repl",
				label: metadata.label,
				mode: metadata.mode,
				code: params.code,
				status: "sending",
			}, { origin: "pi-repl" });
			recordEntry = recorded.entry as SharedReplRecordEntry;
		} catch (error) {
			recordWarning = error instanceof Error ? error.message : String(error);
		}

		try {
			const execution = await runReplCode(pi, params, ctx, signal, identity, (state) => {
				submissionStateRef.current = state;
			});
			if (recordEntry) {
				try {
					const recorded = upsertReplSessionRecordEntry(sessionInfo.recordId, identity, {
						...recordEntry,
						output: execution.output,
						status: "captured",
						completedAt: Date.now(),
					}, { origin: "pi-repl" });
					recordEntry = recorded.entry as SharedReplRecordEntry;
				} catch (error) {
					recordWarning = error instanceof Error ? error.message : String(error);
				}
			}
			return {
				...execution,
				details: {
					...execution.details,
					recordId: sessionInfo.recordId,
					recordPath: sessionInfo.recordPath,
					recordEntryId: recordEntry?.id,
					recordWarning,
				},
			};
		} catch (error) {
			if (recordEntry) {
				try {
					upsertReplSessionRecordEntry(sessionInfo.recordId, identity, {
						...recordEntry,
						output: error instanceof Error ? error.message : String(error),
						status: error instanceof Error && /timed out/i.test(error.message) ? "timeout" : "error",
						completedAt: Date.now(),
					}, { origin: "pi-repl" });
				} catch {
					// Preserve the original execution error when record maintenance also fails.
				}
			}
			throw error;
		}
	} finally {
		const submissionState = submissionStateRef.current;
		if (
			submissionState
			&& !submissionState.completionObserved
			&& !existsSync(submissionState.prepared.controlPaths.doneFile)
		) {
			retainReplSendLeaseUntilSubmissionSettles(pi, submissionState, lease);
		} else {
			await lease.release().catch(() => undefined);
		}
	}
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
		...(details.recordWarning ? ["", `Shared record warning: ${details.recordWarning}`] : []),
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
	signal: AbortSignal | undefined,
	toolCallId: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: ReplSendDetails }> {
	const execution = await runRecordedReplCode(pi, params, ctx, signal, {
		requestId: `tool:${toolCallId}`,
		label: "Pi",
		mode: "agent",
	});
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
		const execution = await runRecordedReplCode(
			pi,
			{
				code: buildReplEnvInspectionCode(),
				timeoutMs: 10_000,
			},
			ctx,
			undefined,
			{ requestId: `command:env:${Date.now().toString(36)}`, label: "/repl env", mode: "raw" },
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

	return {
		python: {
			running: Boolean(python),
			sessionName: python?.sessionName ?? DEFAULT_PYTHON_SESSION,
			runtime: python?.runtime ?? undefined,
			recordId: python?.recordId ?? undefined,
			recordPath: python?.recordPath ?? undefined,
			recordEntryCount: python?.recordEntryCount ?? 0,
			recordEntries: python?.recordTail ?? [],
			recordWarning: python?.recordWarning ?? undefined,
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
			recordId: julia?.recordId ?? undefined,
			recordPath: julia?.recordPath ?? undefined,
			recordEntryCount: julia?.recordEntryCount ?? 0,
			recordEntries: julia?.recordTail ?? [],
			recordWarning: julia?.recordWarning ?? undefined,
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
			recordId: r?.recordId ?? undefined,
			recordPath: r?.recordPath ?? undefined,
			recordEntryCount: r?.recordEntryCount ?? 0,
			recordEntries: r?.recordTail ?? [],
			recordWarning: r?.recordWarning ?? undefined,
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
			recordId: ghci?.recordId ?? undefined,
			recordPath: ghci?.recordPath ?? undefined,
			recordEntryCount: ghci?.recordEntryCount ?? 0,
			recordEntries: ghci?.recordTail ?? [],
			recordWarning: ghci?.recordWarning ?? undefined,
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
			recordId: clojure?.recordId ?? undefined,
			recordPath: clojure?.recordPath ?? undefined,
			recordEntryCount: clojure?.recordEntryCount ?? 0,
			recordEntries: clojure?.recordTail ?? [],
			recordWarning: clojure?.recordWarning ?? undefined,
			historyPath: clojure?.historyPath ?? undefined,
			historyLogging: Boolean(clojure?.historyPath),
			currentCommand: clojure?.currentCommand ?? undefined,
			currentPath: clojure?.currentPath ?? undefined,
			attachCommand: formatAttachCommand(DEFAULT_CLOJURE_SESSION),
		},
		runningSessions: sessions.map((session) => ({
			target: session.selector,
			sessionName: session.info.sessionName,
			runtime: session.info.runtime,
			recordId: session.info.recordId,
			recordPath: session.info.recordPath,
			recordEntryCount: session.info.recordEntryCount ?? 0,
			recordEntries: session.info.recordTail ?? [],
			recordWarning: session.info.recordWarning,
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
			"No shared REPL sessions are running. Start one with /repl python, /repl ipython, /repl julia, /repl R, /repl ghci, or /repl clojure.",
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
				"No shared REPL sessions are running. Start one with /repl python, /repl ipython, /repl julia, /repl R, /repl ghci, or /repl clojure.",
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

	const label = selector === "julia" ? "Julia" : selector === "r" ? "R" : selector === "ghci" ? "Haskell (GHCi)" : selector === "clojure" ? "Clojure" : "Python/IPython";
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
				"No shared REPL sessions are running. Start one with /repl python, /repl ipython, /repl julia, /repl R, /repl ghci, or /repl clojure.",
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

async function exportReplRecord(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	selector?: SessionSelector,
): Promise<void> {
	let selected: { selector: SessionSelector; info: SessionInfo } | undefined;
	if (selector) {
		const info = await readSessionInfo(pi, getSessionNameForSelector(selector), ctx.cwd);
		if (!info) {
			notify(ctx, formatNoSessionRunning(selector), "info");
			return;
		}
		selected = { selector, info };
	} else {
		const running = await listRunningSharedSessions(pi, ctx.cwd);
		if (running.length === 0) {
			notify(ctx, "No shared REPL sessions are running, so there is no clean record to export.", "info");
			return;
		}
		if (running.length > 1) {
			notify(
				ctx,
				[
					"Multiple shared REPL sessions are running.",
					"Choose one with /repl export python, julia, r, ghci, or clojure.",
				].join("\n"),
				"warning",
			);
			return;
		}
		selected = running[0];
	}

	const { info } = selected;
	if (!info.recordId) {
		notify(ctx, info.recordWarning || `No compatible clean record is available for ${info.sessionName}.`, "error");
		return;
	}

	try {
		const record = readReplSessionRecord(info.recordId, {
			sessionName: info.sessionName,
			tmuxSessionId: info.tmuxSessionId,
			tmuxSessionCreatedAt: info.tmuxSessionCreatedAt,
			runtime: info.runtime || "unknown",
		});
		if (!record) {
			notify(ctx, `The clean record for ${info.sessionName} is not available.`, "error");
			return;
		}
		const markdown = renderReplSessionRecordMarkdown(record);
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const baseName = `${info.sessionName}.record.${stamp}`;
		let outputPath: string | undefined;
		for (let suffix = 0; suffix < 100; suffix += 1) {
			const candidate = join(ctx.cwd, `${baseName}${suffix ? `-${suffix}` : ""}.md`);
			try {
				writeFileSync(candidate, markdown, { encoding: "utf8", flag: "wx", mode: 0o600 });
				outputPath = candidate;
				break;
			} catch (error) {
				if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
			}
		}
		if (!outputPath) throw new Error("Could not choose an unused export filename.");
		notify(ctx, `Exported ${record.entries.length} clean record entries to ${outputPath}`, "info");
	} catch (error) {
		notify(ctx, `Could not export the shared REPL record: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
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
		case "export":
			await exportReplRecord(pi, ctx, parsed.runtime ? toSessionSelector(parsed.runtime) : undefined);
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

			const sessionName = buildSessionName(parsed.runtime, parsed.name);
			const nameNote = parsed.name ? ` (from name: ${parsed.name})` : "";
			notify(
				ctx,
				[
					"Scaffold only: parsed REPL start request.",
					`Runtime: ${parsed.runtime}`,
					`tmux session: ${sessionName}${nameNote}`,
					"Only Python, IPython, Julia, R, GHCi, and basic Clojure session management are implemented so far.",
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
		description: "Inspect shared REPL session state for Python/IPython, Julia, R, Haskell (GHCi), and Clojure.",
		promptSnippet: "Check whether the shared Python/IPython, Julia, R, Haskell (GHCi), and Clojure REPL sessions are running.",
		promptGuidelines: [
			"Use this tool before claiming whether a shared REPL is running, especially after a previous failure or status change.",
			"If the user asks specifically about Julia, use target='julia'. If they ask specifically about R, use target='r'. If they ask specifically about GHCi or Haskell, use target='ghci'. If they ask specifically about Clojure, use target='clojure'. If they ask specifically about Python or IPython, use target='python'.",
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
		description: `Execute code in the shared default Python/IPython, Julia, R, Haskell (GHCi), or Clojure tmux REPL sessions (${DEFAULT_PYTHON_SESSION}, ${DEFAULT_JULIA_SESSION}, ${DEFAULT_R_SESSION}, ${DEFAULT_GHCI_SESSION}, ${DEFAULT_CLOJURE_SESSION}). Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first).`,
		promptSnippet: "Execute a small snippet in the shared Python/IPython, Julia, R, Haskell (GHCi), or Clojure REPL and return its output.",
		promptGuidelines: [
			"Use this tool only after a /repl python, /repl ipython, /repl julia, /repl R, /repl ghci, or /repl clojure session has been started.",
			"If the user asks to run code in Julia or in the shared Julia REPL, use target='julia'. If they ask to run code in R or in the shared R REPL, use target='r'. If they ask to run code in GHCi, Haskell, or the shared Haskell REPL, use target='ghci'. If they ask to run code in Clojure or in the shared Clojure REPL, use target='clojure'. Otherwise use the shared Python/IPython session.",
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
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			return executeReplSend(pi, params as { code: string; target?: string; timeoutMs?: number }, ctx, signal, toolCallId);
		},
	});
}
