/**
 * Webhook endpoint for Telegram updates
 */

import { Router, Request, Response } from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { processUpdate } from '../services/telegram.js';

const router = Router();

/**
 * POST /webhook
 * Receives updates from Telegram
 */
router.post('/webhook', (req: Request, res: Response) => {
  try {
    const update = req.body as TelegramBot.Update;

    // Process the update asynchronously
    processUpdate(update);

    // Respond immediately to Telegram
    res.sendStatus(200);
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.sendStatus(500);
  }
});

export default router;
