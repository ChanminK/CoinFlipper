# Use Node.js 18 Alpine for smaller image size
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Create data directory for state storage
RUN mkdir -p data

# Expose port (if needed for health checks)
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
