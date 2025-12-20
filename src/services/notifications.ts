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
 * Schedule daily notifications (briefings and streak warnings)
 */
function scheduleDailyNotifications(): void {
  // Check time and run appropriate notifications
  const checkAndSendNotifications = async () => {
    const now = new Date();
    const hour = now.getHours();

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

      const tasks = await getTasksDueToday(integration.user_id);
      const streak = await calculateJournalStreak(integration.user_id);

      const message = formatDailyBriefing(tasks.map(t => t.title), streak);
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
 * Format daily briefing message
 */
function formatDailyBriefing(tasksDueToday: string[], streak: number): string {
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

  message += '\n_Have a productive day!_ 💪';

  return message;
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
