const OpenAI = require('openai');

const ai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
});

async function summarizeEmails(emails, clientName) {
  if (!emails.length) {
    return `No new emails since your last briefing.`;
  }

  const emailList = emails
    .map((e, i) => `${i + 1}. From: ${e.from}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`)
    .join('\n\n');

  const response = await ai.chat.completions.create({
    model: 'anthropic/claude-haiku-4-5',
    messages: [
      {
        role: 'system',
        content: [
          `You are Habari, a friendly email briefing assistant. Summarize these emails for ${clientName}.`,
          'Rules:',
          '- Use WhatsApp formatting: *bold* for emphasis, _italic_ for names',
          '- Keep it concise, 2-3 lines per email max',
          '- Group by priority: urgent first, then important, then FYI',
          '- Use plain language, no jargon',
          '- Never use em dashes or long dashes. Use commas or periods instead.',
          '- End with a friendly one-liner',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `Here are ${emails.length} emails to summarize:\n\n${emailList}`,
      },
    ],
    max_tokens: 1024,
  });

  return response.choices[0].message.content;
}

/**
 * Summarize a batch of up to 5 emails using Haiku.
 * Returns an array of 1-2 sentence summaries in the same order as input.
 *
 * @param {object[]} emails - array of { from, subject, snippet }
 * @param {string} contextNote - optional user context (stressPoints, topSenders)
 * @returns {Promise<string[]>} array of summary strings
 */
async function summarizeEmailsBatch(emails, contextNote = '') {
  if (!emails.length) return [];

  const emailList = emails
    .map((e, i) => `${i + 1}. From: ${e.from}\nSubject: ${e.subject}\nSnippet: ${e.snippet || '(no preview)'}`)
    .join('\n\n');

  const systemLines = [
    'You are Habari, a concise email briefing assistant.',
    'Summarize each email in exactly 1-2 sentences. Be direct and specific.',
    'Return a numbered list matching input order. No extra text, no em dashes.',
    'If an email looks important or urgent, start with "URGENT:".',
  ];
  if (contextNote) systemLines.push(`User context: ${contextNote}`);

  const response = await ai.chat.completions.create({
    model: 'anthropic/claude-haiku-4-5',
    messages: [
      { role: 'system', content: systemLines.join('\n') },
      { role: 'user', content: `Summarize these ${emails.length} email(s):\n\n${emailList}` },
    ],
    max_tokens: 400,
  });

  const raw = response.choices[0].message.content || '';
  const lines = raw
    .split('\n')
    .map((l) => l.replace(/^\d+\.\s*/, '').trim())
    .filter(Boolean);

  // Pad/trim to match input length
  const result = [];
  for (let i = 0; i < emails.length; i++) {
    result.push(lines[i] || `${emails[i].subject} from ${emails[i].from}`);
  }
  return result;
}

/**
 * Analyze up to 50 emails in ONE Haiku call for onboarding inbox profiling.
 *
 * Returns a structured object with:
 *   - categories: [{ name, count, pct, topSenders[] }]
 *   - topSenders: string[] (top 3 display names)
 *   - urgentCount: number
 *   - hasCompliance: boolean (KRA, legal, regulatory)
 *   - hasNewsletters: boolean (marketing, promotions, newsletters)
 *   - skipSuggestions: string[]
 *
 * @param {object[]} emails - array of { from, subject, snippet }
 * @returns {Promise<object|null>} parsed analysis or null on failure
 */
async function analyzeInboxBatch(emails) {
  if (!emails.length) return null;

  const sample = emails.slice(0, 50);
  const emailList = sample
    .map((e, i) => `${i + 1}. From: ${(e.from || 'unknown').slice(0, 60)} | Subject: ${(e.subject || '(no subject)').slice(0, 80)} | Preview: ${(e.snippet || '').slice(0, 80)}`)
    .join('\n');

  const systemPrompt = [
    'You analyze email inboxes and return ONLY valid JSON. No explanation, no markdown, just the JSON object.',
    'Category definitions:',
    '  Client = emails from or about clients, customers, external business contacts',
    '  Internal = team, colleagues, company-internal comms',
    '  Compliance = KRA, government agencies, regulatory bodies, legal notices, tax authorities',
    '  Financial = banks, mobile money, payments, invoices, receipts (excluding KRA)',
    '  Personal = family, friends, personal matters',
    '  Newsletter = marketing, promotions, newsletters, mailing lists, subscriptions',
    '  Other = anything that does not fit above categories',
    'For topSenders: extract the display name (not email address). Pick the 3 most frequent senders.',
    'urgentCount: count emails with urgent/overdue/final notice/deadline/action required in subject or preview.',
    'hasCompliance: true if ANY emails match Compliance category.',
    'hasNewsletters: true if ANY emails match Newsletter category.',
    'skipSuggestions: list category names the user likely wants to skip (Newsletter, Other if dominant).',
  ].join('\n');

  const userPrompt = [
    `Analyze these ${sample.length} emails from a user's inbox:`,
    '',
    emailList,
    '',
    'Return ONLY this JSON structure (fill in real values):',
    JSON.stringify({
      categories: [
        { name: 'Client', count: 0, pct: 0, topSenders: [] },
        { name: 'Internal', count: 0, pct: 0, topSenders: [] },
        { name: 'Compliance', count: 0, pct: 0, topSenders: [] },
        { name: 'Financial', count: 0, pct: 0, topSenders: [] },
        { name: 'Personal', count: 0, pct: 0, topSenders: [] },
        { name: 'Newsletter', count: 0, pct: 0, topSenders: [] },
        { name: 'Other', count: 0, pct: 0, topSenders: [] },
      ],
      topSenders: ['Sender One', 'Sender Two', 'Sender Three'],
      urgentCount: 0,
      hasCompliance: false,
      hasNewsletters: false,
      skipSuggestions: [],
    }),
  ].join('\n');

  try {
    const response = await ai.chat.completions.create({
      model: 'anthropic/claude-haiku-4-5',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 700,
    });

    const raw = (response.choices[0].message.content || '').trim();

    // Extract JSON - handle cases where model wraps in markdown code blocks
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[ai] analyzeInboxBatch: no JSON found in response');
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Normalize: remove zero-count categories, ensure pct totals are sane
    if (parsed.categories) {
      parsed.categories = parsed.categories
        .filter((c) => c.count > 0)
        .map((c) => ({
          ...c,
          pct: Math.round(c.pct),
          topSenders: (c.topSenders || []).slice(0, 3),
        }))
        .sort((a, b) => b.count - a.count);
    }

    return parsed;
  } catch (err) {
    console.error('[ai] analyzeInboxBatch error:', err.message);
    return null;
  }
}

module.exports = { summarizeEmails, summarizeEmailsBatch, analyzeInboxBatch };
