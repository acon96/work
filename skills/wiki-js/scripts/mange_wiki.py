#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import pathlib
import sys
import uuid
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple


def eprint(*args: Any) -> None:
    print(*args, file=sys.stderr)


class WikiError(RuntimeError):
    pass


@dataclass
class WikiConfig:
    url: str
    token: str
    locale: str = "en"
    editor: str = "markdown"
    timeout: int = 30


class WikiClient:
    def __init__(self, config: WikiConfig, verbose: bool = False):
        self.config = config
        self.verbose = verbose
        self.graphql_endpoint = f"{self.config.url.rstrip('/')}/graphql"
        self.upload_endpoint = f"{self.config.url.rstrip('/')}/u"

    def graphql(
        self,
        query: str,
        variables: Optional[Dict[str, Any]] = None,
        allow_graphql_errors: bool = False,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"query": query}
        if variables is not None:
            payload["variables"] = variables

        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            self.graphql_endpoint,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.config.token}",
            },
        )

        if self.verbose:
            eprint(f"[wiki] POST {self.graphql_endpoint}")
            eprint(f"[wiki] variables={json.dumps(variables or {}, ensure_ascii=True)}")

        try:
            with urllib.request.urlopen(req, timeout=self.config.timeout) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            details = exc.read().decode("utf-8", errors="replace")
            raise WikiError(f"HTTP {exc.code} calling GraphQL endpoint: {details}") from exc
        except urllib.error.URLError as exc:
            raise WikiError(f"Network error calling GraphQL endpoint: {exc}") from exc

        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise WikiError(f"Invalid JSON from GraphQL endpoint: {raw[:500]}") from exc

        errors = data.get("errors")
        if errors and not allow_graphql_errors:
            raise WikiError(f"GraphQL errors: {json.dumps(errors, ensure_ascii=True)}")

        return data

    def upload_asset(self, file_path: str, folder_id: int) -> Dict[str, Any]:
        path = pathlib.Path(file_path)
        if not path.is_file():
            raise WikiError(f"Asset file not found: {file_path}")

        metadata = json.dumps({"folderId": folder_id}, separators=(",", ":"))
        filename = path.name
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        file_bytes = path.read_bytes()

        boundary = f"----WikiBoundary{uuid.uuid4().hex}"
        body = self._encode_multipart(boundary, metadata, filename, content_type, file_bytes)

        req = urllib.request.Request(
            self.upload_endpoint,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {self.config.token}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Content-Length": str(len(body)),
            },
        )

        if self.verbose:
            eprint(f"[wiki] POST {self.upload_endpoint}")
            eprint(f"[wiki] upload filename={filename} size={len(file_bytes)} folderId={folder_id}")

        try:
            with urllib.request.urlopen(req, timeout=self.config.timeout) as resp:
                response_text = resp.read().decode("utf-8", errors="replace").strip()
                status = resp.status
        except urllib.error.HTTPError as exc:
            details = exc.read().decode("utf-8", errors="replace")
            raise WikiError(f"HTTP {exc.code} uploading asset: {details}") from exc
        except urllib.error.URLError as exc:
            raise WikiError(f"Network error uploading asset: {exc}") from exc

        return {
            "status": status,
            "raw": response_text,
            "succeeded": status >= 200 and status < 300 and response_text.lower() == "ok",
            "filename": filename,
            "folderId": folder_id,
        }

    @staticmethod
    def _encode_multipart(
        boundary: str,
        metadata_json: str,
        filename: str,
        content_type: str,
        file_bytes: bytes,
    ) -> bytes:
        crlf = "\r\n"

        parts: List[bytes] = []

        parts.append(f"--{boundary}{crlf}".encode("utf-8"))
        parts.append(
            (
                f'Content-Disposition: form-data; name="mediaUpload"{crlf}'
                f"Content-Type: application/json{crlf}{crlf}"
                f"{metadata_json}{crlf}"
            ).encode("utf-8")
        )

        parts.append(f"--{boundary}{crlf}".encode("utf-8"))
        parts.append(
            (
                f'Content-Disposition: form-data; name="mediaUpload"; filename="{filename}"{crlf}'
                f"Content-Type: {content_type}{crlf}{crlf}"
            ).encode("utf-8")
        )
        parts.append(file_bytes)
        parts.append(crlf.encode("utf-8"))

        parts.append(f"--{boundary}--{crlf}".encode("utf-8"))

        return b"".join(parts)


QUERY_SITE_CONFIG = """
query {
  site {
    __typename
  }
}
"""

QUERY_PAGE_BY_PATH = """
query($path: String!, $locale: String!) {
  pages {
    singleByPath(path: $path, locale: $locale) {
      id
      path
      locale
      title
      description
      isPublished
      isPrivate
      editor
      contentType
      content
      createdAt
      updatedAt
      tags { tag title }
    }
  }
}
"""

QUERY_PAGES_LIST = """
query($limit: Int, $orderBy: PageOrderBy, $orderByDirection: PageOrderByDirection, $tags: [String!], $locale: String) {
  pages {
    list(
      limit: $limit
      orderBy: $orderBy
      orderByDirection: $orderByDirection
      tags: $tags
      locale: $locale
    ) {
      id
      path
      locale
      title
      description
      isPublished
      isPrivate
      createdAt
      updatedAt
      tags
    }
  }
}
"""

QUERY_PAGES_SEARCH = """
query($query: String!, $path: String, $locale: String) {
  pages {
    search(query: $query, path: $path, locale: $locale) {
      totalHits
      suggestions
      results {
        id
        title
        description
        path
        locale
      }
    }
  }
}
"""

MUTATION_PAGE_CREATE = """
mutation(
  $content: String!
  $description: String!
  $editor: String!
  $isPublished: Boolean!
  $isPrivate: Boolean!
  $locale: String!
  $path: String!
  $title: String!
  $tags: [String]!
  $publishStartDate: Date
  $publishEndDate: Date
  $scriptCss: String
  $scriptJs: String
) {
  pages {
    create(
      content: $content
      description: $description
      editor: $editor
      isPublished: $isPublished
      isPrivate: $isPrivate
      locale: $locale
      path: $path
      title: $title
      tags: $tags
      publishStartDate: $publishStartDate
      publishEndDate: $publishEndDate
      scriptCss: $scriptCss
      scriptJs: $scriptJs
    ) {
      responseResult {
        succeeded
        errorCode
        slug
        message
      }
      page {
        id
        path
        title
        createdAt
        updatedAt
      }
    }
  }
}
"""

MUTATION_PAGE_UPDATE = """
mutation(
  $id: Int!
  $content: String
  $description: String
  $editor: String
  $isPrivate: Boolean
  $isPublished: Boolean
  $locale: String
  $path: String
  $publishEndDate: Date
  $publishStartDate: Date
  $scriptCss: String
  $scriptJs: String
  $tags: [String]
  $title: String
) {
  pages {
    update(
      id: $id
      content: $content
      description: $description
      editor: $editor
      isPrivate: $isPrivate
      isPublished: $isPublished
      locale: $locale
      path: $path
      publishEndDate: $publishEndDate
      publishStartDate: $publishStartDate
      scriptCss: $scriptCss
      scriptJs: $scriptJs
      tags: $tags
      title: $title
    ) {
      responseResult {
        succeeded
        errorCode
        slug
        message
      }
      page {
        id
        path
        title
        updatedAt
      }
    }
  }
}
"""

MUTATION_PAGE_DELETE = """
mutation($id: Int!) {
  pages {
    delete(id: $id) {
      responseResult {
        succeeded
        errorCode
        slug
        message
      }
    }
  }
}
"""

QUERY_ASSET_FOLDERS = """
query($parentFolderId: Int!) {
  assets {
    folders(parentFolderId: $parentFolderId) {
      id
      slug
      name
    }
  }
}
"""

QUERY_ASSET_LIST = """
query($folderId: Int!, $kind: AssetKind!) {
  assets {
    list(folderId: $folderId, kind: $kind) {
      id
      filename
      ext
      kind
      mime
      fileSize
      createdAt
      updatedAt
      metadata
      folder { id slug name }
      author { id name }
    }
  }
}
"""

MUTATION_ASSET_CREATE_FOLDER = """
mutation($parentFolderId: Int!, $slug: String!, $name: String) {
  assets {
    createFolder(parentFolderId: $parentFolderId, slug: $slug, name: $name) {
      responseResult {
        succeeded
        errorCode
        slug
        message
      }
    }
  }
}
"""

QUERY_NAV_TREE = """
query {
  navigation {
    tree {
      locale
      items {
        id
        kind
        label
        icon
        targetType
        target
        visibilityMode
        visibilityGroups
      }
    }
  }
}
"""

QUERY_NAV_CONFIG = """
query {
  navigation {
    config {
      mode
    }
  }
}
"""

MUTATION_NAV_UPDATE_TREE = """
mutation($tree: [NavigationTreeInput]!) {
  navigation {
    updateTree(tree: $tree) {
      responseResult {
        succeeded
        errorCode
        slug
        message
      }
    }
  }
}
"""

MUTATION_NAV_UPDATE_CONFIG = """
mutation($mode: NavigationMode!) {
  navigation {
    updateConfig(mode: $mode) {
      responseResult {
        succeeded
        errorCode
        slug
        message
      }
    }
  }
}
"""


def read_file(path: str) -> str:
    p = pathlib.Path(path)
    if not p.is_file():
        raise WikiError(f"File not found: {path}")
    return p.read_text(encoding="utf-8")


def normalize_page_path(path: str) -> str:
    return path.strip().strip("/")


def response_status(node: Dict[str, Any]) -> Dict[str, Any]:
    status = node.get("responseResult") if isinstance(node, dict) else None
    if not isinstance(status, dict):
        raise WikiError("Mutation response missing responseResult")
    return status


def require_success(status: Dict[str, Any], operation: str) -> None:
    if status.get("succeeded"):
        return
    raise WikiError(
        f"{operation} failed: errorCode={status.get('errorCode')} slug={status.get('slug')} message={status.get('message')}"
    )


def pretty_print(payload: Any) -> None:
    print(json.dumps(payload, indent=2, ensure_ascii=True, sort_keys=True))


def parse_json_file(path: str) -> Any:
    text = read_file(path)
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise WikiError(f"Invalid JSON in file {path}: {exc}") from exc


def bool_from_string(value: str) -> bool:
    lowered = value.strip().lower()
    if lowered in {"1", "true", "yes", "y", "on"}:
        return True
    if lowered in {"0", "false", "no", "n", "off"}:
        return False
    raise argparse.ArgumentTypeError(f"Invalid boolean value: {value}")


def resolve_content(args: argparse.Namespace) -> Optional[str]:
    if getattr(args, "content", None) is not None:
        return args.content
    if getattr(args, "content_file", None):
        return read_file(args.content_file)
    return None


def get_page_by_path(client: WikiClient, path: str, locale: str) -> Optional[Dict[str, Any]]:
    data = client.graphql(
        QUERY_PAGE_BY_PATH,
        {"path": normalize_page_path(path), "locale": locale},
        allow_graphql_errors=True,
    )

    errors = data.get("errors") or []
    if errors:
        # Wiki.js may report "page does not exist" as a GraphQL error (code 6003)
        # instead of returning null.
        only_not_found = True
        for err in errors:
            exc = ((err or {}).get("extensions") or {}).get("exception") or {}
            code = exc.get("code")
            message = (err or {}).get("message", "")
            if code == 6003 or "does not exist" in message.lower():
                continue
            only_not_found = False
            break

        if only_not_found:
            return None

        raise WikiError(f"GraphQL errors: {json.dumps(errors, ensure_ascii=True)}")

    return data.get("data", {}).get("pages", {}).get("singleByPath")


def cmd_check(client: WikiClient, _args: argparse.Namespace) -> None:
    data = client.graphql(QUERY_SITE_CONFIG)
    pretty_print(data.get("data", {}))


def cmd_page_get(client: WikiClient, args: argparse.Namespace) -> None:
    page = get_page_by_path(client, args.path, args.locale)
    if page is None:
        raise WikiError(f"Page not found at path '{normalize_page_path(args.path)}' locale '{args.locale}'")
    pretty_print(page)


def cmd_page_list(client: WikiClient, args: argparse.Namespace) -> None:
    variables: Dict[str, Any] = {
        "limit": args.limit,
        "orderBy": args.order_by,
        "orderByDirection": args.order_direction,
        "tags": args.tags or None,
        "locale": args.locale,
    }
    data = client.graphql(QUERY_PAGES_LIST, variables)
    pretty_print(data.get("data", {}).get("pages", {}).get("list", []))


def cmd_page_search(client: WikiClient, args: argparse.Namespace) -> None:
    variables = {"query": args.query, "path": args.path, "locale": args.locale}
    data = client.graphql(QUERY_PAGES_SEARCH, variables)
    pretty_print(data.get("data", {}).get("pages", {}).get("search", {}))


def cmd_page_create(client: WikiClient, args: argparse.Namespace) -> None:
    content = resolve_content(args)
    if content is None:
        raise WikiError("Provide --content or --content-file for page creation")

    path = normalize_page_path(args.path)
    description = args.description or f"Documentation page for {args.title}"

    variables = {
        "content": content,
        "description": description,
        "editor": args.editor,
        "isPublished": args.published,
        "isPrivate": args.private,
        "locale": args.locale,
        "path": path,
        "title": args.title,
        "tags": args.tags or [],
        "publishStartDate": args.publish_start,
        "publishEndDate": args.publish_end,
        "scriptCss": args.script_css,
        "scriptJs": args.script_js,
    }

    data = client.graphql(MUTATION_PAGE_CREATE, variables)
    node = data.get("data", {}).get("pages", {}).get("create", {})
    status = response_status(node)
    require_success(status, "pages.create")
    pretty_print(node)


def parse_page_id_value(value: Any, context: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise WikiError(f"Invalid page id in {context}: {value!r}") from exc


def extract_page_tags(page: Optional[Dict[str, Any]]) -> List[str]:
    if not isinstance(page, dict):
        return []
    raw_tags = page.get("tags")
    if not isinstance(raw_tags, list):
        return []

    tags: List[str] = []
    for item in raw_tags:
        if isinstance(item, str):
            tags.append(item)
        elif isinstance(item, dict):
            tag_val = item.get("tag")
            if isinstance(tag_val, str) and tag_val:
                tags.append(tag_val)
    return tags


def find_page_id(client: WikiClient, *, page_id: Optional[int], path: Optional[str], locale: str) -> int:
    if page_id is not None:
        return page_id
    if not path:
        raise WikiError("Provide --id or --path")
    page = get_page_by_path(client, path, locale)
    if page is None:
        raise WikiError(f"Page not found for path '{normalize_page_path(path)}' locale '{locale}'")
    return parse_page_id_value(page.get("id"), "pages.singleByPath")


def cmd_page_update(client: WikiClient, args: argparse.Namespace) -> None:
    page_id = find_page_id(client, page_id=args.id, path=args.path, locale=args.locale)
    content = resolve_content(args)

    variables: Dict[str, Any] = {"id": page_id}

    page_for_defaults: Optional[Dict[str, Any]] = None
    if args.path:
        page_for_defaults = get_page_by_path(client, args.path, args.locale)

    optional_fields = {
        "content": content,
        "description": args.description,
        "editor": args.editor,
        "isPrivate": args.private,
        "isPublished": args.published,
        "locale": args.new_locale,
        "path": normalize_page_path(args.new_path) if args.new_path else None,
        "publishEndDate": args.publish_end,
        "publishStartDate": args.publish_start,
        "scriptCss": args.script_css,
        "scriptJs": args.script_js,
        "tags": args.tags if args.tags is not None else None,
        "title": args.title,
    }

    changed_without_tags = [k for k, v in optional_fields.items() if k != "tags" and v is not None]
    if args.tags is None and changed_without_tags:
        optional_fields["tags"] = extract_page_tags(page_for_defaults)

    changed_keys = [k for k, v in optional_fields.items() if v is not None]
    if not changed_keys:
        raise WikiError("No update fields provided. Add at least one field to update.")

    variables.update({k: v for k, v in optional_fields.items() if v is not None})

    data = client.graphql(MUTATION_PAGE_UPDATE, variables)
    node = data.get("data", {}).get("pages", {}).get("update", {})
    status = response_status(node)
    require_success(status, "pages.update")
    pretty_print(node)


def cmd_page_upsert(client: WikiClient, args: argparse.Namespace) -> None:
    path = normalize_page_path(args.path)
    content = resolve_content(args)
    if content is None:
        raise WikiError("Provide --content or --content-file for upsert")

    page = get_page_by_path(client, path, args.locale)

    if page is None:
        create_args = argparse.Namespace(**vars(args))
        create_args.path = path
        cmd_page_create(client, create_args)
        return

    update_variables = {
        "id": parse_page_id_value(page.get("id"), "pages.singleByPath"),
        "content": content,
        "title": args.title,
        "description": args.description,
        "editor": args.editor,
        "isPublished": args.published,
        "isPrivate": args.private,
        "tags": args.tags if args.tags is not None else extract_page_tags(page),
        "scriptCss": args.script_css,
        "scriptJs": args.script_js,
        "publishStartDate": args.publish_start,
        "publishEndDate": args.publish_end,
    }

    data = client.graphql(MUTATION_PAGE_UPDATE, update_variables)
    node = data.get("data", {}).get("pages", {}).get("update", {})
    status = response_status(node)
    require_success(status, "pages.update")
    pretty_print(node)


def cmd_page_delete(client: WikiClient, args: argparse.Namespace) -> None:
    page_id = find_page_id(client, page_id=args.id, path=args.path, locale=args.locale)
    data = client.graphql(MUTATION_PAGE_DELETE, {"id": page_id})
    node = data.get("data", {}).get("pages", {}).get("delete", {})
    status = response_status(node)
    require_success(status, "pages.delete")
    pretty_print(node)


def cmd_asset_folders(client: WikiClient, args: argparse.Namespace) -> None:
    data = client.graphql(QUERY_ASSET_FOLDERS, {"parentFolderId": args.parent_folder_id})
    pretty_print(data.get("data", {}).get("assets", {}).get("folders", []))


def cmd_asset_list(client: WikiClient, args: argparse.Namespace) -> None:
    variables = {"folderId": args.folder_id, "kind": args.kind}
    data = client.graphql(QUERY_ASSET_LIST, variables)
    pretty_print(data.get("data", {}).get("assets", {}).get("list", []))


def cmd_asset_create_folder(client: WikiClient, args: argparse.Namespace) -> None:
    variables = {
        "parentFolderId": args.parent_folder_id,
        "slug": args.slug,
        "name": args.name,
    }
    data = client.graphql(MUTATION_ASSET_CREATE_FOLDER, variables)
    node = data.get("data", {}).get("assets", {}).get("createFolder", {})
    status = response_status(node)
    require_success(status, "assets.createFolder")
    pretty_print(node)


def cmd_asset_upload(client: WikiClient, args: argparse.Namespace) -> None:
    result = client.upload_asset(args.file, args.folder_id)
    if not result.get("succeeded"):
        raise WikiError(
            f"Asset upload did not return expected success payload (status={result.get('status')}, raw={result.get('raw')})"
        )
    pretty_print(result)


def load_nav_tree(client: WikiClient) -> List[Dict[str, Any]]:
    data = client.graphql(QUERY_NAV_TREE)
    tree = data.get("data", {}).get("navigation", {}).get("tree", [])
    if not isinstance(tree, list):
        raise WikiError("navigation.tree returned unexpected payload")
    return tree


def save_nav_tree(client: WikiClient, tree: List[Dict[str, Any]]) -> Dict[str, Any]:
    data = client.graphql(MUTATION_NAV_UPDATE_TREE, {"tree": tree})
    node = data.get("data", {}).get("navigation", {}).get("updateTree", {})
    status = response_status(node)
    require_success(status, "navigation.updateTree")
    return node


def ensure_locale_tree(tree: List[Dict[str, Any]], locale: str) -> Dict[str, Any]:
    for entry in tree:
        if entry.get("locale") == locale:
            if "items" not in entry or entry["items"] is None:
                entry["items"] = []
            return entry

    new_entry = {"locale": locale, "items": []}
    tree.append(new_entry)
    return new_entry


def find_nav_item(items: List[Dict[str, Any]], item_id: str) -> Optional[Tuple[Optional[Dict[str, Any]], Dict[str, Any]]]:
    for item in items:
        if isinstance(item, dict) and item.get("id") == item_id:
            return None, item
    return None


def remove_nav_item(items: List[Dict[str, Any]], item_id: str) -> bool:
    for index, item in enumerate(list(items)):
        if isinstance(item, dict) and item.get("id") == item_id:
            del items[index]
            return True
    return False


def cmd_nav_tree(client: WikiClient, args: argparse.Namespace) -> None:
    tree = load_nav_tree(client)
    if args.locale:
        for entry in tree:
            if entry.get("locale") == args.locale:
                pretty_print(entry)
                return
        raise WikiError(f"No navigation tree found for locale '{args.locale}'")
    pretty_print(tree)


def cmd_nav_config(client: WikiClient, _args: argparse.Namespace) -> None:
    data = client.graphql(QUERY_NAV_CONFIG)
    pretty_print(data.get("data", {}).get("navigation", {}).get("config", {}))


def cmd_nav_set_mode(client: WikiClient, args: argparse.Namespace) -> None:
    data = client.graphql(MUTATION_NAV_UPDATE_CONFIG, {"mode": args.mode})
    node = data.get("data", {}).get("navigation", {}).get("updateConfig", {})
    status = response_status(node)
    require_success(status, "navigation.updateConfig")
    pretty_print(node)


def cmd_nav_set_tree(client: WikiClient, args: argparse.Namespace) -> None:
    payload = parse_json_file(args.file)

    if isinstance(payload, list):
        if payload and isinstance(payload[0], dict) and "locale" in payload[0] and "items" in payload[0]:
            tree = payload
        else:
            tree = [{"locale": args.locale, "items": payload}]
    elif isinstance(payload, dict) and "locale" in payload and "items" in payload:
        tree = [payload]
    else:
        raise WikiError(
            "Invalid tree payload. Expected either: "
            "[NavigationTreeInput], a single {locale, items} object, or an items array."
        )

    node = save_nav_tree(client, tree)
    pretty_print(node)


def build_nav_item(kind: str, args: argparse.Namespace) -> Dict[str, Any]:
    item: Dict[str, Any] = {
        "id": args.id,
        "kind": kind,
        "label": args.label,
        "icon": args.icon,
        "targetType": args.target_type,
        "target": args.target,
        "visibilityMode": args.visibility_mode,
        "visibilityGroups": args.visibility_groups or [],
    }

    if kind == "separator":
        item["target"] = ""
        item["targetType"] = "header"

    return {k: v for k, v in item.items() if v is not None}


def cmd_nav_add_item(client: WikiClient, args: argparse.Namespace) -> None:
    tree = load_nav_tree(client)
    locale_tree = ensure_locale_tree(tree, args.locale)
    items = locale_tree.get("items", [])
    if not isinstance(items, list):
        raise WikiError("navigation tree items has invalid structure")

    if find_nav_item(items, args.id):
        raise WikiError(f"Navigation item id already exists in locale '{args.locale}': {args.id}")

    item = build_nav_item(args.kind, args)
    if args.child_of:
        raise WikiError("This Wiki.js schema does not support nested navigation children items.")

    if args.position == "start":
        items.insert(0, item)
    else:
        items.append(item)

    node = save_nav_tree(client, tree)
    pretty_print(node)


def cmd_nav_remove_item(client: WikiClient, args: argparse.Namespace) -> None:
    tree = load_nav_tree(client)
    locale_tree = ensure_locale_tree(tree, args.locale)
    items = locale_tree.get("items", [])
    if not isinstance(items, list):
        raise WikiError("navigation tree items has invalid structure")

    removed = remove_nav_item(items, args.id)
    if not removed:
        raise WikiError(f"Navigation item not found in locale '{args.locale}': {args.id}")

    node = save_nav_tree(client, tree)
    pretty_print(node)


def build_parser(default_locale: str, default_editor: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Unified Wiki.js manager for pages, assets, and navigation."
    )

    parser.add_argument("--wiki-url", default=os.environ.get("WIKI_URL"), help="Wiki.js base URL")
    parser.add_argument("--wiki-token", default=os.environ.get("WIKI_TOKEN"), help="Wiki.js API token")
    parser.add_argument("--timeout", type=int, default=30, help="HTTP timeout seconds (default: 30)")
    parser.add_argument("--verbose", action="store_true", help="Enable debug logging to stderr")

    subparsers = parser.add_subparsers(dest="resource", required=True)

    check_parser = subparsers.add_parser("check", help="Verify API connectivity")
    check_parser.set_defaults(func=cmd_check)

    page_parser = subparsers.add_parser("page", help="Manage pages")
    page_sub = page_parser.add_subparsers(dest="page_cmd", required=True)

    page_get = page_sub.add_parser("get", help="Get page by path")
    page_get.add_argument("--path", required=True)
    page_get.add_argument("--locale", default=default_locale)
    page_get.set_defaults(func=cmd_page_get)

    page_list = page_sub.add_parser("list", help="List pages")
    page_list.add_argument("--limit", type=int, default=200)
    page_list.add_argument("--order-by", default="TITLE", choices=["CREATED", "ID", "PATH", "TITLE", "UPDATED"])
    page_list.add_argument("--order-direction", default="ASC", choices=["ASC", "DESC"])
    page_list.add_argument("--locale", default=default_locale)
    page_list.add_argument("--tag", dest="tags", action="append", help="Filter by tag (repeatable)")
    page_list.set_defaults(func=cmd_page_list)

    page_search = page_sub.add_parser("search", help="Search pages")
    page_search.add_argument("--query", required=True)
    page_search.add_argument("--path", default=None)
    page_search.add_argument("--locale", default=default_locale)
    page_search.set_defaults(func=cmd_page_search)

    def add_page_content_args(p: argparse.ArgumentParser, include_title_path: bool = True) -> None:
        if include_title_path:
            p.add_argument("--path", required=True)
            p.add_argument("--title", required=True)
        p.add_argument("--content", default=None, help="Inline content")
        p.add_argument("--content-file", default=None, help="Path to markdown/content file")
        p.add_argument("--description", default=None)
        p.add_argument("--editor", default=default_editor)
        p.add_argument("--locale", default=default_locale)
        p.add_argument("--published", type=bool_from_string, default=True)
        p.add_argument("--private", type=bool_from_string, default=False)
        p.add_argument("--tag", dest="tags", action="append", help="Page tag (repeatable)")
        p.add_argument("--publish-start", default=None)
        p.add_argument("--publish-end", default=None)
        p.add_argument("--script-css", default=None)
        p.add_argument("--script-js", default=None)

    page_create = page_sub.add_parser("create", help="Create page")
    add_page_content_args(page_create, include_title_path=True)
    page_create.set_defaults(func=cmd_page_create)

    page_upsert = page_sub.add_parser("upsert", help="Create or update page by path")
    add_page_content_args(page_upsert, include_title_path=True)
    page_upsert.set_defaults(func=cmd_page_upsert)

    page_update = page_sub.add_parser("update", help="Update page by id or path")
    page_update.add_argument("--id", type=int, default=None)
    page_update.add_argument("--path", default=None, help="Lookup path when --id not provided")
    page_update.add_argument("--locale", default=default_locale, help="Lookup locale for --path")
    page_update.add_argument("--new-path", default=None, help="Set new page path")
    page_update.add_argument("--new-locale", default=None, help="Set new page locale")
    page_update.add_argument("--title", default=None)
    page_update.add_argument("--content", default=None)
    page_update.add_argument("--content-file", default=None)
    page_update.add_argument("--description", default=None)
    page_update.add_argument("--editor", default=None)
    page_update.add_argument("--published", type=bool_from_string, default=None)
    page_update.add_argument("--private", type=bool_from_string, default=None)
    page_update.add_argument("--tag", dest="tags", action="append")
    page_update.add_argument("--publish-start", default=None)
    page_update.add_argument("--publish-end", default=None)
    page_update.add_argument("--script-css", default=None)
    page_update.add_argument("--script-js", default=None)
    page_update.set_defaults(func=cmd_page_update)

    page_delete = page_sub.add_parser("delete", help="Delete page by id or path")
    page_delete.add_argument("--id", type=int, default=None)
    page_delete.add_argument("--path", default=None)
    page_delete.add_argument("--locale", default=default_locale)
    page_delete.set_defaults(func=cmd_page_delete)

    asset_parser = subparsers.add_parser("asset", help="Manage assets")
    asset_sub = asset_parser.add_subparsers(dest="asset_cmd", required=True)

    asset_upload = asset_sub.add_parser("upload", help="Upload asset file")
    asset_upload.add_argument("file")
    asset_upload.add_argument("--folder-id", type=int, default=0)
    asset_upload.set_defaults(func=cmd_asset_upload)

    asset_folders = asset_sub.add_parser("folders", help="List asset folders")
    asset_folders.add_argument("--parent-folder-id", type=int, default=0)
    asset_folders.set_defaults(func=cmd_asset_folders)

    asset_list = asset_sub.add_parser("list", help="List assets in folder")
    asset_list.add_argument("--folder-id", type=int, required=True)
    asset_list.add_argument("--kind", default="ALL", choices=["ALL", "IMAGE", "BINARY"])
    asset_list.set_defaults(func=cmd_asset_list)

    asset_create_folder = asset_sub.add_parser("create-folder", help="Create asset folder")
    asset_create_folder.add_argument("--parent-folder-id", type=int, default=0)
    asset_create_folder.add_argument("--slug", required=True)
    asset_create_folder.add_argument("--name", default=None)
    asset_create_folder.set_defaults(func=cmd_asset_create_folder)

    nav_parser = subparsers.add_parser("nav", help="Manage navigation")
    nav_sub = nav_parser.add_subparsers(dest="nav_cmd", required=True)

    nav_tree = nav_sub.add_parser("tree", help="Get navigation tree")
    nav_tree.add_argument("--locale", default=None)
    nav_tree.set_defaults(func=cmd_nav_tree)

    nav_config = nav_sub.add_parser("config", help="Get navigation config")
    nav_config.set_defaults(func=cmd_nav_config)

    nav_set_mode = nav_sub.add_parser("set-mode", help="Set navigation mode")
    nav_set_mode.add_argument("--mode", required=True, choices=["NONE", "TREE", "MIXED", "STATIC"])
    nav_set_mode.set_defaults(func=cmd_nav_set_mode)

    nav_set_tree = nav_sub.add_parser("set-tree", help="Replace navigation tree from JSON file")
    nav_set_tree.add_argument("--file", required=True, help="JSON file (full tree or locale items)")
    nav_set_tree.add_argument("--locale", default=default_locale, help="Used when --file contains only items array")
    nav_set_tree.set_defaults(func=cmd_nav_set_tree)

    def add_nav_item_base(p: argparse.ArgumentParser, *, kind_choices: Optional[List[str]] = None) -> None:
        p.add_argument("--locale", default=default_locale)
        if kind_choices:
            p.add_argument("--kind", required=True, choices=kind_choices)
        p.add_argument("--id", required=True)
        p.add_argument("--label", default=None)
        p.add_argument("--icon", default=None)
        p.add_argument("--target", default="")
        p.add_argument("--target-type", default="internal", choices=["internal", "external", "header"])
        p.add_argument("--visibility-mode", default="public", choices=["public", "private", "groups"])
        p.add_argument("--visibility-group", dest="visibility_groups", action="append", type=int)
        p.add_argument(
            "--child-of",
            default=None,
            help="Reserved for future nested nav schemas. Current schema is flat and this option will error if used.",
        )
        p.add_argument("--position", default="end", choices=["start", "end"])

    nav_add_page = nav_sub.add_parser("add-page", help="Add navigation page item")
    add_nav_item_base(nav_add_page)
    nav_add_page.set_defaults(func=cmd_nav_add_item, kind="page", target_type="internal")

    nav_add_link = nav_sub.add_parser("add-link", help="Add navigation external link item")
    add_nav_item_base(nav_add_link)
    nav_add_link.set_defaults(func=cmd_nav_add_item, kind="link", target_type="external")

    nav_add_category = nav_sub.add_parser("add-category", help="Add navigation category/header item")
    add_nav_item_base(nav_add_category)
    nav_add_category.set_defaults(func=cmd_nav_add_item, kind="category", target_type="header")

    nav_add_generic = nav_sub.add_parser("add-item", help="Add generic navigation item")
    add_nav_item_base(nav_add_generic, kind_choices=["page", "category", "link", "separator"])
    nav_add_generic.set_defaults(func=cmd_nav_add_item)

    nav_remove = nav_sub.add_parser("remove-item", help="Remove navigation item by id")
    nav_remove.add_argument("--locale", default=default_locale)
    nav_remove.add_argument("--id", required=True)
    nav_remove.set_defaults(func=cmd_nav_remove_item)

    return parser


def load_config_from_args(args: argparse.Namespace) -> WikiConfig:
    wiki_url = (args.wiki_url or "").strip().rstrip("/")
    wiki_token = (args.wiki_token or "").strip()
    if not wiki_url:
        raise WikiError("WIKI_URL is required (env var or --wiki-url)")
    if not wiki_token:
        raise WikiError("WIKI_TOKEN is required (env var or --wiki-token)")

    locale = os.environ.get("WIKI_LOCALE", "en")
    editor = os.environ.get("WIKI_EDITOR", "markdown")

    return WikiConfig(
        url=wiki_url,
        token=wiki_token,
        locale=locale,
        editor=editor,
        timeout=args.timeout,
    )


def main(argv: Optional[List[str]] = None) -> int:
    default_locale = os.environ.get("WIKI_LOCALE", "en")
    default_editor = os.environ.get("WIKI_EDITOR", "markdown")

    parser = build_parser(default_locale=default_locale, default_editor=default_editor)
    args = parser.parse_args(argv)

    try:
        config = load_config_from_args(args)
        client = WikiClient(config, verbose=args.verbose)
        args.func(client, args)
        return 0
    except WikiError as exc:
        eprint(f"Error: {exc}")
        return 1
    except KeyboardInterrupt:
        eprint("Interrupted")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())