# ── base ─────────────────────────────────────────────────────────────────────
FROM node:24-slim AS base

# Install system dependencies.
# squid-openssl is the SSL-bumping build of squid (needed for Mode B MITM).
# Note: squid and squid-openssl conflict — use squid-openssl only.
# build-essential is needed for native node module compilation (node-pty).
RUN apt-get update && apt-get install -y --no-install-recommends \
        sudo \
        squid-openssl \
        dnsmasq \
        openssl \
        ca-certificates \
        python3 \
        iptables \
        procps \
        jq \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

# ── users ─────────────────────────────────────────────────────────────────────
# The node:24-slim image already has a `node` user (uid 1000).
# We use 1001/1002 to avoid conflicts.
# work  (uid 1001) – owns /app; runs the pi server
# agent (uid 1002) – runs pi tool-calls; heavily restricted
RUN useradd -m -u 1001 -s /bin/bash work \
 && useradd -m -u 1002 -s /bin/bash agent

# Application directory
RUN mkdir -p /app && chown work:work /app

# ── squid MITM CA (Mode B) ────────────────────────────────────────────────────
# Generated once at image build time; injected into the system trust store so
# node processes running as agent/work trust it automatically.
RUN openssl req -new -newkey rsa:4096 -days 3650 -nodes -x509 \
        -subj "/CN=Work Proxy CA/O=Work Sandbox/C=US" \
        -keyout /etc/squid/ssl-ca.key \
        -out /etc/squid/ssl-ca.crt \
 && cp /etc/squid/ssl-ca.crt /usr/local/share/ca-certificates/work-proxy-ca.crt \
 && update-ca-certificates

# Squid SSL certificate cache (used only in Mode B)
# security_file_certgen -c creates the ssl_db directory itself; pre-creating it causes failure.
RUN mkdir -p /var/lib/squid \
 && chown proxy:proxy /var/lib/squid \
 && chmod 750 /var/lib/squid \
 && /usr/lib/squid/security_file_certgen -c -s /var/lib/squid/ssl_db -M 4MB

# ── proxy env for agent user ──────────────────────────────────────────────────
RUN printf '\nexport http_proxy=http://127.0.0.1:3128\nexport https_proxy=http://127.0.0.1:3128\nexport HTTP_PROXY=http://127.0.0.1:3128\nexport HTTPS_PROXY=http://127.0.0.1:3128\n' \
        >> /home/agent/.bashrc \
 && printf '\nexport http_proxy=http://127.0.0.1:3128\nexport https_proxy=http://127.0.0.1:3128\nexport HTTP_PROXY=http://127.0.0.1:3128\nexport HTTPS_PROXY=http://127.0.0.1:3128\n' \
        >> /home/agent/.profile

# ── config & scripts ──────────────────────────────────────────────────────────
COPY config/squid-allowlist.conf   /etc/work/squid-allowlist.conf
COPY config/squid-open-get.conf    /etc/work/squid-open-get.conf
COPY config/dnsmasq-allowlist.conf /etc/work/dnsmasq-allowlist.conf
COPY config/dnsmasq-open.conf      /etc/work/dnsmasq-open.conf
COPY config/proxy-allowlist.txt    /etc/work/proxy-allowlist.txt.default
COPY config/sudo-allowlist.txt     /etc/work/sudo-allowlist.txt.default
COPY scripts/squid-url-rewrite.py  /usr/local/bin/squid-url-rewrite
COPY scripts/entrypoint.sh         /entrypoint.sh
RUN chmod +x /entrypoint.sh /usr/local/bin/squid-url-rewrite

# Bootstrap config directory (runtime /config volume overlays this)
RUN mkdir -p /config \
 && cp /etc/work/proxy-allowlist.txt.default /config/proxy-allowlist.txt \
 && cp /etc/work/sudo-allowlist.txt.default  /config/sudo-allowlist.txt

# ── workspace ─────────────────────────────────────────────────────────────────
RUN mkdir -p /workspace && chown work:work /workspace

# ── pi project settings ──────────────────────────────────────────────────────
# .pi/settings.json tells pi where to store sessions and which packages to load.
# sessionDir is the directory where session files are stored.
# packages loads off-the-shelf extensions by npm name (pinned versions).
# extensions adds local paths.
RUN mkdir -p /home/work/.pi \
 && chown work:work /home/work/.pi

# ── pi extensions (pinned npm packages) ──────────────────────────────────────
# Copy package.json and install off-the-shelf extensions.
# pi will auto-discover these via the "packages" array in .pi/settings.json.
WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev 2>&1

# Copy local extensions into the build context.
COPY extensions/ /app/extensions/

# Copy local extensions into the .pi/extensions directory where pi auto-discovers them.
RUN mkdir -p /home/work/.pi/extensions \
 && cp /app/extensions/*.ts /home/work/.pi/extensions/ \
 && chown -R work:work /home/work/.pi

# The entrypoint starts dnsmasq + squid then execs the pi server as work.
ENTRYPOINT ["/entrypoint.sh"]
