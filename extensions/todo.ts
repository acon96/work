/**
 * pi-todo extension.
 *
 * A simple persistent todo list exposed as a pi tool.
 *
 * Tool: todo
 *   action : "add" | "complete" | "delete" | "list"
 *   id     : number   (complete / delete)
 *   text   : string   (add)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── types ─────────────────────────────────────────────────────────────────────
interface TodoItem {
	id: number;
	text: string;
	done: boolean;
	created_at: number; // epoch ms
}

interface TodoState {
	items: TodoItem[];
}

const TODO_ENTRY_TYPE = "todo-state";

// ── module-level state ────────────────────────────────────────────────────────
let todos: TodoItem[] = [];
let nextId = 1;

// ── persistence ───────────────────────────────────────────────────────────────
function persist(pi: ExtensionAPI): void {
	pi.appendEntry<TodoState>(TODO_ENTRY_TYPE, { items: todos });
}

function restore(ctx: ExtensionContext): void {
	let lastSaved: TodoState | null = null;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== TODO_ENTRY_TYPE) continue;
		const data = entry.data as TodoState | undefined;
		if (Array.isArray(data?.items)) {
			lastSaved = data as TodoState;
		}
	}

	if (!lastSaved) return;

	todos = lastSaved.items;
	nextId = todos.reduce((max, item) => Math.max(max, item.id + 1), 1);
}

// ── rendering ─────────────────────────────────────────────────────────────────
function formatList(): object {
	if (todos.length === 0) return { result: "No todos." };
	return {
		result: todos.map((item) => ({
			id: item.id,
			status: item.done ? "done" : "pending",
			text: item.text,
			created_at: new Date(item.created_at).toISOString(),
		})),
	};
}

// ── extension export ──────────────────────────────────────────────────────────
export default function todoExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		restore(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restore(ctx);
	});

	pi.registerTool("todo", {
		description:
			"Manage a persistent todo list. " +
			"Actions: add (text required), complete (id required), delete (id required), list.",
		parameters: {
			type: "object",
			required: ["action"],
			properties: {
				action: {
					type: "string",
					enum: ["add", "complete", "delete", "list"],
					description: "Operation to perform.",
				},
				text: {
					type: "string",
					description: "Todo text (required for add).",
				},
				id: {
					type: "number",
					description: "Todo id (required for complete / delete).",
				},
			},
		},
		handler: async (input: Record<string, unknown>) => {
			const action = String(input.action ?? "");

			if (action === "list") {
				return formatList();
			}

			if (action === "add") {
				const text = String(input.text ?? "").trim();
				if (!text) return { error: "text is required." };
				const item: TodoItem = { id: nextId++, text, done: false, created_at: Date.now() };
				todos.push(item);
				persist(pi);
				return { result: `Added todo #${item.id}: ${item.text}` };
			}

			if (action === "complete") {
				const id = Number(input.id);
				const item = todos.find((t) => t.id === id);
				if (!item) return { error: `No todo with id ${id}.` };
				item.done = true;
				persist(pi);
				return { result: `Marked todo #${id} as done.` };
			}

			if (action === "delete") {
				const id = Number(input.id);
				const before = todos.length;
				todos = todos.filter((t) => t.id !== id);
				if (todos.length === before) return { error: `No todo with id ${id}.` };
				persist(pi);
				return { result: `Deleted todo #${id}.` };
			}

			return { error: `Unknown action '${action}'. Use: add, complete, delete, list.` };
		},
	});
}
