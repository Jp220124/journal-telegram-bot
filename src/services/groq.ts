/**
 * Groq service for voice-to-text transcription using Whisper
 * Free tier with fast inference
 */

import Groq from 'groq-sdk';
import { config } from '../config/env.js';

const groq = new Groq({
  apiKey: config.groqApiKey,
});

/**
 * Transcribe audio buffer to text using Whisper
 */
export async function transcribeAudio(audioBuffer: Buffer, filename: string = 'audio.ogg'): Promise<string | null> {
  try {
    // Create a File-like object from the buffer
    const file = new File([audioBuffer], filename, { type: 'audio/ogg' });

    const transcription = await groq.audio.transcriptions.create({
      file,
      model: 'whisper-large-v3',
      response_format: 'text',
    });

    return transcription.trim();
  } catch (error) {
    console.error('Error transcribing audio with Groq:', error);
    return null;
  }
}

/**
 * Transcribe with additional options
 */
export async function transcribeAudioWithOptions(
  audioBuffer: Buffer,
  options?: {
    filename?: string;
    language?: string;
    prompt?: string;
  }
): Promise<{ text: string | null; duration?: number }> {
  try {
    const file = new File([audioBuffer], options?.filename || 'audio.ogg', { type: 'audio/ogg' });

    const transcription = await groq.audio.transcriptions.create({
      file,
      model: 'whisper-large-v3',
      response_format: 'verbose_json',
      language: options?.language,
      prompt: options?.prompt,
    });

    return {
      text: transcription.text?.trim() || null,
      duration: transcription.duration,
    };
  } catch (error) {
    console.error('Error transcribing audio with Groq:', error);
    return { text: null };
  }
}
