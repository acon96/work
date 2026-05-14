# AGENTS.md — guidelines for developing `work`

This document is for AI agents (and humans) doing further development on this repository.

---

## Repository layout

```
work/
├── Dockerfile                   Main container image
├── docker-compose.yml           Compose config
├── config/
│   ├── proxy-allowlist.txt      User-editable proxy domain allowlist (Mode A)
│   ├── sudo-allowlist.txt       User-editable sudo command allowlist
│   ├── squid-allowlist.conf     Squid config rendered for Mode A
│   ├── squid-open-get.conf      Squid config rendered for Mode B
│   ├── dnsmasq-allowlist.conf   dnsmasq config for Mode A (default-deny)
│   └── dnsmasq-open.conf        dnsmasq config for Mode B (permissive)
├── scripts/
│   ├── entrypoint.sh            Container start-up script
│   ├── docker-run.sh            Convenience host launcher
│   ├── sudo-wrapper.sh          Runtime allowlist-checked sudo gate
│   └── squid-url-rewrite.py     URL rewrite helper (strips query strings, Mode B)
├── extensions/
│   ├── sudo-gate.ts             pi extension: intercepts dangerous bash calls
│   ├── tools.ts                 pi extension: runtime tool toggling
│   ├── watch.ts                 pi extension: polling watches
│   └── todo.ts                  pi extension: persistent todo list
└── .github/workflows/docker.yml CI/CD: build & publish image on push to main
```

---

## Core invariants — never violate these

1. **The `agent` user must never be able to run arbitrary root commands.** The only sudoers entry for `agent` points at `/usr/local/bin/sudo-wrapper`, which re-checks `/config/sudo-allowlist.txt` at runtime.
2. **All outbound traffic from the container is routed through squid (port 3128).** Do not add firewall rules or iptables that bypass this.
3. **`rm -rf` and `chmod/chown 777` are unconditionally blocked** by `extensions/sudo-gate.ts`, regardless of allowlists.
4. **Mode A (allowlist)** is the secure default. Mode B (open-GET) trades security for convenience — never make Mode B the default.
5. **The squid MITM CA private key is generated at build time** and never exported. Do not add steps that print or persist `/etc/squid/ssl-ca.key`.

---

## Extending extensions

All extensions live in `extensions/*.ts` and implement `ExtensionAPI` from `@mariozechner/pi-coding-agent`.

### Adding a new tool

```typescript
pi.registerTool("my-tool", {
  description: "...",
  parameters: { type: "object", required: [...], properties: { ... } },
  handler: async (input) => { ... },
});
```

### Persisting state across sessions

```typescript
// Write
pi.appendEntry<MyState>("my-state-type", { ... });

// Read on session_start / session_tree
for (const entry of ctx.sessionManager.getBranch()) {
  if (entry.type === "custom" && entry.customType === "my-state-type") {
    // restore state from entry.data
  }
}
```

### Intercepting tool calls

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName !== "bash") return undefined;
  // Return { block: true, reason: "..." } to deny, or undefined to allow.
});
```

---

## Docker & proxy

### Adding an allowlisted domain

Append to `config/proxy-allowlist.txt`. The entry must be a bare domain (e.g. `pypi.org`); squid's `dstdomain` ACL automatically matches subdomains.  The entrypoint also appends a `server=/<domain>/8.8.8.8` dnsmasq directive so DNS resolves correctly in Mode A.

### Adding an allowlisted sudo command

Append the full command (including `sudo`) to `config/sudo-allowlist.txt`, e.g.:
```
sudo apt-get install -y curl
```

### Switching network modes

Set `NETWORK_MODE=open-get` via environment variable (docker-compose or docker run `-e`).

---

## CI/CD

The GitHub Actions workflow at `.github/workflows/docker.yml` builds and pushes the image to `ghcr.io/<owner>/<repo>` on every push to `main` and on version tags.  Pull request builds run without pushing.

The image is tagged with:
- branch name (e.g. `main`)
- semantic version (`v1.2.3` → `1.2.3` and `1.2`)
- git SHA prefix (`sha-abc1234`)

---

## Testing checklist before merging

- [ ] `docker build .` completes without errors
- [ ] `NETWORK_MODE=allowlist docker compose up` — verify squid blocks non-allowlisted domains
- [ ] `NETWORK_MODE=open-get docker compose up` — verify only GET/HEAD pass; POST returns 403
- [ ] sudo-gate extension blocks `rm -rf /` and `chmod 777 /etc` tool calls
- [ ] sudo-gate extension blocks unlisted sudo commands
- [ ] watch extension creates, fires, and auto-cancels correctly
- [ ] todo extension persists across session restart
