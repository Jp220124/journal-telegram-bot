/**
 * Command handlers for Telegram bot
 * Handles /start, /help, /link, etc.
 */

import TelegramBot from 'node-telegram-bot-api';
import { sendMessage, sendMessageWithKeyboard } from '../services/telegram.js';
import { findIntegrationByChatId, verifyTelegramChat, saveMessageHistory } from '../services/supabase.js';

/**
 * Handle /start command
 */
export async function handleStart(msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id.toString();
  const username = msg.from?.username;
  const firstName = msg.from?.first_name || 'there';

  // Check if user is already linked
  const integration = await findIntegrationByChatId(chatId);

  if (integration) {
    await sendMessage(
      chatId,
      `Welcome back, ${firstName}! 👋\n\n` +
        "I'm your Journal Assistant. Here's what I can do:\n\n" +
        '📝 *Add Tasks*\n"Add buy groceries tomorrow"\n\n' +
        '✅ *Complete Tasks*\n"Done with groceries"\n\n' +
        '📋 *View Tasks*\n"What are my tasks?"\n\n' +
        '📓 *Journal*\n"Journal: Had a great day today"\n\n' +
        '📄 *Notes*\n"Create a note about project ideas"\n\n' +
        'Just send me a message and I\'ll understand!'
    );
    return;
  }

  // New user - prompt to link account
  await sendMessage(
    chatId,
    `Hi ${firstName}! 👋\n\n` +
      "I'm your Journal & Todo Assistant. I can help you:\n\n" +
      '• Add tasks via chat or voice\n' +
      '• Log journal entries\n' +
      '• Create and manage notes\n' +
      '• Get reminders when tasks are due\n\n' +
      '*To get started, link your account:*\n\n' +
      '1. Open your Daily Journal web app\n' +
      '2. Go to Settings → Telegram\n' +
      '3. Get your verification code\n' +
      '4. Send it here with `/link YOUR_CODE`\n\n' +
      'Example: `/link 123456`'
  );

  // Log the interaction
  await saveMessageHistory(null, null, 'inbound', 'command', '/start');
}

/**
 * Handle /link command for account verification
 */
export async function handleLink(msg: TelegramBot.Message, code?: string): Promise<void> {
  const chatId = msg.chat.id.toString();
  const username = msg.from?.username;

  if (!code || code.length !== 6) {
    await sendMessage(
      chatId,
      '⚠️ Please provide your 6-digit verification code.\n\n' +
        'Usage: `/link 123456`\n\n' +
        'Get your code from the Daily Journal web app:\n' +
        'Settings → Telegram → Generate Code'
    );
    return;
  }

  // Check if already linked
  const existing = await findIntegrationByChatId(chatId);
  if (existing) {
    await sendMessage(chatId, '✅ Your account is already linked!\n\nJust send me a message to get started.');
    return;
  }

  // Attempt verification
  const result = await verifyTelegramChat(code, chatId, username);

  if (result.success) {
    await sendMessage(
      chatId,
      '🎉 *Account linked successfully!*\n\n' +
        "You're all set! Here's what you can do:\n\n" +
        '📝 *Add a task:* "Add call mom tomorrow at 5pm"\n' +
        '📋 *View tasks:* "What are my tasks?"\n' +
        '✅ *Complete task:* "Done with call mom"\n' +
        '📓 *Journal:* "Journal: Today was productive"\n' +
        '🎤 *Voice:* Just send a voice message!\n\n' +
        "I'll also send you reminders when tasks are due."
    );
  } else {
    await sendMessage(
      chatId,
      `❌ ${result.message}\n\n` +
        'Please check your code and try again.\n' +
        'Codes expire after 10 minutes.'
    );
  }

  await saveMessageHistory(null, result.userId || null, 'inbound', 'command', `/link ${code}`);
}

/**
 * Handle /help command
 */
export async function handleHelp(msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id.toString();

  await sendMessage(
    chatId,
    '*📚 Journal Assistant Help*\n\n' +
      '*Commands:*\n' +
      '/start - Start the bot\n' +
      '/help - Show this help\n' +
      '/link CODE - Link your account\n' +
      '/tasks - Show your tasks\n' +
      '/today - Show today\'s tasks\n' +
      '/mynotes - Show your notes\n' +
      '/newnote - Create a new note\n\n' +
      '*Natural Language:*\n' +
      'Just type naturally! Examples:\n\n' +
      '*Tasks:*\n' +
      '• "Add meeting with John tomorrow 3pm"\n' +
      '• "Remind me to buy milk"\n' +
      '• "High priority: finish report"\n' +
      '• "What do I need to do today?"\n' +
      '• "Done with the report"\n\n' +
      '*Notes:*\n' +
      '• "Create a note about project ideas"\n' +
      '• "Show my notes"\n' +
      '• "Read my note about meeting"\n\n' +
      '*Journal:*\n' +
      '• "Journal: Felt productive today"\n\n' +
      '*Voice Messages:*\n' +
      'Send a voice message and I\'ll transcribe it!\n\n' +
      '*Notifications:*\n' +
      "You'll receive reminders before tasks are due.\n" +
      'Configure in Settings → Telegram'
  );
}

/**
 * Handle /tasks command
 */
export async function handleTasks(msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id.toString();

  const integration = await findIntegrationByChatId(chatId);
  if (!integration) {
    await sendMessage(chatId, 'Please link your account first with /link YOUR_CODE');
    return;
  }

  // Import here to avoid circular dependency
  const { executeQueryTodos } = await import('./message.js');
  await executeQueryTodos(chatId, integration.user_id, { filter: 'pending' });
}

/**
 * Handle /today command
 */
export async function handleToday(msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id.toString();

  const integration = await findIntegrationByChatId(chatId);
  if (!integration) {
    await sendMessage(chatId, 'Please link your account first with /link YOUR_CODE');
    return;
  }

  const { executeQueryTodos } = await import('./message.js');
  await executeQueryTodos(chatId, integration.user_id, { filter: 'today' });
}

/**
 * Handle /unlink command
 */
export async function handleUnlink(msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id.toString();

  await sendMessageWithKeyboard(
    chatId,
    '⚠️ Are you sure you want to unlink your account?\n\n' +
      "You'll stop receiving notifications and won't be able to use the bot until you link again.",
    [
      [
        { text: '✅ Yes, unlink', callback_data: 'confirm_unlink' },
        { text: '❌ Cancel', callback_data: 'cancel_unlink' },
      ],
    ]
  );
}

/**
 * Handle /mynotes command - Show user's notes
 */
export async function handleNotes(msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id.toString();

  const integration = await findIntegrationByChatId(chatId);
  if (!integration) {
    await sendMessage(chatId, 'Please link your account first with /link YOUR_CODE');
    return;
  }

  // Import here to avoid circular dependency
  const { executeQueryNotes } = await import('./message.js');
  const response = await executeQueryNotes(chatId, integration.user_id, {});
  await sendMessage(chatId, response);
}

/**
 * Handle /newnote command - Start creating a new note
 */
export async function handleNewNote(msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id.toString();

  const integration = await findIntegrationByChatId(chatId);
  if (!integration) {
    await sendMessage(chatId, 'Please link your account first with /link YOUR_CODE');
    return;
  }

  // Import here to avoid circular dependency
  const { setState } = await import('../services/conversationState.js');

  // Set state to awaiting note title
  setState(chatId, 'AWAITING_NOTE_TITLE', undefined, undefined, {});

  await sendMessage(
    chatId,
    '📝 *Create a new note*\n\n' +
      'What would you like to name this note?\n\n' +
      '_Send the note title, or /cancel to abort._'
  );
}
