# Development and test image: Node 22, pnpm, Xvfb and the browser/Electron
# system libraries from the Playwright base image.
#
#   docker compose -f docker/compose.yml run --rm dev pnpm check
FROM node:22-bookworm-slim AS node22

FROM mcr.microsoft.com/playwright:v1.63.0-noble

# Node 22 takes precedence over the base image's Node (/usr/local/bin is first on PATH).
COPY --from=node22 /usr/local/bin/node /usr/local/bin/node
COPY --from=node22 /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && npm install -g pnpm@12.14.0 \
 && apt-get update \
 && apt-get install -y --no-install-recommends openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /home/ubuntu/.local/share/pnpm/store /home/ubuntu/.cache/electron \
 && chown -R 1000:1000 /home/ubuntu

# Run as the image's uid 1000 so files written to the bind mount stay yours.
USER 1000:1000
ENV PNPM_HOME=/home/ubuntu/.local/share/pnpm \
    PATH=/home/ubuntu/.local/share/pnpm:$PATH \
    ELECTRON_CACHE=/home/ubuntu/.cache/electron
WORKDIR /workspace
