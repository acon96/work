# Superagent Planning Skill

Use this skill when the user requests strategic planning, architectural decisions, or complex reasoning that requires a stronger model's judgment.

## When to Invoke

- User asks for refactoring strategies or architecture decisions  
- Task requires complex reasoning about tradeoffs
- Need to plan a multi-step implementation
- User specifically mentions planning or asks "how should I..."

## Workflow

### 1. Determine if Superagent is Needed

First, assess whether the local model can handle the task directly or if strategic planning from a stronger model would be beneficial.

**Use superagent planning when:**
- Task involves architectural decisions (which pattern to use, how to structure code)
- Multiple valid approaches exist and need expert judgment
- Complex refactoring with many interdependencies
- User explicitly requests planning or a strategy

**Don't use superagent planning for:**
- Simple, well-defined tasks (add a function, fix a typo)
- Following existing patterns (just do it)
- Tasks where you already know the approach

### 2. Check for Model Specification

Check if the user specified a planning model in their request.

**If model specified:**
- Extract the provider and model from their request
- Examples: "use Claude Sonnet 4", "plan with o1", "use anthropic/claude-sonnet-4-20250514"

**If NO model specified:**
- Prompt the user to choose a planning model
- Show available options using `/superagent models`
- Recommended models:
  - `anthropic/claude-sonnet-4-20250514` - Strong reasoning, good code understanding
  - `openai/o1` - Extended reasoning for complex problems
  - `openai/gpt-4o` - Balanced speed and quality

### 3. Gather Context

Use your built-in `read` and `bash` tools to gather relevant context. **Be selective** - only include files and commands that are directly relevant to the task.

**Gather file context:**
```
read src/relevant-file-1.ts
read src/relevant-file-2.ts
read package.json
```

Store the tool call IDs from these `read` invocations - you'll reference them later.

**Gather diagnostic context:**
```
bash git log --oneline -20 src/feature/
bash npm list relevant-package
bash tree src/feature -L 2
```

Store the tool call IDs from these `bash` invocations.

**Guidelines for context gathering:**
- **DO** include files directly related to the task
- **DO** run diagnostic commands that provide useful insights
- **DO** check git history for relevant changes
- **DON'T** read entire directories - be selective
- **DON'T** include node_modules or generated files
- **DON'T** run commands with huge output (no `cat` on large logs)

### 4. Call Superagent Plan

Once you have gathered context, call the `superagent_plan` tool with:

```json
{
  "tool": "superagent_plan",
  "parameters": {
    "provider": "<provider from step 2>",
    "model": "<model from step 2>",
    "userQuery": "<original user request>",
    "readToolCallIds": ["<id-from-read-1>", "<id-from-read-2>", ...],
    "bashToolCallIds": ["<id-from-bash-1>", "<id-from-bash-2>", ...],
    "additionalContext": "<optional: any constraints, preferences, or requirements>"
  }
}
```

**Important:**
- Use `readToolCallIds` to reference your previous `read` tool calls
- Use `bashToolCallIds` to reference your previous `bash` tool calls
- Do NOT paste large file contents or command outputs directly
- The tool will extract the results from your previous tool calls automatically

**Alternative:** If you have small amounts of context, you can use `fileContents` and `commandOutputs` arrays directly instead of tool call IDs.

### 5. Execute the Plan

Once you receive the plan from the superagent:

1. **Review** the plan to ensure it makes sense
2. **Execute step-by-step** using your built-in tools (`read`, `write`, `edit`, `bash`)
3. **Report progress** as you complete each major step
4. **Handle errors** gracefully and adapt if needed

## Example Interaction

**User:** "I need to refactor our authentication system to support OAuth2 with GitHub and Google providers"

**Your Response:**

1. First, let me check what model you'd like to use for planning this refactoring.

Available strong models:
- `anthropic/claude-sonnet-4-20250514` (recommended for refactoring)
- `openai/o1` (deep reasoning)
- `openai/gpt-4o` (balanced)

Which would you prefer, or should I use Claude Sonnet 4?

**User:** "Use Claude Sonnet 4"

**Your Actions:**

```
// Gather context
read src/auth/auth-service.ts
read src/auth/user-model.ts  
read src/routes/auth-routes.ts
read package.json

bash git log --oneline -20 src/auth/
bash npm list passport express-session
bash tree src/auth -L 2

// Call superagent with the tool call IDs
superagent_plan({
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  userQuery: "Refactor authentication to support OAuth2 with GitHub and Google providers",
  readToolCallIds: ["<call-1>", "<call-2>", "<call-3>", "<call-4>"],
  bashToolCallIds: ["<call-5>", "<call-6>", "<call-7>"],
  additionalContext: "Using Express.js with TypeScript. Current auth is username/password with bcrypt. Database is PostgreSQL via Prisma."
})
```

**After receiving plan:**

I've received a strategic plan from Claude Sonnet 4. Here's the approach:

[Display summary of plan]

Now executing the implementation:

1. Installing OAuth dependencies... ✓
2. Updating User model... ✓
3. Creating OAuth strategies... ✓
[etc.]

## Tips

- **Context quality matters**: Better context = better plans
- **Be concise**: Don't overload with unnecessary files
- **Use tool call IDs**: More efficient than pasting content
- **Follow the plan**: The strong model has done the hard thinking
- **Adapt when needed**: If you encounter issues during execution, handle them

## Cost Optimization

- Gather context locally (free)
- Send to strong model ONCE (single API call)
- Execute locally (free)
- Total cost: One strong model invocation vs. many turns

This approach saves 60-80% compared to having the strong model do everything.
