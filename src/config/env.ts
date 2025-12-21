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

  // OpenRouter API (for AI models)
  openRouterApiKey: getEnvVar('OPENROUTER_API_KEY'),

  // Groq (for Whisper) - optional, voice transcription disabled if not set
  groqApiKey: getEnvVar('GROQ_API_KEY', false),

  // Supabase
  supabaseUrl: getEnvVar('SUPABASE_URL'),
  supabaseServiceKey: getEnvVar('SUPABASE_SERVICE_KEY'),

  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Research Automation (optional)
  redisUrl: getEnvVar('REDIS_URL', false),
  exaApiKey: getEnvVar('EXA_API_KEY', false),
  tavilyApiKey: getEnvVar('TAVILY_API_KEY', false),

  // Feature flags
  isProduction: process.env.NODE_ENV === 'production',
  isDevelopment: process.env.NODE_ENV !== 'production',

  // Research automation is enabled if Redis URL is configured
  get isResearchEnabled(): boolean {
    return Boolean(this.redisUrl);
  },
} as const;

export type Config = typeof config;
