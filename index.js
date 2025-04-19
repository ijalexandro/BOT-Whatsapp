require('dotenv').config();

const express = require('express');
const { Client, AuthStrategy } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const { OpenAI } = require('openai');
const qrcode = require('qrcode-terminal');

// Configuración de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Configuración de OpenAI (ChatGPT)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Estrategia personalizada para almacenar la sesión en Supabase
class SupabaseAuth extends AuthStrategy {
  constructor(clientId, supabase) {
    super();
    this.clientId = clientId || 'default-client';
    this.supabase = supabase;
  }

  async beforeBrowserInitialized() {
    console.log('Inicializando SupabaseAuth para clientId:', this.clientId);
  }

  async afterAuth(data) {
    console.log('Guardando datos de autenticación en Supabase');
    const sessionData = JSON.stringify(data);

    const { error } = await this.supabase
      .from('whatsapp_sessions')
      .upsert([
        {
          client_id: this.clientId,
          session_data: sessionData,
          updated_at: new Date().toISOString(),
        }
      ], { onConflict: ['client_id'] });

    if (error) {
      console.error('Error al guardar la sesión en Supabase:', error.message);
    } else {
      console.log('Sesión guardada en Supabase');
    }

    return data;
  }

  async logout() {
    console.log('Eliminando sesión de Supabase');
    const { error } = await this.supabase
      .from('whatsapp_sessions')
      .delete()
      .eq('client_id', this.clientId);

    if (error) {
      console.error('Error al eliminar la sesión de Supabase:', error.message);
    } else {
      console.log('Sesión eliminada de Supabase');
    }
  }

  async getAuth() {
    console.log('Cargando datos de autenticación desde Supabase');
    const { data, error } = await this.supabase
      .from('whatsapp_sessions')
      .select('session_data')
      .eq('client_id', this.clientId)
      .single();

    if (error || !data) {
      console.error('Error al cargar la sesión de Supabase:', error?.message || 'No encontrada');
      return null;
    }

    try {
      return JSON.parse(data.session_data);
    } catch (err) {
      console.error('Error al parsear los datos de la sesión:', err.message);
      return null;
    }
  }
}

// Configuración de WhatsApp con la nueva estrategia de autenticación
const client = new Client({
  puppeteer: {
    executablePath: undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-web-security',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-breakpad',
      '--disable-client-side-phishing-detection',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--no-default-browser-check',
      '--no-pings',
      '--enable-logging',
      '--v=1',
      '--single-process'
    ],
    headless: 'new',
    ignoreHTTPSErrors: true,
    dumpio: false
  },
  authStrategy: new SupabaseAuth('my-client', supabase),
  webVersion: '2.2412.54',
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
  }
});

const app = express();
const port = process.env.PORT || 3000;
app.use(bodyParser.json());

// Conjuntos para tracking
const processedMessages = new Set();
const chatGPTResponses = new Set();

// Almacenar la hora de inicio del servidor
const serverStartTime = new Date();
console.log('Servidor iniciado en:', serverStartTime);

// Palabras clave para detectar si el cliente quiere hablar con una persona
const humanRequestKeywords = [
  'hablar con una persona',
  'necesito ayuda humana',
  'quiero hablar con alguien',
  'hablar con el encargado',
  'ayuda de una persona',
  'hablar con un humano'
];

// **Eventos de depuración para WhatsApp**
client.on('qr', (qr) => {
  console.log('📱 Escaneá este código QR desde WhatsApp Web:');
  console.log('\n', qr, '\n');
  console.log('También podés copiarlo en un generador de QR como https://www.qr-code-generator.com/');
});

client.on('qr_expired', () => {
  console.log('El código QR ha expirado. Generando un nuevo QR...');
});

client.on('authenticated', () => {
  console.log('Autenticación exitosa');
});

client.on('auth_failure', (msg) => {
  console.error('Error de autenticación:', msg);
});

client.on('disconnected', (reason) => {
  console.log('Cliente desconectado:', reason);
  console.log('Intentando reconectar...');
  client.initialize();
});

client.on('loading_screen', (percent, message) => {
  console.log('Cargando:', percent, message);
});

client.on('ready', () => {
  console.log('Cliente listo');
  setInterval(async () => {
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

client.on('puppeteer_error', (error) => {
  console.error('Error de Puppeteer:', error);
});

// Función para obtener el prompt personalizado desde Supabase
async function getTenantPromptTemplate(tenantId) {
  const { data, error } = await supabase
    .from('tenant_prompts')
    .select('prompt_template')
    .eq('tenant_id', tenantId)
    .single();

  if (error || !data) {
    console.error('Error al obtener el prompt del tenant:', error?.message || 'No encontrado');
    throw new Error('No se encontró un prompt para este tenant. Por favor, configura un prompt en la tabla tenant_prompts.');
  }
  return data.prompt_template;
}

// Función para registrar un pedido en la tabla pedidos
async function registerOrder({ clientNumber, tenantId, productName, price, size, clientName, address, paymentMethod }) {
  const { data, error } = await supabase
    .from('pedidos')
    .insert([{
      client_number: clientNumber,
      tenant_id: tenantId,
      product_name: productName,
      price: price,
      size: size,
      client_name: clientName,
      address: address,
      payment_method: paymentMethod,
      status: 'pendiente',
      created_at: new Date().toISOString()
    }])
    .select();

  if (error) {
    console.error('Error al registrar el pedido:', error.message);
    return { success: false, error: error.message };
  }

  console.log('Pedido registrado:', data);
  return { success: true, data };
}

// Función para obtener los datos del catálogo desde Supabase
async function getCatalogData(tenantId) {
  const { data, error } = await supabase
    .from('productos')
    .select('nombre, precio, descripcion, tamano, foto_url, categoria')
    .eq('tenant_id', tenantId.toString());

  if (error) {
    console.error('Error al obtener el catálogo:', error.message);
    throw new Error('No se pudo cargar el catálogo.');
  }

  return data;
}

// Función para validar y corregir la respuesta de ChatGPT
async function validateAndCorrectResponse(response, tenantId) {
  let parsedResponse;
  try {
    // Removemos el bloque de código Markdown si existe (```json ... ```)
    const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      parsedResponse = JSON.parse(jsonMatch[1]);
      // Extraemos el texto después del JSON
      const textAfterJson = response.slice(jsonMatch[0].length).trim();
      return {
        response: parsedResponse,
        textAfterJson: textAfterJson || '',
        corrected: false
      };
    } else {
      parsedResponse = JSON.parse(response);
      return {
        response: parsedResponse,
        textAfterJson: '',
        corrected: false
      };
    }
  } catch (error) {
    console.error('Error al parsear la respuesta de ChatGPT:', error.message);
    return {
      response: { mensaje: response },
      textAfterJson: '',
      corrected: false
    };
  }

  if (parsedResponse.error) {
    return { response: parsedResponse, textAfterJson: '', corrected: false };
  }

  const catalog = await getCatalogData(tenantId);

  if (Array.isArray(parsedResponse)) {
    const correctedResponse = [];
    let hasCorrections = false;

    for (const product of parsedResponse) {
      const catalogProduct = catalog.find(p => p.nombre === product.nombre && p.tamano === product.tamano);
      if (!catalogProduct) {
        return {
          error: `El producto ${product.nombre} no existe en el catálogo.`,
          textAfterJson: '',
          corrected: false
        };
      }

      const correctedProduct = { ...product };
      let productCorrected = false;

      if (product.precio !== catalogProduct.precio) {
        console.log(`Corrigiendo precio de ${product.nombre}: ${product.precio} -> ${catalogProduct.precio}`);
        correctedProduct.precio = catalogProduct.precio;
        productCorrected = true;
      }

      if (product.ingredientes !== catalogProduct.descripcion) {
        console.log(`Corrigiendo ingredientes de ${product.nombre}: ${product.ingredientes} -> ${catalogProduct.descripcion}`);
        correctedProduct.ingredientes = catalogProduct.descripcion;
        productCorrected = true;
      }

      if (product.foto_url !== catalogProduct.foto_url) {
        console.log(`Corrigiendo foto_url de ${product.nombre}: ${product.foto_url} -> ${catalogProduct.foto_url}`);
        correctedProduct.foto_url = catalogProduct.foto_url;
        productCorrected = true;
      }

      correctedResponse.push(correctedProduct);
      if (productCorrected) hasCorrections = true;
    }

    return { response: correctedResponse, textAfterJson: '', corrected: hasCorrections };
  } else {
    const catalogProduct = catalog.find(p => p.nombre === parsedResponse.nombre && p.tamano === parsedResponse.tamano);
    if (!catalogProduct) {
      return {
        error: `El producto ${parsedResponse.nombre} no existe en el catálogo.`,
        textAfterJson: '',
        corrected: false
      };
    }

    const correctedResponse = { ...parsedResponse };
    let hasCorrections = false;

    if (parsedResponse.precio !== catalogProduct.precio) {
      console.log(`Corrigiendo precio de ${parsedResponse.nombre}: ${parsedResponse.precio} -> ${catalogProduct.precio}`);
      correctedResponse.precio = catalogProduct.precio;
      hasCorrections = true;
    }

    if (parsedResponse.ingredientes !== catalogProduct.descripcion) {
      console.log(`Corrigiendo ingredientes de ${parsedResponse.nombre}: ${parsedResponse.ingredientes} -> ${catalogProduct.descripcion}`);
      correctedResponse.ingredientes = catalogProduct.descripcion;
      hasCorrections = true;
    }

    if (parsedResponse.foto_url !== catalogProduct.foto_url) {
      console.log(`Corrigiendo foto_url de ${parsedResponse.nombre}: ${parsedResponse.foto_url} -> ${catalogProduct.foto_url}`);
      correctedResponse.foto_url = catalogProduct.foto_url;
      hasCorrections = true;
    }

    return { response: correctedResponse, textAfterJson: '', corrected: hasCorrections };
  }
}

// Función para enviar a ChatGPT
async function sendToChatGPT(message, sessionId, context = {}) {
  const tenantId = context.tenantId || 1;
  const clientNumber = (context.from && normalizeWhatsappNumber(context.from)) || 'Desconocido';

  const messageLower = message.toLowerCase();
  const wantsHuman = humanRequestKeywords.some(keyword => messageLower.includes(keyword));
  if (wantsHuman) {
    const notifMessage = `Cliente ${clientNumber} solicita hablar con una persona: "${message}"`;
    await notifyAdmin(tenantId, clientNumber, notifMessage);
    await handleManualResponse(clientNumber, tenantId);
    return { response: 'Un agente te va a contactar en breve, ¿dale?', source: 'system' };
  }

  const { data: manualResponse, error: manualError } = await supabase
    .from('respuestas_manuales')
    .select('manual_response, last_response_at')
    .eq('client_number', clientNumber)
    .eq('tenant_id', tenantId)
    .single();

  if (manualError && manualError.code !== 'PGRST116') {
    console.error('Error al verificar respuesta manual:', manualError.message);
  }

  const lastResponseTime = manualResponse?.last_response_at ? new Date(manualResponse.last_response_at) : null;
  const isManualResponseActive = manualResponse?.manual_response && 
    lastResponseTime && 
    lastResponseTime >= serverStartTime && 
    new Date() < new Date(lastResponseTime.getTime() + 60 * 60 * 1000);

  if (isManualResponseActive) {
    console.log('Respuesta manual activa, ChatGPT no responderá.');
    return null;
  }

  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('business_name')
    .eq('id', tenantId)
    .single();

  if (tenantError || !tenant) {
    console.error('Error al obtener información del tenant:', tenantError?.message || 'No encontrada');
    return { response: 'Hubo un error. Un agente te va a contactar pronto.', source: 'error' };
  }

  const businessName = tenant.business_name || 'Nuestro negocio';

  const { data: messages, error: messagesError } = await supabase
    .from('messages')
    .select('body, is_outgoing')
    .eq('from', clientNumber)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(5);

  if (messagesError) {
    console.error('Error al obtener historial de conversación:', messagesError.message);
    return { response: 'Hubo un error. Un agente te va a contactar pronto.', source: 'error' };
  }

  const conversationHistory = messages
    .reverse()
    .map(msg => `${msg.is_outgoing ? 'Asistente' : 'Cliente'}: ${msg.body}`)
    .join('\n');

  const catalog = await getCatalogData(tenantId);
  const menu = catalog.map(p => `${p.nombre} - ${p.precio}, ${p.tamano} (${p.categoria || 'Sin categoría'})\nIngredientes: ${p.descripcion || 'No especificados'}`).join('\n');

  const { data: horarios, error: horariosError } = await supabase
    .from('horarios')
    .select('dia_semana, hora_apertura, hora_cierre')
    .eq('tenant_id', tenantId.toString());

  if (horariosError) {
    console.error('Error al obtener horarios:', horariosError.message);
    return { response: 'Hubo un error. Un agente te va a contactar pronto.', source: 'error' };
  }

  const schedules = horarios.map(h => `${h.dia_semana}: ${h.hora_apertura} - ${h.hora_cierre}`).join(', ');

  const { data: diasCerrados, error: diasCerradosError } = await supabase
    .from('dias_cerrados')
    .select('fecha')
    .eq('tenant_id', tenantId.toString());

  if (diasCerradosError) {
    console.error('Error al obtener días cerrados:', diasCerradosError.message);
    return { response: 'Hubo un error. Un agente te va a contactar pronto.', source: 'error' };
  }

  const closedDays = diasCerrados.map(d => d.fecha).join(', ');

  let promptTemplate;
  try {
    promptTemplate = await getTenantPromptTemplate(tenantId);
  } catch (error) {
    console.error(error.message);
    const notifMessage = `No se encontró un prompt para el tenant ${tenantId}. Por favor, configura un prompt en la tabla tenant_prompts.`;
    await notifyAdmin(tenantId, clientNumber, notifMessage);
    return { response: 'No puedo procesar tu pedido ahora. Un agente te va a contactar pronto.', source: 'error' };
  }

  const prompt = promptTemplate
    .replace('{business_name}', businessName)
    .replace('{conversation_history}', conversationHistory || 'No hay historial previo.')
    .replace('{menu}', menu || 'No hay productos disponibles.')
    .replace('{schedules}', schedules || 'No hay horarios disponibles.')
    .replace('{closed_days}', closedDays || 'No hay días cerrados registrados.')
    .replace('{user_message}', message);

  try {
    console.log('Enviando a ChatGPT:', message);
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: message }
      ],
      temperature: 0.0,
      max_tokens: 1000
    });

    const chatGPTResponse = response.choices[0].message.content;
    console.log('Respuesta de ChatGPT:', chatGPTResponse);

    const validationResult = await validateAndCorrectResponse(chatGPTResponse, tenantId);
    if (!validationResult) {
      throw new Error('validateAndCorrectResponse devolvió undefined');
    }

    const { response: correctedResponse, textAfterJson, corrected } = validationResult;

    if (corrected) {
      console.log('La respuesta de ChatGPT fue corregida automáticamente.');
    }

    if (correctedResponse?.error) {
      return { response: correctedResponse.error, source: 'error', textAfterJson: '' };
    }

    if (correctedResponse.mensaje) {
      const finalResponse = textAfterJson ? `${correctedResponse.mensaje}\n\n${textAfterJson}` : correctedResponse.mensaje;
      return { response: finalResponse, source: 'chatgpt', jsonResponse: correctedResponse };
    }

    let formattedResponse = '';
    if (Array.isArray(correctedResponse)) {
      formattedResponse = correctedResponse.map(product => 
        `Te recomiendo la ${product.nombre}:\nIngredientes: ${product.ingredientes}\nPrecio: ${product.precio}`
      ).join('\n\n') + '\n\n¿Querés que te las reserve?';
    } else {
      formattedResponse = `Te recomiendo la ${correctedResponse.nombre}:\nIngredientes: ${correctedResponse.ingredientes}\nPrecio: ${correctedResponse.precio}\n\n¿Querés que te la reserve?`;
    }

    const finalResponse = textAfterJson ? `${formattedResponse}\n\n${textAfterJson}` : formattedResponse;
    return { response: finalResponse, source: 'chatgpt', jsonResponse: correctedResponse };
  } catch (error) {
    console.error('Error al enviar a ChatGPT:', error.message);
    const notifMessage = `Cliente ${clientNumber} no pudo ser atendido por ChatGPT: ${error.message}`;
    await notifyAdmin(tenantId, clientNumber, notifMessage);
    return { response: 'Hubo un error al procesar tu mensaje. Un agente te va a contactar pronto.', source: 'error' };
  }
}

// Funciones auxiliares
async function getBusinessName(tenantId) {
  const { data, error } = await supabase
    .from('tenants')
    .select('business_name')
    .eq('id', tenantId)
    .single();
  return error ? 'Nuestro negocio' : (data.business_name || 'Nuestro negocio');
}

function normalizeWhatsappNumber(whatsappNumber) {
  return whatsappNumber ? whatsappNumber.replace('@c.us', '').trim() : null;
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
      chatGPTResponses.add(sentMessage.id._serialized);
      await supabase.from('notificaciones').insert([{
        client_number: normalizedClientNumber,
        tenant_id: tenantId,
        message: notifMessage
      }]);
      console.log('Notificación enviada');
    } else {
      console.log('Notificación ya enviada recientemente');
    }
  } catch (error) {
    console.error('Error notificando:', error.message);
  }
}

async function shouldNotify(clientNumber, tenantId, message) {
  const normalizedClientNumber = normalizeWhatsappNumber(clientNumber) || 'Desconocido';
  const { data: existing, error } = await supabase
    .from('notificaciones')
    .select('id')
    .eq('client_number', normalizedClientNumber)
    .eq('tenant_id', tenantId)
    .eq('message', message)
    .gte('created_at', new Date(Date.now() - 20 * 60 * 1000).toISOString())
    .limit(1);

  if (error && error.code !== 'PGRST116') {
    console.error('Error verificando notificación:', error.message);
    return false;
  }
  return !existing || existing.length === 0;
}

async function handleManualResponse(clientNumber, tenantId) {
  const normalizedClientNumber = normalizeWhatsappNumber(clientNumber) || 'Desconocido';
  const { error } = await supabase
    .from('respuestas_manuales')
    .upsert([{
      client_number: normalizedClientNumber,
      tenant_id: tenantId,
      manual_response: true,
      last_response_at: new Date(),
      deepseek_invocation_count: 0
    }], { onConflict: ['client_number', 'tenant_id'] });

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
        chatGPTResponses.add(sentMessage.id._serialized);
      }
    }
  }
}

// Handlers
app.get('/', (req, res) => {
  res.send('¡Servidor funcionando!');
});

// Eventos WhatsApp
client.on('message_create', async (message) => {
  const messageId = message.id._serialized;
  if (processedMessages.has(messageId)) {
    console.log('Mensaje ya procesado (message_create):', messageId);
    return;
  }

  processedMessages.add(messageId);
  setTimeout(() => processedMessages.delete(messageId), 5 * 60 * 1000);

  console.log('Nuevo mensaje (message_create):', message.body);
  console.log('Detalles del mensaje:', {
    from: message.from,
    to: message.to,
    fromMe: message.fromMe,
    id: message.id._serialized
  });

  let tenantId = 1;
  const normalizedFrom = normalizeWhatsappNumber(message.from);
  const normalizedTo = normalizeWhatsappNumber(message.to);

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
      .eq('from', message.from)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    tenantId = lastMessage?.tenant_id || 1;
  }

  if (message.fromMe || normalizedFrom === '5491135907587') {
    if (chatGPTResponses.has(messageId)) {
      console.log('Ignorando mensaje enviado por ChatGPT o notificación:', message.body);
      return;
    }

    console.log('Registrando mensaje manual del comercio:', message.body);
    const { data: savedManualMessage, error: saveError } = await supabase
      .from('messages')
      .insert([{
        body: message.body,
        from: message.to,
        recipient: message.to,
        tenant_id: tenantId,
        is_outgoing: true,
        response_source: 'manual',
        response_status: 'sent',
        created_at: new Date().toISOString()
      }])
      .select();

    if (saveError) {
      console.error('Error al guardar mensaje manual:', saveError.message);
    } else {
      console.log('Mensaje manual guardado:', savedManualMessage);
      await handleManualResponse(message.to, tenantId);
    }
    return;
  }

  const { data: savedMessage, error: saveError } = await supabase
    .from('messages')
    .insert([{
      body: message.body,
      from: message.from,
      tenant_id: tenantId,
      is_outgoing: false,
      created_at: new Date().toISOString()
    }])
    .select();
  if (saveError) {
    console.error('Error al guardar mensaje entrante:', saveError.message);
    return;
  } else {
    console.log('Mensaje entrante guardado:', savedMessage);
  }

  try {
    const result = await sendToChatGPT(message.body, message.from, {
      tenantId,
      from: message.from
    });

    if (result?.response) {
      const sentMessage = await client.sendMessage(message.from, result.response);
      chatGPTResponses.add(sentMessage.id._serialized);
      console.log('Respuesta enviada al cliente:', result.response);

      const { data: savedResponse, error: responseError } = await supabase
        .from('messages')
        .insert([{
          body: result.response,
          from: message.from,
          recipient: message.from,
          tenant_id: tenantId,
          is_outgoing: true,
          response_source: result.source,
          response_status: 'sent',
          created_at: new Date().toISOString()
        }])
        .select();

      if (responseError) {
        console.error('Error al registrar respuesta:', responseError.message);
      } else {
        console.log('Respuesta registrada:', savedResponse);
      }

      const messageLower = message.body.toLowerCase();

      if (result.jsonResponse && !result.jsonResponse.error && (messageLower.includes('confirmo') || messageLower.includes('sí') || messageLower.includes('si'))) {
        const product = Array.isArray(result.jsonResponse) ? result.jsonResponse[0] : result.jsonResponse;
        await registerOrder({
          clientNumber: normalizedFrom,
          tenantId: tenantId,
          productName: product.nombre,
          price: parseFloat(product.precio.replace('$ ', '').replace('.', '')),
          size: product.tamano,
          clientName: 'Cliente',
          address: 'Dirección',
          paymentMethod: 'Pendiente'
        });
      }
    } else {
      console.log('No se generó respuesta para el mensaje:', message.body);
      const { data: noResponse, error: noResponseError } = await supabase
        .from('messages')
        .insert([{
          body: 'No se generó respuesta',
          from: message.from,
          recipient: message.from,
          tenant_id: tenantId,
          is_outgoing: true,
          response_source: 'chatgpt',
          response_status: 'no_response',
          created_at: new Date().toISOString()
        }])
        .select();

      if (noResponseError) {
        console.error('Error al registrar no respuesta:', noResponseError.message);
      } else {
        console.log('Registrado mensaje sin respuesta:', noResponse);
      }
    }
  } catch (error) {
    console.error('Error al procesar mensaje con ChatGPT:', error.message);
  }

  await checkClientTimeout(message.from, tenantId);
});

client.initialize();
app.listen(port, () => {
  console.log(`Servidor en puerto ${port}`);
});
