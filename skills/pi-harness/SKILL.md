---
name: pi-harness
description: Use this skill when the user asks about pi.dev harness behavior, extension development, SDK usage, models/providers configuration, sessions, compaction, or prompt assembly.
---
# Pi Harness Site Map (SDK + Extensions)

Use this as the primary reference map for pi.dev architecture and implementation paths.

## When to invoke

Invoke this skill when the task involves:
- How Pi builds or modifies system prompts
- Extension lifecycle/events/tools/commands
- SDK programmatic usage or embedding
- Session model, context compaction, and persistence
- Provider/model configuration and custom providers
- Skills, prompt templates, themes, TUI components

## Extension API surface map

### High-value events

- `before_agent_start` — inspect/replace `systemPrompt`
- `tool_call` — inspect/mutate/block tool inputs
- `tool_result` — inspect/transform tool outputs
- `before_provider_request` / `before_provider_headers` / `after_provider_response` — provider pipeline hooks
- `session_start`, `session_tree`, `session_shutdown` — session lifecycle hooks

### Core extension capabilities

- Register tools with schemas and async execution handlers
- Register slash commands and completions
- Add custom messages/entries and renderers
- Persist/replay extension state via session entries

## SDK surface map

- **Session creation/runtime**: `createAgentSession`, `AgentSessionRuntime`
- **Resource loading**: `DefaultResourceLoader` for context files, skills, extensions
- **Built-in tools**: read/write/edit/bash/grep/find/ls tool definitions and wrappers
- **Model/runtime**: provider selection, thinking level, retries, auth storage

## Documentation site map (pi.dev)

Start here:
- `/docs/latest/` overview and quickstart

Customization:
- `/docs/latest/extensions` — extension model, events, tools, commands
- `/docs/latest/skills` — skill format and invocation behavior
- `/docs/latest/prompt-templates` — prompt customization strategy
- `/docs/latest/themes` — theme and UI customization
- `/docs/latest/packages` — package-distributed resources
- `/docs/latest/models` — model definitions
- `/docs/latest/custom-provider` — custom provider wiring

Runtime behavior:
- `/docs/latest/sessions` — session tree and persistence behavior
- `/docs/latest/compaction` — context trimming and summarization
- `/docs/latest/settings` — settings precedence and defaults
- `/docs/latest/providers` — provider lifecycle and configuration

Programmatic usage:
- `/docs/latest/sdk` — embedding and programmatic control
- `/docs/latest/rpc` — RPC mode integration
- `/docs/latest/json` — JSON event stream mode
- `/docs/latest/tui` — TUI components and rendering hooks

## Practical guidance

1. Read relevant docs sections first for harness/API questions.
2. Prefer extension hooks over patching core behavior where possible.
3. Keep prompt modifications deterministic and minimal.
4. Preserve user/project context loading (`context files`, `skills`, `cwd`) when replacing default prompt text.
5. For tool behavior changes, prefer `tool_call`/`tool_result` handlers over global prompt-only instructions.
