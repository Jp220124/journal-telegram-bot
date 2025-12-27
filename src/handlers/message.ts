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
  addMultipleTodos,
  markTodoComplete,
  deleteTodo,
  updateTodo,
  logMood,
  addJournalContent,
  saveMessageHistory,
  getUserNotes,
  addNote,
  searchNotes,
  getNoteByTitle,
  deleteNote,
  setNoteArchived,
  setNotePinned,
  updateNoteContent,
  getUserFolders,
  getUserCategories,
  getRecentMessages,
  getUserTemplates,
  getTemplateByName,
  createTemplateJournalEntry,
  getTodaySchedule,
  getWeekSchedule,
  getRecurringTasks,
  type Note,
  type Todo,
  type JournalTemplate,
  type JournalTemplateWithSections,
} from '../services/supabase.js';
import {
  getState,
  setState,
  resetState,
} from '../services/conversationState.js';
import type { PendingTaskPhotoData } from '../types/conversation.js';
import { config } from '../config/env.js';
import { handleResearchTextInput, triggerResearchForTask } from './research.js';
import { getCategoryAutomation } from '../services/researchDatabase.js';

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

  // Check for research clarification input (handle before normal processing)
  if (config.isResearchEnabled) {
    const isResearchInput = await handleResearchTextInput(msg.chat.id, text);
    if (isResearchInput) {
      // Message was handled as research clarification
      return;
    }
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

      case 'AWAITING_NOTE_TITLE':
        // User's message IS the note title - set it and ask for content
        response = await handleAwaitingNoteTitle(chatId, text, conversationState.pendingNote);
        intentForHistory = 'add_note';
        break;

      case 'AWAITING_NOTE_CONTENT':
        // User's message IS the note content - create the note
        response = await handleAwaitingNoteContent(chatId, integration.user_id, text, conversationState.pendingNote);
        intentForHistory = 'add_note';
        break;

      case 'AWAITING_TEMPLATE_SELECTION':
        // User is selecting a template by number or name
        response = await handleAwaitingTemplateSelection(chatId, integration.user_id, text);
        intentForHistory = 'journal_template';
        break;

      case 'AWAITING_TEMPLATE_SECTION':
        // User is providing content for a template section
        response = await handleAwaitingTemplateSection(chatId, integration.user_id, text, conversationState.pendingTemplate);
        intentForHistory = 'journal_template';
        break;

      case 'AWAITING_TASK_PHOTO':
        // User is selecting a task by number to add photo to
        response = await handleAwaitingTaskPhotoSelection(chatId, integration.user_id, text);
        intentForHistory = 'add_task_photo';
        break;

      case 'IDLE':
      default:
        // Fetch user's custom categories for dynamic category support
        const userCategories = await getUserCategories(integration.user_id);

        // Fetch recent messages for conversation context
        // Each message row contains both user input AND assistant response
        // We need to create proper user/assistant pairs for the LLM context
        const recentMessages = await getRecentMessages(integration.user_id, 5);
        const conversationContext: Array<{ role: 'user' | 'assistant'; content: string }> = [];

        for (const msg of recentMessages) {
          // Add user message if present
          if (msg.original_content && msg.original_content.trim().length > 0) {
            conversationContext.push({
              role: 'user',
              content: msg.original_content,
            });
          }
          // Add assistant response if present (creates proper conversation pairs)
          if (msg.ai_response && msg.ai_response.trim().length > 0) {
            conversationContext.push({
              role: 'assistant',
              content: msg.ai_response,
            });
          }
        }

        // Parse intent with AI (using dynamic categories and context)
        const intent = await parseIntent(text, userCategories, conversationContext);
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

  // Check for research automation (async, non-blocking)
  if (config.isResearchEnabled && todo.category_id) {
    triggerResearchForTask({
      taskId: todo.id,
      taskName: todo.title,
      taskDescription: todo.notes || undefined,
      categoryId: todo.category_id,
      userId,
    }).then((result) => {
      if (result.started) {
        console.log(`🔬 Research triggered for task: ${todo.title}`);
      }
    }).catch((err) => {
      console.error('Error triggering research:', err);
    });
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
 * Handle message when awaiting note title
 * Set the title and ask for content
 */
async function handleAwaitingNoteTitle(
  chatId: string,
  title: string,
  pendingData: { folder_id?: string; folder_name?: string }
): Promise<string> {
  console.log('[State Handler] Processing awaited note title:', { title, pendingData });

  // Update state with title and move to awaiting content
  setState(chatId, 'AWAITING_NOTE_CONTENT', undefined, undefined, {
    title,
    folder_id: pendingData.folder_id,
    folder_name: pendingData.folder_name,
  });

  let response = `📝 *${title}*\n\nNow send the note content.`;
  if (pendingData.folder_name) {
    response += `\n📁 Folder: ${pendingData.folder_name}`;
  }
  response += '\n\n_Send the content, or /cancel to abort._';
  return response;
}

/**
 * Handle message when awaiting note content
 * Create the note with title and content
 */
async function handleAwaitingNoteContent(
  chatId: string,
  userId: string,
  content: string,
  pendingData: { title?: string; folder_id?: string; folder_name?: string }
): Promise<string> {
  console.log('[State Handler] Processing awaited note content:', {
    title: pendingData.title,
    contentLength: content.length,
    pendingData
  });

  // Reset state first
  resetState(chatId);

  if (!pendingData.title) {
    return '❌ Note title is missing. Please start again.';
  }

  const note = await addNote(userId, pendingData.title, content, {
    folderId: pendingData.folder_id,
    folderName: pendingData.folder_name,
  });

  if (!note) {
    return '❌ Failed to create note. Please try again.';
  }

  let response = `📝 Note created: *${note.title}*`;

  if (pendingData.folder_name) {
    response += `\n📁 Folder: ${pendingData.folder_name}`;
  }

  response += `\n📊 ${note.word_count} words`;

  return response;
}

/**
 * Handle incomplete intent - set state and ask for missing data
 */
async function handleIncompleteIntent(chatId: string, intent: ParsedIntent): Promise<string> {
  console.log('[State Handler] Handling incomplete intent:', intent);

  // Cast parameters to string type for convenience
  const params = intent.parameters as Record<string, string | undefined>;

  switch (intent.intent) {
    case 'add_todo':
      // Has category/priority/date but no title
      setState(chatId, 'AWAITING_TODO_TITLE', {
        category: params.category,
        priority: params.priority as 'low' | 'medium' | 'high' | undefined,
        due_date: params.due_date,
        due_time: params.due_time,
      });

      let askMessage = '📝 What task would you like to add';
      if (params.category) {
        askMessage += ` to *${params.category}*`;
      }
      askMessage += '?\n\n_Send the task title, or /cancel to abort._';
      return askMessage;

    case 'add_journal':
      // Has mood but no content
      setState(chatId, 'AWAITING_JOURNAL_CONTENT', undefined, {
        mood: params.mood,
      });

      let journalAsk = '📓 What would you like to write in your journal';
      if (params.mood) {
        journalAsk += ` (mood: ${params.mood})`;
      }
      journalAsk += '?\n\n_Send your journal entry, or /cancel to abort._';
      return journalAsk;

    case 'mark_complete':
      // No task identifier
      return "❓ Which task would you like to mark as complete?\n\nPlease tell me the task name.";

    case 'add_note':
      // Has folder but no title - ask for title first
      setState(chatId, 'AWAITING_NOTE_TITLE', undefined, undefined, {
        folder_name: params.folder,
      });

      let noteAsk = '📝 What would you like to name this note';
      if (params.folder) {
        noteAsk += ` in *${params.folder}*`;
      }
      noteAsk += '?\n\n_Send the note title, or /cancel to abort._';
      return noteAsk;

    case 'read_note':
      // No note title specified
      return "❓ Which note would you like to read?\n\nPlease tell me the note title or use /mynotes to see your notes.";

    default:
      return params.response || "I'm not sure how to help with that.";
  }
}

/**
 * Execute parsed intent (when complete)
 */
export async function executeIntent(chatId: string, userId: string, intent: ParsedIntent): Promise<string> {
  // Cast parameters to the expected type for most functions
  const params = intent.parameters as Record<string, string | undefined>;

  switch (intent.intent) {
    case 'add_todo':
      return executeAddTodo(chatId, userId, params);

    case 'add_multiple_todos':
      return executeAddMultipleTodos(chatId, userId, intent.parameters);

    case 'query_todos':
      return executeQueryTodos(chatId, userId, params);

    case 'mark_complete':
      return executeMarkComplete(chatId, userId, params);

    case 'delete_todo':
      return executeDeleteTodo(chatId, userId, params);

    case 'edit_todo':
      return executeEditTodo(chatId, userId, params);

    case 'log_mood':
      return executeLogMood(chatId, userId, params);

    case 'add_journal':
      return executeAddJournal(chatId, userId, params);

    case 'add_note':
      return executeAddNote(chatId, userId, params);

    case 'query_notes':
      return executeQueryNotes(chatId, userId, params);

    case 'read_note':
      return executeReadNote(chatId, userId, params);

    case 'manage_note':
      return executeManageNote(chatId, userId, params);

    case 'edit_note':
      return executeEditNote(chatId, userId, params);

    case 'query_templates':
      return executeQueryTemplates(chatId, userId);

    case 'journal_template':
      return executeJournalTemplate(chatId, userId, params);

    case 'query_calendar':
      return executeQueryCalendar(chatId, userId, params);

    case 'query_recurring':
      return executeQueryRecurring(chatId, userId);

    case 'add_task_photo':
      return executeAddTaskPhoto(chatId, userId, params);

    case 'general_chat':
    default:
      return params.response || "I'm not sure how to help with that.";
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

  // Check for research automation (async, non-blocking)
  if (config.isResearchEnabled && todo.category_id) {
    triggerResearchForTask({
      taskId: todo.id,
      taskName: todo.title,
      taskDescription: todo.notes || undefined,
      categoryId: todo.category_id,
      userId,
    }).then((result) => {
      if (result.started) {
        console.log(`🔬 Research triggered for task: ${todo.title}`);
      }
    }).catch((err) => {
      console.error('Error triggering research:', err);
    });
  }

  return response;
}

/**
 * Execute add_multiple_todos intent (bulk task creation)
 */
async function executeAddMultipleTodos(
  chatId: string,
  userId: string,
  params: Record<string, string | string[] | undefined>
): Promise<string> {
  const titles = params.titles;

  if (!titles || !Array.isArray(titles) || titles.length === 0) {
    return "I couldn't understand what tasks to add. Please try again.";
  }

  const result = await addMultipleTodos(userId, titles, {
    priority: (params.priority as 'low' | 'medium' | 'high') || 'medium',
    due_date: params.due_date as string | undefined,
    due_time: params.due_time as string | undefined,
    category: params.category as string | undefined,
  });

  if (!result.success) {
    return '❌ Failed to add tasks. Please try again.';
  }

  let response = `✅ Added ${result.todos.length} task${result.todos.length > 1 ? 's' : ''}:\n`;

  for (const todo of result.todos) {
    response += `• ${todo.title}\n`;
  }

  if (params.category) {
    response += `\n📁 Category: ${params.category}`;
  }

  if (params.due_date || params.due_time) {
    response += '\n📅 Due:';
    if (params.due_date) {
      response += ` ${params.due_date}`;
    }
    if (params.due_time) {
      response += ` at ${params.due_time}`;
    }
  }

  if (params.due_date && params.due_time) {
    response += "\n\n⏰ I'll remind you when they're due!";
  }

  if (result.failed.length > 0) {
    response += `\n\n⚠️ Failed to add: ${result.failed.join(', ')}`;
  }

  // Trigger research for each created todo (async, non-blocking)
  if (config.isResearchEnabled) {
    for (const todo of result.todos) {
      if (todo.category_id) {
        triggerResearchForTask({
          taskId: todo.id,
          taskName: todo.title,
          taskDescription: todo.notes || undefined,
          categoryId: todo.category_id,
          userId,
        }).then((researchResult) => {
          if (researchResult.started) {
            console.log(`🔬 Research triggered for task: ${todo.title}`);
          }
        }).catch((err) => {
          console.error('Error triggering research:', err);
        });
      }
    }
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
  const category = params.category;

  const todos = await getUserTodos(userId, filter, category);

  const filterLabels: Record<string, string> = {
    today: "today's",
    pending: 'pending',
    completed: 'completed',
    all: 'all',
    high_priority: 'high priority',
  };

  let label = filterLabels[filter] || filter;
  if (category) {
    label = `${label} ${category}`;
  }

  if (todos.length === 0) {
    if (category) {
      return `No ${filter} tasks in ${category} category! 🎉`;
    }
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
 * Execute delete_todo intent
 */
async function executeDeleteTodo(
  chatId: string,
  userId: string,
  params: Record<string, string | undefined>
): Promise<string> {
  const taskIdentifier = params.task_identifier;
  if (!taskIdentifier) {
    return "I couldn't understand which task to delete. Please specify the task name.";
  }

  const result = await deleteTodo(userId, taskIdentifier);

  if (result.success && result.todo) {
    return `🗑️ Deleted: *${result.todo.title}*\n\nTask has been removed from your list.`;
  }

  return `❌ ${result.message}`;
}

/**
 * Execute edit_todo intent
 */
async function executeEditTodo(
  chatId: string,
  userId: string,
  params: Record<string, string | undefined>
): Promise<string> {
  const taskIdentifier = params.task_identifier;
  if (!taskIdentifier) {
    return "I couldn't understand which task to edit. Please specify the task name.";
  }

  const result = await updateTodo(userId, taskIdentifier, {
    new_title: params.new_title,
    new_due_date: params.new_due_date,
    new_due_time: params.new_due_time,
    new_priority: params.new_priority as 'low' | 'medium' | 'high' | undefined,
    new_category: params.new_category,
  });

  if (result.success && result.todo) {
    let response = `✏️ Updated: *${result.todo.title}*`;

    // Show what was changed
    const changes: string[] = [];
    if (params.new_title) changes.push(`Title: ${params.new_title}`);
    if (params.new_due_date) changes.push(`Due date: ${params.new_due_date}`);
    if (params.new_due_time) changes.push(`Due time: ${params.new_due_time}`);
    if (params.new_priority) changes.push(`Priority: ${params.new_priority}`);
    if (params.new_category) changes.push(`Category: ${params.new_category}`);

    if (changes.length > 0) {
      response += `\n\nChanges:\n${changes.map(c => `• ${c}`).join('\n')}`;
    }

    return response;
  }

  return `❌ ${result.message}`;
}

/**
 * Execute log_mood intent
 */
async function executeLogMood(
  chatId: string,
  userId: string,
  params: Record<string, string | undefined>
): Promise<string> {
  const mood = params.mood as 'great' | 'good' | 'okay' | 'bad' | 'terrible';
  if (!mood) {
    return "I couldn't understand your mood. Please say something like 'feeling great' or 'mood: okay'.";
  }

  const result = await logMood(userId, mood);

  if (result.success) {
    const moodEmojis: Record<string, string> = {
      great: '😊',
      good: '🙂',
      okay: '😐',
      bad: '😔',
      terrible: '😢',
    };

    const emoji = moodEmojis[mood] || '';
    return `${emoji} Mood logged: *${mood}*\n\nYour mood has been recorded for today. Take care of yourself!`;
  }

  return `❌ ${result.message}`;
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

// =====================================================
// Note Execute Functions
// =====================================================

/**
 * Format a note list for display
 */
function formatNoteList(notes: Note[]): string {
  return notes
    .map((note, index) => {
      const pinned = note.is_pinned ? '📌 ' : '';
      const preview = note.content_text.slice(0, 50).replace(/\n/g, ' ');
      const hasMore = note.content_text.length > 50 ? '...' : '';
      return `${index + 1}. ${pinned}*${note.title}*\n   _${preview}${hasMore}_`;
    })
    .join('\n\n');
}

/**
 * Execute add_note intent
 */
async function executeAddNote(
  chatId: string,
  userId: string,
  params: Record<string, string | undefined>
): Promise<string> {
  const title = params.title;
  if (!title) {
    // This shouldn't happen if isComplete check worked, but handle gracefully
    setState(chatId, 'AWAITING_NOTE_TITLE', undefined, undefined, {
      folder_name: params.folder,
    });
    return '📝 What would you like to name this note?\n\n_Send the note title, or /cancel to abort._';
  }

  // If we have title but no content, ask for content
  if (!params.content) {
    setState(chatId, 'AWAITING_NOTE_CONTENT', undefined, undefined, {
      title,
      folder_name: params.folder,
    });
    let response = `📝 *${title}*\n\nNow send the note content.`;
    if (params.folder) {
      response += `\n📁 Folder: ${params.folder}`;
    }
    response += '\n\n_Send the content, or /cancel to abort._';
    return response;
  }

  // We have both title and content - create the note
  const note = await addNote(userId, title, params.content, {
    folderName: params.folder,
  });

  if (!note) {
    return '❌ Failed to create note. Please try again.';
  }

  let response = `📝 Note created: *${note.title}*`;

  if (params.folder) {
    response += `\n📁 Folder: ${params.folder}`;
  }

  response += `\n📊 ${note.word_count} words`;

  return response;
}

/**
 * Execute query_notes intent
 */
export async function executeQueryNotes(
  chatId: string,
  userId: string,
  params: Record<string, string | undefined>
): Promise<string> {
  const searchQuery = params.search_query;
  const folder = params.folder;

  let notes: Note[];

  if (searchQuery) {
    // Search notes
    notes = await searchNotes(userId, searchQuery, 10);

    if (notes.length === 0) {
      return `🔍 No notes found matching "${searchQuery}".\n\nTry a different search term or use /newnote to create one.`;
    }

    return `🔍 *Notes matching "${searchQuery}":*\n\n${formatNoteList(notes)}\n\n_${notes.length} note${notes.length !== 1 ? 's' : ''} found_`;
  } else {
    // List recent notes
    notes = await getUserNotes(userId, { limit: 10 });

    if (notes.length === 0) {
      return "📝 You don't have any notes yet.\n\nTry: \"Create a note about project ideas\" or use /newnote";
    }

    return `📝 *Your recent notes:*\n\n${formatNoteList(notes)}\n\n_${notes.length} note${notes.length !== 1 ? 's' : ''}_`;
  }
}

/**
 * Execute read_note intent
 */
async function executeReadNote(
  chatId: string,
  userId: string,
  params: Record<string, string | undefined>
): Promise<string> {
  const noteTitle = params.note_title;
  if (!noteTitle) {
    return "❓ Which note would you like to read?\n\nPlease tell me the note title.";
  }

  const result = await getNoteByTitle(userId, noteTitle);

  if (!result.success) {
    if (result.notes && result.notes.length > 1) {
      // Multiple matches - show options
      return `${result.message}\n\nPlease be more specific about which note you want to read.`;
    }
    return `❌ ${result.message}`;
  }

  const note = result.note!;
  const pinned = note.is_pinned ? '📌 ' : '';

  let response = `${pinned}📝 *${note.title}*\n\n${note.content_text}`;

  // Add metadata footer
  response += `\n\n---\n📊 ${note.word_count} words`;

  const updatedDate = new Date(note.updated_at).toLocaleDateString();
  response += ` • Updated: ${updatedDate}`;

  return response;
}

/**
 * Execute manage_note intent (delete, archive, pin/unpin)
 */
async function executeManageNote(
  chatId: string,
  userId: string,
  params: Record<string, string | undefined>
): Promise<string> {
  const noteTitle = params.note_title;
  const action = params.action;

  if (!noteTitle) {
    return "❓ Which note would you like to manage?\n\nPlease specify the note title.";
  }

  if (!action) {
    return "❓ What would you like to do with this note?\n\nYou can: delete, archive, unarchive, pin, or unpin.";
  }

  switch (action) {
    case 'delete': {
      const result = await deleteNote(userId, noteTitle);
      if (result.success && result.note) {
        return `🗑️ Deleted: *${result.note.title}*\n\nNote has been removed.`;
      }
      return `❌ ${result.message}`;
    }

    case 'archive': {
      const result = await setNoteArchived(userId, noteTitle, true);
      if (result.success && result.note) {
        return `📦 Archived: *${result.note.title}*\n\nNote moved to archive.`;
      }
      return `❌ ${result.message}`;
    }

    case 'unarchive': {
      const result = await setNoteArchived(userId, noteTitle, false);
      if (result.success && result.note) {
        return `📤 Unarchived: *${result.note.title}*\n\nNote restored from archive.`;
      }
      return `❌ ${result.message}`;
    }

    case 'pin': {
      const result = await setNotePinned(userId, noteTitle, true);
      if (result.success && result.note) {
        return `📌 Pinned: *${result.note.title}*\n\nNote is now pinned to the top.`;
      }
      return `❌ ${result.message}`;
    }

    case 'unpin': {
      const result = await setNotePinned(userId, noteTitle, false);
      if (result.success && result.note) {
        return `📍 Unpinned: *${result.note.title}*\n\nNote is no longer pinned.`;
      }
      return `❌ ${result.message}`;
    }

    default:
      return `❌ Unknown action: ${action}\n\nValid actions: delete, archive, unarchive, pin, unpin`;
  }
}

/**
 * Execute edit_note intent (append content)
 */
async function executeEditNote(
  chatId: string,
  userId: string,
  params: Record<string, string | undefined>
): Promise<string> {
  const noteTitle = params.note_title;
  const contentToAdd = params.content_to_add;

  if (!noteTitle) {
    return "❓ Which note would you like to edit?\n\nPlease specify the note title.";
  }

  if (!contentToAdd) {
    return "❓ What would you like to add to this note?\n\nPlease provide the content to append.";
  }

  const result = await updateNoteContent(userId, noteTitle, contentToAdd);

  if (result.success && result.note) {
    return `✏️ Updated: *${result.note.title}*\n\nContent has been added to your note.\n📊 Now ${result.note.word_count} words`;
  }

  return `❌ ${result.message}`;
}

// =====================================================
// Template Execute Functions (Phase 4)
// =====================================================

/**
 * Execute query_templates intent - list user's templates
 */
async function executeQueryTemplates(
  chatId: string,
  userId: string
): Promise<string> {
  const templates = await getUserTemplates(userId);

  if (!templates || templates.length === 0) {
    return (
      "📓 You don't have any journal templates yet.\n\n" +
      "Create templates in the Daily Journal web app to use them here!"
    );
  }

  let response = `📓 *Your Journal Templates*\n\n`;

  templates.forEach((template, index) => {
    const defaultBadge = template.is_default ? ' ⭐' : '';
    const description = template.description ? `\n   _${template.description}_` : '';
    response += `${index + 1}. *${template.name}*${defaultBadge}${description}\n\n`;
  });

  response += `\n_Say "Journal with [template name]" to start journaling!_`;

  return response;
}

/**
 * Execute journal_template intent - start journaling with a template
 */
async function executeJournalTemplate(
  chatId: string,
  userId: string,
  params: Record<string, string | undefined>
): Promise<string> {
  const templateName = params.template_name;

  if (!templateName) {
    // No template specified - show list and ask for selection
    const templates = await getUserTemplates(userId);

    if (!templates || templates.length === 0) {
      return (
        "📓 You don't have any journal templates yet.\n\n" +
        "Create templates in the Daily Journal web app to use them here!"
      );
    }

    let response = `📓 *Select a Template*\n\n`;

    templates.forEach((template, index) => {
      const defaultBadge = template.is_default ? ' ⭐' : '';
      response += `${index + 1}. *${template.name}*${defaultBadge}\n`;
    });

    response += `\n_Reply with the template number or name._`;

    // Set state to awaiting template selection
    setState(chatId, 'AWAITING_TEMPLATE_SELECTION', undefined, undefined, undefined, {});

    return response;
  }

  // Try to find the template
  const result = await getTemplateByName(userId, templateName);

  if (!result.success) {
    if (result.templates && result.templates.length > 1) {
      // Multiple templates matched
      let response = `📓 *Multiple templates found:*\n\n`;
      result.templates.forEach((template, index) => {
        response += `${index + 1}. *${template.name}*\n`;
      });
      response += `\n_Please be more specific or reply with a number._`;

      setState(chatId, 'AWAITING_TEMPLATE_SELECTION', undefined, undefined, undefined, {});
      return response;
    }
    return `❌ ${result.message}`;
  }

  // Template found - start the journaling flow
  return startTemplateJournaling(chatId, result.template!);
}

/**
 * Start the template journaling flow
 */
function startTemplateJournaling(
  chatId: string,
  template: JournalTemplateWithSections
): string {
  const sections = template.journal_template_sections;

  if (!sections || sections.length === 0) {
    return `❌ Template "${template.name}" has no sections. Please add sections in the web app.`;
  }

  const firstSection = sections[0];

  // Set state to collect section content
  setState(chatId, 'AWAITING_TEMPLATE_SECTION', undefined, undefined, undefined, {
    template_id: template.id,
    template_name: template.name,
    sections: sections.map(s => ({
      id: s.id,
      name: s.name,
      icon: s.icon,
      color: s.color,
      order_index: s.order_index,
    })),
    current_section_index: 0,
    collected_sections: {},
    date: new Date().toISOString().split('T')[0],
  });

  let response = `📓 *Journaling with: ${template.name}*\n\n`;
  response += `Section 1/${sections.length}\n`;
  response += `${firstSection.icon || '📝'} *${firstSection.name}*\n\n`;

  if (firstSection.description) {
    response += `_${firstSection.description}_\n\n`;
  }

  response += `_Type your entry for this section, or /skip to skip, or /cancel to abort._`;

  return response;
}

/**
 * Handle template selection state
 */
async function handleAwaitingTemplateSelection(
  chatId: string,
  userId: string,
  text: string
): Promise<string> {
  const templates = await getUserTemplates(userId);

  if (!templates || templates.length === 0) {
    resetState(chatId);
    return "❌ No templates found. Please create templates in the web app first.";
  }

  // Check if input is a number
  const num = parseInt(text, 10);
  let selectedTemplate: JournalTemplateWithSections | null = null;

  if (!isNaN(num) && num >= 1 && num <= templates.length) {
    // User selected by number
    const template = templates[num - 1];
    const result = await getTemplateByName(userId, template.name);
    if (result.success && result.template) {
      selectedTemplate = result.template;
    }
  } else {
    // User selected by name
    const result = await getTemplateByName(userId, text);
    if (result.success && result.template) {
      selectedTemplate = result.template;
    } else if (result.templates && result.templates.length > 1) {
      // Multiple matches
      let response = `📓 *Multiple templates found:*\n\n`;
      result.templates.forEach((template, index) => {
        response += `${index + 1}. *${template.name}*\n`;
      });
      response += `\n_Please be more specific or reply with a number._`;
      return response;
    } else {
      return `❌ ${result.message}\n\n_Try again with a template name or number, or /cancel to abort._`;
    }
  }

  if (!selectedTemplate) {
    return `❌ Could not find that template. Please try again or /cancel to abort.`;
  }

  // Start journaling with selected template
  return startTemplateJournaling(chatId, selectedTemplate);
}

/**
 * Handle template section content state
 */
async function handleAwaitingTemplateSection(
  chatId: string,
  userId: string,
  text: string,
  pendingTemplate: {
    template_id?: string;
    template_name?: string;
    sections?: Array<{ id: string; name: string; icon: string; color: string; order_index: number }>;
    current_section_index?: number;
    collected_sections?: Record<string, string>;
    date?: string;
  }
): Promise<string> {
  const { template_id, template_name, sections, current_section_index, collected_sections, date } = pendingTemplate;

  if (!template_id || !sections || current_section_index === undefined) {
    resetState(chatId);
    return "❌ Something went wrong. Please start over.";
  }

  const currentSection = sections[current_section_index];
  const isSkip = text.toLowerCase() === '/skip';

  // Update collected sections (unless skipping)
  const updatedCollectedSections = { ...collected_sections };
  if (!isSkip && text.trim().length > 0) {
    updatedCollectedSections[currentSection.id] = text;
  }

  const nextIndex = current_section_index + 1;

  if (nextIndex >= sections.length) {
    // All sections completed - save the entry
    resetState(chatId);

    const result = await createTemplateJournalEntry(
      userId,
      template_id,
      sections,
      updatedCollectedSections,
      date
    );

    if (result.success) {
      const filledCount = Object.keys(updatedCollectedSections).length;
      return (
        `✅ *Journal entry saved!*\n\n` +
        `📓 Template: ${template_name}\n` +
        `📝 Sections filled: ${filledCount}/${sections.length}\n\n` +
        `_Your entry has been saved to the web app._`
      );
    }

    return `❌ ${result.message}`;
  }

  // Move to next section
  const nextSection = sections[nextIndex];

  setState(chatId, 'AWAITING_TEMPLATE_SECTION', undefined, undefined, undefined, {
    template_id,
    template_name,
    sections,
    current_section_index: nextIndex,
    collected_sections: updatedCollectedSections,
    date,
  });

  let response = `${isSkip ? '⏭️ Skipped\n\n' : '✅ Saved\n\n'}`;
  response += `Section ${nextIndex + 1}/${sections.length}\n`;
  response += `${nextSection.icon || '📝'} *${nextSection.name}*\n\n`;

  response += `_Type your entry, /skip to skip, or /cancel to abort._`;

  return response;
}

// =====================================================
// Calendar Execute Functions (Phase 5)
// =====================================================

/**
 * Format time for display (HH:MM -> H:MM AM/PM)
 */
function formatTime(time: string | null | undefined): string {
  if (!time) return '';
  const [hours, minutes] = time.split(':').map(Number);
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  return `${displayHours}:${minutes.toString().padStart(2, '0')} ${ampm}`;
}

/**
 * Format date for display
 */
function formatDate(dateStr: string): string {
  const date = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  if (date.getTime() === today.getTime()) {
    return 'Today';
  } else if (date.getTime() === tomorrow.getTime()) {
    return 'Tomorrow';
  } else {
    return `${dayNames[date.getDay()]}, ${date.toLocaleDateString()}`;
  }
}

/**
 * Execute query_calendar intent - show schedule
 */
async function executeQueryCalendar(
  chatId: string,
  userId: string,
  params: Record<string, string | undefined>
): Promise<string> {
  const timeframe = params.timeframe || 'today';

  let tasks: Todo[];
  let title: string;

  if (timeframe === 'week' || timeframe === 'this week') {
    tasks = await getWeekSchedule(userId);
    title = "This Week's Schedule";
  } else {
    tasks = await getTodaySchedule(userId);
    title = "Today's Schedule";
  }

  if (tasks.length === 0) {
    if (timeframe === 'week' || timeframe === 'this week') {
      return "📅 *This Week's Schedule*\n\n" +
        "No scheduled tasks for this week! 🎉\n\n" +
        "_Add tasks with due dates to see them here._";
    }
    return "📅 *Today's Schedule*\n\n" +
      "Nothing scheduled for today! 🎉\n\n" +
      "_Add tasks with due dates to see them here._";
  }

  // Group tasks by date
  const tasksByDate = new Map<string, Todo[]>();
  for (const task of tasks) {
    const date = task.due_date || 'No date';
    if (!tasksByDate.has(date)) {
      tasksByDate.set(date, []);
    }
    tasksByDate.get(date)!.push(task);
  }

  let response = `📅 *${title}*\n\n`;

  for (const [date, dateTasks] of tasksByDate) {
    response += `*${formatDate(date)}*\n`;

    // Sort by time if available
    dateTasks.sort((a, b) => {
      if (!a.due_time && !b.due_time) return 0;
      if (!a.due_time) return 1;
      if (!b.due_time) return -1;
      return a.due_time.localeCompare(b.due_time);
    });

    for (const task of dateTasks) {
      const timeStr = task.due_time ? `${formatTime(task.due_time)} ` : '';
      const priorityEmoji = task.priority === 'high' ? '🔴 ' : task.priority === 'low' ? '🟢 ' : '';
      const statusEmoji = task.completed ? '✅' : '⬜';

      response += `  ${statusEmoji} ${timeStr}${priorityEmoji}${task.title}\n`;
    }
    response += '\n';
  }

  response += `_${tasks.length} task${tasks.length !== 1 ? 's' : ''} scheduled_`;

  return response;
}

/**
 * Execute query_recurring intent - show recurring tasks
 */
async function executeQueryRecurring(
  chatId: string,
  userId: string
): Promise<string> {
  const result = await getRecurringTasks(userId);

  if (result.tasks.length === 0) {
    return "🔄 *Recurring Tasks*\n\n" +
      "No recurring tasks found.\n\n" +
      "_Add tasks to the \"Daily Recurring\" category to see them here._";
  }

  let response = `🔄 *Daily Recurring Tasks*\n\n`;

  // Separate completed and pending
  const pending = result.tasks.filter(t => !t.completed);
  const completed = result.tasks.filter(t => t.completed);

  if (pending.length > 0) {
    response += `*To Do (${pending.length})*\n`;
    for (const task of pending) {
      const timeStr = task.due_time ? ` ⏰ ${formatTime(task.due_time)}` : '';
      response += `⬜ ${task.title}${timeStr}\n`;
    }
    response += '\n';
  }

  if (completed.length > 0) {
    response += `*Completed Today (${completed.length})*\n`;
    for (const task of completed) {
      response += `✅ ${task.title}\n`;
    }
    response += '\n';
  }

  const completionRate = Math.round((completed.length / result.tasks.length) * 100);
  response += `\n📊 Progress: ${completed.length}/${result.tasks.length} (${completionRate}%)`;

  return response;
}

// =====================================================
// Task Photo Execute Functions
// =====================================================

/**
 * Handle task selection by number when in AWAITING_TASK_PHOTO state
 */
async function handleAwaitingTaskPhotoSelection(
  chatId: string,
  userId: string,
  text: string
): Promise<string> {
  // Check if input is a number
  const num = parseInt(text.trim(), 10);

  if (isNaN(num) || num < 1) {
    return "❓ Please enter a task number from the list, or /cancel to abort.";
  }

  // Get user's pending tasks again
  const todos = await getUserTodos(userId, 'pending');
  const tasksToShow = todos.slice(0, 10);

  if (num > tasksToShow.length) {
    return `❌ Invalid number. Please choose a number between 1 and ${tasksToShow.length}, or /cancel to abort.`;
  }

  const selectedTask = tasksToShow[num - 1];

  // Update state with selected task
  setState(chatId, 'AWAITING_TASK_PHOTO', undefined, undefined, undefined, undefined, {
    taskId: selectedTask.id,
    taskTitle: selectedTask.title,
  });

  return `📷 *Ready to add photo!*\n\n` +
    `Task: *${selectedTask.title}*\n\n` +
    `_Send the photo now, or /cancel to abort._`;
}

/**
 * Execute add_task_photo intent - add photo to an existing task
 */
async function executeAddTaskPhoto(
  chatId: string,
  userId: string,
  params: Record<string, string | undefined>
): Promise<string> {
  const taskIdentifier = params.task_identifier;

  if (!taskIdentifier) {
    // No task specified - show recent pending tasks
    const todos = await getUserTodos(userId, 'pending');

    if (todos.length === 0) {
      return "📷 *Add Photo to Task*\n\n" +
        "You don't have any pending tasks to attach a photo to.\n\n" +
        "_Create a task first, or send a photo with a caption to create a new task with the photo._";
    }

    // Show task list and set state to await task selection (via text number)
    let response = "📷 *Add Photo to Task*\n\n" +
      "Which task would you like to add a photo to?\n\n";

    const tasksToShow = todos.slice(0, 10);
    tasksToShow.forEach((todo, i) => {
      response += `${i + 1}. ${todo.title}\n`;
    });

    response += "\n_Reply with the task number, then send the photo._\n" +
      "_Or /cancel to abort._";

    // Store the task list in state for later reference
    // We'll use a simple approach: store task IDs mapped to numbers
    setState(chatId, 'AWAITING_TASK_PHOTO', undefined, undefined, undefined, undefined, {
      // We'll handle number selection in photo handler
    });

    return response;
  }

  // Task identifier provided - find the task
  const todos = await getUserTodos(userId, 'pending');
  const matchedTask = todos.find(
    (t) => t.title.toLowerCase().includes(taskIdentifier.toLowerCase())
  );

  if (!matchedTask) {
    return `❌ Couldn't find a task matching "${taskIdentifier}".\n\n` +
      `_Try again with a different task name, or say "add photo" to see your tasks._`;
  }

  // Set state to await photo for this specific task
  setState(chatId, 'AWAITING_TASK_PHOTO', undefined, undefined, undefined, undefined, {
    taskId: matchedTask.id,
    taskTitle: matchedTask.title,
  });

  return `📷 *Ready to add photo!*\n\n` +
    `Task: *${matchedTask.title}*\n\n` +
    `_Send the photo now, or /cancel to abort._`;
}
