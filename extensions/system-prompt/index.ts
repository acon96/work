/**
 * System prompt extension.
 *
 * Injects a system-prompt section describing the sandboxed operating
 * environment - how outbound access is enforced, what the domain allowlist
 * is, and what that means for tool use - so the agent knows what it can and
 * cannot do before it tries.
 *
 * Policy is enforced by two pi extensions, neither of which the agent can
 * change from inside a session:
 *   - pi-sandbox: wraps every Bash command in a bubblewrap sandbox with a
 *     baseline domain allowlist; anything else prompts the human once per
 *     connection (config at ~/.pi/agent/extensions/pi-sandbox/config.json,
 *     write-protected from sandboxed commands).
 *   - pi-permission-system: gates Pi's native file tools and out-of-CWD
 *     access with human prompts (config at ~/.pi/agent/extensions/
 *     pi-permission-system/config.json).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";

// -- helpers ------------------------------------------------------------------

interface SandboxConfig {
	network?: {
		strictAllowlist?: boolean;
		allowedDomains?: string[];
		deniedDomains?: string[];
	};
}

function loadSandboxConfig(path: string): SandboxConfig | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as SandboxConfig;
	} catch {
		return null;
	}
}

// -- prompt fragments ---------------------------------------------------------

function buildAllowlistPrompt(allowed: string[], denied: string[]): string {
	const allowList = allowed.map((d) => `  - ${d}`).join("\n");
	const denyNote = denied.length
		? `\nExplicitly denied (never reachable, even if also matched above):\n${denied.map((d) => `  - ${d}`).join("\n")}\n`
		: "";

	return `### Network Access — pi-sandbox (allow baseline + human approval)

**Every Bash command runs inside an OS-level sandbox (bubblewrap) with its own network namespace.** Outbound connections from Bash go through the sandbox's policy broker. Destinations in the baseline below are permitted silently; any other destination pauses the command and asks the human in the session UI for a one-time approval. There is no other route: direct sockets, DNS lookups, and raw connections from Bash have no path off-box. If the human denies (or no UI is present), the connection fails.

Baseline destinations (a leading '*.' matches subdomains; a ':port' suffix restricts the port):
${allowList}
${denyNote}
Writes from Bash are additionally confined to the current workspace. Reads outside the workspace are restricted by the sandbox policy.

If a command needs a domain that is not in the baseline, just run it — the user will be prompted to approve that one connection. Do not attempt to work around the sandbox (proxies, DNS tricks, or helper binaries): that only changes what gets denied, not who decides.

Pi's own web tools (web_search, fetch_content, get_search_content, source_check) run inside the Pi process, outside the Bash sandbox, so the baseline above does not govern them. Search is restricted to the configured SearXNG endpoint; fetches go direct and are guarded against private/loopback targets by pi-web-access's SSRF protection. All web tools are gated by the permission system like any other tool call.

Pi's native file tools are gated by a permission system: reaching outside the current working directory prompts a human, and secret files (.env, keys, credentials) are denied outright.`.trim();
}

function buildDegradedPrompt(): string {
	return `### Network Access - sandbox policy unavailable

The pi-sandbox policy file could not be read. Assume Bash network access is restricted and ask the user before relying on any specific domain.`.trim();
}

// -- extension ----------------------------------------------------------------

function buildEnvironmentPrompt(): string {
	const configPath =
		process.env.PI_SANDBOX_CONFIG ??
		"/home/agent/.pi/agent/extensions/pi-sandbox/config.json";
	const config = loadSandboxConfig(configPath);

	if (!config?.network?.allowedDomains) {
		return buildDegradedPrompt();
	}

	return buildAllowlistPrompt(
		config.network.allowedDomains,
		config.network.deniedDomains ?? [],
	);
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const envPrompt = buildEnvironmentPrompt();
		// Append after the existing system prompt so user-provided
		// instructions (AGENTS.md, SYSTEM.md, etc.) take precedence.
		return {
			systemPrompt: event.systemPrompt + "\n\n" + envPrompt,
		};
	});
}
