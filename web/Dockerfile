# The trading terminal, built as a Next.js standalone server. Build it from the repo root,
# `docker build -f web/Dockerfile .`: the terminal type-checks against ../protocol.ts.
#
# NEXT_PUBLIC_API_URL is read by code that runs in the browser, so Next.js writes its value
# into the JavaScript bundle at build time. Changing it means rebuilding the image; setting
# it when the container starts has no effect. It must be the API's address as the browser
# sees it, and the API's WEB_ORIGIN must be this app's address as the browser sees it.

FROM node:24.21.0-alpine3.23 AS deps
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci

FROM node:24.21.0-alpine3.23 AS build
WORKDIR /app/web
ARG NEXT_PUBLIC_API_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/web/node_modules ./node_modules
COPY protocol.ts /app/
COPY web/ ./
RUN npm run build

FROM node:24.21.0-alpine3.23
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3001 HOSTNAME=0.0.0.0
# The standalone output is server.js plus only the node_modules it traced; static assets
# are served from beside it and are not traced, so they are copied in separately.
COPY --from=build /app/web/.next/standalone ./
COPY --from=build /app/web/.next/static ./.next/static
USER node
EXPOSE 3001
CMD ["node", "server.js"]
