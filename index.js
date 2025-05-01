require('dotenv').config();
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const axios = require('axios');
const qrcode = require('qrcode-terminal');

// Supabase config
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Estrategia personalizada
class SupabaseLocalAuth extends LocalAuth {
  constructor(clientId, supabase) {
    super({ clientId: clientId || 'default-client', dataPath: '/tmp/.wwebjs_auth' });
    this.supabase = supabase;
    this.clientId = clientId;
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
    } catch (e) {
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

const client = new Client({
  puppeteer: {
    args: ['--no-sandbox'],
    headless: 'new'
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

function normalizeNumber(number) {
  return number ? number.replace('@c.us', '').trim() : null;
}

async function sendToN8n(message, clientNumber) {
  try {
    const res = await axios.post(process.env.N8N_WEBHOOK_URL, {
      message,
      clientNumber: normalizeNumber(clientNumber)
    });
    return res.data;
  } catch (e) {
    console.error('Error al enviar a n8n:', e.message);
    return { reply: 'Hubo un error, te contacto un agente pronto.' };
  }
}

// Eventos de WhatsApp
client.on('qr', (qr) => {
  console.log('\n🔷 Escaneá este código QR:\n');
  qr.match(/.{1,50}/g).forEach(line => console.log(line));
});

client.on('authenticated', async (session) => {
  const sessionData = JSON.stringify(session);
  await supabase
    .from('whatsapp_sessions')
    .upsert([{
      client_id: 'my-client',
      session_data: sessionData,
      updated_at: new Date().toISOString()
    }], { onConflict: ['client_id'] });
  console.log('✅ Sesión guardada en Supabase.');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Fallo de autenticación:', msg);
});

client.on('ready', () => {
  console.log('🤖 WhatsApp conectado y listo.');
});

client.on('disconnected', (reason) => {
  console.log('📴 Cliente desconectado:', reason);
  client.initialize();
});

client.on('message_create', async (msg) => {
  if (msg.fromMe) return;
  const from = normalizeNumber(msg.from);
  console.log(`📩 Mensaje recibido de ${from}:`, msg.body);

  // Guardar en Supabase
  await supabase.from('messages').insert([{
    body: msg.body,
    from: msg.from,
    tenant_id: 1,
    is_outgoing: false,
    created_at: new Date().toISOString()
  }]);

  const res = await sendToN8n(msg.body, msg.from);
  if (res?.reply) {
    await client.sendMessage(msg.from, res.reply);
    await supabase.from('messages').insert([{
      body: res.reply,
      from: msg.from,
      tenant_id: 1,
      is_outgoing: true,
      created_at: new Date().toISOString(),
      response_source: 'n8n',
      response_status: 'sent'
    }]);
  }
});

// Start
client.initialize();
app.listen(port, () => {
  console.log(`🚀 Servidor Express corriendo en puerto ${port}`);
});
