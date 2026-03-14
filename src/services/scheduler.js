const { prisma } = require('../lib/prisma');
const { deliverBriefing } = require('./briefing');

// Simple in-process scheduler - no Redis/BullMQ needed
// Checks every minute for clients whose briefing time matches, delivers directly.

async function initScheduler() {
  scheduleCheckLoop();
  console.log('[scheduler] Briefing scheduler initialized (in-process)');
}

function scheduleCheckLoop() {
  setInterval(async () => {
    try {
      await checkAndDeliverBriefings();
    } catch (err) {
      console.error('[scheduler] Check loop error:', err.message);
    }
  }, 60 * 1000);

  checkAndDeliverBriefings().catch((err) => {
    console.error('[scheduler] Initial check error:', err.message);
  });
}

async function checkAndDeliverBriefings() {
  const now = new Date();
  const currentTime = now.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Africa/Nairobi',
  });

  const clients = await prisma.client.findMany({
    where: {
      isActive: true,
      briefingTime: currentTime,
    },
  });

  if (!clients.length) return;

  const today = now.toISOString().split('T')[0];

  for (const client of clients) {
    const existing = await prisma.briefing.findFirst({
      where: {
        clientId: client.id,
        date: today,
      },
    });

    if (existing) continue;

    console.log(`[scheduler] Delivering briefing for ${client.name} (Telegram: ${client.telegramChatId})`);

    // Deliver directly without BullMQ queue
    deliverBriefing(client.id).catch((err) => {
      console.error(`[scheduler] Briefing failed for ${client.id}:`, err.message);
    });
  }
}

module.exports = { initScheduler };
