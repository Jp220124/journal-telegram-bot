/**
 * Notification service - handles sending scheduled notifications
 */

import { sendMessage } from './telegram.js';
import {
  getPendingNotifications,
  markNotificationSent,
  markNotificationFailed,
  getAllVerifiedIntegrations,
  hasJournaledToday,
  calculateJournalStreak,
  getTasksDueToday,
  getWeeklySummaryData,
  getMoodTrend,
  getProductivityData,
} from './supabase.js';

/**
 * Process and send pending notifications
 */
export async function processPendingNotifications(): Promise<{ sent: number; failed: number }> {
  const notifications = await getPendingNotifications();

  let sent = 0;
  let failed = 0;

  for (const notification of notifications) {
    try {
      let message = '';

      switch (notification.notification_type) {
        case 'due_reminder':
          message = formatDueReminder(notification.todo_title || 'Unknown task', notification.scheduled_for);
          break;
        case 'daily_summary':
          message = notification.message_content || 'Here is your daily summary!';
          break;
        default:
          message = notification.message_content || 'Notification';
      }

      const result = await sendMessage(notification.chat_id, message);

      if (result) {
        await markNotificationSent(notification.notification_id);
        sent++;
      } else {
        await markNotificationFailed(notification.notification_id, 'Failed to send message');
        failed++;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await markNotificationFailed(notification.notification_id, errorMessage);
      failed++;
    }

    // Small delay to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return { sent, failed };
}

/**
 * Format a due reminder message
 */
function formatDueReminder(taskTitle: string, scheduledFor: string): string {
  const dueTime = new Date(scheduledFor);
  const timeString = dueTime.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  return `⏰ *Reminder*\n\nYour task is due soon:\n\n📋 *${taskTitle}*\n🕐 Due at ${timeString}\n\nReply "done ${taskTitle.split(' ')[0]}" to mark it complete!`;
}

/**
 * Start the notification processor (runs every minute)
 */
export function startNotificationProcessor(intervalMs: number = 60000): NodeJS.Timeout {
  console.log('Starting notification processor...');

  // Process immediately on start
  processPendingNotifications()
    .then(({ sent, failed }) => {
      if (sent > 0 || failed > 0) {
        console.log(`Notifications processed: ${sent} sent, ${failed} failed`);
      }
    })
    .catch(console.error);

  // Schedule daily briefings and streak warnings
  scheduleDailyNotifications();

  // Then process at regular intervals
  return setInterval(async () => {
    try {
      const { sent, failed } = await processPendingNotifications();
      if (sent > 0 || failed > 0) {
        console.log(`Notifications processed: ${sent} sent, ${failed} failed`);
      }
    } catch (error) {
      console.error('Error in notification processor:', error);
    }
  }, intervalMs);
}

/**
 * Schedule daily notifications (briefings, streak warnings, and weekly summaries)
 */
function scheduleDailyNotifications(): void {
  // Check time and run appropriate notifications
  const checkAndSendNotifications = async () => {
    const now = new Date();
    const hour = now.getHours();
    const dayOfWeek = now.getDay(); // 0 = Sunday

    // Morning briefing (8-9 AM)
    if (hour === 8) {
      console.log('Sending morning briefings...');
      await sendDailyBriefings();
    }

    // Evening streak warning (8-9 PM)
    if (hour === 20) {
      console.log('Checking streak warnings...');
      await sendStreakWarnings();
    }

    // Sunday weekly summary (7-8 PM)
    if (dayOfWeek === 0 && hour === 19) {
      console.log('Sending weekly summaries...');
      await sendWeeklySummaries();
    }
  };

  // Check every hour
  setInterval(checkAndSendNotifications, 60 * 60 * 1000);

  // Also check on startup
  checkAndSendNotifications();
}

/**
 * Send daily briefings to all users
 */
async function sendDailyBriefings(): Promise<void> {
  const integrations = await getAllVerifiedIntegrations();

  for (const integration of integrations) {
    try {
      // Skip if daily summary is disabled
      if (!integration.daily_summary_enabled) continue;

      // Fetch all data in parallel
      const [tasks, streak, moodTrend, productivity] = await Promise.all([
        getTasksDueToday(integration.user_id),
        calculateJournalStreak(integration.user_id),
        getMoodTrend(integration.user_id, 7),
        getProductivityData(integration.user_id, 7),
      ]);

      const message = formatDailyBriefing(
        tasks.map(t => t.title),
        streak,
        moodTrend.trend,
        productivity.overdueTasks,
        productivity.completionRate
      );
      await sendMessage(integration.platform_chat_id, message);

      console.log(`Sent daily briefing to ${integration.platform_chat_id}`);
    } catch (error) {
      console.error(`Error sending daily briefing to ${integration.platform_chat_id}:`, error);
    }

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * Send streak warning to users who haven't journaled today
 */
async function sendStreakWarnings(): Promise<void> {
  const integrations = await getAllVerifiedIntegrations();

  for (const integration of integrations) {
    try {
      // Check if user has a streak worth protecting
      const streak = await calculateJournalStreak(integration.user_id);

      // Only warn if streak is 2+ days
      if (streak < 2) continue;

      // Check if they've journaled today
      const journaledToday = await hasJournaledToday(integration.user_id);

      if (!journaledToday) {
        const message = formatStreakWarning(streak);
        await sendMessage(integration.platform_chat_id, message);
        console.log(`Sent streak warning to ${integration.platform_chat_id} (${streak} day streak)`);
      }
    } catch (error) {
      console.error(`Error sending streak warning to ${integration.platform_chat_id}:`, error);
    }

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * Format daily briefing message with insights
 */
function formatDailyBriefing(
  tasksDueToday: string[],
  streak: number,
  moodTrend: 'improving' | 'declining' | 'stable' | 'insufficient_data',
  overdueTasks: number,
  completionRate: number
): string {
  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });

  let message = `☀️ *Good Morning!*\n📅 ${date}\n\n`;

  // Streak status
  if (streak > 0) {
    const streakEmoji = streak >= 7 ? '🔥' : '⭐';
    message += `${streakEmoji} *${streak}-day journal streak!*\n\n`;
  }

  // Smart insight based on data
  const insight = generateMorningInsight(moodTrend, overdueTasks, completionRate, streak);
  if (insight) {
    message += `💡 ${insight}\n\n`;
  }

  // Tasks due today
  if (tasksDueToday.length > 0) {
    message += `*📋 Tasks Due Today (${tasksDueToday.length}):*\n`;
    tasksDueToday.slice(0, 5).forEach(task => {
      message += `• ${task}\n`;
    });
    if (tasksDueToday.length > 5) {
      message += `_...and ${tasksDueToday.length - 5} more_\n`;
    }
  } else {
    message += `✨ *No tasks due today!*\n`;
  }

  // Overdue warning
  if (overdueTasks > 0) {
    message += `\n⚠️ _${overdueTasks} overdue task${overdueTasks !== 1 ? 's' : ''} need attention_`;
  }

  message += '\n\n_Have a productive day!_ 💪';

  return message;
}

/**
 * Generate a personalized morning insight
 */
function generateMorningInsight(
  moodTrend: 'improving' | 'declining' | 'stable' | 'insufficient_data',
  overdueTasks: number,
  completionRate: number,
  streak: number
): string | null {
  // Priority order for insights (most important first)

  // High priority: Mood declining
  if (moodTrend === 'declining') {
    return "Your mood has been declining lately. Remember to take breaks and practice self-care today. 💙";
  }

  // High priority: Many overdue tasks
  if (overdueTasks >= 5) {
    return `You have ${overdueTasks} overdue tasks. Consider reviewing and reprioritizing today. 📋`;
  }

  // Positive: Great streak
  if (streak >= 7) {
    return `Amazing ${streak}-day journaling streak! You're building a great habit. 🌟`;
  }

  // Positive: Mood improving
  if (moodTrend === 'improving') {
    return "Your mood has been improving! Keep doing what's working for you. 🎉";
  }

  // Productivity feedback
  if (completionRate >= 80) {
    return "You've been crushing it with task completion! Keep up the momentum. 🚀";
  }

  if (completionRate < 40 && completionRate > 0) {
    return "Try focusing on 2-3 key tasks today. Small wins build momentum! 🎯";
  }

  // New streak motivation
  if (streak === 0) {
    return "Start a new journaling streak today - just a few words count! 📝";
  }

  return null;
}

/**
 * Format streak warning message
 */
function formatStreakWarning(streak: number): string {
  const emojis = streak >= 7 ? '🔥🔥🔥' : streak >= 3 ? '🔥' : '⭐';

  return (
    `${emojis} *Don't break your streak!*\n\n` +
    `You have a *${streak}-day* journaling streak!\n\n` +
    `📓 Take a moment to write in your journal today.\n\n` +
    `_Just send me a message starting with "Journal:" to add an entry._`
  );
}

/**
 * Send weekly summaries to all users (Sunday evening)
 */
async function sendWeeklySummaries(): Promise<void> {
  const integrations = await getAllVerifiedIntegrations();

  for (const integration of integrations) {
    try {
      const summary = await getWeeklySummaryData(integration.user_id);
      const message = formatWeeklySummary(summary);
      await sendMessage(integration.platform_chat_id, message);

      console.log(`Sent weekly summary to ${integration.platform_chat_id}`);
    } catch (error) {
      console.error(`Error sending weekly summary to ${integration.platform_chat_id}:`, error);
    }

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * Format weekly summary message
 */
function formatWeeklySummary(summary: {
  tasksCompleted: number;
  tasksCreated: number;
  journalEntries: number;
  notesCreated: number;
  topMood: string | null;
  currentStreak: number;
}): string {
  let message = `📊 *Weekly Summary*\n\n`;
  message += `_Here's your week at a glance:_\n\n`;

  // Task stats
  const completionRate = summary.tasksCreated > 0
    ? Math.round((summary.tasksCompleted / summary.tasksCreated) * 100)
    : 0;

  message += `*Tasks*\n`;
  message += `✅ Completed: ${summary.tasksCompleted}\n`;
  message += `📝 Created: ${summary.tasksCreated}\n`;
  if (summary.tasksCreated > 0) {
    message += `📈 Completion rate: ${completionRate}%\n`;
  }
  message += `\n`;

  // Journal stats
  message += `*Journaling*\n`;
  message += `📓 Entries: ${summary.journalEntries}\n`;
  if (summary.currentStreak > 0) {
    const streakEmoji = summary.currentStreak >= 7 ? '🔥' : '⭐';
    message += `${streakEmoji} Streak: ${summary.currentStreak} days\n`;
  }
  if (summary.topMood) {
    const moodEmojis: Record<string, string> = {
      great: '😊',
      good: '🙂',
      okay: '😐',
      bad: '😔',
      terrible: '😢',
    };
    message += `💭 Most common mood: ${moodEmojis[summary.topMood] || ''} ${summary.topMood}\n`;
  }
  message += `\n`;

  // Notes stats
  if (summary.notesCreated > 0) {
    message += `*Notes*\n`;
    message += `📝 Created: ${summary.notesCreated}\n\n`;
  }

  // Motivational footer
  if (summary.tasksCompleted >= 10) {
    message += `🌟 _Fantastic productivity this week!_`;
  } else if (summary.journalEntries >= 5) {
    message += `📔 _Great journaling consistency!_`;
  } else if (summary.currentStreak >= 7) {
    message += `🔥 _Amazing streak! Keep it up!_`;
  } else {
    message += `💪 _Keep going strong next week!_`;
  }

  return message;
}
