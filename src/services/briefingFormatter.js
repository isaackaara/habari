/**
 * Briefing Formatter
 *
 * Converts an array of parsed email objects into a formatted Telegram message.
 * Keeps it readable: header, topic-grouped sections, footer nudge.
 *
 * Email shape expected:
 *   { id, from, subject, date, snippet }
 *
 * Output is Markdown-compatible for Telegram (parse_mode: 'Markdown').
 * No HTML tags - Telegram's Markdown mode is limited, keep it simple.
 */

const MAX_SNIPPET_LENGTH = 100;
const MAX_EMAILS_IN_SUMMARY = 15;

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

/**
 * Truncate text to a max length, appending ellipsis if needed.
 */
function truncate(text, max = MAX_SNIPPET_LENGTH) {
  if (!text) return '';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? cleaned.slice(0, max - 3) + '...' : cleaned;
}

/**
 * Extract sender name from "Name <email>" format.
 */
function senderName(from = '') {
  const match = from.match(/^([^<]+)</);
  if (match) return match[1].trim();
  return from.replace(/<[^>]+>/, '').trim() || from;
}

/**
 * Format a single email as a bullet point.
 */
function formatEmail(email) {
  const from = senderName(email.from);
  const subject = email.subject || '(no subject)';
  const snippet = truncate(email.snippet);

  return [
    `*${subject}*`,
    `From: ${from}`,
    snippet ? `_${snippet}_` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Main formatter function.
 *
 * @param {object[]} emails - array of email objects
 * @param {object} client   - Prisma client record (for name, topics, briefingTime)
 * @returns {string} Telegram-ready Markdown message
 */
function formatBriefing(emails, client) {
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

  // --- Group by topic ---
  const grouped = {};
  for (const email of trimmed) {
    const topic = classifyEmail(email, userTopics);
    if (!grouped[topic]) grouped[topic] = [];
    grouped[topic].push(email);
  }

  // Sort groups: user's preferred topics first, then rest
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
    const topicEmails = grouped[topic];
    const emoji = topicEmojis[topic] || '\u{1F4E7}';

    lines.push(`${emoji} *${topic}* (${topicEmails.length})`);
    lines.push('');

    for (const email of topicEmails) {
      lines.push(formatEmail(email));
      lines.push('');
    }
  }

  // --- Footer ---
  lines.push('---');
  lines.push('Use the buttons below or type /briefing for a fresh update.');

  return lines.join('\n');
}

/**
 * Build an AI-style summary header when AI summarisation is not available.
 * Used as fallback when OpenAI key is missing.
 *
 * @param {object[]} emails
 * @param {object} client
 * @returns {string}
 */
function formatFallbackBriefing(emails, client) {
  return formatBriefing(emails, client);
}

module.exports = { formatBriefing, formatFallbackBriefing, classifyEmail };
