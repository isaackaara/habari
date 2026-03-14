const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const path = require('path');
const { handleIncomingMessage } = require('./conversation');

let sock = null;
let pairingCode = null;

async function initWhatsApp(phoneNumber) {
  const authDir = path.join(process.cwd(), 'auth_info');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, () => {}),
    },
    printQRInTerminal: false,
    mobile: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('[whatsapp] QR received (scan in WA > Linked Devices):');
      const qrcode = require('qrcode-terminal');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('[whatsapp] Connected successfully');
      pairingCode = null;
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[whatsapp] Connection closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(() => initWhatsApp(), 5000);
      }
    }
  });

  if (phoneNumber && !state.creds.registered) {
    try {
      await new Promise(r => setTimeout(r, 3000));
      const code = await sock.requestPairingCode(phoneNumber);
      pairingCode = code;
      console.log(`[whatsapp] Pairing code for ${phoneNumber}: ${code}`);
      console.log('[whatsapp] Open WhatsApp > Settings > Linked Devices > Link with phone number');
    } catch (err) {
      console.error('[whatsapp] Pairing code error:', err.message);
    }
  }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const from = msg.key.remoteJid;
      if (!from || from === 'status@broadcast') continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';

      if (!text.trim()) continue;

      try {
        await handleIncomingMessage(from, text.trim());
      } catch (err) {
        console.error(`[whatsapp] Error handling message from ${from}:`, err.message);
      }
    }
  });

  return sock;
}

function getSocket() {
  return sock;
}

async function sendMessage(jid, text) {
  if (!sock) {
    console.error('[whatsapp] Socket not initialized');
    return;
  }
  try {
    await sock.sendMessage(jid, { text });
  } catch (err) {
    console.error(`[whatsapp] Failed to send to ${jid}:`, err.message);
  }
}

function phoneToJid(phone) {
  const cleaned = phone.replace(/\+/g, '');
  return `${cleaned}@s.whatsapp.net`;
}

function jidToPhone(jid) {
  const num = jid.replace('@s.whatsapp.net', '');
  return `+${num}`;
}

function getPairingCode() {
  return pairingCode;
}

module.exports = { initWhatsApp, getSocket, sendMessage, phoneToJid, jidToPhone, getPairingCode };
