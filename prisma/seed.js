const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { apiKey: 'kaara-test-key-001' },
    update: {},
    create: {
      name: 'Kaara Works',
      apiKey: 'kaara-test-key-001',
    },
  });

  console.log('Created tenant:', tenant.name, '| API key:', tenant.apiKey);
  console.log('Seed complete. Register users via Telegram /start flow.');
}

main()
  .catch((err) => {
    console.error('Seed error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
