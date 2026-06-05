/**
 * System prompt extension.
 *
 * Injects a system-prompt section describing the sandboxed operating
 * environment — network mode, proxy behaviour, sudo restrictions — so
 * the agent knows what it can and cannot do before it tries.
 *
 * Reads NETWORK_MODE at startup and picks the matching prompt fragment.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";

// ── helpers ───────────────────────────────────────────────────────────────────

function loadProxyAllowlist(): string[] {
	const path = "/config/proxy-allowlist.txt";
	try {
		const raw = readFileSync(path, "utf8");
		return raw
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith("#"));
	} catch {
		return [];
	}
}

// ── prompt fragments ──────────────────────────────────────────────────────────

function buildAllowlistPrompt(domains: string[]): string {
	const list = domains.map((d) => `  - ${d}`).join("\n");

	return `### Network Access — Allowlist Mode (restricted)

You are running inside a sandboxed container.  

**Only HTTPS CONNECT to allowlisted domains is permitted.**  Plain-text HTTP requests are rejected. 

Currently allowlisted domains (subdomains match automatically):
${list}

Before attempting to fetch a URL, install a package, or reach any external service, check whether the domain is on the allowlist.  If it is not, the request will fail — suggest adding it to the allowlist instead of retrying blindly.

Using the web_search, fetch_content, and get_search_results tools do not impose the same restrictions.
.`.trim();
}

const OPEN_GET_MODE_PROMPT = `
### Network Access — Open-GET Mode (read-only)

You are running inside a sandboxed container.  All outbound HTTP(S) traffic is routed through a proxy that restricts requests to GET and HEAD methods only.

POST, PUT, DELETE, and other methods will return 403 Forbidden. This means you can download files, read web pages, and fetch data from read-only APIs, but you cannot submit forms, push to APIs, or make mutating requests.

Additionally:
- Query strings are stripped from URLs, so you cannot use URL parameters
- Sensitive headers are stripped.
- Only a safe set of headers (Host, Accept*, User-Agent, etc.) pass through.

Before attempting any HTTP request, consider whether it is a read-only GET/HEAD operation.  If the task requires POST or other methods, explain the limitation to the user.

Using the web_search, fetch_content, and get_search_results tools do not impose the same restrictions.`.trim();

// ── shared (always-injected) section ──────────────────────────────────────────

const SHARED_PROMPT = `
## Operating Environment

You are running as the **agent** user (uid 1001) inside a Docker container based on Node 24 LTS.

### Sudo access
Sudo access is restricted to a pre-determined allowlist.  Only the exact commands listed in the allowlist are permitted — wildcards are not used.

### Python virtual environments
Python tools that need external packages should use a virtual environment (python3 -m venv) rather than system-wide installs, because sudo apt-get is restricted. 
`.trim();

// ── extension ─────────────────────────────────────────────────────────────────

function buildEnvironmentPrompt(): string {
	const networkMode = process.env.NETWORK_MODE ?? "allowlist";

	const networkSection =
		networkMode === "open-get" ? OPEN_GET_MODE_PROMPT : buildAllowlistPrompt(loadProxyAllowlist());

	return [SHARED_PROMPT, networkSection].join("\n\n");
}

export default function (pi: ExtensionAPI) {
	// Build the prompt once at load time (NETWORK_MODE doesn't change mid-container-lifecycle).
	const envPrompt = buildEnvironmentPrompt();

	pi.on("before_agent_start", async (event) => {
		// Append after the existing system prompt so user-provided
		// instructions (AGENTS.md, SYSTEM.md, etc.) take precedence.
		return {
			systemPrompt: event.systemPrompt + "\n\n" + envPrompt,
		};
	});
}
