FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/migrations ./dist/db/migrations

EXPOSE 3000

# Railway sobrescreve o start command por serviço:
#   booking-api    → node dist/server.js
#   booking-worker → node dist/worker.js
CMD ["node", "dist/server.js"]
