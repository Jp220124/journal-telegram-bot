/**
 * Supabase service for database operations
 * Uses service_role key for full access (bot backend)
 */

import { createClient } from '@supabase/supabase-js';
import { config } from '../config/env.js';

// Types for our database tables
export interface Todo {
  id: string;
  user_id: string;
  title: string;
  completed: boolean;
  priority: 'low' | 'medium' | 'high';
  due_date: string | null;
  due_time: string | null;
  category: string | null;       // Legacy text field
  category_id: string | null;    // UUID foreign key to task_categories
  notes: string | null;
  created_at: string;
  updated_at: string;
  reminder_sent: boolean;
}

export interface JournalEntry {
  id: string;
  user_id: string;
  date: string;
  overall_mood: string | null;
  overall_notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserIntegration {
  id: string;
  user_id: string;
  platform: string;
  platform_chat_id: string;
  platform_username: string | null;
  is_verified: boolean;
  verification_code: string | null;
  code_expires_at: string | null;
  notification_enabled: boolean;
  reminder_minutes_before: number;
  daily_summary_enabled: boolean;
  daily_summary_time: string;
  timezone: string;
  created_at: string;
  updated_at: string;
}

export interface MessageHistory {
  id: string;
  user_id: string | null;
  integration_id: string | null;
  direction: 'inbound' | 'outbound';
  message_type: 'text' | 'voice' | 'command';
  original_content: string | null;
  transcription: string | null;
  ai_intent: string | null;
  ai_response: string | null;
  processing_time_ms: number | null;
  created_at: string;
}

export interface Note {
  id: string;
  user_id: string;
  title: string;
  content: Record<string, unknown>; // TipTap JSON content
  content_text: string; // Plain text for search
  folder_id: string | null;
  is_pinned: boolean;
  is_archived: boolean;
  word_count: number;
  created_at: string;
  updated_at: string;
}

export interface NoteFolder {
  id: string;
  user_id: string;
  name: string;
  icon: string;
  color: string;
  parent_id: string | null;
  order_index: number;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

// Create Supabase client with service role key
const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

/**
 * Find user integration by Telegram chat ID
 */
export async function findIntegrationByChatId(chatId: string): Promise<UserIntegration | null> {
  const { data, error } = await supabase
    .from('user_integrations')
    .select('*')
    .eq('platform', 'telegram')
    .eq('platform_chat_id', chatId)
    .eq('is_verified', true)
    .single();

  if (error || !data) return null;
  return data as UserIntegration;
}

/**
 * Verify a Telegram chat with a verification code
 */
export async function verifyTelegramChat(
  verificationCode: string,
  chatId: string,
  username?: string
): Promise<{ success: boolean; userId?: string; message: string }> {
  const { data, error } = await supabase.rpc('verify_telegram_chat', {
    p_verification_code: verificationCode,
    p_chat_id: chatId,
    p_username: username || null,
  });

  if (error) {
    console.error('Error verifying chat:', error);
    return { success: false, message: 'Database error during verification' };
  }

  const result = data?.[0];
  return {
    success: result?.success || false,
    userId: result?.user_id,
    message: result?.message || 'Unknown error',
  };
}

/**
 * Get user's todos
 */
export async function getUserTodos(
  userId: string,
  filter: 'today' | 'pending' | 'completed' | 'all' | 'high_priority' = 'pending',
  category?: string
): Promise<Todo[]> {
  let query = supabase
    .from('todos')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  const today = new Date().toISOString().split('T')[0];

  switch (filter) {
    case 'today':
      query = query.eq('due_date', today).eq('completed', false);
      break;
    case 'pending':
      query = query.eq('completed', false);
      break;
    case 'completed':
      query = query.eq('completed', true);
      break;
    case 'high_priority':
      query = query.eq('priority', 'high').eq('completed', false);
      break;
    // 'all' - no additional filters
  }

  // Filter by category if provided
  if (category) {
    const categoryId = await getCategoryIdByName(userId, category);
    if (categoryId) {
      query = query.eq('category_id', categoryId);
    }
  }

  const { data, error } = await query.limit(20);

  if (error) {
    console.error('Error fetching todos:', error);
    return [];
  }

  return data as Todo[];
}

/**
 * Get category ID by name from task_categories table
 * The Journal app uses category_id (UUID) not category (string)
 */
async function getCategoryIdByName(userId: string, categoryName: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('task_categories')
    .select('id')
    .eq('user_id', userId)
    .ilike('name', categoryName)  // Case-insensitive match
    .single();

  if (error) {
    console.log('[Category Lookup] Category not found:', { categoryName, error: error.message });
    return null;
  }

  console.log('[Category Lookup] Found category:', { categoryName, categoryId: data.id });
  return data.id;
}

/**
 * Add a new todo
 */
export async function addTodo(
  userId: string,
  title: string,
  options?: {
    priority?: 'low' | 'medium' | 'high';
    due_date?: string;
    due_time?: string;
    category?: string;
    notes?: string;
  }
): Promise<Todo | null> {
  // Look up category_id if category name is provided
  let categoryId: string | null = null;
  if (options?.category) {
    categoryId = await getCategoryIdByName(userId, options.category);
  }

  // Debug logging before insert
  console.log('[DB Insert Debug] Attempting to add todo:', {
    userId,
    title,
    priority: options?.priority || 'medium',
    due_date: options?.due_date || null,
    due_time: options?.due_time || null,
    category: options?.category || null,
    category_id: categoryId,  // The actual UUID we're using
  });

  const { data, error } = await supabase
    .from('todos')
    .insert({
      user_id: userId,
      title,
      priority: options?.priority || 'medium',
      due_date: options?.due_date || null,
      due_time: options?.due_time || null,
      category_id: categoryId,  // Use category_id (UUID) instead of category (string)
      notes: options?.notes || null,
    })
    .select()
    .single();

  if (error) {
    console.error('[DB Insert Error] Error adding todo:', error);
    return null;
  }

  // Debug logging after successful insert - include category_id to verify it was saved
  console.log('[DB Insert Success] Todo created:', {
    id: data.id,
    title: data.title,
    user_id: data.user_id,
    category_id: data.category_id,  // Check if category_id was actually saved
    priority: data.priority,
  });

  return data as Todo;
}

/**
 * Add multiple todos at once (bulk creation)
 */
export async function addMultipleTodos(
  userId: string,
  titles: string[],
  options?: {
    priority?: 'low' | 'medium' | 'high';
    due_date?: string;
    due_time?: string;
    category?: string;
  }
): Promise<{ success: boolean; todos: Todo[]; failed: string[] }> {
  // Look up category_id if category name is provided
  let categoryId: string | null = null;
  if (options?.category) {
    categoryId = await getCategoryIdByName(userId, options.category);
  }

  console.log('[DB Bulk Insert] Adding multiple todos:', {
    userId,
    titles,
    category: options?.category,
    categoryId,
    due_date: options?.due_date,
    due_time: options?.due_time,
  });

  const createdTodos: Todo[] = [];
  const failedTitles: string[] = [];

  // Insert each todo
  for (const title of titles) {
    const { data, error } = await supabase
      .from('todos')
      .insert({
        user_id: userId,
        title: title.trim(),
        priority: options?.priority || 'medium',
        due_date: options?.due_date || null,
        due_time: options?.due_time || null,
        category_id: categoryId,
      })
      .select()
      .single();

    if (error) {
      console.error('[DB Bulk Insert Error] Failed to add:', title, error);
      failedTitles.push(title);
    } else {
      createdTodos.push(data as Todo);
    }
  }

  console.log('[DB Bulk Insert Complete]', {
    created: createdTodos.length,
    failed: failedTitles.length,
    due_date: options?.due_date,
    due_time: options?.due_time,
  });

  return {
    success: createdTodos.length > 0,
    todos: createdTodos,
    failed: failedTitles,
  };
}

/**
 * Mark a todo as complete by searching for title
 */
export async function markTodoComplete(
  userId: string,
  taskIdentifier: string
): Promise<{ success: boolean; todo?: Todo; message: string }> {
  // Find todos matching the identifier (case-insensitive partial match)
  const { data: todos, error: searchError } = await supabase
    .from('todos')
    .select('*')
    .eq('user_id', userId)
    .eq('completed', false)
    .ilike('title', `%${taskIdentifier}%`)
    .limit(5);

  if (searchError) {
    console.error('Error searching todos:', searchError);
    return { success: false, message: 'Error searching for task' };
  }

  if (!todos || todos.length === 0) {
    return { success: false, message: `No pending task found matching "${taskIdentifier}"` };
  }

  if (todos.length > 1) {
    const titles = todos.map((t) => `- ${t.title}`).join('\n');
    return {
      success: false,
      message: `Multiple tasks found. Please be more specific:\n${titles}`,
    };
  }

  // Mark the single matching todo as complete
  const { data, error } = await supabase
    .from('todos')
    .update({ completed: true, updated_at: new Date().toISOString() })
    .eq('id', todos[0].id)
    .select()
    .single();

  if (error) {
    console.error('Error marking todo complete:', error);
    return { success: false, message: 'Error updating task' };
  }

  return { success: true, todo: data as Todo, message: 'Task completed!' };
}

/**
 * Delete a todo by identifier (soft match)
 */
export async function deleteTodo(
  userId: string,
  taskIdentifier: string
): Promise<{ success: boolean; todo?: Todo; message: string }> {
  // Find todos matching the identifier (case-insensitive partial match)
  const { data: todos, error: searchError } = await supabase
    .from('todos')
    .select('*')
    .eq('user_id', userId)
    .ilike('title', `%${taskIdentifier}%`)
    .limit(5);

  if (searchError) {
    console.error('Error searching todos:', searchError);
    return { success: false, message: 'Error searching for task' };
  }

  if (!todos || todos.length === 0) {
    return { success: false, message: `No task found matching "${taskIdentifier}"` };
  }

  if (todos.length > 1) {
    const titles = todos.map((t) => `- ${t.title}`).join('\n');
    return {
      success: false,
      message: `Multiple tasks found. Please be more specific:\n${titles}`,
    };
  }

  const todoToDelete = todos[0];

  // Delete the task
  const { error } = await supabase
    .from('todos')
    .delete()
    .eq('id', todoToDelete.id);

  if (error) {
    console.error('Error deleting todo:', error);
    return { success: false, message: 'Error deleting task' };
  }

  return { success: true, todo: todoToDelete as Todo, message: 'Task deleted!' };
}

/**
 * Update a todo by identifier
 */
export async function updateTodo(
  userId: string,
  taskIdentifier: string,
  updates: {
    new_title?: string;
    new_due_date?: string;
    new_due_time?: string;
    new_priority?: 'low' | 'medium' | 'high';
    new_category?: string;
  }
): Promise<{ success: boolean; todo?: Todo; message: string }> {
  // Find todos matching the identifier (case-insensitive partial match)
  const { data: todos, error: searchError } = await supabase
    .from('todos')
    .select('*')
    .eq('user_id', userId)
    .ilike('title', `%${taskIdentifier}%`)
    .limit(5);

  if (searchError) {
    console.error('Error searching todos:', searchError);
    return { success: false, message: 'Error searching for task' };
  }

  if (!todos || todos.length === 0) {
    return { success: false, message: `No task found matching "${taskIdentifier}"` };
  }

  if (todos.length > 1) {
    const titles = todos.map((t) => `- ${t.title}`).join('\n');
    return {
      success: false,
      message: `Multiple tasks found. Please be more specific:\n${titles}`,
    };
  }

  const todoToUpdate = todos[0];

  // Build update object
  const updateData: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (updates.new_title) {
    updateData.title = updates.new_title;
  }
  if (updates.new_due_date) {
    updateData.due_date = updates.new_due_date;
  }
  if (updates.new_due_time) {
    updateData.due_time = updates.new_due_time;
  }
  if (updates.new_priority) {
    updateData.priority = updates.new_priority;
  }
  if (updates.new_category) {
    const categoryId = await getCategoryIdByName(userId, updates.new_category);
    if (categoryId) {
      updateData.category_id = categoryId;
    }
  }

  // Update the task
  const { data, error } = await supabase
    .from('todos')
    .update(updateData)
    .eq('id', todoToUpdate.id)
    .select()
    .single();

  if (error) {
    console.error('Error updating todo:', error);
    return { success: false, message: 'Error updating task' };
  }

  return { success: true, todo: data as Todo, message: 'Task updated!' };
}

/**
 * Log mood without journal content (quick mood check-in)
 */
export async function logMood(
  userId: string,
  mood: 'great' | 'good' | 'okay' | 'bad' | 'terrible'
): Promise<{ success: boolean; message: string }> {
  const today = new Date().toISOString().split('T')[0];

  // Check if entry exists for today
  const { data: existing } = await supabase
    .from('daily_entries')
    .select('id')
    .eq('user_id', userId)
    .eq('date', today)
    .single();

  if (existing) {
    // Update existing entry's mood
    const { error } = await supabase
      .from('daily_entries')
      .update({ overall_mood: mood, updated_at: new Date().toISOString() })
      .eq('id', existing.id);

    if (error) {
      console.error('Error updating mood:', error);
      return { success: false, message: 'Error saving mood' };
    }
  } else {
    // Create new entry with just mood
    const { error } = await supabase
      .from('daily_entries')
      .insert({
        user_id: userId,
        date: today,
        overall_mood: mood,
        overall_notes: '',
      });

    if (error) {
      console.error('Error creating mood entry:', error);
      return { success: false, message: 'Error saving mood' };
    }
  }

  return { success: true, message: 'Mood logged!' };
}

/**
 * Get or create a daily journal entry
 */
export async function getOrCreateDailyEntry(userId: string, date?: string): Promise<JournalEntry | null> {
  const entryDate = date || new Date().toISOString().split('T')[0];

  // Try to find existing entry
  const { data: existing } = await supabase
    .from('daily_entries')
    .select('*')
    .eq('user_id', userId)
    .eq('date', entryDate)
    .single();

  if (existing) return existing as JournalEntry;

  // Create new entry
  const { data, error } = await supabase
    .from('daily_entries')
    .insert({
      user_id: userId,
      date: entryDate,
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating daily entry:', error);
    return null;
  }

  return data as JournalEntry;
}

/**
 * Add content to journal
 */
export async function addJournalContent(
  userId: string,
  content: string,
  options?: {
    mood?: string;
    date?: string;
  }
): Promise<{ success: boolean; message: string }> {
  const entry = await getOrCreateDailyEntry(userId, options?.date);
  if (!entry) {
    return { success: false, message: 'Could not create journal entry' };
  }

  // Update the overall notes (append if existing)
  const newNotes = entry.overall_notes ? `${entry.overall_notes}\n\n${content}` : content;

  const { error } = await supabase
    .from('daily_entries')
    .update({
      overall_notes: newNotes,
      overall_mood: options?.mood || entry.overall_mood,
      updated_at: new Date().toISOString(),
    })
    .eq('id', entry.id);

  if (error) {
    console.error('Error adding journal content:', error);
    return { success: false, message: 'Error saving journal entry' };
  }

  return { success: true, message: 'Journal entry saved!' };
}

/**
 * Save message to history
 */
export async function saveMessageHistory(
  integrationId: string | null,
  userId: string | null,
  direction: 'inbound' | 'outbound',
  messageType: 'text' | 'voice' | 'command',
  originalContent: string | null,
  options?: {
    transcription?: string;
    aiIntent?: string;
    aiResponse?: string;
    processingTimeMs?: number;
  }
): Promise<void> {
  const { error } = await supabase.from('message_history').insert({
    integration_id: integrationId,
    user_id: userId,
    direction,
    message_type: messageType,
    original_content: originalContent,
    transcription: options?.transcription || null,
    ai_intent: options?.aiIntent || null,
    ai_response: options?.aiResponse || null,
    processing_time_ms: options?.processingTimeMs || null,
  });

  if (error) {
    console.error('Error saving message history:', error);
  }
}

/**
 * Get recent message history for context
 */
export async function getRecentMessages(userId: string, limit: number = 5): Promise<MessageHistory[]> {
  const { data, error } = await supabase
    .from('message_history')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Error fetching message history:', error);
    return [];
  }

  return (data as MessageHistory[]).reverse();
}

/**
 * Get pending notifications that need to be sent
 */
export async function getPendingNotifications(): Promise<
  Array<{
    notification_id: string;
    user_id: string;
    chat_id: string;
    notification_type: string;
    message_content: string | null;
    todo_title: string | null;
    scheduled_for: string;
  }>
> {
  const { data, error } = await supabase.rpc('get_pending_notifications', {
    p_limit: 50,
  });

  if (error) {
    console.error('Error fetching pending notifications:', error);
    return [];
  }

  return data || [];
}

/**
 * Mark a notification as sent
 */
export async function markNotificationSent(notificationId: string): Promise<void> {
  const { error } = await supabase.rpc('mark_notification_sent', {
    p_notification_id: notificationId,
  });

  if (error) {
    console.error('Error marking notification sent:', error);
  }
}

/**
 * Mark a notification as failed
 */
export async function markNotificationFailed(notificationId: string, errorMessage: string): Promise<void> {
  const { error } = await supabase.rpc('mark_notification_failed', {
    p_notification_id: notificationId,
    p_error: errorMessage,
  });

  if (error) {
    console.error('Error marking notification failed:', error);
  }
}

// =====================================================
// Notes Functions
// =====================================================

/**
 * Helper to create TipTap JSON content from plain text
 */
function createTipTapContent(text: string): Record<string, unknown> {
  // Split text into paragraphs
  const paragraphs = text.split('\n').filter((p) => p.trim());

  if (paragraphs.length === 0) {
    return {
      type: 'doc',
      content: [{ type: 'paragraph' }],
    };
  }

  return {
    type: 'doc',
    content: paragraphs.map((p) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: p }],
    })),
  };
}

/**
 * Count words in text
 */
function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

/**
 * Get user's note folders
 */
export async function getUserFolders(userId: string): Promise<NoteFolder[]> {
  const { data, error } = await supabase
    .from('note_folders')
    .select('*')
    .eq('user_id', userId)
    .order('order_index', { ascending: true });

  if (error) {
    console.error('Error fetching note folders:', error);
    return [];
  }

  return data as NoteFolder[];
}

/**
 * Find a folder by name (case-insensitive)
 */
export async function getFolderByName(userId: string, folderName: string): Promise<NoteFolder | null> {
  const { data, error } = await supabase
    .from('note_folders')
    .select('*')
    .eq('user_id', userId)
    .ilike('name', folderName)
    .single();

  if (error) {
    console.log('[Folder Lookup] Folder not found:', { folderName, error: error.message });
    return null;
  }

  return data as NoteFolder;
}

/**
 * Get user's recent notes
 */
export async function getUserNotes(
  userId: string,
  options?: {
    folderId?: string | null;
    limit?: number;
  }
): Promise<Note[]> {
  let query = supabase
    .from('notes')
    .select('*')
    .eq('user_id', userId)
    .eq('is_archived', false)
    .order('is_pinned', { ascending: false })
    .order('updated_at', { ascending: false });

  if (options?.folderId !== undefined) {
    if (options.folderId === null) {
      query = query.is('folder_id', null);
    } else {
      query = query.eq('folder_id', options.folderId);
    }
  }

  const { data, error } = await query.limit(options?.limit || 10);

  if (error) {
    console.error('Error fetching notes:', error);
    return [];
  }

  return data as Note[];
}

/**
 * Search notes by title or content
 */
export async function searchNotes(userId: string, searchQuery: string, limit: number = 10): Promise<Note[]> {
  // Try using the RPC function first if it exists
  const { data: rpcData, error: rpcError } = await supabase.rpc('search_notes', {
    p_user_id: userId,
    p_query: searchQuery,
    p_limit: limit,
    p_offset: 0,
  });

  if (!rpcError && rpcData) {
    return rpcData as Note[];
  }

  // Fallback to simple ILIKE search
  console.log('[Notes Search] RPC failed, using fallback:', rpcError?.message);

  const { data, error } = await supabase
    .from('notes')
    .select('*')
    .eq('user_id', userId)
    .eq('is_archived', false)
    .or(`title.ilike.%${searchQuery}%,content_text.ilike.%${searchQuery}%`)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Error searching notes:', error);
    return [];
  }

  return data as Note[];
}

/**
 * Find a note by title (case-insensitive, partial match)
 */
export async function getNoteByTitle(
  userId: string,
  title: string
): Promise<{ success: boolean; note?: Note; notes?: Note[]; message: string }> {
  const { data, error } = await supabase
    .from('notes')
    .select('*')
    .eq('user_id', userId)
    .eq('is_archived', false)
    .ilike('title', `%${title}%`)
    .limit(5);

  if (error) {
    console.error('Error finding note:', error);
    return { success: false, message: 'Error searching for note' };
  }

  if (!data || data.length === 0) {
    return { success: false, message: `No note found matching "${title}"` };
  }

  if (data.length === 1) {
    return { success: true, note: data[0] as Note, message: 'Note found' };
  }

  // Multiple matches
  return {
    success: false,
    notes: data as Note[],
    message: `Multiple notes found. Please be more specific:\n${data.map((n) => `- ${n.title}`).join('\n')}`,
  };
}

/**
 * Delete a note by title
 */
export async function deleteNote(
  userId: string,
  noteTitle: string
): Promise<{ success: boolean; note?: Note; message: string }> {
  // Find note matching the title
  const { data: notes, error: searchError } = await supabase
    .from('notes')
    .select('*')
    .eq('user_id', userId)
    .ilike('title', `%${noteTitle}%`)
    .limit(5);

  if (searchError) {
    console.error('Error searching notes:', searchError);
    return { success: false, message: 'Error searching for note' };
  }

  if (!notes || notes.length === 0) {
    return { success: false, message: `No note found matching "${noteTitle}"` };
  }

  if (notes.length > 1) {
    const titles = notes.map((n) => `- ${n.title}`).join('\n');
    return {
      success: false,
      message: `Multiple notes found. Please be more specific:\n${titles}`,
    };
  }

  const noteToDelete = notes[0];

  // Delete the note
  const { error } = await supabase
    .from('notes')
    .delete()
    .eq('id', noteToDelete.id);

  if (error) {
    console.error('Error deleting note:', error);
    return { success: false, message: 'Error deleting note' };
  }

  return { success: true, note: noteToDelete as Note, message: 'Note deleted!' };
}

/**
 * Archive or unarchive a note
 */
export async function setNoteArchived(
  userId: string,
  noteTitle: string,
  archived: boolean
): Promise<{ success: boolean; note?: Note; message: string }> {
  // Find note matching the title
  const { data: notes, error: searchError } = await supabase
    .from('notes')
    .select('*')
    .eq('user_id', userId)
    .eq('is_archived', !archived) // Find notes in opposite state
    .ilike('title', `%${noteTitle}%`)
    .limit(5);

  if (searchError) {
    console.error('Error searching notes:', searchError);
    return { success: false, message: 'Error searching for note' };
  }

  if (!notes || notes.length === 0) {
    const stateWord = archived ? 'active' : 'archived';
    return { success: false, message: `No ${stateWord} note found matching "${noteTitle}"` };
  }

  if (notes.length > 1) {
    const titles = notes.map((n) => `- ${n.title}`).join('\n');
    return {
      success: false,
      message: `Multiple notes found. Please be more specific:\n${titles}`,
    };
  }

  const noteToUpdate = notes[0];

  // Update archive status
  const { data, error } = await supabase
    .from('notes')
    .update({ is_archived: archived, updated_at: new Date().toISOString() })
    .eq('id', noteToUpdate.id)
    .select()
    .single();

  if (error) {
    console.error('Error updating note archive status:', error);
    return { success: false, message: 'Error updating note' };
  }

  const action = archived ? 'archived' : 'restored';
  return { success: true, note: data as Note, message: `Note ${action}!` };
}

/**
 * Pin or unpin a note
 */
export async function setNotePinned(
  userId: string,
  noteTitle: string,
  pinned: boolean
): Promise<{ success: boolean; note?: Note; message: string }> {
  // Find note matching the title (only search non-archived notes)
  const { data: notes, error: searchError } = await supabase
    .from('notes')
    .select('*')
    .eq('user_id', userId)
    .eq('is_archived', false)
    .ilike('title', `%${noteTitle}%`)
    .limit(5);

  if (searchError) {
    console.error('Error searching notes:', searchError);
    return { success: false, message: 'Error searching for note' };
  }

  if (!notes || notes.length === 0) {
    return { success: false, message: `No note found matching "${noteTitle}"` };
  }

  if (notes.length > 1) {
    const titles = notes.map((n) => `- ${n.title}`).join('\n');
    return {
      success: false,
      message: `Multiple notes found. Please be more specific:\n${titles}`,
    };
  }

  const noteToUpdate = notes[0];

  // Check if already in desired state
  if (noteToUpdate.is_pinned === pinned) {
    const state = pinned ? 'already pinned' : 'not pinned';
    return { success: false, message: `Note is ${state}` };
  }

  // Update pin status
  const { data, error } = await supabase
    .from('notes')
    .update({ is_pinned: pinned, updated_at: new Date().toISOString() })
    .eq('id', noteToUpdate.id)
    .select()
    .single();

  if (error) {
    console.error('Error updating note pin status:', error);
    return { success: false, message: 'Error updating note' };
  }

  const action = pinned ? 'pinned' : 'unpinned';
  return { success: true, note: data as Note, message: `Note ${action}!` };
}

/**
 * Update note content by appending (with title search)
 */
export async function updateNoteContent(
  userId: string,
  noteTitle: string,
  contentToAdd: string
): Promise<{ success: boolean; note?: Note; message: string }> {
  // Find note matching the title
  const { data: notes, error: searchError } = await supabase
    .from('notes')
    .select('*')
    .eq('user_id', userId)
    .eq('is_archived', false)
    .ilike('title', `%${noteTitle}%`)
    .limit(5);

  if (searchError) {
    console.error('Error searching notes:', searchError);
    return { success: false, message: 'Error searching for note' };
  }

  if (!notes || notes.length === 0) {
    return { success: false, message: `No note found matching "${noteTitle}"` };
  }

  if (notes.length > 1) {
    const titles = notes.map((n) => `- ${n.title}`).join('\n');
    return {
      success: false,
      message: `Multiple notes found. Please be more specific:\n${titles}`,
    };
  }

  const noteToUpdate = notes[0] as Note;

  // Append content
  const newContent = noteToUpdate.content_text + '\n\n' + contentToAdd;
  const newTipTapContent = createTipTapContent(newContent);
  const newWordCount = countWords(newContent);

  // Update the note
  const { data, error } = await supabase
    .from('notes')
    .update({
      content: newTipTapContent,
      content_text: newContent,
      word_count: newWordCount,
      updated_at: new Date().toISOString(),
    })
    .eq('id', noteToUpdate.id)
    .select()
    .single();

  if (error) {
    console.error('Error updating note content:', error);
    return { success: false, message: 'Error updating note' };
  }

  return { success: true, note: data as Note, message: 'Content added to note!' };
}

/**
 * Create a new note
 */
export async function addNote(
  userId: string,
  title: string,
  content: string,
  options?: {
    folderId?: string;
    folderName?: string;
  }
): Promise<Note | null> {
  // Look up folder by name if provided
  let folderId: string | null = options?.folderId || null;
  if (!folderId && options?.folderName) {
    const folder = await getFolderByName(userId, options.folderName);
    if (folder) {
      folderId = folder.id;
    }
  }

  const tipTapContent = createTipTapContent(content);
  const wordCount = countWords(content);

  console.log('[Note Create] Adding note:', {
    userId,
    title,
    contentPreview: content.substring(0, 50) + '...',
    folderId,
    wordCount,
  });

  const { data, error } = await supabase
    .from('notes')
    .insert({
      user_id: userId,
      title,
      content: tipTapContent,
      content_text: content,
      folder_id: folderId,
      is_pinned: false,
      is_archived: false,
      word_count: wordCount,
    })
    .select()
    .single();

  if (error) {
    console.error('[Note Create Error]:', error);
    return null;
  }

  console.log('[Note Create Success]:', { id: data.id, title: data.title });
  return data as Note;
}

/**
 * Append content to an existing note
 */
export async function appendToNote(noteId: string, additionalContent: string): Promise<Note | null> {
  // First get the existing note
  const { data: existing, error: fetchError } = await supabase
    .from('notes')
    .select('*')
    .eq('id', noteId)
    .single();

  if (fetchError || !existing) {
    console.error('Error fetching note to append:', fetchError);
    return null;
  }

  // Combine content
  const newContentText = existing.content_text + '\n\n' + additionalContent;
  const newTipTapContent = createTipTapContent(newContentText);
  const newWordCount = countWords(newContentText);

  const { data, error } = await supabase
    .from('notes')
    .update({
      content: newTipTapContent,
      content_text: newContentText,
      word_count: newWordCount,
      updated_at: new Date().toISOString(),
    })
    .eq('id', noteId)
    .select()
    .single();

  if (error) {
    console.error('Error appending to note:', error);
    return null;
  }

  return data as Note;
}

/**
 * Get user's task categories (for dynamic category support)
 */
export async function getUserCategories(userId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('task_categories')
    .select('name')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('order_index', { ascending: true });

  if (error) {
    console.error('[Categories] Error fetching user categories:', error);
    // Fallback to default categories
    return ['Daily Recurring', 'One-Time Tasks', 'Work', 'Personal'];
  }

  if (!data || data.length === 0) {
    // No categories found, return defaults
    return ['Daily Recurring', 'One-Time Tasks', 'Work', 'Personal'];
  }

  console.log('[Categories] Fetched user categories:', data.map(c => c.name));
  return data.map(cat => cat.name);
}

// =====================================================
// Statistics Functions (Phase 3)
// =====================================================

export interface UserStatistics {
  journalStreak: number;
  totalJournalEntries: number;
  totalNotes: number;
  totalTasks: number;
  completedTasks: number;
  pendingTasks: number;
  completionRate7Days: number;
  completionRate30Days: number;
  moodDistribution: Record<string, number>;
  lastJournalDate: string | null;
}

/**
 * Calculate consecutive days with journal entries (streak)
 */
export async function calculateJournalStreak(userId: string): Promise<number> {
  // Get all journal entries ordered by date descending
  const { data, error } = await supabase
    .from('daily_entries')
    .select('date')
    .eq('user_id', userId)
    .not('overall_notes', 'is', null)
    .order('date', { ascending: false });

  if (error || !data || data.length === 0) {
    return 0;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Create a Set of entry dates for O(1) lookup
  const entryDates = new Set(data.map(e => e.date));

  // Check if there's an entry today or yesterday (to allow for in-progress day)
  const todayStr = today.toISOString().split('T')[0];
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  // Start counting from the most recent day with an entry
  let startDate: Date;
  if (entryDates.has(todayStr)) {
    startDate = today;
  } else if (entryDates.has(yesterdayStr)) {
    startDate = yesterday;
  } else {
    // No recent entries, streak is 0
    return 0;
  }

  // Count consecutive days going backwards
  let streak = 0;
  const checkDate = new Date(startDate);

  while (true) {
    const dateStr = checkDate.toISOString().split('T')[0];
    if (entryDates.has(dateStr)) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }

  return streak;
}

/**
 * Get task completion statistics for a given period
 */
export async function getTaskCompletionStats(
  userId: string,
  days: number
): Promise<{ completed: number; total: number; rate: number }> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startDateStr = startDate.toISOString();

  // Get all tasks created in the period
  const { data, error } = await supabase
    .from('todos')
    .select('id, completed')
    .eq('user_id', userId)
    .gte('created_at', startDateStr);

  if (error || !data) {
    return { completed: 0, total: 0, rate: 0 };
  }

  const completed = data.filter(t => t.completed).length;
  const total = data.length;
  const rate = total > 0 ? Math.round((completed / total) * 100) : 0;

  return { completed, total, rate };
}

/**
 * Get mood distribution for a given period
 */
export async function getMoodDistribution(
  userId: string,
  days: number
): Promise<Record<string, number>> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startDateStr = startDate.toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('daily_entries')
    .select('overall_mood')
    .eq('user_id', userId)
    .gte('date', startDateStr)
    .not('overall_mood', 'is', null);

  if (error || !data) {
    return {};
  }

  const distribution: Record<string, number> = {
    great: 0,
    good: 0,
    okay: 0,
    bad: 0,
    terrible: 0,
  };

  for (const entry of data) {
    if (entry.overall_mood && distribution.hasOwnProperty(entry.overall_mood)) {
      distribution[entry.overall_mood]++;
    }
  }

  return distribution;
}

/**
 * Get comprehensive user statistics
 */
export async function getUserStatistics(userId: string): Promise<UserStatistics> {
  // Run queries in parallel for efficiency
  const [
    streak,
    stats7Days,
    stats30Days,
    moodDist,
    journalCount,
    notesCount,
    tasksData,
    lastJournal,
  ] = await Promise.all([
    calculateJournalStreak(userId),
    getTaskCompletionStats(userId, 7),
    getTaskCompletionStats(userId, 30),
    getMoodDistribution(userId, 30),
    // Total journal entries
    supabase
      .from('daily_entries')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .not('overall_notes', 'is', null),
    // Total notes
    supabase
      .from('notes')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_archived', false),
    // Task counts
    supabase
      .from('todos')
      .select('id, completed')
      .eq('user_id', userId),
    // Last journal entry date
    supabase
      .from('daily_entries')
      .select('date')
      .eq('user_id', userId)
      .not('overall_notes', 'is', null)
      .order('date', { ascending: false })
      .limit(1)
      .single(),
  ]);

  const allTasks = tasksData.data || [];
  const completedTasks = allTasks.filter(t => t.completed).length;
  const pendingTasks = allTasks.length - completedTasks;

  return {
    journalStreak: streak,
    totalJournalEntries: journalCount.count || 0,
    totalNotes: notesCount.count || 0,
    totalTasks: allTasks.length,
    completedTasks,
    pendingTasks,
    completionRate7Days: stats7Days.rate,
    completionRate30Days: stats30Days.rate,
    moodDistribution: moodDist,
    lastJournalDate: lastJournal.data?.date || null,
  };
}

/**
 * Check if user has journaled today (for streak warning)
 */
export async function hasJournaledToday(userId: string): Promise<boolean> {
  const today = new Date().toISOString().split('T')[0];

  const { data } = await supabase
    .from('daily_entries')
    .select('id')
    .eq('user_id', userId)
    .eq('date', today)
    .not('overall_notes', 'is', null)
    .single();

  return !!data;
}

/**
 * Get tasks due today for daily briefing
 */
export async function getTasksDueToday(userId: string): Promise<Todo[]> {
  const today = new Date().toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('todos')
    .select('*')
    .eq('user_id', userId)
    .eq('due_date', today)
    .eq('completed', false)
    .order('due_time', { ascending: true, nullsFirst: false });

  if (error) {
    console.error('Error fetching tasks due today:', error);
    return [];
  }

  return data as Todo[];
}

/**
 * Get all verified integrations for scheduled notifications
 */
export async function getAllVerifiedIntegrations(): Promise<UserIntegration[]> {
  const { data, error } = await supabase
    .from('user_integrations')
    .select('*')
    .eq('platform', 'telegram')
    .eq('is_verified', true)
    .eq('notification_enabled', true);

  if (error) {
    console.error('Error fetching verified integrations:', error);
    return [];
  }

  return data as UserIntegration[];
}

// =====================================================
// Template Functions (Phase 4)
// =====================================================

export interface JournalTemplate {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  icon: string;
  color: string;
  is_default: boolean;
  is_active: boolean;
  order_index: number;
  created_at: string;
  updated_at: string;
}

export interface JournalTemplateSection {
  id: string;
  template_id: string;
  user_id: string;
  name: string;
  description: string | null;
  icon: string;
  color: string;
  order_index: number;
  is_active: boolean;
  created_at: string;
}

export interface JournalTemplateWithSections extends JournalTemplate {
  journal_template_sections: JournalTemplateSection[];
}

/**
 * Get user's journal templates
 */
export async function getUserTemplates(userId: string): Promise<JournalTemplate[]> {
  const { data, error } = await supabase
    .from('journal_templates')
    .select('*')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('order_index', { ascending: true });

  if (error) {
    console.error('Error fetching templates:', error);
    return [];
  }

  return data as JournalTemplate[];
}

/**
 * Get template with sections by ID
 */
export async function getTemplateWithSections(
  userId: string,
  templateId: string
): Promise<JournalTemplateWithSections | null> {
  const { data, error } = await supabase
    .from('journal_templates')
    .select(`
      *,
      journal_template_sections (*)
    `)
    .eq('id', templateId)
    .eq('user_id', userId)
    .single();

  if (error) {
    console.error('Error fetching template with sections:', error);
    return null;
  }

  // Sort sections by order_index
  if (data?.journal_template_sections) {
    data.journal_template_sections.sort(
      (a: JournalTemplateSection, b: JournalTemplateSection) => a.order_index - b.order_index
    );
    // Filter only active sections
    data.journal_template_sections = data.journal_template_sections.filter(
      (s: JournalTemplateSection) => s.is_active
    );
  }

  return data as JournalTemplateWithSections;
}

/**
 * Find template by name (case-insensitive partial match)
 */
export async function getTemplateByName(
  userId: string,
  templateName: string
): Promise<{ success: boolean; template?: JournalTemplateWithSections; templates?: JournalTemplate[]; message: string }> {
  const { data, error } = await supabase
    .from('journal_templates')
    .select('*')
    .eq('user_id', userId)
    .eq('is_active', true)
    .ilike('name', `%${templateName}%`)
    .limit(5);

  if (error) {
    console.error('Error finding template:', error);
    return { success: false, message: 'Error searching for template' };
  }

  if (!data || data.length === 0) {
    return { success: false, message: `No template found matching "${templateName}"` };
  }

  if (data.length === 1) {
    // Get the template with sections
    const templateWithSections = await getTemplateWithSections(userId, data[0].id);
    if (templateWithSections) {
      return { success: true, template: templateWithSections, message: 'Template found' };
    }
    return { success: false, message: 'Error loading template sections' };
  }

  // Multiple matches
  return {
    success: false,
    templates: data as JournalTemplate[],
    message: `Multiple templates found. Please be more specific:\n${data.map((t) => `- ${t.name}`).join('\n')}`,
  };
}

/**
 * Create a journal entry from template sections
 */
export async function createTemplateJournalEntry(
  userId: string,
  templateId: string,
  sections: Array<{ id: string; name: string; icon: string; color: string }>,
  sectionContents: Record<string, string>,
  date?: string
): Promise<{ success: boolean; message: string }> {
  const entryDate = date || new Date().toISOString().split('T')[0];

  // First, create or get the template entry
  const { data: entryData, error: entryError } = await supabase
    .from('journal_template_entries')
    .upsert(
      {
        user_id: userId,
        template_id: templateId,
        date: entryDate,
      },
      {
        onConflict: 'user_id,template_id,date',
        ignoreDuplicates: false,
      }
    )
    .select()
    .single();

  if (entryError) {
    // Try to fetch existing entry if upsert had issues
    const { data: existing } = await supabase
      .from('journal_template_entries')
      .select('*')
      .eq('user_id', userId)
      .eq('template_id', templateId)
      .eq('date', entryDate)
      .single();

    if (!existing) {
      console.error('Error creating template entry:', entryError);
      return { success: false, message: 'Error creating journal entry' };
    }

    // Use existing entry
    const entryId = existing.id;

    // Create section entries
    for (const section of sections) {
      const content = sectionContents[section.id];
      if (!content) continue;

      await supabase
        .from('journal_template_section_entries')
        .upsert(
          {
            entry_id: entryId,
            section_id: section.id,
            section_name: section.name,
            section_icon: section.icon,
            section_color: section.color,
            content: content,
          },
          {
            onConflict: 'entry_id,section_id',
            ignoreDuplicates: false,
          }
        );
    }

    return { success: true, message: 'Template journal entry saved!' };
  }

  const entryId = entryData.id;

  // Create section entries
  for (const section of sections) {
    const content = sectionContents[section.id];
    if (!content) continue;

    const { error: sectionError } = await supabase
      .from('journal_template_section_entries')
      .upsert(
        {
          entry_id: entryId,
          section_id: section.id,
          section_name: section.name,
          section_icon: section.icon,
          section_color: section.color,
          content: content,
        },
        {
          onConflict: 'entry_id,section_id',
          ignoreDuplicates: false,
        }
      );

    if (sectionError) {
      console.error('Error creating section entry:', sectionError);
    }
  }

  return { success: true, message: 'Template journal entry saved!' };
}

export { supabase };
