// Importar las librerías necesarias
const express = require('express');
const bodyParser = require('body-parser');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, getContentType, extractMessageContent, MessageType, MessageMedia } = require('@whiskeysockets/baileys');
const Boom = require('@hapi/boom');
const { createClient } = require('@supabase/supabase-js');

// Configurar Supabase
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
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: true
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) console.log('⚡ Escanee el código QR para vincular WhatsApp.');
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('❌ Sesión cerrada. Escanear QR nuevamente.');
                } else {
                    console.log('⚠️ Conexión perdida. Reconectando...');
                    initWhatsApp();
                }
            } else if (connection === 'open') {
                console.log('✅ Conectado a WhatsApp!');
                if (sock.user) {
                    console.log(`✅ Bot conectado como: ${sock.user.id}`);
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                try {
                    if (msg.key.fromMe) continue;

                    const fullMessage = msg.message;
                    if (!fullMessage) {
                        await supabase.from('MessageLogs').insert({
                            from: msg.key.participant ? msg.key.participant.split('@')[0] : (msg.key.remoteJid ? msg.key.remoteJid.split('@')[0] : null),
                            to: msg.key.remoteJid ? (msg.key.remoteJid.endsWith('@g.us') ? msg.key.remoteJid : (sock.user?.id ? sock.user.id.split('@')[0] : null)) : null,
                            type: 'empty',
                            text: null,
                            message_json: {}
                        });
                        continue;
                    }

                    const originalType = getContentType(fullMessage) || 'unknown';
                    const innerContent = extractMessageContent(fullMessage) || fullMessage;
                    const innerType = getContentType(innerContent) || 'unknown';
                    let messageType = innerType;
                    if (originalType !== innerType && (originalType === 'ephemeralMessage' || originalType === 'viewOnceMessage')) {
                        messageType = `${innerType} (${originalType === 'ephemeralMessage' ? 'ephemeral' : 'view once'})`;
                    }

                    let textContent = null;
                    if (innerContent.conversation) {
                        textContent = innerContent.conversation;
                    } else if (innerContent.extendedTextMessage) {
                        textContent = innerContent.extendedTextMessage.text;
                    } else if (innerContent.imageMessage) {
                        textContent = innerContent.imageMessage.caption || null;
                    } else if (innerContent.videoMessage) {
                        textContent = innerContent.videoMessage.caption || null;
                    } else if (innerContent.documentMessage) {
                        textContent = innerContent.documentMessage.caption || null;
                    } else if (innerContent.buttonsResponseMessage) {
                        textContent = innerContent.buttonsResponseMessage.selectedDisplayText || innerContent.buttonsResponseMessage.selectedButtonId || null;
                    } else if (innerContent.listResponseMessage) {
                        if (innerContent.listResponseMessage.singleSelectReply) {
                            textContent = innerContent.listResponseMessage.singleSelectReply.selectedRowId || innerContent.listResponseMessage.title || null;
                        } else {
                            textContent = innerContent.listResponseMessage.title || null;
                        }
                    } else if (innerContent.templateButtonReplyMessage) {
                        textContent = innerContent.templateButtonReplyMessage.selectedDisplayText || innerContent.templateButtonReplyMessage.selectedId || null;
                    } else if (innerContent.reactionMessage) {
                        textContent = innerContent.reactionMessage.emoji || innerContent.reactionMessage.text || null;
                    }

                    let from = msg.key.participant || msg.key.remoteJid;
                    let to = msg.key.remoteJid;
                    const isGroup = to.endsWith('@g.us');
                    if (from) from = from.split('@')[0];
                    if (isGroup) {
                        // mantener `to` como ID de grupo
                    } else {
                        if (sock.user && sock.user.id) to = sock.user.id;
                        if (to) to = to.split('@')[0];
                    }

                    console.log('----------------------------------------');
                    console.log('📥 Nuevo mensaje entrante:');
                    console.log(`→ De: ${from}`);
                    console.log(`→ Para: ${to}`);
                    console.log(`→ Tipo: ${messageType}`);
                    console.log(`→ Texto: ${textContent || '(sin texto)'}`);
                    console.log('→ Objeto mensaje:', JSON.stringify(fullMessage, null, 2));
                    console.log('----------------------------------------');

                    const { error } = await supabase.from('MessageLogs').insert({
                        from: from || null,
                        to: to || null,
                        type: messageType,
                        text: textContent || null,
                        message_json: fullMessage
                    });

                    if (error) {
                        console.error('❗ Error guardando mensaje:', error.message || error);
                    } else {
                        console.log('✅ Mensaje registrado.');
                    }
                } catch (err) {
                    console.error('❗ Error procesando mensaje:', err);
                }
            }
        });

    } catch (err) {
        console.error('❗ Error inicializando WhatsApp:', err);
    }
}

// Iniciar la conexión a WhatsApp
initWhatsApp();


// 🔥 Servidor Express para recibir imágenes desde n8n
const app = express();
app.use(bodyParser.json());

app.post('/send-media', async (req, res) => {
    const { to, image, caption } = req.body;

    if (!to || !image?.link) {
        return res.status(400).send({ error: 'Faltan parámetros: to o image.link' });
    }

    try {
        const media = await MessageMedia.fromUrl(image.link);
        await sock.sendMessage(`${to}@s.whatsapp.net`, media, { caption });
        res.send({ success: true, message: 'Imagen enviada correctamente' });
    } catch (err) {
        console.error('❗ Error enviando imagen:', err);
        res.status(500).send({ error: 'Error enviando la imagen' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor HTTP escuchando en puerto ${PORT}`);
});
