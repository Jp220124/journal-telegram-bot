/**
 * Research API Routes
 * Endpoints for web app to interact with research automation
 */

import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { config } from '../config/env.js';
import {
  getResearchJob,
  getPendingResearchJobs,
  createResearchJob,
  getCategoryAutomation,
  canUserStartResearch,
  incrementUserJobCount,
  getUserQuota,
} from '../services/researchDatabase.js';
import { addResearchJob, getJobStatus, getQueueStats } from '../services/researchQueue.js';

const router = Router();

// Supabase client for auth verification
const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey);

/**
 * Middleware to verify auth token from web app
 */
async function authenticateRequest(req: Request, res: Response, next: Function) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.substring(7);

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Attach user to request
    (req as any).user = user;
    next();
  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * GET /api/research/status
 * Check if research is enabled and get configuration
 */
router.get('/api/research/status', (req: Request, res: Response) => {
  res.json({
    enabled: config.isResearchEnabled,
    features: {
      exa: Boolean(config.exaApiKey),
      tavily: Boolean(config.tavilyApiKey),
    },
  });
});

/**
 * GET /api/research/jobs
 * Get all research jobs for the authenticated user
 */
router.get('/api/research/jobs', authenticateRequest, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    // Get all jobs (not just pending)
    const { data, error } = await supabase
      .from('research_jobs')
      .select(`
        *,
        todos (id, title, category_id),
        notes (id, title)
      `)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('Error fetching research jobs:', error);
      return res.status(500).json({ error: 'Failed to fetch research jobs' });
    }

    res.json({ jobs: data || [] });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/research/jobs/:jobId
 * Get a specific research job with details
 */
router.get('/api/research/jobs/:jobId', authenticateRequest, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { jobId } = req.params;

    const { data, error } = await supabase
      .from('research_jobs')
      .select(`
        *,
        todos (id, title, category_id, notes),
        notes!research_jobs_generated_note_id_fkey (id, title, content, content_text, sources, created_at)
      `)
      .eq('id', jobId)
      .eq('user_id', user.id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Research job not found' });
    }

    // Also get BullMQ job status if available
    let queueStatus = null;
    if (data.bullmq_job_id) {
      queueStatus = await getJobStatus(data.bullmq_job_id);
    }

    res.json({
      job: data,
      queueStatus,
    });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/research/trigger
 * Trigger research for a task
 */
router.post('/api/research/trigger', authenticateRequest, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { taskId, taskName, taskDescription, categoryId } = req.body;

    if (!taskId || !taskName) {
      return res.status(400).json({ error: 'taskId and taskName are required' });
    }

    // Check if research is enabled
    if (!config.isResearchEnabled) {
      return res.status(503).json({ error: 'Research automation is not enabled' });
    }

    // Check user quota
    const canStart = await canUserStartResearch(user.id);
    if (!canStart) {
      return res.status(429).json({ error: 'Daily research limit reached' });
    }

    // Get automation config (if category has one)
    let automationConfig = null;
    if (categoryId) {
      automationConfig = await getCategoryAutomation(categoryId);
    }

    // Use default config if no category automation
    const finalConfig = automationConfig || {
      id: '',
      user_id: user.id,
      category_id: categoryId || '',
      automation_type: 'research',
      llm_model: 'z-ai/glm-4.5-air:free',
      research_depth: 'medium',
      ask_clarification: false, // Don't ask clarification for web-triggered research
      notification_enabled: true,
      max_sources: 10,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // Create research job in database
    const researchJob = await createResearchJob({
      taskId,
      userId: user.id,
      automationId: automationConfig?.id,
      telegramChatId: undefined, // No Telegram for web-triggered research
    });

    if (!researchJob) {
      return res.status(500).json({ error: 'Failed to create research job' });
    }

    // Increment user's job count
    await incrementUserJobCount(user.id);

    // Add to queue
    await addResearchJob({
      researchJobId: researchJob.id,
      taskId,
      taskName,
      taskDescription,
      userId: user.id,
      telegramChatId: 0, // No Telegram notifications for web
      automationConfig: finalConfig,
    });

    res.json({
      success: true,
      jobId: researchJob.id,
      message: 'Research job started',
    });
  } catch (err) {
    console.error('Error triggering research:', err);
    res.status(500).json({ error: 'Failed to trigger research' });
  }
});

/**
 * GET /api/research/quota
 * Get user's research quota for today
 */
router.get('/api/research/quota', authenticateRequest, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    const quota = await getUserQuota(user.id);
    const canStart = await canUserStartResearch(user.id);

    res.json({
      quota: quota || {
        jobs_today: 0,
        max_jobs_per_day: 10,
        total_jobs_all_time: 0,
      },
      canStartNew: canStart,
    });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/research/queue-stats
 * Get queue statistics (admin/debug)
 */
router.get('/api/research/queue-stats', authenticateRequest, async (req: Request, res: Response) => {
  try {
    if (!config.isResearchEnabled) {
      return res.json({ enabled: false });
    }

    const stats = await getQueueStats();
    res.json({ enabled: true, stats });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/research/task/:taskId/notes
 * Get research notes linked to a task
 */
router.get('/api/research/task/:taskId/notes', authenticateRequest, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { taskId } = req.params;

    // Get linked notes via task_note_links
    const { data, error } = await supabase
      .from('task_note_links')
      .select(`
        note_id,
        link_type,
        created_at,
        notes (
          id,
          title,
          content_text,
          source_type,
          sources,
          research_job_id,
          created_at
        )
      `)
      .eq('task_id', taskId);

    if (error) {
      console.error('Error fetching linked notes:', error);
      return res.status(500).json({ error: 'Failed to fetch linked notes' });
    }

    // Filter to only include notes the user owns
    const notes = (data || [])
      .filter((d: any) => d.notes)
      .map((d: any) => ({
        ...d.notes,
        link_type: d.link_type,
        linked_at: d.created_at,
      }));

    res.json({ notes });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/research/automations
 * Get all category automations for the user
 */
router.get('/api/research/automations', authenticateRequest, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    const { data, error } = await supabase
      .from('category_automations')
      .select(`
        *,
        task_categories (id, name, color, icon)
      `)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching automations:', error);
      return res.status(500).json({ error: 'Failed to fetch automations' });
    }

    res.json({ automations: data || [] });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/research/automations
 * Create a new category automation
 */
router.post('/api/research/automations', authenticateRequest, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const {
      categoryId,
      automationType = 'research',
      llmModel = 'z-ai/glm-4.5-air:free',
      researchDepth = 'medium',
      askClarification = true,
      notificationEnabled = true,
      maxSources = 10,
    } = req.body;

    if (!categoryId) {
      return res.status(400).json({ error: 'categoryId is required' });
    }

    const { data, error } = await supabase
      .from('category_automations')
      .insert({
        user_id: user.id,
        category_id: categoryId,
        automation_type: automationType,
        llm_model: llmModel,
        research_depth: researchDepth,
        ask_clarification: askClarification,
        notification_enabled: notificationEnabled,
        max_sources: maxSources,
        is_active: true,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Automation already exists for this category' });
      }
      console.error('Error creating automation:', error);
      return res.status(500).json({ error: 'Failed to create automation' });
    }

    res.json({ automation: data });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/research/automations/:id
 * Update a category automation
 */
router.put('/api/research/automations/:id', authenticateRequest, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { id } = req.params;
    const updates = req.body;

    // Only allow certain fields to be updated
    const allowedFields = ['llm_model', 'research_depth', 'ask_clarification', 'notification_enabled', 'max_sources', 'is_active'];
    const filteredUpdates: Record<string, any> = {};

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        filteredUpdates[field] = updates[field];
      }
    }

    const { data, error } = await supabase
      .from('category_automations')
      .update(filteredUpdates)
      .eq('id', id)
      .eq('user_id', user.id)
      .select()
      .single();

    if (error) {
      console.error('Error updating automation:', error);
      return res.status(500).json({ error: 'Failed to update automation' });
    }

    res.json({ automation: data });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/research/automations/:id
 * Delete a category automation
 */
router.delete('/api/research/automations/:id', authenticateRequest, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { id } = req.params;

    const { error } = await supabase
      .from('category_automations')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);

    if (error) {
      console.error('Error deleting automation:', error);
      return res.status(500).json({ error: 'Failed to delete automation' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
