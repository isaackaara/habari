const { prisma } = require('../lib/prisma');
const { sendMessage, jidToPhone, phoneToJid } = require('./whatsapp');
const { getAuthUrl } = require('./gmail');
const { generateBriefing } = require('./briefing');

async function handleIncomingMessage(jid, text) {
  const phone = jidToPhone(jid);
  const lower = text.toLowerCase().trim();

  let client = await prisma.client.findUnique({
    where: { whatsappNumber: phone },
  });

  if (!client) {
    await sendMessage(jid, [
      'Hi there! I don\'t have your number registered yet.',
      '',
      'Ask your operator to register you, or contact support.',
    ].join('\n'));
    return;
  }

  if (lower === 'briefing' || lower === 'brief' || lower === 'update') {
    if (!client.isActive) {
      await sendMessage(jid, 'Your account is not fully set up yet. Please complete Gmail connection first.');
      return;
    }
    await sendMessage(jid, 'Generating your briefing now...');
    try {
      const content = await generateBriefing(client.id);
      await sendMessage(jid, content);
    } catch (err) {
      console.error('[conversation] Briefing error:', err.message);
      await sendMessage(jid, 'Sorry, I could not generate your briefing right now. Please try again later.');
    }
    return;
  }

  if (lower === 'help') {
    await sendMessage(jid, [
      '*Habari Commands*',
      '',
      '*briefing* - Get your email briefing now',
      '*status* - Check your account status',
      '*time HH:MM* - Change your daily briefing time',
      '*help* - Show this message',
    ].join('\n'));
    return;
  }

  if (lower === 'status') {
    const status = client.isActive ? 'Active' : 'Pending setup';
    await sendMessage(jid, [
      `*Your Status*`,
      '',
      `Name: ${client.name || 'Not set'}`,
      `Email: ${client.email || 'Not connected'}`,
      `Briefing time: ${client.briefingTime}`,
      `Status: ${status}`,
    ].join('\n'));
    return;
  }

  if (lower.startsWith('time ')) {
    const time = text.slice(5).trim();
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(time)) {
      await sendMessage(jid, 'Please use format HH:MM (24-hour). Example: *time 07:30*');
      return;
    }
    await prisma.client.update({
      where: { id: client.id },
      data: { briefingTime: time },
    });
    await sendMessage(jid, `Your daily briefing time has been updated to *${time}*.`);
    return;
  }

  switch (client.onboardingStep) {
    case 'START': {
      await prisma.client.update({
        where: { id: client.id },
        data: { onboardingStep: 'AWAITING_NAME' },
      });
      await sendMessage(jid, [
        'Welcome to *Habari*! I\'m your email briefing assistant.',
        '',
        'I\'ll send you a daily WhatsApp summary of your important emails.',
        '',
        'First, what is your name?',
      ].join('\n'));
      return;
    }

    case 'AWAITING_NAME': {
      await prisma.client.update({
        where: { id: client.id },
        data: { name: text, onboardingStep: 'AWAITING_GMAIL' },
      });
      const authUrl = getAuthUrl(client.id);
      await sendMessage(jid, [
        `Nice to meet you, *${text}*!`,
        '',
        'Now let\'s connect your Gmail so I can read your emails.',
        '',
        'Tap this link to sign in with Google:',
        authUrl,
        '',
        'After you sign in, I\'ll confirm the connection.',
      ].join('\n'));
      return;
    }

    case 'AWAITING_GMAIL': {
      if (client.gmailTokens) {
        await prisma.client.update({
          where: { id: client.id },
          data: { onboardingStep: 'COMPLETE', isActive: true },
        });
        await sendMessage(jid, [
          'Your Gmail is already connected!',
          '',
          `I\'ll send your daily briefing at *${client.briefingTime}* every morning.`,
          '',
          'Type *briefing* anytime to get an instant update.',
        ].join('\n'));
        return;
      }
      const authUrl = getAuthUrl(client.id);
      await sendMessage(jid, [
        'I\'m still waiting for your Gmail connection.',
        '',
        'Please tap this link to connect:',
        authUrl,
      ].join('\n'));
      return;
    }

    case 'COMPLETE': {
      await sendMessage(jid, [
        'I\'m not sure what you mean. Try one of these commands:',
        '',
        '*briefing* - Get your email briefing',
        '*status* - Check account status',
        '*time HH:MM* - Change briefing time',
        '*help* - Show all commands',
      ].join('\n'));
      return;
    }

    default: {
      await sendMessage(jid, 'Something went wrong. Type *help* for available commands.');
    }
  }
}

module.exports = { handleIncomingMessage };
