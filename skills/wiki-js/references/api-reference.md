# Wiki.js GraphQL API Reference

All GraphQL operations are sent to `POST /graphql` on your Wiki.js instance. Assets are uploaded via `POST /u` (REST). Authentication uses a Bearer JWT (your API key) in the `Authorization` header.

> Source: Wiki.js v2.5.314 GraphQL schemas (`server/graph/schemas/*.graphql`).

## Common Response Types

Every mutation returns a `responseResult` of type `ResponseStatus`:

```graphql
type ResponseStatus {
  succeeded: Boolean!
  errorCode: Int!
  slug: String!
  message: String
}
```

Mutations wrap `responseResult` inside a resource-specific response object. Most also return the affected entity.

```graphql
type DefaultResponse {
  responseResult: ResponseStatus
}
```

## Pagination & Ordering

| Enum | Values |
|------|--------|
| `PageOrderBy` | `CREATED`, `ID`, `PATH`, `TITLE`, `UPDATED` |
| `PageOrderByDirection` | `ASC`, `DESC` |

## Pages

### Queries

#### `pages.list`

List all pages.

```graphql
pages {
  list(
    limit: Int
    orderBy: PageOrderBy
    orderByDirection: PageOrderByDirection
    tags: [String!]
    locale: String
    creatorId: Int
    authorId: Int
  ): [PageListItem!]!
}
```

**`PageListItem`** fields returned: `id`, `path`, `locale`, `title`, `description`, `contentType`, `isPublished`, `isPrivate`, `privateNS`, `createdAt`, `updatedAt`, `tags`.

#### `pages.single(id)`

Fetch a single page by numeric ID. Returns a full `Page` object.

```graphql
pages { single(id: Int!): Page }
```

#### `pages.singleByPath(path, locale)`

Fetch a single page by its URL path and locale.

```graphql
pages { singleByPath(path: String!, locale: String!): Page }
```

#### `pages.search(query, path, locale)`

Full-text search across pages.

```graphql
pages {
  search(query: String!, path: String, locale: String): PageSearchResponse!
}
```

Returns `PageSearchResponse`: `results: [PageSearchResult]`, `suggestions: [String]`, `totalHits: Int`.

#### `pages.tags`

List all tags used across pages.

```graphql
pages { tags: [PageTag]! }
```

#### `pages.tree(path, parent, mode, locale, includeAncestors)`

Hierarchical tree view of pages/folders.

```graphql
pages {
  tree(
    path: String
    parent: Int
    mode: PageTreeMode!    # FOLDERS | PAGES | ALL
    locale: String!
    includeAncestors: Boolean
  ): [PageTreeItem]
}
```

#### `pages.history(id, offsetPage, offsetSize)`

Version history trail for a page. Requires `manage:system` or `read:history` scope.

```graphql
pages { history(id: Int!, offsetPage: Int, offsetSize: Int): PageHistoryResult! }
```

#### `pages.version(pageId, versionId)`

Fetch a specific historical version of a page.

```graphql
pages { version(pageId: Int!, versionId: Int!): PageVersion }
```

#### `pages.links(locale)`

List internal links used by a page.

### Mutations

#### `pages.create`

Create a new page. **All non-optional fields must be provided.**

| Argument | Type | Required |
|----------|------|----------|
| `content` | `String!` | Yes — raw source content |
| `description` | `String!` | Yes — meta description |
| `editor` | `String!` | Yes — `"markdown"` or `"code"` |
| `isPublished` | `Boolean!` | Yes |
| `isPrivate` | `Boolean!` | Yes |
| `locale` | `String!` | Yes — e.g. `"en"` |
| `path` | `String!` | Yes — URL slug path |
| `title` | `String!` | Yes |
| `tags` | `[String]!` | Yes (array, can be empty) |
| `publishStartDate` | `Date` | No |
| `publishEndDate` | `Date` | No |
| `scriptCss` | `String` | No |
| `scriptJs` | `String` | No |

Returns `PageResponse` (`responseResult` + `page: Page`).

**Scopes required:** `write:pages` or `manage:pages` or `manage:system`.

#### `pages.update`

Update an existing page. Only provide fields you want to change; omitted fields are untouched.

| Argument | Type | Required |
|----------|------|----------|
| `id` | `Int!` | Yes |
| `content` | `String` | No |
| `description` | `String` | No |
| `editor` | `String` | No |
| `isPrivate` | `Boolean` | No |
| `isPublished` | `Boolean` | No |
| `locale` | `String` | No |
| `path` | `String` | No |
| `publishEndDate` | `Date` | No |
| `publishStartDate` | `Date` | No |
| `scriptCss` | `String` | No |
| `scriptJs` | `String` | No |
| `tags` | `[String]` | No |
| `title` | `String` | No |

Returns `PageResponse`.

**Scopes required:** `write:pages` or `manage:pages` or `manage:system`.

#### `pages.delete(id)`

Delete a page by ID. Returns `DefaultResponse`.

**Scopes required:** `delete:pages` or `manage:system`.

#### `pages.move(id, destinationPath, destinationLocale)`

Move a page to a different path/locale. Returns `DefaultResponse`.

**Scopes required:** `manage:pages` or `manage:system`.

#### `pages.convert(id, editor)`

Convert a page's editor type (e.g. markdown ↔ code). Returns `DefaultResponse`.

#### `pages.restore(pageId, versionId)`

Restore a page to a previous version. Returns `DefaultResponse`.

### Page Type

The full `Page` type (fields available when you request them):

| Field | Type | Auth scope to read |
|-------|------|--------------------|
| `id` | `Int!` | `read:pages` |
| `path` | `String!` | `read:pages` |
| `hash` | `String!` | `read:pages` |
| `title` | `String!` | `read:pages` |
| `description` | `String!` | `read:pages` |
| `isPrivate` | `Boolean!` | `write:pages` + |
| `isPublished` | `Boolean!` | `write:pages` + |
| `privateNS` | `String` | `write:pages` + |
| `publishStartDate` | `Date!` | `write:pages` + |
| `publishEndDate` | `Date!` | `write:pages` + |
| `tags` | `[PageTag]!` | `read:pages` |
| `content` | `String!` | `read:source` — raw source |
| `render` | `String` | `read:pages` — rendered HTML |
| `toc` | `String` | `read:pages` — table of contents |
| `contentType` | `String!` | `read:pages` |
| `createdAt` | `Date!` | `read:pages` |
| `updatedAt` | `Date!` | `read:pages` |
| `editor` | `String!` | `write:pages` + |
| `locale` | `String!` | `read:pages` |
| `scriptCss` | `String` | `write:pages` + |
| `scriptJs` | `String` | `write:pages` + |
| `authorId` | `Int!` | `write:pages` + |
| `authorName` | `String!` | `write:pages` + |
| `authorEmail` | `String!` | `write:pages` + |
| `creatorId` | `Int!` | `write:pages` + |
| `creatorName` | `String!` | `write:pages` + |
| `creatorEmail` | `String!` | `write:pages` + |

(`+` means `write:pages`, `manage:pages`, or `manage:system` scope required.)

---

## Assets

### Queries

#### `assets.list(folderId, kind)`

List assets in a folder.

```graphql
assets { list(folderId: Int!, kind: AssetKind!): [AssetItem] }
```

`AssetKind`: `IMAGE`, `BINARY`, `ALL`.

**`AssetItem`** fields: `id`, `filename`, `ext`, `kind`, `mime`, `fileSize`, `metadata`, `createdAt`, `updatedAt`, `folder`, `author`.

#### `assets.folders(parentFolderId)`

List folders under a parent.

```graphql
assets { folders(parentFolderId: Int!): [AssetFolder] }
```

### Mutations

#### `assets.createFolder(parentFolderId, slug, name)`

```graphql
assets { createFolder(parentFolderId: Int!, slug: String!, name: String): DefaultResponse }
```

#### `assets.renameAsset(id, filename)`

#### `assets.deleteAsset(id)`

#### `assets.flushTempUploads`

**Scopes:** `manage:system`, `write:assets` / `manage:assets` for mutations.

### REST Upload Endpoint

Upload a single file via `POST /u`:

```bash
curl -X POST \
  -H "Authorization: Bearer $WIKI_TOKEN" \
  -F "mediaUpload={\"folderId\":0}" \
  -F "mediaUpload=@/path/to/file.png" \
  "$WIKI_URL/u"
```

The response is a simple text `ok` on success. After upload, refresh the asset list via GraphQL: `assets { list(folderId: 0, kind: IMAGE) }`.

---

## Search

### Query

#### `search.searchEngines`

List available search engines (admin only).

```graphql
search { searchEngines(filter: String, orderBy: String): [SearchEngine] }
```

### Mutation

#### `search.rebuildIndex`

Trigger a full reindex of all content.

```graphql
search { rebuildIndex: DefaultResponse }
```

**Scope:** `manage:system`.

---

## Navigation

### Queries

#### `navigation.tree`

Get the full navigation tree across all locales.

```graphql
navigation { tree: [NavigationTree]! }
```

#### `navigation.config`

Get navigation configuration.

```graphql
navigation { config: NavigationConfig! }
```

### Mutations

#### `navigation.updateTree`

Replace the entire navigation tree.

```graphql
navigation {
  updateTree(tree: [NavigationTreeInput]!): DefaultResponse
}
```

`NavigationTreeInput`:
```graphql
input NavigationTreeInput {
  locale: String!
  items: [NavigationItemInput]!
}

input NavigationItemInput {
  id: String!        # unique identifier for the item
  kind: String!      # "page" | "category" | "link" | "separator"
  label: String
  icon: String
  targetType: String # "internal" | "external" | "header"
  target: String     # page path, URL, or empty
  visibilityMode: String  # "public" | "private" | "groups"
  visibilityGroups: [Int]
}
```

#### `navigation.updateConfig`

```graphql
navigation { updateConfig(mode: NavigationMode!): DefaultResponse }
```

`NavigationMode`: `NONE`, `TREE`, `MIXED`, `STATIC`.

**Scopes:** `manage:navigation`.

---

## Comments

### Query

#### `comments.list(locale, path)`

List comments for a page.

```graphql
comments { list(locale: String!, path: String!): [CommentPost]! }
```

#### `comments.single(id)`

Fetch a single comment.

### Mutations

#### `comments.create(pageId, replyTo, content, guestName, guestEmail)`

```graphql
comments {
  create(
    pageId: Int!
    replyTo: Int
    content: String!
    guestName: String
    guestEmail: String
  ): CommentCreateResponse
}
```

Returns `CommentCreateResponse` (`responseResult` + `id`).

**Scopes:** `write:comments`.

#### `comments.update(id, content)`

#### `comments.delete(id)`

**Scopes:** `write:comments` / `manage:comments`.

---

## Authentication (API Keys)

### Mutation

#### `authentication.createApiKey`

```graphql
mutation {
  authentication {
    createApiKey(
      name: String!
      expiration: String!    # e.g. "30d", "2h", or ISO date
      fullAccess: Boolean!
      group: Int              # optional group ID restriction
    ) {
      responseResult { succeeded message }
      key: String
    }
  }
}
```

**Scope:** `manage:system`, `manage:api`.

### Query

#### `authentication.apiKeys` — list all API keys (admin only).

#### `authentication.apiState` — check if API is enabled.

#### `authentication.login(username, password, strategy)` — JWT login (for interactive sessions; API tokens are preferred for agents).

---

## Error Code Reference (Pages & Assets)

| Code | Slug | Meaning |
|------|------|---------|
| 6001 | `page-generic-error` | Unexpected page error |
| 6002 | `page-duplicate-create` | Page already exists at path |
| 6003 | `page-not-found` | Page does not exist |
| 6004 | `page-empty-content` | Content is empty |
| 6005 | `page-illegal-path` | Path contains illegal characters |
| 6006 | `page-path-collision` | Destination path already exists |
| 6007 | `page-move-forbidden` | Not authorized to move |
| 6008 | `page-create-forbidden` | Not authorized to create |
| 6009 | `page-update-forbidden` | Not authorized to update |
| 6010 | `page-delete-forbidden` | Not authorized to delete |
| 6011 | `page-restore-forbidden` | Not authorized to restore |
| 6012 | `page-history-forbidden` | Not authorized to view history |
| 6013 | `page-view-forbidden` | Not authorized to view page |
| 1019 | `auth-required` | Not authenticated |
| 2002 | `asset-folder-exists` | Folder already exists |
| 2003 | `asset-delete-forbidden` | Not authorized to delete asset |

---

## Upsert Pattern (Agent Workflow)

```graphql
# Step 1: Check if page exists
query($path: String!, $locale: String!) {
  pages {
    singleByPath(path: $path, locale: $locale) {
      id
      path
      title
      content
    }
  }
}
```

If `data.pages.singleByPath` is `null` → run `pages.create`.
If it returns an object with `id` → run `pages.update(id: <id>, ...)`.
