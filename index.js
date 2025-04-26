require('dotenv').config();
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const qrcode = require('qrcode-terminal');

// Configuración de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Configuración de WhatsApp
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

// Configuración de Express
const app = express();
const port = process.env.PORT || 3000;

// Variables importantes
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL; // Vamos a poner esta variable en el .env
const processedMessages = new Set();

// Evento QR para escanear
client.on('qr', (qr) => {
  console.log('Escaneá este código QR para conectar WhatsApp:');
  qrcode.generate(qr, { small: true });
});

// Evento cuando está listo
client.on('ready', () => {
  console.log('✅ WhatsApp conectado y listo');
});

// Evento cuando llega un mensaje
client.on('message_create', async (message) => {
  const messageId = message.id._serialized;
  if (processedMessages.has(messageId)) return;
  processedMessages.add(messageId);
  setTimeout(() => processedMessages.delete(messageId), 5 * 60 * 1000); // 5 minutos

  // No reenviar mensajes que nosotros mismos enviamos
  if (message.fromMe) return;

  console.log('📩 Nuevo mensaje:', message.body);

  // Enviar el mensaje a n8n
  try {
    await axios.post(N8N_WEBHOOK_URL, {
      from: message.from,
      body: message.body,
      id: message.id._serialized,
      timestamp: message.timestamp
    });
    console.log('Mensaje enviado a n8n correctamente.');
  } catch (error) {
    console.error('Error enviando mensaje a n8n:', error.message);
  }
});

// Inicializar WhatsApp
client.initialize();

// Endpoint simple para saber que el servidor funciona
app.get('/', (req, res) => {
  res.send('Servidor de WhatsApp funcionando');
});

// Iniciar Express
app.listen(port, () => {
  console.log(`Servidor Express escuchando en puerto ${port}`);
});
