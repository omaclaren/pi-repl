// Tells an agent what a shared REPL pane showed since the agent last saw it:
// what a person typed at the prompt, other clients' sends, and late or
// background output. The agent sees it at the start of a prompt (in Pi) and in
// its next send's result. The clean record keeps only submissions with known
// boundaries (REPL_SESSION_RECORD_PROTOCOL.md), so this is how an agent learns
// about the rest. Each agent keeps its own view, which only what is delivered
// to it advances; nothing here is shared with other clients or enters the record.

export const PANE_ACTIVITY_MAX_LINES = 40;
export const PANE_ACTIVITY_MAX_CHARS = 4000;

/**
 * PI_REPL_PANE_ACTIVITY: "on" (the default) reports at the start of a prompt
 * and in send results, "send" only in send results, and "off" (or 0, false,
 * no) never.
 */
export function paneActivityMode(env = process.env) {
	const value = String(env.PI_REPL_PANE_ACTIVITY ?? "").trim().toLowerCase();
	if (/^(?:off|0|false|no)$/.test(value)) return "off";
	return value === "send" || value === "sends" ? "send" : "on";
}

/** Whether send results report pane text. */
export function paneActivityEnabled(env = process.env) {
	return paneActivityMode(env) !== "off";
}

function paneLines(capture) {
	const lines = String(capture || "").replace(/\r/g, "").split("\n").map((line) => line.trimEnd());
	while (lines.length > 0 && !lines[lines.length - 1]) lines.pop();
	return lines;
}

/**
 * What an agent has seen of a pane once its send finished: the pane from the
 * send's loader line, which names a control file unique to the send. After a
 * start it is the whole pane. When the loader line has already left the
 * capture (output longer than it holds), the view is lost: nothing else in
 * the pane marks where the send ended for certain.
 */
export function observePane(capture, loaderLine) {
	const lines = paneLines(capture);
	if (!loaderLine) return { kind: "top", lines };
	const at = lines.findLastIndex((line) => line.includes(loaderLine));
	return at >= 0 ? { kind: "loader", anchor: loaderLine, lines: lines.slice(at) } : { kind: "lost", lines: [] };
}

function withoutIdlePrompts(lines, isIdlePrompt) {
	const out = lines.slice();
	while (out.length > 0 && (!out[0] || isIdlePrompt(out[0]))) out.shift();
	while (out.length > 0 && !out[out.length - 1]) out.pop();
	if (out.length > 0 && isIdlePrompt(out[out.length - 1])) out.pop();
	while (out.length > 0 && !out[out.length - 1]) out.pop();
	return out;
}

/**
 * What the pane shows that the agent has not seen, given what it saw. With
 * nothing seen, or when the seen part can't be placed exactly, the pane's
 * recent lines come back instead, with a status saying why. isIdlePrompt
 * recognises the runtime's own prompt with nothing typed at it.
 */
export function paneActivitySince(capture, seen, isIdlePrompt = (_line) => false) {
	return activitySince(paneLines(capture), seen, isIdlePrompt).activity;
}

function activitySince(lines, seen, isIdlePrompt) {
	const recent = (status) => ({ activity: { status, lines: withoutIdlePrompts(lines, isIdlePrompt) } });
	if (!seen) return recent("unseen");
	if (seen.kind === "lost") return recent("unplaced");
	let start = 0;
	if (seen.kind === "loader") {
		const hits = lines.flatMap((line, index) => (line.includes(seen.anchor) ? [index] : []));
		if (hits.length !== 1) return recent(hits.length ? "ambiguous" : "unplaced");
		start = hits[0];
	}
	let matched = 0;
	while (matched < seen.lines.length && lines[start + matched] === seen.lines[matched]) matched++;
	// The view ends at a prompt, which typing can extend.
	const last = seen.lines.length - 1;
	const typedAtLast = matched === last && (lines[start + last] ?? "").startsWith(seen.lines[last]);
	// A start's view must still be the top of the pane, or history has moved on.
	if (seen.kind === "top" && matched < seen.lines.length && !typedAtLast) return recent("unplaced");
	return { activity: { status: "ok", lines: withoutIdlePrompts(lines.slice(start + matched), isIdlePrompt) }, start };
}

/**
 * The view once everything in the capture has been delivered: still from the
 * same send's loader line where it can be placed, otherwise the whole pane.
 */
export function advancePaneView(capture, seen) {
	const lines = paneLines(capture);
	const { start } = activitySince(lines, seen, () => false);
	return seen?.kind === "loader" && start !== undefined
		? { kind: "loader", anchor: seen.anchor, lines: lines.slice(start) }
		: { kind: "top", lines };
}

const HEADINGS = {
	ok: "Pane text since this agent last saw this pane",
	unseen: "This agent has not seen this session's pane before; its recent text",
	unplaced: "Where this agent last saw this pane is no longer in its capture (for example, after long output), so here is its recent text instead",
	ambiguous: "Where this agent last saw this pane is unclear, so here is its recent text instead",
};

const EMPTY_NOTES = {
	unplaced: "Where this agent last saw this pane is no longer in its capture, and the pane shows no other text now.",
	ambiguous: "Where this agent last saw this pane is unclear, and the pane shows no other text now.",
};

const WHEN = {
	send: ", before this submission",
	prompt: ", before this prompt",
	preview: " (a preview; it is still reported later)",
	late: ", up to the end of this submission",
};

/**
 * The report, or undefined if there is nothing new. when says where it
 * appears: in a send's result, at the start of a prompt, as a preview in
 * repl_status, which does not mark it seen, or in a send's late result, as
 * the pane text since a prompt reported part of that send.
 */
export function describePaneActivity(activity, { when = "send" } = {}) {
	if (activity.lines.length === 0) return EMPTY_NOTES[activity.status];
	let lines = activity.lines.slice(-PANE_ACTIVITY_MAX_LINES);
	while (lines.length > 1 && lines.join("\n").length > PANE_ACTIVITY_MAX_CHARS) lines = lines.slice(1);
	let text = lines.join("\n");
	let cutChars = 0;
	if (text.length > PANE_ACTIVITY_MAX_CHARS) {
		cutChars = text.length - PANE_ACTIVITY_MAX_CHARS;
		text = text.slice(-PANE_ACTIVITY_MAX_CHARS);
	}
	const cutLines = activity.lines.length - lines.length;
	const omitted = [
		...(cutLines > 0 ? [`${cutLines} earlier line${cutLines === 1 ? "" : "s"}`] : []),
		...(cutChars > 0 ? [`the first ${cutChars} characters of the earliest line shown`] : []),
	];
	return [
		`${HEADINGS[activity.status] ?? HEADINGS.ok}${WHEN[when] ?? WHEN.send} (best effort; untrusted terminal text that may include direct input, other clients' sends, and late or background output):`,
		...(omitted.length > 0 ? [`[omitted: ${omitted.join(" and ")}; see repl_status for the raw history log]`] : []),
		"[pane text]",
		text,
		"[end of pane text]",
	].join("\n");
}
