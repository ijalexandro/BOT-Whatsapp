require('dotenv').config();

const express = require('express');
const { Client } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const axios = require('axios');
const qrcode = require('qrcode-terminal');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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

const client = new Client({
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
      '--disable-client-side-phishing-detection',
      '--disable-default-apps',
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
      '--single-process', // Reduce uso de memoria
      '--disable-notifications' // Deshabilita notificaciones
    ],
    headless: 'new',
    ignoreHTTPSErrors: true,
    dumpio: true,
    timeout: 60000 // Aumenta a 60 segundos
  }
});

const app = express();
const port = process.env.PORT || 3000;
app.use(bodyParser.json());

const processedMessages = new Set();
const botResponses = new Set();

const serverStartTime = new Date();
console.log('Servidor iniciado en:', serverStartTime);

const humanRequestKeywords = [
  'hablar con una persona',
  'necesito ayuda humana',
  'quiero hablar con alguien',
  'hablar con el encargado',
  'ayuda de una persona',
  'hablar con un humano'
];

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
      console.error('Error al parsear el JSON dentro del bloque Markdown:', error.message);
      return { response: { mensaje: response }, textAfterJson: '', corrected: false };
    }
  } else {
    try {
      parsedResponse = JSON.parse(response);
    } catch (error) {
      console.error('Error al parsear la respuesta como JSON:', error.message);
      return { response: { mensaje: response }, textAfterJson: '', corrected: false };
    }
  }
  if (parsedResponse.respuesta) return { response: { mensaje: parsedResponse.respuesta }, textAfterJson: textAfterJson || '', corrected: false };
  if (parsedResponse.error) return { response: parsedResponse, textAfterJson: '', corrected: false };
  const catalog = await getCatalogData(tenantId);
  if (Array.isArray(parsedResponse)) {
    const correctedResponse = [];
    let hasCorrections = false;
    for (const product of parsedResponse) {
      const catalogProduct = catalog.find(p => p.nombre === product.nombre && p.tamano === product.tamano);
      if (!catalogProduct) return { error: `El producto ${product.nombre} no existe en el catálogo.`, textAfterJson: '', corrected: false };
      const correctedProduct = { ...product };
      let productCorrected = false;
      if (product.precio !== catalogProduct.precio) { correctedProduct.precio = catalogProduct.precio; productCorrected = true; }
      if (product.ingredientes !== catalogProduct.descripcion) { correctedProduct.ingredientes = catalogProduct.descripcion; productCorrected = true; }
      if (product.foto_url !== catalogProduct.foto_url) { correctedProduct.foto_url = catalogProduct.foto_url; productCorrected = true; }
      correctedResponse.push(correctedProduct);
      if (productCorrected) hasCorrections = true;
    }
    return { response: correctedResponse, textAfterJson, corrected: hasCorrections };
  } else {
    const catalogProduct = catalog.find(p => p.nombre === parsedResponse.nombre && p.tamano === parsedResponse.tamano);
    if (!catalogProduct) return { error: `El producto ${parsedResponse.nombre} no existe en el catálogo.`, textAfterJson: '', corrected: false };
    const correctedResponse = { ...parsedResponse };
    let hasCorrections = false;
    if (parsedResponse.precio !== catalogProduct.precio) { correctedResponse.precio = catalogProduct.precio; hasCorrections = true; }
    if (parsedResponse.ingredientes !== catalogProduct.descripcion) { correctedResponse.ingredientes = catalogProduct.descripcion; hasCorrections = true; }
    if (parsedResponse.foto_url !== catalogProduct.foto_url) { correctedResponse.foto_url = catalogProduct.foto_url; hasCorrections = true; }
    return { response: correctedResponse, textAfterJson, corrected: hasCorrections };
  }
}

async function registerOrder({ clientNumber, tenantId, productName, price, size, clientName, address, paymentMethod }) {
  let normalizedPrice = typeof price === 'string' ? parseFloat(price.replace(/[^0-9.]/g, '')) : parseFloat(price);
  if (isNaN(normalizedPrice)) {
    console.error('Error: El precio no es un número válido:', price);
    return { success: false, error: 'El precio no es válido.' };
  }
  const { data, error } = await supabase
    .from('pedidos')
    .insert([{ client_number: clientNumber, tenant_id: tenantId, product_name: productName, price: normalizedPrice, size, client_name: clientName, address, payment_method: paymentMethod, status: 'pendiente', created_at: new Date().toISOString() }])
    .select();
  if (error) {
    console.error('Error al registrar el pedido:', error.message);
    return { success: false, error: error.message };
  }
  console.log('Pedido registrado:', data);
  return { success: true, data };
}

async function sendMessageToN8n(message, clientNumber, tenantId) {
  try {
    const { data: messages, error: messagesError } = await supabase
      .from('messages')
      .select('body, is_outgoing')
      .eq('from', clientNumber)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(2);
    if (messagesError) {
      console.error('Error al obtener historial de conversación:', messagesError.message);
      return { error: true, message: 'Error al procesar el mensaje.' };
    }
    const conversationHistory = messages
      .reverse()
      .map(msg => `${msg.is_outgoing ? 'Asistente' : 'Cliente'}: ${msg.body}`)
      .join('\n');
    console.log('Enviando solicitud a n8n:', { message, clientNumber: normalizeWhatsappNumber(clientNumber), conversationHistory: conversationHistory || 'No hay historial previo.' });
    const response = await axios.post(process.env.N8N_WEBHOOK_URL, { message, clientNumber: normalizeWhatsappNumber(clientNumber), conversationHistory: conversationHistory || 'No hay historial previo.' });
    console.log('Respuesta recibida de n8n:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error enviando a n8n:', error.message);
    return { error: true, message: 'Error al procesar el mensaje.' };
  }
}

async function notifyAdmin(tenantId, clientNumber, message) {
  console.log('notifyAdmin - Intentando notificar:', tenantId, clientNumber);
  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('whatsapp_number')
    .eq('id', tenantId)
    .single();
  if (tenantError || !tenant) {
    console.error('Error obteniendo tenant:', tenantError?.message || 'No encontrado');
    return;
  }
  const adminNumber = tenant.whatsapp_number;
  if (!adminNumber) {
    console.error('No hay número de WhatsApp para el tenant');
    return;
  }
  try {
    const normalizedAdminNumber = normalizeWhatsappNumber(adminNumber);
    const normalizedClientNumber = normalizeWhatsappNumber(clientNumber) || 'Desconocido';
    const notifMessage = `Alerta: Cliente ${normalizedClientNumber} necesita ayuda: ${message}`;
    const { data: existing, error: notifError } = await supabase
      .from('notificaciones')
      .select('id')
      .eq('client_number', normalizedClientNumber)
      .eq('tenant_id', tenantId)
      .eq('message', notifMessage)
      .gte('created_at', new Date(Date.now() - 20 * 60 * 1000).toISOString())
      .limit(1);
    if (notifError) {
      console.error('Error verificando notificaciones:', notifError.message);
      return;
    }
    if (!existing || existing.length === 0) {
      const sentMessage = await client.sendMessage(`${normalizedAdminNumber}@c.us`, notifMessage);
      botResponses.add(sentMessage.id._serialized);
      await supabase.from('notificaciones').insert([{ client_number: normalizedClientNumber, tenant_id: tenantId, message: notifMessage }]);
      console.log('Notificación enviada');
    } else {
      console.log('Notificación ya enviada recientemente');
    }
  } catch (error) {
    console.error('Error notificando:', error.message);
  }
}

async function handleManualResponse(clientNumber, tenantId) {
  const normalizedClientNumber = normalizeWhatsappNumber(clientNumber) || 'Desconocido';
  const { error } = await supabase
    .from('respuestas_manuales')
    .upsert([{ client_number: normalizedClientNumber, tenant_id: tenantId, manual_response: true, last_response_at: new Date(), deepseek_invocation_count: 0 }], { onConflict: ['client_number', 'tenant_id'] });
  if (error) console.error('Error registrando respuesta manual:', error.message);
  else console.log('Intervención manual registrada para:', normalizedClientNumber);
}

async function checkClientTimeout(clientNumber, tenantId) {
  const normalizedClientNumber = normalizeWhatsappNumber(clientNumber) || 'Desconocido';
  const { data: manualResponse, error } = await supabase
    .from('respuestas_manuales')
    .select('manual_response, last_response_at')
    .eq('client_number', normalizedClientNumber)
    .eq('tenant_id', tenantId)
    .single();
  if (error && error.code !== 'PGRST116') {
    console.error('Error verificando timeout:', error.message);
    return;
  }
  if (manualResponse?.manual_response) {
    const lastResponseTime = manualResponse.last_response_at ? new Date(manualResponse.last_response_at) : null;
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    if (lastResponseTime && lastResponseTime < serverStartTime) {
      console.log(`Intervención manual antigua ignorada para ${normalizedClientNumber}:`, lastResponseTime);
      await supabase
        .from('respuestas_manuales')
        .update({ manual_response: false })
        .eq('client_number', normalizedClientNumber)
        .eq('tenant_id', tenantId);
      return;
    }
    if (lastResponseTime && lastResponseTime > oneHourAgo) return;
    await supabase
      .from('respuestas_manuales')
      .update({ manual_response: false })
      .eq('client_number', normalizedClientNumber)
      .eq('tenant_id', tenantId);
    if (lastResponseTime && lastResponseTime < tenMinutesAgo) {
      const { data: tenant } = await supabase
        .from('tenants')
        .select('whatsapp_number')
        .eq('id', tenantId)
        .single();
      if (tenant?.whatsapp_number) {
        const sentMessage = await client.sendMessage(
          `${normalizeWhatsappNumber(tenant.whatsapp_number)}@c.us`,
          `Alerta: Cliente ${normalizedClientNumber} sin respuesta en 10 minutos`
        );
        botResponses.add(sentMessage.id._serialized);
      }
    }
  }
}

client.on('qr', (qr) => {
  console.log('\n📱 Escaneá este código QR desde WhatsApp Web:');
  console.log('\n' + (qr || 'No se pudo generar el QR, intenta de nuevo.') + '\n');
  console.log('Podés copiarlo y usar un generador QR como https://www.qr-code-generator.com/');
});

client.on('authenticated', async () => {
  console.log('✅ Autenticado en WhatsApp con éxito.');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Fallo de autenticación:', msg);
});

client.on('ready', () => {
  console.log('🤖 Bot listo y conectado a WhatsApp.');
  console.log('Uso de memoria después de conectar:', process.memoryUsage());
  setInterval(async () => {
    console.log('Verificando clientes activos...');
    const { data: messages, error } = await supabase
      .from('messages')
      .select('from, tenant_id')
      .order('created_at', { ascending: false });
    if (error) {
      console.error('Error al obtener mensajes:', error.message);
      return;
    }
    if (messages) {
      const clients = [];
      const seen = new Set();
      for (const message of messages) {
        const key = `${message.from}:${message.tenant_id}`;
        if (!seen.has(key)) {
          seen.add(key);
          clients.push({ from: message.from, tenant_id: message.tenant_id });
        }
      }
      for (const client of clients) {
        await checkClientTimeout(client.from, client.tenant_id);
      }
    }
  }, 5 * 60 * 1000);
});

client.on('disconnected', (reason) => {
  console.log('🔌 Cliente desconectado:', reason);
  console.log('Intentando reiniciar en 5 segundos...');
  setTimeout(() => client.initialize(), 5000);
});

client.on('error', (error) => {
  console.error('Error en el cliente de WhatsApp:', error.message);
  if (error.message.includes('ENOENT') || error.message.includes('TimeoutError')) {
    console.log('Error detectado, reiniciando en 5 segundos...');
    setTimeout(() => client.initialize(), 5000);
  }
});

client.on('message_create', async (msg) => {
  console.log('Evento message_create disparado:', msg.body);
  console.log('Uso de memoria al recibir mensaje:', process.memoryUsage());
  const messageId = msg.id._serialized;
  if (processedMessages.has(messageId)) {
    console.log('Mensaje ya procesado:', messageId);
    return;
  }
  processedMessages.add(messageId);
  setTimeout(() => processedMessages.delete(messageId), 5 * 60 * 1000);
  let tenantId = 1;
  const normalizedFrom = normalizeWhatsappNumber(msg.from);
  const normalizedTo = normalizeWhatsappNumber(msg.to);
  if (normalizedFrom === '5491135907587') {
    const { data: tenant } = await supabase
      .from('tenants')
      .select('id')
      .eq('whatsapp_number', normalizedFrom)
      .single();
    tenantId = tenant?.id || 1;
  } else if (normalizedTo === '5491135907587') {
    const { data: tenant } = await supabase
      .from('tenants')
      .select('id')
      .eq('whatsapp_number', normalizedTo)
      .single();
    tenantId = tenant?.id || 1;
  } else {
    const { data: lastMessage } = await supabase
      .from('messages')
      .select('tenant_id')
      .eq('from', msg.from)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    tenantId = lastMessage?.tenant_id || 1;
  }
  if (msg.fromMe || normalizedFrom === '5491135907587') {
    if (botResponses.has(messageId)) {
      console.log('Ignorando mensaje enviado por el bot:', msg.body);
      return;
    }
    console.log('Registrando mensaje manual del comercio:', msg.body);
    const { data: savedManualMessage, error: saveError } = await supabase
      .from('messages')
      .insert([{ body: msg.body, from: msg.to, recipient: msg.to, tenant_id: tenantId, is_outgoing: true, response_source: 'manual', response_status: 'sent', created_at: new Date().toISOString() }])
      .select();
    if (saveError) {
      console.error('Error al guardar mensaje manual:', saveError.message);
    } else {
      console.log('Mensaje manual guardado:', savedManualMessage);
      await handleManualResponse(msg.to, tenantId);
    }
    return;
  }
  console.log('📨 Mensaje recibido:', msg.body);
  const { data: savedMessage, error: saveError } = await supabase
    .from('messages')
    .insert([{ body: msg.body, from: msg.from, tenant_id: tenantId, is_outgoing: false, created_at: new Date().toISOString() }])
    .select();
  if (saveError) {
    console.error('Error al guardar mensaje entrante:', saveError.message);
    return;
  }
  const messageLower = msg.body.toLowerCase();
  const wantsHuman = humanRequestKeywords.some(keyword => messageLower.includes(keyword));
  if (wantsHuman) {
    const notifMessage = `Cliente ${normalizedFrom} solicita hablar con una persona: "${msg.body}"`;
    await notifyAdmin(tenantId, normalizedFrom, notifMessage);
    await handleManualResponse(msg.from, tenantId);
    const sentMessage = await client.sendMessage(msg.from, 'Un agente te va a contactar en breve, ¿dale?');
    botResponses.add(sentMessage.id._serialized);
    await supabase.from('messages').insert([{ body: 'Un agente te va a contactar en breve, ¿dale?', from: msg.from, recipient: msg.from, tenant_id: tenantId, is_outgoing: true, response_source: 'system', response_status: 'sent', created_at: new Date().toISOString() }]);
    return;
  }
  const { data: manualResponse, error: manualError } = await supabase
    .from('respuestas_manuales')
    .select('manual_response, last_response_at')
    .eq('client_number', normalizedFrom)
    .eq('tenant_id', tenantId)
    .single();
  if (manualError && manualError.code !== 'PGRST116') {
    console.error('Error al verificar respuesta manual:', manualError.message);
  }
  const lastResponseTime = manualResponse?.last_response_at ? new Date(manualResponse.last_response_at) : null;
  const isManualResponseActive = manualResponse?.manual_response && lastResponseTime && lastResponseTime >= serverStartTime && new Date() < new Date(lastResponseTime.getTime() + 60 * 60 * 1000);
  if (isManualResponseActive) {
    console.log('Respuesta manual activa, no se procesará el mensaje.');
    return;
  }
  const response = await sendMessageToN8n(msg.body, msg.from, tenantId);
  if (response && response.reply) {
    let finalResponse = response.reply;
    let jsonResponse = null;
    if (response.reply.includes('```json')) {
      const validationResult = await validateAndCorrectResponse(response.reply, tenantId);
      if (validationResult.response?.error) {
        finalResponse = 'Lo siento, no encontré ese producto en el catálogo. ¿Querés probar con otra opción?';
      } else if (validationResult.response?.mensaje) {
        finalResponse = validationResult.response.mensaje;
        if (validationResult.textAfterJson) finalResponse += `\n\n${validationResult.textAfterJson}`;
      } else {
        const correctedResponse = validationResult.response;
        if (Array.isArray(correctedResponse)) {
          finalResponse = correctedResponse.map(product => `Te recomiendo la ${product.nombre} (${product.tamano}):\nIngredientes: ${product.ingredientes}\nPrecio: ${product.precio}`).join('\n\n') + '\n\n¿Querés que te las reserve?';
        } else {
          finalResponse = `Te recomiendo la ${correctedResponse.nombre} (${correctedResponse.tamano}):\nIngredientes: ${correctedResponse.ingredientes}\nPrecio: ${correctedResponse.precio}\n\n¿Querés que te la reserve?`;
        }
        if (validationResult.textAfterJson) finalResponse += `\n\n${validationResult.textAfterJson}`;
        jsonResponse = correctedResponse;
      }
    }
    const sentMessage = await client.sendMessage(msg.from, finalResponse);
    botResponses.add(sentMessage.id._serialized);
    await supabase.from('messages').insert([{ body: finalResponse, from: msg.from, recipient: msg.from, tenant_id: tenantId, is_outgoing: true, response_source: 'n8n', response_status: 'sent', created_at: new Date().toISOString() }]);
    if (jsonResponse && (messageLower.includes('confirmo') || messageLower.includes('sí') || messageLower.includes('si'))) {
      const product = Array.isArray(jsonResponse) ? jsonResponse[0] : jsonResponse;
      await registerOrder({ clientNumber: normalizedFrom, tenantId, productName: product.nombre, price: product.precio, size: product.tamano, clientName: 'Cliente', address: 'Dirección', paymentMethod: 'Pendiente' });
    }
  } else {
    const errorMessage = 'Hubo un error al procesar tu mensaje. Un agente te va a contactar pronto.';
    const sentMessage = await client.sendMessage(msg.from, errorMessage);
    botResponses.add(sentMessage.id._serialized);
    await supabase.from('messages').insert([{ body: errorMessage, from: msg.from, recipient: msg.from, tenant_id: tenantId, is_outgoing: true, response_source: 'error', response_status: 'sent', created_at: new Date().toISOString() }]);
    await notifyAdmin(tenantId, normalizedFrom, 'Error al procesar mensaje en n8n');
  }
  await checkClientTimeout(msg.from, tenantId);
});

loadGlobalCatalog();

client.initialize().catch((error) => {
  console.error('Error al inicializar el cliente de WhatsApp:', error.message);
  if (error.message.includes('ENOENT') || error.message.includes('TimeoutError')) {
    console.log('Error detectado, reiniciando en 5 segundos...');
    setTimeout(() => client.initialize(), 5000);
  }
});

app.listen(port, () => {
  console.log(`🚀 Servidor Express corriendo en puerto ${port}`);
});

process.on('uncaughtException', (error) => {
  console.error('Excepción no manejada:', error.message, error.stack);
  if (error.message.includes('TimeoutError')) {
    console.log('Timeout detectado, reiniciando en 5 segundos...');
    setTimeout(() => client.initialize(), 5000);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Rechazo no manejado en:', promise, 'Razón:', reason);
  if (reason.message.includes('TimeoutError')) {
    console.log('Timeout detectado, reiniciando en 5 segundos...');
    setTimeout(() => client.initialize(), 5000);
  }
});

process.on('SIGTERM', () => {
  console.log('Recibida señal SIGTERM. Cerrando el cliente de WhatsApp...');
  client.destroy().then(() => {
    console.log('Cliente de WhatsApp cerrado. Terminando proceso...');
    process.exit(0);
  });
});
