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

module.exports = { summarizeEmails };
