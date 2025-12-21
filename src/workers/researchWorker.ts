/**
 * Research Worker
 * BullMQ worker that processes research jobs through multiple stages
 */

import { Worker, Job } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import {
  ResearchStage,
  type ResearchJobStatus,
  type ResearchJobData,
  type ResearchJobResult,
  type TaskUnderstanding,
  type ResearchData,
  type GeneratedNote,
} from '../types/research.js';

// Services
import { understandTask, refineUnderstanding } from '../services/taskUnderstanding.js';
import { performDeepResearch } from '../services/researchEngine.js';
import { synthesizeResearchNote, generateNoteSummary } from '../services/noteSynthesis.js';
import {
  updateResearchJob,
  getResearchJob,
  createResearchNote,
  linkNoteToTask,
  updateTelegramConversation,
} from '../services/researchDatabase.js';
import { sendMessage } from '../services/telegram.js';

// Queue name (must match researchQueue.ts)
const QUEUE_NAME = 'research-automation';

/**
 * Get status string from stage number
 */
function getStatusFromStage(stage: ResearchStage): ResearchJobStatus {
  const statusMap: Record<ResearchStage, ResearchJobStatus> = {
    [ResearchStage.UNDERSTAND]: 'understanding',
    [ResearchStage.CLARIFY]: 'awaiting_clarification',
    [ResearchStage.RESEARCH]: 'researching',
    [ResearchStage.SYNTHESIZE]: 'synthesizing',
    [ResearchStage.NOTIFY]: 'completed',
    [ResearchStage.COMPLETE]: 'completed',
  };
  return statusMap[stage] || 'pending';
}

/**
 * Send clarification question via Telegram
 */
async function sendClarificationQuestion(
  telegramChatId: number,
  researchJobId: string,
  question: string,
  focusAreas: string[]
): Promise<number | null> {
  // Build inline keyboard with focus area options
  const keyboard = {
    inline_keyboard: [
      ...focusAreas.slice(0, 4).map((area, i) => [
        {
          text: area,
          callback_data: `research_focus:${researchJobId}:${i}`,
        },
      ]),
      [
        {
          text: '📋 All of the above',
          callback_data: `research_focus:${researchJobId}:all`,
        },
      ],
      [
        {
          text: '✏️ Let me specify...',
          callback_data: `research_focus:${researchJobId}:custom`,
        },
      ],
    ],
  };

  const message = `🔬 *Research Clarification Needed*\n\n${question}\n\nSelect a focus area or specify your own:`;

  try {
    const result = await sendMessage(telegramChatId, message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });

    return result?.message_id || null;
  } catch (error) {
    console.error('Failed to send clarification question:', error);
    return null;
  }
}

/**
 * Send completion notification via Telegram
 */
async function sendCompletionNotification(
  telegramChatId: number,
  taskName: string,
  note: GeneratedNote,
  noteId: string
): Promise<void> {
  const summary = await generateNoteSummary(note, 400);

  const message = `✅ *Research Complete!*

📚 *Topic:* ${taskName}

📝 *Summary:*
${summary}

📊 *Sources:* ${note.sources.length} sources analyzed

The full research note has been attached to your task.`;

  try {
    await sendMessage(telegramChatId, message, {
      parse_mode: 'Markdown',
    });
  } catch (error) {
    console.error('Failed to send completion notification:', error);
  }
}

/**
 * Send error notification via Telegram
 */
async function sendErrorNotification(
  telegramChatId: number,
  taskName: string,
  error: string
): Promise<void> {
  const message = `❌ *Research Failed*

📚 *Topic:* ${taskName}

⚠️ *Error:* ${error}

Please try again or contact support if the issue persists.`;

  try {
    await sendMessage(telegramChatId, message, {
      parse_mode: 'Markdown',
    });
  } catch (err) {
    console.error('Failed to send error notification:', err);
  }
}

/**
 * Process a research job through all stages
 */
async function processResearchJob(
  job: Job<ResearchJobData, ResearchJobResult>
): Promise<ResearchJobResult> {
  const {
    researchJobId,
    taskId,
    taskName,
    taskDescription,
    userId,
    telegramChatId,
    automationConfig,
    clarificationResponse,
    stage: resumeStage,
    understanding: existingUnderstanding,
    researchData: existingResearchData,
  } = job.data;

  let stage = resumeStage || ResearchStage.UNDERSTAND;
  let understanding: TaskUnderstanding | undefined = existingUnderstanding;
  let researchData: ResearchData | undefined = existingResearchData;
  let generatedNote: GeneratedNote | undefined;
  let noteId: string | undefined;

  console.log(`🚀 Processing research job ${researchJobId} at stage ${stage}`);

  try {
    // Update job as started
    await updateResearchJob(researchJobId, {
      started_at: new Date().toISOString(),
      bullmq_job_id: job.id || undefined,
    });

    while (stage !== ResearchStage.COMPLETE) {
      // Update status in database
      await updateResearchJob(researchJobId, {
        status: getStatusFromStage(stage),
        current_stage: stage,
      });

      // Update job progress
      await job.updateProgress({
        stage,
        stageName: ResearchStage[stage],
        percentage: (stage / ResearchStage.COMPLETE) * 100,
      });

      switch (stage) {
        // ========================================
        // STAGE 1: UNDERSTAND THE TASK
        // ========================================
        case ResearchStage.UNDERSTAND: {
          console.log(`📖 Stage 1: Understanding task "${taskName}"`);

          understanding = await understandTask(taskName, taskDescription);

          // Save understanding to database
          await updateResearchJob(researchJobId, {
            interpreted_topic: understanding.interpretedTopic,
            focus_areas: understanding.suggestedFocusAreas,
            search_queries: understanding.searchQueries,
          });

          // Check if clarification is needed
          if (understanding.needsClarification && automationConfig.ask_clarification) {
            stage = ResearchStage.CLARIFY;
          } else {
            // Skip clarification, go to research
            stage = ResearchStage.RESEARCH;
          }
          break;
        }

        // ========================================
        // STAGE 2: ASK FOR CLARIFICATION
        // ========================================
        case ResearchStage.CLARIFY: {
          console.log(`❓ Stage 2: Sending clarification question`);

          if (!understanding) {
            throw new Error('No understanding data for clarification');
          }

          // Send Telegram message with inline keyboard
          const messageId = await sendClarificationQuestion(
            telegramChatId,
            researchJobId,
            understanding.clarificationQuestion || 'What would you like me to focus on?',
            understanding.suggestedFocusAreas
          );

          // Calculate timeout
          const timeoutHours = automationConfig.ask_clarification ? 24 : 1;
          const timeoutAt = new Date(Date.now() + timeoutHours * 60 * 60 * 1000);

          // Update database with clarification state
          await updateResearchJob(researchJobId, {
            status: 'awaiting_clarification',
            clarification_question: understanding.clarificationQuestion,
            clarification_sent_at: new Date().toISOString(),
            clarification_timeout_at: timeoutAt.toISOString(),
            telegram_message_id: messageId || undefined,
          });

          // Update conversation state
          await updateTelegramConversation(telegramChatId, {
            research_job_id: researchJobId,
            state: 'awaiting_clarification',
            context: {
              focusAreas: understanding.suggestedFocusAreas,
              researchJobId,
              taskName,
            },
            expires_at: timeoutAt.toISOString(),
          });

          // Return - job will be resumed when user responds
          console.log(`⏸️ Waiting for clarification response...`);
          return {
            status: 'awaiting_clarification',
            stage: ResearchStage.CLARIFY,
          };
        }

        // ========================================
        // STAGE 3: PERFORM RESEARCH
        // ========================================
        case ResearchStage.RESEARCH: {
          console.log(`🔬 Stage 3: Performing deep research`);

          if (!understanding) {
            throw new Error('No understanding data for research');
          }

          // Refine understanding if we have clarification
          if (clarificationResponse) {
            understanding = await refineUnderstanding(
              taskName,
              understanding,
              clarificationResponse
            );

            await updateResearchJob(researchJobId, {
              clarification_response: clarificationResponse,
              search_queries: understanding.searchQueries,
            });
          }

          // Perform research
          researchData = await performDeepResearch(
            understanding.searchQueries,
            automationConfig.research_depth
          );

          // Save research data
          await updateResearchJob(researchJobId, {
            status: 'synthesizing',
            raw_research_data: researchData,
            sources_used: researchData.results.map((r) => ({
              title: r.title,
              url: r.url,
            })),
          });

          stage = ResearchStage.SYNTHESIZE;
          break;
        }

        // ========================================
        // STAGE 4: SYNTHESIZE INTO NOTE
        // ========================================
        case ResearchStage.SYNTHESIZE: {
          console.log(`📝 Stage 4: Synthesizing research note`);

          if (!researchData) {
            throw new Error('No research data for synthesis');
          }

          // Generate the note
          generatedNote = await synthesizeResearchNote(
            taskName,
            researchData,
            understanding?.suggestedFocusAreas || []
          );

          // Save note to database
          const createdNoteId = await createResearchNote({
            userId,
            title: generatedNote.title,
            content: generatedNote.content,
            researchJobId,
            sources: generatedNote.sources,
          });

          if (!createdNoteId) {
            throw new Error('Failed to create research note');
          }
          noteId = createdNoteId;

          // Link note to task
          await linkNoteToTask(taskId, noteId);

          // Update research job with note ID
          await updateResearchJob(researchJobId, {
            generated_note_id: noteId,
          });

          stage = ResearchStage.NOTIFY;
          break;
        }

        // ========================================
        // STAGE 5: SEND NOTIFICATION
        // ========================================
        case ResearchStage.NOTIFY: {
          console.log(`📨 Stage 5: Sending completion notification`);

          if (automationConfig.notification_enabled && generatedNote && noteId) {
            await sendCompletionNotification(
              telegramChatId,
              taskName,
              generatedNote,
              noteId
            );
          }

          // Clear conversation state
          await updateTelegramConversation(telegramChatId, {
            research_job_id: null,
            state: 'idle',
            context: {},
            expires_at: null,
          });

          // Mark job as completed
          await updateResearchJob(researchJobId, {
            status: 'completed',
            completed_at: new Date().toISOString(),
          });

          stage = ResearchStage.COMPLETE;
          break;
        }
      }
    }

    console.log(`✅ Research job ${researchJobId} completed successfully`);

    return {
      status: 'completed',
      noteId,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`❌ Research job ${researchJobId} failed:`, errorMessage);

    // Update job as failed
    await updateResearchJob(researchJobId, {
      status: 'failed',
      error_message: errorMessage,
    });

    // Notify user of failure
    await sendErrorNotification(telegramChatId, taskName, errorMessage);

    throw error;
  }
}

// Create the worker
export const researchWorker = new Worker<ResearchJobData, ResearchJobResult>(
  QUEUE_NAME,
  processResearchJob,
  {
    connection: redisConnection,
    concurrency: 2, // Process 2 jobs at a time
    limiter: {
      max: 10, // Max 10 jobs
      duration: 60000, // Per minute
    },
  }
);

// Worker event handlers
researchWorker.on('completed', (job, result) => {
  console.log(`✅ Worker completed job ${job.id}:`, result);
});

researchWorker.on('failed', (job, error) => {
  console.error(`❌ Worker failed job ${job?.id}:`, error.message);
});

researchWorker.on('error', (error) => {
  console.error('❌ Worker error:', error);
});

researchWorker.on('stalled', (jobId) => {
  console.warn(`⚠️ Job ${jobId} stalled`);
});

/**
 * Start the worker
 */
export function startResearchWorker(): void {
  console.log('🚀 Research worker started');
}

/**
 * Stop the worker gracefully
 */
export async function stopResearchWorker(): Promise<void> {
  await researchWorker.close();
  console.log('👋 Research worker stopped');
}
