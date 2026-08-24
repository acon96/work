/**
 * llama-swap provider extension for pi.
 *
 * - LLAMA_SWAP_URL (env): base URL of your llama-swap instance.
 * - models.json (top-level "llama-swap" key): fieldMapping that maps
 *   pi model properties to wherever you put them in each model's metadata
 *   block in llama-swap's config.yaml.
 * - models.json (top-level "llama-swap.slotCache" key): enables per-session
 *   KV cache stashing and stable llama.cpp slot assignment.
 *
 * pi owns the "providers" key in models.json; this extension owns
 * the top-level "llama-swap" key and ignores "providers" entirely.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { ChatTemplateKwargValue, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { readFile } from "node:fs/promises";

// ── Config types ──────────────────────────────────────────────────────────────

interface CostMapping {
  input?:      string;
  output?:     string;
  cacheRead?:  string;
  cacheWrite?: string;
}

interface FieldMapping {
  name?:          string;
  contextWindow?: string;
  maxTokens?:     string;
  reasoning?:     string;
  reasoningLevels?: string;
  input?:         string;
  cost?:          CostMapping;
}

interface LlamaSwapConfig {
  baseUrl?: string;
  apiKey?:  string;
  fieldMapping?: FieldMapping;
  slotCache?: boolean;
}

interface SlotEndpointResult {
  error?: { message?: string };
  n_saved?: number;
  n_restored?: number;
}

interface LlamaServerSlot {
  id: number;
}

interface SlotCacheResult {
  tokens: number;
  slots: number;
  error?: string;
}

const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const EMPTY_SLOT_CACHE_RESULT: SlotCacheResult = { tokens: 0, slots: 0 };
const MODEL_DISCOVERY_ATTEMPTS = 6;
const MODEL_DISCOVERY_TIMEOUT_MS = 5_000;
const MODEL_DISCOVERY_INITIAL_DELAY_MS = 1_000;
const MODEL_DISCOVERY_MAX_DELAY_MS = 5_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function dig(obj: any, path: string | undefined): any {
  if (!path) return undefined;
  return path.split(".").reduce((cur, k) => cur?.[k], obj);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number): number {
  return Math.min(
    MODEL_DISCOVERY_INITIAL_DELAY_MS * (2 ** Math.max(0, attempt - 1)),
    MODEL_DISCOVERY_MAX_DELAY_MS,
  );
}

function isRetryableDiscoveryStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function discoverModels(baseUrl: string): Promise<any[]> {
  const url = `${baseUrl}/v1/models`;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MODEL_DISCOVERY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS),
      });
      if (!response.ok) {
        const error = new Error(`${response.status} ${response.statusText}`);
        if (!isRetryableDiscoveryStatus(response.status)) throw error;
        lastError = error;
      } else {
        const payload = await response.json() as { data?: unknown };
        if (!Array.isArray(payload.data)) {
          throw new Error("model endpoint returned an invalid data field");
        }
        if (payload.data.length === 0) {
          throw new Error("model endpoint returned an empty catalog");
        }
        return payload.data;
      }
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /^4\d\d /u.test(error.message)) throw error;
    }

    if (attempt < MODEL_DISCOVERY_ATTEMPTS) {
      const waitMs = retryDelayMs(attempt);
      console.warn(
        `[llama-swap] Model discovery attempt ${attempt}/${MODEL_DISCOVERY_ATTEMPTS} failed: ` +
        `${errorMessage(lastError)}; retrying in ${waitMs}ms`,
      );
      await delay(waitMs);
    }
  }

  throw new Error(
    `model discovery failed after ${MODEL_DISCOVERY_ATTEMPTS} attempts: ${errorMessage(lastError)}`,
  );
}

function conversationSlotFilename(modelId: string, conversationId: string, idSlot: number): string {
  const safeModelId = modelId.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const safeConversationId = conversationId.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return `pi-llama-swap_${safeModelId}_${safeConversationId}_slot${idSlot}.bin`;
}

/** A stable, dependency-free hash used to map a conversation to a server slot. */
function hashConversationId(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Persists the KV cache for one model and Pi conversation through llama-swap's
 * direct upstream proxy. Requests for this conversation are pinned to the same
 * physical llama.cpp slot, and its cache is stored under a conversation-specific
 * filename. This keeps one conversation from restoring or overwriting another
 * conversation's cache when llama-swap unloads a model.
 * Based on the implementation from this fork: https://github.com/Red4Hack/pi-llama-cpp
 */
class SlotCache {
  private populated = false;
  private saving: Promise<SlotCacheResult> | null = null;
  private restored = false;
  private slotId: number | null = null;
  private slotLookup: Promise<number | null> | null = null;
  private slotError: string | undefined;

  constructor(
    private readonly modelId: string,
    private readonly conversationId: string,
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
  ) {}

  markPopulated(): void {
    this.populated = true;
  }

  /**
   * Pins this conversation's OpenAI requests to one deterministic llama.cpp
   * slot. The available IDs are read from the live `/slots` endpoint rather
   * than inferred from a configured or hard-coded slot count.
   */
  async getSlotId(): Promise<number | null> {
    if (this.slotId !== null) return this.slotId;
    if (this.slotLookup) return this.slotLookup;

    this.slotLookup = this.fetchSlotId().catch((error) => {
      this.slotError = errorMessage(error);
      return null;
    }).finally(() => {
      this.slotLookup = null;
    });
    return this.slotLookup;
  }

  /** Restores once, immediately before this conversation's first request. */
  async restoreBeforeRequest(): Promise<SlotCacheResult | null> {
    if (this.restored) return null;

    const result = await this.restore();
    // A missing cache file is a normal first-use condition. Do not retry on
    // every request, which would continually reset the active slot.
    this.restored = true;
    return result;
  }

  async save(): Promise<SlotCacheResult> {
    if (!this.populated) {
      return { ...EMPTY_SLOT_CACHE_RESULT, error: "no response served yet, nothing to save" };
    }
    if (this.saving) return this.saving;

    this.saving = this.forConversationSlot(async (idSlot) => {
      const result = await this.requestSlotAction(idSlot, "save");
      return { error: result.error?.message, tokens: result.n_saved ?? 0 };
    });

    try {
      return await this.saving;
    } finally {
      this.saving = null;
    }
  }

  async restore(): Promise<SlotCacheResult> {
    const result = await this.forConversationSlot(async (idSlot) => {
      const response = await this.requestSlotAction(idSlot, "restore");
      return { error: response.error?.message, tokens: response.n_restored ?? 0 };
    });
    if (result.tokens > 0) this.populated = true;
    return result;
  }

  private async requestSlotAction(idSlot: number, action: "save" | "restore"): Promise<SlotEndpointResult> {
    const url = new URL(
      `/upstream/${encodeURIComponent(this.modelId)}/slots/${idSlot}`,
      this.baseUrl,
    );
    url.searchParams.set("action", action);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      // `--slot-save-path` constrains where llama.cpp writes. The filename
      // includes both Pi's conversation ID and the stable slot ID, so saving a
      // different conversation can never replace this conversation's stash.
      // The router API reads `model` from the request body when it is present.
      body: JSON.stringify({
        model: this.modelId,
        filename: conversationSlotFilename(this.modelId, this.conversationId, idSlot),
      }),
    });
    const payload = await response.json().catch(() => undefined) as SlotEndpointResult | undefined;

    if (!response.ok) {
      throw new Error(payload?.error?.message ?? `${response.status} ${response.statusText}`);
    }
    return payload ?? {};
  }

  private async fetchSlotId(): Promise<number> {
    const url = new URL(`/upstream/${encodeURIComponent(this.modelId)}/slots`, this.baseUrl);
    url.searchParams.set("model", this.modelId);
    const response = await fetch(url, {
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : undefined,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

    const slots = await response.json() as LlamaServerSlot[];
    const ids = Array.isArray(slots)
      ? slots.map((slot) => slot.id).filter((id) => Number.isInteger(id) && id >= 0)
      : [];
    if (ids.length === 0) throw new Error("the llama.cpp /slots endpoint returned no slots");

    this.slotId = ids[hashConversationId(this.conversationId) % ids.length];
    return this.slotId;
  }

  private async forConversationSlot(
    operation: (idSlot: number) => Promise<{ error?: string; tokens: number }>,
  ): Promise<SlotCacheResult> {
    try {
      const idSlot = await this.getSlotId();
      if (idSlot === null) return { ...EMPTY_SLOT_CACHE_RESULT, error: this.slotError };

      const result = await operation(idSlot);
      if (result.error) return { ...EMPTY_SLOT_CACHE_RESULT, error: result.error };
      return result.tokens > 0
        ? { tokens: result.tokens, slots: 1 }
        : { ...EMPTY_SLOT_CACHE_RESULT };
    } catch (cause) {
      return { ...EMPTY_SLOT_CACHE_RESULT, error: errorMessage(cause) };
    }
  }
}

async function loadConfig(): Promise<LlamaSwapConfig> {
  const candidates = [
    "/home/agent/.pi/agent/models.json",
  ];
  for (const p of candidates) {
    try {
      const raw = await readFile(p, "utf8");
      const parsed = JSON.parse(raw) as Record<string, any>;
      const cfg = parsed["llama-swap"] as LlamaSwapConfig | undefined;
      if (cfg) {
        console.log(`[llama-swap] Loaded fieldMapping from ${p}`);
        return cfg;
      }
    } catch {
      // file missing or unreadable — try next
    }
  }
  console.log("[llama-swap] No fieldMapping found in models.json — using bare model fields");
  return {};
}

function mapModel(raw: any, fm: FieldMapping): ProviderModelConfig {
  const rawInput = dig(raw, fm.input);
  const input: Array<"text" | "image"> = Array.isArray(rawInput)
    ? rawInput.filter((v: string) => v === "text" || v === "image")
    : ["text"];

  const isPeer = dig(raw, "meta.llamaswap.peerID") !== undefined;
  const modelId = raw.id as string;

  if (isPeer && modelId.split("/").length === 2) {
    // attempt to find the peer's ID in our existing model registry and apply those settings
    const [provider, modelName] = modelId.split("/");
    // The generated catalog overloads couple each provider literal to its model
    // literals. Peer metadata is dynamic, so cross that static boundary here.
    const foundModel = getBuiltinModel(provider as any, modelName);

    if (foundModel) {
      return {
        id:               modelId,
        name:             foundModel.name,
        reasoning:        foundModel.reasoning,
        input:            foundModel?.input,
        contextWindow:    foundModel?.contextWindow,
        maxTokens:        foundModel?.maxTokens,
        cost:             foundModel?.cost,
        compat:           foundModel?.compat,
        thinkingLevelMap: foundModel?.thinkingLevelMap,
      }
    }
  }

  const chatTemplateKwargs: Record<string, ChatTemplateKwargValue> = {};
  let supportsReasoningEffort = false;
  let thinkingLevelMap: ThinkingLevelMap | undefined;

  if (fm.reasoning) {
    chatTemplateKwargs.thinking_enabled = { "$var": "thinking.enabled" };
  }

  const rawReasoningLevels = dig(raw, fm.reasoningLevels);
  if (Array.isArray(rawReasoningLevels)) {
    chatTemplateKwargs.reasoning_effort = { "$var": "thinking.effort" };
    supportsReasoningEffort = true;
    const availableLevels = new Set(rawReasoningLevels);
    // only remap off to none
    thinkingLevelMap = Object.fromEntries(
      PI_THINKING_LEVELS.map((level) => [level, availableLevels.has(level) ? (level == "off" ? "none" : level) : null]),
    );
  } else if (fm.reasoning) {
    // if reasoning is enabled but no levels are provided, then assume no thinking effort support
    thinkingLevelMap = Object.fromEntries(
      PI_THINKING_LEVELS.map((level) => [level, null]),
    )
  }

  return {
    id:            modelId,
    name:          (dig(raw, fm.name) as string | undefined) ?? raw.name ?? raw.id,
    reasoning:     Boolean(dig(raw, fm.reasoning)),
    input,
    contextWindow: Number(dig(raw, fm.contextWindow)) || 128000,
    maxTokens:     Number(dig(raw, fm.maxTokens))     || 32768,
    cost: {
      input:      Number(dig(raw, fm.cost?.input))      || 0,
      output:     Number(dig(raw, fm.cost?.output))     || 0,
      cacheRead:  Number(dig(raw, fm.cost?.cacheRead))  || 0,
      cacheWrite: Number(dig(raw, fm.cost?.cacheWrite)) || 0,
    },
    thinkingLevelMap,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: supportsReasoningEffort,
      maxTokensField: "max_tokens"
    },
  };
}

// ── Extension factory ─────────────────────────────────────────────────────────

export default async function llamaSwapExtension(pi: ExtensionAPI) {

  const {
    fieldMapping = {},
    baseUrl,
    apiKey,
    slotCache = false,
  } = await loadConfig();
  const envBaseUrl = process.env.LLAMA_SWAP_URL?.trim().replace(/\/+$/, "");
  const envApiKey = process.env.LLAMA_SWAP_API_KEY?.trim();
  
  if (!baseUrl && !envBaseUrl) {
    console.log("[llama-swap] LLAMA_SWAP_URL not set — skipping provider registration");
    return;
  }

  const resolvedBaseUrl = envBaseUrl ?? baseUrl!;
  const resolvedApiKey = envApiKey ?? apiKey!;
  const slotCaches = new Map<string, SlotCache>();

  const getSlotCache = (modelId: string, conversationId: string): SlotCache => {
    const key = `${modelId}\u0000${conversationId}`;
    let cache = slotCaches.get(key);
    if (!cache) {
      cache = new SlotCache(
        modelId,
        conversationId,
        resolvedBaseUrl,
        resolvedApiKey,
      );
      slotCaches.set(key, cache);
    }
    return cache;
  };

  const saveActiveModel = async (
    model: { provider: string; id: string } | undefined,
    conversationId: string,
  ): Promise<void> => {
    if (!model || model.provider !== "llama-swap") return;

    const result = await getSlotCache(model.id, conversationId).save();
    if (result.tokens > 0) {
      console.log(`[llama-swap] Saved ${result.tokens} KV tokens across ${result.slots} slot(s) for ${model.id}`);
    } else if (result.error && !result.error.startsWith("no response")) {
      console.warn(`[llama-swap] KV slot save for ${model.id}: ${result.error}`);
    }
  };

  try {
    const data = await discoverModels(resolvedBaseUrl);
    const models = data.map((m) => mapModel(m, fieldMapping));

    pi.registerProvider("llama-swap", {
      name:    "llama-swap",
      baseUrl: `${resolvedBaseUrl}/v1`,
      apiKey:  resolvedApiKey,
      api:     "openai-completions",
      models,
    });

    console.log(`[llama-swap] Registered ${models.length} model(s) from ${resolvedBaseUrl}`);

    // llama.cpp accepts `id_slot` in the OpenAI-compatible completion body.
    // Set it on every request so a Pi session stays on one stable slot rather
    // than relying on llama.cpp's default idle-slot assignment (`-1`).
    pi.on("before_provider_request", async (event, ctx) => {
      if (!slotCache || ctx.model?.provider !== "llama-swap" || !event.payload || typeof event.payload !== "object") return;

      const cache = getSlotCache(ctx.model.id, ctx.sessionManager.getSessionId());
      const restore = await cache.restoreBeforeRequest();
      const idSlot = await cache.getSlotId();
      if (restore?.tokens && restore.tokens > 0) {
        console.log(`[llama-swap] Restored ${restore.tokens} KV tokens for ${ctx.model.id} slot ${idSlot}`);
      } else if (restore?.error) {
        console.warn(`[llama-swap] KV slot restore for ${ctx.model.id}: ${restore.error}`);
      }

      return idSlot === null
        ? undefined
        : { ...(event.payload as Record<string, unknown>), id_slot: idSlot };
    });

    // Only successful assistant responses are worth stashing: a failed or
    // aborted request must never overwrite a previously saved slot file.
    pi.on("message_end", (event, ctx) => {
      if (slotCache && event.message.role === "assistant" && ctx.model?.provider === "llama-swap") {
        getSlotCache(ctx.model.id, ctx.sessionManager.getSessionId()).markPopulated();
      }
    });

    // Save after retries, automatic compaction, and queued follow-ups have
    // completed. This is deliberately always-on while slot caching is enabled.
    if (slotCache) {
      pi.on("agent_settled", async (_event, ctx) => {
        await saveActiveModel(ctx.model, ctx.sessionManager.getSessionId());
      });

      pi.on("session_shutdown", async (_event, ctx) => {
        await saveActiveModel(ctx.model, ctx.sessionManager.getSessionId());
      });

      // Save the prior model before switching. The selected model is restored
      // lazily just before its first completion, after llama-swap has loaded it.
      pi.on("model_select", async (event, ctx) => {
        await saveActiveModel(event.previousModel, ctx.sessionManager.getSessionId());
      });
    }
  } catch (err) {
    console.error(`[llama-swap] Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
