/**
 * AI service for intent parsing and natural language understanding
 * Uses Google Gemini API with function calling for structured output
 * Falls back to OpenRouter if Gemini is not configured
 */

import { config } from '../config/env.js';

// Google Gemini API
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

// OpenRouter fallback
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'google/gemini-2.0-flash-exp:free';

// Default categories (fallback)
const DEFAULT_CATEGORIES = ['Daily Recurring', 'One-Time Tasks', 'Work', 'Personal'];

/**
 * Build intent tools with dynamic category list
 */
function buildIntentTools(userCategories: string[]) {
  const categoryList = userCategories.join(', ');

  return [
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
            description: `Task category. MUST be one of the user's categories: ${categoryList}. Match case-insensitively. Common aliases: "daily/recurring" -> "Daily Recurring", "one-time/once" -> "One-Time Tasks", "office/job" -> "Work", "home/life" -> "Personal". If user mentions a custom category name, use it exactly. If no category mentioned, leave empty.`,
          },
        },
        required: [], // No required fields - allows partial intents
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'add_multiple_todos',
      description: 'Add multiple todos/tasks at once. Use this when the user wants to create MULTIPLE tasks in a single message. Examples: "Add these 4 tasks to JP: Final Lamp, Final Shelf, Final Candle, Final Shoes" or "Add task1, task2, task3 to Work by 5pm". This is for bulk task creation.',
      parameters: {
        type: 'object',
        properties: {
          titles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of task titles to create. Extract each task name from the user message.',
          },
          category: {
            type: 'string',
            description: `Task category for ALL tasks. MUST be one of the user's categories: ${categoryList}. Match case-insensitively.`,
          },
          priority: {
            type: 'string',
            description: 'Priority level for all tasks: low, medium, or high. Default to medium.',
          },
          due_date: {
            type: 'string',
            description: 'Due date for all tasks in YYYY-MM-DD format. Parse "today", "tomorrow", etc.',
          },
          due_time: {
            type: 'string',
            description: 'Due time for all tasks in HH:MM format (24-hour). Parse times like "5pm" to "17:00", "3:30pm" to "15:30", "morning" to "09:00", "afternoon" to "14:00", "evening" to "18:00".',
          },
        },
        required: ['titles'],
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
      description: "Get/list user's todos. Use this when the user wants to see their tasks, check what they need to do, or review their list. Can filter by status and/or category.",
      parameters: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            description: 'Filter for todos: today (due today), pending (not completed), completed, all, or high_priority',
          },
          category: {
            type: 'string',
            description: `Filter by category. Must be one of: ${categoryList}. Use when user asks for tasks in a specific category like "Show Work tasks" or "Tasks in JP".`,
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
      name: 'delete_todo',
      description: 'Delete/remove a task from the todo list. Use this when the user wants to delete a task, remove it, cancel it, or get rid of it.',
      parameters: {
        type: 'object',
        properties: {
          task_identifier: {
            type: 'string',
            description: 'Task title or partial match to identify the task to delete',
          },
        },
        required: ['task_identifier'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'edit_todo',
      description: 'Edit/update an existing task. Use this when the user wants to change, modify, update, reschedule, or rename a task.',
      parameters: {
        type: 'object',
        properties: {
          task_identifier: {
            type: 'string',
            description: 'Task title or partial match to identify the task to edit',
          },
          new_title: {
            type: 'string',
            description: 'New title for the task (if user wants to rename it)',
          },
          new_due_date: {
            type: 'string',
            description: 'New due date in YYYY-MM-DD format. Parse "today", "tomorrow", etc.',
          },
          new_due_time: {
            type: 'string',
            description: 'New due time in HH:MM format (24-hour). Parse "5pm" to "17:00", etc.',
          },
          new_priority: {
            type: 'string',
            description: 'New priority level: low, medium, or high',
          },
          new_category: {
            type: 'string',
            description: `New category. Must be one of: ${categoryList}`,
          },
        },
        required: ['task_identifier'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'log_mood',
      description: 'Log/record mood without writing a full journal entry. Use this when the user just wants to log how they feel, check in with their mood, or record their emotional state without writing journal content.',
      parameters: {
        type: 'object',
        properties: {
          mood: {
            type: 'string',
            enum: ['great', 'good', 'okay', 'bad', 'terrible'],
            description: "User's mood: great, good, okay, bad, or terrible",
          },
        },
        required: ['mood'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'add_note',
      description: 'Create a new note for the user. Use this when the user wants to write a note, save some information, or create a document. Notes are different from todos (tasks) - they are for storing information, ideas, or longer text content.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'The title of the note. If not provided, will be asked.',
          },
          content: {
            type: 'string',
            description: 'The content/body of the note. This is the main text.',
          },
          folder: {
            type: 'string',
            description: 'The folder to save the note in (e.g., "Personal", "Work", "Ideas"). If not specified, leave empty.',
          },
        },
        required: [], // No required fields - allows partial intents
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'query_notes',
      description: "Get/list/search user's notes. Use this when the user wants to see their notes, find a specific note, or search through their notes.",
      parameters: {
        type: 'object',
        properties: {
          search_query: {
            type: 'string',
            description: 'Search term to filter notes by title or content. Leave empty to list recent notes.',
          },
          folder: {
            type: 'string',
            description: 'Filter notes by folder name. Leave empty for all folders.',
          },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_note',
      description: 'Read/open a specific note to see its content. Use this when the user wants to see the full content of a particular note.',
      parameters: {
        type: 'object',
        properties: {
          note_title: {
            type: 'string',
            description: 'The title or partial title of the note to read.',
          },
        },
        required: ['note_title'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'manage_note',
      description: 'Manage a note: delete it, archive it, or pin/unpin it. Use this when the user wants to delete a note, archive a note, pin a note, or unpin a note.',
      parameters: {
        type: 'object',
        properties: {
          note_title: {
            type: 'string',
            description: 'The title or partial title of the note to manage.',
          },
          action: {
            type: 'string',
            enum: ['delete', 'archive', 'unarchive', 'pin', 'unpin'],
            description: 'The action to perform: delete (remove permanently), archive (move to archive), unarchive (restore from archive), pin (mark as important), unpin (remove pin).',
          },
        },
        required: ['note_title', 'action'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'edit_note',
      description: 'Edit or update an existing note by adding/appending content to it. Use this when the user wants to add more content to a note, update a note, or append text to a note.',
      parameters: {
        type: 'object',
        properties: {
          note_title: {
            type: 'string',
            description: 'The title or partial title of the note to edit.',
          },
          content_to_add: {
            type: 'string',
            description: 'The new content to add/append to the note.',
          },
        },
        required: ['note_title', 'content_to_add'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'query_templates',
      description: "Get/list user's journal templates. Use this when the user wants to see their templates, check what templates they have, or list available journaling templates.",
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'journal_template',
      description: 'Start journaling using a specific template. Use this when the user wants to write a journal entry using a template, journal with a template, or use a specific template for their journal.',
      parameters: {
        type: 'object',
        properties: {
          template_name: {
            type: 'string',
            description: 'The name of the template to use for journaling. Can be a partial match.',
          },
        },
        required: ['template_name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'query_calendar',
      description: "Get user's schedule/calendar view. Use this when the user asks about their schedule, what's coming up, what's due, or wants a calendar view of tasks and events.",
      parameters: {
        type: 'object',
        properties: {
          timeframe: {
            type: 'string',
            enum: ['today', 'tomorrow', 'week', 'next_week'],
            description: 'The timeframe to show: today, tomorrow, this week, or next week. Defaults to today.',
          },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'query_recurring',
      description: "Get user's recurring/daily tasks. Use this when the user asks about recurring tasks, daily tasks, routine tasks, or habits.",
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'add_task_photo',
      description: 'Add/attach a photo to an existing task. Use this when the user wants to add a photo/image to a task, attach an image to a task, upload a photo for a task.',
      parameters: {
        type: 'object',
        properties: {
          task_identifier: {
            type: 'string',
            description: 'Task title or partial match to identify the task to attach photo to. If not specified, will show list of recent tasks.',
          },
        },
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
}

export interface ParsedIntent {
  intent: 'add_todo' | 'add_multiple_todos' | 'add_journal' | 'query_todos' | 'mark_complete' | 'delete_todo' | 'edit_todo' | 'log_mood' | 'add_note' | 'query_notes' | 'read_note' | 'manage_note' | 'edit_note' | 'query_templates' | 'journal_template' | 'query_calendar' | 'query_recurring' | 'add_task_photo' | 'general_chat';
  parameters: Record<string, string | string[] | undefined>;
  confidence: 'high' | 'medium' | 'low';
  isComplete: boolean; // Whether all required data is present for execution
}

/**
 * Normalize category input to match user's actual categories
 */
function normalizeCategory(input: string | undefined, userCategories: string[]): string | undefined {
  if (!input) return undefined;

  const normalized = input.toLowerCase().trim();

  // First check if it matches any user category exactly (case-insensitive)
  for (const cat of userCategories) {
    if (cat.toLowerCase() === normalized) {
      return cat; // Return the exact category name from database
    }
  }

  // Map common aliases to standard category names
  const aliasMap: Record<string, string> = {
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

  // Check if alias maps to a category that exists in user's list
  if (aliasMap[normalized]) {
    const target = aliasMap[normalized];
    for (const cat of userCategories) {
      if (cat.toLowerCase() === target.toLowerCase()) {
        return cat;
      }
    }
  }

  // If still no match, try partial matching for custom categories
  for (const cat of userCategories) {
    if (cat.toLowerCase().includes(normalized) || normalized.includes(cat.toLowerCase())) {
      return cat;
    }
  }

  console.log('[Category Normalize] No match found for:', input, 'in categories:', userCategories);
  return input; // Return as-is, let the database lookup handle it
}

/**
 * Extract category from title if AI didn't parse it correctly
 * Handles patterns like "HR App to work" → { cleanTitle: "HR App", category: "Work" }
 * Also handles custom categories like "Final Lamp to JP" → { cleanTitle: "Final Lamp", category: "JP" }
 */
function extractCategoryFromTitle(title: string, userCategories: string[]): { cleanTitle: string; category: string | undefined } {
  // Build dynamic regex pattern from user categories
  const categoryNames = userCategories.map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const categoryPattern = new RegExp(`\\s+(?:to|in|for|under)\\s+(${categoryNames})\\s*$`, 'i');

  const match = title.match(categoryPattern);

  if (match) {
    const categoryText = match[1];
    const cleanTitle = title.replace(categoryPattern, '').trim();

    // Find the exact category name (case-insensitive match)
    let category: string | undefined;
    for (const cat of userCategories) {
      if (cat.toLowerCase() === categoryText.toLowerCase()) {
        category = cat;
        break;
      }
    }

    console.log('[Category Extraction] Extracted from title:', {
      originalTitle: title,
      cleanTitle,
      category
    });

    return { cleanTitle, category };
  }

  return { cleanTitle: title, category: undefined };
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

// Gemini API types
interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        text?: string;
        functionCall?: {
          name: string;
          args: Record<string, unknown>;
        };
      }>;
    };
  }>;
}

/**
 * Convert OpenAI-style tools to Gemini function declarations
 */
function convertToolsToGemini(tools: ReturnType<typeof buildIntentTools>): GeminiFunctionDeclaration[] {
  return tools.map(tool => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
}

/**
 * Make a request to Google Gemini API
 */
async function callGemini(
  messages: OpenRouterMessage[],
  tools?: ReturnType<typeof buildIntentTools>
): Promise<OpenRouterResponse> {
  // Convert messages to Gemini format
  // Gemini expects system instruction separately
  const systemMessage = messages.find(m => m.role === 'system');
  const chatMessages = messages.filter(m => m.role !== 'system');

  const contents: GeminiContent[] = chatMessages.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'model',
    parts: [{ text: msg.content }],
  }));

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 1024,
    },
  };

  // Add system instruction
  if (systemMessage) {
    body.systemInstruction = {
      parts: [{ text: systemMessage.content }],
    };
  }

  // Add tools if provided
  if (tools) {
    body.tools = [{
      functionDeclarations: convertToolsToGemini(tools),
    }];
    body.toolConfig = {
      functionCallingConfig: {
        mode: 'AUTO',
      },
    };
  }

  const response = await fetch(`${GEMINI_API_URL}?key=${config.geminiApiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${error}`);
  }

  const geminiResponse = await response.json() as GeminiResponse;

  // Convert Gemini response to OpenRouter format for compatibility
  const candidate = geminiResponse.candidates?.[0];
  if (!candidate) {
    return { choices: [] };
  }

  const parts = candidate.content?.parts || [];
  const functionCallPart = parts.find(p => p.functionCall);
  const textPart = parts.find(p => p.text);

  if (functionCallPart?.functionCall) {
    return {
      choices: [{
        message: {
          tool_calls: [{
            function: {
              name: functionCallPart.functionCall.name,
              arguments: JSON.stringify(functionCallPart.functionCall.args),
            },
          }],
        },
      }],
    };
  }

  return {
    choices: [{
      message: {
        content: textPart?.text || '',
      },
    }],
  };
}

/**
 * Make a request to OpenRouter API (fallback)
 */
async function callOpenRouter(
  messages: OpenRouterMessage[],
  tools?: ReturnType<typeof buildIntentTools>
): Promise<OpenRouterResponse> {
  const body: Record<string, unknown> = {
    model: OPENROUTER_MODEL,
    messages,
  };

  if (tools) {
    body.tools = tools;
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
 * Call the AI API - uses Gemini if available, falls back to OpenRouter
 */
async function callAI(
  messages: OpenRouterMessage[],
  tools?: ReturnType<typeof buildIntentTools>
): Promise<OpenRouterResponse> {
  // Log which API will be used
  const hasGemini = Boolean(config.geminiApiKey);
  const hasOpenRouter = Boolean(config.openRouterApiKey);
  console.log(`[AI Config] Gemini: ${hasGemini ? 'YES' : 'NO'}, OpenRouter: ${hasOpenRouter ? 'YES' : 'NO'}`);

  // Prefer Gemini API if configured
  if (config.geminiApiKey) {
    try {
      console.log('[AI] Using Gemini API');
      return await callGemini(messages, tools);
    } catch (error) {
      console.error('[AI] Gemini API error, falling back to OpenRouter:', error);
      // Fall through to OpenRouter
    }
  }

  // Fallback to OpenRouter
  if (config.openRouterApiKey) {
    console.log('[AI] Using OpenRouter API');
    return await callOpenRouter(messages, tools);
  }

  console.error('[AI] No API keys configured!');
  throw new Error('No AI API configured. Please set GEMINI_API_KEY or OPENROUTER_API_KEY.');
}

/**
 * Parse user message to determine intent and extract parameters
 * @param userMessage - The user's message to parse
 * @param userCategories - The user's custom categories from database
 * @param context - Previous conversation messages for context
 */
export async function parseIntent(
  userMessage: string,
  userCategories: string[] = DEFAULT_CATEGORIES,
  context?: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<ParsedIntent> {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const tomorrowStr = new Date(today.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  // Build dynamic category list for the prompt
  const categoryList = userCategories.join(', ');

  const systemPrompt = `You are a helpful assistant for a daily journal and todo app. Your job is to understand what the user wants to do and call the appropriate function.

Current date: ${todayStr}
Tomorrow: ${tomorrowStr}

CRITICAL: CATEGORY EXTRACTION RULES
This user has these categories: ${categoryList}

When user mentions a category using phrases like "to [category]", "in [category]", "for [category]", "under [category]":
- Match the category name case-insensitively
- Accept ANY category from the user's list above
- For example: "to JP" → category: "JP", "to Work" → category: "Work"

CRITICAL: PARSING EXAMPLES
- "Add task to work" → title: (empty), category: "Work"
- "Add HR App to work" → title: "HR App", category: "Work"
- "Add Final Lamp to JP" → title: "Final Lamp", category: "JP"
- "Add buy groceries to personal" → title: "buy groceries", category: "Personal"
- "In category JP add these tasks" → category: "JP"

The phrase "to [category]" or "in [category]" indicates the category, NOT part of the title!
If user mentions a category name from their list, use it exactly as it appears in their category list.

For add_todo:
- Extract the task title (what comes between "add" and "to [category]")
- Extract category from "to [category]" phrase
- If only category is mentioned with no specific task, leave title empty
- Accept any category from the user's list: ${categoryList}

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
    // Build dynamic tools with user's categories
    const tools = buildIntentTools(userCategories);

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

    const response = await callAI(messages, tools);
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

      // Normalize category if present (using user's categories)
      if (args.category) {
        const normalizedCategory = normalizeCategory(args.category, userCategories);
        if (normalizedCategory) {
          args.category = normalizedCategory;
        }
        // Don't delete - let the database lookup handle unknown categories
      }

      // POST-PROCESSING: Extract category from title if AI didn't parse it
      // This handles cases like "HR App to work" or "Final Lamp to JP"
      if (functionName === 'add_todo' && args.title && !args.category) {
        const extracted = extractCategoryFromTitle(args.title, userCategories);
        if (extracted.category) {
          args.title = extracted.cleanTitle;
          args.category = extracted.category;
        }
      }

      // Determine if intent is complete (has all required data)
      let isComplete = true;
      if (functionName === 'add_todo') {
        isComplete = !!args.title && args.title.trim().length > 0;
      } else if (functionName === 'add_multiple_todos') {
        // Multiple todos needs at least one title in the array
        isComplete = Array.isArray(args.titles) && args.titles.length > 0;
      } else if (functionName === 'add_journal') {
        isComplete = !!args.content && args.content.trim().length > 0;
      } else if (functionName === 'mark_complete') {
        isComplete = !!args.task_identifier && args.task_identifier.trim().length > 0;
      } else if (functionName === 'delete_todo') {
        isComplete = !!args.task_identifier && args.task_identifier.trim().length > 0;
      } else if (functionName === 'edit_todo') {
        // Edit needs task identifier AND at least one field to update
        const hasUpdate = args.new_title || args.new_due_date || args.new_due_time || args.new_priority || args.new_category;
        isComplete = !!args.task_identifier && args.task_identifier.trim().length > 0 && !!hasUpdate;
      } else if (functionName === 'log_mood') {
        isComplete = !!args.mood && ['great', 'good', 'okay', 'bad', 'terrible'].includes(args.mood);
      } else if (functionName === 'add_note') {
        // A note needs at least a title to be complete
        isComplete = !!args.title && args.title.trim().length > 0;
      } else if (functionName === 'read_note') {
        isComplete = !!args.note_title && args.note_title.trim().length > 0;
      } else if (functionName === 'manage_note') {
        // Need note title and action
        const validActions = ['delete', 'archive', 'unarchive', 'pin', 'unpin'];
        isComplete = !!args.note_title && args.note_title.trim().length > 0 &&
                     !!args.action && validActions.includes(args.action);
      } else if (functionName === 'edit_note') {
        // Need note title and content to add
        isComplete = !!args.note_title && args.note_title.trim().length > 0 &&
                     !!args.content_to_add && args.content_to_add.trim().length > 0;
      } else if (functionName === 'journal_template') {
        // Need template name to start journaling
        isComplete = !!args.template_name && args.template_name.trim().length > 0;
      } else if (functionName === 'add_task_photo') {
        // Task photo is always complete - if no task specified, we'll show a list
        isComplete = true;
      }
      // query_todos, query_notes, and query_templates are always complete (can list without filters)

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
 * Generate a conversational response (without function calling)
 */
export async function generateResponse(prompt: string): Promise<string> {
  try {
    const messages: OpenRouterMessage[] = [
      { role: 'user', content: prompt },
    ];

    const response = await callAI(messages); // No tools = no function calling
    return response.choices[0]?.message?.content || "Sorry, I couldn't generate a response right now.";
  } catch (error) {
    console.error('Error generating response:', error);
    return "Sorry, I couldn't generate a response right now.";
  }
}
