FROM node:18-alpine

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy source
COPY server.js ./

# Create required folders
RUN mkdir -p uploads/processed outputs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Start server
# Limit memory to prevent OOM crashes on Render free tier (512MB RAM)
ENV NODE_OPTIONS="--max-old-space-size=400"
CMD ["node", "server.js"]
