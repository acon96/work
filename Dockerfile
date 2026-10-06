# -- base ---------------------------------------------------------------------
FROM node:24-slim

# Install system dependencies.
# build-essential is needed for native node module compilation (node-pty).
# supercronic is a cron-compatible job scheduler designed for containers.
# There is deliberately no proxy, DNS, firewall, sudo, or privilege-dropping
# tooling here: outbound policy is enforced per-Bash-command by pi-sandbox
# (bubblewrap + seccomp network namespaces), and tool-level policy by
# pi-permission-system.
#
# bubblewrap/socat/ripgrep are the native prerequisites of pi-sandbox's Linux
# sandbox runtime. Unprivileged user namespaces must be available at runtime:
# on Kubernetes nodes this may require an AppArmor profile for bwrap or
# kernel.apparmor_restrict_unprivileged_userns=0.
RUN apt-get update && apt-get install -y --no-install-recommends \
        bubblewrap \
        socat \
        ripgrep \
        openssl \
        ca-certificates \
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
    && rm -rf /var/lib/apt/lists/*

# install UV to a system-wide location so all users (including agent) can use it
ENV UV_PYTHON_BIN_DIR=/usr/local/bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
RUN uv python install 3.13 --default && which python3
RUN uv python install 3.14

# Install supercronic (cron for containers)
ARG SUPERCRONIC_VERSION=0.2.33
ARG SUPERCRONIC_SHA1SUM=71b0d58cc53f6bd72cf2f293e09e294b79c666d8
RUN curl -fsSLO "https://github.com/aptible/supercronic/releases/download/v${SUPERCRONIC_VERSION}/supercronic-linux-amd64" \
 && echo "${SUPERCRONIC_SHA1SUM}  supercronic-linux-amd64" | sha1sum -c - \
 && chmod +x supercronic-linux-amd64 \
 && mv supercronic-linux-amd64 /usr/local/bin/supercronic

# -- users ---------------------------------------------------------------------
# The node:24-slim image already has a `node` user (uid 1000).
# We use uid 1001 for the agent user - the sole runtime user, and the user the
# container actually runs as (see USER below). There is no sudo and no
# privilege-dropping handoff: nothing this image runs needs root.
RUN useradd -m -u 1001 -s /bin/bash agent

# Application directory (owned by root for build steps)
RUN mkdir -p /app

# -- config & scripts ---------------------------------------------------------
# Security policy consumed by pi extensions. These files are treated as
# trusted policy inputs; pi-sandbox additionally write-protects its own config
# from sandboxed commands. Bind-mount them over (see docker-compose.yml) to
# change policy without rebuilding the image.
COPY config/pi-sandbox-config.json         /home/agent/.pi/agent/extensions/pi-sandbox/config.json
COPY config/pi-permission-system-config.json /home/agent/.pi/agent/extensions/pi-permission-system/config.json
# pi-web-access policy: search restricted to the configured SearXNG endpoint,
# SSRF guard with a narrow allow-range for the internal SearXNG container.
COPY config/web-search.json                /home/agent/.pi/agent/web-search.json
# Pristine root-owned copies: the entrypoint always re-renders the runtime
# configs from these at startup (idempotent env-var merges, and sandboxed
# commands cannot rewrite the source of truth).
COPY config/pi-sandbox-config.json         config/pi-permission-system-config.json config/web-search.json /etc/work/policies/
COPY config/agent.gitconfig        /home/agent/.gitconfig
COPY scripts/scheduler-run.sh      /usr/local/bin/scheduler-run
COPY scripts/entrypoint.sh         /entrypoint.sh
COPY scripts/healthcheck.sh        /usr/local/bin/healthcheck
RUN chmod +x /entrypoint.sh /usr/local/bin/scheduler-run /usr/local/bin/healthcheck

# -- workspace -----------------------------------------------------------------
RUN mkdir -p /workspace && chown agent:agent /workspace

# -- pi extensions (pinned npm packages) --------------------------------------
# Copy package.json and install off-the-shelf extensions.
# pi will auto-discover these via the "packages" array in .pi/settings.json.
WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev 2>&1
# pi-web ships the relays Pi package inside its tarball and its session daemon
# auto-installs it into the agent profile at startup (relays = remote/mobile
# relay sessions). This deployment does not use relays: remove the shipped
# source so the auto-install has nothing to install, and the entrypoint records
# the matching dismissal so the reconciliation skips it cleanly.
RUN rm -rf /app/node_modules/@jmfederico/pi-web/dist/pi-packages/relays

# -- pi-sandbox nested-container patch ----------------------------------------
# pi-sandbox always asks Sandbox Runtime for a fresh procfs inside each sandbox
# (--proc /proc).  An unprivileged container refuses that remount, so every
# sandboxed Bash command dies with "bwrap: Can't mount proc on /newroot/proc:
# Operation not permitted".  The patch flips Sandbox Runtime's documented
# enableWeakerNestedSandbox mode (which substitutes --bind /proc /proc), gated
# by PI_SANDBOX_WEAKER_NESTED.  pi-sandbox exposes no knob for this and its own
# config parser rejects unknown keys, so the package source is patched.
# The patch must re-apply on every pi-sandbox version bump: the build fails
# loudly if the hunk no longer matches.
COPY patches/ /tmp/work-patches/
RUN patch -p1 --no-backup-if-mismatch -d /app/node_modules/@erichll/pi-sandbox \
      < /tmp/work-patches/pi-sandbox-weaker-nested.patch \
 && rm -rf /tmp/work-patches
ENV PI_SANDBOX_WEAKER_NESTED=on
# Expose all npm-installed binaries (pi, pi-web-server, pi-web-sessiond, etc.)
ENV PATH="/app/node_modules/.bin:${PATH}"

# -- pi directory structure ---------------------------------------------------
# ~/.pi/agent/settings.json - global settings (all projects)
# ~/.pi/agent/extensions/   - local extension files (auto-discovered by pi)
# ~/.pi/agent/skills/       - global skills (auto-discovered by pi)
# ~/.pi/sessions/           - session data (persisted via Docker volume)
RUN mkdir -p /home/agent/.pi/agent \
 && mkdir -p /home/agent/.pi/agent/extensions \
 && mkdir -p /home/agent/.pi/agent/skills \
 && mkdir -p /home/agent/.pi/scheduled \
 && mkdir -p /home/agent/.pi/web \
 && chown -R agent:agent /home/agent/.pi

COPY extensions/ /home/agent/.pi/agent/extensions/
COPY skills/ /home/agent/.pi/agent/skills/

# -- Compile custom pi-web plugins from TypeScript ------------------------
# Install TypeScript as a build dependency (dev-only, not needed at runtime).
RUN --mount=type=cache,target=/root/.npm \
    npm install --no-save --omit=dev typescript 2>&1

# Copy the build script and plugin sources, then compile.
COPY scripts/build-plugins.sh /usr/local/bin/build-plugins
RUN chmod +x /usr/local/bin/build-plugins
COPY pi-web-plugins/ /app/.pi-web-plugins-src/

# Remove bundled info and workspace-tasks plugins (replaced by local versions),
# then compile and install custom plugins from TypeScript.
RUN PI_WEB_REPLACE_PLUGINS="info workspace-tasks" \
    /usr/local/bin/build-plugins /app/.pi-web-plugins-src /app/node_modules/@jmfederico/pi-web/dist/pi-web-plugins

# Pi Web configuration (pathAccess allows the scheduler history plugin to read
# execution logs from /home/agent/.pi/scheduled, which lives outside the workspace).
RUN mkdir -p /home/agent/.config/pi-web
COPY config/pi-web-config.json /home/agent/.config/pi-web/config.json
RUN chown -R agent:agent /home/agent/.config

# add default settings and models config (can be overridden by bind mounts in docker-compose.yml)
COPY .pi/agent/settings.json /home/agent/.pi/agent/settings.json
COPY .pi/agent/models.json /home/agent/.pi/agent/models.json
# Supported global Pi system-prompt override. This is deliberately not bind
# mounted, so the image ships the default prompt alongside its extensions.
COPY .pi/agent/SYSTEM.md /home/agent/.pi/agent/SYSTEM.md
RUN chown agent:agent /home/agent/.pi/agent/SYSTEM.md

# Set default env vars
ENV PI_WEB_DATA_DIR="/home/agent/.pi/web"
ENV SCHEDULER_STATE_DIR="/home/agent/.pi/scheduled"
ENV SCHEDULER_CRONTAB_PATH="/home/agent/.pi/scheduled/scheduler.crontab"
ENV PI_WEB_SESSIOND_SOCKET="/tmp/pi-web/sessiond.sock"

# The agent is the only runtime user. Nothing here needs root: there is no
# proxy, DNS, or privilege-dropping responsibility anywhere in this image.
# Outbound policy is enforced per-Bash-command by pi-sandbox (bubblewrap).
USER agent

# The entrypoint starts sessiond + supercronic, then execs the pi web server
# as the agent user.
ENTRYPOINT ["/entrypoint.sh"]
CMD ["pi-web-server"]

# Pi Web default port (web server)
EXPOSE 8504
