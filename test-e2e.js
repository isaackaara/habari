/**
 * Habari End-to-End Test (no live Telegram required)
 *
 * Simulates the full flow:
 *   1. Bot /start -> client created in DB
 *   2. User sends name
 *   3. Topic toggle + done
 *   4. Time selection
 *   5. Gmail OAuth URL generated
 *   6. Simulate OAuth callback -> gmailTokens stored
 *   7. Simulate sending a formatted briefing
 *
 * Run: node test-e2e.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { getAuthUrl } = require('./src/services/gmail');
const { formatBriefing } = require('./src/services/briefingFormatter');
const { classifyEmail } = require('./src/services/briefingFormatter');

const prisma = new PrismaClient();

const FAKE_CHAT_ID = 'test-chat-999';

const MOCK_EMAILS = [
  {
    id: 'msg1',
    from: 'Peter Kingoroi <peter@petrus.co.ke>',
    subject: 'Q1 Financial Report - Action Required',
    date: new Date().toISOString(),
    snippet: 'Please review the attached Q1 report and send your comments by Friday COB.',
  },
  {
    id: 'msg2',
    from: 'Kenya Revenue Authority <noreply@kra.go.ke>',
    subject: 'iTax: Return Filing Reminder',
    date: new Date().toISOString(),
    snippet: 'This is a reminder that your income tax return for 2024 is due on 30 June 2025.',
  },
  {
    id: 'msg3',
    from: 'Equity Bank <alerts@equitybank.co.ke>',
    subject: 'Transaction Alert: KES 45,000 Credited',
    date: new Date().toISOString(),
    snippet: 'Your account ending 3421 has been credited with KES 45,000.00 from MPESA.',
  },
  {
    id: 'msg4',
    from: 'Tessa Hunja <tessa@example.com>',
    subject: 'Lamu playdate this Saturday?',
    date: new Date().toISOString(),
    snippet: "Hi love, can we do a playdate with the Nganga kids at Nanyuki Country Club? Let me know if it works.",
  },
  {
    id: 'msg5',
    from: 'GitHub <noreply@github.com>',
    subject: '[uzachapchap] Pull request #42: Add M-Pesa integration',
    date: new Date().toISOString(),
    snippet: 'wanjiru opened a pull request: Add M-Pesa STK push integration for order payments.',
  },
];

async function run() {
  console.log('\n=== Habari E2E Test ===\n');

  // --- Step 1: Clean up previous test data ---
  await prisma.briefing.deleteMany({ where: { client: { telegramChatId: FAKE_CHAT_ID } } });
  await prisma.client.deleteMany({ where: { telegramChatId: FAKE_CHAT_ID } });
  console.log('[1] Cleaned previous test data');

  // --- Step 2: Simulate /start - create tenant + client ---
  let tenant = await prisma.tenant.findFirst();
  if (!tenant) {
    tenant = await prisma.tenant.create({ data: { name: 'Test Tenant' } });
  }

  const client = await prisma.client.create({
    data: {
      tenantId: tenant.id,
      telegramChatId: FAKE_CHAT_ID,
      telegramUsername: 'isaachunja',
      onboardingStep: 'AWAITING_NAME',
    },
  });
  console.log(`[2] /start -> Client created: ${client.id}`);

  // --- Step 3: Simulate name input ---
  const afterName = await prisma.client.update({
    where: { id: client.id },
    data: { name: 'Isaac', onboardingStep: 'AWAITING_TOPICS' },
  });
  console.log(`[3] Name set: ${afterName.name}`);

  // --- Step 4: Simulate topic selection ---
  const selectedTopics = ['Work', 'Finance', 'Family'];
  const afterTopics = await prisma.client.update({
    where: { id: client.id },
    data: { topics: selectedTopics, onboardingStep: 'AWAITING_TIME' },
  });
  console.log(`[4] Topics selected: ${JSON.stringify(afterTopics.topics)}`);

  // --- Step 5: Simulate time selection ---
  const afterTime = await prisma.client.update({
    where: { id: client.id },
    data: { briefingTime: '07:00', onboardingStep: 'AWAITING_GMAIL' },
  });
  console.log(`[5] Briefing time set: ${afterTime.briefingTime}`);

  // --- Step 6: Generate Gmail OAuth URL ---
  const gmailUrl = getAuthUrl(client.id);
  console.log(`[6] Gmail OAuth URL generated (${gmailUrl.length} chars)`);
  console.log(`    Starts with: ${gmailUrl.slice(0, 80)}...`);

  // --- Step 7: Simulate OAuth callback -> store fake tokens ---
  const fakeTokens = {
    access_token: 'ya29.fake_access_token',
    refresh_token: '1//fake_refresh_token_for_testing',
    token_type: 'Bearer',
    expiry_date: Date.now() + 3600 * 1000,
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
  };

  const afterOAuth = await prisma.client.update({
    where: { id: client.id },
    data: {
      gmailTokens: fakeTokens,
      email: 'isaac@kaara.works',
      onboardingStep: 'COMPLETE',
      isActive: true,
    },
  });
  console.log(`[7] OAuth complete -> isActive: ${afterOAuth.isActive}, email: ${afterOAuth.email}`);
  console.log(`    Refresh token stored: ${Boolean(afterOAuth.gmailTokens?.refresh_token)}`);

  // --- Step 8: Test email classification ---
  console.log('\n[8] Testing email classifier:');
  for (const email of MOCK_EMAILS) {
    const topic = classifyEmail(email, selectedTopics);
    console.log(`    "${email.subject.slice(0, 50)}" -> ${topic}`);
  }

  // --- Step 9: Format a full briefing ---
  console.log('\n[9] Formatted briefing output:');
  console.log('----------------------------------------------------');
  const formatted = formatBriefing(MOCK_EMAILS, afterOAuth);
  console.log(formatted);
  console.log('----------------------------------------------------');

  // --- Step 10: Store briefing in DB ---
  const today = new Date().toISOString().split('T')[0];
  const briefing = await prisma.briefing.create({
    data: {
      clientId: client.id,
      date: today,
      emailCount: MOCK_EMAILS.length,
      content: formatted,
      deliveredAt: new Date(),
    },
  });
  console.log(`\n[10] Briefing stored in DB: ${briefing.id}`);

  // --- Step 11: Verify final state ---
  const finalClient = await prisma.client.findUnique({
    where: { id: client.id },
    include: { briefings: true },
  });

  console.log('\n[11] Final client state:');
  console.log(`     name:           ${finalClient.name}`);
  console.log(`     telegramChatId: ${finalClient.telegramChatId}`);
  console.log(`     topics:         ${JSON.stringify(finalClient.topics)}`);
  console.log(`     briefingTime:   ${finalClient.briefingTime}`);
  console.log(`     isActive:       ${finalClient.isActive}`);
  console.log(`     gmailConnected: ${Boolean(finalClient.gmailTokens?.refresh_token)}`);
  console.log(`     briefings:      ${finalClient.briefings.length}`);

  console.log('\n=== ALL TESTS PASSED ===\n');
}

run()
  .catch((err) => {
    console.error('\n[FAIL]', err.message);
    console.error(err.stack);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
