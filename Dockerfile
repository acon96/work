# ── base ─────────────────────────────────────────────────────────────────────
FROM node:22-slim AS base

# Install system dependencies.
# squid-openssl is the SSL-bumping build of squid (needed for Mode B MITM).
RUN apt-get update && apt-get install -y --no-install-recommends \
        sudo \
        squid \
        squid-openssl \
        dnsmasq \
        openssl \
        ca-certificates \
        python3 \
        iptables \
        procps \
    && rm -rf /var/lib/apt/lists/*

# ── users ─────────────────────────────────────────────────────────────────────
# work  (uid 1000) – owns /app; runs the pi server
# agent (uid 1001) – runs pi tool-calls; heavily restricted
RUN useradd -m -u 1000 -s /bin/bash work \
 && useradd -m -u 1001 -s /bin/bash agent

# Application directory
RUN mkdir -p /app && chown work:work /app

# ── sudo ──────────────────────────────────────────────────────────────────────
# The sudo-wrapper script is the ONLY binary agent may sudo.
# It re-checks the runtime allowlist at call time.
COPY scripts/sudo-wrapper.sh /usr/local/bin/sudo-wrapper
RUN chmod 755 /usr/local/bin/sudo-wrapper \
 && echo "agent ALL=(root) NOPASSWD: /usr/local/bin/sudo-wrapper" \
         > /etc/sudoers.d/agent \
 && chmod 440 /etc/sudoers.d/agent

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
RUN mkdir -p /var/lib/squid/ssl_db \
 && /usr/lib/squid/security_file_certgen -c -s /var/lib/squid/ssl_db -M 4MB \
 && chown -R proxy:proxy /var/lib/squid/ssl_db

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

WORKDIR /app

# The entrypoint starts dnsmasq + squid then execs the pi server as work.
ENTRYPOINT ["/entrypoint.sh"]
