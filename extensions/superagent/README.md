# pi-superagent Extension

**Invert the agent hierarchy: let cheap models do the work, expensive models do the thinking.**

## Overview

`pi-superagent` inverts the traditional strong-model-drives-weak-subagents pattern. Instead of a strong model spinning up weak subagents to do implementation work:

1. The **weak model** does all the research and context gathering
2. It packages everything into a **single prompt**
3. Sends it to **any strong model you specify** to create a plan
4. The **weak model executes** the plan

## Why This Matters

### Cost Savings

- **Single strong model invocation**: No multi-turn conversations with expensive models
- **No cache interactions**: Cache-reads add up quickly in long workflows
- **Minimal output tokens**: Strong model only generates a plan, not implementations
- **Weak model does heavy lifting**: All reads, searches, and executions use the cheap model

### Performance Match

This technique achieves **equivalent or better results** compared to:
- Strong model doing all the research itself (but costs way more)
- Strong model using weak subagents to survey a project (same outcome, higher cost)

### Hybrid Setup Optimization

Perfect for **weak/strong model hybrid setups**:
- Weak agent-focused models are **excellent at following instructions**
- Weak agent-focused models are **borderline terrible at planning**
- Strong reasoning models are **excellent at planning**
- Strong reasoning models are **expensive per token**

Solution: Weak model gathers info, strong model plans, weak model executes. Minimal strong model costs.

## Usage

The included `superagent` skill should be used to invoke the planning process. You can specify any model from any provider that you have configured in pi. The skill will direct the model to gather the correct context, and then execute the prompt against the strong model to get a detailed implementation plan.

### Direct Tool Usage

Directly calling the tool allows you to specify exactly which tool results to include as context, and which model to use for planning. The skill already directs the agent in the proper usage of the tool, but you can also prompt `pi` to call it directly if you want more control.

```json
{
  "tool": "superagent_plan",
  "parameters": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "userQuery": "Implement user authentication with JWT tokens",
    "planContextToolCallIds": ["tool-call-123", "tool-call-456"],
    "fileContents": ["src/server.ts", "src/routes/auth.ts"],
    "additionalContext": "We're using Express.js and PostgreSQL",
    "maxContextBytes": 100000
  }
}
```

### Example Workflow

```
You: "/superagent I need to refactor the authentication system to support OAuth2"

Weak Model: [gathers relevant files with 'read' tool]
Weak Model: [runs diagnostic commands with 'bash' tool]
Weak Model: [calls superagent_plan with tool call IDs and anthropic/claude-sonnet-4-20250514]
Strong Model: [returns detailed implementation plan]
Weak Model: [executes the plan step by step]
```

### Tool Parameters

- **provider** (required): Provider name (e.g., "anthropic", "openai", "openrouter")
- **model** (required): Model ID (e.g., "claude-sonnet-4-20250514", "o1", "gpt-4o")
- **userQuery** (required): The task that needs planning
- **planContextToolCallIds** (optional): Array of tool call IDs from previous tool invocations (read, bash, grep, find, etc.) to include as context
- **fileContents** (optional): Array of file paths to read and include as context (more efficient if files haven't been read yet)
- **additionalContext** (optional): Any extra context to include
- **maxContextBytes** (optional): Max context budget in bytes (default: 100000)

## When to Use

### ✅ Good Use Cases

- **Strategic planning**: Architecture decisions, refactoring strategies
- **Complex reasoning**: Tradeoff analysis, design pattern selection
- **Cost-sensitive workflows**: Long multi-turn tasks where cache costs add up
- **Upfront planning**: Tasks that benefit from a complete plan before execution

### ❌ Not Recommended

- **Simple tasks**: Things the weak model can handle directly
- **Iterative discovery**: Tasks that need back-and-forth exploration
- **Already planned**: When you know exactly what to do
- **Real-time decisions**: Tool calls that need immediate responses

---

## Cost Comparison

### Traditional Approach: Strong Model Does Everything

```
Turn 1: Read files (cache write: 10K tokens)
Turn 2: Run commands (cache read: 10K, write: 5K)
Turn 3: Analyze results (cache read: 15K, write: 2K)
Turn 4: Create plan (cache read: 17K, output: 2K)
Turn 5-10: Execute plan...

Total: ~60K cache reads, ~20K cache writes, ~5K output
Cost: HIGH (cache-read × many turns)
```

### pi-superagent Approach

```
Weak model: Read files, run commands (weak model cost: $0 or negligible)
Strong model: One planning call (input: 25K, output: 2K)
Weak model: Execute plan (weak model cost: $0 or negligible)

Total: 25K input, 2K output, 0 cache interactions
Cost: LOW (single strong model call)
```
