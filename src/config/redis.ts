/**
 * Redis connection configuration for BullMQ
 * Used for background job processing (research automation)
 */

import IORedis, { type RedisOptions } from 'ioredis';
import { config } from './env.js';

// Parse Redis URL and create connection options
function parseRedisUrl(url: string): RedisOptions {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || 'localhost',
      port: parseInt(parsed.port || '6379', 10),
      password: parsed.password || undefined,
      username: parsed.username || undefined,
      maxRetriesPerRequest: null, // Required for BullMQ
      enableReadyCheck: false,
      retryStrategy: (times: number) => {
        if (times > 10) {
          console.error('Redis connection failed after 10 retries');
          return null;
        }
        return Math.min(times * 200, 2000);
      },
    };
  } catch {
    // Fallback for simple host:port format
    return {
      host: 'localhost',
      port: 6379,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  }
}

// Create Redis connection for BullMQ
export const redisConnection = new IORedis(parseRedisUrl(config.redisUrl));

// Event handlers for connection status
redisConnection.on('connect', () => {
  console.log('✅ Redis connected successfully');
});

redisConnection.on('error', (err) => {
  console.error('❌ Redis connection error:', err.message);
});

redisConnection.on('close', () => {
  console.log('⚠️ Redis connection closed');
});

// Export connection options for BullMQ (it needs options, not instance)
export const bullmqConnection = {
  connection: redisConnection,
};

// Check if Redis is available
export async function checkRedisConnection(): Promise<boolean> {
  try {
    const pong = await redisConnection.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

// Graceful shutdown
export async function closeRedisConnection(): Promise<void> {
  await redisConnection.quit();
}
