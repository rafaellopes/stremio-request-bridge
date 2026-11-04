FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# No dependencies to install: the addon uses only Node's standard library.
COPY package.json ./
COPY src ./src
COPY assets ./assets

USER node
EXPOSE 7000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-7000}/healthz" >/dev/null || exit 1

CMD ["node", "src/index.js"]
