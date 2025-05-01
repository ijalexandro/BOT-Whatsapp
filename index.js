require('dotenv').config();

const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const axios = require('axios');
const qrcode = require('qrcode-terminal');

// Supabase config
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Autenticación con sesión guardada en Supabase
class SupabaseLocalAuth extends LocalAuth {
  constructor(clientId, supabase) {
    super({ clientId: clientId || 'default-client', dataPath: '/tmp/.wwebjs_auth' });
    this.supabase = supabase;
  }

  async getAuth() {
    try {
      const { data, error } = await this.supabase
        .from('whatsapp_sessions')
        .select('session_data')
        .eq('client_id', this.clientId)
        .single();

      if (error || !data) return super.getAuth();
      return JSON.parse(data.session_data);
    } catch {
      return super.getAuth();
    }
  }

  async logout() {
    await this.supabase
      .from('whatsapp_sessions')
      .delete()
      .eq('client_id', this.clientId);
    await super.logout();
  }
}

// Configurar cliente WhatsApp
const client = new Client({
  puppeteer: {
    args: ['--no-sandbox'],
    headless: 'new',
  },
  authStrategy: new SupabaseLocalAuth('my-client', supabase),
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
  }
});

const app = express();
const port = process.env.PORT || 3000;
app.use(bodyParser.json());

// Normalizar número de WhatsApp
function normalizeWhatsappNumber(number) {
  return number ? number.replace('@c.us', '').trim() : null;
}

// Enviar mensaje a n8n
async function sendMessageToN8n(message, clientNumber) {
  try {
    const response = await axios.post(process.env.N8N_WEBHOOK_URL, {
      message,
      clientNumber: normalizeWhatsappNumber(clientNumber)
    });
    return response.data;
  } catch (error) {
    console.error('Error enviando a n8n:', error.message);
    return { error: true, message: 'Error al procesar el mensaje.' };
  }
}

// Eventos de WhatsApp
client.on('qr', (qr) => {
  console.log('\n📱 Escaneá este código QR desde WhatsApp Web:');
  console.log('\n' + qr + '\n');
  console.log('Podés copiarlo y usar un generador QR como https://www.qr-code-generator.com/');
});

client.on('authenticated', async (session) => {
  console.log('✅ Autenticado en WhatsApp.');
  await supabase
    .from('whatsapp_sessions')
    .upsert([{
      client_id: 'my-client',
      session_data: JSON.stringify(session),
      updated_at: new Date().toISOString()
    }], { onConflict: ['client_id'] });
});

client.on('auth_failure', (msg) => {
  console.error('❌ Fallo de autenticación:', msg);
});

client.on('ready', () => {
  console.log('🤖 Bot listo y conectado a WhatsApp.');
});

client.on('disconnected', (reason) => {
  console.log('🔌 Cliente desconectado:', reason);
  client.initialize();
});

client.on('message_create', async (msg) => {
  if (msg.fromMe) return;

  console.log('📨 Mensaje recibido:', msg.body);

  // Guardar mensaje entrante en Supabase
  await supabase.from('messages').insert([{
    body: msg.body,
    from: msg.from,
    tenant_id: 1,
    is_outgoing: false,
    created_at: new Date().toISOString()
  }]);

  // Enviar mensaje a n8n
  const response = await sendMessageToN8n(msg.body, msg.from);

  if (response && response.reply) {
    await client.sendMessage(msg.from, response.reply);

    // Guardar respuesta enviada
    await supabase.from('messages').insert([{
      body: response.reply,
      from: msg.from,
      tenant_id: 1,
      is_outgoing: true,
      response_source: 'n8n',
      response_status: 'sent',
      created_at: new Date().toISOString()
    }]);
  }
});

// Inicializar servidor
client.initialize();
app.listen(port, () => {
  console.log(`🚀 Servidor Express corriendo en puerto ${port}`);
});
