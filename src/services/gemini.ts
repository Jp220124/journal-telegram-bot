/**
 * AI service for intent parsing and natural language understanding
 * Uses OpenRouter API with function calling for structured output
 */

import { config } from '../config/env.js';
import { AVAILABLE_CATEGORIES } from '../types/conversation.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'kwaipilot/kat-coder-pro:free';

// Intent tool definitions for OpenAI-compatible function calling
const INTENT_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'add_todo',
      description: 'Add a new todo/task for the user. Use this when the user wants to create a task, add something to their list, or set a reminder for something to do. Call this even if the user only mentions a category without a specific task title.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'The title/description of the task. Leave empty/undefined if user only mentions category without a specific task.',
          },
          priority: {
            type: 'string',
            description: 'Task priority level: low, medium, or high. Default to medium if not specified.',
          },
          due_date: {
            type: 'string',
            description: 'Due date in YYYY-MM-DD format. Parse relative dates like "today", "tomorrow", "next Monday" to actual dates.',
          },
          due_time: {
            type: 'string',
            description: 'Due time in HH:MM format (24-hour). Parse times like "5pm" to "17:00", "morning" to "09:00", etc.',
          },
          category: {
            type: 'string',
            description: `Task category. MUST be one of these exact values: ${AVAILABLE_CATEGORIES.join(', ')}. Map user input: "daily recurring/daily/recurring" -> "Daily Recurring", "one-time/once" -> "One-Time Tasks", "work/office/job" -> "Work", "personal/home/life" -> "Personal". If no category mentioned, leave empty.`,
          },
        },
        required: [], // No required fields - allows partial intents
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'add_journal',
      description: 'Add a journal entry for the user. Use this when the user wants to write in their journal, log their thoughts, reflect on their day, or record experiences.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The journal entry content',
          },
          mood: {
            type: 'string',
            description: "User's mood: great, good, okay, bad, or terrible",
          },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'query_todos',
      description: "Get/list user's todos. Use this when the user wants to see their tasks, check what they need to do, or review their list.",
      parameters: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            description: 'Filter for todos: today (due today), pending (not completed), completed, all, or high_priority',
          },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'mark_complete',
      description: 'Mark a todo as complete. Use this when the user says they finished a task, completed something, or did something on their list.',
      parameters: {
        type: 'object',
        properties: {
          task_identifier: {
            type: 'string',
            description: 'Task title or partial match to identify the task',
          },
        },
        required: ['task_identifier'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'general_chat',
      description: "General conversation that doesn't match other intents. Use this for greetings, questions, or when the user is just chatting.",
      parameters: {
        type: 'object',
        properties: {
          response: {
            type: 'string',
            description: 'A helpful, friendly response to the user',
          },
        },
        required: ['response'],
      },
    },
  },
];

export interface ParsedIntent {
  intent: 'add_todo' | 'add_journal' | 'query_todos' | 'mark_complete' | 'general_chat';
  parameters: Record<string, string | undefined>;
  confidence: 'high' | 'medium' | 'low';
  isComplete: boolean; // Whether all required data is present for execution
}

/**
 * Normalize category input to exact database values
 */
function normalizeCategory(input: string | undefined): string | undefined {
  if (!input) return undefined;

  const normalized = input.toLowerCase().trim();

  // Map common variations to exact category names
  const categoryMap: Record<string, string> = {
    'daily recurring': 'Daily Recurring',
    'daily': 'Daily Recurring',
    'recurring': 'Daily Recurring',
    'one-time tasks': 'One-Time Tasks',
    'one-time': 'One-Time Tasks',
    'one time': 'One-Time Tasks',
    'once': 'One-Time Tasks',
    'work': 'Work',
    'office': 'Work',
    'job': 'Work',
    'personal': 'Personal',
    'home': 'Personal',
    'life': 'Personal',
  };

  // Check direct match first
  if (categoryMap[normalized]) {
    return categoryMap[normalized];
  }

  // Check if it's already a valid category (case-insensitive)
  for (const cat of AVAILABLE_CATEGORIES) {
    if (cat.toLowerCase() === normalized) {
      return cat;
    }
  }

  return undefined;
}

interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenRouterResponse {
  choices: Array<{
    message: {
      content?: string;
      tool_calls?: Array<{
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
  }>;
}

/**
 * Make a request to OpenRouter API
 */
async function callOpenRouter(
  messages: OpenRouterMessage[],
  useTools: boolean = true
): Promise<OpenRouterResponse> {
  const body: Record<string, unknown> = {
    model: MODEL,
    messages,
  };

  if (useTools) {
    body.tools = INTENT_TOOLS;
    body.tool_choice = 'auto';
  }

  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.openRouterApiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://daily-journal.app',
      'X-Title': 'Daily Journal Telegram Bot',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<OpenRouterResponse>;
}

/**
 * Parse user message to determine intent and extract parameters
 */
export async function parseIntent(
  userMessage: string,
  context?: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<ParsedIntent> {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const tomorrowStr = new Date(today.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const systemPrompt = `You are a helpful assistant for a daily journal and todo app. Your job is to understand what the user wants to do and call the appropriate function.

Current date: ${todayStr}
Tomorrow: ${tomorrowStr}

CRITICAL INSTRUCTION: When extracting parameters (especially task titles, journal content), you MUST use the content from the CURRENT/LATEST user message ONLY. Previous messages in the conversation are provided for context about what actions were taken, but NEVER extract titles or content from previous messages.

For add_todo:
- The "title" parameter MUST come from the CURRENT user message
- Extract exactly what the user wants to add as a task from their LATEST message
- Do NOT use task names from previous messages in the conversation

When parsing dates:
- "today" = ${todayStr}
- "tomorrow" = ${tomorrowStr}
- Parse relative days like "next Monday" to actual dates

When parsing times:
- "morning" = 09:00
- "afternoon" = 14:00
- "evening" = 18:00
- "night" = 21:00
- "5pm" = 17:00
- "5:30pm" = 17:30

For priorities:
- Words like "urgent", "important", "asap", "critical" = high
- Words like "whenever", "low priority", "not urgent" = low
- Default to medium if not specified

Analyze the user's CURRENT message and call the most appropriate function.`;

  try {
    // Build messages array
    const messages: OpenRouterMessage[] = [
      { role: 'system', content: systemPrompt },
    ];

    // Add context from previous messages
    if (context) {
      for (const msg of context) {
        messages.push({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content,
        });
      }
    }

    // Add current user message
    messages.push({ role: 'user', content: userMessage });

    const response = await callOpenRouter(messages, true);
    const choice = response.choices[0];

    // Check for function call
    if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
      const toolCall = choice.message.tool_calls[0];
      const functionName = toolCall.function.name;
      let args: Record<string, string> = {};

      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        args = {};
      }

      // Normalize category if present
      if (args.category) {
        const normalizedCategory = normalizeCategory(args.category);
        if (normalizedCategory) {
          args.category = normalizedCategory;
        } else {
          delete args.category; // Remove invalid category
        }
      }

      // Determine if intent is complete (has all required data)
      let isComplete = true;
      if (functionName === 'add_todo') {
        isComplete = !!args.title && args.title.trim().length > 0;
      } else if (functionName === 'add_journal') {
        isComplete = !!args.content && args.content.trim().length > 0;
      } else if (functionName === 'mark_complete') {
        isComplete = !!args.task_identifier && args.task_identifier.trim().length > 0;
      }

      // Debug logging to track AI extraction
      console.log('[AI Intent Debug]', {
        userMessage: userMessage,
        extractedIntent: functionName,
        extractedParams: args,
        isComplete,
        contextLength: context?.length || 0,
      });

      return {
        intent: functionName as ParsedIntent['intent'],
        parameters: args,
        confidence: 'high',
        isComplete,
      };
    }

    // Fallback to general chat if no function was called
    const text = choice?.message?.content;
    return {
      intent: 'general_chat',
      parameters: { response: text || "I'm not sure how to help with that. You can ask me to add todos, write journal entries, or check your tasks!" },
      confidence: 'low',
      isComplete: true, // General chat is always "complete"
    };
  } catch (error) {
    console.error('Error parsing intent with OpenRouter:', error);
    return {
      intent: 'general_chat',
      parameters: { response: 'Sorry, I had trouble understanding that. Could you try again?' },
      confidence: 'low',
      isComplete: true,
    };
  }
}

/**
 * Generate a conversational response
 */
export async function generateResponse(prompt: string): Promise<string> {
  try {
    const messages: OpenRouterMessage[] = [
      { role: 'user', content: prompt },
    ];

    const response = await callOpenRouter(messages, false);
    return response.choices[0]?.message?.content || "Sorry, I couldn't generate a response right now.";
  } catch (error) {
    console.error('Error generating response:', error);
    return "Sorry, I couldn't generate a response right now.";
  }
}
