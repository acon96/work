#!/usr/bin/env python3
"""
squid-url-rewrite — strip query strings from all proxied URLs.

Squid url_rewrite_program protocol (concurrency=0):
  stdin:  <channel-id> <URL> <client-addr>/<fqdn> <user> <method>\n
  stdout: <channel-id> OK rewrite-url=<new-url>\n   (or OK to pass through)

Each line must be answered with exactly one line.
"""
import sys
from urllib.parse import urlsplit, urlunsplit


def strip_query(url: str) -> str:
    try:
        parts = urlsplit(url)
        # Rebuild without query string or fragment.
        clean = urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
        return clean
    except Exception:
        return url


def main() -> None:
    for raw_line in sys.stdin:
        line = raw_line.rstrip("\n")
        if not line:
            continue

        # Split off the channel-id prefix (first token).
        parts = line.split(" ", 1)
        if len(parts) < 2:
            sys.stdout.write(f"{line} OK\n")
            sys.stdout.flush()
            continue

        channel_id, rest = parts
        # The URL is the first token in the remainder.
        tokens = rest.split(" ", 1)
        url = tokens[0]

        new_url = strip_query(url)

        if new_url == url:
            sys.stdout.write(f"{channel_id} OK\n")
        else:
            sys.stdout.write(f"{channel_id} OK rewrite-url={new_url}\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
