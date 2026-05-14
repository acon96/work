/**
 * pi-watch extension.
 *
 * Provides a `watch` tool that polls a shell command on an interval and
 * delivers a follow-up message to the user when a stop condition fires.
 *
 * Tool schema:
 *   action      : "create" | "list" | "cancel"
 *   name        : string                        (create / cancel)
 *   command     : string                        (create)
 *   poll_every  : number  — seconds, 30–86400   (create)
 *   stop_on     : string  — JS expression       (create, optional)
 *
 * The stop_on expression is evaluated with the following context variables:
 *   output      : string  — current stdout+stderr (truncated at 64 KB)
 *   exit_code   : number  — process exit code
 *   prev_output : string  — output from the previous poll
 *   changed     : boolean — output !== prev_output
 *
 * If stop_on is omitted the watch fires once on the first poll.
 * After firing the watch auto-cancels.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── constants ─────────────────────────────────────────────────────────────────
const MAX_ACTIVE_WATCHES = 5;
const MIN_POLL_SECONDS = 30;
const MAX_POLL_SECONDS = 86_400; // 24 h
const MAX_OUTPUT_BYTES = 64 * 1024;
const WATCH_STATE_ENTRY_TYPE = "watch-state";

// ── types ─────────────────────────────────────────────────────────────────────
interface WatchDefinition {
	name: string;
	command: string;
	poll_every: number; // seconds
	stop_on: string | null;
	created_at: number; // epoch ms
}

interface WatchRecord {
	definition: WatchDefinition;
	timer: ReturnType<typeof setInterval> | null;
	prev_output: string;
}

// ── module-level state ────────────────────────────────────────────────────────
// Keyed by watch name.
const watches = new Map<string, WatchRecord>();

// ── helpers ───────────────────────────────────────────────────────────────────
function truncate(s: string): string {
	const buf = Buffer.from(s, "utf8");
	if (buf.byteLength <= MAX_OUTPUT_BYTES) return s;
	return buf.subarray(0, MAX_OUTPUT_BYTES).toString("utf8") + "\n[output truncated]";
}

/**
 * Evaluate a stop_on expression against the poll context.
 * Uses Function constructor so expressions can reference the context vars
 * directly.  Errors in the expression are treated as false (watch continues).
 */
function evalStopOn(
	expression: string,
	ctx: { output: string; exit_code: number; prev_output: string; changed: boolean },
): boolean {
	try {
		// Build an isolated function: no `this`, all context vars in scope.
		const fn = new Function(
			"output",
			"exit_code",
			"prev_output",
			"changed",
			`"use strict"; return !!(${expression});`,
		);
		return Boolean(fn(ctx.output, ctx.exit_code, ctx.prev_output, ctx.changed));
	} catch {
		return false;
	}
}

function cancelWatch(name: string): boolean {
	const record = watches.get(name);
	if (!record) return false;
	if (record.timer !== null) {
		clearInterval(record.timer);
	}
	watches.delete(name);
	return true;
}

function persistWatches(pi: ExtensionAPI): void {
	const definitions = Array.from(watches.values()).map((r) => r.definition);
	pi.appendEntry<WatchDefinition[]>(WATCH_STATE_ENTRY_TYPE, definitions);
}

// ── poll logic ────────────────────────────────────────────────────────────────
async function runPoll(pi: ExtensionAPI, name: string): Promise<void> {
	const record = watches.get(name);
	if (!record) return;

	const { definition, prev_output } = record;
	let output = "";
	let exit_code = 0;

	try {
		const result = await pi.exec("bash", ["-c", definition.command]);
		output = truncate(result.stdout ?? "");
		exit_code = result.code ?? 0;
	} catch (err) {
		output = String(err);
		exit_code = 1;
	}

	const changed = output !== prev_output;

	// Update stored prev_output.
	record.prev_output = output;

	// Evaluate stop condition.
	const shouldFire =
		definition.stop_on === null ||
		evalStopOn(definition.stop_on, { output, exit_code, prev_output, changed });

	if (shouldFire) {
		cancelWatch(name);
		persistWatches(pi);

		const message =
			`**Watch \`${name}\` fired**\n` +
			`Command: \`${definition.command}\`\n\n` +
			`Exit code: ${exit_code}\n\n` +
			"```\n" +
			output +
			"\n```";

		pi.sendUserMessage(message, { deliverAs: "followUp" });
	}
}

function startTimer(pi: ExtensionAPI, record: WatchRecord): void {
	const { definition } = record;
	record.timer = setInterval(() => {
		void runPoll(pi, definition.name);
	}, definition.poll_every * 1_000);
}

// ── session restore ───────────────────────────────────────────────────────────
function restoreWatches(pi: ExtensionAPI, ctx: ExtensionContext): void {
	// Clear any existing timers first (handles tree-switch scenarios).
	for (const [name] of watches) {
		cancelWatch(name);
	}

	let lastSaved: WatchDefinition[] | null = null;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== WATCH_STATE_ENTRY_TYPE) continue;
		if (Array.isArray(entry.data)) {
			lastSaved = entry.data as WatchDefinition[];
		}
	}

	if (!lastSaved || lastSaved.length === 0) return;

	for (const def of lastSaved) {
		const record: WatchRecord = { definition: def, timer: null, prev_output: "" };
		watches.set(def.name, record);
		startTimer(pi, record);
	}
}

// ── extension export ──────────────────────────────────────────────────────────
export default function watchExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		restoreWatches(pi, ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreWatches(pi, ctx);
	});

	pi.on("session_shutdown", async () => {
		for (const [name] of [...watches]) {
			cancelWatch(name);
		}
	});

	pi.registerTool("watch", {
		description:
			"Monitor a shell command on a polling interval. " +
			"Actions: create, list, cancel. " +
			"On create provide: name (string), command (string), poll_every (seconds, 30–86400), " +
			"stop_on (optional JS expression over {output, exit_code, prev_output, changed}).",
		parameters: {
			type: "object",
			required: ["action"],
			properties: {
				action: {
					type: "string",
					enum: ["create", "list", "cancel"],
					description: "Operation to perform.",
				},
				name: {
					type: "string",
					description: "Unique name for the watch (required for create/cancel).",
				},
				command: {
					type: "string",
					description: "Shell command to run on each poll (required for create).",
				},
				poll_every: {
					type: "number",
					description: "Poll interval in seconds, 30–86400 (required for create).",
				},
				stop_on: {
					type: "string",
					description:
						"JS boolean expression evaluated with {output, exit_code, prev_output, changed}. " +
						"Omit to fire on the very first poll.",
				},
			},
		},
		handler: async (input: Record<string, unknown>) => {
			const action = String(input.action ?? "");

			// ── list ────────────────────────────────────────────────────────────
			if (action === "list") {
				if (watches.size === 0) {
					return { result: "No active watches." };
				}
				const rows = Array.from(watches.values()).map((r) => ({
					name: r.definition.name,
					command: r.definition.command,
					poll_every_s: r.definition.poll_every,
					stop_on: r.definition.stop_on ?? "(first poll)",
					created_at: new Date(r.definition.created_at).toISOString(),
				}));
				return { result: rows };
			}

			// ── cancel ──────────────────────────────────────────────────────────
			if (action === "cancel") {
				const name = String(input.name ?? "").trim();
				if (!name) return { error: "name is required for cancel." };
				const removed = cancelWatch(name);
				if (!removed) return { error: `No watch named '${name}'.` };
				persistWatches(pi);
				return { result: `Watch '${name}' cancelled.` };
			}

			// ── create ──────────────────────────────────────────────────────────
			if (action === "create") {
				const name = String(input.name ?? "").trim();
				const command = String(input.command ?? "").trim();
				const poll_every = Number(input.poll_every);
				const stop_on = input.stop_on != null ? String(input.stop_on).trim() : null;

				if (!name) return { error: "name is required." };
				if (!command) return { error: "command is required." };
				if (!Number.isFinite(poll_every) || poll_every < MIN_POLL_SECONDS || poll_every > MAX_POLL_SECONDS) {
					return { error: `poll_every must be between ${MIN_POLL_SECONDS} and ${MAX_POLL_SECONDS} seconds.` };
				}
				if (watches.has(name)) return { error: `A watch named '${name}' already exists.` };
				if (watches.size >= MAX_ACTIVE_WATCHES) {
					return { error: `Maximum of ${MAX_ACTIVE_WATCHES} active watches reached.` };
				}

				const definition: WatchDefinition = {
					name,
					command,
					poll_every,
					stop_on: stop_on || null,
					created_at: Date.now(),
				};

				const record: WatchRecord = { definition, timer: null, prev_output: "" };
				watches.set(name, record);
				startTimer(pi, record);
				persistWatches(pi);

				return {
					result: `Watch '${name}' created. Polling every ${poll_every}s.`,
				};
			}

			return { error: `Unknown action '${action}'. Use: create, list, cancel.` };
		},
	});
}
