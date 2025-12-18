/**
 * Message handler - processes incoming text messages
 * Uses a conversation state machine for multi-turn interactions
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
} from '../services/supabase.js';
import {
  getState,
  setState,
  resetState,
} from '../services/conversationState.js';
import { AVAILABLE_CATEGORIES } from '../types/conversation.js';

/**
 * Handle incoming text message with state machine
 */
export async function handleTextMessage(msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id.toString();
  const text = msg.text?.trim();

  if (!text) return;

  // Handle /cancel command to reset state
  if (text.toLowerCase() === '/cancel') {
    resetState(chatId);
    await sendMessage(chatId, '❌ Action cancelled. What would you like to do?');
    return;
  }

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

  // Get current conversation state
  const conversationState = getState(chatId);
  let response: string;
  let intentForHistory = 'state_continuation';

  try {
    // Handle based on current state
    switch (conversationState.state) {
      case 'AWAITING_TODO_TITLE':
        // User's message IS the task title - no AI parsing needed
        response = await handleAwaitingTodoTitle(chatId, integration.user_id, text, conversationState.pendingTodo);
        intentForHistory = 'add_todo';
        break;

      case 'AWAITING_JOURNAL_CONTENT':
        // User's message IS the journal content - no AI parsing needed
        response = await handleAwaitingJournalContent(chatId, integration.user_id, text, conversationState.pendingJournal);
        intentForHistory = 'add_journal';
        break;

      case 'IDLE':
      default:
        // Parse intent with AI
        const intent = await parseIntent(text);
        intentForHistory = intent.intent;

        if (intent.isComplete) {
          // All required data present - execute immediately
          response = await executeIntent(chatId, integration.user_id, intent);
        } else {
          // Incomplete intent - set state and ask for missing data
          response = await handleIncompleteIntent(chatId, intent);
        }
        break;
    }
  } catch (error) {
    console.error('Error handling message:', error);
    response = "Sorry, I couldn't complete that action. Please try again.";
    resetState(chatId);
  }

  // Send response
  await sendMessage(chatId, response);

  // Save to message history
  const processingTime = Date.now() - startTime;
  await saveMessageHistory(integration.id, integration.user_id, 'inbound', 'text', text, {
    aiIntent: intentForHistory,
    aiResponse: response,
    processingTimeMs: processingTime,
  });
}

/**
 * Handle message when awaiting todo title
 * The entire message is treated as the task title
 */
async function handleAwaitingTodoTitle(
  chatId: string,
  userId: string,
  title: string,
  pendingData: { category?: string; priority?: 'low' | 'medium' | 'high'; due_date?: string; due_time?: string }
): Promise<string> {
  console.log('[State Handler] Processing awaited todo title:', { title, pendingData });

  // Reset state first
  resetState(chatId);

  // Create the todo with pending data from state
  const todo = await addTodo(userId, title, {
    priority: pendingData.priority || 'medium',
    due_date: pendingData.due_date,
    due_time: pendingData.due_time,
    category: pendingData.category,
  });

  if (!todo) {
    return '❌ Failed to add task. Please try again.';
  }

  let response = `✅ Task added: *${todo.title}*`;

  if (pendingData.category) {
    response += `\n📁 Category: ${pendingData.category}`;
  }

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
 * Handle message when awaiting journal content
 * The entire message is treated as the journal content
 */
async function handleAwaitingJournalContent(
  chatId: string,
  userId: string,
  content: string,
  pendingData: { mood?: string; date?: string }
): Promise<string> {
  console.log('[State Handler] Processing awaited journal content:', { contentLength: content.length, pendingData });

  // Reset state first
  resetState(chatId);

  const result = await addJournalContent(userId, content, {
    mood: pendingData.mood,
    date: pendingData.date,
  });

  if (result.success) {
    let response = '📓 Journal entry saved!';
    if (pendingData.mood) {
      const moodEmojis: Record<string, string> = {
        great: '😊',
        good: '🙂',
        okay: '😐',
        bad: '😔',
        terrible: '😢',
      };
      response += `\nMood: ${moodEmojis[pendingData.mood] || ''} ${pendingData.mood}`;
    }
    return response;
  }

  return `❌ ${result.message}`;
}

/**
 * Handle incomplete intent - set state and ask for missing data
 */
async function handleIncompleteIntent(chatId: string, intent: ParsedIntent): Promise<string> {
  console.log('[State Handler] Handling incomplete intent:', intent);

  switch (intent.intent) {
    case 'add_todo':
      // Has category/priority/date but no title
      setState(chatId, 'AWAITING_TODO_TITLE', {
        category: intent.parameters.category,
        priority: intent.parameters.priority as 'low' | 'medium' | 'high' | undefined,
        due_date: intent.parameters.due_date,
        due_time: intent.parameters.due_time,
      });

      let askMessage = '📝 What task would you like to add';
      if (intent.parameters.category) {
        askMessage += ` to *${intent.parameters.category}*`;
      }
      askMessage += '?\n\n_Send the task title, or /cancel to abort._';
      return askMessage;

    case 'add_journal':
      // Has mood but no content
      setState(chatId, 'AWAITING_JOURNAL_CONTENT', undefined, {
        mood: intent.parameters.mood,
      });

      let journalAsk = '📓 What would you like to write in your journal';
      if (intent.parameters.mood) {
        journalAsk += ` (mood: ${intent.parameters.mood})`;
      }
      journalAsk += '?\n\n_Send your journal entry, or /cancel to abort._';
      return journalAsk;

    case 'mark_complete':
      // No task identifier
      return "❓ Which task would you like to mark as complete?\n\nPlease tell me the task name.";

    default:
      return intent.parameters.response || "I'm not sure how to help with that.";
  }
}

/**
 * Execute parsed intent (when complete)
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

  if (params.category) {
    response += `\n📁 Category: ${params.category}`;
  }

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
