---
name: wiki-js
description: Maintain a Wiki.js knowledge base via its GraphQL API — create, update, search, and organize pages and assets. Use when an agent needs to write new documentation, sync incoming information into a wiki, or query existing wiki content.
license: MIT
---

# Wiki.js Maintenance Skill

This skill integrates with [Wiki.js](https://js.wiki/) (v2.2+) via its GraphQL API at `POST /graphql` plus a REST endpoint for asset uploads at `POST /u`. It lets you perform the full lifecycle of wiki content maintenance: check, create, update, search, organize, and upload media.

## Configure environment & Verify connectivity

Load these variables into your shell by sourcing `/workspace/.env.sh`:

```bash
export WIKI_URL="https://your-wiki.example.com"     # No trailing slash
export WIKI_TOKEN="<the-jwt-api-key-from-step-1>"
export WIKI_LOCALE="en"                              # Default locale (optional, defaults to "en")
export WIKI_EDITOR="markdown"                        # Default editor (optional, defaults to "markdown")
```

Then run a simple query to verify connectivity:

```bash
/wiki-js/scripts/wiki-gql.sh '{ site { config } }' --print
```

If the key or scopes are wrong, you'll get a `401`/`403` or a GraphQL `Unauthorized`/`Forbidden` error. Report to the user if the connection fails.

## Core Workflows

### Upsert a page (create or update)

The agent workflow for "ensure this page exists with this content":

1. **Check existence** — query by path:
   ```graphql
   { pages { singleByPath(path: "guide/getting-started", locale: "en") { id path title } } }
   ```
2. **If no `id` is returned** → run `pages.create(...)` (full content required).
3. **If an `id` is returned** → run `pages.update(id: N, ...)` with only the fields you want to change.

Both mutations return a `PageResponse` with `responseResult { succeeded, errorCode, slug, message }` and the created/updated `page { id, path }`.

> Every `pages.create` / `pages.update` input requires `editor: "markdown"` (or `"code"`) and `isPublished: true`. The `content` field holds the raw source of the page.

### Sync a batch of pages

When triggered with multiple pieces of incoming information:

1. Loop through each item.
2. For each: upsert using the workflow above.
3. After all writes, optionally call `search.rebuildIndex` if content was significantly changed (only if `manage:system` scope).

### Upload an asset (image, document)

Assets are uploaded via the REST endpoint `POST /u`, **not** GraphQL:

```bash
# Upload a file to folder ID 0 (root)
curl -s -X POST \
  -H "Authorization: Bearer $WIKI_TOKEN" \
  -F "mediaUpload={\"folderId\":0}" \
  -F "mediaUpload=@/path/to/image.png" \
  "$WIKI_URL/u"
```

After upload, the file appears in `assets.list(folderId, kind: IMAGE)`.

To create folders first:
```graphql
mutation { assets { createFolder(parentFolderId: 0, slug: "screenshots", name: "Screenshots") { responseResult { succeeded message } } } }
```

### Update navigation tree

```graphql
mutation {
  navigation {
    updateTree(tree: [{
      locale: "en"
      items: [
        { id: "home", kind: "page", label: "Home", target: "home" }
      ]
    }]) {
      responseResult { succeeded message }
    }
  }
}
```

## Scripts

### `scripts/wiki-gql.sh` — GraphQL request helper

```bash
# Run a raw GraphQL query/mutation
./scripts/wiki-gql.sh '{ pages { list { id path title } } }'

# Run a mutation stored in a file
./scripts/wiki-gql.sh --file scripts/queries/create-page.gql

# Pretty-print the JSON response (pipe through jq)
./scripts/wiki-gql.sh '{ pages { list { id path } } }' --print

# Send variables
./scripts/wiki-gql.sh 'mutation($p:String!){ pages { singleByPath(path:$p) { id } } }' --var path="guide/intro" --print
```

### `scripts/wiki-upload.sh` — Asset upload helper

```bash
./scripts/wiki-upload.sh /path/to/image.png --folder 0
./scripts/wiki-upload.sh /path/to/doc.pdf --folder 5
```

## Error Handling

All mutations return a `responseResult` object:

```json
{
  "responseResult": {
    "succeeded": false,
    "errorCode": 6002,
    "slug": "page-duplicate-create",
    "message": "Cannot create this page because an entry already exists at the same path."
  }
}
```

Always check `responseResult.succeeded` before proceeding. Common error codes:

| Code | Meaning |
|------|---------|
| 6002 | Page already exists at that path (use update instead) |
| 6003 | Page not found |
| 6006 | Path collision (destination exists) |
| 6008 | Not authorized to create page |
| 6009 | Not authorized to update page |
| 6010 | Not authorized to delete page |
| 2002 | Asset folder already exists |
| 2003 | Not authorized to delete asset |
| 1019 | Not authenticated (check token / scopes) |

## References

- [API reference](./references/api-reference.md) — full GraphQL schema for pages, assets, search, navigation, and comments.
- [Example Queries](./references/queries/*.gql) — examples of GraphQL queries for reading pages, creating/updating pages, assets, etc..
- [Wiki.js official docs](https://docs.requarks.io/)
- `curl` is the primary HTTP tool. `jq` is used for parsing JSON responses.
