---
name: scheduled-tasks
description: manage scheduled tasks
---

# Scheduled Tasks Skill

Use the scheduler_task tool to create background tasks that run agent prompts on a recurring schedule. Tasks run automatically as isolated agent sessions in the workspace.

## Tool: scheduler_task

Parameters:
- action (required): "schedule", "list", or "delete"
- name (required for schedule/delete): task identifier
- prompt (required for schedule): instruction for agent to execute (max 500 chars; newlines converted to spaces)
- interval (optional): schedule timing, default "1h"

### Actions

schedule - Create recurring task. Example: `{"action": "schedule", "name": "system-check", "prompt": "Check logs for errors", "interval": "1h"}`

list - Show all tasks. Example: `{"action": "list"}`

delete - Remove task. Example: `{"action": "delete", "name": "system-check"}`

### Supported Intervals

Supports arbitrary numbers with units: m (minutes), h (hours), d (days). Example: 1m, 30m, 1h, 2h, 1d, 7d (converted to cron)

Also supports raw cron syntax: `*/5 * * * *` (every 5 min), `0 */2 * * *` (every 2 hours), `0 2 * * *` (daily 2am), `30 9 * * 1-5` (weekdays 9:30am)

## Constraints

- Task names must be unique (delete first to replace)
- Prompts limited to 500 characters
- Newlines in prompts converted to spaces
- For complex instructions, write to file and reference: "Read and execute prompts/scheduler-tasks/task.md"

## Notes

- Changes take effect immediately
- Tasks run at next scheduled time after creation
- Use descriptive names: hourly-backup, daily-cleanup, not task1
- Keep prompts under 500 chars or use instruction files
- Shell variables like $(date +%F) work in prompts
