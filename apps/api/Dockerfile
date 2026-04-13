FROM node:22-alpine AS base
WORKDIR /app

COPY package*.json ./
COPY apps/api/package*.json ./apps/api/
RUN npm ci

COPY apps/api ./apps/api
WORKDIR /app/apps/api
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY apps/api/package*.json ./apps/api/
RUN npm ci --omit=dev

COPY --from=base /app/apps/api/dist ./apps/api/dist
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["node", "dist/server.js"]
