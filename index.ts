import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	truncateTail,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
import {
	createReplSubmissionDisplay,
	normalizeReplSubmissionEchoMode,
	stripReplSubmissionDisplay,
} from "./shared/repl-submission-display.js";
import {
	cleanupPrivateReplControlFiles,
	createPrivateReplControlFiles,
} from "./shared/repl-control-files.js";

import { createPrivateReplHistoryFile } from "./shared/repl-history.js";
import { stopVerifiedReplSession } from "./shared/repl-session-stop.js";
import { mStringLiteral, buildMLanguageControlSource, buildMLanguageDriverSource } from "./shared/repl-m-language.js";
import { buildGnuplotSubmissionLine, buildGnuplotGuardSource, buildGnuplotDriverSource } from "./shared/repl-gnuplot.js";
import { GNUPLOT_OWNER_ENV, GNUPLOT_OWNER_OPTION } from "./shared/repl-gnuplot-processes.js";

const SUPPORTED_RUNTIMES = ["julia", "python", "ipython", "r", "ghci", "clojure", "clj", "ruby", "java", "octave", "matlab", "gnuplot", "bun"] as const;
const DEFAULT_PYTHON_SESSION = "pi-repl-python";
const DEFAULT_JULIA_SESSION = "pi-repl-julia";
const DEFAULT_R_SESSION = "pi-repl-r";
const DEFAULT_GHCI_SESSION = "pi-repl-ghci";
const DEFAULT_CLOJURE_SESSION = "pi-repl-clojure";
const DEFAULT_RUBY_SESSION = "pi-repl-ruby";
const DEFAULT_JAVA_SESSION = "pi-repl-java";
const DEFAULT_OCTAVE_SESSION = "pi-repl-octave";
const DEFAULT_MATLAB_SESSION = "pi-repl-matlab";
const DEFAULT_GNUPLOT_SESSION = "pi-repl-gnuplot";
const DEFAULT_CAPTURE_LINES = 20;
const DEFAULT_STARTUP_WAIT_MS = 20_000;
const MAX_STARTUP_WAIT_MS = 120_000;
const DEFAULT_STARTUP_POLL_MS = 250;
const DEFAULT_REPL_SEND_TIMEOUT_MS = 20_000;
const MAX_REPL_SEND_TIMEOUT_MS = 120_000;
const REPL_SEND_POLL_MS = 100;
const REPL_SEND_CAPTURE_LINES = 5_000;
// Optional private root override, also used by isolated integration tests.
const REPL_CONTROL_OPTIONS = { root: process.env.PI_REPL_CONTROL_ROOT };
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
type ManagedRuntime = PythonRuntime | "julia" | "r" | "ghci" | ClojureRuntime | "ruby" | "java" | "octave" | "matlab" | "gnuplot";
type ImplementedRuntime = Exclude<ManagedRuntime, "clj">;
type SessionSelector = Exclude<ImplementedRuntime, "ipython">;
type ReplSubmissionEchoMode = "off" | "summary" | "full";
type ReplSubmissionDisplay = ReturnType<typeof createReplSubmissionDisplay>;
type ReplSendParams = { code: string; target?: string; timeoutMs?: number; echoMode?: string };

type ReplCommand =
	| { action: "help" }
	| { action: "echo"; mode?: ReplSubmissionEchoMode }
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
	promptLine?: string;
};

type ReplSendDetails = {
	sessionName: string;
	runtime: ImplementedRuntime;
	timeoutMs: number;
	target: SessionSelector;
	submittedCode: string;
	echoMode: ReplSubmissionEchoMode;
	submissionAnchorId?: string;
	previewComment?: string;
	recordId?: string;
	recordPath?: string;
	recordEntryId?: string;
	recordWarning?: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
};

const REPL_SEND_PARAMS = Type.Object({
	code: Type.String({ description: "Python, IPython, Julia, R, GHCi, Clojure, Ruby, Java, Octave, MATLAB, or gnuplot code to execute in the shared REPL session." }),
	target: Type.Optional(
		Type.String({
			description: "Optional target REPL: python, julia, r, ghci, clojure, ruby, java, octave, matlab, or gnuplot. If omitted, repl_send uses the shared Python/IPython session.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description: "Maximum time to wait for completion in milliseconds (default 20000).",
			minimum: 1000,
			maximum: MAX_REPL_SEND_TIMEOUT_MS,
		}),
	),
	echoMode: Type.Optional(
		StringEnum(
			["off", "summary", "full"] as const,
			{ description: "How much submitted code to echo visibly in the raw REPL pane. Defaults to the current /repl echo setting (summary initially, unless PI_REPL_ECHO_MODE overrides it). Summary shows short submissions in full and truncates longer ones; Full has larger bounds and writes source code into persistent raw terminal history." },
		),
	),
});

let replSubmissionEchoMode = normalizeReplSubmissionEchoMode(process.env.PI_REPL_ECHO_MODE) as ReplSubmissionEchoMode;

function resolveReplSubmissionEchoMode(value?: string): ReplSubmissionEchoMode {
	return normalizeReplSubmissionEchoMode(value, replSubmissionEchoMode) as ReplSubmissionEchoMode;
}

const REPL_START_RUNTIMES = ["python", "ipython", "julia", "r", "ghci", "clojure", "ruby", "java", "octave", "matlab", "gnuplot"] as const;
const REPL_START_PARAMS = Type.Object({
	runtime: StringEnum(REPL_START_RUNTIMES, {
		description: "Runtime to start explicitly. Python and IPython share one session; an existing session is reused without switching its interpreter.",
	}),
	timeoutMs: Type.Optional(Type.Number({
		description: "How long to wait for a normal prompt in milliseconds (default 20000). Timeout leaves the session running and reports ready=false.",
		minimum: 1000,
		maximum: MAX_STARTUP_WAIT_MS,
	})),
});

const REPL_STATUS_PARAMS = Type.Object({
	target: Type.Optional(
		Type.String({
			description: "Optional session target: python, julia, r, ghci, ruby, java, clojure, octave, matlab, or gnuplot. If omitted, report all shared REPL sessions.",
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
	return value === "clj" || REPL_START_RUNTIMES.includes(value as ImplementedRuntime);
}

function toSessionSelector(runtime: ManagedRuntime): SessionSelector {
	if (runtime === "julia") return "julia";
	if (runtime === "r") return "r";
	if (runtime === "ghci") return "ghci";
	if (runtime === "clojure" || runtime === "clj") return "clojure";
	if (runtime === "ruby") return "ruby";
	if (runtime === "java") return "java";
	if (runtime === "octave" || runtime === "matlab" || runtime === "gnuplot") return runtime;
	return "python";
}

function getSessionNameForSelector(selector: SessionSelector): string {
	if (selector === "julia") return DEFAULT_JULIA_SESSION;
	if (selector === "r") return DEFAULT_R_SESSION;
	if (selector === "ghci") return DEFAULT_GHCI_SESSION;
	if (selector === "clojure") return DEFAULT_CLOJURE_SESSION;
	if (selector === "ruby") return DEFAULT_RUBY_SESSION;
	if (selector === "java") return DEFAULT_JAVA_SESSION;
	if (selector === "octave") return DEFAULT_OCTAVE_SESSION;
	if (selector === "matlab") return DEFAULT_MATLAB_SESSION;
	if (selector === "gnuplot") return DEFAULT_GNUPLOT_SESSION;
	return DEFAULT_PYTHON_SESSION;
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
		"  /repl octave",
		"  /repl matlab",
		"  /repl gnuplot",
		"  /repl echo [off|summary|full]",
		"  /repl status [python|julia|r|ghci|clojure|ruby|java|octave|matlab|gnuplot]",
		"  /repl env [python]",
		"  /repl attach [python|julia|r|ghci|clojure|ruby|java|octave|matlab|gnuplot]",
		"  /repl export [python|julia|r|ghci|clojure|ruby|java|octave|matlab|gnuplot]",
		"  /repl stop [python|julia|r|ghci|clojure|ruby|java|octave|matlab|gnuplot]",
		"",
		"Supported runtimes right now: python, ipython, julia, r, ghci, clojure, ruby, java, octave, matlab, gnuplot",
		"For R, both /repl R and /repl r work. The same applies to /lab, /repl status, /repl attach, /repl export, and /repl stop.",
		"For Clojure, /repl clojure is canonical and /repl clj also works. The same applies to /lab, /repl status, /repl attach, /repl export, and /repl stop.",
		"For Ruby, /repl ruby starts irb. For Java, /repl java starts jshell.",
		"",
		"Current real implementation:",
		"  - /repl python and /repl ipython manage the shared tmux session pi-repl-python",
		"  - /repl julia manages the shared tmux session pi-repl-julia",
		"  - /repl r manages the shared tmux session pi-repl-r",
		"  - /repl ghci manages the shared tmux session pi-repl-ghci",
		"  - /repl clojure and /repl clj manage the shared tmux session pi-repl-clojure",
		"  - /repl ruby manages the shared tmux session pi-repl-ruby",
		"  - /repl java manages the shared tmux session pi-repl-java",
		"  - /repl octave and /repl matlab manage separate terminal sessions; they never substitute for each other",
		"  - /repl gnuplot manages the independent pi-repl-gnuplot session, retaining native plotting settings",
		"  - /repl status, /repl attach, /repl export, and /repl stop can target any managed runtime",
		"  - repl_start lets pi start or reuse a session with an explicit runtime; repl_send never auto-starts one",
		"  - /repl echo controls the bounded submitted-code display in the raw pane; PI_REPL_ECHO_MODE sets the startup default",
		"  - /repl export writes the selected session's canonical clean record as Markdown",
		"  - /repl env inspects the shared Python/IPython session",
		"  - the repl_send tool can execute code in any supported shared session",
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

	if (firstLower === "echo") {
		if (rest.length === 0) return { action: "echo" };
		if (rest.length > 1 || !["off", "summary", "full"].includes(rest[0].toLowerCase())) {
			return { action: "error", message: "Usage: /repl echo [off|summary|full]" };
		}
		return { action: "echo", mode: rest[0].toLowerCase() as ReplSubmissionEchoMode };
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
	if (runtime === "ruby") return "irb";
	if (runtime === "java") return "jshell";
	if (runtime === "octave") return "octave-cli --quiet --interactive";
	if (runtime === "matlab") return "matlab -nodesktop -nosplash";
	return runtime;
}

function buildDefaultShellRuntimeCommand(runtime: ManagedRuntime, cwd?: string): { shell: string; command: string } {
	const shell = process.env.SHELL?.trim() || "/bin/sh";
	const runtimeCommand = buildRuntimeLaunchCommand(runtime) + (runtime === "matlab" && cwd ? ` -sd ${shellQuote(cwd)}` : "");
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

function getSessionTarget(sessionName: string): string {
	return /^\$\d+$/.test(sessionName) ? sessionName : `=${sessionName}`;
}

async function getPaneTarget(pi: ExtensionAPI, sessionName: string, cwd: string): Promise<string> {
	if (/^%\d+$/.test(sessionName)) return sessionName;
	// Resolve the first window/pane by its actual indexes, not the user's active
	// pane or an assumed 0.0. Use the stable pane ID for the whole submission.
	const result = await execTmux(pi, [
		"list-panes", "-s", "-t", getSessionTarget(sessionName),
		"-F", "#{window_index}\t#{pane_index}\t#{pane_id}",
	], cwd, 3_000);
	const panes = result.stdout.trim().split("\n")
		.map((line) => line.split("\t"))
		.filter(([window, pane, id]) => /^\d+$/.test(window) && /^\d+$/.test(pane) && /^%\d+$/.test(id))
		.sort((a, b) => Number(a[0]) - Number(b[0]) || Number(a[1]) - Number(b[1]));
	if (result.code !== 0 || !panes.length) {
		throw new Error(`Could not locate a REPL pane for ${sessionName}: ${result.stderr.trim() || "no panes found"}`);
	}
	return panes[0][2];
}

async function tmuxSessionExists(pi: ExtensionAPI, sessionName: string, cwd: string): Promise<boolean> {
	try {
		const result = await execTmux(pi, ["has-session", "-t", getSessionTarget(sessionName)], cwd, 3_000);
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
	let recordId = await readTmuxSessionOption(pi, identity.tmuxSessionId, REPL_SESSION_RECORD_ID_OPTION, cwd);
	let version = await readTmuxSessionOption(pi, identity.tmuxSessionId, REPL_SESSION_RECORD_VERSION_OPTION, cwd);
	if (recordId && !isValidReplSessionRecordId(recordId)) {
		return { warning: `Shared REPL record metadata is invalid for ${identity.sessionName}; leaving it untouched.` };
	}
	if (!recordId) {
		const candidate = createReplSessionRecordId();
		if (!(await setTmuxSessionOptionIfAbsent(pi, identity.tmuxSessionId, REPL_SESSION_RECORD_ID_OPTION, candidate, cwd))) {
			return { warning: `Could not attach shared record metadata to ${identity.sessionName}.` };
		}
		recordId = await readTmuxSessionOption(pi, identity.tmuxSessionId, REPL_SESSION_RECORD_ID_OPTION, cwd);
	}
	if (!recordId || !isValidReplSessionRecordId(recordId)) {
		return { warning: `Could not read valid shared record metadata from ${identity.sessionName}.` };
	}
	if (!version) {
		await setTmuxSessionOptionIfAbsent(
			pi,
			identity.tmuxSessionId,
			REPL_SESSION_RECORD_VERSION_OPTION,
			String(REPL_SESSION_RECORD_VERSION),
			cwd,
		);
		version = await readTmuxSessionOption(pi, identity.tmuxSessionId, REPL_SESSION_RECORD_VERSION_OPTION, cwd);
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
	sessionTarget = sessionName,
): Promise<{ historyPath?: string; warning?: string }> {
	let historyPath: string;
	let paneTarget: string;
	try {
		paneTarget = await getPaneTarget(pi, sessionTarget, cwd);
		historyPath = createPrivateReplHistoryFile(sessionName);
	} catch (error) {
		return { warning: `History logging could not be enabled for ${sessionName}: ${error instanceof Error ? error.message : String(error)}` };
	}

	const pipeCommand = `${shellQuote(process.execPath)} -e ${shellQuote(REPL_HISTORY_FILTER_SCRIPT)} >> ${shellQuote(historyPath)}`;
	const result = await execTmux(pi, ["pipe-pane", "-o", "-t", paneTarget, pipeCommand], cwd, 5_000);
	if (result.code !== 0) {
		const reason = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		return {
			warning: `History logging could not be enabled for ${sessionName}: ${reason}`,
		};
	}

	const stored = await setTmuxSessionOption(pi, sessionTarget, REPL_HISTORY_OPTION, historyPath, cwd);
	if (!stored) {
		return {
			historyPath,
			warning: `History logging is active for ${sessionName}, but the history path could not be recorded in tmux metadata.`,
		};
	}

	return { historyPath };
}

async function readSessionInfo(pi: ExtensionAPI, sessionName: string, cwd: string, inspectPrompt = false): Promise<SessionInfo | null> {
	if (!(await tmuxSessionExists(pi, sessionName, cwd))) return null;

	const target = await getPaneTarget(pi, sessionName, cwd);
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
	let promptLine: string | undefined;
	if (inspectPrompt) {
		// Inspect the physical cursor row, not the last nonblank history line:
		// an old prompt/banner above a blank current row is not readiness.
		const cursor = await execTmux(pi, ["display-message", "-p", "-t", target, "#{cursor_y}"], cwd, 3_000);
		const row = cursor.stdout.trim();
		if (cursor.code === 0 && /^\d+$/.test(row)) {
			const prompt = await execTmux(pi, ["capture-pane", "-p", "-t", target, "-S", row, "-E", row], cwd, 3_000);
			if (prompt.code === 0) promptLine = prompt.stdout.trimEnd();
		}
	}
	const runtime = await readTmuxSessionOption(pi, tmuxSessionId, REPL_RUNTIME_OPTION, cwd);
	const historyPath = await readTmuxSessionOption(pi, tmuxSessionId, REPL_HISTORY_OPTION, cwd);
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
		...(inspectPrompt ? { promptLine } : {}),
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
	if (selector === "ruby") return "Ruby (irb)";
	if (selector === "java") return "Java (jshell)";
	if (selector === "octave") return "Octave";
	if (selector === "matlab") return "MATLAB";
	if (selector === "gnuplot") return "gnuplot";
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
	for (const selector of ["octave", "matlab", "gnuplot"] as const) {
		const info = await readSessionInfo(pi, getSessionNameForSelector(selector), cwd);
		if (info) sessions.push({ selector, info });
	}
	return sessions;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasNormalReplPrompt(info: SessionInfo, requested: ImplementedRuntime): boolean {
	// Observe only: never send a probe, Enter or Ctrl-C into shared user state.
	// A running process or startup banner alone does not establish readiness.
	const runtime = info.runtime || requested;
	const prompts: Record<ImplementedRuntime, RegExp> = {
		python: /(?:^|\n)>>>[ \t]*$/,
		ipython: /(?:^|\n)In \[\d+\]:[ \t]*$/,
		julia: /(?:^|\n)julia>[ \t]*$/,
		r: /(?:^|\n)>[ \t]*$/,
		ghci: /(?:^|\n)(?:\*?[A-Za-z0-9_.:]+)(?: \*?[A-Za-z0-9_.:]+)*>[ \t]*$/,
		clojure: /(?:^|\n)[^\s>]+=>[ \t]*$/,
		ruby: /(?:^|\n)irb\([^\n]*\):\d+(?::0)?>[ \t]*$/,
		java: /(?:^|\n)jshell>[ \t]*$/,
		octave: /(?:^|\n)octave:\d+>[ \t]*$/,
		matlab: /(?:^|\n)>>[ \t]*$/,
		gnuplot: /(?:^|\n)gnuplot>[ \t]*$/,
	};
	if (!REPL_START_RUNTIMES.includes(runtime as ImplementedRuntime)) return false;
	if (toSessionSelector(runtime as ImplementedRuntime) !== toSessionSelector(requested)) return false;
	const line = info.promptLine ?? "";
	// Shell aliases and legacy metadata can label either Python frontend as
	// the other. They intentionally share one session and execution protocol.
	if (runtime === "python" || runtime === "ipython") return prompts.python.test(line) || prompts.ipython.test(line);
	return prompts[runtime as ImplementedRuntime].test(line);
}

function checkStartAborted(signal: AbortSignal | undefined, sessionName: string): void {
	if (signal?.aborted) {
		throw new Error(`REPL start aborted for ${sessionName}. Any session already created is left running; inspect it with repl_status.`);
	}
}

async function waitForReplSessionInfo(
	pi: ExtensionAPI,
	cwd: string,
	sessionTarget: string,
	sessionName: string,
	runtime: ImplementedRuntime,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ info: SessionInfo; ready: boolean }> {
	const deadline = Date.now() + timeoutMs;
	let identity: SessionInfo | undefined;
	while (true) {
		checkStartAborted(signal, sessionName);
		const info = await readSessionInfo(pi, identity?.tmuxSessionId || sessionTarget, cwd, true);
		checkStartAborted(signal, sessionName);
		if (!info) throw new Error(`REPL session ended while waiting for ${sessionName}. Check the runtime and your login-shell configuration before retrying.`);
		if (identity && (info.tmuxSessionId !== identity.tmuxSessionId || info.tmuxSessionCreatedAt !== identity.tmuxSessionCreatedAt || info.recordId !== identity.recordId)) {
			throw new Error(`REPL session ${sessionName} changed while waiting for its prompt. No replacement was started; inspect it with repl_status.`);
		}
		identity = info;
		if (hasNormalReplPrompt(info, runtime)) return { info, ready: true };
		if (Date.now() >= deadline) return { info, ready: false };
		await sleep(Math.min(DEFAULT_STARTUP_POLL_MS, deadline - Date.now()));
	}
}

type ReplControlPaths = {
	dir: string;
	sourceFile: string;
	doneFile: string;
};

type ReplSubmissionState = {
	recordId?: string;
	sessionName: string;
	sessionTarget: string;
	tmuxSessionId: string;
	tmuxSessionCreatedAt: number;
	cwd: string;
	runtime: ImplementedRuntime;
	beforeCapture: string;
	prepared: ReturnType<typeof prepareReplControlFiles>;
	completionObserved: boolean;
};

function getReplControlExtension(runtime: ImplementedRuntime): string {
	if (runtime === "julia") return "jl";
	if (runtime === "r") return "R";
	if (runtime === "ghci") return "ghci";
	if (runtime === "clojure") return "clj";
	if (runtime === "ruby") return "rb";
	if (runtime === "java") return "java";
	if (runtime === "octave" || runtime === "matlab") return "m";
	if (runtime === "gnuplot") return "gp";
	return "py";
}

function buildPythonDisplayStatements(display: ReplSubmissionDisplay, indent = ""): string[] {
	if (!display.enabled) return [];
	return display.prefixLines.map((line) => `${indent}__pi_repl_builtins.print(${JSON.stringify(line)})`);
}

function juliaStringLiteral(value: string): string {
	// JSON escaping alone leaves Julia's $ interpolation active in the wrapper.
	return JSON.stringify(value).replace(/\$/g, "\\$");
}

function buildJuliaDisplayStatements(display: ReplSubmissionDisplay, indent = ""): string[] {
	if (!display.enabled) return [];
	return display.prefixLines.map((line) => `${indent}Base.println(${juliaStringLiteral(line)})`);
}

function buildRDisplayStatements(display: ReplSubmissionDisplay, indent = ""): string[] {
	if (!display.enabled) return [];
	return display.prefixLines.map((line) => `${indent}base::cat(${JSON.stringify(`${line}\n`)})`);
}

function buildClojureDisplayStatements(display: ReplSubmissionDisplay, indent = ""): string[] {
	if (!display.enabled) return [];
	return display.prefixLines.map((line) => `${indent}(clojure.core/println ${JSON.stringify(line)})`);
}

function buildPythonControlSource(runtime: PythonRuntime, code: string, doneFile: string, display: ReplSubmissionDisplay): string {
	const prefix = buildPythonDisplayStatements(display);
	const completion = display.suffixLines.map((line) => `    __pi_repl_builtins.print(${JSON.stringify(line)})`);
	if (runtime === "ipython") {
		return [
			"from pathlib import Path as __pi_repl_path",
			"import builtins as __pi_repl_builtins",
			"import traceback as __pi_repl_traceback",
			...prefix,
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
			...completion,
			`    __pi_repl_path(${JSON.stringify(doneFile)}).write_text('done\\n', encoding='utf-8')`,
		].join("\n");
	}

	return [
		"from pathlib import Path as __pi_repl_path",
		"import builtins as __pi_repl_builtins",
		"import traceback as __pi_repl_traceback",
		...prefix,
		"try:",
		`    exec(compile(${JSON.stringify(code)}, '<pi-repl>', 'exec'), globals())`,
		"except Exception:",
		"    __pi_repl_traceback.print_exc()",
		"finally:",
		...completion,
		`    __pi_repl_path(${JSON.stringify(doneFile)}).write_text('done\\n', encoding='utf-8')`,
	].join("\n");
}

function buildJuliaControlSource(code: string, doneFile: string, display: ReplSubmissionDisplay): string {
	const completion = display.suffixLines.map((line) => `    Base.println(${juliaStringLiteral(line)})`);
	return [
		...buildJuliaDisplayStatements(display),
		"try",
		`    local __pi_result = Base.include_string(Main, ${juliaStringLiteral(code)}, "pi-repl")`,
		"    if !isnothing(__pi_result)",
		"        println(repr(__pi_result))",
		"    end",
		"catch e",
		"    Base.display_error(stderr, e, catch_backtrace())",
		"finally",
		...completion,
		`    write(${juliaStringLiteral(doneFile)}, "done\\n")`,
		"end",
	].join("\n");
}

function buildRControlSource(code: string, doneFile: string, display: ReplSubmissionDisplay): string {
	const completion = display.suffixLines.map((line) => `    base::cat(${JSON.stringify(`${line}\n`)})`);
	return [
		"local({",
		...buildRDisplayStatements(display, "  "),
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
		...completion,
		"    writeLines(\"done\", .__pi_repl_done_file)",
		"  })",
		"})",
	].join("\n");
}

function buildGhciControlSource(code: string, doneFile: string, display: ReplSubmissionDisplay): string {
	if (/[\r\n]/.test(doneFile)) throw new Error("GHCi control paths cannot contain line breaks.");
	const prefix = display.enabled
		? display.prefixLines.map((line) => `:! command printf '%s\\n' ${shellQuote(line)}`)
		: [];
	return [...prefix, code.replace(/\r/g, "").trimEnd()].filter(Boolean).join("\n");
}

function rubyStringLiteral(value: string): string {
	// JSON escaping leaves Ruby's #{...}, #@... and #$... interpolation active.
	// ASCII escapes also keep Unicode paths intact through older IRB input editors.
	return JSON.stringify(value).replace(/#/g, "\\#")
		.replace(/[^\x00-\x7f]/gu, (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`);
}

function buildRubyControlSource(code: string, doneFile: string, display: ReplSubmissionDisplay): string {
	const prefix = display.enabled ? display.prefixLines.map((line) => `  puts ${rubyStringLiteral(line)}`) : [];
	// Query the actual terminal column rather than intercepting user stdout.
	// Keep the old newline guard if the bounded, read-only query is unavailable.
	const completion = display.enabled ? [
		'  __pi_repl_column = ""',
		"  begin",
		"    $stdout.flush",
		"    $stderr.flush",
		// Ruby's $? is thread-local: do not replace the user's last child status.
		"    __pi_repl_column = Thread.new do",
		"      begin",
		`        IO.popen(["tmux", "-N", "display-message", "-p", "-t", ENV.fetch("TMUX_PANE"), ${rubyStringLiteral("#{cursor_x}")}], err: File::NULL) do |__pi_repl_query|`,
		"          begin",
		"            if IO.select([__pi_repl_query], nil, nil, 0.5)",
		"              __pi_repl_bytes = __pi_repl_query.read_nonblock(32, exception: false)",
		'              __pi_repl_bytes.is_a?(String) ? __pi_repl_bytes.strip : ""',
		"            else",
		'              ""',
		"            end",
		"          ensure",
		// Reap only our own query process, including on timeout; never leave an
		// IO.popen close waiting indefinitely for a stuck tmux client to exit.
		"            Process.kill('KILL', __pi_repl_query.pid) rescue nil",
		"          end",
		"        end",
		"      rescue StandardError",
		'        ""',
		"      end",
		"    end.value",
		"  rescue StandardError",
		'    __pi_repl_column = ""',
		"  end",
		'  puts unless __pi_repl_column == "0"',
		...display.suffixLines.map((line) => `  puts ${rubyStringLiteral(line)}`),
	] : ["  puts"];
	return [
		"begin",
		...prefix,
		`  __pi_repl_code = ${rubyStringLiteral(code)}`,
		"  __pi_repl_context = defined?(IRB) && IRB.respond_to?(:CurrentContext) && IRB.CurrentContext",
		"  __pi_repl_binding = __pi_repl_context ? __pi_repl_context.workspace.binding : TOPLEVEL_BINDING",
		"  __pi_repl_result = eval(__pi_repl_code, __pi_repl_binding, '<pi-repl>', 1)",
		"  p __pi_repl_result unless __pi_repl_result.nil?",
		"rescue Exception => __pi_repl_e",
		"  $stderr.puts __pi_repl_e.full_message(highlight: false)",
		"ensure",
		...completion,
		`  File.write(${rubyStringLiteral(doneFile)}, "done\\n")`,
		// IRB checks echo? immediately after evaluating the loader. Suppress
		// just that result, restoring the original method before returning.
		"  begin",
		"    if __pi_repl_context && __pi_repl_context.respond_to?(:echo?)",
		"      __pi_repl_echo_owner = __pi_repl_context.singleton_class",
		"      __pi_repl_echo_owned = __pi_repl_echo_owner.instance_methods(false).include?(:echo?)",
		"      __pi_repl_echo_original = __pi_repl_context.method(:echo?)",
		"      __pi_repl_context.define_singleton_method(:echo?) do",
		"        if __pi_repl_echo_owned",
		"          __pi_repl_echo_owner.send(:define_method, :echo?, __pi_repl_echo_original)",
		"        else",
		"          __pi_repl_echo_owner.send(:remove_method, :echo?)",
		"        end",
		"        false",
		"      end",
		"    end",
		"  rescue StandardError",
		// If a customised/frozen context refuses the hook, keep normal IRB
		// behaviour rather than fail the already completed submission.
		"  end",
		"end",
	].join("\n");
}

function buildJavaControlSource(code: string, doneFile: string, display: ReplSubmissionDisplay): string {
	if (/[\r\n]/.test(doneFile)) throw new Error("JShell control paths cannot contain line breaks.");
	const prefix = display.enabled ? display.prefixLines.map((line) => `java.lang.System.out.println(${JSON.stringify(line)});`) : [];
	// /open evaluates top-level snippets in the existing JShell. Completion
	// stays in the outer driver, outside this source file's parser state.
	return [...prefix, code.replace(/\r/g, "").trimEnd(), ""].join("\n");
}

function buildClojureControlSource(code: string, doneFile: string, display: ReplSubmissionDisplay): string {
	const completion = display.suffixLines.map((line) => `      (clojure.core/println ${JSON.stringify(line)})`);
	return [
		"(let [code " + JSON.stringify(code) + "]",
		...buildClojureDisplayStatements(display, "  "),
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
		...completion,
		`      (spit ${JSON.stringify(doneFile)} "done\\n"))))`,
	].join("\n");
}

function buildReplControlSource(runtime: ImplementedRuntime, code: string, doneFile: string, display: ReplSubmissionDisplay): string {
	if (runtime === "julia") return buildJuliaControlSource(code, doneFile, display);
	if (runtime === "r") return buildRControlSource(code, doneFile, display);
	if (runtime === "ghci") return buildGhciControlSource(code, doneFile, display);
	if (runtime === "clojure") return buildClojureControlSource(code, doneFile, display);
	if (runtime === "ruby") return buildRubyControlSource(code, doneFile, display);
	if (runtime === "java") return buildJavaControlSource(code, doneFile, display);
	if (runtime === "octave" || runtime === "matlab") return buildMLanguageControlSource(code, display);
	if (runtime === "gnuplot") return code + "\n";
	return buildPythonControlSource(runtime, code, doneFile, display);
}

function buildReplSubmissionLine(runtime: ImplementedRuntime, sourceFile: string): string {
	const quotedPath = JSON.stringify(sourceFile);
	if (runtime === "julia") {
		return `include(${juliaStringLiteral(sourceFile)})`;
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
		return `load ${rubyStringLiteral(sourceFile)}; nil`;
	}
	if (runtime === "java") {
		return `/open ${sourceFile}`;
	}
	if (runtime === "octave" || runtime === "matlab") return `eval(fileread(${mStringLiteral(sourceFile)}));`;
	if (runtime === "gnuplot") return buildGnuplotSubmissionLine(sourceFile);
	return `exec(open(${quotedPath}).read(),globals())`;
}

function buildJavaDriverSource(sourceFile: string, doneFile: string, display: ReplSubmissionDisplay): string {
	// Only add a newline when the terminal is mid-line. The scoped query does
	// not replace System.out/err, change user declarations, or emit another /open.
	const completion = display.enabled ? [
		'  String __pi_repl_column = "";',
		"  java.lang.Process __pi_repl_query = null;",
		"  try {",
		"    java.lang.System.out.flush();",
		"    java.lang.System.err.flush();",
		`    __pi_repl_query = new java.lang.ProcessBuilder("tmux", "-N", "display-message", "-p", "-t", java.lang.System.getenv("TMUX_PANE"), ${JSON.stringify("#{cursor_x}")}).redirectError(java.lang.ProcessBuilder.Redirect.DISCARD).start();`,
		"    if (__pi_repl_query.waitFor(500, java.util.concurrent.TimeUnit.MILLISECONDS) && __pi_repl_query.exitValue() == 0) {",
		// Do not wait for EOF if an unexpected descendant inherits the pipe.
		"      byte[] __pi_repl_bytes = new byte[32];",
		"      int __pi_repl_count = __pi_repl_query.getInputStream().read(__pi_repl_bytes, 0, Math.min(32, __pi_repl_query.getInputStream().available()));",
		"      __pi_repl_column = new String(__pi_repl_bytes, 0, Math.max(0, __pi_repl_count), java.nio.charset.StandardCharsets.UTF_8).trim();",
		"    }",
		"  } catch (Exception __pi_repl_ignored) {",
		'    __pi_repl_column = "";',
		"  } finally {",
		"    if (__pi_repl_query != null) {",
		"      try { __pi_repl_query.destroyForcibly(); } catch (Exception __pi_repl_ignored) {}",
		"    }",
		"  }",
		'  if (!"0".equals(__pi_repl_column)) java.lang.System.out.println();',
		...display.suffixLines.map((line) => `  java.lang.System.out.println(${JSON.stringify(line)});`),
	] : [];
	return [
		buildReplSubmissionLine("java", sourceFile),
		"{",
		...completion,
		`  java.nio.file.Files.write(java.nio.file.Paths.get(${JSON.stringify(doneFile)}), new byte[]{100, 111, 110, 101, 10});`,
		"}",
	].join("\n");
}

function buildReplCompletionLine(runtime: ImplementedRuntime, doneFile: string, display: ReplSubmissionDisplay): string | undefined {
	if (runtime === "ghci") {
		// Run from the outer driver, after the guard has absorbed a source
		// script failure. Node is already used by the raw-history pipe; its
		// bounded cursor query avoids both blank padding and inline footers.
		const footerScript = [
			'let column = "";',
			'try { column = require("node:child_process").execFileSync("tmux", ["-N", "display-message", "-p", "-t", process.env.TMUX_PANE, "#{cursor_x}"], { encoding: "utf8", timeout: 500, killSignal: "SIGKILL", maxBuffer: 128, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}',
			`process.stdout.write((column === "0" ? "" : "\\n") + ${JSON.stringify(`${display.suffixLines.join("\n")}\n`)});`,
		].join(" ");
		const fallback = `command printf '\\n%s\\n\\n' ${shellQuote(display.endMarker)}`;
		const displayCommand = display.enabled ? `${shellQuote(process.execPath)} -e ${shellQuote(footerScript)} 2>/dev/null || ${fallback}; ` : "";
		return `:! ${displayCommand}touch ${shellQuote(doneFile)}`;
	}
	return undefined;
}

function buildSubmissionText(submissionLine: string, previewComment?: string, completionLine?: string): string {
	return [previewComment, submissionLine, completionLine].filter((value) => Boolean(value)).join("\n");
}

function prepareReplControlFiles(
	runtime: ImplementedRuntime,
	code: string,
	details: { submissionId: string; echoMode: ReplSubmissionEchoMode },
): { controlPaths: ReplControlPaths; guardPaths?: ReplControlPaths; driverPaths?: ReplControlPaths; submissionLine: string; completionLine?: string; previewComment?: string; submissionText: string; display: ReplSubmissionDisplay } {
	const display = createReplSubmissionDisplay({
		entryId: details.submissionId,
		origin: "pi-repl",
		code,
		mode: details.echoMode,
	});
	const controlOptions = { ...REPL_CONTROL_OPTIONS, anchorId: display.anchorId };
	const controlPaths: ReplControlPaths = createPrivateReplControlFiles({
		...controlOptions,
		extension: getReplControlExtension(runtime),
		buildSource: ({ doneFile }: ReplControlPaths) => buildReplControlSource(runtime, code, doneFile, display),
	});
	let guardPaths: ReplControlPaths | undefined;
	let driverPaths: ReplControlPaths | undefined;
	try {
		if (runtime === "ghci") {
			// An unclosed :{ throws out of source collection. The guard's
			// command handler catches it and its script stops normally, letting
			// the OUTER driver continue to completion. Two levels alone fail.
			const guard = createPrivateReplControlFiles({
				...controlOptions,
				extension: "ghci",
				buildSource: () => buildReplSubmissionLine("ghci", controlPaths.sourceFile) + "\n",
			});
			guardPaths = guard;
			driverPaths = createPrivateReplControlFiles({
				...controlOptions,
				extension: "ghci",
				buildSource: () => [buildReplSubmissionLine("ghci", guard.sourceFile), buildReplCompletionLine("ghci", controlPaths.doneFile, display), ""].join("\n"),
			});
		}
		// JShell echoes only the outer /open. Its nested source load returns
		// before completion, even if user source is rejected or unfinished.
		if (runtime === "java") {
			driverPaths = createPrivateReplControlFiles({
				...controlOptions,
				extension: "java",
				buildSource: () => buildJavaDriverSource(controlPaths.sourceFile, controlPaths.doneFile, display),
			});
		}
		if (runtime === "octave" || runtime === "matlab") {
			driverPaths = createPrivateReplControlFiles({
				...controlOptions,
				extension: "m",
				buildSource: () => buildMLanguageDriverSource(runtime, controlPaths.sourceFile, controlPaths.doneFile, display),
			});
		}
		if (runtime === "gnuplot") {
			const guard = createPrivateReplControlFiles({
				...controlOptions,
				extension: "gp",
				buildSource: ({ doneFile }: ReplControlPaths) => buildGnuplotGuardSource(doneFile),
			});
			guardPaths = guard;
			driverPaths = createPrivateReplControlFiles({
				...controlOptions,
				extension: "cjs",
				buildSource: () => buildGnuplotDriverSource(controlPaths.sourceFile, guard.sourceFile, guard.doneFile, controlPaths.doneFile, display),
			});
		}
		const submissionLine = buildReplSubmissionLine(runtime, driverPaths?.sourceFile ?? controlPaths.sourceFile);
		const completionLine = driverPaths ? undefined : buildReplCompletionLine(runtime, controlPaths.doneFile, display);
		const previewComment = undefined;
		return {
			controlPaths,
			guardPaths,
			driverPaths,
			submissionLine,
			completionLine,
			previewComment,
			display,
			submissionText: buildSubmissionText(submissionLine, previewComment, completionLine),
		};
	} catch (error) {
		cleanupPrivateReplControlFiles(controlPaths);
		cleanupPrivateReplControlFiles(guardPaths);
		cleanupPrivateReplControlFiles(driverPaths);
		throw error;
	}
}

async function pasteTextToTmuxPane(
	pi: ExtensionAPI,
	sessionTarget: string,
	cwd: string,
	text: string,
	onPasted?: () => void,
): Promise<void> {
	const bufferName = `pi-repl-${randomUUID()}`;
	const target = await getPaneTarget(pi, sessionTarget, cwd);
	const controlPaths = createPrivateReplControlFiles({ ...REPL_CONTROL_OPTIONS, extension: "txt", buildSource: () => text });
	const tempFile = controlPaths.sourceFile;

	try {
		// load-buffer expands tmux formats even in an argv path; keep # literal.
		const loadResult = await execTmux(pi, ["load-buffer", "-b", bufferName, tempFile.replace(/#/g, "##")], cwd, 5_000);
		if (loadResult.code !== 0) {
			const reason = loadResult.stderr.trim() || loadResult.stdout.trim() || `exit code ${loadResult.code}`;
			throw new Error(`Failed to load tmux buffer: ${reason}`);
		}

		const pasteResult = await execTmux(pi, ["paste-buffer", "-d", "-b", bufferName, "-t", target], cwd, 5_000);
		if (pasteResult.code !== 0) {
			const reason = pasteResult.stderr.trim() || pasteResult.stdout.trim() || `exit code ${pasteResult.code}`;
			throw new Error(`Failed to paste tmux buffer: ${reason}`);
		}
		onPasted?.();

		const enterResult = await execTmux(pi, ["send-keys", "-t", target, "C-m"], cwd, 5_000);
		if (enterResult.code !== 0) {
			const reason = enterResult.stderr.trim() || enterResult.stdout.trim() || `exit code ${enterResult.code}`;
			throw new Error(`Failed to send Enter to tmux pane: ${reason}`);
		}
	} finally {
		cleanupPrivateReplControlFiles(controlPaths);
		await execTmux(pi, ["delete-buffer", "-b", bufferName], cwd, 2_000).catch(() => undefined);
	}
}

async function capturePaneOutput(pi: ExtensionAPI, sessionTarget: string, cwd: string): Promise<string> {
	const target = await getPaneTarget(pi, sessionTarget, cwd);
	const result = await execTmux(
		pi,
		["capture-pane", "-J", "-p", "-t", target, "-S", `-${REPL_SEND_CAPTURE_LINES}`],
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

export function cleanupReplDelta(delta: string, submissionLine: string, previewComment?: string, completionLine?: string, display?: ReplSubmissionDisplay): string {
	const isMLanguageSubmission = submissionLine.startsWith("eval(fileread(");
	const isPrompt = (line: string) =>
		/^(?:>>>|In \[\d+\]:|\.\.\.:|>|\+)\s*$/.test(line) ||
		/^(ghci|Prelude|\*?[A-Za-z0-9_.:]+)>\s*$/.test(line) ||
		/^[^\s>]+=>\s*$/.test(line) ||
		/^irb\(.*\)[:\d]+[>*]\s*$/.test(line) ||
		(isMLanguageSubmission && /^(?:octave:\d+>|>>)\s*$/.test(line));
	const echoEnd = (line: string, command: string) => {
		if (!command) return -1;
		const index = line.indexOf(command);
		const prefix = line.slice(0, index).trim();
		// An exact command at the start (optionally after a native prompt),
		// not a command/path mentioned somewhere inside a diagnostic.
		return index >= 0 && (!prefix || isPrompt(prefix)) ? index + command.length : -1;
	};
	const lines = stripBoundaryBlankLines(delta).split("\n");
	let removedPreview = false;
	while (lines.length > 0) {
		const first = lines[0].trim();
		if (!first || isPrompt(first)) { lines.shift(); continue; }
		if (!removedPreview && previewComment && first === previewComment) {
			lines.shift();
			removedPreview = true;
			continue;
		}
		const end = echoEnd(lines[0], submissionLine);
		if (end < 0) break;
		// Some input editors join output/header to the loader echo. Preserve
		// the remainder, including its spaces, and consume at most ONE echo:
		// printing that same command again is legitimate user output.
		const remainder = lines[0].slice(end);
		if (remainder.trim()) lines[0] = remainder;
		else lines.shift();
		break;
	}

	const isClojureSubmission = submissionLine.startsWith("(do (load-file ") && submissionLine.endsWith(":pi-repl/silent)");
	let removedPrompt = false;
	let removedResult = false;
	let removedCompletion = false;
	while (lines.length > 0) {
		const last = lines[lines.length - 1].trim();
		if (!last) { lines.pop(); continue; }
		if (!removedPrompt && isPrompt(last)) {
			lines.pop();
			removedPrompt = true;
			continue;
		}
		if (!removedResult && isClojureSubmission && last === ":pi-repl/silent") {
			lines.pop();
			removedResult = true;
			continue;
		}
		if (!removedCompletion && completionLine && echoEnd(last, completionLine) === last.length) {
			lines.pop();
			removedCompletion = true;
			continue;
		}
		break;
	}

	// Remove native scaffolding while the display still separates it from
	// payload. Never reclassify that payload using generic loader/path/comment
	// substrings (e.g. /tmp/pi-repl), which can be real output or error text.
	const scaffoldCleaned = lines.join("\n");
	return stripBoundaryBlankLines(display ? stripReplSubmissionDisplay(scaffoldCleaned, display) : scaffoldCleaned);
}

async function waitForReplDoneFile(
	pi: ExtensionAPI,
	sessionName: string,
	sessionTarget: string,
	paneTarget: string,
	cwd: string,
	doneFile: string,
	timeoutMs: number,
	signal?: AbortSignal,
	captureContext?: { beforeCapture: string; prepared: ReturnType<typeof prepareReplControlFiles> },
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

		latestCapture = await capturePaneOutput(pi, paneTarget, cwd);
		await sleep(REPL_SEND_POLL_MS);
	}

	const latestOutput = captureContext
		? cleanupReplDelta(
			extractPaneDelta(captureContext.beforeCapture, latestCapture),
			captureContext.prepared.submissionLine,
			captureContext.prepared.previewComment,
			captureContext.prepared.completionLine,
			captureContext.prepared.display,
		)
		: latestCapture;
	const tail = truncateTail(latestOutput, {
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
	if (trimmed === "octave" || trimmed === "matlab" || trimmed === "gnuplot") return trimmed;
	throw new Error(`Unknown repl_send target: ${target}`);
}

async function runReplCode(
	pi: ExtensionAPI,
	params: ReplSendParams,
	ctx: ExtensionContext,
	signal?: AbortSignal,
	options: {
		expectedSession?: ReplSessionIdentity;
		expectedRecordId?: string;
		onSubmissionStarted?: (state: ReplSubmissionState) => void;
		submissionId?: string;
	} = {},
): Promise<{ output: string; details: ReplSendDetails }> {
	const code = params.code ?? "";
	if (!code.trim()) {
		throw new Error("repl_send requires non-empty code.");
	}

	const target = normalizeReplSendTarget(params.target) ?? "python";
	const sessionName = getSessionNameForSelector(target);

	if (!(await tmuxSessionExists(pi, sessionName, ctx.cwd))) {
		if (target === "octave" || target === "matlab" || target === "gnuplot") throw new Error(`No default ${getSessionDisplayName(target)} REPL session is running (${sessionName}). Start one with /repl ${target} first.`);
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
		if (target === "octave" || target === "matlab" || target === "gnuplot") throw new Error(`Could not inspect the default ${getSessionDisplayName(target)} REPL session (${sessionName}). Inspect it with /repl status ${target}.`);
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

	if (
		options.expectedSession
		&& (
			sessionInfo.sessionName !== options.expectedSession.sessionName
			|| sessionInfo.tmuxSessionId !== options.expectedSession.tmuxSessionId
			|| sessionInfo.tmuxSessionCreatedAt !== options.expectedSession.tmuxSessionCreatedAt
			|| (options.expectedRecordId && sessionInfo.recordId !== options.expectedRecordId)
		)
	) {
		throw new Error(`REPL session ${sessionName} changed while repl_send was waiting to execute.`);
	}

	const runtime: ImplementedRuntime = target === "python" ? normalizePythonRuntime(sessionInfo) : target;
	const timeoutMs = clampReplSendTimeout(params.timeoutMs);
	const sessionTarget = sessionInfo.tmuxSessionId || sessionName;
	const paneTarget = await getPaneTarget(pi, sessionTarget, ctx.cwd);
	const beforeCapture = await capturePaneOutput(pi, paneTarget, ctx.cwd);
	const echoMode = resolveReplSubmissionEchoMode(params.echoMode);
	const prepared = prepareReplControlFiles(runtime, code, {
		submissionId: options.submissionId || `pi-repl:local:${randomUUID()}`,
		echoMode,
	});
	const submissionState: ReplSubmissionState = {
		recordId: sessionInfo.recordId,
		sessionName,
		sessionTarget,
		tmuxSessionId: sessionInfo.tmuxSessionId,
		tmuxSessionCreatedAt: sessionInfo.tmuxSessionCreatedAt,
		cwd: ctx.cwd,
		runtime,
		beforeCapture,
		prepared,
		completionObserved: false,
	};

	let submissionStarted = false;
	try {
		await pasteTextToTmuxPane(pi, paneTarget, ctx.cwd, prepared.submissionText, () => {
			submissionStarted = true;
			options.onSubmissionStarted?.(submissionState);
		});
		await waitForReplDoneFile(
			pi,
			sessionName,
			sessionTarget,
			paneTarget,
			ctx.cwd,
			prepared.controlPaths.doneFile,
			timeoutMs,
			signal,
			{ beforeCapture, prepared },
		);
		submissionState.completionObserved = true;
		const afterCapture = await capturePaneOutput(pi, paneTarget, ctx.cwd);
		const delta = extractPaneDelta(beforeCapture, afterCapture);
		const output = cleanupReplDelta(delta, prepared.submissionLine, prepared.previewComment, prepared.completionLine, prepared.display);
		cleanupPrivateReplControlFiles(prepared.controlPaths);
		cleanupPrivateReplControlFiles(prepared.guardPaths);
		cleanupPrivateReplControlFiles(prepared.driverPaths);

		return {
			output,
			details: {
				sessionName,
				runtime,
				target,
				timeoutMs,
				submittedCode: code,
				echoMode,
				submissionAnchorId: prepared.display.enabled ? prepared.display.anchorId : undefined,
				previewComment: prepared.previewComment,
			},
		};
	} catch (error) {
		if (existsSync(prepared.controlPaths.doneFile)) submissionState.completionObserved = true;
		if (!submissionStarted || submissionState.completionObserved) {
			cleanupPrivateReplControlFiles(prepared.controlPaths);
			cleanupPrivateReplControlFiles(prepared.guardPaths);
			cleanupPrivateReplControlFiles(prepared.driverPaths);
		} else if (!options.onSubmissionStarted) {
			retainReplSubmissionUntilSettled(pi, submissionState, null);
		}
		throw error;
	}
}

function sleepWithoutKeepingProcessAlive(ms: number): Promise<void> {
	return new Promise((resolveSleep) => {
		const timer = setTimeout(resolveSleep, ms);
		timer.unref?.();
	});
}

function retainReplSubmissionUntilSettled(
	pi: ExtensionAPI,
	state: ReplSubmissionState,
	lease: Awaited<ReturnType<typeof acquireReplSessionSendLease>> | null,
): void {
	// A timeout or abort only stops the caller's wait; it does not stop code that
	// is already running in the shared REPL. Keep the private control files (and
	// any shared lease) until the wrapper reports completion or the session ends.
	void (async () => {
		let missingChecks = 0;
		try {
			while (!existsSync(state.prepared.controlPaths.doneFile)) {
				if (!existsSync(state.prepared.controlPaths.sourceFile)) return;
				try {
					const current = await readSessionInfo(pi, state.sessionName, state.cwd);
					if (
						current
						&& current.tmuxSessionId === state.tmuxSessionId
						&& current.tmuxSessionCreatedAt === state.tmuxSessionCreatedAt
						&& (!state.recordId || current.recordId === state.recordId)
					) {
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
		} finally {
			cleanupPrivateReplControlFiles(state.prepared.controlPaths);
			cleanupPrivateReplControlFiles(state.prepared.guardPaths);
			cleanupPrivateReplControlFiles(state.prepared.driverPaths);
			await lease?.release().catch(() => undefined);
		}
	})();
}

async function runRecordedReplCode(
	pi: ExtensionAPI,
	params: ReplSendParams,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	metadata: { requestId: string; label: string; mode: "raw" | "literate" | "agent" },
): Promise<{ output: string; details: ReplSendDetails }> {
	const target = normalizeReplSendTarget(params.target) ?? "python";
	const sessionName = getSessionNameForSelector(target);
	const submissionId = `pi-repl:${metadata.requestId}`;
	const sessionInfo = await readSessionInfo(pi, sessionName, ctx.cwd);
	if (!sessionInfo?.recordId || !sessionInfo.recordPath || sessionInfo.recordWarning) {
		const execution = await runReplCode(pi, params, ctx, signal, { submissionId });
		return {
			...execution,
			details: {
				...execution.details,
				recordWarning: sessionInfo?.recordWarning || "The tmux session has no compatible clean-record metadata; execution was not synchronized.",
			},
		};
	}

	const runtime: ImplementedRuntime = target === "python" ? normalizePythonRuntime(sessionInfo) : target;
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
				id: submissionId,
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
			const execution = await runReplCode(pi, params, ctx, signal, {
				expectedSession: identity,
				expectedRecordId: sessionInfo.recordId,
				submissionId,
				onSubmissionStarted: (state) => {
					submissionStateRef.current = state;
				},
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
			retainReplSubmissionUntilSettled(pi, submissionState, lease);
		} else {
			cleanupPrivateReplControlFiles(submissionState?.prepared.controlPaths);
			cleanupPrivateReplControlFiles(submissionState?.prepared.guardPaths);
			cleanupPrivateReplControlFiles(submissionState?.prepared.driverPaths);
			await lease.release().catch(() => undefined);
		}
	}
}

export function formatReplSendResult(output: string, details: ReplSendDetails): { text: string; details: ReplSendDetails } {
	const fullText = [
		"Submitted code:",
		details.submittedCode.trimEnd(),
		"",
		"Output:",
		output.trim() ? output : "(no output)",
		...(details.recordWarning ? ["", `Shared record warning: ${details.recordWarning}`] : []),
	].join("\n");
	const initial = truncateHead(fullText, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!initial.truncated) return { text: fullText, details };

	// Bound the entire response, including submitted source, not just output.
	// Reserve room for the truncation notice and keep the complete response private.
	const tempDir = mkdtempSync(join(tmpdir(), "pi-repl-output-"));
	const tempFile = join(tempDir, "submission.txt");
	writeFileSync(tempFile, fullText, { encoding: "utf8", mode: 0o600, flag: "wx" });
	const notice = `\n\n[REPL response truncated. Full submitted code and output saved to: ${tempFile}]`;
	const truncation = truncateHead(fullText, {
		maxLines: DEFAULT_MAX_LINES - 3,
		maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(notice, "utf8"),
	});
	return {
		text: truncation.content + notice,
		details: { ...details, truncation, fullOutputPath: tempFile },
	};
}

async function executeReplSend(
	pi: ExtensionAPI,
	params: ReplSendParams,
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

async function startDefaultReplSession(
	pi: ExtensionAPI,
	cwd: string,
	requested: ManagedRuntime,
	timeoutMs = DEFAULT_STARTUP_WAIT_MS,
	signal?: AbortSignal,
) {
	const runtime: ImplementedRuntime = requested === "clj" ? "clojure" : requested;
	const target = toSessionSelector(runtime);
	const sessionName = getSessionNameForSelector(target);
	checkStartAborted(signal, sessionName);
	if (!(await commandExists(pi, "tmux", cwd))) {
		throw new Error("tmux was not found on PATH. pi-repl requires tmux.");
	}
	checkStartAborted(signal, sessionName);
	const exists = await tmuxSessionExists(pi, sessionName, cwd);
	checkStartAborted(signal, sessionName);
	const shellLaunch = buildDefaultShellRuntimeCommand(runtime, cwd);
	let created = false;
	let sessionTarget = sessionName;
	const warnings: string[] = [];
	if (!exists) {
		// tmux atomically creates the name. Do not use -A, respawn or kill: a
		// concurrent winner must be reused without rewriting its metadata/log.
		const gnuplotOwner = runtime === "gnuplot" ? randomUUID().replace(/-/g, "") : undefined;
		const result = await execTmux(pi, [
			"new-session", "-d", "-P", "-F", "#{session_id}", "-s", sessionName, "-c", cwd,
			...(gnuplotOwner ? ["-e", `${GNUPLOT_OWNER_ENV}=${gnuplotOwner}`] : []), shellLaunch.command,
		], cwd, 10_000);
		if (result.code !== 0) {
			if (!(await tmuxSessionExists(pi, sessionName, cwd))) {
				const reason = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
				throw new Error(`Failed to create tmux session ${sessionName}: ${reason}`);
			}
		} else {
			created = true;
			sessionTarget = result.stdout.trim();
			if (!/^\$\d+$/.test(sessionTarget)) throw new Error(`Could not identify newly created session ${sessionName}; inspect it with repl_status. It has not been stopped.`);
			// Finish initial metadata even if the caller cancels during creation.
			// Pin the returned ID so an external same-name replacement is untouched.
			if (gnuplotOwner && !(await setTmuxSessionOption(pi, sessionTarget, GNUPLOT_OWNER_OPTION, gnuplotOwner, cwd))) {
				warnings.push("Could not record gnuplot helper ownership; detached graphics cleanup cannot be verified.");
			}
			if (!(await setTmuxSessionOption(pi, sessionTarget, REPL_RUNTIME_OPTION, runtime, cwd))) {
				warnings.push(`Could not record the runtime for ${sessionName}.`);
			}
			const history = await enableSessionHistoryLogging(pi, sessionName, cwd, sessionTarget);
			if (history.warning) warnings.push(history.warning);
		}
	}
	const { info, ready } = await waitForReplSessionInfo(pi, cwd, sessionTarget, sessionName, runtime, timeoutMs, signal);
	if (!ready) warnings.push(`No normal prompt was confirmed within ${timeoutMs}ms. The session is left running; it may be busy, awaiting input, or using a custom prompt. Inspect it before sending code.`);
	if (info.runtime && info.runtime !== runtime) warnings.push(`Requested ${runtime}, but the existing session reports ${info.runtime}. Its interpreter and state were preserved.`);
	const text = [
		created
			? `Started default ${getSessionDisplayName(target)} REPL session: ${sessionName}`
			: `Default ${getSessionDisplayName(target)} REPL session is already running; reused without restarting (requested: ${runtime}).`,
		...(created ? [
			`Launch method: ${shellLaunch.shell} -i -l -c '${buildRuntimeLaunchCommand(runtime)}' inside tmux.`,
			...(target === "python" ? ["This respects your normal shell-level Python setup (aliases, pyenv/virtualenv/conda activation, shell init, etc.)."] : []),
			...(target === "clojure" ? ["`clojure` is used without rlwrap; `/repl clj` remains an alias."] : []),
			...(target === "gnuplot" ? ["An inherited ownership marker identifies this session's interpreter and Qt helpers during explicit stop; plotting settings are unchanged."] : []),
		] : []),
		ready ? "Readiness: normal prompt observed (snapshot only, not a reservation)." : "Readiness: unconfirmed.",
		...warnings.map((warning) => `Warning: ${warning}`),
		"",
		formatSessionInfo(info),
	].join("\n");
	return {
		text,
		details: {
			requestedRuntime: runtime,
			runtime: info.runtime,
			target,
			sessionName: info.sessionName,
			created,
			reused: !created,
			ready,
			timeoutMs,
			attachCommand: formatAttachCommand(info.sessionName),
			warnings,
			session: buildReplStatusDetails([{ selector: target, info }])[target],
		},
	};
}

async function startReplCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, runtime: ManagedRuntime): Promise<void> {
	try {
		const result = await startDefaultReplSession(pi, ctx.cwd, runtime);
		notify(ctx, result.text, result.details.warnings.length ? "warning" : "info");
	} catch (error) {
		notify(ctx, error instanceof Error ? error.message : String(error), "error");
	}
}

function formatNoSessionRunning(selector: SessionSelector): string {
	if (selector === "octave" || selector === "matlab" || selector === "gnuplot") return `No default ${getSessionDisplayName(selector)} REPL session is running (${getSessionNameForSelector(selector)}).\nStart one with /repl ${selector} or /lab ${selector}.`;
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
	const additionalRuntimeDetails = Object.fromEntries((["octave", "matlab", "gnuplot"] as const).map((selector) => {
		const info = sessions.find((session) => session.selector === selector)?.info;
		return [selector, {
			running: Boolean(info), sessionName: info?.sessionName ?? getSessionNameForSelector(selector),
			runtime: info?.runtime, recordId: info?.recordId, recordPath: info?.recordPath,
			recordEntryCount: info?.recordEntryCount ?? 0, recordEntries: info?.recordTail ?? [],
			recordWarning: info?.recordWarning, historyPath: info?.historyPath, historyLogging: Boolean(info?.historyPath),
			currentCommand: info?.currentCommand, currentPath: info?.currentPath,
			attachCommand: formatAttachCommand(getSessionNameForSelector(selector)),
		}];
	}));

	return {
		...additionalRuntimeDetails,
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
		ruby: {
			running: Boolean(ruby),
			sessionName: ruby?.sessionName ?? DEFAULT_RUBY_SESSION,
			runtime: ruby?.runtime ?? undefined,
			recordId: ruby?.recordId ?? undefined,
			recordPath: ruby?.recordPath ?? undefined,
			recordEntryCount: ruby?.recordEntryCount ?? 0,
			recordEntries: ruby?.recordTail ?? [],
			recordWarning: ruby?.recordWarning ?? undefined,
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
			recordId: java?.recordId ?? undefined,
			recordPath: java?.recordPath ?? undefined,
			recordEntryCount: java?.recordEntryCount ?? 0,
			recordEntries: java?.recordTail ?? [],
			recordWarning: java?.recordWarning ?? undefined,
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
		notify(ctx, `No shared REPL sessions are running. Start one with /repl followed by ${REPL_START_RUNTIMES.join(", ")}.`, "info");
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
			notify(ctx, `No shared REPL sessions are running. Start one with /repl followed by ${REPL_START_RUNTIMES.join(", ")}.`, "info");
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
					"/repl stop octave",
					"/repl stop matlab",
					"/repl stop gnuplot",
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

	try {
		const result = await stopVerifiedReplSession({
			tmux: (args: string[]) => execTmux(pi, args, ctx.cwd, 3_000),
			sessionName,
		});
		const escalated = result.signals.length ? ` Cleaned up ${new Set(result.signals.map((entry) => entry.pid)).size} surviving process(es).` : "";
		const warnings = result.warnings ?? [];
		notify(ctx, `Stopped default ${getSessionDisplayName(selector)} REPL session: ${sessionName}. Verified owned runtime processes exited.${escalated}${warnings.length ? "\n" + warnings.join("\n") : ""}`, warnings.length ? "warning" : "info");
	} catch (error) {
		notify(ctx, `Could not fully stop ${sessionName}: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function attachReplSession(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	selector?: SessionSelector,
): Promise<void> {
	if (!selector) {
		const running = await listRunningSharedSessions(pi, ctx.cwd);
		if (running.length === 0) {
			notify(ctx, `No shared REPL sessions are running. Start one with /repl followed by ${REPL_START_RUNTIMES.join(", ")}.`, "info");
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
					"Choose one with /repl export python, julia, r, ghci, clojure, ruby, java, octave, matlab, or gnuplot.",
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

	if (parsed.action === "echo") {
		if (parsed.mode) replSubmissionEchoMode = parsed.mode;
		const privacyNote = replSubmissionEchoMode === "full"
			? " Full mode writes bounded submitted source code into persistent raw terminal history."
			: "";
		notify(
			ctx,
			`REPL submission echo: ${replSubmissionEchoMode}. Use /repl echo off|summary|full to change it for this Pi process; set PI_REPL_ECHO_MODE to choose the startup default.${privacyNote}`,
			replSubmissionEchoMode === "full" ? "warning" : "info",
		);
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

				await startReplCommand(pi, ctx, parsed.runtime);
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

				await startReplCommand(pi, ctx, parsed.runtime);
				return;
			}

			if (parsed.runtime === "r") {
				if (parsed.name) {
					notify(ctx, "Named R sessions are not implemented yet. For now, use /repl R or /repl r with no --name.", "warning");
					return;
				}

				await startReplCommand(pi, ctx, parsed.runtime);
				return;
			}

			if (parsed.runtime === "ghci") {
				if (parsed.name) {
					notify(ctx, "Named GHCi sessions are not implemented yet. For now, use /repl ghci with no --name.", "warning");
					return;
				}

				await startReplCommand(pi, ctx, parsed.runtime);
				return;
			}

			if (isClojureRuntime(parsed.runtime)) {
				if (parsed.name) {
					notify(ctx, "Named Clojure sessions are not implemented yet. For now, use /repl clojure or /repl clj with no --name.", "warning");
					return;
				}

				await startReplCommand(pi, ctx, parsed.runtime);
				return;
			}

			if (parsed.runtime === "ruby") {
				if (parsed.name) {
					notify(ctx, "Named Ruby sessions are not implemented yet. For now, use /repl ruby with no --name.", "warning");
					return;
				}

				await startReplCommand(pi, ctx, parsed.runtime);
				return;
			}

			if (parsed.runtime === "java") {
				if (parsed.name) {
					notify(ctx, "Named Java sessions are not implemented yet. For now, use /repl java with no --name.", "warning");
					return;
				}

				await startReplCommand(pi, ctx, parsed.runtime);
				return;
			}

			if (parsed.runtime === "octave" || parsed.runtime === "matlab" || parsed.runtime === "gnuplot") {
				if (parsed.name) {
					notify(ctx, `Named ${getSessionDisplayName(parsed.runtime)} sessions are not implemented yet. For now, use /repl ${parsed.runtime} with no --name.`, "warning");
					return;
				}
				await startReplCommand(pi, ctx, parsed.runtime);
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
					"Only Python, IPython, Julia, R, GHCi, Clojure, Ruby, Java, Octave, MATLAB, and gnuplot session management are implemented so far.",
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
		name: "repl_start",
		label: "REPL Start",
		description: `Start or reuse a shared tmux REPL with an explicit runtime. Never resets existing sessions, switches interpreters, or sends probe code. Waits for a normal prompt and returns created/reused, ready, session status and attach instructions. Readiness timeout leaves the session running with ready=false. Response text is bounded to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Start a shared REPL, or reuse it without resetting its state, and wait for a normal prompt.",
		promptGuidelines: [
			"Use repl_start when the user wants to start a shared REPL, choosing runtime explicitly. It uses the same startup path as /repl and /lab; Python and IPython share one session and an existing interpreter is never switched.",
			"Check repl_start's ready result before repl_send. ready=false means inspect the pane or repl_status first; do not reset, interrupt, or send input to force readiness. A detected prompt is a snapshot, not a reservation against direct terminal input.",
			"repl_start leaves sessions running after readiness timeout or cancellation. Stopping or restarting remains an explicit user action; repl_send never auto-starts sessions.",
		],
		parameters: REPL_START_PARAMS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!REPL_START_RUNTIMES.includes(params.runtime)) throw new Error(`repl_start requires an explicit supported runtime: ${REPL_START_RUNTIMES.join(", ")}.`);
			const timeoutMs = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
				? Math.max(1_000, Math.min(MAX_STARTUP_WAIT_MS, Math.round(params.timeoutMs))) : DEFAULT_STARTUP_WAIT_MS;
			const result = await startDefaultReplSession(pi, ctx.cwd, params.runtime, timeoutMs, signal);
			const truncation = truncateHead(result.text, { maxLines: DEFAULT_MAX_LINES - 2, maxBytes: DEFAULT_MAX_BYTES - 256 });
			return {
				content: [{ type: "text", text: truncation.content + (truncation.truncated ? "\n\n[Status text truncated; inspect repl_status or the session's raw history for more context.]" : "") }],
				details: { ...result.details, ...(truncation.truncated ? { truncation } : {}) },
			};
		},
	});

	pi.registerTool({
		name: "repl_status",
		label: "REPL Status",
		description: "Inspect shared REPL session state for Python/IPython, Julia, R, Haskell (GHCi), Clojure, Ruby, Java, Octave, MATLAB, and gnuplot.",
		promptSnippet: "Check whether the shared Python/IPython, Julia, R, Haskell (GHCi), Clojure, Ruby, Java, Octave, MATLAB, and gnuplot REPL sessions are running.",
		promptGuidelines: [
			"Use repl_status before claiming whether a shared REPL is running, especially after a previous failure or status change.",
			"For Octave use repl_status target='octave'; for MATLAB use target='matlab'; for gnuplot use target='gnuplot'. They use separate shared sessions.",
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
				else if (targetRaw === "octave" || targetRaw === "matlab" || targetRaw === "gnuplot") target = targetRaw;
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
		description: `Execute code in the shared default Python/IPython, Julia, R, Haskell (GHCi), Clojure, Ruby, Java, Octave, MATLAB, or gnuplot tmux REPL sessions (${DEFAULT_PYTHON_SESSION}, ${DEFAULT_JULIA_SESSION}, ${DEFAULT_R_SESSION}, ${DEFAULT_GHCI_SESSION}, ${DEFAULT_CLOJURE_SESSION}, ${DEFAULT_RUBY_SESSION}, ${DEFAULT_JAVA_SESSION}, ${DEFAULT_OCTAVE_SESSION}, ${DEFAULT_MATLAB_SESSION}, ${DEFAULT_GNUPLOT_SESSION}). The complete response (submitted code and output) is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first); the full response is saved privately when truncated.`,
		promptSnippet: "Execute a small snippet in the shared Python/IPython, Julia, R, Haskell (GHCi), Clojure, Ruby, Java, Octave, MATLAB, or gnuplot REPL and return its output.",
		promptGuidelines: [
			"Use repl_send only after the relevant session has been started with repl_start, /repl, or /lab and is at a normal prompt. repl_send never auto-starts a missing session.",
			"If the user asks to run code in Julia or in the shared Julia REPL, use target='julia'. If they ask to run code in R or in the shared R REPL, use target='r'. If they ask to run code in GHCi, Haskell, or the shared Haskell REPL, use target='ghci'. If they ask to run code in Clojure or in the shared Clojure REPL, use target='clojure'. If they ask to run code in Ruby or IRB or the shared Ruby REPL, use target='ruby'. If they ask to run code in Java or jshell or the shared Java REPL, use target='java'. For Octave use target='octave', for MATLAB use target='matlab', and for gnuplot use target='gnuplot'. Otherwise use the shared Python/IPython session.",
			"Use repl_status before claiming whether the shared REPL is active if there has been a prior failure or a possible state change.",
			"If you need context about prior direct REPL interaction, inspect repl_status details and read the session history file listed there.",
			"The session history file is raw tmux pane output, so expect prompts and echoed input as well as results.",
			"This is a shared long-lived session: inspect state before mutating it, and do not assume variables already exist.",
			"repl_send shows bounded submitted code and alignment anchors in the raw pane by default (Summary). Respect the current /repl echo setting; use echoMode='off' when the user asks for quiet output, and echoMode='full' only when explicitly requested.",
			"Keep snippets small. If you need a value back reliably, print it explicitly.",
			"In GHCi, use normal interactive syntax such as let-bindings or :{ ... :} blocks for multiline declarations.",
			"In Clojure, use normal interactive syntax such as let-bindings, def/defn, or do forms for multiline code.",
			"In Ruby, definitions persist in the active IRB workspace and are shared with direct terminal input. Use normal Ruby source, including string interpolation.",
			"In Java, use top-level JShell snippets: imports, variables, methods, classes, expressions, or statements. Use System.out.println(...) for visible values; /open does not echo expression results. Submit complete snippets; native /open may discard an unfinished fragment. JShell commands such as /reset and /exit change or end the live session.",
			"For Octave use repl_send target='octave'; for MATLAB use target='matlab'. They are separate runtimes: do not silently substitute one for the other. Send complete code; use disp or fprintf for explicit output. Code executes in the base workspace, with native semicolon and ans behaviour. MATLAB function definitions belong in .m files; run scripts or call functions from the current path. clear, clear all, exit and quit are deliberate state-changing actions. This does not control an existing MATLAB desktop session.",
			"For gnuplot use repl_send target='gnuplot'. This is its own persistent runtime, not another REPL's plotting backend. Send complete native scripts; use print for console results. Preserve the user's terminal, output, print destination and settings; export figures only when requested. reset and reset session deliberately change state. In a loaded script, exit/quit returns from that script; exit gnuplot ends the process. Avoid pause/input waits unless explicitly wanted.",
			"Avoid blocking interactive input() prompts or long-running code unless the user explicitly wants that.",
		],
		parameters: REPL_SEND_PARAMS,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			return executeReplSend(pi, params as ReplSendParams, ctx, signal, toolCallId);
		},
	});
}
