/**
 * Task Photo Service - Handles uploading task photos to Supabase Storage
 */

import { createClient } from '@supabase/supabase-js';
import { config } from '../config/env.js';

// Create Supabase client with service role key (bypasses RLS for server-side operations)
const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey);

const BUCKET_NAME = 'task-images';
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB limit

export interface TaskPhotoResult {
  success: boolean;
  url?: string;
  storagePath?: string;
  error?: string;
}

/**
 * Upload a task photo to Supabase Storage and create database record
 */
export async function uploadTaskPhoto(
  userId: string,
  taskId: string,
  buffer: Buffer,
  mimeType: string,
  fileName: string
): Promise<TaskPhotoResult> {
  try {
    // Validate file size
    if (buffer.length > MAX_FILE_SIZE) {
      return {
        success: false,
        error: `File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)}MB`,
      };
    }

    // Validate mime type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(mimeType)) {
      return {
        success: false,
        error: `Invalid file type. Allowed types: ${allowedTypes.join(', ')}`,
      };
    }

    // Check if task already has an image (one image per task limit)
    const { data: existingImage } = await supabase
      .from('task_images')
      .select('id, storage_path')
      .eq('task_id', taskId)
      .single();

    // If image exists, delete the old one first
    if (existingImage) {
      // Delete from storage
      await supabase.storage.from(BUCKET_NAME).remove([existingImage.storage_path]);
      // Delete from database
      await supabase.from('task_images').delete().eq('id', existingImage.id);
    }

    // Create storage path: userId/taskId/timestamp_filename
    const timestamp = Date.now();
    const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storagePath = `${userId}/${taskId}/${timestamp}_${safeFileName}`;

    // Upload to storage
    const { error: uploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(storagePath, buffer, {
        contentType: mimeType,
        upsert: false,
      });

    if (uploadError) {
      console.error('Storage upload error:', uploadError);
      return {
        success: false,
        error: `Upload failed: ${uploadError.message}`,
      };
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(storagePath);

    const publicUrl = urlData.publicUrl;

    // Insert record in task_images table
    const { error: dbError } = await supabase.from('task_images').insert({
      task_id: taskId,
      user_id: userId,
      storage_path: storagePath,
      file_name: fileName,
      file_size: buffer.length,
      mime_type: mimeType,
    });

    if (dbError) {
      console.error('Database insert error:', dbError);
      // Clean up storage if database insert failed
      await supabase.storage.from(BUCKET_NAME).remove([storagePath]);
      return {
        success: false,
        error: `Database error: ${dbError.message}`,
      };
    }

    console.log(`[TaskPhoto] Uploaded photo for task ${taskId}: ${storagePath}`);

    return {
      success: true,
      url: publicUrl,
      storagePath,
    };
  } catch (error) {
    console.error('Error uploading task photo:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Delete a task's photo from storage and database
 */
export async function deleteTaskPhoto(taskId: string): Promise<boolean> {
  try {
    // Get the image record
    const { data: image } = await supabase
      .from('task_images')
      .select('id, storage_path')
      .eq('task_id', taskId)
      .single();

    if (!image) {
      return true; // No image to delete
    }

    // Delete from storage
    await supabase.storage.from(BUCKET_NAME).remove([image.storage_path]);

    // Delete from database
    await supabase.from('task_images').delete().eq('id', image.id);

    console.log(`[TaskPhoto] Deleted photo for task ${taskId}`);
    return true;
  } catch (error) {
    console.error('Error deleting task photo:', error);
    return false;
  }
}

/**
 * Get task photo info
 */
export async function getTaskPhoto(taskId: string): Promise<{
  url: string;
  fileName: string;
  mimeType: string;
} | null> {
  try {
    const { data: image } = await supabase
      .from('task_images')
      .select('storage_path, file_name, mime_type')
      .eq('task_id', taskId)
      .single();

    if (!image) {
      return null;
    }

    const { data: urlData } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(image.storage_path);

    return {
      url: urlData.publicUrl,
      fileName: image.file_name,
      mimeType: image.mime_type,
    };
  } catch (error) {
    console.error('Error getting task photo:', error);
    return null;
  }
}
