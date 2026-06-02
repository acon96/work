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

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
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
  input?:         string;
  cost?:          CostMapping;
  thinkingFormat?: string;
}

interface LlamaSwapConfig {
  baseUrl?: string;
  apiKey?:  string;
  fieldMapping?: FieldMapping;
}

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

  return {
    id:            raw.id as string,
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
    compat: {
      supportsDeveloperRole:   false,
      supportsReasoningEffort: false,
      maxTokensField:          "max_tokens",
      thinkingFormat: fm?.thinkingFormat ?? undefined,
    },
  };
}

// ── Extension factory ─────────────────────────────────────────────────────────

export default async function llamaSwapExtension(pi: ExtensionAPI) {

  const { fieldMapping, baseUrl, apiKey }  = await loadConfig();
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
