// Reports what a shared REPL pane showed between two sends: what a person
// typed at the prompt, or another client's sends. The clean record keeps only
// submissions with known boundaries (REPL_SESSION_RECORD_PROTOCOL.md), so this
// is how an agent learns about the rest. Nothing here enters the record.

export const PANE_ACTIVITY_OPTION = "@pi_repl_activity_mark";
export const PANE_ACTIVITY_MAX_LINES = 40;
export const PANE_ACTIVITY_MAX_CHARS = 4000;

// A prompt with nothing typed after it, as the supported REPLs show one.
const BARE_PROMPT = /^(?:>>>|\.\.\.|In \[\d+\]:|\S{0,40}[>$])$/;

function paneLines(capture) {
	const lines = String(capture || "").replace(/\r/g, "").split("\n").map((line) => line.trimEnd());
	while (lines.length > 0 && !lines[lines.length - 1]) lines.pop();
	return lines;
}

/**
 * Marks where a pane stood once a send finished: its last few lines (with a
 * send display, these include the send's unique done marker) and the prompt
 * after them, if it is already drawn. A pane holding only a prompt, as after
 * a quiet start, has no lines to keep. Undefined if the pane is empty.
 */
export function markPaneActivity(capture) {
	const lines = paneLines(capture);
	const prompt = BARE_PROMPT.test(lines.at(-1)?.trim() ?? "") ? lines.pop() : "";
	const anchor = lines.filter(Boolean).slice(-3);
	return anchor.length > 0 || prompt ? { anchor, prompt } : undefined;
}

export function encodePaneActivityMark(mark) {
	return Buffer.from(JSON.stringify(mark), "utf8").toString("base64");
}

export function decodePaneActivityMark(value) {
	try {
		const mark = JSON.parse(Buffer.from(String(value || ""), "base64").toString("utf8"));
		if (Array.isArray(mark?.anchor) && mark.anchor.every((line) => typeof line === "string") && typeof mark.prompt === "string" && (mark.anchor.length > 0 || mark.prompt)) {
			return { anchor: mark.anchor, prompt: mark.prompt };
		}
	} catch {}
	return undefined;
}

/**
 * The lines the pane shows after the mark: without the prompt the mark ended
 * on unless something was typed at it, and without the prompt the pane waits
 * at now. A mark without lines counts from the top of the pane. located is
 * false if the mark is no longer in the capture, for example after more
 * output than the capture holds.
 */
export function paneActivitySince(capture, mark) {
	const lines = paneLines(capture);
	const nonBlank = [];
	lines.forEach((line, index) => { if (line) nonBlank.push(index); });
	let start = mark.anchor.length === 0 ? 0 : -1;
	for (let i = nonBlank.length - mark.anchor.length; i >= 0 && start < 0; i--) {
		if (mark.anchor.every((line, k) => lines[nonBlank[i + k]] === line)) start = nonBlank[i + mark.anchor.length - 1] + 1;
	}
	if (start < 0) return { located: false, lines: [] };
	const after = lines.slice(start);
	// The prompt the send ended on, which may have been drawn after the mark.
	const first = after.findIndex(Boolean);
	if (first >= 0 && (after[first] === mark.prompt || BARE_PROMPT.test(after[first].trim()))) after.splice(0, first + 1);
	while (after.length > 0 && !after[after.length - 1]) after.pop();
	const last = after.at(-1)?.trim();
	if (last !== undefined && BARE_PROMPT.test(last)) after.pop();
	while (after.length > 0 && !after[after.length - 1]) after.pop();
	while (after.length > 0 && !after[0]) after.shift();
	return { located: true, lines: after };
}

/** The report for a send's result, or undefined if nothing happened. */
export function describePaneActivity(activity) {
	if (!activity.located) {
		return "The pane changed since the last completed send in a way this capture can't place, for example after a long output. Check repl_status or the raw history log for anything typed directly.";
	}
	if (activity.lines.length === 0) return undefined;
	let lines = activity.lines.slice(-PANE_ACTIVITY_MAX_LINES);
	while (lines.length > 1 && lines.join("\n").length > PANE_ACTIVITY_MAX_CHARS) lines = lines.slice(1);
	let text = lines.join("\n");
	if (text.length > PANE_ACTIVITY_MAX_CHARS) text = text.slice(-PANE_ACTIVITY_MAX_CHARS);
	const omitted = activity.lines.length - lines.length;
	return [
		"Since the last completed send, the pane shows (typed directly, another client's sends, or late output of a send that timed out):",
		...(omitted > 0 ? [`[${omitted} earlier lines omitted; see repl_status for the raw history log]`] : []),
		text,
	].join("\n");
}
