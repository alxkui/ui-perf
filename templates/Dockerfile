FROM mcr.microsoft.com/playwright:v1.48.0-noble

WORKDIR /app

# Copy package manifests and install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application files and built dist
COPY . .
RUN npm run build

# Default environment variables for Kubernetes & Argo
ENV NODE_ENV=production
ENV CI=1

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["run"]
