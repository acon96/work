---
name: notify
description: Send background-triggered notifications to the user via ntfy.sh push notifications using curl
---

# Notify Skill

Send push notifications to the user's device when background-triggered events occur (e.g. long-running jobs, CI pipelines, scheduled tasks). Uses [ntfy.sh](https://ntfy.sh) as the push notification service.

## Prerequisites

The user must have the ntfy app installed on their phone and subscribed to a topic. The topic name is user-defined and acts as a "password" — pick something unique and hard to guess.

## Basic Usage

```bash
curl -d "Background job completed successfully" ntfy.sh/<topic>
```

## Priority Levels

Set the `X-Priority` header to control how urgently the notification appears:

| Priority | Value | Behavior |
|----------|-------|----------|
| Min | `1` or `min` | No vibration/sound, hidden in drawer |
| Low | `2` or `low` | No vibration/sound |
| Default | `3` or `default` | Short vibration and sound |
| High | `4` or `high` | Long vibration, pop-over notification |
| Max/Urgent | `5` or `urgent` | Long vibration bursts, pop-over notification |

```bash
curl \
  -H "X-Priority: 5" \
  -H "Title: Build Failed" \
  -H "Tags: warning,skull" \
  -d "CI pipeline failed on step: test-integration" \
  ntfy.sh/<topic>
```

## Recommended Patterns

### Simple alert (default priority)

```bash
curl -d "Task finished" ntfy.sh/<topic>
```

### High-priority failure alert

```bash
curl \
  -H "X-Priority: 4" \
  -H "Title: Alert" \
  -H "Tags: warning" \
  -d "Something went wrong: <details>" \
  ntfy.sh/<topic>
```

### Urgent alert with click action (opens a URL when tapped)

```bash
curl \
  -H "X-Priority: 5" \
  -H "Title: Server Down" \
  -H "Tags: skull,no_entry" \
  -H "Click: https://grafana.example.com/dashboard" \
  -d "Host <hostname> is unreachable" \
  ntfy.sh/<topic>
```

### Notification with action buttons (interactive)

```bash
curl \
  -H "X-Priority: 4" \
  -H "Title: Deployment Ready" \
  -H "Actions: view, Review Deploy, https://github.com/org/repo/actions, clear=true" \
  -d "Production deployment #42 is pending approval" \
  ntfy.sh/<topic>
```

### JSON payload (for complex structured data)

```bash
curl ntfy.sh \
  -d '{
    "topic": "<topic>",
    "message": "Build #1234 succeeded",
    "title": "CI Report",
    "tags": ["heavy_check_mark", "ci"],
    "priority": 3,
    "click": "https://github.com/org/repo/actions/runs/1234"
  }'
```

### Markdown formatting

```bash
curl \
  -H "Markdown: yes" \
  -H "X-Priority: 3" \
  -d "Build **<hostname>** passed in *42s* ✅" \
  ntfy.sh/<topic>
```

## Tags & Emojis

Use the `X-Tags` header with emoji short codes to add visual indicators:

| Tag | Emoji | Use case |
|-----|-------|----------|
| `warning` | ⚠️ | Warnings |
| `rotating_light` | 🚨 | Critical alerts |
| `heavy_check_mark` | ✔️ | Success |
| `skull` | 💀 | Failures |
| `computer` | 💻 | System events |
| `loudspeaker` | 📢 | Announcements |
| `party_popper` | 🎉 | Celebrations |
| `no_entry` | ⛔ | Blocked |

```bash
curl \
  -H "X-Tags: heavy_check_mark,ci,docker" \
  -d "Docker build completed" \
  ntfy.sh/<topic>
```

## Delayed Delivery

Schedule a notification to arrive later using the `X-In` header:

```bash
curl \
  -H "X-In: 30m" \
  -H "Title: Reminder" \
  -d "Check on the long-running migration job" \
  ntfy.sh/<topic>
```

Supported duration formats: `30m`, `2h`, `1 day`, `3 days`. Minimum delay is 10 seconds.

## Updating Notifications

Replace an existing notification by reusing the same `X-Sequence-ID`:

```bash
# Initial notification
curl -H "X-Sequence-ID: build-123" -d "Building... 25%" ntfy.sh/<topic>

# Update progress
curl -H "X-Sequence-ID: build-123" -d "Building... 75%" ntfy.sh/<topic>

# Final state
curl -H "X-Sequence-ID: build-123" -d "Build complete ✅" ntfy.sh/<topic>
```

## Dead Man's Switch (timeout alert)

Schedule an alert that fires if a heartbeat script stops running:

```bash
# Start heartbeat — pushes the alert delivery further into the future
while true; do
  curl -H "X-In: 5m" -d "Server heartbeat: <hostname>" ntfy.sh/<topic>
  sleep 60
done
```

If the loop stops, the scheduled alert delivers after 5 minutes.

## Notes

- Topic names are public — don't use sensitive information in them. Treat them like passwords. The user should have provided you with a unique topic name that only they know.
- Messages are up to 4,096 bytes before being treated as attachments.
- On ntfy.sh: daily limit is 250 messages, rate limit is 60 requests with refill of 1 per 5 seconds.
