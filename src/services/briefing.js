/**
 * Briefing Service
 *
 * Generates and delivers email briefings.
 * Pulls emails from Gmail, formats them, stores in DB.
 */

const { prisma } = require('../lib/prisma');
const { fetchRecentEmails } = require('./gmail');
const { formatBriefing } = require('./briefingFormatter');

// NOTE: telegram is required lazily inside deliverBriefing to avoid a circular
// dependency (telegram.js -> briefing.js -> telegram.js). Top-level require here
// would capture an incomplete module export and leave sendBriefingToChat as
// undefined, silently breaking scheduled delivery.
function getTelegram() {
  return require('./telegram');
}

/**
 * Generate a briefing for a client.
 * Returns the formatted content and the new briefing record ID.
 *
 * @param {string} clientId
 * @returns {{ content: string, briefingId: string, emailCount: number }}
 */
async function generateBriefing(clientId) {
  const client = await prisma.client.findUnique({ where: { id: clientId } });

  if (!client) throw new Error('Client not found');
  if (!client.gmailTokens) throw new Error('Gmail not connected');

  const emails = await fetchRecentEmails(client);
  const today = new Date().toISOString().split('T')[0];

  const content = await formatBriefing(emails, client);

  const briefing = await prisma.briefing.create({
    data: {
      clientId: client.id,
      date: today,
      emailCount: emails.length,
      content,
      deliveredAt: new Date(),
    },
  });

  return { content, briefingId: briefing.id, emailCount: emails.length };
}

/**
 * Deliver a scheduled briefing to a client via Telegram.
 *
 * @param {string} clientId
 */
async function deliverBriefing(clientId) {
  try {
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client?.telegramChatId) {
      console.error(`[briefing] No Telegram chat ID for client ${clientId}`);
      return;
    }

    const { content, briefingId } = await generateBriefing(clientId);
    const { sendBriefingToChat } = getTelegram();
    await sendBriefingToChat(client.telegramChatId, content, briefingId);
  } catch (err) {
    console.error(`[briefing] Failed for client ${clientId}:`, err.message);
  }
}

module.exports = { generateBriefing, deliverBriefing };
