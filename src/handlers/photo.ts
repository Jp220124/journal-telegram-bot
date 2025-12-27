/**
 * Photo Message Handler
 * Handles incoming photo messages for task attachments
 *
 * Use Cases:
 * 1. Photo with caption -> Create new task with photo attached
 * 2. Photo in AWAITING_TASK_PHOTO state -> Attach to selected task
 * 3. Photo without context -> Prompt user for action
 */

import TelegramBot from 'node-telegram-bot-api';
import { sendMessage, sendTypingAction, downloadPhotoFile } from '../services/telegram.js';
import { findIntegrationByChatId, addTodo } from '../services/supabase.js';
import { uploadTaskPhoto } from '../services/taskPhoto.js';
import { getState, resetState } from '../services/conversationState.js';

/**
 * Handle incoming photo message
 */
export async function handlePhotoMessage(msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id.toString();

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

  await sendTypingAction(chatId);

  // Get the largest photo (last in array - Telegram sends multiple sizes)
  const photos = msg.photo;
  if (!photos || photos.length === 0) {
    console.log('[Photo] No photos in message');
    return;
  }

  const largestPhoto = photos[photos.length - 1];
  const caption = msg.caption?.trim();

  // Check current conversation state
  const state = getState(chatId);

  if (state.state === 'AWAITING_TASK_PHOTO') {
    // User is adding photo to an existing task
    await handleAddPhotoToExistingTask(
      chatId,
      integration.user_id,
      largestPhoto.file_id,
      state.pendingTaskPhoto?.taskId,
      state.pendingTaskPhoto?.taskTitle
    );
    return;
  }

  if (caption) {
    // Caption exists - create new task with photo
    await handleCreateTaskWithPhoto(
      chatId,
      integration.user_id,
      largestPhoto.file_id,
      caption
    );
  } else {
    // No caption and not in awaiting state - prompt user
    await sendMessage(
      chatId,
      '📷 *Photo received!*\n\n' +
        'What would you like to do?\n\n' +
        '• *Send with a caption* to create a new task with this photo\n' +
        '• Say *"add photo to [task name]"* to attach to an existing task\n\n' +
        '_Or send another photo with a caption._'
    );
  }
}

/**
 * Create a new task with photo attached
 */
async function handleCreateTaskWithPhoto(
  chatId: string,
  userId: string,
  fileId: string,
  taskTitle: string
): Promise<void> {
  try {
    // 1. Create the task first
    const todo = await addTodo(userId, taskTitle, { priority: 'medium' });

    if (!todo) {
      await sendMessage(chatId, '❌ Failed to create task. Please try again.');
      return;
    }

    // 2. Download photo from Telegram
    await sendTypingAction(chatId);
    const photoData = await downloadPhotoFile(fileId);

    if (!photoData) {
      await sendMessage(
        chatId,
        `✅ Task created: *${todo.title}*\n\n` +
          '⚠️ But couldn\'t download the photo. You can try adding it again later.'
      );
      return;
    }

    // 3. Upload to Supabase Storage
    const result = await uploadTaskPhoto(
      userId,
      todo.id,
      photoData.buffer,
      photoData.mimeType,
      photoData.fileName
    );

    if (result.success) {
      await sendMessage(
        chatId,
        `✅ *Task created with photo!*\n\n` +
          `📝 ${todo.title}\n` +
          `📷 Photo attached\n\n` +
          '_View in the Daily Journal app_'
      );
      console.log(`[Photo] Created task "${todo.title}" with photo for user ${userId}`);
    } else {
      await sendMessage(
        chatId,
        `✅ Task created: *${todo.title}*\n\n` +
          `⚠️ Photo upload failed: ${result.error}\n\n` +
          '_You can try adding the photo again later._'
      );
    }
  } catch (error) {
    console.error('[Photo] Error creating task with photo:', error);
    await sendMessage(chatId, '❌ Something went wrong. Please try again.');
  }
}

/**
 * Add photo to an existing task (when in AWAITING_TASK_PHOTO state)
 */
async function handleAddPhotoToExistingTask(
  chatId: string,
  userId: string,
  fileId: string,
  taskId?: string,
  taskTitle?: string
): Promise<void> {
  // Reset state immediately
  resetState(chatId);

  if (!taskId) {
    await sendMessage(chatId, '❌ No task selected. Please try again.');
    return;
  }

  try {
    // Download photo from Telegram
    await sendTypingAction(chatId);
    const photoData = await downloadPhotoFile(fileId);

    if (!photoData) {
      await sendMessage(
        chatId,
        '❌ Couldn\'t download the photo. Please try again.'
      );
      return;
    }

    // Upload to Supabase Storage
    const result = await uploadTaskPhoto(
      userId,
      taskId,
      photoData.buffer,
      photoData.mimeType,
      photoData.fileName
    );

    if (result.success) {
      await sendMessage(
        chatId,
        `✅ *Photo added!*\n\n` +
          `📝 Task: ${taskTitle || 'Selected task'}\n` +
          `📷 Photo attached\n\n` +
          '_View in the Daily Journal app_'
      );
      console.log(`[Photo] Added photo to task "${taskTitle}" for user ${userId}`);
    } else {
      await sendMessage(
        chatId,
        `❌ Photo upload failed: ${result.error}\n\n` +
          '_Please try again._'
      );
    }
  } catch (error) {
    console.error('[Photo] Error adding photo to task:', error);
    await sendMessage(chatId, '❌ Something went wrong. Please try again.');
  }
}
