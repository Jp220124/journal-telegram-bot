/**
 * Message handler - processes incoming text messages
 */

import TelegramBot from 'node-telegram-bot-api';
import { sendMessage, sendTypingAction, formatTodoList } from '../services/telegram.js';
import { parseIntent, ParsedIntent } from '../services/gemini.js';
import {
  findIntegrationByChatId,
  getUserTodos,
  addTodo,
  markTodoComplete,
  addJournalContent,
  saveMessageHistory,
  getRecentMessages,
} from '../services/supabase.js';

/**
 * Handle incoming text message
 */
export async function handleTextMessage(msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id.toString();
  const text = msg.text?.trim();

  if (!text) return;

  // Check if user is linked
  const integration = await findIntegrationByChatId(chatId);
  if (!integration) {
    await sendMessage(
      chatId,
      "You haven't linked your account yet!\n\n" +
        'Use `/link YOUR_CODE` with the code from your Daily Journal app.'
    );
    return;
  }

  const startTime = Date.now();

  // Show typing indicator
  await sendTypingAction(chatId);

  // Get recent messages for context
  const recentMessages = await getRecentMessages(integration.user_id, 5);
  const context: Array<{ role: 'user' | 'assistant'; content: string }> = recentMessages.map((m) => ({
    role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: m.original_content || m.transcription || '',
  }));

  // Parse intent using Gemini
  const intent = await parseIntent(text, context);

  // Execute the appropriate action
  let response: string;
  try {
    response = await executeIntent(chatId, integration.user_id, intent);
  } catch (error) {
    console.error('Error executing intent:', error);
    response = "Sorry, I couldn't complete that action. Please try again.";
  }

  // Send response
  await sendMessage(chatId, response);

  // Save to message history
  const processingTime = Date.now() - startTime;
  await saveMessageHistory(integration.id, integration.user_id, 'inbound', 'text', text, {
    aiIntent: intent.intent,
    aiResponse: response,
    processingTimeMs: processingTime,
  });
}

/**
 * Execute parsed intent
 */
export async function executeIntent(chatId: string, userId: string, intent: ParsedIntent): Promise<string> {
  switch (intent.intent) {
    case 'add_todo':
      return executeAddTodo(chatId, userId, intent.parameters);

    case 'query_todos':
      return executeQueryTodos(chatId, userId, intent.parameters);

    case 'mark_complete':
      return executeMarkComplete(chatId, userId, intent.parameters);

    case 'add_journal':
      return executeAddJournal(chatId, userId, intent.parameters);

    case 'general_chat':
    default:
      return intent.parameters.response || "I'm not sure how to help with that.";
  }
}

/**
 * Execute add_todo intent
 */
async function executeAddTodo(
  chatId: string,
  userId: string,
  params: Record<string, string | undefined>
): Promise<string> {
  const title = params.title;
  if (!title) {
    return "I couldn't understand what task to add. Please try again.";
  }

  const todo = await addTodo(userId, title, {
    priority: (params.priority as 'low' | 'medium' | 'high') || 'medium',
    due_date: params.due_date,
    due_time: params.due_time,
    category: params.category,
  });

  if (!todo) {
    return '❌ Failed to add task. Please try again.';
  }

  let response = `✅ Task added: *${todo.title}*`;

  if (todo.priority !== 'medium') {
    const priorityEmoji = { high: '🔴', low: '🟢' }[todo.priority] || '';
    response += `\n${priorityEmoji} Priority: ${todo.priority}`;
  }

  if (todo.due_date) {
    response += `\n📅 Due: ${todo.due_date}`;
    if (todo.due_time) {
      response += ` at ${todo.due_time}`;
    }
  }

  if (todo.due_date && todo.due_time) {
    response += "\n\n⏰ I'll remind you when it's due!";
  }

  return response;
}

/**
 * Execute query_todos intent
 */
export async function executeQueryTodos(
  chatId: string,
  userId: string,
  params: Record<string, string | undefined>
): Promise<string> {
  const filter = (params.filter as 'today' | 'pending' | 'completed' | 'all' | 'high_priority') || 'pending';

  const todos = await getUserTodos(userId, filter);

  const filterLabels: Record<string, string> = {
    today: "today's",
    pending: 'pending',
    completed: 'completed',
    all: 'all',
    high_priority: 'high priority',
  };

  const label = filterLabels[filter] || filter;

  if (todos.length === 0) {
    const emptyMessages: Record<string, string> = {
      today: "No tasks due today! 🎉\n\nEnjoy your free day or add a new task.",
      pending: "You're all caught up! 🎉\n\nNo pending tasks.",
      completed: "No completed tasks yet.\n\nComplete a task and it'll show up here!",
      high_priority: "No high priority tasks! 👍\n\nThat's good news.",
      all: "You don't have any tasks yet.\n\nTry: \"Add call mom tomorrow\"",
    };
    return emptyMessages[filter] || 'No tasks found!';
  }

  return `📋 *Your ${label} tasks:*\n\n${formatTodoList(todos)}\n\n_${todos.length} task${todos.length !== 1 ? 's' : ''} found_`;
}

/**
 * Execute mark_complete intent
 */
async function executeMarkComplete(
  chatId: string,
  userId: string,
  params: Record<string, string | undefined>
): Promise<string> {
  const taskIdentifier = params.task_identifier;
  if (!taskIdentifier) {
    return "I couldn't understand which task to complete. Please specify the task name.";
  }

  const result = await markTodoComplete(userId, taskIdentifier);

  if (result.success && result.todo) {
    return `✅ Done! *${result.todo.title}* has been marked complete.\n\nGreat job! 🎉`;
  }

  return `❌ ${result.message}`;
}

/**
 * Execute add_journal intent
 */
async function executeAddJournal(
  chatId: string,
  userId: string,
  params: Record<string, string | undefined>
): Promise<string> {
  const content = params.content;
  if (!content) {
    return "I couldn't understand what to add to your journal. Please try again.";
  }

  const result = await addJournalContent(userId, content, {
    mood: params.mood,
  });

  if (result.success) {
    let response = '📓 Journal entry saved!';
    if (params.mood) {
      const moodEmojis: Record<string, string> = {
        great: '😊',
        good: '🙂',
        okay: '😐',
        bad: '😔',
        terrible: '😢',
      };
      response += `\nMood: ${moodEmojis[params.mood] || ''} ${params.mood}`;
    }
    return response;
  }

  return `❌ ${result.message}`;
}
