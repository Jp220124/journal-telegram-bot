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
  category: string | null;
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
  filter: 'today' | 'pending' | 'completed' | 'all' | 'high_priority' = 'pending'
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

  const { data, error } = await query.limit(20);

  if (error) {
    console.error('Error fetching todos:', error);
    return [];
  }

  return data as Todo[];
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
  const { data, error } = await supabase
    .from('todos')
    .insert({
      user_id: userId,
      title,
      priority: options?.priority || 'medium',
      due_date: options?.due_date || null,
      due_time: options?.due_time || null,
      category: options?.category || null,
      notes: options?.notes || null,
    })
    .select()
    .single();

  if (error) {
    console.error('Error adding todo:', error);
    return null;
  }

  return data as Todo;
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

export { supabase };
