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

This local skill file is intended to replace ad-hoc `wiki-gql.sh` and `wiki-upload.sh` usage patterns.

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

## Output and Error Behavior

- Successful commands print JSON to stdout.
- Failures print `Error: ...` to stderr and return non-zero exit code.
- GraphQL-level failures are surfaced with code/slug/message when available.
