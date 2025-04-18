require('dotenv').config();

const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const dialogflow = require('@google-cloud/dialogflow');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

// Configuración de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Configuración de Dialogflow
const sessionClient = new dialogflow.SessionsClient({
  keyFilename: './dialogflow-api-access.json'
});

// Configuración de WhatsApp
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
    dumpio: false // Silenciar logs de Chromium
  },
  authStrategy: new LocalAuth({
    dataPath: './.wwebjs_auth',
    clientId: 'my-client'
  }),
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
const processedDialogflowMessages = new Set();
const dialogflowResponses = new Set();

// Objeto para rastrear clientes atendidos por Qwen y su última interacción
// { clientNumber: lastInteractionTimestamp }
const clientsHandledByQwen = {};

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
  console.log('Código QR generado. Escanea este código con tu teléfono:');
  qrcode.generate(qr, { small: true });
});

client.on('qr_expired', () => {
  console.log('El código QR ha expirado. Generando un nuevo QR...');
});

client.on('authenticated', () => {
  console.log('Autenticación exitosa');
  console.log('Sesión guardada en:', client.options.authStrategy.dataPath);
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

// Función para obtener la clave API de Qwen desde Supabase
async function getQwenApiKey(tenantId) {
  const { data, error } = await supabase
    .from('api_keys')
    .select('api_key')
    .eq('tenant_id', tenantId)
    .single();

  if (error || !data) {
    console.error('Error al obtener la clave API de Qwen:', error?.message || 'No encontrada');
    return null;
  }
  return data.api_key;
}

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

// Función para extraer información del historial
function extractContextFromHistory(conversationHistory) {
  const context = {
    numberOfPeople: null,
    selectedProduct: null,
    selectedSize: null,
    price: null
  };

  // Extraer la cantidad de personas
  const peopleMatch = conversationHistory.match(/(?:somos|somo|para)\s*(\d+)/i);
  if (peopleMatch) {
    context.numberOfPeople = parseInt(peopleMatch[1], 10);
  }

  // Extraer el producto seleccionado
  const productMatch = conversationHistory.match(/(?:quiero|haceme|dame|sí, la|sí la|anotala)\s*(?:una\s*)?(\w+(?:\s+\w+)*)/i);
  if (productMatch) {
    context.selectedProduct = productMatch[1].trim();
  }

  // Extraer el tamaño y precio del último producto mencionado
  const lastProductMatch = conversationHistory.match(/(?:te anoto la|te recomiendo la)\s*(\w+(?:\s+\w+)*)\s*de\s*\$(\d+),\s*para\s*([^\.]+)/i);
  if (lastProductMatch) {
    context.selectedProduct = lastProductMatch[1].trim();
    context.price = parseFloat(lastProductMatch[2]);
    context.selectedSize = lastProductMatch[3].trim();
  }

  return context;
}

// Función para enviar a Qwen 2.5
async function sendToQwen(message, sessionId, context = {}) {
  const tenantId = context.tenantId || 1;
  const clientNumber = (context.from && normalizeWhatsappNumber(context.from)) || 'Desconocido';

  // Actualizar el tiempo de última interacción del cliente en clientsHandledByQwen
  if (clientNumber !== 'Desconocido') {
    clientsHandledByQwen[clientNumber] = new Date();
    console.log(`Cliente ${clientNumber} ahora será manejado exclusivamente por Qwen. Última interacción: ${clientsHandledByQwen[clientNumber]}`);
  }

  // Verificar si el cliente quiere hablar con una persona
  const messageLower = message.toLowerCase();
  const wantsHuman = humanRequestKeywords.some(keyword => messageLower.includes(keyword));
  if (wantsHuman) {
    const notifMessage = `Cliente ${clientNumber} solicita hablar con una persona: "${message}"`;
    await notifyAdmin(tenantId, clientNumber, notifMessage);
    await handleManualResponse(clientNumber, tenantId);
    return 'Un agente te va a contactar en breve, ¿dale?';
  }

  // Obtener el contador actual de invocaciones (solo para seguimiento, no para limitar)
  const { data: manualResponse, error: manualError } = await supabase
    .from('respuestas_manuales')
    .select('deepseek_invocation_count')
    .eq('client_number', clientNumber)
    .eq('tenant_id', tenantId)
    .single();

  let qwenInvocationCount = (manualResponse?.deepseek_invocation_count || 0) + 1;

  // Actualizar el contador (solo para estadísticas)
  await supabase
    .from('respuestas_manuales')
    .upsert({
      client_number: clientNumber,
      tenant_id: tenantId,
      deepseek_invocation_count: qwenInvocationCount
    }, { onConflict: ['client_number', 'tenant_id'] });

  // Obtener la clave API de Qwen
  const qwenApiKey = await getQwenApiKey(tenantId);
  if (!qwenApiKey) {
    return 'Hubo un error al conectar con el asistente. Un agente te va a contactar pronto.';
  }

  // Obtener información del tenant
  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('business_name')
    .eq('id', tenantId)
    .single();

  if (tenantError || !tenant) {
    console.error('Error al obtener información del tenant:', tenantError?.message || 'No encontrada');
    return 'Hubo un error. Un agente te va a contactar pronto.';
  }

  const businessName = tenant.business_name || 'Nuestro negocio';

  // Obtener historial de la conversación
  const { data: messages, error: messagesError } = await supabase
    .from('messages')
    .select('body, is_outgoing')
    .eq('from', clientNumber)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(5);

  if (messagesError) {
    console.error('Error al obtener historial de conversación:', messagesError.message);
    return 'Hubo un error. Un agente te va a contactar pronto.';
  }

  const conversationHistory = messages
    .reverse()
    .map(msg => `${msg.is_outgoing ? 'Asistente' : 'Cliente'}: ${msg.body}`)
    .join('\n');

  // Obtener el menú (incluyendo la descripción)
  const { data: productos, error: productosError } = await supabase
    .from('productos')
    .select('nombre, precio, tamano, categoria, descripcion')
    .eq('tenant_id', tenantId.toString());

  if (productosError) {
    console.error('Error al obtener productos:', productosError.message);
    return 'Hubo un error. Un agente te va a contactar pronto.';
  }

  const menu = productos.map(p => `${p.nombre} - $${p.precio}, ${p.tamano} (${p.categoria || 'Sin categoría'})\nIngredientes: ${p.descripcion || 'No especificados'}`).join('\n');

  // Obtener horarios
  const { data: horarios, error: horariosError } = await supabase
    .from('horarios')
    .select('dia_semana, hora_apertura, hora_cierre')
    .eq('tenant_id', tenantId.toString());

  if (horariosError) {
    console.error('Error al obtener horarios:', horariosError.message);
    return 'Hubo un error. Un agente te va a contactar pronto.';
  }

  const schedules = horarios.map(h => `${h.dia_semana}: ${h.hora_apertura} - ${h.hora_cierre}`).join(', ');

  // Obtener días cerrados
  const { data: diasCerrados, error: diasCerradosError } = await supabase
    .from('dias_cerrados')
    .select('fecha')
    .eq('tenant_id', tenantId.toString());

  if (diasCerradosError) {
    console.error('Error al obtener días cerrados:', diasCerradosError.message);
    return 'Hubo un error. Un agente te va a contactar pronto.';
  }

  const closedDays = diasCerrados.map(d => d.fecha).join(', ');

  // Obtener el prompt personalizado
  let promptTemplate;
  try {
    promptTemplate = await getTenantPromptTemplate(tenantId);
  } catch (error) {
    console.error(error.message);
    const notifMessage = `No se encontró un prompt para el tenant ${tenantId}. Por favor, configura un prompt en la tabla tenant_prompts.`;
    await notifyAdmin(tenantId, clientNumber, notifMessage);
    return 'No puedo procesar tu pedido ahora. Un agente te va a contactar pronto.';
  }

  // Construir el prompt dinámico
  const prompt = promptTemplate
    .replace('{business_name}', businessName)
    .replace('{conversation_history}', conversationHistory || 'No hay historial previo.')
    .replace('{menu}', menu || 'No hay productos disponibles.')
    .replace('{schedules}', schedules || 'No hay horarios disponibles.')
    .replace('{closed_days}', closedDays || 'No hay días cerrados registrados.')
    .replace('{user_message}', message);

  // Extraer información del historial
  const extractedContext = extractContextFromHistory(conversationHistory + `\nCliente: ${message}`);

  // Si el cliente confirma con "sí" o reafirma un producto, forzar el avance
  const isConfirmation = messageLower.match(/^(s[ií](, la|,la)?|anotala|mandamela|dale)\s*(\w+(?:\s+\w+)*)?$/i);
  const isNumberOfPeople = messageLower.match(/^\d+$/i);
  const isReaffirmation = messageLower.includes('ya te dije') || messageLower.includes('te dije que');

  if (isConfirmation || isReaffirmation || (isNumberOfPeople && extractedContext.selectedProduct)) {
    let product = extractedContext.selectedProduct;
    let numberOfPeople = extractedContext.numberOfPeople;
    let size = extractedContext.selectedSize;
    let price = extractedContext.price;

    // Si el mensaje es un número y ya hay un producto seleccionado, asumir que es la cantidad de personas
    if (isNumberOfPeople && extractedContext.selectedProduct) {
      numberOfPeople = parseInt(message, 10);
    }

    // Si el mensaje es una confirmación con un producto (por ejemplo, "sí, la Criolla"), usar ese producto
    if (isConfirmation && isConfirmation[2]) {
      product = isConfirmation[2].trim();
    }

    // Si no hay producto, pero el mensaje reafirma un producto (por ejemplo, "ya te dije que quiero la Criolla"), extraerlo
    if (!product && isReaffirmation) {
      const reaffirmationMatch = message.match(/(?:quiero|haceme|dame)\s*(?:una\s*)?(\w+(?:\s+\w+)*)/i);
      if (reaffirmationMatch) {
        product = reaffirmationMatch[1].trim();
      }
    }

    // Si tenemos producto y número de personas, buscar el tamaño y precio correspondientes
    if (product && numberOfPeople) {
      const productData = productos.find(p => p.nombre.toLowerCase() === product.toLowerCase() && parseInt(p.tamano.match(/comen (\d+)/i)?.[1], 10) === numberOfPeople);
      if (productData) {
        size = productData.tamano;
        price = productData.precio;
      }
    }

    // Si tenemos toda la información necesaria, avanzar al pedido
    if (product && size && price) {
      return `¡Genial! Te anoto la ${product} de $${price}, para ${size}. ¿Todo bien para confirmar?`;
    }
  }

  try {
    console.log('Enviando a Qwen 2.5:', message);
    const response = await axios.post(
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
      {
        model: 'qwen-plus',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: message }
        ],
        temperature: 0.0,
        max_tokens: 8000
      },
      {
        headers: {
          'Authorization': `Bearer ${qwenApiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    let qwenResponse = response.data.choices[0].message.content;
    console.log('Respuesta de Qwen 2.5:', qwenResponse);

    // Verificar si Qwen incluyó [NOTIFY_ADMIN] en su respuesta
    if (qwenResponse.includes('[NOTIFY_ADMIN]')) {
      // Limpiar la respuesta para el cliente (quitar [NOTIFY_ADMIN])
      qwenResponse = qwenResponse.replace('[NOTIFY_ADMIN]', '').trim();

      // Notificar al administrador
      const notifMessage = `Cliente ${clientNumber} necesita ayuda: Qwen detectó un problema en la conversación: "${message}"`;
      await notifyAdmin(tenantId, clientNumber, notifMessage);
      await handleManualResponse(clientNumber, tenantId);

      // Agregar mensaje de intervención al cliente
      qwenResponse += '\n\nNo pude ayudarte con esto. Un agente te va a contactar pronto.';
    }

    // Verificar si Qwen quiere registrar un pedido
    if (qwenResponse.includes('[REGISTER_ORDER]')) {
      // Extraer los datos del pedido de la respuesta de Qwen
      const orderMatch = qwenResponse.match(/\[REGISTER_ORDER\]\s*\{([^}]+)\}/);
      if (orderMatch) {
        const orderDataStr = orderMatch[1];
        const orderData = {};
        orderDataStr.split(',').forEach(pair => {
          const [key, value] = pair.split(':').map(s => s.trim());
          orderData[key] = value;
        });

        // Registrar el pedido
        const result = await registerOrder({
          clientNumber: clientNumber,
          tenantId: tenantId,
          productName: orderData.product_name,
          price: parseFloat(orderData.price),
          size: orderData.size,
          clientName: orderData.client_name,
          address: orderData.address,
          paymentMethod: orderData.payment_method
        });

        if (result.success) {
          // Limpiar la respuesta para el cliente (quitar [REGISTER_ORDER])
          qwenResponse = qwenResponse.replace(/\[REGISTER_ORDER\]\s*\{[^}]+\}/, '').trim();
        } else {
          qwenResponse = 'Hubo un error al registrar tu pedido. Un agente te va a contactar pronto.';
        }
      } else {
        qwenResponse = 'No pude registrar tu pedido correctamente. Un agente te va a contactar pronto.';
      }
    } else if (messageLower === 'sí' || messageLower === 'si') {
      // Si el cliente confirma con "sí" pero Qwen no incluyó [REGISTER_ORDER], intentar avanzar manualmente
      const extracted = extractContextFromHistory(conversationHistory);
      if (extracted.selectedProduct && extracted.selectedSize && extracted.price) {
        qwenResponse = `Genial, ya tengo tu pedido de la ${extracted.selectedProduct} por $${extracted.price}, para ${extracted.selectedSize}. Me falta tu nombre, dirección y cómo vas a pagar (efectivo, transferencia o tarjeta). ¿Me pasás esos datos?`;
      }
    }

    return qwenResponse;
  } catch (error) {
    console.error('Error al enviar a Qwen 2.5:', error.message);
    if (error.response?.status === 402 || error.message.includes('insufficient balance')) {
      const notifMessage = `Cliente ${clientNumber} no puede ser atendido por Qwen debido a saldo insuficiente.`;
      await notifyAdmin(tenantId, clientNumber, notifMessage);
      await handleManualResponse(clientNumber, tenantId);
      return 'No puedo procesar tu pedido ahora por un problema con el servicio. Un agente te va a contactar pronto.';
    }
    return 'Hubo un error al procesar tu mensaje. Un agente te va a contactar pronto.';
  }
}

// Función para enviar a Dialogflow
async function sendToDialogflow(message, sessionId, context = {}) {
  const dialogflowMessageId = `${sessionId}:${message}`;
  if (processedDialogflowMessages.has(dialogflowMessageId)) {
    console.log('Mensaje ya procesado por Dialogflow, ignorando:', message);
    return null;
  }

  processedDialogflowMessages.add(dialogflowMessageId);
  setTimeout(() => processedDialogflowMessages.delete(dialogflowMessageId), 5 * 60 * 1000);

  let tenantId = context.tenantId || 1;
  let clientNumber = (context.from && normalizeWhatsappNumber(context.from)) || 'Desconocido';

  // Verificar si el cliente ya ha sido atendido por Qwen y si han pasado más de 6 horas
  if (clientNumber !== 'Desconocido' && clientsHandledByQwen[clientNumber]) {
    const lastInteraction = new Date(clientsHandledByQwen[clientNumber]);
    const now = new Date();
    const timeDiff = (now - lastInteraction) / (1000 * 60 * 60); // Diferencia en horas

    if (timeDiff > 6) {
      // Han pasado más de 6 horas, permitir que Dialogflow responda de nuevo
      console.log(`Han pasado más de 6 horas desde la última interacción de ${clientNumber}. Permitiendo que Dialogflow responda.`);
      delete clientsHandledByQwen[clientNumber];
    } else {
      // Redirigir directamente a Qwen
      console.log(`Cliente ${clientNumber} ya fue atendido por Qwen, redirigiendo directamente a Qwen...`);
      const qwenResponse = await sendToQwen(message, sessionId, { tenantId, from: clientNumber });
      return { response: qwenResponse, source: 'qwen' };
    }
  }

  // Verificar si hay una respuesta manual activa
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
    console.log('Respuesta manual activa, Dialogflow no responderá.');
    return null;
  }

  if (!context.tenantId && clientNumber !== 'Desconocido') {
    const normalizedNumber = normalizeWhatsappNumber(clientNumber);
    if (normalizedNumber === '5491135907587') {
      const { data: tenant, error: tenantError } = await supabase
        .from('tenants')
        .select('id')
        .eq('whatsapp_number', normalizedNumber)
        .single();

      if (!tenantError && tenant) {
        tenantId = tenant.id;
      } else {
        console.error('Error al obtener tenant:', tenantError?.message || 'No encontrado');
      }
    } else {
      const { data: lastMessage, error: messageError } = await supabase
        .from('messages')
        .select('tenant_id')
        .eq('from', clientNumber)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!messageError && lastMessage) {
        tenantId = lastMessage.tenant_id;
      }
    }
  }

  await new Promise(resolve => setTimeout(resolve, 500));

  const sessionPath = sessionClient.projectAgentSessionPath(process.env.DIALOGFLOW_PROJECT_ID, sessionId);
  const request = {
    session: sessionPath,
    queryInput: {
      text: {
        text: message,
        languageCode: 'es'
      }
    }
  };

  try {
    console.log('Enviando a Dialogflow:', message);
    const responses = await sessionClient.detectIntent(request);
    const intent = responses[0].queryResult.intent.displayName;
    const parameters = responses[0].queryResult.parameters;
    let fulfillmentText = responses[0].queryResult.fulfillmentText || '';
    console.log('Respuesta Dialogflow - Intent:', intent, 'Texto:', fulfillmentText);

    // Si Dialogflow activa el Default Fallback Intent, redirigir a Qwen
    if (intent === 'Default Fallback Intent') {
      console.log('Dialogflow no entendió, redirigiendo a Qwen...');
      const qwenResponse = await sendToQwen(message, sessionId, { tenantId, from: clientNumber });
      return { response: qwenResponse, source: 'qwen' };
    }

    if (intent === 'Default Welcome Intent') {
      const businessName = await getBusinessName(tenantId);
      if (fulfillmentText.trim()) {
        return { response: fulfillmentText.replace('[nombre_del_negocio]', businessName), source: 'dialogflow' };
      }
      return { response: `¡Hola! Bienvenido a ${businessName}. ¿En qué puedo ayudarte hoy?`, source: 'dialogflow' };
    } else if (intent === 'WelcomeWithRequest') {
      console.log('Dialogflow detectó WelcomeWithRequest, redirigiendo a Qwen...');
      const qwenResponse = await sendToQwen(message, sessionId, { tenantId, from: clientNumber });
      return { response: qwenResponse, source: 'qwen' };
    } else if (intent === 'Consultar menú') {
      const { data, error } = await supabase.from('productos').select('nombre, descripcion, precio, tamano, categoria').eq('tenant_id', tenantId.toString());
      if (error) {
        const notifMessage = `Error al consultar menú para ${clientNumber}: ${error.message}`;
        if (await shouldNotify(clientNumber, tenantId, notifMessage)) {
          await notifyAdmin(tenantId, clientNumber, notifMessage);
        }
        return { response: 'Hubo un error. Un agente te va a contactar pronto.', source: 'error' };
      } else if (data.length === 0) {
        return { response: fulfillmentText || 'No hay productos disponibles.', source: 'dialogflow' };
      }

      const categorias = {};
      data.forEach(item => {
        const categoria = item.categoria || 'Sin categoría';
        if (!categorias[categoria]) categorias[categoria] = [];
        categorias[categoria].push(item);
      });

      let respuesta = fulfillmentText || 'Nuestros productos:\n';
      for (const [categoria, productos] of Object.entries(categorias)) {
        if (productos.length > 0) {
          respuesta += `- ${categoria}: Ej. ${productos[0].nombre}, ${productos[1]?.nombre || ''}\n`;
        }
      }
      respuesta += '¿Qué te gustaría pedir?';
      return { response: respuesta, source: 'dialogflow' };
    } else if (intent === 'Hacer pedido') {
      if (fulfillmentText.trim()) return { response: fulfillmentText, source: 'dialogflow' };
      const productoNombre = parameters.producto;
      if (!productoNombre) return { response: '¿Qué producto querés comprar?', source: 'dialogflow' };

      const { data, error } = await supabase.from('productos').select('*').eq('tenant_id', tenantId.toString()).eq('nombre', productoNombre);
      if (error) {
        const notifMessage = `Error buscando "${productoNombre}": ${error.message}`;
        if (await shouldNotify(clientNumber, tenantId, notifMessage)) {
          await notifyAdmin(tenantId, clientNumber, notifMessage);
        }
        return { response: 'Hubo un error. Un agente te va a contactar pronto.', source: 'error' };
      } else if (data.length === 0) {
        return { response: `No encontramos "${productoNombre}". ¿Otro producto?`, source: 'dialogflow' };
      } else if (data.length > 1) {
        const opciones = data.map(item => `${item.nombre} - $${item.precio}, ${item.tamano}`).join('\n');
        return { response: `Opciones para ${productoNombre}:\n${opciones}\n¿Qué preferís?`, source: 'dialogflow' };
      } else {
        const producto = data[0];
        const capacidad = estimarCapacidad(producto.tamano);
        return { response: `¡Perfecto! ${producto.nombre} - $${producto.precio}, ${producto.tamano}. ¿Confirmás?`, source: 'dialogflow' };
      }
    } else if (intent === 'Especificar opciones de producto') {
      if (fulfillmentText.trim()) return { response: fulfillmentText, source: 'dialogflow' };

      // Obtener los parámetros de búsqueda para este tenant
      const { data: searchParams, error: searchParamsError } = await supabase
        .from('tenant_search_parameters')
        .select('parameter_name, search_field, exclude_pattern')
        .eq('tenant_id', tenantId)
        .single();

      if (searchParamsError || !searchParams) {
        console.error('Error al obtener parámetros de búsqueda:', searchParamsError?.message || 'No encontrados');
        return { response: 'No puedo buscar productos ahora. Intentá de nuevo más tarde.', source: 'error' };
      }

      const parameterName = searchParams.parameter_name; // Ej. "ingrediente"
      const searchField = searchParams.search_field; // Ej. "descripcion"
      const excludePattern = searchParams.exclude_pattern; // Ej. "%Combo%"

      const searchValues = parameters[parameterName] || [];
      if (!searchValues.length) {
        // Si no hay valores específicos, redirigir a Qwen para que maneje la solicitud
        console.log('Dialogflow no identificó ingredientes específicos, redirigiendo a Qwen...');
        const qwenResponse = await sendToQwen(message, sessionId, { tenantId, from: clientNumber });
        return { response: qwenResponse, source: 'qwen' };
      }

      let query = supabase
        .from('productos')
        .select('*')
        .eq('tenant_id', tenantId.toString())
        .ilike(searchField, `%${searchValues.join('%')}%`);

      if (excludePattern) {
        query = query.neq('nombre', excludePattern);
      }

      const { data, error } = await query;

      if (error) {
        const notifMessage = `Error buscando productos: ${error.message}`;
        if (await shouldNotify(clientNumber, tenantId, notifMessage)) {
          await notifyAdmin(tenantId, clientNumber, notifMessage);
        }
        return { response: 'Hubo un error. Un agente te va a contactar pronto.', source: 'error' };
      } else if (data.length === 0) {
        // Si no se encuentran productos, redirigir a Qwen
        console.log('No se encontraron productos con los criterios, redirigiendo a Qwen...');
        const qwenResponse = await sendToQwen(message, sessionId, { tenantId, from: clientNumber });
        return { response: qwenResponse, source: 'qwen' };
      } else {
        const opciones = data.map(item => `${item.nombre} - $${item.precio}, ${item.tamano}`).join('\n');
        return { response: `Productos disponibles:\n${opciones}\n¿Cuál preferís?`, source: 'dialogflow' };
      }
    } else if (intent === 'Consultar días cerrados') {
      if (fulfillmentText.trim()) return { response: fulfillmentText, source: 'dialogflow' };
      const { data, error } = await supabase.from('dias_cerrados').select('fecha').eq('tenant_id', tenantId.toString());
      if (error) {
        const notifMessage = `Error consultando días cerrados: ${error.message}`;
        if (await shouldNotify(clientNumber, tenantId, notifMessage)) {
          await notifyAdmin(tenantId, clientNumber, notifMessage);
        }
        return { response: 'Hubo un error. Un agente te va a contactar pronto.', source: 'error' };
      }
      return { response: `Días cerrados: ${data.map(item => item.fecha).join(', ')}`, source: 'dialogflow' };
    } else if (intent === 'Consultar horarios') {
      if (fulfillmentText.trim()) return { response: fulfillmentText, source: 'dialogflow' };
      const { data, error } = await supabase.from('horarios').select('dia_semana, hora_apertura, hora_cierre').eq('tenant_id', tenantId.toString());
      if (error) {
        const notifMessage = `Error consultando horarios: ${error.message}`;
        if (await shouldNotify(clientNumber, tenantId, notifMessage)) {
          await notifyAdmin(tenantId, clientNumber, notifMessage);
        }
        return { response: 'Hubo un error. Un agente te va a contactar pronto.', source: 'error' };
      }
      const horariosTexto = data.map(item => `${item.dia_semana}: ${item.hora_apertura} - ${item.hora_cierre}`).join(', ');
      return { response: `Horarios: ${horariosTexto}`, source: 'dialogflow' };
    } else {
      return { response: fulfillmentText || 'No entendí. Intentá de nuevo.', source: 'dialogflow' };
    }
  } catch (error) {
    console.error('Error en Dialogflow:', error.message);
    const notifMessage = `Error general: ${error.message}`;
    if (await shouldNotify(clientNumber, tenantId, notifMessage)) {
      await notifyAdmin(tenantId, clientNumber, notifMessage);
    }
    return { response: 'Hubo un error. Un agente te va a contactar pronto.', source: 'error' };
  }
}

// Funciones auxiliares
function estimarCapacidad(tamano) {
  return tamano || 'No especificado';
}

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
      .single();

    if (notifError && notifError.code !== 'PGRST116') {
      console.error('Error verificando notificaciones:', notifError.message);
      return;
    }

    if (!existing) {
      const sentMessage = await client.sendMessage(`${normalizedAdminNumber}@c.us`, notifMessage);
      dialogflowResponses.add(sentMessage.id._serialized);
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
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error verificando notificación:', error.message);
    return false;
  }
  return !existing;
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
        dialogflowResponses.add(sentMessage.id._serialized);
      }
    }
  }
}

// Handlers
app.get('/', (req, res) => {
  res.send('¡Servidor funcionando!');
});

app.post('/webhook', async (req, res) => {
  const sessionId = req.body.session.split('/').pop();
  let tenantId = 1;
  let whatsappNumber = null;

  if (req.body.originalDetectIntentRequest?.payload?.data?.from) {
    whatsappNumber = req.body.originalDetectIntentRequest.payload.data.from;
  }

  const normalizedNumber = normalizeWhatsappNumber(whatsappNumber);
  if (normalizedNumber === '5491135907587') {
    const { data: tenant } = await supabase
      .from('tenants')
      .select('id')
      .eq('whatsapp_number', normalizedNumber)
      .single();
    tenantId = tenant?.id || 1;
  } else if (normalizedNumber) {
    const { data: lastMessage } = await supabase
      .from('messages')
      .select('tenant_id')
      .eq('from', whatsappNumber)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    tenantId = lastMessage?.tenant_id || 1;
  }

  const result = await sendToDialogflow(
    req.body.queryResult.queryText,
    sessionId,
    { tenantId, from: whatsappNumber }
  );

  res.json({ fulfillmentText: result?.response || '' });
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
    if (dialogflowResponses.has(messageId)) {
      console.log('Ignorando mensaje enviado por Dialogflow o notificación:', message.body);
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
    const result = await sendToDialogflow(message.body, message.from, {
      tenantId,
      from: message.from
    });

    if (result?.response) {
      const sentMessage = await client.sendMessage(message.from, result.response);
      dialogflowResponses.add(sentMessage.id._serialized);
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
          response_source: 'dialogflow',
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
    console.error('Error al procesar mensaje con Dialogflow:', error.message);
  }

  await checkClientTimeout(message.from, tenantId);
});

client.initialize();
app.listen(port, () => {
  console.log(`Servidor en puerto ${port}`);
});
