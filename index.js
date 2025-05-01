require('dotenv').config();

const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const axios = require('axios'); // Para enviar a n8n

// Configuración de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Configuración de WhatsApp
const client = new Client({
  puppeteer: {
    executablePath: undefined,
    args: ['--no-sandbox'],
    headless: 'new',
    ignoreHTTPSErrors: true,
    dumpio: false
  },
  authStrategy: new LocalAuth({ clientId: 'my-client' }),
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
  }
});

const app = express();
const port = process.env.PORT || 3000;
app.use(bodyParser.json());

// Normaliza el número de WhatsApp (sin @c.us)
function normalizeWhatsappNumber(number) {
  return number ? number.replace('@c.us', '').trim() : null;
}

// Envia mensaje a n8n
async function sendMessageToN8n(message, clientNumber) {
  try {
    const response = await axios.post(`${process.env.N8N_WEBHOOK_URL}`, {
      message: message,
      clientNumber: normalizeWhatsappNumber(clientNumber)
    });
    return response.data;
  } catch (error) {
    console.error('Error enviando mensaje a n8n:', error.message);
    return { error: true, message: 'No se pudo procesar el mensaje' };
  }
}

// QR plano en consola para pegar en lector externo
client.on('qr', (qr) => {
  console.log('📱 Escaneá este QR desde WhatsApp Web o copiá el siguiente texto en un generador QR externo:\n');
  console.log(qr);
  console.log('\n👉 Podés usar: https://www.qr-code-generator.com/');
});

client.on('authenticated', () => {
  console.log('✅ Autenticado en WhatsApp');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Fallo de autenticación:', msg);
});

client.on('ready', () => {
  console.log('🚀 Cliente de WhatsApp listo');
});

client.on('disconnected', (reason) => {
  console.log('🔌 Cliente desconectado:', reason);
  client.initialize();
});

// Mensaje recibido
client.on('message_create', async (msg) => {
  if (msg.fromMe) return;

  console.log('💬 Mensaje recibido:', msg.body);

  // Guardar mensaje entrante
  await supabase.from('messages').insert([
    {
      body: msg.body,
      from: msg.from,
      tenant_id: 1,
      is_outgoing: false,
      created_at: new Date().toISOString()
    }
  ]);

  // Enviar a n8n
  const response = await sendMessageToN8n(msg.body, msg.from);

  if (response && response.reply) {
    await client.sendMessage(msg.from, response.reply);

    await supabase.from('messages').insert([
      {
        body: response.reply,
        from: msg.from,
        tenant_id: 1,
        is_outgoing: true,
        created_at: new Date().toISOString(),
        response_source: 'n8n',
        response_status: 'sent'
      }
    ]);
  }
});

client.initialize();
app.listen(port, () => {
  console.log(`🟢 Servidor corriendo en el puerto ${port}`);
});
