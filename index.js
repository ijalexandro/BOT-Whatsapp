// Importar las librerías necesarias
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, getContentType, extractMessageContent } = require('@whiskeysockets/baileys');
const Boom = require('@hapi/boom');
const { createClient } = require('@supabase/supabase-js');

// Configurar Supabase (usar variables de entorno para seguridad)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Variable global para el socket de WhatsApp
let sock;

/**
 * Inicializa la conexión de WhatsApp y configura los manejadores de eventos.
 */
async function initWhatsApp() {
    try {
        // Estado de autenticación de Baileys (almacenamiento en múltiples archivos)
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: true // Muestra el código QR en la terminal para escanear
            // Puedes agregar logger: P({ level: 'debug' }) si deseas más detalles de Baileys
        });

        // Guardar credenciales actualizadas en disco
        sock.ev.on('creds.update', saveCreds);

        // Manejador de actualización de conexión
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                console.log('⚡ Escanee el código QR para vincular WhatsApp.');
            }
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('❌ Conexión cerrada: se cerró la sesión de WhatsApp. Deberá autenticarse nuevamente.');
                    // No intentamos reconectar automáticamente si las credenciales no son válidas (sesión cerrada).
                } else {
                    console.log('⚠️ Conexión perdida inesperadamente. Intentando reconectar...');
                    initWhatsApp(); // Reconectar si no fue un cierre de sesión manual
                }
            } else if (connection === 'open') {
                console.log('✅ Conexión a WhatsApp establecida exitosamente!');
                if (sock.user) {
                    console.log(`✅ Bot conectado como: ${sock.user.id}`);
                }
            }
        });

        // Manejador de nuevos mensajes entrantes
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            // Solo procesar nuevos mensajes (omitimos historiales u otros tipos)
            if (type !== 'notify') return;
            for (const msg of messages) {
                try {
                    // Ignorar mensajes propios enviados (fromMe) para solo registrar entrantes
                    if (msg.key.fromMe) continue;

                    // Obtener contenido completo del mensaje
                    const fullMessage = msg.message;
                    if (!fullMessage) {
                        // Mensaje sin contenido (puede ser notificación de mensaje eliminado u otro tipo)
                        console.log('📌 Mensaje entrante sin contenido (posible mensaje de protocolo). key:', msg.key);
                        // Aún así, intentamos guardar la información básica en Supabase
                        await supabase.from('MessageLogs').insert({
                            from: msg.key.participant ? msg.key.participant.split('@')[0] : (msg.key.remoteJid ? msg.key.remoteJid.split('@')[0] : null),
                            to: msg.key.remoteJid ? (msg.key.remoteJid.endsWith('@g.us') ? msg.key.remoteJid : (sock.user?.id ? sock.user.id.split('@')[0] : null)) : null,
                            type: 'empty',
                            text: null,
                            message_json: {} // Guardamos un objeto vacío ya que no hay contenido
                        });
                        continue;
                    }

                    // Determinar tipo de mensaje (p. ej. conversation, imageMessage, etc.), incluyendo envoltorios como ephemeral/viewOnce
                    const originalType = getContentType(fullMessage) || 'unknown';
                    const innerContent = extractMessageContent(fullMessage) || fullMessage;
                    const innerType = getContentType(innerContent) || 'unknown';
                    let messageType = innerType;
                    if (originalType !== innerType && (originalType === 'ephemeralMessage' || originalType === 'viewOnceMessage')) {
                        // Indicar en el tipo si era un mensaje efímero o de visualización única
                        messageType = `${innerType} (${originalType === 'ephemeralMessage' ? 'ephemeral' : 'view once'})`;
                    }

                    // Extraer el texto del mensaje, manejando múltiples formas de texto
                    let textContent = null;
                    if (innerContent.conversation) {
                        textContent = innerContent.conversation;
                    } else if (innerContent.extendedTextMessage) {
                        textContent = innerContent.extendedTextMessage.text;
                    } else if (innerContent.imageMessage) {
                        // Texto de imagen (pie de foto)
                        textContent = innerContent.imageMessage.caption || null;
                    } else if (innerContent.videoMessage) {
                        // Texto de video (pie de foto)
                        textContent = innerContent.videoMessage.caption || null;
                    } else if (innerContent.documentMessage) {
                        // Texto de documento (por ejemplo, nombre o pie de foto del archivo)
                        textContent = innerContent.documentMessage.caption || null;
                    } else if (innerContent.buttonsResponseMessage) {
                        // Texto seleccionado de una respuesta de botón
                        textContent = innerContent.buttonsResponseMessage.selectedDisplayText || innerContent.buttonsResponseMessage.selectedButtonId || null;
                    } else if (innerContent.listResponseMessage) {
                        // Texto seleccionado de una respuesta de lista
                        if (innerContent.listResponseMessage.singleSelectReply) {
                            textContent = innerContent.listResponseMessage.singleSelectReply.selectedRowId || innerContent.listResponseMessage.title || null;
                        } else {
                            textContent = innerContent.listResponseMessage.title || null;
                        }
                    } else if (innerContent.templateButtonReplyMessage) {
                        // Texto seleccionado de un botón de plantilla
                        textContent = innerContent.templateButtonReplyMessage.selectedDisplayText || innerContent.templateButtonReplyMessage.selectedId || null;
                    } else if (innerContent.reactionMessage) {
                        // Reacción (emoji)
                        textContent = innerContent.reactionMessage.emoji || innerContent.reactionMessage.text || null;
                    }
                    // (Si se requieren más tipos, se pueden agregar casos similares)

                    // Determinar número de origen (quien envía) y destino (a quién se envía)
                    let from = msg.key.participant || msg.key.remoteJid;  // participante en grupo, o remitente directo
                    let to = msg.key.remoteJid;                           // ID del chat destino (grupo o chat individual)
                    const isGroup = to.endsWith('@g.us');
                    if (from) {
                        from = from.split('@')[0]; // obtener solo el número (sin el dominio @s.whatsapp.net)
                    }
                    if (isGroup) {
                        // Si es un grupo, el destino será el ID del grupo completo
                        // (from ya es el número del participante gracias a lo anterior)
                    } else {
                        // Si es chat individual, `to` realmente es el número del bot (nuestro número)
                        if (sock.user && sock.user.id) {
                            to = sock.user.id;
                        }
                        if (to) {
                            to = to.split('@')[0];
                        }
                    }

                    // Log detallado en la consola para debugging
                    console.log('----------------------------------------');
                    console.log('📥 Nuevo mensaje entrante:');
                    console.log(`→ Origen (de): ${from}`);
                    console.log(`→ Destino (para): ${to}`);
                    console.log(`→ Tipo de mensaje: ${messageType}`);
                    if (textContent) {
                        console.log(`→ Texto: ${textContent}`);
                    } else {
                        console.log('→ Texto: (no determinado o sin texto)');
                    }
                    console.log('→ Objeto de mensaje completo:', JSON.stringify(fullMessage, null, 2));
                    console.log('----------------------------------------');

                    // Guardar los datos en Supabase
                    const { error } = await supabase.from('MessageLogs').insert({
                        from: from || null,
                        to: to || null,
                        type: messageType,
                        text: textContent || null,
                        message_json: fullMessage
                    });
                    if (error) {
                        console.error('❗ Error guardando mensaje en Supabase:', error.message || error);
                    } else {
                        console.log('✅ Mensaje registrado en Supabase correctamente.');
                    }
                } catch (err) {
                    console.error('❗ Error procesando un mensaje entrante:', err);
                }
            }
        });

    } catch (err) {
        console.error('❗ Error inicializando WhatsApp:', err);
    }
}

// Iniciar la conexión al ejecutar el archivo
initWhatsApp();
