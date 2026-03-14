/**
 * OAuth Routes
 *
 * Handles Google OAuth callback after user completes Gmail consent.
 * Stores refresh token in the Client record and notifies via Telegram.
 */

const { Router } = require('express');
const { prisma } = require('../lib/prisma');
const { exchangeCode } = require('../services/gmail');
const { notifyGmailConnected } = require('../services/telegram');

const router = Router();

router.get('/callback', async (req, res) => {
  const { code, state: clientId, error: oauthError } = req.query;

  console.log('[oauth] Callback received:', {
    hasCode: !!code,
    codeLength: code?.length,
    clientId,
    oauthError: oauthError || null,
    query: req.query,
  });

  // Google may redirect back with an error (e.g. user denied access)
  if (oauthError) {
    console.error('[oauth] Google returned error:', oauthError);
    return res.status(400).send(errorPage(`Google returned an error: ${oauthError}`));
  }

  if (!code || !clientId) {
    console.error('[oauth] Missing params - code:', !!code, 'clientId:', !!clientId);
    return res.status(400).send(errorPage('Missing code or state parameter.'));
  }

  try {
    // Step 1: Client lookup
    console.log('[oauth] Looking up client:', clientId);
    const client = await prisma.client.findUnique({ where: { id: clientId } });

    if (!client) {
      console.error('[oauth] Client not found for id:', clientId);
      return res.status(404).send(errorPage('Account not found. Please restart setup with /start in the bot.'));
    }

    console.log('[oauth] Client found:', {
      id: client.id,
      name: client.name,
      onboardingStep: client.onboardingStep,
      hasChatId: !!client.telegramChatId,
      email: client.email || null,
    });

    // Step 2: Token exchange
    console.log('[oauth] Exchanging authorization code for tokens...');
    let tokens;
    try {
      tokens = await exchangeCode(code);
      console.log('[oauth] Token exchange successful:', {
        hasAccessToken: !!tokens.access_token,
        hasRefreshToken: !!tokens.refresh_token,
        hasIdToken: !!tokens.id_token,
        expiryDate: tokens.expiry_date,
        tokenType: tokens.token_type,
        scope: tokens.scope,
      });
    } catch (tokenErr) {
      console.error('[oauth] Token exchange failed:', tokenErr.message, tokenErr.stack);
      return res.status(500).send(errorPage('Failed to exchange authorization code. Please try again.'));
    }

    // Step 3: Extract email from id_token if not already set
    let email = client.email;
    if (!email && tokens.id_token) {
      try {
        const payload = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64').toString());
        email = payload.email || null;
        console.log('[oauth] Extracted email from id_token:', email);
      } catch (idTokenErr) {
        console.warn('[oauth] Could not parse id_token:', idTokenErr.message);
      }
    }

    // Step 4: Save tokens to DB
    console.log('[oauth] Saving tokens to DB for client:', clientId);
    let updatedClient;
    try {
      updatedClient = await prisma.client.update({
        where: { id: clientId },
        data: {
          gmailTokens: tokens,
          email: email || client.email,
        },
      });
      console.log('[oauth] DB updated successfully:', {
        id: updatedClient.id,
        email: updatedClient.email,
        onboardingStep: updatedClient.onboardingStep,
      });
    } catch (dbErr) {
      console.error('[oauth] DB update failed:', dbErr.message, dbErr.stack);
      return res.status(500).send(errorPage('Failed to save Gmail connection. Please try again.'));
    }

    // Step 5: Notify via Telegram
    if (client.telegramChatId) {
      console.log('[oauth] Notifying Telegram chat:', client.telegramChatId);
      try {
        await notifyGmailConnected(client.telegramChatId, updatedClient);
        console.log('[oauth] Telegram notification sent successfully');
      } catch (tgErr) {
        // Non-fatal: tokens are saved. User can still proceed from Telegram.
        console.error('[oauth] Telegram notification failed (non-fatal):', tgErr.message, tgErr.stack);
      }
    } else {
      console.warn('[oauth] No telegramChatId on client - skipping Telegram notification');
    }

    console.log('[oauth] Callback complete - returning success page for:', client.name || 'unknown');
    return res.send(successPage(client.name || 'there'));

  } catch (err) {
    console.error('[oauth] Unhandled callback error:', err.message, err.stack);
    return res.status(500).send(errorPage('Failed to connect Gmail. Please try again.'));
  }
});

// ---------------------------------------------------------------------------
// HTML page helpers
// ---------------------------------------------------------------------------

function successPage(name) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gmail Connected - Habari</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f0fdf4;
      padding: 20px;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 48px 40px;
      max-width: 440px;
      width: 100%;
      text-align: center;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    }
    .icon { font-size: 64px; margin-bottom: 24px; }
    h1 { font-size: 24px; color: #111; margin-bottom: 12px; }
    p { color: #555; font-size: 16px; line-height: 1.6; margin-bottom: 16px; }
    .highlight { color: #16a34a; font-weight: 600; }
    .close-hint { font-size: 14px; color: #999; margin-top: 24px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#x2705;</div>
    <h1>Gmail Connected!</h1>
    <p>Hi <span class="highlight">${name}</span>, your inbox is now linked to Habari.</p>
    <p>Head back to Telegram to finish setting up your topics and briefing time.</p>
    <p class="close-hint">You can close this window.</p>
  </div>
</body>
</html>`;
}

function errorPage(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Error - Habari</title>
  <style>
    body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #fef2f2; }
    .card { background: white; border-radius: 16px; padding: 48px 40px; max-width: 400px; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .icon { font-size: 64px; margin-bottom: 24px; }
    h1 { color: #dc2626; margin-bottom: 12px; }
    p { color: #555; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#x274C;</div>
    <h1>Something went wrong</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

module.exports = router;
