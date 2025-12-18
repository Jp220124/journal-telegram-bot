/**
 * Environment configuration for the Telegram bot
 * All environment variables are loaded and validated here
 */

function getEnvVar(name: string, required: boolean = true): string {
  const value = process.env[name];
  if (!value && required) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value || '';
}

export const config = {
  // Telegram
  telegramBotToken: getEnvVar('TELEGRAM_BOT_TOKEN'),
  webhookUrl: getEnvVar('WEBHOOK_URL', false),

  // Google Gemini
  geminiApiKey: getEnvVar('GEMINI_API_KEY'),

  // Groq (for Whisper)
  groqApiKey: getEnvVar('GROQ_API_KEY'),

  // Supabase
  supabaseUrl: getEnvVar('SUPABASE_URL'),
  supabaseServiceKey: getEnvVar('SUPABASE_SERVICE_KEY'),

  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Feature flags
  isProduction: process.env.NODE_ENV === 'production',
  isDevelopment: process.env.NODE_ENV !== 'production',
} as const;

export type Config = typeof config;
