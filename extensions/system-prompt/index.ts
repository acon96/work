/**
 * System prompt extension.
 *
 * Injects a system-prompt section describing the sandboxed operating
 * environment - how outbound access is enforced, what the domain allowlist
 * is, which paths are writable, and what that means for tool use - so the
 * agent knows what it can and cannot do before it tries.
 *
 * Policy is enforced by two pi extensions, neither of which the agent can
 * change from inside a session:
 *   - pi-sandbox: wraps every Bash command (and every `!` user-shell command)
 *     in a bubblewrap sandbox with its own network namespace and a fixed mount
 *     set. Config at ~/.pi/agent/sandbox.json, write-protected from sandboxed
 *     commands by its own denyWrite list and by pi-permission-system.
 *   - pi-permission-system: gates Pi's native file tools with human prompts
 *     (config at ~/.pi/agent/extensions/pi-permission-system/config.json).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";

// -- helpers ------------------------------------------------------------------

interface SandboxConfig {
	filesystem?: {
		allowWrite?: string[];
	};
	network?: {
		allowedDomains?: string[];
		deniedDomains?: string[];
	};
}

function loadSandboxConfig(path: string): SandboxConfig | null {
	try {
		// The config is JSONC; strip line comments so a commented policy file
		// still describes itself.
		const jsonc = readFileSync(path, "utf8").replace(/^[ \t]*\/\/.*$/gm, "");
		return JSON.parse(jsonc) as SandboxConfig;
	} catch {
		return null;
	}
}

// -- prompt fragments ---------------------------------------------------------

function buildEnvironmentPrompt(allowed: string[], denied: string[]): string {
	const allowList = allowed.map((d) => `  - ${d}`).join("\n");
	const denyNote = denied.length
		? `\nExplicitly denied (never reachable, even if also matched above):\n${denied.map((d) => `  - ${d}`).join("\n")}\n`
		: "";

	return `### Execution environment - pi-sandbox (bubblewrap) + permission system

**Every Bash command, and every \`!\` shell command, runs inside an OS-level sandbox (bubblewrap) with its own network and PID namespaces.** The Pi process itself - native file tools, web tools, MCP servers - runs outside that sandbox and is governed by the permission system instead.

**Writable paths.** Only these are writable from Bash:
  - the session's current working directory (and everything beneath it)
  - \`/scratch\` - stable temp space, memory-backed, shared by all commands in this container, emptied when the container restarts

Everything else in the image is mounted read-only. Redirecting into another path fails immediately with \`Read-only file system\` rather than prompting, so install and build into the working directory or \`/scratch\`, never into a system location. \`$TMPDIR\` points at a fresh directory created for the current command only: anything written there is gone once the command exits, so keep files you need to reuse in \`/scratch\` rather than caching state under \`/tmp\`.

**Reads.** The rest of the container is readable on purpose - installed packages under \`/app\`, system files under \`/etc\` and \`/usr\`, your home directory - so research and information gathering need no special handling. Masked from every view: \`~/.pi/agent/auth.json\`, \`~/.git-credentials\`, \`~/.ssh\`.

**Network.** Sandboxed commands reach the network only through a policy proxy with a fixed baseline. Baseline destinations (a leading '*.' matches subdomains; a ':port' suffix restricts the port):
${allowList}
${denyNote}
A command whose text names a destination outside this baseline pauses and asks the human for a one-time approval. A destination reached *indirectly* - an HTTP redirect, a bare IP address, a host read from a config file, an installer that fetches from somewhere else - is not detected in advance and its connection simply fails. There is no other route off the box: direct sockets, DNS lookups, and raw connections from Bash have no path out. If the human denies, or no UI is present, the connection fails. Do not attempt to work around the sandbox (proxies, DNS tricks, or helper binaries): that only changes what gets denied, not who decides. Adding a domain is a policy change for the human to make, not a workaround to discover.

Pi's own web tools (web_search, fetch_content, get_search_content, source_check) run inside the Pi process, outside the Bash sandbox, so the baseline above does not govern them. Search is restricted to the configured SearXNG endpoint; fetches go direct and are guarded against private/loopback targets by pi-web-access's SSRF protection. All web tools are gated by the permission system like any other tool call.

Pi's native file tools are gated by a permission system: reads anywhere are permitted, writes outside the current working directory prompt a human, and credential files are denied outright.`.trim();
}

function buildDegradedPrompt(): string {
	return `### Execution environment - sandbox policy unavailable

The pi-sandbox policy file (~/.pi/agent/sandbox.json) could not be read. Assume Bash network access is restricted to an unknown baseline and that only the working directory is writable; ask the user before relying on any specific domain or path.`.trim();
}

// -- extension ----------------------------------------------------------------

function buildEnvironmentPromptFromConfig(): string {
	const configPath =
		process.env.PI_SANDBOX_CONFIG ?? "/home/agent/.pi/agent/sandbox.json";
	const config = loadSandboxConfig(configPath);

	if (!config?.network?.allowedDomains) {
		return buildDegradedPrompt();
	}

	return buildEnvironmentPrompt(
		config.network.allowedDomains,
		config.network.deniedDomains ?? [],
	);
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const envPrompt = buildEnvironmentPromptFromConfig();
		// Append after the existing system prompt so user-provided
		// instructions (AGENTS.md, SYSTEM.md, etc.) take precedence.
		return {
			systemPrompt: event.systemPrompt + "\n\n" + envPrompt,
		};
	});
}
