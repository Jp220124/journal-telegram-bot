/**
 * Types for the autonomous research automation feature
 */

// ============================================================================
// Research Job Status
// ============================================================================

export type ResearchJobStatus =
  | 'pending'
  | 'understanding'
  | 'awaiting_clarification'
  | 'researching'
  | 'synthesizing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export enum ResearchStage {
  UNDERSTAND = 1,
  CLARIFY = 2,
  RESEARCH = 3,
  SYNTHESIZE = 4,
  NOTIFY = 5,
  COMPLETE = 6,
}

export type ResearchDepth = 'quick' | 'medium' | 'deep';

export type AutomationType = 'research' | 'summary' | 'analysis';

// ============================================================================
// Category Automation
// ============================================================================

export interface CategoryAutomation {
  id: string;
  user_id: string;
  category_id: string;
  automation_type: AutomationType;
  llm_model: string;
  research_depth: ResearchDepth;
  ask_clarification: boolean;
  notification_enabled: boolean;
  max_sources: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Research Job
// ============================================================================

export interface ResearchJob {
  id: string;
  task_id: string;
  user_id: string;
  automation_id?: string;
  status: ResearchJobStatus;
  current_stage: number;
  bullmq_job_id?: string;

  // Task understanding
  interpreted_topic?: string;
  focus_areas: string[];

  // Clarification
  clarification_question?: string;
  clarification_response?: string;
  clarification_sent_at?: string;
  clarification_timeout_at?: string;

  // Research data
  search_queries: string[];
  raw_research_data: ResearchData;
  sources_used: SourceReference[];

  // Result
  generated_note_id?: string;

  // Error handling
  error_message?: string;
  retry_count: number;
  max_retries: number;

  // Telegram
  telegram_chat_id?: number;
  telegram_message_id?: number;

  // Timestamps
  started_at?: string;
  completed_at?: string;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Task Understanding
// ============================================================================

export interface TaskUnderstanding {
  interpretedTopic: string;
  searchQueries: string[];
  needsClarification: boolean;
  clarificationQuestion?: string;
  suggestedFocusAreas: string[];
  confidence: number; // 0-1
}

// ============================================================================
// Search Results
// ============================================================================

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  publishedDate?: string;
  author?: string;
  score?: number;
  source: 'exa' | 'tavily';
}

export interface SourceReference {
  title: string;
  url: string;
  author?: string;
  publishedDate?: string;
}

export interface ResearchData {
  queries: string[];
  results: SearchResult[];
  totalSources: number;
  searchedAt: string;
  exaResultCount: number;
  tavilyResultCount: number;
}

// ============================================================================
// Generated Note
// ============================================================================

export interface GeneratedNote {
  title: string;
  content: string;
  sources: SourceReference[];
  sections: NoteSectionSummary[];
  generatedAt: string;
}

export interface NoteSectionSummary {
  heading: string;
  bulletPoints: string[];
}

// ============================================================================
// BullMQ Job Data
// ============================================================================

export interface ResearchJobData {
  researchJobId: string;
  taskId: string;
  taskName: string;
  taskDescription?: string;
  userId: string;
  telegramChatId: number;
  automationConfig: CategoryAutomation;

  // Resume data
  stage?: ResearchStage;
  clarificationResponse?: string;
  understanding?: TaskUnderstanding;
  researchData?: ResearchData;
  generatedNote?: GeneratedNote;
  noteId?: string;
}

export interface ResearchJobResult {
  status: 'completed' | 'awaiting_clarification' | 'failed';
  noteId?: string;
  error?: string;
  stage?: ResearchStage;
}

// ============================================================================
// Telegram Conversation State
// ============================================================================

export type TelegramResearchConversationState =
  | 'idle'
  | 'awaiting_clarification'
  | 'awaiting_custom_input';

export interface TelegramResearchConversation {
  id: string;
  user_id: string;
  telegram_chat_id: number;
  research_job_id?: string;
  state: TelegramResearchConversationState;
  context: {
    focusAreas?: string[];
    researchJobId?: string;
    taskName?: string;
  };
  expires_at?: string;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// User Quota
// ============================================================================

export interface UserResearchQuota {
  id: string;
  user_id: string;
  date: string;
  jobs_today: number;
  max_jobs_per_day: number;
  total_jobs_all_time: number;
  total_sources_fetched: number;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Research Settings (from depth)
// ============================================================================

export const RESEARCH_SETTINGS = {
  quick: {
    maxQueriesPerSource: 2,
    resultsPerQuery: 5,
    maxTotalSources: 10,
  },
  medium: {
    maxQueriesPerSource: 3,
    resultsPerQuery: 8,
    maxTotalSources: 15,
  },
  deep: {
    maxQueriesPerSource: 5,
    resultsPerQuery: 10,
    maxTotalSources: 25,
  },
} as const;

// ============================================================================
// Events
// ============================================================================

export interface ResearchTaskCreatedEvent {
  taskId: string;
  taskName: string;
  taskDescription?: string;
  categoryId: string;
  categoryName: string;
  userId: string;
  telegramChatId?: number;
}
