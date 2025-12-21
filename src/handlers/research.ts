/**
 * Research Handlers
 * Handle Telegram callbacks and messages related to research automation
 */

import TelegramBot from 'node-telegram-bot-api';
import { getBot, sendMessage } from '../services/telegram.js';
import {
  getResearchJob,
  updateResearchJob,
  getActiveConversation,
  updateTelegramConversation,
  getCategoryAutomation,
  createResearchJob,
  canUserStartResearch,
  incrementUserJobCount,
} from '../services/researchDatabase.js';
import { addResearchJob, resumeResearchJob } from '../services/researchQueue.js';
import { refineUnderstanding } from '../services/taskUnderstanding.js';
import { findIntegrationByChatId } from '../services/supabase.js';
import { config } from '../config/env.js';
import type { ResearchStage, ResearchJobData, TaskUnderstanding } from '../types/research.js';

const bot = getBot();

/**
 * Register research-related handlers
 */
export function registerResearchHandlers(): void {
  if (!config.isResearchEnabled) {
    console.log('⚠️ Research automation disabled (no API keys configured)');
    return;
  }

  // Handle callback queries for research focus selection
  bot.on('callback_query', handleResearchCallback);

  console.log('✅ Research handlers registered');
}

/**
 * Handle callback queries for research automation
 */
async function handleResearchCallback(query: TelegramBot.CallbackQuery): Promise<void> {
  if (!query.data || !query.data.startsWith('research_focus:')) {
    return;
  }

  const chatId = query.message?.chat.id;
  if (!chatId) return;

  // Acknowledge the callback
  await bot.answerCallbackQuery(query.id, { text: 'Processing...' });

  // Parse callback data: research_focus:<jobId>:<selection>
  const parts = query.data.split(':');
  if (parts.length !== 3) return;

  const [, researchJobId, selection] = parts;

  try {
    // Get the research job
    const researchJob = await getResearchJob(researchJobId);
    if (!researchJob) {
      await sendMessage(chatId, '❌ Research job not found or expired.');
      return;
    }

    // Get focus areas from job data
    const focusAreas = researchJob.focus_areas || [];

    let clarificationResponse: string;

    if (selection === 'custom') {
      // Ask for custom input
      await updateTelegramConversation(chatId, {
        state: 'awaiting_custom_input',
        context: {
          researchJobId,
          focusAreas,
          taskName: researchJob.interpreted_topic || 'Research',
        },
      });

      await bot.editMessageText(
        '✏️ Please type your specific focus for this research:',
        {
          chat_id: chatId,
          message_id: query.message?.message_id,
        }
      );
      return;
    } else if (selection === 'all') {
      clarificationResponse = 'comprehensive overview covering all aspects';
    } else {
      // Get the focus area by index
      const index = parseInt(selection, 10);
      if (isNaN(index) || index < 0 || index >= focusAreas.length) {
        clarificationResponse = focusAreas[0] || 'general overview';
      } else {
        clarificationResponse = focusAreas[index];
      }
    }

    // Update message to show selection
    await bot.editMessageText(
      `✅ *Selected:* ${clarificationResponse}\n\n🔬 Starting deep research... This may take a few minutes.`,
      {
        chat_id: chatId,
        message_id: query.message?.message_id,
        parse_mode: 'Markdown',
      }
    );

    // Resume the research job
    await resumeResearchWithClarification(researchJobId, clarificationResponse, researchJob);
  } catch (error) {
    console.error('Error handling research callback:', error);
    await sendMessage(
      chatId,
      '❌ An error occurred. Please try again or start a new research task.'
    );
  }
}

/**
 * Handle custom text input for research clarification
 */
export async function handleResearchTextInput(
  chatId: number,
  text: string
): Promise<boolean> {
  // Check if there's an active research conversation awaiting custom input
  const conversation = await getActiveConversation(chatId);

  if (!conversation || conversation.state !== 'awaiting_custom_input') {
    return false; // Not a research clarification input
  }

  const { researchJobId, taskName } = conversation.context as {
    researchJobId?: string;
    taskName?: string;
  };

  if (!researchJobId) {
    await updateTelegramConversation(chatId, { state: 'idle', context: {} });
    return false;
  }

  try {
    // Get the research job
    const researchJob = await getResearchJob(researchJobId);
    if (!researchJob) {
      await sendMessage(chatId, '❌ Research job not found or expired.');
      await updateTelegramConversation(chatId, { state: 'idle', context: {} });
      return true;
    }

    // Send confirmation
    await sendMessage(
      chatId,
      `✅ *Focus:* ${text}\n\n🔬 Starting deep research on *${taskName}*... This may take a few minutes.`,
      { parse_mode: 'Markdown' }
    );

    // Resume research with custom clarification
    await resumeResearchWithClarification(researchJobId, text, researchJob);

    return true;
  } catch (error) {
    console.error('Error handling research text input:', error);
    await sendMessage(chatId, '❌ An error occurred. Please try again.');
    await updateTelegramConversation(chatId, { state: 'idle', context: {} });
    return true;
  }
}

/**
 * Resume research job with clarification response
 */
async function resumeResearchWithClarification(
  researchJobId: string,
  clarificationResponse: string,
  researchJob: {
    id: string;
    task_id: string;
    user_id: string;
    telegram_chat_id?: number;
    interpreted_topic?: string;
    search_queries: string[];
    focus_areas: string[];
  }
): Promise<void> {
  // Update the research job with clarification response
  await updateResearchJob(researchJobId, {
    clarification_response: clarificationResponse,
    status: 'researching',
  });

  // Clear conversation state
  if (researchJob.telegram_chat_id) {
    await updateTelegramConversation(researchJob.telegram_chat_id, {
      state: 'idle',
      context: {},
      research_job_id: null,
    });
  }

  // Get category automation config
  const automation = await getCategoryAutomation(researchJob.task_id);

  // Create job data for queue
  const jobData: ResearchJobData = {
    researchJobId,
    taskId: researchJob.task_id,
    taskName: researchJob.interpreted_topic || 'Research',
    userId: researchJob.user_id,
    telegramChatId: researchJob.telegram_chat_id || 0,
    automationConfig: automation || {
      id: '',
      user_id: researchJob.user_id,
      category_id: '',
      automation_type: 'research',
      llm_model: 'z-ai/glm-4.5-air:free',
      research_depth: 'medium',
      ask_clarification: true,
      notification_enabled: true,
      max_sources: 10,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    clarificationResponse,
    stage: 3, // ResearchStage.RESEARCH
    understanding: {
      interpretedTopic: researchJob.interpreted_topic || '',
      searchQueries: researchJob.search_queries,
      needsClarification: false,
      suggestedFocusAreas: researchJob.focus_areas,
      confidence: 0.9,
    },
  };

  // Add to queue for processing
  await resumeResearchJob({
    researchJobId,
    clarificationResponse,
    originalJobData: jobData,
  });
}

/**
 * Trigger research for a newly created task
 * Called when a task is added to a category with research automation
 */
export async function triggerResearchForTask(params: {
  taskId: string;
  taskName: string;
  taskDescription?: string;
  categoryId: string;
  userId: string;
}): Promise<{ started: boolean; message: string }> {
  const { taskId, taskName, taskDescription, categoryId, userId } = params;

  // Check if research is enabled
  if (!config.isResearchEnabled) {
    return { started: false, message: 'Research automation not configured' };
  }

  // Check if category has automation enabled
  const automation = await getCategoryAutomation(categoryId);
  if (!automation || !automation.is_active) {
    return { started: false, message: 'No automation for this category' };
  }

  // Check if automation type is research
  if (automation.automation_type !== 'research') {
    return { started: false, message: 'Category automation is not research type' };
  }

  // Check user quota
  const canStart = await canUserStartResearch(userId);
  if (!canStart) {
    return { started: false, message: 'Daily research limit reached' };
  }

  // Get user's Telegram integration
  const integration = await getUserIntegration(userId);
  if (!integration || !integration.telegram_chat_id) {
    return { started: false, message: 'Telegram not linked' };
  }

  const telegramChatId = parseInt(integration.telegram_chat_id, 10);

  try {
    // Create research job in database
    const researchJob = await createResearchJob({
      taskId,
      userId,
      automationId: automation.id,
      telegramChatId,
    });

    if (!researchJob) {
      return { started: false, message: 'Failed to create research job' };
    }

    // Increment user's job count
    await incrementUserJobCount(userId);

    // Send initial notification
    await sendMessage(
      telegramChatId,
      `🔬 *Research Started*\n\nI'm beginning research on: *${taskName}*\n\nI'll analyze this task and may ask for clarification if needed.`,
      { parse_mode: 'Markdown' }
    );

    // Add to queue
    await addResearchJob({
      researchJobId: researchJob.id,
      taskId,
      taskName,
      taskDescription,
      userId,
      telegramChatId,
      automationConfig: automation,
    });

    return { started: true, message: 'Research job started' };
  } catch (error) {
    console.error('Error triggering research:', error);
    return { started: false, message: 'Error starting research' };
  }
}

/**
 * Get user integration from supabase service
 * (Helper to avoid circular imports)
 */
async function getUserIntegration(
  userId: string
): Promise<{ telegram_chat_id: string } | null> {
  // Import dynamically to avoid circular dependency
  const { findIntegrationByUserId } = await import('../services/supabase.js');
  const integration = await findIntegrationByUserId(userId);
  if (integration?.platform_chat_id) {
    return { telegram_chat_id: integration.platform_chat_id };
  }
  return null;
}
