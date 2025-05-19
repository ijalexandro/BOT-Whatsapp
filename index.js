require('dotenv').config();

const express = require('express');
const { Client } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const axios = require('axios');
const qrcode = require('qrcode-terminal');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

let globalCatalog = null;

console.log('Iniciando el bot...');
console.log('Versión de Node.js:', process.version);
console.log('Uso de memoria inicial:', process.memoryUsage());

async function loadGlobalCatalog() {
  try {
    const { data, error } = await supabase
      .from('productos')
      .select('nombre, precio, descripcion, tamano, foto_url, categoria')
      .eq('tenant_id', '1');
    if (error) {
      console.error('Error al cargar el catálogo global:', error.message);
      throw new Error('No se pudo cargar el catálogo global.');
    }
    globalCatalog = data;
    console.log('Catálogo global cargado con éxito.');
  } catch (err) {
    console.error('Excepción al cargar el catálogo global:', err.message);
    globalCatalog = [];
  }
}

// ————— Persistencia de sesión WhatsApp —————
async function getSession() {
  const { data, error } = await supabase
    .storage
    .from(process.env.SESSION_BUCKET)
    .download(process.env.SESSION_FILE);
  if (error || !data) return null;
  return JSON.parse(await data.text());
}

async function saveSession(sess) {
  await supabase
    .storage
    .from(process.env.SESSION_BUCKET)
    .upload(
      process.env.SESSION_FILE,
      Buffer.from(JSON.stringify(sess)),
      { upsert: true }
    );
}

const app = express();
const port = process.env.PORT || 3000;
app.use(bodyParser.json());

const processedMessages = new Set();
const botResponses = new Set();

const serverStartTime = new Date();
console.log('Servidor iniciado en:', serverStartTime);

function normalizeWhatsappNumber(number) {
  return number ? number.replace('@c.us', '').trim() : null;
}

async function getCatalogData(tenantId) {
  return globalCatalog;
}

async function validateAndCorrectResponse(response, tenantId) {
  let parsedResponse;
  let textAfterJson = '';
  const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/);
  if (jsonMatch) {
    try {
      parsedResponse = JSON.parse(jsonMatch[1]);
      textAfterJson = response.slice(jsonMatch[0].length).trim();
    } catch (error) {
      console.error('Error al parsear JSON en bloque:', error.message);
      return { response: { mensaje: response }, textAfterJson: '', corrected: false };
    }
  } else {
    try {
      parsedResponse = JSON.parse(response);
    } catch (error) {
      console.error('Error al parsear JSON:', error.message);
      return { response: { mensaje: response }, textAfterJson: '', corrected: false };
    }
  }
  if (parsedResponse.respuesta) {
    return { response: { mensaje: parsedResponse.respuesta }, textAfterJson, corrected: false };
  }
  if (parsedResponse.error) {
    return { response: parsedResponse, textAfterJson: '', corrected: false };
  }
  const catalog = await getCatalogData(tenantId);
  if (Array.isArray(parsedResponse)) {
    const correctedResponse = [];
    let hasCorrections = false;
    for (const product of parsedResponse) {
      const catalogProduct = catalog.find(
        p => p.nombre === product.nombre && p.tamano === product.tamano
      );
      if (!catalogProduct) {
        return { error: `El producto ${product.nombre} no existe en el catálogo.`, textAfterJson: '', corrected: false };
      }
      const cp = { ...product };
      let productCorrected = false;
      if (product.precio !== catalogProduct.precio) {
        cp.precio = catalogProduct.precio;
        productCorrected = true;
      }
      if (product.ingredientes !== catalogProduct.descripcion) {
        cp.ingredientes = catalogProduct.descripcion;
        productCorrected = true;
      }
      if (product.foto_url !== catalogProduct.foto_url) {
        cp.foto_url = catalogProduct.foto_url;
        productCorrected = true;
      }
      correctedResponse.push(cp);
      if (productCorrected) hasCorrections = true;
    }
    return { response: correctedResponse, textAfterJson, corrected: hasCorrections };
  } else {
    const catalogProduct = catalog.find(
      p => p.nombre === parsedResponse.nombre && p.tamano === parsedResponse.tamano
    );
    if (!catalogProduct) {
      return { error: `El producto ${parsedResponse.nombre} no existe en el catálogo.`, textAfterJson: '', corrected: false };
    }
    const cp = { ...parsedResponse };
    let hasCorrections = false;
    if (parsedResponse.precio !== catalogProduct.precio) {
      cp.precio = catalogProduct.precio;
      hasCorrections = true;
    }
    if (parsedResponse.ingredientes !== catalogProduct.descripcion) {
      cp.ingredientes = catalogProduct.descripcion;
      hasCorrections = true;
    }
    if (parsedResponse.foto_url !== catalogProduct.foto_url) {
      cp.foto_url = catalogProduct.foto_url;
      hasCorrections = true;
    }
    return { response: cp, textAfterJson, corrected: hasCorrections };
  }
}

async function registerOrder({ clientNumber, tenantId, productName, price, size, clientName, address, paymentMethod }) {
  let normalizedPrice = typeof price === 'string'
    ? parseFloat(price.replace(/[^0-9.]/g, ''))
    : parseFloat(price);
  if (isNaN(normalizedPrice)) {
    console.error('Precio no válido:', price);
    return { success: false, error: 'Precio no válido.' };
  }
  const { data, error } = await supabase
    .from('pedidos')
    .insert([{
      client_number: clientNumber,
      tenant_id: tenantId,
      product_name: productName,
      price: normalizedPrice,
      size,
      client_name: clientName,
      address,
      payment_method: paymentMethod,
      status: 'pendiente',
      created_at: new Date().toISOString()
    }])
    .select();
  if (error) {
    console.error('Error al registrar pedido:', error.message);
    return { success: false, error: error.message };
  }
  console.log('Pedido registrado:', data);
  return { success: true, data };
}

async function sendMessageToN8n(message, clientNumber, tenantId) {
  try {
    const { data: msgs, error: msgsErr } = await supabase
      .from('messages')
      .select('body, is_outgoing')
      .eq('from', clientNumber)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(2);
    if (msgsErr) {
      console.error('Error historial:', msgsErr.message);
      return { error: true, message: 'Error historia.' };
    }
    const history = msgs.reverse().map(m =>
      `${m.is_outgoing ? 'Asistente' : 'Cliente'}: ${m.body}`
    ).join('\n');
    console.log('Enviando a n8n:', { message, clientNumber: normalizeWhatsappNumber(clientNumber), history });
    const r = await axios.post(
      process.env.N8N_WEBHOOK_URL,
      { message, clientNumber: normalizeWhatsappNumber(clientNumber), conversationHistory: history || 'No hay historial.' }
    );
    console.log('Recibido de n8n:', r.data);
    return r.data;
  } catch (err) {
    console.error('Error enviando a n8n:', err.message);
    return { error: true, message: 'Error al procesar.' };
  }
}

;(async () => {
  // Cargo sesión
  const legacySession = await getSession();

  const client = new Client({
    session: legacySession || undefined,
    puppeteer: {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-zygote',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-breakpad',
        '--disable-extensions',
        '--disable-hang-monitor',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--disable-translate',
        '--metrics-recording-only',
        '--no-first-run',
        '--safebrowsing-disable-auto-update',
        '--disable-features=TranslateUI',
        '--enable-features=NetworkService',
        '--ignore-certificate-errors',
        '--disable-software-rasterizer',
        '--disable-accelerated-2d-canvas',
        '--disable-audio-output',
        '--single-process',
        '--disable-notifications'
      ],
      headless: 'new',
      ignoreHTTPSErrors: true,
      dumpio: true,
      timeout: 60000
    }
  });

client.on('authenticated', async (session) => {
  try {
    console.log('✅ Auth OK, guardando sesión en Supabase Storage...');
    await saveSession(session);
    console.log('✅ Sesión guardada correctamente en Supabase Storage');
    // Prueba si se puede leer la sesión que recién guardaste
    const testSession = await getSession();
    if (testSession) {
      console.log('🔍 Sesión leída luego de guardar:', JSON.stringify(testSession));
    } else {
      console.log('❌ No se pudo leer la sesión guardada desde Storage');
    }
  } catch (e) {
    console.error('❌ Error guardando sesión:', e.message);
  }
});


  client.on('auth_failure', msg => console.error('❌ Auth falló:', msg));
  client.on('ready', () => console.log('🤖 Bot listo y conectado'));
  client.on('disconnected', () => {
    console.log('🔌 Desconectado, reinicio…');
    client.initialize();
  });
  client.on('error', e => console.error('Error cliente WhatsApp:', e.message));

  // Manejador de mensajes entrantes
  client.on('message_create', async msg => {
    console.log('Evento message_create:', msg.body);
    const messageId = msg.id._serialized;
    if (processedMessages.has(messageId)) return;
    processedMessages.add(messageId);
    setTimeout(() => processedMessages.delete(messageId), 5 * 60 * 1000);

    let tenantId = 1;
    const from = normalizeWhatsappNumber(msg.from);
    const to   = normalizeWhatsappNumber(msg.to);
    if (from === '5491135907587' || to === '5491135907587') {
      const field = from === '5491135907587' ? 'whatsapp_number' : 'whatsapp_number';
      const val = normalizeWhatsappNumber(from === '5491135907587' ? msg.from : msg.to);
      const { data: t } = await supabase
        .from('tenants')
        .select('id')
        .eq(field, val)
        .single();
      tenantId = t?.id || 1;
    }

    if (msg.fromMe || from === '5491135907587') {
      if (botResponses.has(messageId)) return;
      const manual = await supabase
        .from('messages')
        .insert([{
          body: msg.body,
          from: msg.to,
          recipient: msg.to,
          tenant_id: tenantId,
          is_outgoing: true,
          response_source: 'manual',
          response_status: 'sent',
          created_at: new Date().toISOString()
        }]);
      console.log('Mensaje manual guardado:', manual.data);
      return;
    }

    // guardo entrante
  const { error: errorEntrada } = await supabase
  .from('messages')
  .insert([{
    body: msg.body,
    from: msg.from,
    tenant_id: tenantId,
    is_outgoing: false,
    created_at: new Date().toISOString()
  }]);
if (errorEntrada) {
  console.error('❌ Error guardando mensaje entrante:', errorEntrada.message);
} else {
  console.log('✅ Mensaje entrante guardado en DB');
}

    
    const resp = await sendMessageToN8n(msg.body, msg.from, tenantId);
    if (resp && resp.reply) {
      let final = resp.reply;
      let jsonResp = null;
      if (resp.reply.includes('```json')) {
        const vr = await validateAndCorrectResponse(resp.reply, tenantId);
        if (vr.response?.error) {
          final = 'Lo siento, no encontré ese producto. ¿Querés probar otra?';
        } else if (vr.response?.mensaje) {
          final = vr.response.mensaje;
          if (vr.textAfterJson) final += `\n\n${vr.textAfterJson}`;
        } else {
          const cr = vr.response;
          if (Array.isArray(cr)) {
            final = cr.map(p => `Recomiendo: ${p.nombre} (${p.tamano}) – $${p.precio}`).join('\n');
          } else {
            final = `Recomiendo: ${cr.nombre} – $${cr.precio}`;
          }
          if (vr.textAfterJson) final += `\n\n${vr.textAfterJson}`;
          jsonResp = cr;
        }
      }

      const sent = await client.sendMessage(msg.from, final);
      botResponses.add(sent.id._serialized);
const { error: errorSalida } = await supabase
  .from('messages')
  .insert([{
    body: final,
    from: msg.from,
    recipient: msg.from,
    tenant_id: tenantId,
    is_outgoing: true,
    response_source: 'n8n',
    response_status: 'sent',
    created_at: new Date().toISOString()
  }]);

if (errorSalida) {
  console.error('❌ Error guardando mensaje de salida:', errorSalida.message);
} else {
  console.log('✅ Mensaje de respuesta guardado en DB');
}


      // si confirma, registro pedido
      if (jsonResp && /si|sí|confirmo/i.test(msg.body)) {
        const pr = Array.isArray(jsonResp) ? jsonResp[0] : jsonResp;
        await registerOrder({
          clientNumber: normalizeWhatsappNumber(msg.from),
          tenantId,
          productName: pr.nombre,
          price: pr.precio,
          size: pr.tamano,
          clientName: 'Cliente',
          address: 'Dirección',
          paymentMethod: 'Pendiente'
        });
      }
    } else {
      const errMsg = 'Hubo un error procesando tu mensaje.';
      await client.sendMessage(msg.from, errMsg);
    }
  });

  loadGlobalCatalog();

  // Ruta para enviar desde n8n
  app.post('/send-message', async (req, res) => {
    const { to, body } = req.body;
    try {
      const sent = await client.sendMessage(to, body);
      await supabase
        .from('messages')
        .insert([{
          body,
          from: to,
          recipient: to,
          tenant_id: 1,
          is_outgoing: true,
          response_source: 'n8n',
          response_status: 'sent',
          created_at: new Date().toISOString()
        }]);
      return res.json({ status: 'enviado' });
    } catch (error) {
      console.error('Error en /send-message:', error.message);
      return res.status(500).json({ status: 'error', message: error.message });
    }
  });

  await client.initialize();
  app.listen(port, () => console.log(`🚀 Express en puerto ${port}`));
})();
