/**
 * Scheduler Extension
 *
 * Manages scheduled agent tasks via supercronic (cron for containers).
 * Tasks are stored in /workspace/.scheduler.crontab and executed by supercronic.
 *
 * Each task runs `pi --mode print` in the workspace directory,
 * spawning an isolated agent session for that task.
 *
 * Commands (via /task):
 *   /task schedule <name> <prompt> [interval]  — create a scheduled task
 *   /task list                                  — show all scheduled tasks
 *   /task delete <name>                         — remove a scheduled task
 *
 * Interval formats:
 *   - Human-readable: 5m, 2h, 1d (converted to cron syntax)
 *   - Cron syntax: star-slash-5 space star space star space star space star (every 5 minutes)
 *
 * Prompt options:
 *   - prompt: inline string (max 500 characters)
 *   - promptFile: path to a file containing the prompt (workspace-relative or absolute)
 *   - Newlines in inline prompts are automatically converted to spaces
 *
 * Advanced options:
 *   - tools: array of allowed tool names (e.g., ["read", "grep", "find"])
 *   - skills: array of skill names (e.g., ["notify", "scheduled-tasks"])
 *   - model: model pattern or ID (e.g., "sonnet", "gpt-4o")
 *   - ephemeralSession: don't save session to disk
 *
 * The crontab file format stores metadata as comments with TASK and PROMPT directives
 * followed by the cron schedule line that executes pi in print mode.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// ── constants ─────────────────────────────────────────────────────────────────
// Store crontab in workspace so it persists across container restarts
const CRONTAB_PATH = "/workspace/.scheduler.crontab";
const LOG_PREFIX = "[scheduler]";
const MAX_PROMPT_LENGTH = 500; // Characters - keep prompts concise

// ── types ─────────────────────────────────────────────────────────────────────
interface TaskDefinition {
  name: string;
  prompt?: string; // inline prompt (mutually exclusive with promptFile)
  promptFile?: string; // path to prompt file (mutually exclusive with prompt)
  cron: string; // cron expression
  created_at: number; // epoch ms
  // Optional pi flags
  tools?: string; // comma-separated tool list (stored as string in crontab)
  skills?: string; // comma-separated skill names (stored as string in crontab)
  model?: string; // model pattern
  ephemeralSession?: boolean; // don't save session
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse interval string (e.g., "5m", "2h", "30s") to cron syntax.
 * Returns null if input is invalid or if it's already valid cron syntax.
 */
function intervalToCron(input: string): string | null {
  // If it contains spaces, assume it's cron syntax
  if (input.includes(" ")) {
    return input; // Pass through as-is (validated later)
  }

  const match = input.match(/^(\d+)(s|m|h|d)?$/);
  if (!match) return null;

  const [, num, unit = "s"] = match;
  const n = parseInt(num, 10);

  switch (unit) {
    case "s":
      // Cron doesn't support seconds, round up to minutes
      if (n < 60) return "* * * * *"; // Every minute
      return `*/${Math.ceil(n / 60)} * * * *`;
    case "m":
      if (n === 1) return "* * * * *"; // Every minute
      if (n < 60) return `*/${n} * * * *`; // Every N minutes
      return `0 */${Math.ceil(n / 60)} * * *`; // Every N hours
    case "h":
      if (n === 1) return "0 * * * *"; // Every hour
      if (n < 24) return `0 */${n} * * *`; // Every N hours
      return `0 0 */${Math.ceil(n / 24)} * *`; // Every N days
    case "d":
      if (n === 1) return "0 0 * * *"; // Daily at midnight
      return `0 0 */${n} * *`; // Every N days
    default:
      return null;
  }
}

/**
 * Format cron expression to human-readable string (best effort).
 */
function cronToHuman(cron: string): string {
  if (cron === "* * * * *") return "every minute";
  if (cron === "0 * * * *") return "hourly";
  if (cron === "0 0 * * *") return "daily";
  if (cron.match(/^\*\/(\d+) \* \* \* \*$/)) {
    const m = cron.match(/^\*\/(\d+) \* \* \* \*$/);
    return `every ${m![1]} minutes`;
  }
  if (cron.match(/^0 \*\/(\d+) \* \* \*$/)) {
    const m = cron.match(/^0 \*\/(\d+) \* \* \*$/);
    return `every ${m![1]} hours`;
  }
  if (cron.match(/^0 0 \*\/(\d+) \* \*$/)) {
    const m = cron.match(/^0 0 \*\/(\d+) \* \*$/);
    return `every ${m![1]} days`;
  }
  return cron; // Fall back to showing the raw cron syntax
}

/**
 * Escape a string for safe inclusion in a bash command.
 */
function escapeShell(str: string): string {
  return str.replace(/'/g, "'\\''");
}

/**
 * Validate and sanitize a prompt for crontab usage.
 * Returns an error message if invalid, or the sanitized prompt if valid.
 */
function validatePrompt(prompt: string): { valid: boolean; sanitized?: string; error?: string } {
  // Check for empty prompt
  if (!prompt || prompt.trim().length === 0) {
    return { valid: false, error: "Prompt cannot be empty." };
  }

  // Check length
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return {
      valid: false,
      error: `Prompt too long (${prompt.length} chars, max ${MAX_PROMPT_LENGTH}). ` +
        "Use the promptFile parameter to reference a file containing your instructions.",
    };
  }

  // Check for newlines and sanitize
  if (prompt.includes("\n") || prompt.includes("\r")) {
    // Replace newlines with spaces
    const sanitized = prompt.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    
    // After sanitization, check if it's still too long
    if (sanitized.length > MAX_PROMPT_LENGTH) {
      return {
        valid: false,
        error: "Prompt too long after removing newlines. Use the promptFile parameter instead.",
      };
    }

    return { valid: true, sanitized };
  }

  return { valid: true, sanitized: prompt.trim() };
}

/**
 * Read and parse the crontab file into TaskDefinition objects.
 */
function readCrontab(): TaskDefinition[] {
  if (!fs.existsSync(CRONTAB_PATH)) {
    return [];
  }

  const content = fs.readFileSync(CRONTAB_PATH, "utf8");
  const lines = content.split("\n");
  const tasks: TaskDefinition[] = [];

  let currentTask: Partial<TaskDefinition> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Parse TASK comment
    if (trimmed.startsWith("# TASK: ")) {
      if (currentTask) {
        console.error(`${LOG_PREFIX} Warning: incomplete task definition, missing cron line`);
      }
      currentTask = {
        name: trimmed.slice(8).trim(),
        created_at: Date.now(), // Default, will be overridden if CREATED_AT comment exists
      };
      continue;
    }

    // Parse PROMPT comment
    if (trimmed.startsWith("# PROMPT: ") && currentTask) {
      currentTask.prompt = trimmed.slice(10).trim();
      continue;
    }

    // Parse PROMPT_FILE comment
    if (trimmed.startsWith("# PROMPT_FILE: ") && currentTask) {
      currentTask.promptFile = trimmed.slice(15).trim();
      continue;
    }

    // Parse TOOLS comment
    if (trimmed.startsWith("# TOOLS: ") && currentTask) {
      currentTask.tools = trimmed.slice(9).trim();
      continue;
    }

    // Parse SKILLS comment
    if (trimmed.startsWith("# SKILLS: ") && currentTask) {
      currentTask.skills = trimmed.slice(10).trim();
      continue;
    }

    // Parse MODEL comment
    if (trimmed.startsWith("# MODEL: ") && currentTask) {
      currentTask.model = trimmed.slice(9).trim();
      continue;
    }

    // Parse EPHEMERAL_SESSION comment
    if (trimmed.startsWith("# EPHEMERAL_SESSION: ") && currentTask) {
      currentTask.ephemeralSession = trimmed.slice(21).trim() === "true";
      continue;
    }

    // Parse CREATED_AT comment (optional)
    if (trimmed.startsWith("# CREATED_AT: ") && currentTask) {
      currentTask.created_at = parseInt(trimmed.slice(14).trim(), 10);
      continue;
    }

    // Parse cron line (non-comment, non-empty)
    if (!trimmed.startsWith("#") && trimmed.length > 0 && currentTask) {
      // Extract cron expression (first 5 fields)
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 6) {
        currentTask.cron = parts.slice(0, 5).join(" ");

        // Validate we have all required fields
        if (currentTask.name && (currentTask.prompt || currentTask.promptFile) && currentTask.cron) {
          tasks.push(currentTask as TaskDefinition);
        } else {
          console.error(`${LOG_PREFIX} Warning: incomplete task definition:`, currentTask);
        }
      }
      currentTask = null; // Reset for next task
    }
  }

  return tasks;
}

/**
 * Write tasks to the crontab file.
 */
function writeCrontab(tasks: TaskDefinition[]): void {
  const lines: string[] = [
    "# Scheduler crontab — managed by pi scheduler extension",
    "# Do not edit manually; use /task commands",
    "",
  ];

  for (const task of tasks) {
    lines.push(`# TASK: ${task.name}`);
    
    if (task.prompt) {
      lines.push(`# PROMPT: ${task.prompt}`);
    }
    
    if (task.promptFile) {
      lines.push(`# PROMPT_FILE: ${task.promptFile}`);
    }
    
    if (task.tools) {
      lines.push(`# TOOLS: ${task.tools}`);
    }
    
    if (task.skills) {
      lines.push(`# SKILLS: ${task.skills}`);
    }
    
    if (task.model) {
      lines.push(`# MODEL: ${task.model}`);
    }
    
    if (task.ephemeralSession) {
      lines.push(`# EPHEMERAL_SESSION: true`);
    }
    
    lines.push(`# CREATED_AT: ${task.created_at}`);
    
    // Build pi command with all options
    let piCommand = "cd /workspace && pi --mode print";
    
    if (task.tools) {
      piCommand += ` --tools '${escapeShell(task.tools)}'`;
    }
    
    if (task.skills) {
      // Split skills and add each as a separate --skill flag
      // Skills are names; construct path to standard skills directory
      const skillList = task.skills.split(",").map((s) => s.trim());
      for (const skill of skillList) {
        // If it looks like a path (starts with / or .), use as-is; otherwise assume it's in standard location
        const skillPath = skill.startsWith("/") || skill.startsWith(".") 
          ? skill 
          : `~/.pi/agent/skills/${skill}`;
        piCommand += ` --skill '${escapeShell(skillPath)}'`;
      }
    }
    
    if (task.model) {
      piCommand += ` --model '${escapeShell(task.model)}'`;
    }
    
    if (task.ephemeralSession) {
      piCommand += " --no-session";
    }
    
    if (task.promptFile) {
      // Use @file syntax for prompt file
      piCommand += ` '@${escapeShell(task.promptFile)}'`;
    } else if (task.prompt) {
      // Use --message flag for inline prompt
      piCommand += ` --message '${escapeShell(task.prompt)}'`;
    }
    
    lines.push(`${task.cron} ${piCommand}`);
    lines.push("");
  }

  fs.writeFileSync(CRONTAB_PATH, lines.join("\n"), "utf8");
  console.error(`${LOG_PREFIX} Crontab updated: ${tasks.length} task(s)`);
}

// ── extension export ──────────────────────────────────────────────────────────
export default function schedulerExtension(pi: ExtensionAPI) {
  // Ensure crontab exists on startup
  if (!fs.existsSync(CRONTAB_PATH)) {
    writeCrontab([]);
  }

  // ── /task command ────────────────────────────────────────────────────────
  pi.registerCommand("task", {
    description: "Scheduler: /task schedule|list|delete",
    handler: async (args, ctx) => {
      const argv = String(args ?? "")
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);

      const subcommand = (argv[0] ?? "").toLowerCase();

      // ── list ─────────────────────────────────────────────────────────────
      if (subcommand === "list") {
        const tasks = readCrontab();

        if (!tasks.length) {
          ctx.ui.notify("No scheduled tasks.", "info");
          return;
        }

        const rows = tasks.map((t) => {
          const row: Record<string, any> = {
            name: t.name,
            schedule: cronToHuman(t.cron),
            cron: t.cron,
          };
          
          if (t.prompt) {
            row.prompt = t.prompt.length > 60 ? t.prompt.slice(0, 57) + "..." : t.prompt;
          }
          
          if (t.promptFile) {
            row.promptFile = t.promptFile;
          }
          
          if (t.tools) {
            row.tools = t.tools;
          }
          
          if (t.skills) {
            row.skills = t.skills;
          }
          
          if (t.model) {
            row.model = t.model;
          }
          
          if (t.ephemeralSession) {
            row.ephemeralSession = true;
          }
          
          return row;
        });

        ctx.ui.notify(`Scheduled tasks (${tasks.length}):\n${JSON.stringify(rows, null, 2)}`, "info");
      }

      // ── schedule (create) ────────────────────────────────────────────────
      else if (subcommand === "schedule") {
        ctx.ui.notify(
          "The /task schedule command has a simplified interface. " +
          "For full control including promptFile, tools, skills, model, and ephemeralSession, " +
          "use the scheduler_task tool directly.",
          "info",
        );
        
        const name = argv[1]?.trim();
        const intervalOrCron = argv[3]?.trim();

        if (!name) {
          ctx.ui.notify("Usage: /task schedule <name> <prompt> [interval|cron]", "error");
          return;
        }

        if (!argv[2] || argv[2].trim() === "") {
          ctx.ui.notify("Prompt is required.", "error");
          return;
        }

        // Extract prompt (everything between name and optional interval)
        let rawPrompt: string;
        let cron: string;

        if (intervalOrCron) {
          // Prompt is argv[2]
          rawPrompt = argv[2];
          const parsedCron = intervalToCron(intervalOrCron);
          if (!parsedCron) {
            ctx.ui.notify(
              `Invalid interval/cron format: ${intervalOrCron}. Use 5m, 2h, 1d, or cron syntax.`,
              "error",
            );
            return;
          }
          cron = parsedCron;
        } else {
          // No interval specified, use everything from argv[2] onward as prompt
          rawPrompt = argv.slice(2).join(" ");
          cron = "0 * * * *"; // Default: hourly
        }

        // Validate and sanitize prompt
        const validation = validatePrompt(rawPrompt);
        if (!validation.valid) {
          ctx.ui.notify(validation.error!, "error");
          return;
        }
        const prompt = validation.sanitized!;

        const tasks = readCrontab();

        // Check for duplicate name
        if (tasks.some((t) => t.name === name)) {
          ctx.ui.notify(`Task '${name}' already exists. Delete it first.`, "error");
          return;
        }

        const task: TaskDefinition = {
          name,
          prompt,
          cron,
          created_at: Date.now(),
        };

        tasks.push(task);
        writeCrontab(tasks);

        ctx.ui.notify(
          `Task '${name}' scheduled — ${cronToHuman(cron)} (cron: ${cron})`,
          "info",
        );
      }

      // ── delete ───────────────────────────────────────────────────────────
      else if (subcommand === "delete") {
        const name = argv[1]?.trim();
        if (!name) {
          ctx.ui.notify("Usage: /task delete <name>", "error");
          return;
        }

        const tasks = readCrontab();
        const filtered = tasks.filter((t) => t.name !== name);

        if (filtered.length === tasks.length) {
          ctx.ui.notify(`Task '${name}' not found.`, "error");
          return;
        }

        writeCrontab(filtered);
        ctx.ui.notify(`Task '${name}' deleted.`, "info");
      }

      // ── unknown subcommand ───────────────────────────────────────────────
      else {
        ctx.ui.notify(
          [
            "Scheduler commands:",
            "  /task schedule <name> <prompt> [interval]  — create task (interval: 5m, 2h, 1d, or cron)",
            "  /task list                                  — show all tasks",
            "  /task delete <name>                         — remove task",
            "",            "Note: For advanced features (promptFile, tools, skills, model, ephemeralSession),",
            "use the scheduler_task tool directly.",
            "",            "Examples:",
            "  /task schedule hourly-check 'Check system status' 1h",
            "  /task schedule nightly 'Generate daily report' '0 2 * * *'",
          ].join("\n"),
          "info",
        );
      }
    },
  });

  // ── tool: for the agent to manage scheduler tasks programmatically ─────
  pi.registerTool({
    name: "scheduler_task",
    label: "Scheduler Task",
    description:
      "Manage scheduled agent tasks via supercronic. Actions: schedule, list, delete. " +
      "Tasks run in the workspace directory using `pi --mode print`. " +
      "Supports promptFile (via @file syntax), tools allowlist, skills, model selection, and ephemeral sessions.",
    parameters: Type.Object({
      action: Type.String({ description: "schedule|list|delete" }),
      name: Type.Optional(Type.String({ description: "Task name (required for schedule/delete)" })),
      prompt: Type.Optional(Type.String({ description: "Inline prompt text (max 500 chars, mutually exclusive with promptFile)" })),
      promptFile: Type.Optional(Type.String({ description: "Path to prompt file (workspace-relative or absolute, mutually exclusive with prompt)" })),
      interval: Type.Optional(
        Type.String({
          description: "Schedule interval: 5m, 2h, 1d, or cron syntax (e.g., '*/5 * * * *'). Default: hourly",
        }),
      ),
      tools: Type.Optional(Type.Array(Type.String(), { description: "Array of allowed tool names (e.g., ['read', 'grep', 'find'])" })),
      skills: Type.Optional(Type.Array(Type.String(), { description: "Array of skill names (e.g., ['notify', 'scheduled-tasks'])" })),
      model: Type.Optional(Type.String({ description: "Model pattern or ID (e.g., 'sonnet', 'gpt-4o')" })),
      ephemeralSession: Type.Optional(Type.Boolean({ description: "Don't save session to disk" })),
    }),
    async execute(_toolCallId, params) {
      const action = params.action.toLowerCase();

      if (action === "list") {
        const tasks = readCrontab();
        if (!tasks.length) {
          return { content: [{ type: "text", text: "No scheduled tasks." }], details: {} };
        }

        const rows = tasks.map((t) => {
          const row: Record<string, any> = {
            name: t.name,
            schedule: cronToHuman(t.cron),
            cron: t.cron,
          };
          
          if (t.prompt) {
            row.prompt = t.prompt.slice(0, 80);
          }
          
          if (t.promptFile) {
            row.promptFile = t.promptFile;
          }
          
          if (t.tools) {
            row.tools = t.tools;
          }
          
          if (t.skills) {
            row.skills = t.skills;
          }
          
          if (t.model) {
            row.model = t.model;
          }
          
          if (t.ephemeralSession) {
            row.ephemeralSession = true;
          }
          
          return row;
        });
        
        return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }], details: {} };
      }

      if (action === "schedule") {
        const name = params.name?.trim() ?? "";
        const rawPrompt = params.prompt ?? "";
        const promptFile = params.promptFile?.trim();
        const intervalInput = params.interval ?? "1h";
        // Convert arrays to comma-separated strings for storage
        const tools = params.tools ? params.tools.join(",") : undefined;
        const skills = params.skills ? params.skills.join(",") : undefined;
        const model = params.model?.trim();
        const ephemeralSession = params.ephemeralSession ?? false;

        if (!name) {
          return { content: [{ type: "text", text: "Error: name is required." }], details: {} };
        }

        // Validate mutually exclusive prompt options
        if (rawPrompt && promptFile) {
          return { 
            content: [{ type: "text", text: "Error: prompt and promptFile are mutually exclusive. Provide only one." }], 
            details: {} 
          };
        }

        if (!rawPrompt && !promptFile) {
          return { 
            content: [{ type: "text", text: "Error: either prompt or promptFile is required." }], 
            details: {} 
          };
        }

        let prompt: string | undefined;
        
        // Validate inline prompt if provided
        if (rawPrompt) {
          const validation = validatePrompt(rawPrompt);
          if (!validation.valid) {
            return { content: [{ type: "text", text: `Error: ${validation.error}` }], details: {} };
          }
          prompt = validation.sanitized!;
        }

        // Validate promptFile exists if provided
        if (promptFile) {
          const filePath = path.isAbsolute(promptFile) ? promptFile : path.join("/workspace", promptFile);
          if (!fs.existsSync(filePath)) {
            return { 
              content: [{ type: "text", text: `Error: promptFile '${promptFile}' does not exist.` }], 
              details: {} 
            };
          }
        }

        const cron = intervalToCron(intervalInput);
        if (!cron) {
          return {
            content: [{ type: "text", text: `Error: invalid interval '${intervalInput}'. Use 5m, 2h, 1d, or cron syntax.` }],
            details: {},
          };
        }

        const tasks = readCrontab();

        if (tasks.some((t) => t.name === name)) {
          return { content: [{ type: "text", text: `Task '${name}' already exists.` }], details: {} };
        }

        const task: TaskDefinition = {
          name,
          prompt,
          promptFile,
          cron,
          created_at: Date.now(),
          tools,
          skills,
          model,
          ephemeralSession,
        };

        tasks.push(task);
        writeCrontab(tasks);

        const optionsDesc = [
          tools && `tools: ${tools}`,
          skills && `skills: ${skills}`,
          model && `model: ${model}`,
          ephemeralSession && "ephemeral session",
        ].filter(Boolean).join(", ");

        return {
          content: [{ 
            type: "text", 
            text: `Task '${name}' scheduled — ${cronToHuman(cron)} (cron: ${cron})` +
                  (optionsDesc ? `\nOptions: ${optionsDesc}` : "")
          }],
          details: {},
        };
      }

      if (action === "delete") {
        const name = params.name?.trim() ?? "";
        if (!name) {
          return { content: [{ type: "text", text: "Error: name is required." }], details: {} };
        }

        const tasks = readCrontab();
        const filtered = tasks.filter((t) => t.name !== name);

        if (filtered.length === tasks.length) {
          return { content: [{ type: "text", text: `Task '${name}' not found.` }], details: {} };
        }

        writeCrontab(filtered);
        return { content: [{ type: "text", text: `Task '${name}' deleted.` }], details: {} };
      }

      return {
        content: [{ type: "text", text: `Unknown action '${action}'. Use: schedule, list, delete.` }],
        details: {},
      };
    },
  });
}
