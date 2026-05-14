/**
 * Tools extension.
 *
 * Adds command-driven runtime tool toggling for web UI integrations.
 * This extension avoids interactive UI prompts so clients can provide
 * native dropdown UX for quickly enabling/disabling tools.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface ToolConfigState {
	active: string[];
}

const TOOL_CONFIG_ENTRY_TYPE = "tool-config";
const TOOL_STATE_MESSAGE_TYPE = "tools_state";

function dedupe(values: string[]): string[] {
	return Array.from(new Set(values));
}

function restoreToolState(pi: ExtensionAPI, ctx: ExtensionContext): string[] {
	const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
	let lastSaved: string[] | undefined;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== TOOL_CONFIG_ENTRY_TYPE) continue;
		const data = entry.data as ToolConfigState | undefined;
		if (Array.isArray(data?.active)) {
			lastSaved = data.active;
		}
	}

	if (!lastSaved) {
		return pi.getActiveTools().filter((name) => allToolNames.has(name));
	}

	return dedupe(lastSaved).filter((name) => allToolNames.has(name));
}

function applyAndPersist(pi: ExtensionAPI, active: string[]) {
	const next = dedupe(active);
	pi.setActiveTools(next);
	pi.appendEntry<ToolConfigState>(TOOL_CONFIG_ENTRY_TYPE, { active: next });
}

function emitState(pi: ExtensionAPI) {
	pi.sendMessage({
		customType: TOOL_STATE_MESSAGE_TYPE,
		content: "",
		display: false,
		details: {
			allTools: pi.getAllTools().map((tool) => tool.name),
			activeTools: pi.getActiveTools(),
		},
	});
}

export default function toolsExtension(pi: ExtensionAPI) {
	let activeTools = new Set<string>();

	function reloadState(ctx: ExtensionContext) {
		activeTools = new Set(restoreToolState(pi, ctx));
		pi.setActiveTools(Array.from(activeTools));
		emitState(pi);
	}

	pi.on("session_start", async (_event, ctx) => {
		reloadState(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reloadState(ctx);
	});

	pi.registerCommand("tools", {
		description: "Tools control: /tools state | /tools toggle <name> | /tools set <name1,name2,...>",
		handler: async (args, ctx) => {
			const argv = String(args ?? "")
				.split(/\s+/)
				.map((token) => token.trim())
				.filter((token) => token.length > 0);
			const allTools = pi.getAllTools().map((tool) => tool.name);
			const allSet = new Set(allTools);

			const subcommand = (argv[0] ?? "state").toLowerCase();
			if (subcommand === "state") {
				emitState(pi);
				return;
			}

			if (subcommand === "toggle") {
				const toolName = argv[1];
				if (!toolName || !allSet.has(toolName)) {
					if (ctx.hasUI) {
						ctx.ui.notify(`Unknown tool: ${toolName ?? "(missing)"}`, "warning");
					}
					emitState(pi);
					return;
				}

				if (activeTools.has(toolName)) {
					activeTools.delete(toolName);
				} else {
					activeTools.add(toolName);
				}

				applyAndPersist(pi, Array.from(activeTools));
				emitState(pi);
				return;
			}

			if (subcommand === "set") {
				const raw = argv.slice(1).join(" ");
				const names = raw
					.split(/[\s,]+/)
					.map((name: string) => name.trim())
					.filter((name: string) => name.length > 0)
					.filter((name: string) => allSet.has(name));

				activeTools = new Set(dedupe(names));
				applyAndPersist(pi, Array.from(activeTools));
				emitState(pi);
				return;
			}

			if (ctx.hasUI) {
				ctx.ui.notify("Usage: /tools state | /tools toggle <name> | /tools set <name1,name2,...>", "warning");
			}
			emitState(pi);
		},
	});
}
