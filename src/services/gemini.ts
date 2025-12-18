/**
 * Gemini AI service for intent parsing and natural language understanding
 * Uses function calling for structured output
 */

import { GoogleGenerativeAI, FunctionDeclarationSchemaType, Tool } from '@google/generative-ai';
import { config } from '../config/env.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

// Intent tool definitions for function calling
const INTENT_TOOLS: Tool[] = [
  {
    functionDeclarations: [
      {
        name: 'add_todo',
        description: 'Add a new todo/task for the user. Use this when the user wants to create a task, add something to their list, or set a reminder for something to do.',
        parameters: {
          type: FunctionDeclarationSchemaType.OBJECT,
          properties: {
            title: {
              type: FunctionDeclarationSchemaType.STRING,
              description: 'The title/description of the task',
            },
            priority: {
              type: FunctionDeclarationSchemaType.STRING,
              description: 'Task priority level: low, medium, or high. Default to medium if not specified.',
            },
            due_date: {
              type: FunctionDeclarationSchemaType.STRING,
              description: 'Due date in YYYY-MM-DD format. Parse relative dates like "today", "tomorrow", "next Monday" to actual dates.',
            },
            due_time: {
              type: FunctionDeclarationSchemaType.STRING,
              description: 'Due time in HH:MM format (24-hour). Parse times like "5pm" to "17:00", "morning" to "09:00", etc.',
            },
            category: {
              type: FunctionDeclarationSchemaType.STRING,
              description: 'Task category like work, personal, health, shopping, etc.',
            },
          },
          required: ['title'],
        },
      },
      {
        name: 'add_journal',
        description: 'Add a journal entry for the user. Use this when the user wants to write in their journal, log their thoughts, reflect on their day, or record experiences.',
        parameters: {
          type: FunctionDeclarationSchemaType.OBJECT,
          properties: {
            content: {
              type: FunctionDeclarationSchemaType.STRING,
              description: 'The journal entry content',
            },
            mood: {
              type: FunctionDeclarationSchemaType.STRING,
              description: 'User\'s mood: great, good, okay, bad, or terrible',
            },
          },
          required: ['content'],
        },
      },
      {
        name: 'query_todos',
        description: 'Get/list user\'s todos. Use this when the user wants to see their tasks, check what they need to do, or review their list.',
        parameters: {
          type: FunctionDeclarationSchemaType.OBJECT,
          properties: {
            filter: {
              type: FunctionDeclarationSchemaType.STRING,
              description: 'Filter for todos: today (due today), pending (not completed), completed, all, or high_priority',
            },
          },
        },
      },
      {
        name: 'mark_complete',
        description: 'Mark a todo as complete. Use this when the user says they finished a task, completed something, or did something on their list.',
        parameters: {
          type: FunctionDeclarationSchemaType.OBJECT,
          properties: {
            task_identifier: {
              type: FunctionDeclarationSchemaType.STRING,
              description: 'Task title or partial match to identify the task',
            },
          },
          required: ['task_identifier'],
        },
      },
      {
        name: 'general_chat',
        description: 'General conversation that doesn\'t match other intents. Use this for greetings, questions, or when the user is just chatting.',
        parameters: {
          type: FunctionDeclarationSchemaType.OBJECT,
          properties: {
            response: {
              type: FunctionDeclarationSchemaType.STRING,
              description: 'A helpful, friendly response to the user',
            },
          },
          required: ['response'],
        },
      },
    ],
  },
];

// Model with function calling
const model = genAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
  tools: INTENT_TOOLS,
});

export interface ParsedIntent {
  intent: 'add_todo' | 'add_journal' | 'query_todos' | 'mark_complete' | 'general_chat';
  parameters: Record<string, string | undefined>;
  confidence: 'high' | 'medium' | 'low';
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

Analyze the user's message and call the most appropriate function.`;

  try {
    // Build chat history
    const history = context?.map((msg) => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }],
    })) || [];

    const chat = model.startChat({
      history: [
        {
          role: 'user',
          parts: [{ text: systemPrompt }],
        },
        {
          role: 'model',
          parts: [{ text: 'I understand. I will analyze user messages and call the appropriate function to help with their todos and journal entries.' }],
        },
        ...history,
      ],
    });

    const result = await chat.sendMessage(userMessage);
    const response = result.response;

    // Check for function call
    const functionCall = response.functionCalls()?.[0];

    if (functionCall) {
      return {
        intent: functionCall.name as ParsedIntent['intent'],
        parameters: (functionCall.args as Record<string, string>) || {},
        confidence: 'high',
      };
    }

    // Fallback to general chat if no function was called
    const text = response.text();
    return {
      intent: 'general_chat',
      parameters: { response: text || "I'm not sure how to help with that. You can ask me to add todos, write journal entries, or check your tasks!" },
      confidence: 'low',
    };
  } catch (error) {
    console.error('Error parsing intent with Gemini:', error);
    return {
      intent: 'general_chat',
      parameters: { response: 'Sorry, I had trouble understanding that. Could you try again?' },
      confidence: 'low',
    };
  }
}

/**
 * Generate a conversational response
 */
export async function generateResponse(prompt: string): Promise<string> {
  try {
    const simpleModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await simpleModel.generateContent(prompt);
    return result.response.text();
  } catch (error) {
    console.error('Error generating response:', error);
    return "Sorry, I couldn't generate a response right now.";
  }
}
