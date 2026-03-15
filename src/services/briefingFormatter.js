/**
 * Briefing Formatter
 *
 * Converts an array of parsed email objects into a formatted Telegram message.
 * Uses Haiku to generate 1-2 sentence summaries per email (batches of 5).
 * Context-aware: uses onboarding metadata to flag stressed/prioritised emails.
 *
 * Email shape expected:
 *   { id, from, subject, date, snippet }
 *
 * Output is Markdown-compatible for Telegram (parse_mode: 'Markdown').
 */

const { summarizeEmailsBatch } = require('../lib/ai');

const MAX_EMAILS_IN_SUMMARY = 15;
const HAIKU_BATCH_SIZE = 5;

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

/**
 * Parse client.metadata (JSON string) into a usable object.
 */
function parseMetadata(client) {
  if (!client.metadata) return {};
  try {
    return JSON.parse(client.metadata);
  } catch {
    return {};
  }
}

/**
 * Build a short context note to pass to Haiku from onboarding metadata.
 */
function buildContextNote(metadata) {
  const parts = [];
  if (metadata.topSenders) parts.push(`Top senders: ${metadata.topSenders}`);
  if (metadata.stressPoints) parts.push(`Stress areas: ${metadata.stressPoints}`);
  if (metadata.excludedTopics && metadata.excludedTopics !== 'none') {
    parts.push(`Skip/low-priority: ${metadata.excludedTopics}`);
  }
  return parts.join('. ');
}

/**
 * Check if an email matches the user's stress keywords.
 * Returns true if the email should be flagged.
 */
function isStressEmail(email, metadata) {
  if (!metadata.stressPoints) return false;
  const stressWords = metadata.stressPoints
    .toLowerCase()
    .split(/[,\s]+/)
    .filter((w) => w.length > 2);
  const combined = `${email.from} ${email.subject} ${email.snippet || ''}`.toLowerCase();
  return stressWords.some((w) => combined.includes(w));
}

/**
 * Check if an email is from a top sender.
 */
function isTopSenderEmail(email, metadata) {
  if (!metadata.topSenders) return false;
  const senderWords = metadata.topSenders
    .toLowerCase()
    .split(/[,\s]+/)
    .filter((w) => w.length > 2);
  const combined = `${email.from} ${email.subject}`.toLowerCase();
  return senderWords.some((w) => combined.includes(w));
}

/**
 * Check if an email matches excluded topics.
 */
function isExcludedEmail(email, metadata) {
  if (!metadata.excludedTopics || metadata.excludedTopics === 'none') return false;
  const excludeWords = metadata.excludedTopics
    .toLowerCase()
    .split(/[,\s]+/)
    .filter((w) => w.length > 2);
  const combined = `${email.from} ${email.subject} ${email.snippet || ''}`.toLowerCase();
  return excludeWords.some((w) => combined.includes(w));
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify an email into a rough topic bucket.
 * Used to group the briefing into sections.
 *
 * @param {object} email
 * @param {string[]} userTopics - user's selected topic preferences
 * @returns {string} topic label
 */
function classifyEmail(email, userTopics = []) {
  const combined = `${email.from} ${email.subject} ${email.snippet}`.toLowerCase();

  const rules = [
    { topic: 'Finance',  patterns: ['invoice', 'payment', 'bank', 'mpesa', 'm-pesa', 'transaction', 'receipt', 'statement', 'budget', 'salary', 'payslip', 'tax', 'kra', 'equity', 'kcb', 'stanchart', 'paypal', 'stripe'] },
    { topic: 'Work',     patterns: ['meeting', 'zoom', 'teams', 'google meet', 'slack', 'jira', 'github', 'pull request', 'review', 'project', 'deadline', 'report', 'proposal', 'contract', 'client', 'sprint'] },
    { topic: 'Travel',   patterns: ['flight', 'booking', 'hotel', 'airbnb', 'reservation', 'itinerary', 'boarding', 'ticket', 'visa', 'travel', 'trip', 'safari'] },
    { topic: 'Shopping', patterns: ['order', 'shipped', 'delivered', 'amazon', 'jumia', 'kilimall', 'cart', 'purchase', 'tracking', 'dispatch'] },
    { topic: 'Health',   patterns: ['appointment', 'doctor', 'hospital', 'clinic', 'prescription', 'test result', 'insurance', 'medical'] },
    { topic: 'Family',   patterns: ['school', 'nursery', 'pta', 'results', 'birthday', 'family'] },
    { topic: 'News',     patterns: ['newsletter', 'weekly digest', 'daily brief', 'breaking', 'update from', 'substack', 'medium'] },
    { topic: 'Events',   patterns: ['invitation', 'rsvp', 'event', 'webinar', 'conference', 'workshop', 'meetup', 'ceremony'] },
  ];

  for (const rule of rules) {
    if (rule.patterns.some((p) => combined.includes(p))) {
      return rule.topic;
    }
  }

  return 'Other';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract sender name from "Name <email>" format.
 */
function senderName(from = '') {
  const match = from.match(/^([^<]+)</);
  if (match) return match[1].trim();
  return from.replace(/<[^>]+>/, '').trim() || from;
}

// ---------------------------------------------------------------------------
// Haiku batch summarizer
// ---------------------------------------------------------------------------

/**
 * Summarize all emails using Haiku, batched in groups of HAIKU_BATCH_SIZE.
 * Falls back to snippet if AI fails.
 *
 * @param {object[]} emails
 * @param {string} contextNote - built from user metadata
 * @returns {Promise<string[]>} array of summaries, same length as emails
 */
async function buildSummaries(emails, contextNote) {
  const summaries = new Array(emails.length);
  let aiAvailable = !!process.env.OPENROUTER_API_KEY;

  if (!aiAvailable) {
    // Fallback: use snippet
    for (let i = 0; i < emails.length; i++) {
      const s = (emails[i].snippet || '').replace(/\s+/g, ' ').trim();
      summaries[i] = s.length > 120 ? s.slice(0, 117) + '...' : s || '(no preview)';
    }
    return summaries;
  }

  // Batch calls
  for (let start = 0; start < emails.length; start += HAIKU_BATCH_SIZE) {
    const batch = emails.slice(start, start + HAIKU_BATCH_SIZE);
    try {
      const batchSummaries = await summarizeEmailsBatch(batch, contextNote);
      for (let j = 0; j < batch.length; j++) {
        summaries[start + j] = batchSummaries[j] || batch[j].snippet || '(no preview)';
      }
    } catch (err) {
      console.error('[briefingFormatter] Haiku batch error:', err.message);
      // Fallback on error
      for (let j = 0; j < batch.length; j++) {
        const s = (batch[j].snippet || '').replace(/\s+/g, ' ').trim();
        summaries[start + j] = s.length > 120 ? s.slice(0, 117) + '...' : s || '(no preview)';
      }
    }
  }

  return summaries;
}

// ---------------------------------------------------------------------------
// Main formatter (async)
// ---------------------------------------------------------------------------

/**
 * Format a single email entry with its Haiku summary.
 */
function formatEmailEntry(email, summary, isStressed, isTopSender) {
  const from = senderName(email.from);
  const subject = email.subject || '(no subject)';
  const flag = isStressed ? ' *!!*' : isTopSender ? ' *>*' : '';

  return [
    `*${subject}*${flag}`,
    `From: ${from}`,
    summary ? `_${summary}_` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Main async formatter function.
 *
 * @param {object[]} emails - array of email objects
 * @param {object} client   - Prisma client record (for name, topics, briefingTime, metadata)
 * @returns {Promise<string>} Telegram-ready Markdown message
 */
async function formatBriefing(emails, client) {
  const name = client.name || 'there';
  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const userTopics = typeof client.topics === 'string'
    ? (() => { try { return JSON.parse(client.topics); } catch { return []; } })()
    : (Array.isArray(client.topics) ? client.topics : []);

  const metadata = parseMetadata(client);
  const contextNote = buildContextNote(metadata);

  const trimmed = emails.slice(0, MAX_EMAILS_IN_SUMMARY);

  // --- Header ---
  const lines = [
    `Good morning, *${name}!* Your Habari briefing for ${today}.`,
    '',
    `${trimmed.length} email${trimmed.length !== 1 ? 's' : ''} in your inbox since yesterday.`,
    '',
  ];

  if (trimmed.length === 0) {
    lines.push('Your inbox is quiet. Nothing new since yesterday.');
    lines.push('');
    lines.push('Have a productive day! /help for commands.');
    return lines.join('\n');
  }

  // --- Generate Haiku summaries ---
  const summaries = await buildSummaries(trimmed, contextNote);

  // --- Group by topic, filtering excluded emails to bottom ---
  const grouped = {};
  const excludedGroup = [];

  for (let i = 0; i < trimmed.length; i++) {
    const email = trimmed[i];
    if (isExcludedEmail(email, metadata)) {
      excludedGroup.push({ email, summary: summaries[i], stressed: false, topSender: false });
      continue;
    }
    const topic = classifyEmail(email, userTopics);
    if (!grouped[topic]) grouped[topic] = [];
    grouped[topic].push({
      email,
      summary: summaries[i],
      stressed: isStressEmail(email, metadata),
      topSender: isTopSenderEmail(email, metadata),
    });
  }

  // Within each group: stressed emails first, then top senders, then rest
  for (const topic of Object.keys(grouped)) {
    grouped[topic].sort((a, b) => {
      if (a.stressed && !b.stressed) return -1;
      if (!a.stressed && b.stressed) return 1;
      if (a.topSender && !b.topSender) return -1;
      if (!a.topSender && b.topSender) return 1;
      return 0;
    });
  }

  // Sort topics: user's preferred first, then standard order, then Other
  const topicOrder = [...userTopics, 'Work', 'Finance', 'Travel', 'Family', 'Shopping', 'News', 'Health', 'Events', 'Other'];
  const sortedTopics = Object.keys(grouped).sort((a, b) => {
    const ai = topicOrder.indexOf(a);
    const bi = topicOrder.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  const topicEmojis = {
    Work: '\u{1F4BC}',
    Finance: '\u{1F4B0}',
    Travel: '\u2708\uFE0F',
    Family: '\u{1F3E0}',
    Shopping: '\u{1F6D2}',
    News: '\u{1F4F0}',
    Health: '\u2764\uFE0F',
    Events: '\u{1F4C5}',
    Other: '\u{1F4E9}',
  };

  for (const topic of sortedTopics) {
    const topicEntries = grouped[topic];
    const emoji = topicEmojis[topic] || '\u{1F4E7}';

    lines.push(`${emoji} *${topic}* (${topicEntries.length})`);
    lines.push('');

    for (const entry of topicEntries) {
      lines.push(formatEmailEntry(entry.email, entry.summary, entry.stressed, entry.topSender));
      lines.push('');
    }
  }

  // Excluded emails shown at bottom as a collapsed note
  if (excludedGroup.length > 0) {
    lines.push(`\u{1F6AB} *Skipped* (${excludedGroup.length}) - matching your excluded topics`);
    lines.push('');
  }

  // Context hint if metadata has stress points
  if (metadata.stressPoints) {
    lines.push(`_Emails marked *!!* match your stress keywords (${metadata.stressPoints})_`);
    lines.push('');
  }

  // --- Footer ---
  lines.push('---');
  lines.push('Use the buttons below or type /briefing for a fresh update.');

  return lines.join('\n');
}

/**
 * Fallback formatter (sync) - used when async path is unavailable.
 */
function formatFallbackBriefing(emails, client) {
  // Sync version without Haiku summaries
  const name = client.name || 'there';
  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const userTopics = typeof client.topics === 'string'
    ? (() => { try { return JSON.parse(client.topics); } catch { return []; } })()
    : (Array.isArray(client.topics) ? client.topics : []);

  const trimmed = emails.slice(0, MAX_EMAILS_IN_SUMMARY);
  const lines = [
    `Good morning, *${name}!* Your Habari briefing for ${today}.`,
    '',
    `${trimmed.length} email${trimmed.length !== 1 ? 's' : ''} in your inbox since yesterday.`,
    '',
  ];

  if (!trimmed.length) {
    lines.push('Your inbox is quiet. Have a productive day!');
    return lines.join('\n');
  }

  const grouped = {};
  for (const email of trimmed) {
    const topic = classifyEmail(email, userTopics);
    if (!grouped[topic]) grouped[topic] = [];
    grouped[topic].push(email);
  }

  for (const [topic, topicEmails] of Object.entries(grouped)) {
    lines.push(`*${topic}* (${topicEmails.length})`);
    for (const email of topicEmails) {
      const from = senderName(email.from);
      const snippet = (email.snippet || '').slice(0, 100);
      lines.push(`*${email.subject || '(no subject)'}*\nFrom: ${from}\n_${snippet}_`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('/briefing for a fresh update.');
  return lines.join('\n');
}

module.exports = { formatBriefing, formatFallbackBriefing, classifyEmail };
