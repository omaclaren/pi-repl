// Writes the LFortran helper's entries in the session's shared clean record, in
// a thread of its own (repl-jupyter-helper.js's RecordWriter starts it). A write
// takes the record's lock, waiting for another writer if it must, and fsyncs:
// here that blocks only this thread, never the helper's protocol reader.
import { parentPort } from "node:worker_threads";
import { upsertReplSessionRecordEntry } from "./repl-session-record.js";

parentPort.on("message", ({ seq, recordId, identity, root, entry }) => {
	try {
		upsertReplSessionRecordEntry(recordId, identity, entry, { root, origin: "pi-repl" });
		parentPort.postMessage({ seq, ok: true });
	} catch (error) {
		parentPort.postMessage({ seq, ok: false, error: error instanceof Error ? error.message : String(error) });
	}
});
