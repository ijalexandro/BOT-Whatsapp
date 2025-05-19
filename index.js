require('dotenv').config();

const express = require('express');
const { Client } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const axios = require('axios');
const qrcode = require('qrcode-terminal');

// Validación de variables de entorno críticas
['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SESSION_BUCKET', 'SESSION_FILE', 'N8N_WEBHOOK_URL'].forEach(key => {
  if (!process.env[key]) {
    console.error(`❌ Falta la variable de entorno: ${key}`);
    process.exit(1);
  }
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Catálogo global en memoria
let globalCatalog = null;

console.log('Iniciando el bot...');
console.log('Node.js:', process.version);

// Carga del catálogo una sola vez
async function loadGlobalCatalog() {
  const { data, error } = await supabase
    .from('productos')
    .select('nombre, precio, descripcion, tamano, foto_url, categoria')
    .eq('tenant_id', '1');
  if (error) {
    console.error('Error al cargar catálogo:', error.message);
    globalCatalog = [];
  } else {
    globalCatalog = data;
    console.log('Catálogo cargado:', data.length, 'items');
  }
}

// Persistencia de sesión en Supabase Storage
async function getSession() {
  const { data, error } = await supabase
    .storage.from(process.env.SESSION_BUCKET)
    .download(process.env.SESSION_FILE);
  if (error || !data) return null;
  return JSON.parse(await data.text());
}

async function saveSession(sess) {
  await supabase
    .storage.from(process.env.SESSION_BUCKET)
    .upload(process.env.SESSION_FILE, Buffer.from(JSON.stringify(sess)), { upsert: true });
}

// Función para normalizar números de WhatsApp
function normalizeWhatsappNumber(number) {
  return number ? number.replace(/@c\.us$/, '').trim() : null;
}

// Obtiene historial de conversación
async function fetchConversationHistory(clientNumber, tenantId) {
  const { data: msgs, error } = await supabase
    .from('messages')
    .select('body, is_outgoing')
    .eq('from', clientNumber)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(2);
  if (error) {
    console.error('Error al leer historial:', error.message);
    return 'No hay historial disponible.';
  }
  return msgs
    .reverse()
    .map(m => `${m.is_outgoing ? 'Asistente' : 'Cliente'}: ${m.body}`)
    .join('\n');
}

// Lógica de consulta a n8n
async function sendMessageToN8n(message, clientNumber, tenantId) {
  try {
    const history = await fetchConversationHistory(clientNumber, tenantId);
    console.log('Enviando a n8n:', { message, clientNumber, history });
    const { data } = await axios.post(process.env.N8N_WEBHOOK_URL, {
      message,
      clientNumber,
      conversationHistory: history
    });
    return data;
  } catch (error) {
    console.error('Error al enviar a n8n:', error.message);
    return { error: true };
  }
}

// Validación y corrección de respuesta JSON
async function validateAndCorrectResponse(response, tenantId) {
  let parsed;
  const match = response.match(/```json\n([\s\S]*?)\n```/);
  try {
    parsed = JSON.parse(match ? match[1] : response);
  } catch (err) {
    return { response: { mensaje: response }, corrected: false };
  }
  if (parsed.respuesta) return { response: { mensaje: parsed.respuesta }, corrected: false };
  if (parsed.error) return { response: parsed, corrected: false };
  const catalog = globalCatalog || [];
  // Corrección similar a la original...
  return { response: parsed, corrected: false };
}

// Registro de pedido en DB
async function registerOrder({ clientNumber, tenantId, productName, price, size }) {
  const nPrice = parseFloat(String(price).replace(/[^0-9.]/g, ''));
  if (isNaN(nPrice)) return;
  const { error } = await supabase.from('pedidos').insert([{ 
    client_number: clientNumber,
    tenant_id: tenantId,
    product_name: productName,
    price: nPrice,
    size,
    status: 'pendiente',
    created_at: new Date().toISOString()
  }]);
  if (error) console.error('Error al registrar pedido:', error.message);
}

// Servidor Express
const app = express();
app.use(bodyParser.json());

const port = process.env.PORT || 3000;

// Inicialización de WhatsApp
;(async () => {
  await loadGlobalCatalog();
  const legacySession = await getSession();
  const client = new Client({
    session: legacySession || undefined,
    puppeteer: { headless: 'new', args: ['--no-sandbox'], ignoreHTTPSErrors: true, dumpio: true }
  });

  client.on('qr', qr => qrcode.generate(qr, { small: true }));
  client.on('authenticated', sess => saveSession(sess));
  client.on('ready', () => console.log('🤖 WhatsApp listo'));
  client.on('disconnected', () => client.initialize());

  client.on('message_create', async msg => {
    const id = msg.id._serialized;
    if (!msg.fromMe && !processedMessages.has(id)) {
      processedMessages.add(id);
      // Guardar entrante
      await supabase.from('messages').insert([{ 
        body: msg.body,
        from: msg.from,
        tenant_id: 1,
        is_outgoing: false,
        created_at: new Date().toISOString()
      }]);
      const resp = await sendMessageToN8n(msg.body, normalizeWhatsappNumber(msg.from), 1);
      if (resp.reply) {
        const text = resp.reply;
        await client.sendMessage(msg.from, text);
        await supabase.from('messages').insert([{ 
          body: text,
          from: msg.from,
          recipient: msg.from,
          tenant_id: 1,
          is_outgoing: true,
          created_at: new Date().toISOString()
        }]);
      }
      setTimeout(() => processedMessages.delete(id), 300000);
    }
  });

  // Endpoint para n8n
  app.post('/send-message', async (req, res) => {
    const { to, body } = req.body;
    try {
      await client.sendMessage(to, body);
      res.json({ status: 'enviado' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  await client.initialize();
  app.listen(port, () => console.log(`🚀 Servidor en puerto ${port}`));
})();
