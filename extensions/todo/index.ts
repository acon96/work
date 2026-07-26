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
import { Type } from "typebox";

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
function formatListResult(): Array<{ id: number; status: string; text: string; created_at: string }> {
	if (todos.length === 0) return [];
	return todos.map((item) => ({
		id: item.id,
		status: item.done ? "done" : "pending",
		text: item.text,
		created_at: new Date(item.created_at).toISOString(),
	}));
}

// ── extension export ──────────────────────────────────────────────────────────
export default function todoExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		restore(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restore(ctx);
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a persistent todo list. " +
			"Actions: add (text required), complete (id required), delete (id required), list.",
		parameters: Type.Object({
			action: Type.String({ description: "Operation to perform." }),
			text: Type.Optional(Type.String({ description: "Todo text (required for add)." })),
			id: Type.Optional(Type.Number({ description: "Todo id (required for complete / delete)." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const action = params.action;

			if (action === "list") {
				const items = formatListResult();
				if (items.length === 0) {
					return { content: [{ type: "text", text: "No todos." }], details: {} };
				}
				return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }], details: {} };
			}

			if (action === "add") {
				const text = params.text?.trim();
				if (!text) {
					return { content: [{ type: "text", text: "Error: text is required." }], details: {} };
				}
				const item: TodoItem = { id: nextId++, text, done: false, created_at: Date.now() };
				todos.push(item);
				persist(pi);
				return { content: [{ type: "text", text: `Added todo #${item.id}: ${item.text}` }], details: {} };
			}

			if (action === "complete") {
				const id = params.id;
				if (id === undefined) {
					return { content: [{ type: "text", text: "Error: id is required." }], details: {} };
				}
				const item = todos.find((t) => t.id === id);
				if (!item) {
					return { content: [{ type: "text", text: `Error: No todo with id ${id}.` }], details: {} };
				}
				item.done = true;
				persist(pi);
				return { content: [{ type: "text", text: `Marked todo #${id} as done.` }], details: {} };
			}

			if (action === "delete") {
				const id = params.id;
				if (id === undefined) {
					return { content: [{ type: "text", text: "Error: id is required." }], details: {} };
				}
				const before = todos.length;
				todos = todos.filter((t) => t.id !== id);
				if (todos.length === before) {
					return { content: [{ type: "text", text: `Error: No todo with id ${id}.` }], details: {} };
				}
				persist(pi);
				return { content: [{ type: "text", text: `Deleted todo #${id}.` }], details: {} };
			}

			return { content: [{ type: "text", text: `Unknown action '${action}'. Use: add, complete, delete, list.` }], details: {} };
		},
	});
}
