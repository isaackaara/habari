/**
 * test-oauth-callback.js
 *
 * End-to-end smoke test for the OAuth callback route.
 * Mocks the Gmail token exchange and Prisma DB calls so this runs
 * without real credentials or a live Google auth code.
 *
 * Usage:
 *   node test-oauth-callback.js
 */

require('dotenv').config();

const http = require('http');

// ---------------------------------------------------------------------------
// Module mocks - must be set up before requiring the route
// ---------------------------------------------------------------------------

// Mock prisma
const mockClient = {
  id: 'test-client-id-123',
  name: 'Isaac',
  email: null,
  telegramChatId: '999888777',
  onboardingStep: 'AWAITING_GMAIL',
  gmailTokens: null,
  isActive: false,
  briefingTime: '07:00',
  topics: [],
};

const mockUpdatedClient = {
  ...mockClient,
  gmailTokens: { access_token: 'mock-access', refresh_token: 'mock-refresh', expiry_date: Date.now() + 3600000 },
  email: 'isaac@example.com',
  onboardingStep: 'AWAITING_GMAIL',
};

// Patch Module._cache so subsequent requires get our mocks
const Module = require('module');
const originalLoad = Module._load;

Module._load = function (request, parent, isMain) {
  const resolved = (() => {
    try { return Module._resolveFilename(request, parent, isMain); } catch { return null; }
  })();

  // Intercept prisma
  if (resolved && resolved.includes('src/lib/prisma')) {
    return {
      prisma: {
        client: {
          findUnique: async ({ where }) => {
            console.log('[mock-prisma] findUnique client where:', where);
            if (where.id === mockClient.id) return { ...mockClient };
            return null;
          },
          update: async ({ where, data }) => {
            console.log('[mock-prisma] update client:', { where, data: { ...data, gmailTokens: data.gmailTokens ? '[TOKENS]' : undefined } });
            return { ...mockUpdatedClient, ...data };
          },
        },
      },
    };
  }

  // Intercept gmail service
  if (resolved && resolved.includes('src/services/gmail')) {
    return {
      exchangeCode: async (code) => {
        console.log('[mock-gmail] exchangeCode called with code length:', code?.length);
        if (code === 'bad-code') throw new Error('invalid_grant: code already used');
        return {
          access_token: 'mock-access-token',
          refresh_token: 'mock-refresh-token',
          id_token: 'eyJhbGciOiJSUzI1NiJ9.' + Buffer.from(JSON.stringify({ email: 'isaac@example.com', sub: '12345' })).toString('base64') + '.sig',
          expiry_date: Date.now() + 3600000,
          token_type: 'Bearer',
          scope: 'https://www.googleapis.com/auth/gmail.readonly',
        };
      },
      getAuthUrl: (clientId) => `https://accounts.google.com/mock-auth?state=${clientId}`,
      fetchRecentEmails: async () => [],
      getAuthenticatedClient: async () => ({}),
      createOAuth2Client: () => ({}),
    };
  }

  // Intercept telegram service
  if (resolved && resolved.includes('src/services/telegram')) {
    return {
      notifyGmailConnected: async (chatId, client) => {
        console.log('[mock-telegram] notifyGmailConnected called:', { chatId, clientId: client.id, name: client.name });
      },
      initTelegram: () => console.log('[mock-telegram] initTelegram (noop)'),
      getBot: () => null,
      sendBriefingToChat: async (chatId, content, briefingId) => {
        console.log('[mock-telegram] sendBriefingToChat:', { chatId, briefingId });
      },
    };
  }

  return originalLoad.apply(this, arguments);
};

// Now require the route after mocks are in place
const express = require('express');
const oauthRoutes = require('./src/routes/oauth');

const app = express();
app.use('/oauth', oauthRoutes);

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function makeRequest(path) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, async () => {
      const { port } = server.address();
      const url = `http://localhost:${port}${path}`;
      console.log('\n[test] GET', url);

      http.get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body });
        });
      }).on('error', (err) => {
        server.close();
        reject(err);
      });
    });
  });
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(condition, label, detail = '') {
    if (condition) {
      console.log('  PASS:', label);
      passed++;
    } else {
      console.error('  FAIL:', label, detail);
      failed++;
    }
  }

  // Test 1: Missing params
  console.log('\n=== Test 1: Missing code/state ===');
  const t1 = await makeRequest('/oauth/callback');
  assert(t1.status === 400, 'Returns 400', `got ${t1.status}`);
  assert(t1.body.includes('Missing'), 'Error page shows missing params message');

  // Test 2: Valid flow - happy path
  console.log('\n=== Test 2: Valid code + state (happy path) ===');
  const t2 = await makeRequest(`/oauth/callback?code=valid-auth-code&state=${mockClient.id}`);
  assert(t2.status === 200, 'Returns 200', `got ${t2.status}`);
  assert(t2.body.includes('Gmail Connected'), 'Success page rendered');
  assert(t2.body.includes('Isaac'), 'Shows client name on success page');

  // Test 3: Client not found
  console.log('\n=== Test 3: Unknown clientId ===');
  const t3 = await makeRequest('/oauth/callback?code=valid-code&state=nonexistent-id');
  assert(t3.status === 404, 'Returns 404', `got ${t3.status}`);
  assert(t3.body.includes('Account not found'), 'Shows not found message');

  // Test 4: Bad code (token exchange fails)
  console.log('\n=== Test 4: Bad auth code (exchange fails) ===');
  const t4 = await makeRequest(`/oauth/callback?code=bad-code&state=${mockClient.id}`);
  assert(t4.status === 500, 'Returns 500 on token exchange failure', `got ${t4.status}`);
  assert(t4.body.includes('Failed to exchange'), 'Shows exchange failure message');

  // Test 5: OAuth error from Google
  console.log('\n=== Test 5: Google returns error param ===');
  const t5 = await makeRequest('/oauth/callback?error=access_denied&state=some-id');
  assert(t5.status === 400, 'Returns 400 for Google error', `got ${t5.status}`);
  assert(t5.body.includes('access_denied'), 'Shows Google error message');

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('[test] Uncaught error:', err);
  process.exit(1);
});
