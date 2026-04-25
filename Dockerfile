# Use the official Playwright image — includes Chromium + all system deps
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Install Chromium browser
RUN npx playwright install chromium

# Copy source + build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

CMD ["node", "dist/index.js"]
