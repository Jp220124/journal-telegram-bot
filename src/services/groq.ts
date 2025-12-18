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
    // Create a File-like object from the buffer (convert to Uint8Array for type compatibility)
    const file = new File([new Uint8Array(audioBuffer)], filename, { type: 'audio/ogg' });

    const transcription = await groq.audio.transcriptions.create({
      file,
      model: 'whisper-large-v3',
      response_format: 'text',
    });

    // When response_format is 'text', transcription is a string
    return (transcription as unknown as string).trim();
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
    const file = new File([new Uint8Array(audioBuffer)], options?.filename || 'audio.ogg', { type: 'audio/ogg' });

    const transcription = await groq.audio.transcriptions.create({
      file,
      model: 'whisper-large-v3',
      response_format: 'verbose_json',
      language: options?.language,
      prompt: options?.prompt,
    });

    // When response_format is 'verbose_json', transcription has text and duration
    const result = transcription as unknown as { text?: string; duration?: number };
    return {
      text: result.text?.trim() || null,
      duration: result.duration,
    };
  } catch (error) {
    console.error('Error transcribing audio with Groq:', error);
    return { text: null };
  }
}
