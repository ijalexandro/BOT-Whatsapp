const express = require('express');
const qrcode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, getContentType, extractMessageContent } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');

// Configurar Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Inicializar servidor Express
const app = express();
const PORT = process.env.PORT || 3000;

let qrCodeBase64 = '';

app.get('/qr', (req, res) => {
    if (qrCodeBase64) {
        res.send(`<h2>Escaneá el código QR para vincular WhatsApp</h2><img src="${qrCodeBase64}" />`);
    } else {
        res.send('QR no disponible todavía. Esperá unos segundos y recargá.');
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server en puerto ${PORT}`);
});

// Inicializar conexión WhatsApp
let sock;

async function initWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

        sock = makeWASocket({
            auth: state,
            printQRInTerminal: true
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
            if (qr) {
                try {
                    qrCodeBase64 = await qrcode.toDataURL(qr);
                    console.log('⚡ Escaneá el código QR en: /qr');
                } catch (err) {
                    console.error('❌ Error generando QR:', err);
                }
            }

            if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                if (code === DisconnectReason.loggedOut) {
                    console.log('❌ Sesión cerrada. Debe escanear el QR nuevamente.');
                } else {
                    console.log('🔁 Conexión cerrada inesperadamente. Reintentando...');
                    initWhatsApp();
                }
            }

            if (connection === 'open') {
                console.log('✅ WhatsApp conectado');
                if (sock.user) console.log(`🤖 Bot conectado como: ${sock.user.id}`);
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                try {
                    if (msg.key.fromMe) continue;

                    const fullMessage = msg.message;
                    if (!fullMessage) return;

                    const originalType = getContentType(fullMessage) || 'unknown';
                    const innerContent = extractMessageContent(fullMessage) || fullMessage;
                    const innerType = getContentType(innerContent) || 'unknown';
                    let messageType = innerType;

                    if (originalType !== innerType && ['ephemeralMessage', 'viewOnceMessage'].includes(originalType)) {
                        messageType = `${innerType} (${originalType})`;
                    }

                    let textContent = null;
                    if (innerContent.conversation) textContent = innerContent.conversation;
                    else if (innerContent.extendedTextMessage) textContent = innerContent.extendedTextMessage.text;
                    else if (innerContent.imageMessage) textContent = innerContent.imageMessage.caption || null;
                    else if (innerContent.videoMessage) textContent = innerContent.videoMessage.caption || null;
                    else if (innerContent.documentMessage) textContent = innerContent.documentMessage.caption || null;
                    else if (innerContent.buttonsResponseMessage) textContent = innerContent.buttonsResponseMessage.selectedDisplayText || null;
                    else if (innerContent.listResponseMessage?.singleSelectReply) textContent = innerContent.listResponseMessage.singleSelectReply.selectedRowId || null;
                    else if (innerContent.reactionMessage) textContent = innerContent.reactionMessage.emoji || null;

                    let from = msg.key.participant || msg.key.remoteJid;
                    let to = msg.key.remoteJid;
                    const isGroup = to.endsWith('@g.us');
                    from = from?.split('@')[0];
                    if (!isGroup && sock.user?.id) to = sock.user.id.split('@')[0];

                    const { error } = await supabase.from('MessageLogs').insert({
                        from: from || null,
                        to: to || null,
                        type: messageType,
                        text: textContent || null,
                        message_json: fullMessage
                    });

                    if (error) {
                        console.error('❗ Error guardando en Supabase:', error.message);
                    } else {
                        console.log(`📥 Mensaje de ${from}: ${textContent || '(sin texto)'}`);
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

initWhatsApp();
