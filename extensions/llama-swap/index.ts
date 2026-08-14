/**
 * llama-swap provider extension for pi.
 *
 * - LLAMA_SWAP_URL (env): base URL of your llama-swap instance.
 * - models.json (top-level "llama-swap" key): fieldMapping that maps
 *   pi model properties to wherever you put them in each model's metadata
 *   block in llama-swap's config.yaml.
 *
 * pi owns the "providers" key in models.json; this extension owns
 * the top-level "llama-swap" key and ignores "providers" entirely.
 */

import type { ExtensionAPI, ProviderModelConfig, } from "@earendil-works/pi-coding-agent";
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
}

const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function dig(obj: any, path: string | undefined): any {
  if (!path) return undefined;
  return path.split(".").reduce((cur, k) => cur?.[k], obj);
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

  const { fieldMapping = {}, baseUrl, apiKey }  = await loadConfig();
  const envBaseUrl = process.env.LLAMA_SWAP_URL?.trim().replace(/\/+$/, "");
  const envApiKey = process.env.LLAMA_SWAP_API_KEY?.trim();
  
  if (!baseUrl && !envBaseUrl) {
    console.log("[llama-swap] LLAMA_SWAP_URL not set — skipping provider registration");
    return;
  }

  const resolvedBaseUrl = envBaseUrl ?? baseUrl!;
  const resolvedApiKey = envApiKey ?? apiKey!;

  try {
    const res = await fetch(`${resolvedBaseUrl}/v1/models`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

    const { data } = (await res.json()) as { data: any[] };
    const models = (data ?? []).map((m) => mapModel(m, fieldMapping));

    pi.registerProvider("llama-swap", {
      name:    "llama-swap",
      baseUrl: `${resolvedBaseUrl}/v1`,
      apiKey:  resolvedApiKey,
      api:     "openai-completions",
      models,
    });

    console.log(`[llama-swap] Registered ${models.length} model(s) from ${resolvedBaseUrl}`);
  } catch (err) {
    console.error(`[llama-swap] Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
