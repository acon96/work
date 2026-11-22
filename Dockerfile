# -- pi-web (rebuilt from upstream source with local patch) --------------------
# patches/pi-web-request-storm.patch is a source-level patch: it changes
# TypeScript under src/client and pi-web-plugins, and the published tarball
# ships only the compiled dist. Shipping the fix therefore means rebuilding
# pi-web from the source of the exact version pinned in package.json.
# The produced dist is a drop-in replacement for the published one: same file
# set, with the patched client chunks as the only difference (verified below in
# the main stage). Bumping @jmfederico/pi-web in package.json is enough to
# rebuild this stage; the patch must still apply to the new tag.
FROM node:24-slim AS pi-web-build
# git to fetch the tag, build-essential/python3 for the native install script of
# node-pty (an optional dependency npm would otherwise skip silently).
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        build-essential \
        python3 \
    && rm -rf /var/lib/apt/lists/*
# The version pin in this repository's package.json is the single source of
# truth for which upstream tag gets built, so the two cannot drift apart.
COPY package.json /tmp/work-package.json
RUN PI_WEB_VERSION="$(node -p "require('/tmp/work-package.json').dependencies['@jmfederico/pi-web']")" \
 && case "${PI_WEB_VERSION}" in \
      [0-9]*) ;; \
      *) echo "the @jmfederico/pi-web pin must be an exact version, got ${PI_WEB_VERSION}" >&2; exit 1 ;; \
    esac \
 && echo "building pi-web v${PI_WEB_VERSION} from source" \
 && git clone --depth 1 --single-branch --branch "v${PI_WEB_VERSION}" https://github.com/jmfederico/pi-web.git /build \
 && rm -rf /build/.git
WORKDIR /build
COPY patches/pi-web-request-storm.patch /build/patches/
RUN git apply --verbose patches/pi-web-request-storm.patch
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund 2>&1 && npm run build 2>&1

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

# install kubectl
RUN curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
    && install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl \
    && rm kubectl \
    && kubectl version --client

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
# trusted policy inputs; pi-sandbox write-protects its own config from
# sandboxed commands (see its denyWrite list). Bind-mount them over (see
# docker-compose.yml) to change policy without rebuilding the image.
# pi-sandbox (carderne/pi-sandbox) reads its global config from
# ~/.pi/agent/sandbox.json.
COPY config/sandbox.json                   /home/agent/.pi/agent/sandbox.json
COPY config/pi-permission-system-config.json /home/agent/.pi/agent/extensions/pi-permission-system/config.json
# pi-web-access policy: search restricted to the configured SearXNG endpoint,
# SSRF guard with a narrow allow-range for the internal SearXNG container.
COPY config/web-search.json                /home/agent/.pi/agent/web-search.json
# Pristine root-owned copies: the entrypoint always re-renders the runtime
# configs from these at startup (idempotent env-var merges, and sandboxed
# commands cannot rewrite the source of truth).
COPY config/sandbox.json                   config/pi-permission-system-config.json config/web-search.json /etc/work/policies/
COPY config/agent.gitconfig        /home/agent/.gitconfig
COPY scripts/scheduler-run.sh      /usr/local/bin/scheduler-run
COPY scripts/entrypoint.sh         /entrypoint.sh
COPY scripts/healthcheck.sh        /usr/local/bin/healthcheck
RUN chmod +x /entrypoint.sh /usr/local/bin/scheduler-run /usr/local/bin/healthcheck

# -- workspace -----------------------------------------------------------------
# /workspace  - the agent's persistent, writable project root (bind-mounted).
# /scratch    - stable agent-writable temp space. At runtime this is overlaid by
#               a memory-backed volume (tmpfs / emptyDir medium: Memory) so it
#               never touches disk and resets with the container. The directory
#               is world-writable with the sticky bit so an externally mounted
#               volume keeps working regardless of its owning uid.
RUN mkdir -p /workspace && chown agent:agent /workspace \
 && mkdir -p /scratch && chmod 1777 /scratch

# -- pi extensions (pinned npm packages) --------------------------------------
# Copy package.json and install off-the-shelf extensions.
# pi will auto-discover these via the "packages" array in .pi/settings.json.
WORKDIR /app
COPY package.json /app/package.json
# --legacy-peer-deps: pi-sandbox still declares peerOptional
# @earendil-works/pi-coding-agent@^0.80.0 (stale metadata published with
# 0.7.1) while this image pins the 1.x agent every other extension requires.
# The package's own imports resolve fine against 1.0.4; only its peer range is
# behind, so the conflict is metadata, not a real incompatibility.
RUN npm install --omit=dev --legacy-peer-deps 2>&1
# Swap the published pi-web build for the patched one built in the first stage.
# Only dist is replaced: package.json and the package's installed dependencies
# stay the published ones, which is the same version the patched dist was
# compiled from. This must happen before the plugin build below, which writes
# into dist/pi-web-plugins.
COPY --from=pi-web-build /build/dist /app/node_modules/@jmfederico/pi-web/dist
# Fail the build rather than ship a half-applied swap: the replaced dist must
# belong to the pinned version, and it must actually carry the patch (this
# string only exists in the patched refresh-batch code).
RUN INSTALLED_PI_WEB_VERSION="$(jq -r .version /app/node_modules/@jmfederico/pi-web/package.json)" \
 && PINNED_PI_WEB_VERSION="$(jq -r '.dependencies["@jmfederico/pi-web"]' /app/package.json)" \
 && test "${INSTALLED_PI_WEB_VERSION}" = "${PINNED_PI_WEB_VERSION}" \
    || { echo "pi-web version mismatch: installed ${INSTALLED_PI_WEB_VERSION}, pinned ${PINNED_PI_WEB_VERSION}"; exit 1; } \
 && grep -rq "concurrency must be a positive integer" /app/node_modules/@jmfederico/pi-web/dist/client \
    || { echo "pi-web dist does not contain the request-storm patch"; exit 1; } \
 && echo "pi-web ${INSTALLED_PI_WEB_VERSION} dist replaced with patched build"
# pi-web ships the relays Pi package inside its tarball and its session daemon
# auto-installs it into the agent profile at startup (relays = remote/mobile
# relay sessions). This deployment does not use relays: remove the shipped
# source so the auto-install has nothing to install, and the entrypoint records
# the matching dismissal so the reconciliation skips it cleanly.
RUN rm -rf /app/node_modules/@jmfederico/pi-web/dist/pi-packages/relays

# Nested-container sandboxing needs no patch: pi-sandbox (carderne) exposes
# Sandbox Runtime's documented enableWeakerNestedSandbox through its own config
# (config/sandbox.json), which binds the container's /proc instead of asking
# bwrap for a fresh procfs an unprivileged container would refuse. Sandboxed
# Bash can therefore see this container's process table; the outer container is
# the security boundary that matters.
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
    npm install --no-save --omit=dev --legacy-peer-deps typescript 2>&1

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
