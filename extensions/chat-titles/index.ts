import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export function normalizeSessionTitle(raw: string): string | undefined {
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) return undefined;

  const cleaned = firstLine
    .replace(/^[\s`"'“”‘’*_-]+/, "")
    .replace(/[\s`"'“”‘’*_-]+$/, "")
    .replace(/^(?:titre|title)\s*:\s*/i, "")
    .replace(/[.!?…。！？]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;

  const bounded = cleaned.split(" ").slice(0, 8).join(" ");
  return bounded.length > 80 ? bounded.slice(0, 80).trimEnd() : bounded;
}

function resolveModel(ctx: ExtensionContext) {
  const spec = process.env.PI_TITLE_MODEL?.trim();
  if (!spec) return null;

  const sep = spec.lastIndexOf("/");
  if (sep <= 0) {
    return null;
  }

  const provider = spec.slice(0, sep);
  const modelId = spec.slice(sep + 1);
  const found = ctx.modelRegistry.find(provider, modelId);
  if (found) return found;
  return null;
}

async function generateTitle(prompt: string, ctx: ExtensionContext): Promise<string | undefined> {
  const model = resolveModel(ctx);
  if (!model) return undefined;

  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    systemPrompt: "",
    systemPromptOverride: () => "",
    extensionsOverride: (base) => ({ ...base, extensions: [] }),
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    resourceLoader: loader,
    model,
    thinkingLevel: "off",
    noTools: "all",
    sessionManager: SessionManager.inMemory(),
  });

  try {
    await session.prompt(prompt);
    return normalizeSessionTitle(session.getLastAssistantText() ?? "");;
  } finally {
    session.abort();
  }
}

export default function registerAutoTitle(pi: ExtensionAPI): void {
  let attempted = false;

  pi.on("session_start", (_event, ctx) => {
    attempted = ctx.sessionManager.getEntries().some(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (attempted || pi.getSessionName()) return;
    const prompt = event.prompt.trim();
    if (!prompt) return;
    attempted = true;

    // The first prompt must never wait for title generation.
    void generateTitle(prompt, ctx)
      .then((title) => {
        if (title && !pi.getSessionName()) pi.setSessionName(title);
      })
      .catch(() => {});
  });
}
