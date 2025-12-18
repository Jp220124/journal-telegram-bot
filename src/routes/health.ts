/**
 * Health check endpoint for monitoring and keep-alive pings
 */

import { Router } from 'express';

const router = Router();

/**
 * GET /health
 * Returns server health status
 * Used by cron-job.org to keep Render service alive
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: 'journal-telegram-bot',
  });
});

/**
 * GET /
 * Root endpoint
 */
router.get('/', (req, res) => {
  res.json({
    name: 'Journal Telegram Bot',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      webhook: '/webhook',
    },
  });
});

export default router;
