/**
 * Habari Telegram Bot Service
 *
 * Handles the full user lifecycle via Telegram:
 *
 *   NEW ONBOARDING FLOW:
 *   /start  -> "Hi there, let me know your name"
 *   user sends name (extracted robustly) -> "Got it, [name]! Let's connect Gmail"
 *   [Gmail OAuth button shown]
 *   OAuth success -> fetch inbox, analyse topics, show % breakdown with checkboxes
 *   user selects topics -> "What time for your briefing?"
 *   user picks time -> all set, confirmed
 *
 *   /briefing  -> on-demand briefing
 *   /status    -> account summary
 *   /help      -> command list
 *   /pause     -> pause daily briefings
 *   /resume    -> resume daily briefings
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { prisma } = require('../lib/prisma');
const { getAuthUrl, fetchRecentEmails } = require('./gmail');
const { generateBriefing } = require('./briefing');
const { classifyEmail } = require('./briefingFormatter');

// ---------------------------------------------------------------------------
// Bot singleton
// ---------------------------------------------------------------------------

let bot = null;

// In-memory session store: chatId -> { selectedTopics: Set<string>, discoveredTopics: {topic: pct}[] }
const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { selectedTopics: new Set(), discoveredTopics: [] });
  }
  return sessions.get(chatId);
}

function clearSession(chatId) {
  sessions.delete(chatId);
}

// ---------------------------------------------------------------------------
// Available config options
// ---------------------------------------------------------------------------

const AVAILABLE_TIMES = [
  ['06:00', '07:00', '07:30'],
  ['08:00', '09:00', '12:00'],
  ['18:00', '20:00', '22:00'],
];

// ---------------------------------------------------------------------------
// Name extraction - robust regex + fallback
// ---------------------------------------------------------------------------

/**
 * Extract a human name from freeform text.
 *
 * Handles patterns like:
 *   "Hi my name is Isaac"       -> "Isaac"
 *   "My name is Isaac Smith"    -> "Isaac Smith"
 *   "I'm Isaac"                 -> "Isaac"
 *   "I am Isaac Hunja"          -> "Isaac Hunja"
 *   "Call me Isaac"             -> "Isaac"
 *   "It's Isaac"                -> "Isaac"
 *   "Isaac"                     -> "Isaac"   (single word, no pattern match)
 *   "Hi, I'm Isaac!"            -> "Isaac"
 *
 * @param {string} text - raw message from user
 * @returns {string|null} extracted name or null
 */
function extractName(text) {
  if (!text) return null;

  const cleaned = text.trim();

  // Ordered patterns - most specific first
  const patterns = [
    // "my name is ..."
    /my name is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
    // "i'm ..." / "i am ..."
    /i['\u2019]?m\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
    /i\s+am\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
    // "call me ..."
    /call me\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
    // "it's ..." / "it is ..."
    /it['\u2019]?s\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
    // "name: ..." or "name - ..."
    /name\s*[:\-]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
    // "hi[,]? [i'm]? ..."  - strip greeting words and grab the rest
    /^(?:hi|hey|hello|yo|hiya)[,!\s]+(?:i['\u2019]?m\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match) {
      return capitalizeWords(match[1].trim());
    }
  }

  // Fallback: if input is 1-3 words that look like a name (no digits, no special chars)
  const words = cleaned.replace(/[^a-zA-Z\s'-]/g, '').trim().split(/\s+/);
  if (words.length >= 1 && words.length <= 3 && words.every((w) => w.length >= 2)) {
    // Check it doesn't look like a sentence fragment (no common English words)
    const stopWords = new Set(['the', 'is', 'it', 'in', 'on', 'at', 'by', 'to', 'for', 'and', 'or', 'but', 'a', 'an', 'ok', 'yes', 'no', 'sure', 'thanks', 'thank', 'please', 'hi', 'hey', 'hello']);
    if (!stopWords.has(words[0].toLowerCase())) {
      return capitalizeWords(words.join(' '));
    }
  }

  return null;
}

function capitalizeWords(str) {
  return str
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// ---------------------------------------------------------------------------
// Topic analysis from inbox
// ---------------------------------------------------------------------------

/**
 * Fetch recent emails and return topic distribution as an array:
 * [ { topic: 'Finance', count: 45, pct: 45 }, ... ]
 * sorted descending by count.
 *
 * @param {object} clientRecord - Prisma client with gmailTokens
 * @returns {Promise<{topic: string, count: number, pct: number}[]>}
 */
async function analyzeInboxTopics(clientRecord) {
  const emails = await fetchRecentEmails(clientRecord, 50);
  if (!emails.length) return [];

  const counts = {};
  for (const email of emails) {
    const topic = classifyEmail(email, []);
    counts[topic] = (counts[topic] || 0) + 1;
  }

  const total = emails.length;
  const distribution = Object.entries(counts)
    .map(([topic, count]) => ({ topic, count, pct: Math.round((count / total) * 100) }))
    .sort((a, b) => b.count - a.count);

  return distribution;
}

// ---------------------------------------------------------------------------
// Keyboard builders
// ---------------------------------------------------------------------------

function buildTopicsKeyboard(selectedTopics, discoveredTopics = []) {
  // Build topic list from discovered + any not found
  const standardTopics = ['Work', 'Finance', 'Travel', 'Family', 'Shopping', 'News', 'Health', 'Events'];

  // Merge discovered topics with standard ones, preserving all
  const discoveredNames = discoveredTopics.map((d) => d.topic);
  const allTopics = [
    ...discoveredNames,
    ...standardTopics.filter((t) => !discoveredNames.includes(t)),
  ];

  const rows = [];
  for (let i = 0; i < allTopics.length; i += 2) {
    const row = [];
    for (let j = i; j < Math.min(i + 2, allTopics.length); j++) {
      const topic = allTopics[j];
      const selected = selectedTopics.has(topic);
      const discovered = discoveredTopics.find((d) => d.topic === topic);
      const label = discovered
        ? `${selected ? '\u2705' : '\u25fb'} ${topic} ${discovered.pct}%`
        : `${selected ? '\u2705' : '\u25fb'} ${topic}`;
      row.push({ text: label, callback_data: `topic:${topic}` });
    }
    rows.push(row);
  }

  rows.push([{ text: 'Done \u2192', callback_data: 'topics:done' }]);
  return { inline_keyboard: rows };
}

function buildTimesKeyboard() {
  const rows = AVAILABLE_TIMES.map((row) =>
    row.map((time) => ({
      text: time,
      callback_data: `time:${time}`,
    }))
  );
  return { inline_keyboard: rows };
}

function buildGmailButton(clientId) {
  console.log('[telegram] buildGmailButton - clientId:', clientId);
  const url = getAuthUrl(clientId);
  console.log('[telegram] Gmail OAuth URL generated:', url);
  return {
    inline_keyboard: [
      [{ text: '\u{1F4E7} Connect Gmail', url }],
      [{ text: '\u2753 Why do you need Gmail access?', callback_data: 'info:gmail' }],
    ],
  };
}

function buildBriefingButtons(briefingId) {
  return {
    inline_keyboard: [
      [
        { text: '\u{1F4CB} View Details', callback_data: `briefing:details:${briefingId}` },
        { text: '\u23F8 Pause Briefings', callback_data: 'briefing:pause' },
      ],
      [{ text: '\u2753 Help', callback_data: 'show:help' }],
    ],
  };
}

// ---------------------------------------------------------------------------
// Core handlers
// ---------------------------------------------------------------------------

async function handleStart(msg) {
  const chatId = msg.chat.id;
  const username = msg.from?.username || null;

  let client = await prisma.client.findUnique({ where: { telegramChatId: String(chatId) } });

  if (client && client.isActive) {
    await bot.sendMessage(
      chatId,
      [
        `Welcome back, *${client.name || 'there'}*! \u{1F44B}`,
        '',
        "You're all set. Your daily briefing arrives at *" + client.briefingTime + '* every morning.',
        '',
        'Commands: /briefing /status /pause /help',
      ].join('\n'),
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // First time: create or reset client record
  if (!client) {
    let tenant = await prisma.tenant.findFirst();
    if (!tenant) {
      tenant = await prisma.tenant.create({ data: { name: 'Default' } });
    }
    client = await prisma.client.create({
      data: {
        tenantId: tenant.id,
        telegramChatId: String(chatId),
        telegramUsername: username,
        onboardingStep: 'AWAITING_NAME',
      },
    });
  } else {
    await prisma.client.update({
      where: { id: client.id },
      data: { onboardingStep: 'AWAITING_NAME', telegramUsername: username },
    });
  }

  clearSession(chatId);

  // New greeting - friendly, minimal
  await bot.sendMessage(
    chatId,
    "Hi there \u{1F44B} Let me know your name and I'll set up your briefing.",
    {}
  );
}

async function handleName(chatId, text, client) {
  const name = extractName(text);

  if (!name || name.length < 2) {
    await bot.sendMessage(
      chatId,
      "I didn't quite catch your name. Try something like \"My name is Isaac\" or just type your name."
    );
    return;
  }

  await prisma.client.update({
    where: { id: client.id },
    data: { name, onboardingStep: 'AWAITING_GMAIL' },
  });

  clearSession(chatId);

  // Confirm name, then immediately prompt Gmail
  await bot.sendMessage(chatId, `Got it, *${name}!* \u{1F44F}`, { parse_mode: 'Markdown' });

  await bot.sendMessage(
    chatId,
    [
      "Let's connect your Gmail so I can read your emails and suggest the best topics for you.",
      '',
      "I only request *read-only* access. I never send emails or share your data.",
    ].join('\n'),
    {
      parse_mode: 'Markdown',
      reply_markup: buildGmailButton(client.id),
    }
  );
}

async function handleTopicToggle(chatId, topic, callbackQueryId, messageId) {
  const session = getSession(chatId);
  if (session.selectedTopics.has(topic)) {
    session.selectedTopics.delete(topic);
  } else {
    session.selectedTopics.add(topic);
  }

  await bot.answerCallbackQuery(callbackQueryId, {
    text: `${topic} ${session.selectedTopics.has(topic) ? 'selected' : 'removed'}`,
  });

  await bot.editMessageReplyMarkup(
    buildTopicsKeyboard(session.selectedTopics, session.discoveredTopics),
    { chat_id: chatId, message_id: messageId }
  );
}

async function handleTopicsDone(chatId, callbackQueryId, client) {
  const session = getSession(chatId);
  const topics = Array.from(session.selectedTopics);

  // If nothing selected, default to top 3 discovered or all
  const finalTopics =
    topics.length > 0
      ? topics
      : session.discoveredTopics.slice(0, 3).map((d) => d.topic);

  await prisma.client.update({
    where: { id: client.id },
    data: {
      topics: JSON.stringify(finalTopics.length > 0 ? finalTopics : ['Work', 'Finance', 'Travel']),
      onboardingStep: 'AWAITING_TIME',
    },
  });

  await bot.answerCallbackQuery(callbackQueryId, { text: 'Topics saved!' });

  await bot.sendMessage(
    chatId,
    "What time would you like your daily briefing?",
    { reply_markup: buildTimesKeyboard() }
  );
}

async function handleTimeSelect(chatId, time, callbackQueryId, client) {
  await prisma.client.update({
    where: { id: client.id },
    data: {
      briefingTime: time,
      onboardingStep: 'COMPLETE',
      isActive: true,
    },
  });

  clearSession(chatId);

  await bot.answerCallbackQuery(callbackQueryId, { text: `Briefing time set to ${time}` });

  await bot.sendMessage(
    chatId,
    [
      `\u2705 *All set, ${client.name || 'there'}!*`,
      '',
      `Your daily briefing will arrive at *${time}* every morning.`,
      '',
      'Type /briefing anytime for an instant summary.',
      'Type /help to see all commands.',
    ].join('\n'),
    { parse_mode: 'Markdown' }
  );
}

async function handleGmailInfoQuery(callbackQueryId) {
  await bot.answerCallbackQuery(callbackQueryId, {
    text: 'Habari uses read-only Gmail access to summarise your emails. We never send emails or share your data.',
    show_alert: true,
  });
}

async function handleBriefingCommand(chatId, client) {
  if (!client?.isActive || !client?.gmailTokens) {
    await bot.sendMessage(
      chatId,
      [
        "Your Gmail isn't connected yet.",
        '',
        'Complete setup with /start to activate your briefings.',
      ].join('\n')
    );
    return;
  }

  const thinking = await bot.sendMessage(chatId, '\u23F3 Fetching your inbox...');

  try {
    const { content, briefingId } = await generateBriefing(client.id);
    await bot.deleteMessage(chatId, thinking.message_id).catch(() => {});
    await bot.sendMessage(chatId, content, {
      parse_mode: 'Markdown',
      reply_markup: buildBriefingButtons(briefingId),
    });
  } catch (err) {
    await bot.deleteMessage(chatId, thinking.message_id).catch(() => {});
    console.error('[telegram] Briefing error:', err.message);
    await bot.sendMessage(
      chatId,
      'Could not generate your briefing right now. Please try again in a moment.'
    );
  }
}

async function handleStatusCommand(chatId, client) {
  if (!client) {
    await bot.sendMessage(chatId, 'No account found. Type /start to get set up.');
    return;
  }

  const parsedTopics = typeof client.topics === 'string' ? (() => { try { return JSON.parse(client.topics); } catch { return []; } })() : (client.topics || []);
  const topics = parsedTopics.length > 0 ? parsedTopics.join(', ') : 'All topics';
  const status = client.isActive ? '\u2705 Active' : '\u23F3 Pending setup';

  await bot.sendMessage(
    chatId,
    [
      '*Your Habari Account*',
      '',
      `Name: ${client.name || 'Not set'}`,
      `Email: ${client.email || 'Not connected'}`,
      `Topics: ${topics}`,
      `Briefing time: ${client.briefingTime}`,
      `Status: ${status}`,
    ].join('\n'),
    { parse_mode: 'Markdown' }
  );
}

async function handleHelpCommand(chatId) {
  await bot.sendMessage(
    chatId,
    [
      '*Habari Commands*',
      '',
      '/briefing - Get your email briefing now',
      '/status - View your account details',
      '/pause - Pause daily briefings',
      '/resume - Resume daily briefings',
      '/start - Re-run setup',
      '/help - Show this message',
    ].join('\n'),
    { parse_mode: 'Markdown' }
  );
}

async function handlePauseCommand(chatId, client) {
  if (!client) {
    await bot.sendMessage(chatId, 'No account found. Type /start to register.');
    return;
  }
  await prisma.client.update({ where: { id: client.id }, data: { isActive: false } });
  await bot.sendMessage(chatId, '\u23F8 Daily briefings paused. Type /resume to turn them back on.');
}

async function handleResumeCommand(chatId, client) {
  if (!client) {
    await bot.sendMessage(chatId, 'No account found. Type /start to register.');
    return;
  }
  if (!client.gmailTokens) {
    await bot.sendMessage(
      chatId,
      "Gmail isn't connected yet. Complete setup with /start first.",
      { reply_markup: buildGmailButton(client.id) }
    );
    return;
  }
  await prisma.client.update({ where: { id: client.id }, data: { isActive: true } });
  await bot.sendMessage(
    chatId,
    `\u25B6\uFE0F Briefings resumed. Next one at *${client.briefingTime}*.`,
    { parse_mode: 'Markdown' }
  );
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

async function routeMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (!text) return;
  if (text.startsWith('/')) return;

  const client = await prisma.client.findUnique({
    where: { telegramChatId: String(chatId) },
  });

  if (!client) {
    await bot.sendMessage(chatId, 'Type /start to get set up with Habari.');
    return;
  }

  if (client.onboardingStep === 'AWAITING_NAME') {
    await handleName(chatId, text, client);
    return;
  }

  if (client.onboardingStep === 'AWAITING_GMAIL') {
    // Nudge them to click the button
    await bot.sendMessage(
      chatId,
      [
        'Tap the button below to connect your Gmail.',
        '',
        "Once connected I'll analyse your inbox and suggest topics for you.",
      ].join('\n'),
      { reply_markup: buildGmailButton(client.id) }
    );
    return;
  }

  if (!client.isActive) {
    await bot.sendMessage(chatId, "I'm still setting you up. Type /start to continue.");
    return;
  }

  // Active user - treat as help request
  await handleHelpCommand(chatId);
}

// ---------------------------------------------------------------------------
// Callback query router
// ---------------------------------------------------------------------------

async function routeCallbackQuery(query) {
  const chatId = query.message.chat.id;
  const data = query.data;
  const messageId = query.message.message_id;
  const queryId = query.id;

  const client = await prisma.client.findUnique({
    where: { telegramChatId: String(chatId) },
  });

  if (data.startsWith('topic:')) {
    const topic = data.slice(6);
    await handleTopicToggle(chatId, topic, queryId, messageId);
    return;
  }

  if (data === 'topics:done') {
    await handleTopicsDone(chatId, queryId, client);
    return;
  }

  if (data.startsWith('time:')) {
    const time = data.slice(5);
    await handleTimeSelect(chatId, time, queryId, client);
    return;
  }

  if (data === 'info:gmail') {
    await handleGmailInfoQuery(queryId);
    return;
  }

  if (data === 'briefing:pause') {
    await handlePauseCommand(chatId, client);
    await bot.answerCallbackQuery(queryId, { text: 'Briefings paused.' });
    return;
  }

  if (data === 'show:help') {
    await handleHelpCommand(chatId);
    await bot.answerCallbackQuery(queryId);
    return;
  }

  if (data.startsWith('briefing:details:')) {
    await bot.answerCallbackQuery(queryId, {
      text: 'Full detail view coming soon!',
      show_alert: false,
    });
    return;
  }

  await bot.answerCallbackQuery(queryId);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function initTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set in environment');
  }

  bot = new TelegramBot(token, { polling: true });

  console.log('[telegram] Bot initialised (polling mode)');

  bot.onText(/\/start/, (msg) =>
    handleStart(msg).catch((e) => console.error('[telegram] /start error:', e.message))
  );
  bot.onText(/\/briefing/, async (msg) => {
    const client = await prisma.client.findUnique({ where: { telegramChatId: String(msg.chat.id) } });
    handleBriefingCommand(msg.chat.id, client).catch((e) =>
      console.error('[telegram] /briefing error:', e.message)
    );
  });
  bot.onText(/\/status/, async (msg) => {
    const client = await prisma.client.findUnique({ where: { telegramChatId: String(msg.chat.id) } });
    handleStatusCommand(msg.chat.id, client).catch((e) =>
      console.error('[telegram] /status error:', e.message)
    );
  });
  bot.onText(/\/help/, (msg) =>
    handleHelpCommand(msg.chat.id).catch((e) => console.error('[telegram] /help error:', e.message))
  );
  bot.onText(/\/pause/, async (msg) => {
    const client = await prisma.client.findUnique({ where: { telegramChatId: String(msg.chat.id) } });
    handlePauseCommand(msg.chat.id, client).catch((e) =>
      console.error('[telegram] /pause error:', e.message)
    );
  });
  bot.onText(/\/resume/, async (msg) => {
    const client = await prisma.client.findUnique({ where: { telegramChatId: String(msg.chat.id) } });
    handleResumeCommand(msg.chat.id, client).catch((e) =>
      console.error('[telegram] /resume error:', e.message)
    );
  });

  bot.on('message', (msg) =>
    routeMessage(msg).catch((e) => console.error('[telegram] message error:', e.message))
  );
  bot.on('callback_query', (query) =>
    routeCallbackQuery(query).catch((e) => console.error('[telegram] callback error:', e.message))
  );
  bot.on('polling_error', (err) => console.error('[telegram] Polling error:', err.message));

  return bot;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

function getBot() {
  return bot;
}

/**
 * Send a formatted briefing to a specific chat.
 */
async function sendBriefingToChat(chatId, content, briefingId) {
  if (!bot) {
    console.error('[telegram] Bot not initialised - cannot send briefing');
    return;
  }
  try {
    await bot.sendMessage(chatId, content, {
      parse_mode: 'Markdown',
      reply_markup: buildBriefingButtons(briefingId),
    });
  } catch (err) {
    console.error(`[telegram] Failed to send briefing to ${chatId}:`, err.message);
  }
}

/**
 * Called by the OAuth callback route after Gmail token exchange.
 *
 * New flow:
 *   1. Acknowledge Gmail connection
 *   2. Fetch inbox + analyse topics
 *   3. Show topic breakdown with checkboxes
 *
 * @param {string} chatId
 * @param {object} clientRecord - fresh Prisma client record (has gmailTokens)
 */
async function notifyGmailConnected(chatId, clientRecord) {
  if (!bot) return;

  try {
    await bot.sendMessage(chatId, '\u2705 Gmail connected! Analysing your inbox...');

    // Fetch and analyse
    let distribution = [];
    try {
      distribution = await analyzeInboxTopics(clientRecord);
    } catch (err) {
      console.error('[telegram] Inbox analysis error:', err.message);
    }

    // Store discovered topics in session
    const session = getSession(chatId);
    session.discoveredTopics = distribution;

    // Pre-select top 3 topics
    session.selectedTopics = new Set(distribution.slice(0, 3).map((d) => d.topic));

    // Build the discovery message
    let discoveryText;
    if (distribution.length > 0) {
      const topicList = distribution
        .map((d) => `${d.topic} (${d.pct}%)`)
        .join(', ');
      discoveryText = [
        `I found these topics in your inbox: *${topicList}*`,
        '',
        'Which matter most to you? Tap to toggle, then hit Done.',
      ].join('\n');
    } else {
      discoveryText = [
        "I couldn't find many emails yet. Pick the topics that matter to you and I'll watch for them.",
        '',
        'Tap to toggle, then hit Done.',
      ].join('\n');
    }

    // Update onboarding step
    await prisma.client.update({
      where: { id: clientRecord.id },
      data: { onboardingStep: 'AWAITING_TOPICS' },
    });

    await bot.sendMessage(chatId, discoveryText, {
      parse_mode: 'Markdown',
      reply_markup: buildTopicsKeyboard(session.selectedTopics, distribution),
    });
  } catch (err) {
    console.error('[telegram] Failed to send Gmail confirmation:', err.message);
  }
}

module.exports = {
  initTelegram,
  getBot,
  sendBriefingToChat,
  notifyGmailConnected,
  extractName,
  analyzeInboxTopics,
};
