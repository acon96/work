/**
 * pi-sudo-gate extension.
 *
 * Intercepts bash tool calls that contain sudo. Commands must be present
 * in /config/sudo-allowlist.txt and then explicitly confirmed by the user.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFile } from "node:fs/promises";

const SUDO_PATTERN = /\bsudo\b/i;
const SUDO_ALLOWLIST_PATH = "/config/sudo-allowlist.txt";
const CONFIRM_TIMEOUT_MS = 30_000;

function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

function parseAllowlist(contents: string): Set<string> {
	const commands = contents
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.filter((line) => !line.startsWith("#"))
		.map((line) => normalizeCommand(line));

	return new Set(commands);
}

async function loadAllowlist(): Promise<Set<string>> {
	try {
		const contents = await readFile(SUDO_ALLOWLIST_PATH, "utf8");
		return parseAllowlist(contents);
	} catch {
		// Missing/unreadable allowlist means nothing is approved.
		return new Set<string>();
	}
}

export default function sudoGateExtension(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = typeof event.input.command === "string" ? event.input.command : "";
		if (!SUDO_PATTERN.test(command)) return undefined;

		const normalizedCommand = normalizeCommand(command);
		const allowlist = await loadAllowlist();

		if (!allowlist.has(normalizedCommand)) {
			return {
				block: true,
				reason: `Blocked: command not in sudo allowlist (${SUDO_ALLOWLIST_PATH})`,
			};
		}

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: "Blocked: sudo command requires UI confirmation",
			};
		}

		const confirmed = await ctx.ui.confirm(
			"Sudo Approval Required",
			`The agent requested a sudo command:\n\n${command}\n\nAllow this command?`,
			{ timeout: CONFIRM_TIMEOUT_MS },
		);

		if (!confirmed) {
			return {
				block: true,
				reason: "Blocked by user (or confirmation timed out)",
			};
		}

		return undefined;
	});
}