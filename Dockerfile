FROM node:20-alpine AS builder

WORKDIR /app

# Force development mode during build to ensure typescript is installed
ENV NODE_ENV=development

# Install dependencies needed for compiling better-sqlite3
RUN apk add --no-cache python3 make g++ 

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++ 

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

# Create data directory for SQLite
RUN mkdir -p /app/data && chown -R node:node /app/data

# Use non-root user
USER node

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/index.js"]
