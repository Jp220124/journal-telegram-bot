/**
 * Conversation state types for the state machine
 */

export type ConversationStateType =
  | 'IDLE'
  | 'AWAITING_TODO_TITLE'
  | 'AWAITING_TODO_DETAILS'
  | 'AWAITING_JOURNAL_CONTENT'
  | 'AWAITING_NOTE_TITLE'
  | 'AWAITING_NOTE_CONTENT'
  | 'AWAITING_TEMPLATE_SELECTION'
  | 'AWAITING_TEMPLATE_SECTION'
  | 'AWAITING_TASK_PHOTO'
  | 'CHATTING';

export interface PendingTodoData {
  title?: string;
  category?: string;
  priority?: 'low' | 'medium' | 'high';
  due_date?: string;
  due_time?: string;
}

export interface PendingJournalData {
  mood?: string;
  date?: string;
}

export interface PendingNoteData {
  title?: string;
  content?: string;
  folder_id?: string;
  folder_name?: string;
}

export interface TemplateSection {
  id: string;
  name: string;
  icon: string;
  color: string;
  order_index: number;
}

export interface PendingTemplateData {
  template_id?: string;
  template_name?: string;
  sections?: TemplateSection[];
  current_section_index?: number;
  collected_sections?: Record<string, string>; // section_id -> content
  date?: string;
}

export interface PendingTaskPhotoData {
  taskId?: string;
  taskTitle?: string;
}

export interface ConversationState {
  state: ConversationStateType;
  pendingTodo: PendingTodoData;
  pendingJournal: PendingJournalData;
  pendingNote: PendingNoteData;
  pendingTemplate: PendingTemplateData;
  pendingTaskPhoto: PendingTaskPhotoData;
  lastUpdated: number; // timestamp
  expiresAt: number; // timestamp
}

export const DEFAULT_STATE: ConversationState = {
  state: 'IDLE',
  pendingTodo: {},
  pendingJournal: {},
  pendingNote: {},
  pendingTemplate: {},
  pendingTaskPhoto: {},
  lastUpdated: Date.now(),
  expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
};

// Available categories in the Journal app
export const AVAILABLE_CATEGORIES = [
  'Daily Recurring',
  'One-Time Tasks',
  'Work',
  'Personal',
] as const;

export type AvailableCategory = (typeof AVAILABLE_CATEGORIES)[number];
