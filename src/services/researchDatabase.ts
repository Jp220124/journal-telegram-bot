/**
 * Database service for research automation
 * Handles CRUD operations for category_automations, research_jobs, etc.
 */

import { createClient } from '@supabase/supabase-js';
import { config } from '../config/env.js';
import type {
  CategoryAutomation,
  ResearchJob,
  ResearchJobStatus,
  TelegramResearchConversation,
  UserResearchQuota,
  ResearchData,
  SourceReference,
  TaskUnderstanding,
} from '../types/research.js';

// Supabase client with service role key
const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// ============================================================================
// CATEGORY AUTOMATIONS
// ============================================================================

/**
 * Get automation config for a category
 */
export async function getCategoryAutomation(
  categoryId: string
): Promise<CategoryAutomation | null> {
  const { data, error } = await supabase
    .from('category_automations')
    .select('*')
    .eq('category_id', categoryId)
    .eq('is_active', true)
    .single();

  if (error || !data) {
    return null;
  }

  return data as CategoryAutomation;
}

/**
 * Get all automations for a user
 */
export async function getUserAutomations(
  userId: string
): Promise<CategoryAutomation[]> {
  const { data, error } = await supabase
    .from('category_automations')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error || !data) {
    return [];
  }

  return data as CategoryAutomation[];
}

/**
 * Create a new category automation
 */
export async function createCategoryAutomation(
  automation: Omit<CategoryAutomation, 'id' | 'created_at' | 'updated_at'>
): Promise<CategoryAutomation | null> {
  const { data, error } = await supabase
    .from('category_automations')
    .insert(automation)
    .select()
    .single();

  if (error) {
    console.error('Error creating category automation:', error);
    return null;
  }

  return data as CategoryAutomation;
}

/**
 * Update a category automation
 */
export async function updateCategoryAutomation(
  id: string,
  updates: Partial<CategoryAutomation>
): Promise<boolean> {
  const { error } = await supabase
    .from('category_automations')
    .update(updates)
    .eq('id', id);

  return !error;
}

// ============================================================================
// RESEARCH JOBS
// ============================================================================

/**
 * Create a new research job
 */
export async function createResearchJob(params: {
  taskId: string;
  userId: string;
  automationId?: string;
  telegramChatId?: number;
}): Promise<ResearchJob | null> {
  const { data, error } = await supabase
    .from('research_jobs')
    .insert({
      task_id: params.taskId,
      user_id: params.userId,
      automation_id: params.automationId,
      telegram_chat_id: params.telegramChatId,
      status: 'pending',
      current_stage: 1,
      focus_areas: [],
      search_queries: [],
      raw_research_data: {},
      sources_used: [],
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating research job:', error);
    return null;
  }

  return data as ResearchJob;
}

/**
 * Get a research job by ID
 */
export async function getResearchJob(
  jobId: string
): Promise<ResearchJob | null> {
  const { data, error } = await supabase
    .from('research_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (error || !data) {
    return null;
  }

  return data as ResearchJob;
}

/**
 * Update research job status and data
 */
export async function updateResearchJob(
  jobId: string,
  updates: Partial<{
    status: ResearchJobStatus;
    current_stage: number;
    bullmq_job_id: string;
    interpreted_topic: string;
    focus_areas: string[];
    clarification_question: string;
    clarification_response: string;
    clarification_sent_at: string;
    clarification_timeout_at: string;
    search_queries: string[];
    raw_research_data: ResearchData;
    sources_used: SourceReference[];
    generated_note_id: string;
    error_message: string;
    retry_count: number;
    telegram_message_id: number;
    started_at: string;
    completed_at: string;
  }>
): Promise<boolean> {
  const { error } = await supabase
    .from('research_jobs')
    .update(updates)
    .eq('id', jobId);

  if (error) {
    console.error('Error updating research job:', error);
    return false;
  }

  return true;
}

/**
 * Get pending research jobs for a user
 */
export async function getPendingResearchJobs(
  userId: string
): Promise<ResearchJob[]> {
  const { data, error } = await supabase
    .from('research_jobs')
    .select('*')
    .eq('user_id', userId)
    .in('status', ['pending', 'researching', 'awaiting_clarification'])
    .order('created_at', { ascending: false });

  if (error || !data) {
    return [];
  }

  return data as ResearchJob[];
}

/**
 * Get research job by Telegram message ID
 */
export async function getResearchJobByTelegramMessage(
  chatId: number,
  messageId: number
): Promise<ResearchJob | null> {
  const { data, error } = await supabase
    .from('research_jobs')
    .select('*')
    .eq('telegram_chat_id', chatId)
    .eq('telegram_message_id', messageId)
    .single();

  if (error || !data) {
    return null;
  }

  return data as ResearchJob;
}

// ============================================================================
// TELEGRAM CONVERSATIONS
// ============================================================================

/**
 * Get or create telegram research conversation
 */
export async function getOrCreateTelegramConversation(
  userId: string,
  telegramChatId: number
): Promise<TelegramResearchConversation | null> {
  // Try to get existing
  const { data: existing } = await supabase
    .from('telegram_research_conversations')
    .select('*')
    .eq('telegram_chat_id', telegramChatId)
    .single();

  if (existing) {
    return existing as TelegramResearchConversation;
  }

  // Create new
  const { data, error } = await supabase
    .from('telegram_research_conversations')
    .insert({
      user_id: userId,
      telegram_chat_id: telegramChatId,
      state: 'idle',
      context: {},
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating telegram conversation:', error);
    return null;
  }

  return data as TelegramResearchConversation;
}

/**
 * Update telegram conversation state
 */
export async function updateTelegramConversation(
  telegramChatId: number,
  updates: Partial<{
    research_job_id: string | null;
    state: string;
    context: Record<string, unknown>;
    expires_at: string | null;
  }>
): Promise<boolean> {
  const { error } = await supabase
    .from('telegram_research_conversations')
    .update(updates)
    .eq('telegram_chat_id', telegramChatId);

  return !error;
}

/**
 * Get active conversation for a chat
 */
export async function getActiveConversation(
  telegramChatId: number
): Promise<TelegramResearchConversation | null> {
  const { data } = await supabase
    .from('telegram_research_conversations')
    .select('*')
    .eq('telegram_chat_id', telegramChatId)
    .neq('state', 'idle')
    .single();

  return data as TelegramResearchConversation | null;
}

// ============================================================================
// USER QUOTAS
// ============================================================================

/**
 * Check if user can start a new research job
 */
export async function canUserStartResearch(userId: string): Promise<boolean> {
  const today = new Date().toISOString().split('T')[0];

  const { data } = await supabase
    .from('user_research_quotas')
    .select('jobs_today, max_jobs_per_day')
    .eq('user_id', userId)
    .eq('date', today)
    .single();

  if (!data) {
    // No record for today, user can start
    return true;
  }

  return data.jobs_today < data.max_jobs_per_day;
}

/**
 * Increment user's research job count
 */
export async function incrementUserJobCount(userId: string): Promise<void> {
  const today = new Date().toISOString().split('T')[0];

  // Try to upsert
  const { error } = await supabase.from('user_research_quotas').upsert(
    {
      user_id: userId,
      date: today,
      jobs_today: 1,
      total_jobs_all_time: 1,
    },
    {
      onConflict: 'user_id,date',
    }
  );

  if (error) {
    // If conflict, update instead
    await supabase.rpc('increment_research_job_count', { p_user_id: userId });
  }
}

/**
 * Get user's quota for today
 */
export async function getUserQuota(
  userId: string
): Promise<UserResearchQuota | null> {
  const today = new Date().toISOString().split('T')[0];

  const { data } = await supabase
    .from('user_research_quotas')
    .select('*')
    .eq('user_id', userId)
    .eq('date', today)
    .single();

  return data as UserResearchQuota | null;
}

// ============================================================================
// NOTES (for attaching research results)
// ============================================================================

/**
 * Create a research-generated note
 */
export async function createResearchNote(params: {
  userId: string;
  title: string;
  content: string;
  researchJobId: string;
  sources: SourceReference[];
  folderId?: string;
}): Promise<string | null> {
  // Create TipTap JSON content structure
  const tipTapContent = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: params.content }],
      },
    ],
  };

  const { data, error } = await supabase
    .from('notes')
    .insert({
      user_id: params.userId,
      title: params.title,
      content: tipTapContent,
      content_text: params.content,
      folder_id: params.folderId || null,
      research_job_id: params.researchJobId,
      source_type: 'research',
      sources: params.sources,
      word_count: params.content.split(/\s+/).length,
    })
    .select('id')
    .single();

  if (error) {
    console.error('Error creating research note:', error);
    return null;
  }

  return data.id;
}

// ============================================================================
// TASK-NOTE LINKING
// ============================================================================

/**
 * Link a note to a task
 */
export async function linkNoteToTask(
  taskId: string,
  noteId: string
): Promise<boolean> {
  const { error } = await supabase.from('task_note_links').insert({
    task_id: taskId,
    note_id: noteId,
    link_type: 'research',
    created_at: new Date().toISOString(),
  });

  if (error) {
    console.error('Error linking note to task:', error);
    return false;
  }

  return true;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Count today's research jobs for a user
 */
export async function countTodayResearchJobs(userId: string): Promise<number> {
  const today = new Date().toISOString().split('T')[0];

  const { count } = await supabase
    .from('research_jobs')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', `${today}T00:00:00`)
    .lt('created_at', `${today}T23:59:59`);

  return count || 0;
}

/**
 * Get task by ID (for research context)
 */
export async function getTask(
  taskId: string
): Promise<{ id: string; title: string; category_id: string | null } | null> {
  const { data } = await supabase
    .from('todos')
    .select('id, title, category_id')
    .eq('id', taskId)
    .single();

  return data;
}

/**
 * Get category by ID
 */
export async function getCategory(
  categoryId: string
): Promise<{ id: string; name: string } | null> {
  const { data } = await supabase
    .from('task_categories')
    .select('id, name')
    .eq('id', categoryId)
    .single();

  return data;
}
