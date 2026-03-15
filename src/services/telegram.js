/**
 * Habari Telegram Bot Service
 *
 * Handles the full user lifecycle via Telegram:
 *
 *   ONBOARDING FLOW:
 *   /start -> name -> Gmail OAuth -> inbox analysis (Haiku, batched) -> priority question
 *          -> personalized follow-ups -> briefing time -> done
 *
 *   Onboarding states:
 *     AWAITING_NAME          - collecting user's name
 *     AWAITING_GMAIL         - waiting for Gmail OAuth to complete
 *     AWAITING_INBOX_PRIORITY - showing inbox analysis, waiting for Yes/No
 *     AWAITING_PERSONALIZED_Q1 - personalized question 1 (compliance stress, urgent, etc.)
 *     AWAITING_PERSONALIZED_Q2 - personalized question 2 (newsletters, etc.)
 *     AWAITING_CONTEXT_1/2/3 - fallback generic questions (if analysis unavailable)
 *     AWAITING_TIME          - picking briefing time
 *     AWAITING_FEEDBACK      - collecting feedback text
 *     COMPLETE               - fully onboarded
 *
 *   Inbox analysis (stored in Client.metadata.inboxProfile):
 *     ONE Haiku call analyzing all 50 recent emails:
 *     - category distribution (Client, Internal, Compliance, Financial, etc.)
 *     - top 3 senders
 *     - urgent email count
 *     - compliance/newsletter flags
 *     - skip suggestions
 *
 *   Commands:
 *   /briefing  /summary -> on-demand briefing
 *   /status    -> account summary
 *   /pause     -> pause briefings
 *   /resume    -> resume briefings
 *   /topics    -> update inbox context
 *   /time      -> change briefing time
 *   /feedback  -> submit feedback
 *   /help      -> command list
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { prisma } = require('../lib/prisma');
const { getAuthUrl, fetchRecentEmails } = require('./gmail');
const { generateBriefing } = require('./briefing');
const { classifyEmail } = require('./briefingFormatter');
const { analyzeInboxBatch } = require('../lib/ai');

// ---------------------------------------------------------------------------
// Bot singleton
// ---------------------------------------------------------------------------

let bot = null;

// In-memory session store
// chatId -> { selectedTopics: Set<string>, discoveredTopics: [], pendingContext: {} }
const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { selectedTopics: new Set(), discoveredTopics: [], pendingContext: {} });
  }
  return sessions.get(chatId);
}

function clearSession(chatId) {
  sessions.delete(chatId);
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

function parseMetadata(client) {
  if (!client.metadata) return {};
  try { return JSON.parse(client.metadata); } catch { return {}; }
}

async function updateMetadata(clientId, patch) {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  const existing = client?.metadata ? (() => { try { return JSON.parse(client.metadata); } catch { return {}; } })() : {};
  const merged = { ...existing, ...patch };
  await prisma.client.update({
    where: { id: clientId },
    data: { metadata: JSON.stringify(merged) },
  });
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

function buildInboxPriorityKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '\u2705 Yes, prioritize', callback_data: 'inbox:priority:yes' },
        { text: '\u27A1 Skip for now', callback_data: 'inbox:priority:no' },
      ],
    ],
  };
}

function buildYesNoKeyboard(yesData, noData) {
  return {
    inline_keyboard: [
      [
        { text: '\u2705 Yes', callback_data: yesData },
        { text: '\u274C No', callback_data: noData },
      ],
    ],
  };
}

// ---------------------------------------------------------------------------
// Inbox analysis helpers
// ---------------------------------------------------------------------------

/**
 * Format inbox analysis into a Telegram-ready summary message.
 *
 * Example output:
 *   "Your inbox: 30% client (Alice, Bob), 20% KRA compliance, 15% internal, 35% other.
 *    Should I prioritize *Client* emails first?"
 *
 * @param {object} analysis - result from analyzeInboxBatch
 * @returns {{ text: string, topCategory: string }|null}
 */
function formatInboxAnalysisMessage(analysis) {
  if (!analysis || !analysis.categories || !analysis.categories.length) return null;

  const top4 = analysis.categories.slice(0, 4);
  const catParts = top4.map((c) => {
    const senders =
      c.topSenders && c.topSenders.length > 0
        ? ` (${c.topSenders.slice(0, 2).join(', ')})`
        : '';
    return `${c.pct}% ${c.name.toLowerCase()}${senders}`;
  });

  const topCat = top4[0]?.name || 'important';
  const summary = catParts.join(', ');

  const urgentNote =
    analysis.urgentCount > 0 ? ` I also spotted *${analysis.urgentCount} urgent* email${analysis.urgentCount > 1 ? 's' : ''}.` : '';

  const text = [
    '\u{1F4E5} *Your inbox breakdown:*',
    `${summary}.${urgentNote}`,
    '',
    `Should I prioritize *${topCat}* emails at the top of your briefings?`,
  ].join('\n');

  return { text, topCategory: topCat };
}

/**
 * Generate the first personalized question based on inbox analysis.
 * Returns { text, keyboard } or null.
 */
function generatePersonalizedQ1(profile) {
  if (!profile) {
    return {
      text: [
        'What types of emails stress you most?',
        '',
        '_For example: "overdue invoices, client complaints, KRA notices"_',
        '',
        "Type your answer or *none* to skip.",
      ].join('\n'),
      keyboard: null,
    };
  }

  if (profile.hasCompliance) {
    return {
      text: '\u26A0\uFE0F I found *compliance/KRA* emails in your inbox. Do these stress you? I can flag them urgently.',
      keyboard: buildYesNoKeyboard('personalized:compliance:yes', 'personalized:compliance:no'),
    };
  }

  if (profile.urgentCount > 2) {
    return {
      text: `\u{1F6A8} I found *${profile.urgentCount} urgent emails*. Should I always flag urgent emails at the very top of your briefing?`,
      keyboard: buildYesNoKeyboard('personalized:urgent:yes', 'personalized:urgent:no'),
    };
  }

  const topCat = profile.categories && profile.categories[0];
  if (topCat && topCat.pct > 30 && topCat.topSenders && topCat.topSenders.length > 0) {
    const senderList = topCat.topSenders.slice(0, 2).join(' and ');
    return {
      text: `\u{1F4AC} *${senderList}* appear frequently in your inbox. Should I always show their emails first?`,
      keyboard: buildYesNoKeyboard('personalized:topsenders:yes', 'personalized:topsenders:no'),
    };
  }

  // Generic fallback
  return {
    text: [
      'What types of emails stress you most?',
      '',
      '_For example: "overdue invoices, client complaints"_',
      '',
      "Type your answer or *none* to skip.",
    ].join('\n'),
    keyboard: null,
  };
}

/**
 * Generate the second personalized question (newsletters/skip).
 * Returns { text, keyboard } or null if not needed.
 */
function generatePersonalizedQ2(profile) {
  if (!profile || !profile.hasNewsletters) return null;
  return {
    text: '\u{1F4F0} I found newsletters and promotions in your inbox. Should I skip them in your daily briefing?',
    keyboard: buildYesNoKeyboard('personalized:newsletters:yes', 'personalized:newsletters:no'),
  };
}

/**
 * Move to time selection after personalization is done.
 */
async function finalizePersonalizationAndAskTime(chatId, client) {
  await prisma.client.update({
    where: { id: client.id },
    data: { onboardingStep: 'AWAITING_TIME' },
  });

  await bot.sendMessage(
    chatId,
    '\u{1F44D} Got it. Your briefing is personalised.\n\nLast step: what time would you like your daily briefing?',
    { reply_markup: buildTimesKeyboard() }
  );
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

// ---------------------------------------------------------------------------
// Context question handlers (onboarding steps 1-3)
// ---------------------------------------------------------------------------

async function handleContextQ1(chatId, text, client) {
  // Store "topSenders"
  const session = getSession(chatId);
  session.pendingContext.topSenders = text.trim() || 'unspecified';

  await prisma.client.update({
    where: { id: client.id },
    data: { onboardingStep: 'AWAITING_CONTEXT_2' },
  });

  await bot.sendMessage(
    chatId,
    [
      '*Question 2 of 3*',
      '',
      'What types of emails stress you? (e.g. "billing disputes, client complaints, overdue invoices")',
      '',
      '_I will flag these at the top with a warning so you can deal with them first._',
    ].join('\n'),
    { parse_mode: 'Markdown' }
  );
}

async function handleContextQ2(chatId, text, client) {
  const session = getSession(chatId);
  session.pendingContext.stressPoints = text.trim() || 'unspecified';

  await prisma.client.update({
    where: { id: client.id },
    data: { onboardingStep: 'AWAITING_CONTEXT_3' },
  });

  await bot.sendMessage(
    chatId,
    [
      '*Question 3 of 3*',
      '',
      'Any topics or senders you NEVER want in your briefing? (e.g. "newsletters, spam, promotions")',
      '',
      "_Type 'none' to skip._",
    ].join('\n'),
    { parse_mode: 'Markdown' }
  );
}

async function handleContextQ3(chatId, text, client) {
  const session = getSession(chatId);
  session.pendingContext.excludedTopics = text.trim().toLowerCase();

  // Save all context to metadata
  await updateMetadata(client.id, session.pendingContext);

  // Set default topics from context
  const defaultTopics = ['Work', 'Finance', 'Travel'];
  await prisma.client.update({
    where: { id: client.id },
    data: {
      topics: JSON.stringify(defaultTopics),
      onboardingStep: 'AWAITING_TIME',
    },
  });

  await bot.sendMessage(
    chatId,
    [
      '\u{1F44D} Got it. Your briefing is personalised.',
      '',
      'Last step: what time would you like your daily briefing?',
    ].join('\n'),
    {
      parse_mode: 'Markdown',
      reply_markup: buildTimesKeyboard(),
    }
  );
}

// ---------------------------------------------------------------------------
// Inbox analysis onboarding handlers
// ---------------------------------------------------------------------------

/**
 * User tapped "Yes, prioritize" after seeing inbox analysis.
 * Store preference and ask personalized Q1.
 */
async function handleInboxPriorityYes(chatId, callbackQueryId, client) {
  await bot.answerCallbackQuery(callbackQueryId, { text: 'Got it!' });

  const metadata = parseMetadata(client);
  const profile = metadata.inboxProfile;

  await updateMetadata(client.id, { prioritizeTopCategory: true });

  const q1 = generatePersonalizedQ1(profile);

  await prisma.client.update({
    where: { id: client.id },
    data: { onboardingStep: 'AWAITING_PERSONALIZED_Q1' },
  });

  await bot.sendMessage(chatId, q1.text, {
    parse_mode: 'Markdown',
    ...(q1.keyboard ? { reply_markup: q1.keyboard } : {}),
  });
}

/**
 * User tapped "Skip for now" - skip personalization, go straight to time picker.
 */
async function handleInboxPriorityNo(chatId, callbackQueryId, client) {
  await bot.answerCallbackQuery(callbackQueryId, { text: 'No problem!' });
  await finalizePersonalizationAndAskTime(chatId, client);
}

/**
 * Handle personalized callback buttons (compliance, urgent, topsenders, newsletters).
 * Stores answers in metadata and advances to Q2 or time picker.
 */
async function handlePersonalizedCallback(chatId, data, callbackQueryId, client) {
  await bot.answerCallbackQuery(callbackQueryId, { text: 'Saved!' });

  const parts = data.split(':'); // personalized:type:answer
  const type = parts[1];
  const answer = parts[2];

  const metaPatch = {};
  if (type === 'compliance') metaPatch.complianceStress = answer === 'yes';
  if (type === 'urgent') metaPatch.flagUrgent = answer === 'yes';
  if (type === 'topsenders') metaPatch.prioritizeTopSenders = answer === 'yes';
  if (type === 'newsletters') metaPatch.skipNewsletters = answer === 'yes';
  await updateMetadata(client.id, metaPatch);

  const metadata = parseMetadata(await prisma.client.findUnique({ where: { id: client.id } }));
  const profile = metadata.inboxProfile;

  // If Q1 was answered and newsletters haven't been asked yet, ask Q2
  const isQ1Callback = ['compliance', 'urgent', 'topsenders'].includes(type);
  if (isQ1Callback && profile?.hasNewsletters) {
    const q2 = generatePersonalizedQ2(profile);
    if (q2) {
      await prisma.client.update({
        where: { id: client.id },
        data: { onboardingStep: 'AWAITING_PERSONALIZED_Q2' },
      });
      await bot.sendMessage(chatId, q2.text, {
        parse_mode: 'Markdown',
        reply_markup: q2.keyboard,
      });
      return;
    }
  }

  await finalizePersonalizationAndAskTime(chatId, client);
}

/**
 * Handle text response to personalized Q1 (free-text stress points).
 */
async function handlePersonalizedQ1Text(chatId, text, client) {
  if (text.toLowerCase() !== 'none') {
    await updateMetadata(client.id, { stressPoints: text.trim() });
  }

  const metadata = parseMetadata(await prisma.client.findUnique({ where: { id: client.id } }));
  const profile = metadata.inboxProfile;
  const q2 = generatePersonalizedQ2(profile);

  if (q2) {
    await prisma.client.update({
      where: { id: client.id },
      data: { onboardingStep: 'AWAITING_PERSONALIZED_Q2' },
    });
    await bot.sendMessage(chatId, q2.text, {
      parse_mode: 'Markdown',
      reply_markup: q2.keyboard,
    });
  } else {
    await finalizePersonalizationAndAskTime(chatId, client);
  }
}

/**
 * Handle text response to personalized Q2 (free-text exclusions).
 */
async function handlePersonalizedQ2Text(chatId, text, client) {
  if (text.toLowerCase() !== 'none') {
    await updateMetadata(client.id, { excludedTopics: text.trim() });
  }
  await finalizePersonalizationAndAskTime(chatId, client);
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
      '/summary - Same as /briefing',
      '/status - View your account details',
      '/topics - View or update inbox context',
      '/time - Change your briefing time',
      '/pause - Pause daily briefings',
      '/resume - Resume daily briefings',
      '/feedback - Tell us how to improve',
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
// New command handlers
// ---------------------------------------------------------------------------

/**
 * /topics - show current inbox context and offer to update it
 */
async function handleTopicsCommand(chatId, client) {
  if (!client) {
    await bot.sendMessage(chatId, 'No account found. Type /start to register.');
    return;
  }

  const metadata = parseMetadata(client);
  const lines = ['*Your Inbox Context*', ''];

  if (metadata.topSenders) lines.push(`Top senders: ${metadata.topSenders}`);
  if (metadata.stressPoints) lines.push(`Stress areas: ${metadata.stressPoints}`);
  if (metadata.excludedTopics) lines.push(`Excluded: ${metadata.excludedTopics}`);

  if (!metadata.topSenders && !metadata.stressPoints) {
    lines.push("No context set yet. I'll ask a few questions to personalise your briefing.");
  }

  lines.push('');
  lines.push('To update, reply with: /topics update');

  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
}

/**
 * /topics update - restart context questions
 */
async function handleTopicsUpdate(chatId, client) {
  if (!client) {
    await bot.sendMessage(chatId, 'No account found. Type /start to register.');
    return;
  }

  const session = getSession(chatId);
  session.pendingContext = {};

  await prisma.client.update({
    where: { id: client.id },
    data: { onboardingStep: 'AWAITING_CONTEXT_1' },
  });

  await bot.sendMessage(
    chatId,
    [
      "Let's update your inbox context.",
      '',
      '*Question 1 of 3*',
      'Who emails you most? (e.g. "clients, my team, family")',
    ].join('\n'),
    { parse_mode: 'Markdown' }
  );
}

/**
 * /time - change briefing time
 */
async function handleTimeCommand(chatId, client) {
  if (!client) {
    await bot.sendMessage(chatId, 'No account found. Type /start to register.');
    return;
  }

  await bot.sendMessage(
    chatId,
    `Current briefing time: *${client.briefingTime}*\n\nPick a new time:`,
    { parse_mode: 'Markdown', reply_markup: buildTimesKeyboard() }
  );
}

/**
 * /feedback - collect user feedback
 */
async function handleFeedbackCommand(chatId, client) {
  if (!client) {
    await bot.sendMessage(chatId, 'No account found. Type /start to register.');
    return;
  }

  await prisma.client.update({
    where: { id: client.id },
    data: { onboardingStep: 'AWAITING_FEEDBACK' },
  });

  await bot.sendMessage(
    chatId,
    [
      'What would you like to improve about your briefings?',
      '',
      "Type your feedback and I'll log it. Or type 'cancel' to exit.",
    ].join('\n')
  );
}

async function handleFeedbackText(chatId, text, client) {
  if (text.toLowerCase() === 'cancel') {
    await prisma.client.update({ where: { id: client.id }, data: { onboardingStep: 'COMPLETE' } });
    await bot.sendMessage(chatId, 'Feedback cancelled.');
    return;
  }

  // Append feedback to metadata
  const metadata = parseMetadata(client);
  const history = metadata.feedbackHistory || [];
  history.push({ date: new Date().toISOString().split('T')[0], text });
  await updateMetadata(client.id, { feedbackHistory: history.slice(-10) }); // keep last 10

  await prisma.client.update({ where: { id: client.id }, data: { onboardingStep: 'COMPLETE' } });

  await bot.sendMessage(
    chatId,
    '\u{1F64F} Thanks for the feedback! It helps make Habari better.'
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
    await bot.sendMessage(
      chatId,
      [
        'Tap the button below to connect your Gmail.',
        '',
        "Once connected I'll ask a few quick questions to personalise your briefing.",
      ].join('\n'),
      { reply_markup: buildGmailButton(client.id) }
    );
    return;
  }

  if (client.onboardingStep === 'AWAITING_INBOX_PRIORITY') {
    // User typed instead of tapping buttons
    await bot.sendMessage(chatId, 'Please use the buttons above to answer. \u{1F447}');
    return;
  }

  if (client.onboardingStep === 'AWAITING_PERSONALIZED_Q1') {
    await handlePersonalizedQ1Text(chatId, text, client);
    return;
  }

  if (client.onboardingStep === 'AWAITING_PERSONALIZED_Q2') {
    await handlePersonalizedQ2Text(chatId, text, client);
    return;
  }

  if (client.onboardingStep === 'AWAITING_CONTEXT_1') {
    await handleContextQ1(chatId, text, client);
    return;
  }

  if (client.onboardingStep === 'AWAITING_CONTEXT_2') {
    await handleContextQ2(chatId, text, client);
    return;
  }

  if (client.onboardingStep === 'AWAITING_CONTEXT_3') {
    await handleContextQ3(chatId, text, client);
    return;
  }

  if (client.onboardingStep === 'AWAITING_FEEDBACK') {
    await handleFeedbackText(chatId, text, client);
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

  // Inbox analysis onboarding callbacks
  if (data === 'inbox:priority:yes') {
    await handleInboxPriorityYes(chatId, queryId, client);
    return;
  }

  if (data === 'inbox:priority:no') {
    await handleInboxPriorityNo(chatId, queryId, client);
    return;
  }

  if (data.startsWith('personalized:')) {
    await handlePersonalizedCallback(chatId, data, queryId, client);
    return;
  }

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
  bot.onText(/\/summary/, async (msg) => {
    const client = await prisma.client.findUnique({ where: { telegramChatId: String(msg.chat.id) } });
    handleBriefingCommand(msg.chat.id, client).catch((e) =>
      console.error('[telegram] /summary error:', e.message)
    );
  });
  bot.onText(/\/topics update/, async (msg) => {
    const client = await prisma.client.findUnique({ where: { telegramChatId: String(msg.chat.id) } });
    handleTopicsUpdate(msg.chat.id, client).catch((e) =>
      console.error('[telegram] /topics update error:', e.message)
    );
  });
  bot.onText(/\/topics$/, async (msg) => {
    const client = await prisma.client.findUnique({ where: { telegramChatId: String(msg.chat.id) } });
    handleTopicsCommand(msg.chat.id, client).catch((e) =>
      console.error('[telegram] /topics error:', e.message)
    );
  });
  bot.onText(/\/time/, async (msg) => {
    const client = await prisma.client.findUnique({ where: { telegramChatId: String(msg.chat.id) } });
    handleTimeCommand(msg.chat.id, client).catch((e) =>
      console.error('[telegram] /time error:', e.message)
    );
  });
  bot.onText(/\/feedback/, async (msg) => {
    const client = await prisma.client.findUnique({ where: { telegramChatId: String(msg.chat.id) } });
    handleFeedbackCommand(msg.chat.id, client).catch((e) =>
      console.error('[telegram] /feedback error:', e.message)
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
 * New inbox-analysis-first flow:
 *   1. Show "Scanning your inbox..." message
 *   2. Fetch 50 recent emails
 *   3. Call Haiku ONCE (batched) to analyze all 50:
 *      - Category distribution (Client, Internal, Compliance, Financial, etc.)
 *      - Top 3 senders
 *      - Urgent email count
 *      - Compliance/newsletter flags
 *   4. Present findings as formatted message with Yes/No inline buttons
 *   5. If analysis fails, fall back to generic context questions
 *
 * @param {string} chatId
 * @param {object} clientRecord - fresh Prisma client record (has gmailTokens)
 */
async function notifyGmailConnected(chatId, clientRecord) {
  if (!bot) return;

  let thinkingMsg = null;
  try {
    thinkingMsg = await bot.sendMessage(chatId, '\u2705 Gmail connected! Scanning your inbox...');

    // Attempt inbox analysis if AI is available
    let analysis = null;
    if (process.env.OPENROUTER_API_KEY) {
      try {
        console.log('[telegram] Fetching emails for inbox analysis...');
        const emails = await fetchRecentEmails(clientRecord, 50);
        console.log(`[telegram] Fetched ${emails.length} emails for analysis`);

        if (emails.length > 0) {
          console.log('[telegram] Running single Haiku call for inbox analysis...');
          analysis = await analyzeInboxBatch(emails);
          console.log('[telegram] Inbox analysis complete:', JSON.stringify(analysis, null, 2));
        }
      } catch (analysisErr) {
        console.error('[telegram] Inbox analysis failed (will fall back):', analysisErr.message);
      }
    }

    // Delete the "scanning..." message
    if (thinkingMsg) {
      await bot.deleteMessage(chatId, thinkingMsg.message_id).catch(() => {});
      thinkingMsg = null;
    }

    if (analysis && analysis.categories && analysis.categories.length > 0) {
      // Store inbox profile in metadata
      await updateMetadata(clientRecord.id, { inboxProfile: analysis });

      const formatted = formatInboxAnalysisMessage(analysis);

      if (formatted) {
        await prisma.client.update({
          where: { id: clientRecord.id },
          data: { onboardingStep: 'AWAITING_INBOX_PRIORITY' },
        });

        await bot.sendMessage(chatId, formatted.text, {
          parse_mode: 'Markdown',
          reply_markup: buildInboxPriorityKeyboard(),
        });
        return;
      }
    }

    // Fallback: analysis unavailable or empty - use generic context questions
    console.log('[telegram] Falling back to generic context questions');
    await prisma.client.update({
      where: { id: clientRecord.id },
      data: { onboardingStep: 'AWAITING_CONTEXT_1' },
    });

    await bot.sendMessage(
      chatId,
      '\u2705 Gmail connected! A few quick questions to personalise your briefings.'
    );

    await bot.sendMessage(
      chatId,
      [
        '*Question 1 of 3*',
        '',
        'Who emails you most? (e.g. "clients, my team, family")',
        '',
        '_This helps me put the right emails at the top of your briefing._',
      ].join('\n'),
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('[telegram] notifyGmailConnected error:', err.message);
    // Clean up thinking message if still around
    if (thinkingMsg) {
      await bot.deleteMessage(chatId, thinkingMsg.message_id).catch(() => {});
    }
    // Attempt fallback to avoid user being stuck
    try {
      await prisma.client.update({
        where: { id: clientRecord.id },
        data: { onboardingStep: 'AWAITING_CONTEXT_1' },
      });
      await bot.sendMessage(chatId, '\u2705 Gmail connected! Tell me a bit about your inbox to personalise your briefing.');
      await bot.sendMessage(chatId, '*Question 1 of 3*\n\nWho emails you most?', { parse_mode: 'Markdown' });
    } catch (fallbackErr) {
      console.error('[telegram] Fallback also failed:', fallbackErr.message);
    }
  }
}

module.exports = {
  initTelegram,
  getBot,
  sendBriefingToChat,
  notifyGmailConnected,
  extractName,
  analyzeInboxTopics,
  parseMetadata,
  updateMetadata,
};
