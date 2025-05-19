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

console.log('📟 Iniciando el bot...');
console.log('ℹ️ Versión de Node.js:', process.version);
console.log('ℹ️ Uso de memoria inicial:', process.memoryUsage());

async function loadGlobalCatalog() {
  try {
    const { data, error } = await supabase
      .from('productos')
      .select('nombre, precio, descripcion, tamano, foto_url, categoria')
      .eq('tenant_id', '1');
    if (error) {
      console.error('❌ Error al cargar el catálogo global:', error.message, error.details);
      throw new Error('No se pudo cargar el catálogo global.');
    }
    globalCatalog = data;
    console.log('✅ Catálogo global cargado con éxito:', data.length, 'productos');
  } catch (err) {
    console.error('❌ Excepción al cargar el catálogo global:', err.message);
    globalCatalog = [];
  }
}

// ————— Persistencia de sesión WhatsApp —————
async function getSession() {
  try {
    console.log('📂 Intentando cargar sesión desde Supabase Storage...');
    const { data, error } = await supabase
      .storage
      .from(process.env.SESSION_BUCKET)
      .download(process.env.SESSION_FILE);
    if (error) {
      console.error('❌ Error descargando sesión:', error.message, error.code);
      return null;
    }
    const sessionData = JSON.parse(await data.text());
    console.log('✅ Sesión cargada correctamente:', JSON.stringify(sessionData).slice(0, 100) + '...');
    return sessionData;
  } catch (err) {
    console.error('❌ Excepción en getSession:', err.message);
    return null;
  }
}

async function saveSession(session) {
  try {
    console.log('💾 Intentando guardar sesión en Supabase Storage...');
    const sessionData = JSON.stringify(session);
    const { error } = await supabase
      .storage
      .from(process.env.SESSION_BUCKET)
      .upload(process.env.SESSION_FILE, Buffer.from(sessionData), {
        upsert: true,
        contentType: 'application/json',
      });
    if (error) {
      console.error('❌ Error guardando sesión:', error.message, error.code, error.details);
      throw error;
    }
    console.log('✅ Sesión guardada correctamente en Supabase Storage');
    // Verificar que se guardó correctamente
    const { data: testData, error: testError } = await supabase
      .storage
      .from(process.env.SESSION_BUCKET)
      .download(process.env.SESSION_FILE);
    if (testError) {
      console.error('❌ No se pudo verificar la sesión guardada:', testError.message);
    } else {
      console.log('✅ Sesión verificada en Storage:', (await testData.text()).slice(0, 100) + '...');
    }
  } catch (err) {
    console.error('❌ Excepción en saveSession:', err.message);
  }
}

const app = express();
const port = process.env.PORT || 3000;
app.use(bodyParser.json());

const processedMessages = new Set();
const botResponses = new Set();

const serverStartTime = new Date();
console.log('🚀 Servidor iniciado en:', serverStartTime.toISOString());

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
      console.error('❌ Error al parsear JSON en bloque:', error.message);
      return { response: { mensaje: response }, textAfterJson: '', corrected: false };
    }
  } else {
    try {
      parsedResponse = JSON.parse(response);
    } catch (error) {
      console.error('❌ Error al parsear JSON:', error.message);
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
    console.error('❌ Precio no válido:', price);
    return { success: false, error: 'Precio no válido.' };
  }
  try {
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
      console.error('❌ Error al registrar pedido:', error.message, error.details);
      return { success: false, error: error.message };
    }
    console.log('✅ Pedido registrado:', data);
    return { success: true, data };
  } catch (err) {
    console.error('❌ Excepción en registerOrder:', err.message);
    return { success: false, error: err.message };
  }
}

async function sendMessageToN8n(message, clientNumber, tenantId) {
  try {
    const { data: msgs, error: msgsErr } = await supabase
      .from('messages')
      .select('texto, enviado_por_bot')
      .eq('whatsapp_from', clientNumber)
      .order('created_at', { ascending: false })
      .limit(2);
    if (msgsErr) {
      console.error('❌ Error obteniendo historial:', msgsErr.message, msgsErr.details);
      return { error: true, message: 'Error al obtener historial.' };
    }
    const history = msgs.reverse().map(m =>
      `${m.enviado_por_bot ? 'Asistente' : 'Cliente'}: ${m.texto}`
    ).join('\n');
    console.log('➡️ Enviando a n8n:', {
      message,
      clientNumber: normalizeWhatsappNumber(clientNumber),
      history: history || 'No hay historial.'
    });
    const response = await axios.post(
      process.env.N8N_WEBHOOK_URL,
      {
        message,
        clientNumber: normalizeWhatsappNumber(clientNumber),
        conversationHistory: history || 'No hay historial.'
      }
    );
    console.log('✔️ Recibido de n8n:', response.data);
    return response.data;
  } catch (err) {
    console.error('❌ Error enviando a n8n:', err.message);
    return { error: true, message: 'Error al procesar en n8n.' };
  }
}

(async () => {
  // Cargar sesión
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

  client.on('qr', qr => {
    console.log('⚠️ Nuevo QR generado. Esto no debería pasar si la sesión persiste.');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', async (session) => {
    try {
      console.log('✅ Autenticado correctamente, guardando sesión...');
      await saveSession(session);
      console.log('✅ Sesión guardada en Supabase Storage');
    } catch (err) {
      console.error('❌ Error guardando sesión:', err.message);
    }
  });

  client.on('auth_failure', msg => {
    console.error('❌ Autenticación falló:', msg);
  });

  client.on('ready', () => {
    console.log('✅ WhatsApp listo.');
  });

  client.on('disconnected', () => {
    console.log('🔌 Desconectado, reiniciando...');
    client.initialize();
  });

  client.on('error', err => {
    console.error('❌ Error en cliente WhatsApp:', err.message);
  });

  // Manejador de mensajes entrantes
  client.on('message_create', async msg => {
    try {
      console.log('📩 Mensaje entrante:', {
        messageId: msg.id._serialized,
        from: msg.from,
        to: msg.to,
        body: msg.body,
        timestamp: new Date().toISOString()
      });

      const messageId = msg.id._serialized;
      if (processedMessages.has(messageId)) {
        console.log('🔄 Mensaje ya procesado, ignorando:', messageId);
        return;
      }
      processedMessages.add(messageId);
      setTimeout(() => processedMessages.delete(messageId), 5 * 60 * 1000);

      const from = normalizeWhatsappNumber(msg.from);
      const to = normalizeWhatsappNumber(msg.to);
      const tenantId = 1; // Fijo, ya que no usamos tenant_id en messages

      if (msg.fromMe || from === '5491135907587') {
        if (botResponses.has(messageId)) {
          console.log('🤖 Mensaje de bot ya registrado, ignorando:', messageId);
          return;
        }
        console.log('📤 Guardando mensaje saliente manual...');
        const { data, error } = await supabase
          .from('messages')
          .insert([{
            whatsapp_from: msg.to,
            whatsapp_to: msg.from,
            texto: msg.body,
            enviado_por_bot: true,
            created_at: new Date().toISOString()
          }])
          .select();
        if (error) {
          console.error('❌ Error guardando mensaje saliente manual:', error.message, error.details);
        } else {
          console.log('✅ Mensaje saliente manual guardado:', data);
        }
        return;
      }

      // Guardar mensaje entrante
      console.log('📥 Guardando mensaje entrante...');
      const { data: entradaData, error: entradaError } = await supabase
        .from('messages')
        .insert([{
          whatsapp_from: msg.from,
          whatsapp_to: msg.to,
          texto: msg.body,
          enviado_por_bot: false,
          created_at: new Date().toISOString()
        }])
        .select();
      if (entradaError) {
        console.error('❌ Error guardando mensaje entrante:', entradaError.message, entradaError.details);
      } else {
        console.log('🗄️ Mensaje entrante guardado en DB:', entradaData);
      }

      // Enviar a n8n y procesar respuesta
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

        // Enviar respuesta al cliente
        const sent = await client.sendMessage(msg.from, final);
        botResponses.add(sent.id._serialized);
        console.log('✔️ Mensaje enviado a', msg.from, ':', final);

        // Guardar respuesta del bot
        console.log('📤 Guardando respuesta del bot...');
        const { data: salidaData, error: salidaError } = await supabase
          .from('messages')
          .insert([{
            whatsapp_from: msg.to,
            whatsapp_to: msg.from,
            texto: final,
            enviado_por_bot: true,
            created_at: new Date().toISOString()
          }])
          .select();
        if (salidaError) {
          console.error('❌ Error guardando respuesta del bot:', salidaError.message, salidaError.details);
          console.error('Datos enviados:', {
            whatsapp_from: msg.to,
            whatsapp_to: msg.from,
            texto: final,
            enviado_por_bot: true
          });
        } else {
          console.log('✅ Respuesta del bot guardada en DB:', salidaData);
        }

        // Registrar pedido si confirma
        if (jsonResp && /si|sí|confirmo/i.test(msg.body)) {
          const pr = Array.isArray(jsonResp) ? jsonResp[0] : jsonResp;
          const orderResult = await registerOrder({
            clientNumber: normalizeWhatsappNumber(msg.from),
            tenantId,
            productName: pr.nombre,
            price: pr.precio,
            size: pr.tamano,
            clientName: 'Cliente',
            address: 'Dirección',
            paymentMethod: 'Pendiente'
          });
          console.log('📦 Resultado de registro de pedido:', orderResult);
        }
      } else {
        const errMsg = 'Hubo un error procesando tu mensaje.';
        await client.sendMessage(msg.from, errMsg);
        console.log('⚠️ Enviado mensaje de error al cliente:', errMsg);
      }
    } catch (err) {
      console.error('❌ Error en message_create:', err.message);
    }
  });

  // Ruta para enviar desde n8n
  app.post('/send-message', async (req, res) => {
    const { to, body } = req.body;
    try {
      console.log('📤 Recibida solicitud de n8n para enviar mensaje:', { to, body });
      const sent = await client.sendMessage(to, body);
      const { data, error } = await supabase
        .from('messages')
        .insert([{
          whatsapp_from: to,
          whatsapp_to: to,
          texto: body,
          enviado_por_bot: true,
          created_at: new Date().toISOString()
        }])
        .select();
      if (error) {
        console.error('❌ Error guardando mensaje de n8n:', error.message, error.details);
      } else {
        console.log('✅ Mensaje de n8n guardado:', data);
      }
      return res.json({ status: 'enviado' });
    } catch (error) {
      console.error('❌ Error en /send-message:', error.message);
      return res.status(500).json({ status: 'error', message: error.message });
    }
  });

  await loadGlobalCatalog();
  await client.initialize();
  app.listen(port, () => console.log(`🚀 Express escuchando en puerto ${port}`));
})();
