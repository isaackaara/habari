/**
 * Habari REST API
 *
 * Tenant-scoped endpoints for managing clients and triggering briefings.
 * Authentication via X-API-Key header.
 */

const { Router } = require('express');
const { prisma } = require('../lib/prisma');

const router = Router();

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

async function authMiddleware(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing x-api-key header' });
  }

  const tenant = await prisma.tenant.findUnique({ where: { apiKey } });
  if (!tenant) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  req.tenant = tenant;
  next();
}

router.use(authMiddleware);

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

// List all clients for this tenant
router.get('/clients', async (req, res) => {
  try {
    const clients = await prisma.client.findMany({
      where: { tenantId: req.tenant.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json(clients);
  } catch (err) {
    console.error('[api] List clients error:', err.message);
    res.status(500).json({ error: 'Failed to list clients' });
  }
});

// Get a single client with recent briefings
router.get('/clients/:id', async (req, res) => {
  try {
    const client = await prisma.client.findFirst({
      where: { id: req.params.id, tenantId: req.tenant.id },
      include: {
        briefings: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
    });

    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json(client);
  } catch (err) {
    console.error('[api] Get client error:', err.message);
    res.status(500).json({ error: 'Failed to get client' });
  }
});

// Update client preferences
router.patch('/clients/:id', async (req, res) => {
  try {
    const { name, briefingTime, timezone, isActive, topics } = req.body;

    const existing = await prisma.client.findFirst({
      where: { id: req.params.id, tenantId: req.tenant.id },
    });

    if (!existing) return res.status(404).json({ error: 'Client not found' });

    const data = {};
    if (name !== undefined) data.name = name;
    if (briefingTime !== undefined) data.briefingTime = briefingTime;
    if (timezone !== undefined) data.timezone = timezone;
    if (isActive !== undefined) data.isActive = isActive;
    if (topics !== undefined) data.topics = topics;

    const client = await prisma.client.update({ where: { id: req.params.id }, data });
    res.json(client);
  } catch (err) {
    console.error('[api] Update client error:', err.message);
    res.status(500).json({ error: 'Failed to update client' });
  }
});

// Delete a client and their briefings
router.delete('/clients/:id', async (req, res) => {
  try {
    const existing = await prisma.client.findFirst({
      where: { id: req.params.id, tenantId: req.tenant.id },
    });

    if (!existing) return res.status(404).json({ error: 'Client not found' });

    await prisma.briefing.deleteMany({ where: { clientId: req.params.id } });
    await prisma.client.delete({ where: { id: req.params.id } });

    res.json({ deleted: true });
  } catch (err) {
    console.error('[api] Delete client error:', err.message);
    res.status(500).json({ error: 'Failed to delete client' });
  }
});

// ---------------------------------------------------------------------------
// Briefings
// ---------------------------------------------------------------------------

// Manually trigger a briefing for a client
router.post('/clients/:id/briefing', async (req, res) => {
  try {
    const client = await prisma.client.findFirst({
      where: { id: req.params.id, tenantId: req.tenant.id },
    });

    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!client.isActive) return res.status(400).json({ error: 'Client is not active' });
    if (!client.gmailTokens) return res.status(400).json({ error: 'Gmail not connected for this client' });

    const { deliverBriefing } = require('../services/briefing');
    await deliverBriefing(client.id);

    res.json({ message: 'Briefing triggered', clientId: client.id });
  } catch (err) {
    console.error('[api] Trigger briefing error:', err.message);
    res.status(500).json({ error: 'Failed to trigger briefing' });
  }
});

// ---------------------------------------------------------------------------
// Tenant
// ---------------------------------------------------------------------------

router.get('/tenant', (req, res) => {
  res.json({
    id: req.tenant.id,
    name: req.tenant.name,
    createdAt: req.tenant.createdAt,
  });
});

module.exports = router;
