// src/index.js

require('dotenv').config();
const express = require('express');
const fetch = global.fetch || require('node-fetch');
const { default: makeWASocket, useMultiFileAuthState } = require('@adiwajshing/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  N8N_WEBHOOK_URL,
  BASE_URL,
  PORT,
  SESSION_BUCKET,
  SESSION_FILE
} = process.env;

// Inicializa cliente Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.use(express.json());

let whatsappClient, latestQr = null;
let globalCatalog = null;
let numeroComercio = null; // <--- ACA

async function loadSession() {
  console.log('📂 Intentando cargar sesión desde Supabase Storage...');
  try {
    const { data, error } = await supabase.storage
      .from(SESSION_BUCKET)
      .download(SESSION_FILE);
    if (error) throw error;
    const sessionData = await data.text();
    return JSON.parse(sessionData);
  } catch (err) {
    console.error('❌ Error descargando sesión:', err, err.message, err.details);
    return null;
  }
}

async function saveSession(session) {
  console.log('💾 Intentando guardar sesión en Supabase Storage...');
  try {
    const { error } = await supabase.storage
      .from(SESSION_BUCKET)
      .upload(SESSION_FILE, JSON.stringify(session), {
        upsert: true,
      });
    if (error) throw error;
    console.log('✅ Sesión guardada correctamente en Supabase Storage');
  } catch (err) {
    console.error('❌ Error guardando sesión:', err);
  }
}

async function loadGlobalCatalog() {
  console.log('📋 Intentando cargar catálogo global...');
  try {
    const { data, error } = await supabase
      .from('productos')
      .select('id, nombre, descripcion, precio, tamano, foto_url, categoria');
    if (error) throw error;
    globalCatalog = data;
    console.log('✅ Catálogo global cargado correctamente:', data.length, 'productos');
    return data;
  } catch (err) {
    console.error('❌ Error al cargar el catálogo global:', err.message, err.details);
    console.error('❌ Excepción al cargar el catálogo global:', err);
    return null;
  }
}

async function initWhatsApp() {
  console.log('📡 Iniciando cliente WhatsApp...');
  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth');

  const client = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  client.ev.on('creds.update', saveCreds);

  client.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;
    if (qr) {
      latestQr = qr;
      console.log('--- QR RECEIVED ---');
      console.log(`🖼️  Escanea en tu navegador: ${BASE_URL}/qr`);
    }
    if (connection === 'open') {
      numeroComercio = client.user.id; // <--- GUARDA ACA EL NRO DEL COMERCIO
      console.log('✅ WhatsApp listo', numeroComercio);
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
      if (shouldReconnect) initWhatsApp();
      console.log('❌ WhatsApp desconectado:', lastDisconnect?.error);
    }
  });

  client.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (msg.message) {
      const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      if (!numeroComercio) {
        console.error('❌ numeroComercio no inicializado aún.');
        return;
      }
      // Logica: de cliente al comercio, de comercio al cliente
      const from = msg.key.fromMe ? numeroComercio : msg.key.remoteJid;
      const to   = msg.key.fromMe ? msg.key.remoteJid : numeroComercio;

      try {
        const { error } = await supabase
          .from('mensajes')
          .insert({
            whatsapp_from: from,
            whatsapp_to: to,
            texto: texto,
            enviado_por_bot: msg.key.fromMe
          });
        if (error) console.error('❌ Error guardando en DB:', error.message);
        else console.log(`🗄️ Guardado: de ${from} a ${to}`);
      } catch (err) {
        console.error('❌ Excepción al guardar en DB:', err);
      }

      // Solo reenviá a n8n si es cliente → comercio
      if (!msg.key.fromMe && texto) {
        try {
          await fetch(N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: from, body: texto })
          });
          console.log('➡️ Mensaje enviado a n8n');
        } catch (err) {
          console.error('❌ Error forward a n8n:', err.message);
        }
      }
    }
  });

  await loadGlobalCatalog();
  whatsappClient = client;
}

app.get('/qr', async (req, res) => {
  if (!latestQr) return res.status(404).send('QR no disponible');
  try {
    const img = await QRCode.toBuffer(latestQr);
    res.set('Content-Type', 'image/png');
    res.send(img);
  } catch (err) {
    console.error('Error generando QR PNG:', err);
    res.status(500).send('Error generando imagen QR');
  }
});

app.post('/send-message', async (req, res) => {
  const { to, body } = req.body;
  if (!whatsappClient) return res.status(503).send('WhatsApp no inicializado');
  try {
    await whatsappClient.sendMessage(to, { text: body });
    console.log(`✔️ Mensaje enviado a ${to}`);
    res.json({ status: 'enviado' });
  } catch (err) {
    console.error('Error enviando mensaje:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/webhook/new-message', (req, res) => {
  console.log('🔔 Webhook recibido:', req.body);
  res.sendStatus(200);
});

initWhatsApp().catch(err => console.error('❌ initWhatsApp error:', err));

const port = PORT || 3000;
app.listen(port, () => console.log(`🚀 Server escuchando en puerto ${port}`));
