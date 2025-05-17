FROM node:22-slim
RUN apt-get update && apt-get install -y \
    chromium \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*
RUN which chromium || echo "Chromium no encontrado en /usr/bin/chromium" && \
    echo "Usando Chromium en: $(which chromium)"
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
EXPOSE 3000
CMD ["npm", "start"]
