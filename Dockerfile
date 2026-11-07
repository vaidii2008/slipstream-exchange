# The API image. One image runs three commands: the API (the default), the migrations
# (`node migrate.ts`) and the bot fleet (`node fleet.ts`). Node 24 runs the .ts files as
# they are, so there is no build step: the stages only keep npm's cache out of the image.

FROM node:24.21.0-alpine3.23 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24.21.0-alpine3.23
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY drizzle ./drizzle
COPY *.ts ./
USER node
EXPOSE 3000
CMD ["node", "main.ts"]
