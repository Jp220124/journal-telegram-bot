/**
 * Journal Telegram Bot - Main Entry Point
 *
 * Features:
 * - Add todos via chat or voice
 * - Add journal entries
 * - Create and manage notes
 * - Query and complete tasks
 * - Due date reminders
 *
 * Free Stack:
 * - Telegram Bot API (free)
 * - Google Gemini (free tier)
 * - Groq Whisper (free)
 * - Render (free tier)
 */

import express from 'express';
import { config } from './config/env.js';
import { getBot, setWebhook, deleteWebhook } from './services/telegram.js';
import { startNotificationProcessor } from './services/notifications.js';
import healthRouter from './routes/health.js';
import webhookRouter from './routes/webhook.js';

// Import handlers
import { handleStart, handleLink, handleHelp, handleTasks, handleToday, handleUnlink, handleNotes, handleNewNote } from './handlers/commands.js';
import { handleTextMessage } from './handlers/message.js';
import { handleVoiceMessage } from './handlers/voice.js';

// Create Express app
const app = express();
app.use(express.json());

// Mount routes
app.use(healthRouter);
app.use(webhookRouter);

// Get the bot instance
const bot = getBot();

// Register command handlers
bot.onText(/^\/start$/, handleStart);
bot.onText(/^\/help$/, handleHelp);
bot.onText(/^\/link\s+(\d{6})$/, (msg, match) => {
  handleLink(msg, match?.[1]);
});
bot.onText(/^\/link$/, (msg) => handleLink(msg));
bot.onText(/^\/tasks$/, handleTasks);
bot.onText(/^\/today$/, handleToday);
bot.onText(/^\/unlink$/, handleUnlink);
bot.onText(/^\/mynotes$/, handleNotes);
bot.onText(/^\/newnote$/, handleNewNote);

// Handle text messages (non-commands)
bot.on('message', async (msg) => {
  // Skip if it's a command (starts with /)
  if (msg.text?.startsWith('/')) return;

  // Skip if it's a voice message (handled separately)
  if (msg.voice) return;

  // Handle text message
  if (msg.text) {
    await handleTextMessage(msg);
  }
});

// Handle voice messages
bot.on('voice', handleVoiceMessage);

// Handle callback queries (inline keyboard buttons)
bot.on('callback_query', async (query) => {
  const chatId = query.message?.chat.id;
  if (!chatId) return;

  switch (query.data) {
    case 'confirm_unlink':
      // TODO: Implement unlink functionality
      await bot.answerCallbackQuery(query.id, { text: 'Account unlinked!' });
      await bot.sendMessage(chatId, '✅ Your account has been unlinked.\n\nUse /link to connect again.');
      break;

    case 'cancel_unlink':
      await bot.answerCallbackQuery(query.id, { text: 'Cancelled' });
      await bot.sendMessage(chatId, '👍 Action cancelled. Your account is still linked.');
      break;

    default:
      await bot.answerCallbackQuery(query.id);
  }

  // Remove inline keyboard
  if (query.message) {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId,
      message_id: query.message.message_id,
    });
  }
});

// Error handling for bot polling errors
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message);
});

// Start server
const server = app.listen(config.port, async () => {
  console.log(`
╔═══════════════════════════════════════════════╗
║     Journal Telegram Bot Started! 🤖          ║
╠═══════════════════════════════════════════════╣
║  Port: ${String(config.port).padEnd(38)}║
║  Mode: ${(config.isProduction ? 'Production (Webhook)' : 'Development (Polling)').padEnd(38)}║
╚═══════════════════════════════════════════════╝
  `);

  // Set up webhook in production
  if (config.isProduction && config.webhookUrl) {
    await deleteWebhook(); // Clear any existing webhook first
    await setWebhook(config.webhookUrl);
    console.log(`Webhook URL: ${config.webhookUrl}/webhook`);
  } else {
    console.log('Running in polling mode (development)');
  }

  // Start notification processor
  startNotificationProcessor(60000); // Check every minute
  console.log('Notification processor started');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

export { app };
