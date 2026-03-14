/**
 * Habari - Multi-tenant AI Email Briefing via Telegram
 *
 * Entry point. Boots DB, Telegram bot, scheduler, and Express server.
 */

require('dotenv').config();
const express = require('express');
const { prisma } = require('./lib/prisma');
const { initTelegram } = require('./services/telegram');
const { initScheduler } = require('./services/scheduler');
const apiRoutes = require('./routes/api');
const oauthRoutes = require('./routes/oauth');

const app = express();
app.use(express.json());

// Routes
app.use('/api', apiRoutes);
app.use('/oauth', oauthRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'habari', transport: 'telegram', version: '2.0.0' });
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Habari</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #e0f2fe 0%, #f0fdf4 100%);
      padding: 20px;
    }
    .card {
      background: white;
      border-radius: 20px;
      padding: 48px 40px;
      max-width: 480px;
      width: 100%;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0,0,0,0.08);
    }
    .logo { font-size: 56px; margin-bottom: 16px; }
    h1 { font-size: 32px; font-weight: 700; color: #111; margin-bottom: 8px; }
    .tagline { color: #64748b; font-size: 16px; margin-bottom: 32px; }
    .status { display: inline-block; background: #dcfce7; color: #16a34a; padding: 6px 16px; border-radius: 999px; font-size: 14px; font-weight: 500; margin-bottom: 32px; }
    .step { display: flex; align-items: flex-start; text-align: left; margin-bottom: 20px; }
    .step-num { background: #0ea5e9; color: white; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; flex-shrink: 0; margin-right: 14px; margin-top: 2px; }
    .step-text { color: #374151; font-size: 15px; line-height: 1.5; }
    .step-text strong { color: #111; }
    .note { margin-top: 32px; font-size: 13px; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">&#x{1F4F0}</div>
    <h1>Habari</h1>
    <p class="tagline">Your personal email briefing, delivered via Telegram.</p>
    <div class="status">&#x2705; Server running</div>
    <div class="step">
      <div class="step-num">1</div>
      <div class="step-text">Find <strong>@YourBotUsername</strong> on Telegram</div>
    </div>
    <div class="step">
      <div class="step-num">2</div>
      <div class="step-text">Send <strong>/start</strong> to begin onboarding</div>
    </div>
    <div class="step">
      <div class="step-num">3</div>
      <div class="step-text">Connect your Gmail and choose your briefing time</div>
    </div>
    <div class="step">
      <div class="step-num">4</div>
      <div class="step-text">Wake up to a smart inbox summary every morning</div>
    </div>
    <p class="note">v2.0.0 &mdash; Telegram transport</p>
  </div>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await prisma.$connect();
    console.log('[habari] Database connected');

    initTelegram();
    console.log('[habari] Telegram bot started');

    await initScheduler();
    console.log('[habari] Scheduler started');

    app.listen(PORT, () => {
      console.log(`[habari] Server running on port ${PORT}`);
      console.log(`[habari] OAuth callback: ${process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/oauth/callback`}`);
    });
  } catch (err) {
    console.error('[habari] Startup failed:', err.message);
    process.exit(1);
  }
}

start();
