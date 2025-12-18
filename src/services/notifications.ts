/**
 * Notification service - handles sending scheduled notifications
 */

import { sendMessage } from './telegram.js';
import { getPendingNotifications, markNotificationSent, markNotificationFailed } from './supabase.js';

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
