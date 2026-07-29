FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN sed -i 's|http://deb.debian.org/debian|http://mirrors.tencent.com/debian|g; s|http://deb.debian.org/debian-security|http://mirrors.tencent.com/debian-security|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
RUN useradd --create-home --uid 10001 processor \
  && mkdir -p /tmp/tianclip \
  && chown -R processor:processor /app /tmp/tianclip
USER processor
EXPOSE 10000
CMD ["node", "dist/server.js"]
