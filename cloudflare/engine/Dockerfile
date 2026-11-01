# Agent sandboxes run under Cloudflare's durable_object scheduling policy, which
# needs no base image from Cloudflare: the Worker starts the container and runs
# commands in it directly. Ubuntu and Node match the earlier Sandbox SDK 0.12 base.
ARG NODE_VERSION=24

FROM docker.io/library/node:${NODE_VERSION}-slim AS node-runtime

FROM docker.io/library/ubuntu:22.04
ARG DSH_VERSION=0.2.1-rc.2
ARG CODEX_VERSION=0.165.0
ARG FOUNDRY_VERSION=1.8.1
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive \
    PATH=/opt/harness/node_modules/.bin:$PATH \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    XDG_DATA_HOME=/workspace/home/.local/share

USER root
# The Ubuntu base has no CA certificates, so install them from the default
# sources (apt verifies package signatures) before switching apt to HTTPS.
RUN apt-get -o Acquire::Retries=3 update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && sed -i \
      -e 's|http://archive.ubuntu.com|https://archive.ubuntu.com|g' \
      -e 's|http://security.ubuntu.com|https://security.ubuntu.com|g' \
      /etc/apt/sources.list \
    && apt-get -o Acquire::Retries=3 update \
    && apt-get install -y --no-install-recommends \
      bash build-essential ca-certificates curl file git jq libudev-dev libusb-1.0-0-dev \
      pkg-config procps python3 python3-pip python3-venv ripgrep sudo unzip util-linux vim-common \
      wget zip zstd \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node --version && npm --version

RUN case "${TARGETARCH}" in \
      amd64|arm64) foundry_arch="${TARGETARCH}" ;; \
      *) echo "unsupported Foundry architecture: ${TARGETARCH}" >&2; exit 2 ;; \
    esac \
    && foundry_base="foundry_v${FOUNDRY_VERSION}_linux_${foundry_arch}" \
    && curl -fsSLO "https://github.com/foundry-rs/foundry/releases/download/v${FOUNDRY_VERSION}/${foundry_base}.tar.gz" \
    && curl -fsSLO "https://github.com/foundry-rs/foundry/releases/download/v${FOUNDRY_VERSION}/${foundry_base}.sha256" \
    && sha256sum --check "${foundry_base}.sha256" \
    && tar -xzf "${foundry_base}.tar.gz" -C /usr/local/bin \
    && rm "${foundry_base}.tar.gz" "${foundry_base}.sha256"

COPY container/harness/package.json container/harness/package-lock.json /opt/harness/
COPY container/harness/patch-dsh-pi.mjs /opt/harness/
RUN test "$(node -p "require('/opt/harness/package.json').dependencies['@deepseek-ai/dsh']")" = "${DSH_VERSION}" \
    && test "$(node -p "require('/opt/harness/package.json').dependencies['@openai/codex']")" = "${CODEX_VERSION}" \
    && npm ci --ignore-scripts --prefix /opt/harness --no-audit --no-fund \
    && node /opt/harness/patch-dsh-pi.mjs /opt/harness \
    && npm rebuild --prefix /opt/harness \
      @deepseek-ai/dsh-subprocess-local koffi node-pty protobufjs \
    && cd /opt/harness \
    && node --input-type=module -e \
      "import('@deepseek-ai/dsh-app-boot').then(module => { if (typeof module.prepareProfilePatches !== 'function') process.exit(1) })" \
    && /opt/harness/node_modules/.bin/dsh --help >/dev/null

RUN useradd --uid 10001 --create-home --home-dir /workspace/home --shell /bin/bash ack3agent \
    && install -d -m 0700 -o 10001 -g 10001 /codex-home /workspace/home /workspace/source /workspace/results /workspace/accepted \
      /opt/dsh-home/profiles/native-worker \
    && printf '%s\n' \
      '{' \
      '  "name": "ack3-cloudflare-native-worker",' \
      '  "private": true,' \
      '  "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"], "patchReload": "startup"}}' \
      '}' > /opt/dsh-home/profiles/native-worker/package.json \
    && printf '%s\n' '# Provider configuration is supplied by the launch-fenced HOME patch.' \
      > /opt/dsh-home/profiles/native-worker/cordis.patch.yml \
    && ln -s /opt/harness/node_modules /opt/dsh-home/profiles/native-worker/node_modules \
    && chown -R 10001:10001 /opt/dsh-home \
    && cd /opt/dsh-home/profiles/native-worker \
    && setpriv --reuid=10001 --regid=10001 --init-groups \
      node --input-type=module -e "await import('@deepseek-ai/dsh-mcp-client')"

# Tools that follow XDG_DATA_HOME (for example Foundry's compiler cache) write to
# the unprivileged agent home. Foundry installs the Solidity compiler a project needs.
RUN install -d -m 0755 -o 10001 -g 10001 /workspace/home/.local/share

COPY container/agent-runner.mjs /usr/local/bin/ack3-agent-runner
COPY container/output-files.mjs /usr/local/bin/output-files.mjs
COPY container/agent-log-writer.mjs /usr/local/bin/agent-log-writer.mjs
COPY container/claude-runner.mjs /usr/local/bin/claude-runner.mjs
COPY container/claude-usage.mjs /usr/local/bin/claude-usage.mjs
COPY container/subscription-limits.mjs /usr/local/bin/subscription-limits.mjs
COPY container/codex-subscription.mjs /usr/local/bin/codex-subscription.mjs
COPY container/codex-usage.mjs /usr/local/bin/codex-usage.mjs
COPY container/dsh-usage.mjs /usr/local/bin/dsh-usage.mjs
COPY container/dsh-cost.mjs /usr/local/bin/dsh-cost.mjs
COPY container/native-search-evidence.mjs /usr/local/bin/native-search-evidence.mjs
COPY container/reasoning-config.mjs /usr/local/bin/reasoning-config.mjs
COPY container/install-codex-auth.sh /usr/local/bin/ack3-install-codex-auth
COPY container/prepare-source.sh /usr/local/bin/ack3-prepare-source
COPY container/prepare-workspace.mjs /usr/local/bin/ack3-prepare-workspace
COPY container/install-os-packages.py /usr/local/bin/ack3-install-os-packages
COPY container/reset-accepted.sh /usr/local/bin/ack3-reset-accepted
COPY container/preflight.sh /usr/local/bin/ack3-preflight
COPY container/preflight.mjs /usr/local/lib/ack3/preflight.mjs
RUN mkdir -p /opt/ack3 \
    && chmod 0755 /usr/local/bin/ack3-* \
    && printf '%s\n' 'ack3agent ALL=(root) NOPASSWD: /usr/local/bin/ack3-install-os-packages' \
      > /etc/sudoers.d/ack3-agent-packages \
    && chmod 0440 /etc/sudoers.d/ack3-agent-packages \
    && printf '%s\n' '#!/bin/sh' 'exit 101' > /usr/sbin/policy-rc.d \
    && chmod 0755 /usr/sbin/policy-rc.d \
    && { uname -m; node --version; npm --version; forge --version; cast --version; anvil --version; xxd -v 2>&1; } \
      > /opt/ack3/TOOL_VERSIONS \
    && sha256sum \
      /opt/harness/package-lock.json \
      /opt/harness/patch-dsh-pi.mjs \
      /opt/ack3/TOOL_VERSIONS \
      /usr/local/bin/ack3-agent-runner \
      /usr/local/bin/output-files.mjs \
      /usr/local/bin/agent-log-writer.mjs \
      /usr/local/bin/claude-runner.mjs \
      /usr/local/bin/claude-usage.mjs \
      /usr/local/bin/subscription-limits.mjs \
      /usr/local/bin/codex-subscription.mjs \
      /usr/local/bin/dsh-usage.mjs \
      /usr/local/bin/dsh-cost.mjs \
      /usr/local/bin/native-search-evidence.mjs \
      /usr/local/bin/reasoning-config.mjs \
      /usr/local/bin/ack3-preflight \
      /usr/local/bin/ack3-prepare-source \
      /usr/local/bin/ack3-prepare-workspace \
      /usr/local/bin/ack3-install-os-packages \
      /usr/local/lib/ack3/preflight.mjs \
    | sha256sum | cut -d' ' -f1 > /opt/ack3/BUILD_FINGERPRINT \
    && grep -Eq '^[0-9a-f]{64}$' /opt/ack3/BUILD_FINGERPRINT

WORKDIR /workspace
# The Worker starts the container with this command and runs each task through exec.
CMD ["sleep", "infinity"]
