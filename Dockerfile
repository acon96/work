# ── base ─────────────────────────────────────────────────────────────────────
FROM node:24-slim

# Install system dependencies.
# squid-openssl is the SSL-bumping build of squid (needed for Mode B MITM).
# Note: squid and squid-openssl conflict — use squid-openssl only.
# build-essential is needed for native node module compilation (node-pty).
# e2fsprogs provides chattr for making sudoers immutable.
# supercronic is a cron-compatible job scheduler designed for containers.
RUN apt-get update && apt-get install -y --no-install-recommends \
        sudo \
        gosu \
        squid-openssl \
        dnsmasq \
        openssl \
        ca-certificates \
        python3 \
        python3-pip \
        python3-venv \
        python3-full \
        iptables \
        procps \
        jq \
        build-essential \
        git \
        zip \
        unzip \
        wget \
        curl \
        tree \
        htop \
        vim \
        nano \
        less \
        file \
        tar \
        zstd \
        lsof \
        net-tools \
        strace \
        ltrace \
        e2fsprogs \
    && rm -rf /var/lib/apt/lists/*

# Install supercronic (cron for containers)
ARG SUPERCRONIC_VERSION=0.2.33
ARG SUPERCRONIC_SHA1SUM=71b0d58cc53f6bd72cf2f293e09e294b79c666d8
RUN curl -fsSLO "https://github.com/aptible/supercronic/releases/download/v${SUPERCRONIC_VERSION}/supercronic-linux-amd64" \
 && echo "${SUPERCRONIC_SHA1SUM}  supercronic-linux-amd64" | sha1sum -c - \
 && chmod +x supercronic-linux-amd64 \
 && mv supercronic-linux-amd64 /usr/local/bin/supercronic

# ── users ─────────────────────────────────────────────────────────────────────
# The node:24-slim image already has a `node` user (uid 1000).
# We use uid 1001 for the agent user — the sole runtime user.
# Root is available for build-time / privileged operations; gosu used at runtime.
RUN useradd -m -u 1001 -s /bin/bash agent

# Passwordless sudo for the agent user — allowlist will be enforced at runtime
# by regenerating /etc/sudoers from /config/sudo-allowlist.txt in entrypoint.sh.
RUN echo 'agent ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/agent \
 && chmod 0440 /etc/sudoers.d/agent

# Copy sudo allowlist (will be processed into /etc/sudoers at container startup)
COPY config/sudo-allowlist.txt /config/sudo-allowlist.txt

# Application directory (owned by root for build steps)
RUN mkdir -p /app

# ── squid dirs (runtime ssl_db generated in entrypoint) ───────────────────────
RUN mkdir -p /var/lib/squid /var/log/squid \
 && chown proxy:proxy /var/lib/squid /var/log/squid \
 && chmod 750 /var/lib/squid

# ── proxy env ─────────────────────────────────────────────────────────────────
# All HTTP traffic from the agent user is routed through squid.
RUN printf '\nexport http_proxy=http://127.0.0.1:3128\nexport https_proxy=http://127.0.0.1:3128\nexport HTTP_PROXY=http://127.0.0.1:3128\nexport HTTPS_PROXY=http://127.0.0.1:3128\n' \
        >> /home/agent/.bashrc \
 && printf '\nexport http_proxy=http://127.0.0.1:3128\nexport https_proxy=http://127.0.0.1:3128\nexport HTTP_PROXY=http://127.0.0.1:3128\nexport HTTPS_PROXY=http://127.0.0.1:3128\n' \
        >> /home/agent/.profile

# ── config & scripts ──────────────────────────────────────────────────────────
COPY config/squid-allowlist.conf   /etc/work/squid-allowlist.conf
COPY config/squid-open-get.conf    /etc/work/squid-open-get.conf
COPY config/dnsmasq-allowlist.conf /etc/work/dnsmasq-allowlist.conf
COPY config/dnsmasq-open.conf      /etc/work/dnsmasq-open.conf
COPY config/proxy-allowlist.txt    /config/proxy-allowlist.txt
COPY config/agent.gitconfig        /home/agent/.gitconfig
COPY scripts/squid-url-rewrite.py  /usr/local/bin/squid-url-rewrite
COPY scripts/entrypoint.sh         /entrypoint.sh
COPY scripts/healthcheck.sh        /usr/local/bin/healthcheck
RUN chmod +x /entrypoint.sh /usr/local/bin/squid-url-rewrite /usr/local/bin/healthcheck

# ── workspace ─────────────────────────────────────────────────────────────────
RUN mkdir -p /workspace && chown agent:agent /workspace

# ── pi extensions (pinned npm packages) ──────────────────────────────────────
# Copy package.json and install off-the-shelf extensions.
# pi will auto-discover these via the "packages" array in .pi/settings.json.
WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev 2>&1
# Expose all npm-installed binaries (pi, pi-web-server, pi-web-sessiond, etc.)
ENV PATH="/app/node_modules/.bin:${PATH}"

# Copy local extensions and skills into the build context.
COPY extensions/ /app/extensions/
COPY skills/ /app/skills/

# ── pi directory structure ───────────────────────────────────────────────────
# ~/.pi/agent/settings.json — global settings (all projects)
# ~/.pi/agent/extensions/   — local extension files (auto-discovered by pi)
# ~/.pi/agent/skills/       — global skills (auto-discovered by pi)
# ~/.pi/sessions/           — session data (persisted via Docker volume)
RUN mkdir -p /home/agent/.pi/agent \
 && mkdir -p /home/agent/.pi/extensions \
 && mkdir -p /home/agent/.pi/agent/skills \
 && cp /app/extensions/*.ts /home/agent/.pi/extensions/ \
 && cp -r /app/skills/* /home/agent/.pi/agent/skills/ \
 && chown -R agent:agent /home/agent/.pi

# add default settings and models config (can be overridden by bind mounts in docker-compose.yml)
COPY .pi/agent/settings.json /home/agent/.pi/agent/settings.json
COPY .pi/agent/models.json /home/agent/.pi/agent/models.json

# Squid log directory (proxy user needs write access).
RUN mkdir -p /var/log/squid && chown proxy:proxy /var/log/squid

# The entrypoint starts dnsmasq + squid + pi-web, then execs the pi-web-server as agent.
ENTRYPOINT ["/entrypoint.sh"]
CMD ["pi-web-server"]

# Pi Web default port (web server)
EXPOSE 8504
