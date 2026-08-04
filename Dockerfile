# Multi-stage so the runtime image carries no toolchain and no source.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --omit=optional --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY examples ./examples
# Matches the `files` list in package.json, so `ripar init` works in the
# container exactly as it does from npm rather than failing on a missing dir.
COPY templates ./templates

# Never run the agent as root; a handler is arbitrary code by design.
RUN addgroup -S ripar && adduser -S ripar -G ripar
USER ripar

EXPOSE 4021
# Hits the free health route — it must not require payment, or the platform
# would mark a perfectly healthy agent as down.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4021)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/serve-example.js"]
