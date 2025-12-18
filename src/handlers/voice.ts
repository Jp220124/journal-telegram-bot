/**
 * Voice message handler - transcribes voice messages and processes them
 */

import TelegramBot from 'node-telegram-bot-api';
import { sendMessage, sendTypingAction, downloadVoiceFile } from '../services/telegram.js';
import { transcribeAudio } from '../services/groq.js';
import { parseIntent } from '../services/gemini.js';
import { findIntegrationByChatId, saveMessageHistory, getRecentMessages } from '../services/supabase.js';
import { handleTextMessage } from './message.js';

/**
 * Handle incoming voice message
 */
export async function handleVoiceMessage(msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id.toString();
  const voice = msg.voice;

  if (!voice) return;

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

  // Get recent messages for context
  const recentMessages = await getRecentMessages(integration.user_id, 5);
  const context = recentMessages.map((m) => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant' as const,
    content: m.original_content || m.transcription || '',
  }));

  // Parse intent
  const intent = await parseIntent(transcription, context);

  // Execute the appropriate action
  const { executeIntent } = await import('./message.js');
  let response: string;

  try {
    switch (intent.intent) {
      case 'add_todo':
        const { addTodo } = await import('../services/supabase.js');
        const todo = await addTodo(integration.user_id, intent.parameters.title!, {
          priority: (intent.parameters.priority as 'low' | 'medium' | 'high') || 'medium',
          due_date: intent.parameters.due_date,
          due_time: intent.parameters.due_time,
          category: intent.parameters.category,
        });
        if (todo) {
          response = `✅ Task added: *${todo.title}*`;
          if (todo.due_date) {
            response += `\n📅 Due: ${todo.due_date}`;
            if (todo.due_time) response += ` at ${todo.due_time}`;
          }
        } else {
          response = '❌ Failed to add task.';
        }
        break;

      case 'query_todos':
        const { executeQueryTodos } = await import('./message.js');
        response = await executeQueryTodos(chatId, integration.user_id, intent.parameters);
        break;

      case 'mark_complete':
        const { markTodoComplete } = await import('../services/supabase.js');
        const result = await markTodoComplete(integration.user_id, intent.parameters.task_identifier!);
        response = result.success
          ? `✅ Done! *${result.todo?.title}* marked complete. 🎉`
          : `❌ ${result.message}`;
        break;

      case 'add_journal':
        const { addJournalContent } = await import('../services/supabase.js');
        const journalResult = await addJournalContent(integration.user_id, intent.parameters.content!, {
          mood: intent.parameters.mood,
        });
        response = journalResult.success ? '📓 Journal entry saved!' : `❌ ${journalResult.message}`;
        break;

      case 'general_chat':
      default:
        response = intent.parameters.response || "I'm not sure how to help with that.";
    }
  } catch (error) {
    console.error('Error processing voice intent:', error);
    response = "Sorry, I couldn't process that. Please try again.";
  }

  // Send response
  await sendMessage(chatId, response);

  // Save to message history
  const processingTime = Date.now() - startTime;
  await saveMessageHistory(integration.id, integration.user_id, 'inbound', 'voice', null, {
    transcription,
    aiIntent: intent.intent,
    aiResponse: response,
    processingTimeMs: processingTime,
  });
}
