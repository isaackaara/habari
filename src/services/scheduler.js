const { Queue, Worker } = require('bullmq');
const { connection } = require('../lib/redis');
const { prisma } = require('../lib/prisma');
const { deliverBriefing } = require('./briefing');

const briefingQueue = new Queue('briefings', { connection });

async function initScheduler() {
  const worker = new Worker(
    'briefings',
    async (job) => {
      const { clientId } = job.data;
      console.log(`[scheduler] Processing briefing for client ${clientId}`);
      await deliverBriefing(clientId);
    },
    {
      connection,
      concurrency: 5,
    }
  );

  worker.on('completed', (job) => {
    console.log(`[scheduler] Briefing job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[scheduler] Briefing job ${job?.id} failed:`, err.message);
  });

  scheduleCheckLoop();
  console.log('[scheduler] Briefing scheduler initialized');
}

function scheduleCheckLoop() {
  setInterval(async () => {
    try {
      await checkAndQueueBriefings();
    } catch (err) {
      console.error('[scheduler] Check loop error:', err.message);
    }
  }, 60 * 1000);

  checkAndQueueBriefings().catch((err) => {
    console.error('[scheduler] Initial check error:', err.message);
  });
}

async function checkAndQueueBriefings() {
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

    await briefingQueue.add(
      `briefing-${client.id}`,
      { clientId: client.id },
      {
        jobId: `${client.id}-${today}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 60000 },
      }
    );

    console.log(`[scheduler] Queued briefing for ${client.name} (Telegram: ${client.telegramChatId})`);
  }
}

module.exports = { initScheduler, briefingQueue };
