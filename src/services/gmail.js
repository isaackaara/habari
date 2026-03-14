const { google } = require('googleapis');
const { prisma } = require('../lib/prisma');

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl(clientId) {
  const oauth2 = createOAuth2Client();
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    state: clientId,
  });
  console.log('[gmail] getAuthUrl called:', {
    clientId,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
    generatedUrl: url,
  });
  return url;
}

async function exchangeCode(code) {
  const oauth2 = createOAuth2Client();
  const { tokens } = await oauth2.getToken(code);
  return tokens;
}

async function getAuthenticatedClient(clientRecord) {
  const oauth2 = createOAuth2Client();
  let tokens = clientRecord.gmailTokens;

  if (!tokens) {
    throw new Error('No Gmail tokens found for this client');
  }

  // gmailTokens is stored as a JSON string in the DB - parse it before use
  if (typeof tokens === 'string') {
    try {
      tokens = JSON.parse(tokens);
    } catch (parseErr) {
      throw new Error('Gmail tokens are corrupted (invalid JSON). Please reconnect Gmail.');
    }
  }

  oauth2.setCredentials(tokens);

  oauth2.on('tokens', async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    try {
      await prisma.client.update({
        where: { id: clientRecord.id },
        data: { gmailTokens: merged },
      });
    } catch (err) {
      console.error('[gmail] Failed to save refreshed tokens:', err.message);
    }
  });

  return oauth2;
}

async function fetchRecentEmails(clientRecord, maxResults = 20) {
  const auth = await getAuthenticatedClient(clientRecord);
  const gmail = google.gmail({ version: 'v1', auth });

  const since = new Date();
  since.setHours(since.getHours() - 24);
  const query = `after:${Math.floor(since.getTime() / 1000)}`;

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults,
  });

  const messageIds = listRes.data.messages || [];
  if (!messageIds.length) return [];

  const emails = [];

  for (const { id } of messageIds) {
    try {
      const msgRes = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });

      const headers = msgRes.data.payload?.headers || [];
      const getHeader = (name) =>
        headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      emails.push({
        id: msgRes.data.id,
        from: getHeader('From'),
        subject: getHeader('Subject'),
        date: getHeader('Date'),
        snippet: msgRes.data.snippet || '',
      });
    } catch (err) {
      console.error(`[gmail] Failed to fetch message ${id}:`, err.message);
    }
  }

  return emails;
}

module.exports = { createOAuth2Client, getAuthUrl, exchangeCode, getAuthenticatedClient, fetchRecentEmails };
