/**
 * Telegram service - handles bot API interactions
 */

import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config/env.js';

// Create bot instance
// In development, use polling. In production, use webhook.
const bot = new TelegramBot(config.telegramBotToken, {
  polling: config.isDevelopment,
});

/**
 * Send a text message to a chat
 */
export async function sendMessage(
  chatId: string | number,
  text: string,
  options?: TelegramBot.SendMessageOptions
): Promise<TelegramBot.Message | null> {
  try {
    return await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      ...options,
    });
  } catch (error: unknown) {
    // If Markdown parsing fails, retry without formatting
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes("can't parse entities") || errorMessage.includes('parse')) {
      console.log('[Telegram] Markdown parsing failed, retrying without formatting');
      try {
        // Remove Markdown formatting and send as plain text
        const plainText = text
          .replace(/\*/g, '')      // Remove bold markers
          .replace(/_/g, '')       // Remove italic markers
          .replace(/`/g, '');      // Remove code markers
        return await bot.sendMessage(chatId, plainText, {
          ...options,
          parse_mode: undefined,
        });
      } catch (retryError) {
        console.error('Error sending plain text message:', retryError);
        return null;
      }
    }
    console.error('Error sending message:', error);
    return null;
  }
}

/**
 * Send a message with inline keyboard
 */
export async function sendMessageWithKeyboard(
  chatId: string | number,
  text: string,
  buttons: Array<{ text: string; callback_data: string }[]>
): Promise<TelegramBot.Message | null> {
  return sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: buttons,
    },
  });
}

/**
 * Send a typing indicator
 */
export async function sendTypingAction(chatId: string | number): Promise<void> {
  try {
    await bot.sendChatAction(chatId, 'typing');
  } catch (error) {
    console.error('Error sending typing action:', error);
  }
}

/**
 * Download a voice file from Telegram
 */
export async function downloadVoiceFile(fileId: string): Promise<Buffer | null> {
  try {
    const file = await bot.getFile(fileId);
    if (!file.file_path) return null;

    const fileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
    const response = await fetch(fileUrl);

    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    console.error('Error downloading voice file:', error);
    return null;
  }
}

/**
 * Set up webhook for production
 */
export async function setWebhook(url: string): Promise<boolean> {
  try {
    await bot.setWebHook(`${url}/webhook`);
    console.log(`Webhook set to: ${url}/webhook`);
    return true;
  } catch (error) {
    console.error('Error setting webhook:', error);
    return false;
  }
}

/**
 * Remove webhook (useful for switching to polling)
 */
export async function deleteWebhook(): Promise<boolean> {
  try {
    await bot.deleteWebHook();
    console.log('Webhook deleted');
    return true;
  } catch (error) {
    console.error('Error deleting webhook:', error);
    return false;
  }
}

/**
 * Process webhook update
 */
export function processUpdate(update: TelegramBot.Update): void {
  bot.processUpdate(update);
}

/**
 * Get bot instance for registering handlers
 */
export function getBot(): TelegramBot {
  return bot;
}

/**
 * Format a todo for display
 */
export function formatTodo(todo: { title: string; priority: string; due_date?: string | null; due_time?: string | null }): string {
  const priorityEmoji = {
    high: '🔴',
    medium: '🟡',
    low: '🟢',
  }[todo.priority] || '⚪';

  let text = `${priorityEmoji} ${todo.title}`;

  if (todo.due_date) {
    text += `\n   📅 ${todo.due_date}`;
    if (todo.due_time) {
      text += ` at ${todo.due_time}`;
    }
  }

  return text;
}

/**
 * Format a list of todos for display
 */
export function formatTodoList(todos: Array<{ title: string; priority: string; due_date?: string | null; due_time?: string | null }>): string {
  if (todos.length === 0) {
    return "No tasks found! 🎉";
  }

  return todos.map((todo, index) => `${index + 1}. ${formatTodo(todo)}`).join('\n\n');
}

export { bot };
