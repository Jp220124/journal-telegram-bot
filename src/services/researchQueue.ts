/**
 * Research Queue Service
 * Manages BullMQ queue for background research jobs
 */

import { Queue, QueueEvents } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import type {
  ResearchJobData,
  ResearchJobResult,
  CategoryAutomation,
} from '../types/research.js';

// Queue name
const QUEUE_NAME = 'research-automation';

// Create the research queue
export const researchQueue = new Queue<ResearchJobData, ResearchJobResult>(
  QUEUE_NAME,
  {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: {
        age: 24 * 60 * 60, // Keep completed jobs for 24 hours
        count: 100, // Keep last 100 completed jobs
      },
      removeOnFail: {
        age: 7 * 24 * 60 * 60, // Keep failed jobs for 7 days
        count: 50, // Keep last 50 failed jobs
      },
    },
  }
);

// Queue events for monitoring
export const researchQueueEvents = new QueueEvents(QUEUE_NAME, {
  connection: redisConnection,
});

// Log queue events
researchQueueEvents.on('completed', ({ jobId, returnvalue }) => {
  console.log(`✅ Research job ${jobId} completed:`, returnvalue);
});

researchQueueEvents.on('failed', ({ jobId, failedReason }) => {
  console.error(`❌ Research job ${jobId} failed:`, failedReason);
});

researchQueueEvents.on('progress', ({ jobId, data }) => {
  console.log(`📊 Research job ${jobId} progress:`, data);
});

/**
 * Add a research job to the queue
 */
export async function addResearchJob(params: {
  researchJobId: string;
  taskId: string;
  taskName: string;
  taskDescription?: string;
  userId: string;
  telegramChatId: number;
  automationConfig: CategoryAutomation;
}): Promise<string> {
  const job = await researchQueue.add(
    'research-task',
    {
      researchJobId: params.researchJobId,
      taskId: params.taskId,
      taskName: params.taskName,
      taskDescription: params.taskDescription,
      userId: params.userId,
      telegramChatId: params.telegramChatId,
      automationConfig: params.automationConfig,
    },
    {
      jobId: params.researchJobId, // Use database ID as job ID for easy tracking
    }
  );

  console.log(`📥 Added research job to queue: ${job.id}`);
  return job.id || params.researchJobId;
}

/**
 * Resume a paused research job with clarification response
 */
export async function resumeResearchJob(params: {
  researchJobId: string;
  clarificationResponse: string;
  originalJobData: ResearchJobData;
}): Promise<string> {
  const job = await researchQueue.add(
    'research-resume',
    {
      ...params.originalJobData,
      clarificationResponse: params.clarificationResponse,
      stage: 3, // Skip to RESEARCH stage
    },
    {
      jobId: `${params.researchJobId}-resume-${Date.now()}`,
    }
  );

  console.log(`📥 Resumed research job: ${job.id}`);
  return job.id || params.researchJobId;
}

/**
 * Get job status
 */
export async function getJobStatus(
  jobId: string
): Promise<{
  state: string;
  progress: number;
  data: ResearchJobData | null;
  result: ResearchJobResult | null;
  error: string | null;
} | null> {
  const job = await researchQueue.getJob(jobId);
  if (!job) return null;

  const state = await job.getState();
  const progress =
    typeof job.progress === 'number' ? job.progress : (job.progress as { percentage?: number })?.percentage || 0;

  return {
    state,
    progress,
    data: job.data,
    result: job.returnvalue || null,
    error: job.failedReason || null,
  };
}

/**
 * Cancel a pending research job
 */
export async function cancelResearchJob(jobId: string): Promise<boolean> {
  const job = await researchQueue.getJob(jobId);
  if (!job) return false;

  const state = await job.getState();
  if (state === 'waiting' || state === 'delayed') {
    await job.remove();
    return true;
  }

  return false;
}

/**
 * Get queue statistics
 */
export async function getQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    researchQueue.getWaitingCount(),
    researchQueue.getActiveCount(),
    researchQueue.getCompletedCount(),
    researchQueue.getFailedCount(),
    researchQueue.getDelayedCount(),
  ]);

  return { waiting, active, completed, failed, delayed };
}

/**
 * Get active jobs for a user
 */
export async function getActiveJobsForUser(
  userId: string
): Promise<ResearchJobData[]> {
  const [waitingJobs, activeJobs] = await Promise.all([
    researchQueue.getWaiting(),
    researchQueue.getActive(),
  ]);

  const allJobs = [...waitingJobs, ...activeJobs];
  return allJobs.filter((job) => job.data.userId === userId).map((job) => job.data);
}

/**
 * Pause the queue (for maintenance)
 */
export async function pauseQueue(): Promise<void> {
  await researchQueue.pause();
  console.log('⏸️ Research queue paused');
}

/**
 * Resume the queue
 */
export async function resumeQueue(): Promise<void> {
  await researchQueue.resume();
  console.log('▶️ Research queue resumed');
}

/**
 * Clean old jobs
 */
export async function cleanOldJobs(gracePeriodMs: number = 7 * 24 * 60 * 60 * 1000): Promise<void> {
  await Promise.all([
    researchQueue.clean(gracePeriodMs, 100, 'completed'),
    researchQueue.clean(gracePeriodMs, 50, 'failed'),
  ]);
  console.log('🧹 Cleaned old research jobs');
}

/**
 * Close the queue (for graceful shutdown)
 */
export async function closeQueue(): Promise<void> {
  await researchQueueEvents.close();
  await researchQueue.close();
  console.log('👋 Research queue closed');
}
