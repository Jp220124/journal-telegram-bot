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

  // Redis (for BullMQ job queue)
  redisUrl: getEnvVar('REDIS_URL', false) || 'redis://localhost:6379',

  // Research APIs - optional, research automation disabled if not set
  exaApiKey: getEnvVar('EXA_API_KEY', false),
  tavilyApiKey: getEnvVar('TAVILY_API_KEY', false),

  // Research settings
  researchClarificationTimeoutHours: parseInt(process.env.RESEARCH_CLARIFICATION_TIMEOUT_HOURS || '24', 10),
  researchMaxJobsPerDay: parseInt(process.env.RESEARCH_MAX_JOBS_PER_DAY || '10', 10),

  // Supabase
  supabaseUrl: getEnvVar('SUPABASE_URL'),
  supabaseServiceKey: getEnvVar('SUPABASE_SERVICE_KEY'),

  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Feature flags
  isProduction: process.env.NODE_ENV === 'production',
  isDevelopment: process.env.NODE_ENV !== 'production',

  // Research automation feature flag (enabled if both APIs are configured)
  get isResearchEnabled(): boolean {
    return Boolean(this.exaApiKey || this.tavilyApiKey);
  },
} as const;

export type Config = typeof config;
