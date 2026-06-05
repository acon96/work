/**
 * pi-superagent extension
 *
 * Inverts the traditional strong-model-drives-weak-subagents pattern.
 * The local model gathers context, packages it into a single prompt,
 * sends it to a strong model ONCE for planning, then executes the plan.
 *
 * This minimizes expensive model costs by:
 * - Single strong model invocation (no multi-turn cache interactions)
 * - Minimal output tokens from expensive model (just a plan)
 * - Local model does all the heavy lifting (research + execution)
 *
 * Configuration is fully dynamic - specify the provider and model at invocation time.
 * Uses pi's existing provider and authentication configuration.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_MAX_CONTEXT_BYTES = 100000; // 100KB default

function truncateContent(content: string, maxBytes: number): { content: string; truncated: boolean } {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) {
    return { content, truncated: false };
  }

  const lines = content.split("\n");
  let accumulated = "";
  let truncated = false;

  for (const line of lines) {
    const candidate = accumulated + (accumulated ? "\n" : "") + line;
    if (Buffer.byteLength(candidate, "utf8") > maxBytes) {
      truncated = true;
      break;
    }
    accumulated = candidate;
  }

  if (truncated) {
    accumulated += "\n\n[Content truncated to fit context budget]";
  }

  return { content: accumulated, truncated };
}

/**
 * Gathers context from previous tool call results
 */
function gatherContextFromToolCalls(
  toolCallIds: string[],
  ctx: ExtensionContext,
  maxBytes: number,
): { items: Array<{ label: string; content: string }>; totalBytes: number; truncated: boolean } {
  const items: Array<{ label: string; content: string }> = [];
  let totalBytes = 0;
  let truncated = false;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    if (!toolCallIds.includes(entry.message.toolCallId)) continue;

    const toolName = entry.message.toolName;
    let content = "";

    // Extract text content from the message
    for (const contentItem of entry.message.content) {
      if (contentItem.type === "text") {
        content += contentItem.text;
      }
    }

    // Build label based on tool type and metadata
    let label: string;
    if (toolName === "read" && entry.message.details?.path) {
      label = `File: ${entry.message.details.path}`;
    } else if (toolName === "bash" && entry.message.details?.command) {
      label = `Command: ${entry.message.details.command}`;
    } else if (toolName === "grep" && entry.message.details?.pattern) {
      label = `Grep: ${entry.message.details.pattern}`;
    } else if (toolName === "find" && entry.message.details?.pattern) {
      label = `Find: ${entry.message.details.pattern}`;
    } else {
      label = `Tool: ${toolName} [${entry.message.toolCallId}]`;
    }

    // Check if adding this would exceed budget
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (totalBytes + contentBytes > maxBytes) {
      const remaining = maxBytes - totalBytes;
      if (remaining > 500) {
        const truncation = truncateContent(content, remaining - 100);
        items.push({ label, content: truncation.content });
        totalBytes += Buffer.byteLength(truncation.content, "utf8");
        truncated = true;
      }
      break;
    }

    items.push({ label, content });
    totalBytes += contentBytes;
  }

  return { items, totalBytes, truncated };
}

/**
 * Gathers context from file paths by reading them
 */
async function gatherContextFromFilePaths(
  filePaths: string[],
  maxBytes: number,
  execFn: (cmd: string, args: string[]) => Promise<{ stdout: string; code: number }>,
): Promise<{ items: Array<{ label: string; content: string }>; totalBytes: number; truncated: boolean }> {
  const items: Array<{ label: string; content: string }> = [];
  let totalBytes = 0;
  let truncated = false;

  for (const path of filePaths) {
    try {
      const result = await execFn("cat", [path]);
      if (result.code !== 0) continue;
      
      const content = result.stdout;
      const contentBytes = Buffer.byteLength(content, "utf8");
      
      if (totalBytes + contentBytes > maxBytes) {
        const remaining = maxBytes - totalBytes;
        if (remaining > 500) {
          const truncation = truncateContent(content, remaining - 100);
          items.push({ label: `File: ${path}`, content: truncation.content });
          totalBytes += Buffer.byteLength(truncation.content, "utf8");
          truncated = true;
        }
        break;
      }

      items.push({ label: `File: ${path}`, content });
      totalBytes += contentBytes;
    } catch {
      // Skip files that can't be read
      continue;
    }
  }

  return { items, totalBytes, truncated };
}

function buildSuperagentPrompt(
  userQuery: string,
  contextItems: Array<{ label: string; content: string }>,
  additionalContext?: string,
): string {
  const parts: string[] = [];

  parts.push("# Task Planning Request");
  parts.push("");
  parts.push("You are planner that provides detailed implementation plans. Another AI agent will execute your plan, so provide clear, actionable steps.");
  parts.push("");
  parts.push("## User Request");
  parts.push(userQuery);
  parts.push("");

  if (additionalContext) {
    parts.push("## Additional Context");
    parts.push(additionalContext);
    parts.push("");
  }

  if (contextItems.length > 0) {
    parts.push("## Gathered Context");
    parts.push("");
    parts.push("The following context has been gathered from the project:");
    parts.push("");

    for (const { label, content } of contextItems) {
      parts.push(`### ${label}`);
      parts.push("");
      parts.push("```");
      parts.push(content);
      parts.push("```");
      parts.push("");
    }
  }

  parts.push("## Your Task");
  parts.push("");
  parts.push("Based on the above context, provide a detailed implementation plan that addresses the user's request. Structure your response as:");
  parts.push("");
  parts.push("1. **Analysis**: Briefly summarize what needs to be done and why");
  parts.push("2. **Approach**: Describe the high-level strategy");
  parts.push("3. **Implementation Steps**: Provide numbered, actionable steps the agent can follow");
  parts.push("4. **Considerations**: Note any edge cases, potential issues, or things to watch for");
  parts.push("");
  parts.push("Keep the plan focused and actionable. The executing agent is good at following instructions but not at planning, so be explicit about what to do at each step.");

  return parts.join("\n");
}

/**
 * Invokes a planning model using pi's SDK
 */
async function callPlanningModel(
  provider: string,
  modelId: string,
  prompt: string,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<string> {
  // Find the specified model
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) {
    throw new Error(
      `Model not found: ${provider}/${modelId}\n` +
        `Available models can be listed with: /superagent models\n` +
        `Make sure the provider is configured in pi.`,
    );
  }

  // Create a temporary session for the planning model
  const planningSession = await createAgentSession({
    model,
    authStorage: ctx.modelRegistry["authStorage"],
    modelRegistry: ctx.modelRegistry,
    sessionManager: SessionManager.inMemory(),
    tools: [],
    noTools: "all",
  });

  try {
    let response = "";
    let errorMessage: string | undefined;

    // Subscribe to get the response
    const unsubscribe = planningSession.session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        response += event.assistantMessageEvent.delta;
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        if (event.message.stopReason === "error") {
          errorMessage = event.message.errorMessage;
        }
      }
    });

    try {
      // Send the prompt to the planning model
      await planningSession.session.prompt(prompt);

      if (errorMessage) {
        throw new Error(`Planning model error: ${errorMessage}`);
      }

      if (!response) {
        throw new Error("Planning model returned an empty response");
      }

      return response;
    } finally {
      unsubscribe();
    }
  } finally {
    // Clean up the temporary session
    planningSession.session.dispose();
  }
}

export default function superagentExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "superagent_plan",
    label: "Superagent Plan",
    description: "Ask a strong reasoning model to create an implementation plan. Use the superagent skill prior to calling this tool to understand proper usage.",
    promptSnippet: "Request a strategic plan from a strong reasoning model",
    promptGuidelines: [
      "Use superagent_plan when you need strategic architecture or complex reasoning that would benefit from a stronger model's judgment.",
      "Load the superagent skill and follow its guidance to gather relevant context before invoking this tool.",
    ],
    // parameter descriptions are intentionally omitted to save tokens under normal usage
    // because the agent will load up the skill prior to calling this tool
    parameters: Type.Object({
      provider: Type.String(),
      model: Type.String(),
      userQuery: Type.String(),
      planContextToolCallIds: Type.Optional(Type.Array(Type.String())),
      fileContents: Type.Optional(Type.Array(Type.String())),
      additionalContext: Type.Optional(Type.String()),
      maxContextBytes: Type.Optional(Type.Number({ minimum: 10000, maximum: 500000 })),
    }),

    async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled" }], details: undefined };
      }

      try {
        const maxContextBytes = params.maxContextBytes || DEFAULT_MAX_CONTEXT_BYTES;

        onUpdate?.({
          content: [{ type: "text", text: "Gathering context..." }],
        });

        // Gather context from various sources
        let allContextItems: Array<{ label: string; content: string }> = [];
        let totalBytes = 0;
        let truncated = false;

        // Gather from tool call IDs if provided
        if (params.planContextToolCallIds && params.planContextToolCallIds.length > 0) {
          onUpdate?.({ content: [{ type: "text", text: "Extracting context from previous tool results..." }] });
          const toolResult = gatherContextFromToolCalls(params.planContextToolCallIds, ctx, maxContextBytes);
          allContextItems = toolResult.items;
          totalBytes = toolResult.totalBytes;
          truncated = toolResult.truncated;
        }

        // Gather from directly provided file paths if provided
        if (params.fileContents && params.fileContents.length > 0) {
          onUpdate?.({ content: [{ type: "text", text: "Reading provided file paths..." }] });
          const remaining = maxContextBytes - totalBytes;
          if (remaining > 1000) {
            const fileResult = await gatherContextFromFilePaths(params.fileContents, remaining, (cmd, args) => pi.exec(cmd, args));
            allContextItems.push(...fileResult.items);
            totalBytes += fileResult.totalBytes;
            truncated = truncated || fileResult.truncated;
          } else {
            truncated = true;
          }
        }

        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Cancelled" }], details: undefined };
        }

        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Context gathered (${allContextItems.length} items, ~${Math.ceil(totalBytes / 1000)}KB). Calling ${params.provider}/${params.model} for strategic planning...`,
            },
          ],
        });

        // Build the prompt
        const prompt = buildSuperagentPrompt(
          params.userQuery,
          allContextItems,
          params.additionalContext,
        );

        // Call the planning model using pi's SDK
        const plan = await callPlanningModel(params.provider, params.model, prompt, ctx, signal);

        if (!plan) {
          throw new Error("Planning model returned an empty plan");
        }

        // Calculate token estimate
        const promptBytes = Buffer.byteLength(prompt, "utf8");
        const responseBytes = Buffer.byteLength(plan, "utf8");
        const inputTokens = Math.ceil(promptBytes / 4); // Rough estimate
        const outputTokens = Math.ceil(responseBytes / 4);

        const resultParts: string[] = [];
        resultParts.push(`# Strategic Plan from ${params.provider}/${params.model}`);
        resultParts.push("");
        resultParts.push(plan);
        resultParts.push("");
        resultParts.push("---");
        resultParts.push("");
        resultParts.push("**Context Summary:**");
        resultParts.push(`- Context items: ${allContextItems.length}`);
        resultParts.push(`- Total context: ~${Math.ceil(totalBytes / 1000)}KB`);
        resultParts.push(`- Estimated tokens: ~${inputTokens} input, ~${outputTokens} output`);

        if (truncated) {
          resultParts.push("- ⚠️ Some context was truncated to fit budget");
        }

        return {
          content: [{ type: "text", text: resultParts.join("\n") }],
          details: {
            model: `${params.provider}/${params.model}`,
            contextItems: allContextItems.length,
            contextBytes: totalBytes,
            estimatedInputTokens: inputTokens,
            estimatedOutputTokens: outputTokens,
            truncated,
          },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        throw new Error(`Superagent planning failed: ${errorMsg}`);
      }
    },
  });

  // Log successful load
  pi.on("session_start", async () => {
    console.log("[pi-superagent] Loaded - use superagent_plan tool with any configured provider/model");
  });
}
