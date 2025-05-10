# Usar una imagen base de Node.js con soporte para Chromium
FROM node:22-slim

# Instalar dependencias necesarias para Chromium
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

# Verificar la ruta de Chromium
RUN which chromium || echo "Chromium no encontrado en /usr/bin/chromium, intentando otra ruta" && \
    [ -f /usr/lib/chromium-browser/chromium ] && echo "Chromium encontrado en /usr/lib/chromium-browser/chromium" || echo "Chromium no encontrado"

# Establecer el directorio de trabajo
WORKDIR /app

# Copiar los archivos de package.json y package-lock.json (si existe)
COPY package*.json ./

# Instalar las dependencias de Node.js
RUN npm install

# Copiar el resto de los archivos del proyecto
COPY . .

# Configurar la variable de entorno para Puppeteer
ENV PUPPETEER_EXECUTABLE_PATH=/usr/lib/chromium-browser/chromium

# Exponer el puerto
EXPOSE 3000

# Comando para iniciar la aplicación
CMD ["npm", "start"]
