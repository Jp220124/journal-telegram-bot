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
  type Note,
} from '../services/supabase.js';
import {
  getState,
  setState,
  resetState,
} from '../services/conversationState.js';

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
