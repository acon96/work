/**
 * Scheduler Extension
 *
 * Manages scheduled agent tasks via supercronic (cron for containers).
 * Tasks are stored in ~/scheduler.crontab and executed by supercronic.
 *
 * Each task runs `pi --mode print --message "<prompt>"` in the workspace directory,
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
 * The crontab file format stores metadata as comments with TASK and PROMPT directives
 * followed by the cron schedule line that executes pi in print mode.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── constants ─────────────────────────────────────────────────────────────────
const CRONTAB_PATH = path.join(os.homedir(), "scheduler.crontab");
const LOG_PREFIX = "[scheduler]";

// ── types ─────────────────────────────────────────────────────────────────────
interface TaskDefinition {
  name: string;
  prompt: string;
  cron: string; // cron expression
  created_at: number; // epoch ms
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
        if (currentTask.name && currentTask.prompt && currentTask.cron) {
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
    lines.push(`# PROMPT: ${task.prompt}`);
    lines.push(`# CREATED_AT: ${task.created_at}`);
    const escapedPrompt = escapeShell(task.prompt);
    lines.push(`${task.cron} cd /workspace && pi --mode print --message '${escapedPrompt}'`);
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

        const rows = tasks.map((t) => ({
          name: t.name,
          prompt: t.prompt.length > 60 ? t.prompt.slice(0, 57) + "..." : t.prompt,
          schedule: cronToHuman(t.cron),
          cron: t.cron,
        }));

        ctx.ui.notify(`Scheduled tasks (${tasks.length}):\n${JSON.stringify(rows, null, 2)}`, "info");
      }

      // ── schedule (create) ────────────────────────────────────────────────
      else if (subcommand === "schedule") {
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
        let prompt: string;
        let cron: string;

        if (intervalOrCron) {
          // Prompt is argv[2]
          prompt = argv[2];
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
          prompt = argv.slice(2).join(" ");
          cron = "0 * * * *"; // Default: hourly
        }

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
            "",
            "Examples:",
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
      "Tasks run in the workspace directory using `pi --mode print`.",
    parameters: Type.Object({
      action: Type.String({ description: "schedule|list|delete" }),
      name: Type.Optional(Type.String({ description: "Task name (required for schedule/delete)" })),
      prompt: Type.Optional(Type.String({ description: "Prompt text (required for schedule)" })),
      interval: Type.Optional(
        Type.String({
          description: "Schedule interval: 5m, 2h, 1d, or cron syntax (e.g., '*/5 * * * *'). Default: hourly",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const action = params.action.toLowerCase();

      if (action === "list") {
        const tasks = readCrontab();
        if (!tasks.length) {
          return { content: [{ type: "text", text: "No scheduled tasks." }], details: {} };
        }

        const rows = tasks.map((t) => ({
          name: t.name,
          prompt: t.prompt.slice(0, 80),
          schedule: cronToHuman(t.cron),
          cron: t.cron,
        }));
        return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }], details: {} };
      }

      if (action === "schedule") {
        const name = params.name?.trim() ?? "";
        const prompt = params.prompt ?? "";
        const intervalInput = params.interval ?? "1h";

        if (!name || !prompt) {
          return { content: [{ type: "text", text: "Error: name and prompt are required." }], details: {} };
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
          cron,
          created_at: Date.now(),
        };

        tasks.push(task);
        writeCrontab(tasks);

        return {
          content: [{ type: "text", text: `Task '${name}' scheduled — ${cronToHuman(cron)} (cron: ${cron})` }],
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
