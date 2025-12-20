/**
 * Voice message handler - transcribes voice messages and processes them
 * Uses conversation state machine for multi-turn interactions
 */

import TelegramBot from 'node-telegram-bot-api';
import { sendMessage, sendTypingAction, downloadVoiceFile } from '../services/telegram.js';
import { transcribeAudio } from '../services/groq.js';
import { parseIntent } from '../services/gemini.js';
import {
  findIntegrationByChatId,
  saveMessageHistory,
  addTodo,
  addJournalContent,
  getUserCategories,
  getRecentMessages,
} from '../services/supabase.js';
import { executeIntent, executeQueryTodos } from './message.js';
import { config } from '../config/env.js';
import {
  getState,
  setState,
  resetState,
} from '../services/conversationState.js';

/**
 * Handle incoming voice message with state machine support
 */
export async function handleVoiceMessage(msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id.toString();
  const voice = msg.voice;

  if (!voice) return;

  // Check if voice transcription is enabled
  if (!config.groqApiKey) {
    await sendMessage(
      chatId,
      "🎤 Voice messages are not currently enabled.\n\n" +
        'Please send a text message instead.'
    );
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

  // Download the voice file
  const audioBuffer = await downloadVoiceFile(voice.file_id);

  if (!audioBuffer) {
    await sendMessage(chatId, "❌ Couldn't download the voice message. Please try again.");
    return;
  }

  // Transcribe using Groq Whisper
  const transcription = await transcribeAudio(audioBuffer);

  if (!transcription) {
    await sendMessage(
      chatId,
      "❌ Couldn't transcribe your voice message.\n\n" +
        'Please try again or send a text message instead.'
    );
    return;
  }

  // Send transcription confirmation
  await sendMessage(chatId, `🎤 I heard: _"${transcription}"_`);

  // Process the transcribed text
  await sendTypingAction(chatId);

  // Get current conversation state
  const conversationState = getState(chatId);
  let response: string;
  let intentForHistory = 'state_continuation';

  try {
    // Handle based on current state
    switch (conversationState.state) {
      case 'AWAITING_TODO_TITLE':
        // Voice message IS the task title - no AI parsing needed
        response = await handleAwaitingTodoTitle(
          chatId,
          integration.user_id,
          transcription,
          conversationState.pendingTodo
        );
        intentForHistory = 'add_todo';
        break;

      case 'AWAITING_JOURNAL_CONTENT':
        // Voice message IS the journal content - no AI parsing needed
        response = await handleAwaitingJournalContent(
          chatId,
          integration.user_id,
          transcription,
          conversationState.pendingJournal
        );
        intentForHistory = 'add_journal';
        break;

      case 'IDLE':
      default:
        // Fetch user's custom categories for dynamic category support
        const userCategories = await getUserCategories(integration.user_id);

        // Fetch recent messages for conversation context
        const recentMessages = await getRecentMessages(integration.user_id, 5);
        const conversationContext = recentMessages
          .filter(msg => msg.original_content || msg.ai_response)
          .map(msg => ({
            role: msg.direction === 'inbound' ? 'user' as const : 'assistant' as const,
            content: msg.direction === 'inbound'
              ? (msg.original_content || msg.transcription || '')
              : (msg.ai_response || ''),
          }))
          .filter(msg => msg.content.length > 0);

        // Parse intent with AI (using dynamic categories and context)
        const intent = await parseIntent(transcription, userCategories, conversationContext);
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
    console.error('Error processing voice intent:', error);
    response = "Sorry, I couldn't process that. Please try again.";
    resetState(chatId);
  }

  // Send response
  await sendMessage(chatId, response);

  // Save to message history
  const processingTime = Date.now() - startTime;
  await saveMessageHistory(integration.id, integration.user_id, 'inbound', 'voice', null, {
    transcription,
    aiIntent: intentForHistory,
    aiResponse: response,
    processingTimeMs: processingTime,
  });
}

/**
 * Handle voice message when awaiting todo title
 */
async function handleAwaitingTodoTitle(
  chatId: string,
  userId: string,
  title: string,
  pendingData: { category?: string; priority?: 'low' | 'medium' | 'high'; due_date?: string; due_time?: string }
): Promise<string> {
  console.log('[Voice State Handler] Processing awaited todo title:', { title, pendingData });

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
 * Handle voice message when awaiting journal content
 */
async function handleAwaitingJournalContent(
  chatId: string,
  userId: string,
  content: string,
  pendingData: { mood?: string; date?: string }
): Promise<string> {
  console.log('[Voice State Handler] Processing awaited journal content:', { contentLength: content.length, pendingData });

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
 * Handle incomplete intent from voice - set state and ask for missing data
 */
async function handleIncompleteIntent(chatId: string, intent: ReturnType<typeof parseIntent> extends Promise<infer T> ? T : never): Promise<string> {
  console.log('[Voice State Handler] Handling incomplete intent:', intent);

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
      askMessage += '?\n\n_Send the task title (text or voice), or /cancel to abort._';
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
      journalAsk += '?\n\n_Send your journal entry (text or voice), or /cancel to abort._';
      return journalAsk;

    case 'mark_complete':
      // No task identifier
      return "❓ Which task would you like to mark as complete?\n\nPlease tell me the task name.";

    default:
      return params.response || "I'm not sure how to help with that.";
  }
}
