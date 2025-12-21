/**
 * Journal Telegram Bot - Main Entry Point
 *
 * Features:
 * - Add todos via chat or voice
 * - Add journal entries
 * - Create and manage notes
 * - Query and complete tasks
 * - Due date reminders
 * - Autonomous research automation
 *
 * Free Stack:
 * - Telegram Bot API (free)
 * - Google Gemini (free tier)
 * - Groq Whisper (free)
 * - Render (free tier)
 */

import express from 'express';
import cors from 'cors';
import { config } from './config/env.js';
import { getBot, setWebhook, deleteWebhook } from './services/telegram.js';
import { startNotificationProcessor } from './services/notifications.js';
import healthRouter from './routes/health.js';
import webhookRouter from './routes/webhook.js';
import researchRouter from './routes/research.js';

// Import handlers
import { handleStart, handleLink, handleHelp, handleTasks, handleToday, handleUnlink, handleNotes, handleNewNote, handleStats, handleInsights } from './handlers/commands.js';
import { handleTextMessage } from './handlers/message.js';
import { handleVoiceMessage } from './handlers/voice.js';
import { verifySupabaseConnection } from './services/supabase.js';

// Research automation imports (conditional)
let startResearchWorker: (() => void) | undefined;
let stopResearchWorker: (() => Promise<void>) | undefined;
let registerResearchHandlers: (() => void) | undefined;
let closeQueue: (() => Promise<void>) | undefined;

// Conditionally import research modules if enabled
if (config.isResearchEnabled) {
  import('./workers/researchWorker.js').then((module) => {
    startResearchWorker = module.startResearchWorker;
    stopResearchWorker = module.stopResearchWorker;
    console.log('✅ Research worker module loaded');
  }).catch((err) => {
    console.error('Failed to load research worker:', err.message);
  });

  import('./handlers/research.js').then((module) => {
    registerResearchHandlers = module.registerResearchHandlers;
    // Register handlers immediately after loading
    if (registerResearchHandlers) {
      registerResearchHandlers();
    }
  }).catch((err) => {
    console.error('Failed to load research handlers:', err.message);
  });

  import('./services/researchQueue.js').then((module) => {
    closeQueue = module.closeQueue;
  }).catch((err) => {
    console.error('Failed to load research queue:', err.message);
  });
}

// Create Express app
const app = express();

// CORS configuration - allow requests from web app
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://claude-journal.priyanshukumarmaurya786.workers.dev',
    'https://claude-journal.pages.dev',
    /\.pages\.dev$/,  // Allow all Cloudflare Pages preview URLs
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// Mount routes
app.use(healthRouter);
app.use(webhookRouter);
app.use(researchRouter);

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
bot.onText(/^\/stats$/, handleStats);
bot.onText(/^\/insights$/, handleInsights);

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
  const researchStatus = config.isResearchEnabled ? 'Enabled' : 'Disabled';
  console.log(`
╔═══════════════════════════════════════════════╗
║     Journal Telegram Bot Started! 🤖          ║
╠═══════════════════════════════════════════════╣
║  Port: ${String(config.port).padEnd(38)}║
║  Mode: ${(config.isProduction ? 'Production (Webhook)' : 'Development (Polling)').padEnd(38)}║
║  Research: ${researchStatus.padEnd(35)}║
╚═══════════════════════════════════════════════╝
  `);

  // Verify Supabase connection on startup
  const supabaseOk = await verifySupabaseConnection();
  if (!supabaseOk) {
    console.error('⚠️ WARNING: Supabase connection verification failed!');
    console.error('Database operations may not work correctly.');
  }

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

  // Start research worker if enabled
  if (config.isResearchEnabled && startResearchWorker) {
    startResearchWorker();
    console.log('🔬 Research worker started');
  }
});

// Graceful shutdown handler
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down...`);

  // Stop research worker and queue if enabled
  if (config.isResearchEnabled) {
    try {
      if (stopResearchWorker) {
        await stopResearchWorker();
        console.log('Research worker stopped');
      }
      if (closeQueue) {
        await closeQueue();
        console.log('Research queue closed');
      }
    } catch (err) {
      console.error('Error stopping research services:', err);
    }
  }

  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });

  // Force exit after 10 seconds if graceful shutdown fails
  setTimeout(() => {
    console.error('Could not close connections in time, forcing shut down');
    process.exit(1);
  }, 10000);
}

// Graceful shutdown
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export { app };
