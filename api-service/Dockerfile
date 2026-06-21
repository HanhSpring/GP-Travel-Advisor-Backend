FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source and build
COPY . .
RUN npm run build

# Production image
FROM node:20-alpine

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm install --only=production

# Copy built artifacts from builder
COPY --from=builder /app/dist ./dist

# Expose API port
EXPOSE 3000

# Start the application
CMD ["node", "dist/main"]
