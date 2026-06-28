/**
 * System prompt extension.
 *
 * Injects a system-prompt section describing the sandboxed operating
 * environment — network mode, proxy behaviour, sudo restrictions — so
 * the agent knows what it can and cannot do before it tries.
 *
 * Reads the current runtime mode from /run/work/network-mode so prompts
 * reflect runtime switching performed by the network_mode tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";

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

function loadRuntimeMode(): "allowlist" | "open-get" {
	const statePath = "/run/work/network-mode";
	if (existsSync(statePath)) {
		try {
			const mode = readFileSync(statePath, "utf8").trim();
			if (mode === "allowlist" || mode === "open-get") {
				return mode;
			}
		} catch {
			// Fall back below.
		}
	}

	const envMode = process.env.NETWORK_MODE ?? "allowlist";
	return envMode === "open-get" ? "open-get" : "allowlist";
}

// ── prompt fragments ──────────────────────────────────────────────────────────

function buildAllowlistPrompt(domains: string[]): string {
	const list = domains.map((d) => `  - ${d}`).join("\n");

	return `### Network Access — Allowlist Mode (restricted)

You are running inside a sandboxed container.  

**Only allowlisted domains are permitted over HTTPS.**  Plain-text HTTP requests are rejected. Raw TCP socket access will be dropped.

Currently allowlisted domains (subdomains match if there is a leading dot):
${list}

Using the web_search, and get_search_results tools do not impose the same restrictions and should be used for research. The fetch_content tool is subject to the allowlist, so it will fail if the URL is not on the allowlist.

Before attempting any HTTP request: if you need to access a domain that is NOT on the allowlist, you can switch to open-get mode using the network_mode tool. This mode allows read-only access to any domain, but does not allow POST, PUT, DELETE, or other mutating requests.
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

Before attempting any HTTP request: consider whether it is a read-only GET/HEAD operation. If it is not, you will need to switch to allowlist mode using the network_mode tool. In allowlist mode, only requests to allowlisted domains are permitted, and mutating requests are allowed.
`.trim();

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
	const networkMode = loadRuntimeMode();

	const networkSection =
		networkMode === "open-get" ? OPEN_GET_MODE_PROMPT : buildAllowlistPrompt(loadProxyAllowlist());

	return [SHARED_PROMPT, networkSection].join("\n\n");
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
