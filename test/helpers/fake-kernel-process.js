// The fake kernel as a process, started as `lfortran kernel -f FILE --managed`
// would be: it writes FILE (mode 0600) once it listens, removes it on SIGTERM,
// and exits with n for a cell `exit:<n>`. FAKE_KERNEL_EXIT=n exits at once;
// --ignore-term ignores SIGTERM. The connection file also names
// the owner marker the kernel inherited, as `owner`, for tests to check.
import { closeSync, constants, openSync, unlinkSync, writeSync } from "node:fs";
import { startFakeKernel } from "./fake-jupyter-kernel.js";

if (process.env.FAKE_KERNEL_EXIT) process.exit(Number(process.env.FAKE_KERNEL_EXIT));
const file = process.argv[process.argv.indexOf("-f") + 1];
let wrote = false;
const end = (code) => {
	if (wrote) try { unlinkSync(file); } catch {}
	process.exit(code);
};
const kernel = await startFakeKernel({ onExit: (code) => end(code) });
const { ports, key } = kernel;
const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
writeSync(fd, JSON.stringify({ transport: "tcp", ip: "127.0.0.1", shell_port: ports.shell, iopub_port: ports.iopub, stdin_port: ports.stdin, control_port: ports.control, hb_port: ports.hb, signature_scheme: "hmac-sha256", key, kernel_name: "fake", owner: process.env.PI_REPL_JUPYTER_OWNER ?? null }));
closeSync(fd);
wrote = true;
process.on("SIGTERM", () => { if (!process.argv.includes("--ignore-term")) end(0); });
