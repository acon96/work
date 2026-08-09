---
name: wiki-js
description: How to manage a wiki.js instance using a unified CLI script. Use this skill if the user asks you to edit the wiki.
license: MIT
---
# Wiki.js Management

This document describes how to use `manage_wiki.py` as a unified Wiki.js CLI for:

- page operations
- asset operations
- navigation operations
- connectivity checks

## Script Location

- Script: `<skill_root>/scripts/manage_wiki.py`

## Required Environment

The script needs: `WIKI_URL` & `WIKI_TOKEN`

Load from existing workspace env file:

```bash
source /workspace/.env.sh
```

## Top-Level Commands

```bash
./manage_wiki.py {check,page,asset,nav} ...
```

- `check` -> API connectivity probe
- `page` -> page CRUD/search/list/upsert
- `asset` -> upload/list/folders/create-folder
- `nav` -> navigation config/tree updates

Useful global flags:

- `--timeout 30`
- `--verbose` (prints request debug info to stderr)
- `--content-file <file>`: Always use this for page content. Write the staged page content into `/tmp/*.md` and pass the file path to this flag. Avoid passing raw content on the command line.

## Quick Start

```bash
source /workspace/.env.sh

# 1) Verify token and endpoint
./manage_wiki.py check

# 2) Upsert page from markdown
./manage_wiki.py page upsert \
  --path homelab/overview \
  --title "Homelab Overview" \
  --content-file README.md \
  --tag homelab --tag docs

# 3) Upload an asset to root folder
./manage_wiki.py asset upload ./diagram.png --folder-id 0

# 4) Add page to nav
./manage_wiki.py nav add-page \
  --locale en \
  --id homelab-overview \
  --label "Homelab Overview" \
  --target homelab/overview
```

## Page Commands

### Get a page

```bash
./manage_wiki.py page get --path homelab/overview --locale en
```

### List pages

```bash
./manage_wiki.py page list --limit 25 --order-by UPDATED --order-dir DESC --locale en
```

### Search pages

```bash
./manage_wiki.py page search --query "k3s" --locale en
```

### Create page

```bash
./manage_wiki.py page create \
  --path notes/test-create \
  --title "Test Create" \
  --content "hello world" \
  --tag test
```

### Upsert page (create-or-update by path)

```bash
./manage_wiki.py page upsert \
  --path notes/test-upsert \
  --title "Test Upsert" \
  --content-file /tmp/page.md
```

### Update page (by id or path)

By path:

```bash
./manage_wiki.py page update \
  --path notes/test-upsert \
  --locale en \
  --title "Updated Title" \
  --content-file /tmp/page-updated.md
```

By id:

```bash
./manage_wiki.py page update \
  --id 123 \
  --description "new description"
```

### Delete page

```bash
./manage_wiki.py page delete --path notes/test-upsert --locale en
# or
./manage_wiki.py page delete --id 123
```

## Asset Commands

### Upload file

```bash
./manage_wiki.py asset upload ./image.png --folder-id 0
```

### List folders

```bash
./manage_wiki.py asset folders --parent-folder-id 0
```

### Create folder

```bash
./manage_wiki.py asset create-folder \
  --parent-folder-id 0 \
  --slug screenshots \
  --name "Screenshots"
```

### List assets in folder

```bash
./manage_wiki.py asset list --folder-id 0 --kind ALL
```

## Navigation Commands

### Read nav config/tree

```bash
./manage_wiki.py nav config
./manage_wiki.py nav tree
```

### Set nav mode

```bash
./manage_wiki.py nav set-mode --mode MIXED
```

### Replace full tree from JSON

```bash
./manage_wiki.py nav set-tree --file ./nav-tree.json
```

**Example Tree JSON:**
```json
[
  {
    "locale": "en",
    "items": [
      { "id": "home", "kind": "page", "label": "Home", "target": "home", "targetType": "internal" },
      { "id": "docs", "kind": "category", "label": "Documentation", "target": "", "targetType": "header" },
    ]
  }
]
```

| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | String | Unique identifier for the navigation item. |
| `kind` | String | The type of item: `page`, `link`, `category`, or `separator`. |
| `label` | String | The text displayed in the sidebar. |
| `target` | String | The destination. For `internal`, it's the page path. For `external`, a URL. |
| `targetType` | String | One of `internal`, `external`, or `header`. |
| `icon` | String | (Optional) Icon identifier. |
| `visibilityMode` | String | `public`, `private`, or `groups`. |
| `visibilityGroups`| Array | (Optional) List of group IDs if `visibilityMode` is `groups`. |

### Add items

Add internal page item:

```bash
./manage_wiki.py nav add-page \
  --locale en \
  --id docs-home \
  --label "Docs Home" \
  --target homelab/overview
```

Add external link:

```bash
./manage_wiki.py nav add-link \
  --locale en \
  --id ext-github \
  --label "GitHub" \
  --target "https://github.com"
```

Add category/header:

```bash
./manage_wiki.py nav add-category \
  --locale en \
  --id cat-tools \
  --label "Tools"
```

Remove item:

```bash
./manage_wiki.py nav remove-item --locale en --id docs-home
```

Note: Current schema in this environment is flat navigation items (no nested children field).

## Explicit Notes

- Do not spend time introspecting the contents of `manage_wiki.py`. If it is not working correctly then report it to the user. Do not attempt to debug or fix the script yourself.
- When making links or working with the navigation tree: all pages are referred to by their proper title. There is no internal ID reference or slug style reference used
- In order to avoid corrupting page content, all page edits should land as a local markdown file and then be written to the wiki using the `--content-file` flag.
