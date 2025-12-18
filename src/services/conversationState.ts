/**
 * Conversation State Machine Service
 * Manages conversation state per chat to enable multi-turn conversations
 * without relying on AI to parse context correctly.
 */

import {
  ConversationState,
  ConversationStateType,
  PendingTodoData,
  PendingJournalData,
  DEFAULT_STATE,
} from '../types/conversation.js';

// In-memory state storage (per chat_id)
// For production, consider using Redis or database storage
const stateStore = new Map<string, ConversationState>();

// State expiration time in milliseconds (5 minutes)
const STATE_EXPIRATION_MS = 5 * 60 * 1000;

/**
 * Get conversation state for a chat
 * Returns default IDLE state if no state exists or state has expired
 */
export function getState(chatId: string): ConversationState {
  const state = stateStore.get(chatId);

  // No state exists
  if (!state) {
    return { ...DEFAULT_STATE, lastUpdated: Date.now(), expiresAt: Date.now() + STATE_EXPIRATION_MS };
  }

  // State has expired
  if (Date.now() > state.expiresAt) {
    console.log(`[State] State expired for chat ${chatId}, resetting to IDLE`);
    stateStore.delete(chatId);
    return { ...DEFAULT_STATE, lastUpdated: Date.now(), expiresAt: Date.now() + STATE_EXPIRATION_MS };
  }

  return state;
}

/**
 * Set conversation state for a chat
 */
export function setState(
  chatId: string,
  newState: ConversationStateType,
  pendingTodo?: Partial<PendingTodoData>,
  pendingJournal?: Partial<PendingJournalData>
): ConversationState {
  const currentState = getState(chatId);
  const now = Date.now();

  const updatedState: ConversationState = {
    state: newState,
    pendingTodo: {
      ...currentState.pendingTodo,
      ...pendingTodo,
    },
    pendingJournal: {
      ...currentState.pendingJournal,
      ...pendingJournal,
    },
    lastUpdated: now,
    expiresAt: now + STATE_EXPIRATION_MS,
  };

  stateStore.set(chatId, updatedState);
  console.log(`[State] Set state for chat ${chatId}:`, {
    state: newState,
    pendingTodo: updatedState.pendingTodo,
    pendingJournal: updatedState.pendingJournal,
  });

  return updatedState;
}

/**
 * Reset conversation state to IDLE
 */
export function resetState(chatId: string): void {
  stateStore.delete(chatId);
  console.log(`[State] Reset state for chat ${chatId}`);
}

/**
 * Update pending todo data without changing state
 */
export function updatePendingTodo(chatId: string, data: Partial<PendingTodoData>): void {
  const state = getState(chatId);
  setState(chatId, state.state, data, undefined);
}

/**
 * Update pending journal data without changing state
 */
export function updatePendingJournal(chatId: string, data: Partial<PendingJournalData>): void {
  const state = getState(chatId);
  setState(chatId, state.state, undefined, data);
}

/**
 * Check if state is in an awaiting state
 */
export function isAwaitingInput(chatId: string): boolean {
  const state = getState(chatId);
  return state.state.startsWith('AWAITING_');
}

/**
 * Get human-readable state description
 */
export function getStateDescription(state: ConversationStateType): string {
  const descriptions: Record<ConversationStateType, string> = {
    IDLE: 'Ready for new commands',
    AWAITING_TODO_TITLE: 'Waiting for task title',
    AWAITING_TODO_DETAILS: 'Waiting for task details',
    AWAITING_JOURNAL_CONTENT: 'Waiting for journal content',
    CHATTING: 'In conversation',
  };
  return descriptions[state];
}

/**
 * Clean up expired states (call periodically)
 */
export function cleanupExpiredStates(): void {
  const now = Date.now();
  let cleaned = 0;

  for (const [chatId, state] of stateStore.entries()) {
    if (now > state.expiresAt) {
      stateStore.delete(chatId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[State] Cleaned up ${cleaned} expired states`);
  }
}

// Run cleanup every minute
setInterval(cleanupExpiredStates, 60 * 1000);
