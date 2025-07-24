const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, getContentType, extractMessageContent } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const qrcode = require('qrcode');
const express = require('express');

// Supabase config
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Web server para mostrar el QR
const app = express();
let qrCodeBase64 = '';

app.get('/qr', (req, res) => {
    if (qrCodeBase64) {
        res.send(`<h2>Escaneá el código QR para vincular WhatsApp</h2><img src="${qrCodeBase64}" />`);
    } else {
        res.send('QR no disponible aún. Esperá unos segundos y recargá.');
    }
});

app.listen(3000, () => {
    console.log('🌐 QR disponible en http://localhost:3000/qr (o tu dominio público)');
});

// WhatsApp
let sock;

async function initWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: true
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('⚡ Escanee el código QR para vincular WhatsApp.');
                qrCodeBase64 = await qrcode.toDataURL(qr);
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('❌ Sesión cerrada. Escaneá el nuevo código QR.');
                } else {
                    console.log('⚠️ Conexión perdida. Reintentando...');
                    initWhatsApp();
                }
            }

            if (connection === 'open') {
                console.log('✅ Conectado a WhatsApp!');
                if (sock.user) console.log(`Bot activo como: ${sock.user.id}`);
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                try {
                    if (msg.key.fromMe) continue;
                    const fullMessage = msg.message;
                    if (!fullMessage) continue;

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

                    await supabase.from('MessageLogs').insert({
                        from: from || null,
                        to: to || null,
                        type: messageType,
                        text: textContent || null,
                        message_json: fullMessage
                    });

                    console.log(`📥 Mensaje de ${from}: ${textContent || '(sin texto)'}`);
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

