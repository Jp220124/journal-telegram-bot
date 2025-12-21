/**
 * Task Understanding Service
 * Uses OpenRouter LLM to interpret task names and generate research queries
 */

import { config } from '../config/env.js';
import type { TaskUnderstanding } from '../types/research.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'z-ai/glm-4.5-air:free';

interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenRouterResponse {
  choices: Array<{
    message: {
      content?: string;
    };
  }>;
}

/**
 * Call OpenRouter API for task understanding
 */
async function callOpenRouter(
  messages: OpenRouterMessage[]
): Promise<string> {
  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://daily-journal.app',
      'X-Title': 'Daily Journal Research Agent',
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
  }

  const data = (await response.json()) as OpenRouterResponse;
  return data.choices[0]?.message?.content || '';
}

/**
 * Understand a task and generate research queries
 */
export async function understandTask(
  taskName: string,
  taskDescription?: string
): Promise<TaskUnderstanding> {
  const systemPrompt = `You are a research assistant. Analyze tasks to understand what research is needed.

Your job is to:
1. Interpret what the task is about
2. Determine if more clarification is needed from the user
3. Generate specific search queries for research
4. Suggest focus areas for the research

RESPOND ONLY IN JSON FORMAT with this exact structure:
{
  "interpretedTopic": "string - your understanding of what should be researched",
  "searchQueries": ["array of 3-5 specific search queries"],
  "needsClarification": boolean,
  "clarificationQuestion": "string or null - a specific question to ask if clarification is needed",
  "suggestedFocusAreas": ["array of 2-4 focus areas"],
  "confidence": number between 0 and 1
}

Rules for determining if clarification is needed:
- If the task name is very short or ambiguous (e.g., just a name like "IIT Ropar"), ask for focus area
- If the topic could mean multiple things, ask for clarification
- If the task name is already specific (e.g., "Research IIT Ropar admission process"), no clarification needed

Examples:

Task: "IIT Ropar"
Response: {
  "interpretedTopic": "Research about Indian Institute of Technology Ropar",
  "searchQueries": [
    "IIT Ropar overview history rankings",
    "IIT Ropar programs courses departments",
    "IIT Ropar campus facilities infrastructure",
    "IIT Ropar admission process eligibility",
    "IIT Ropar placements career opportunities"
  ],
  "needsClarification": true,
  "clarificationQuestion": "What aspect of IIT Ropar would you like me to focus on?",
  "suggestedFocusAreas": ["Admissions & Programs", "Research & Faculty", "Campus & Placements", "General Overview"],
  "confidence": 0.7
}

Task: "Best practices for React state management"
Response: {
  "interpretedTopic": "Research best practices for managing state in React applications",
  "searchQueries": [
    "React state management best practices 2024",
    "Redux vs Context API vs Zustand comparison",
    "React state management patterns",
    "When to use global state React",
    "React state management library comparison"
  ],
  "needsClarification": false,
  "clarificationQuestion": null,
  "suggestedFocusAreas": ["Library Comparison", "Performance Optimization", "Architecture Patterns", "Use Cases"],
  "confidence": 0.95
}`;

  const userPrompt = taskDescription
    ? `Task Name: "${taskName}"\nDescription: "${taskDescription}"\n\nAnalyze this task and provide your response in JSON format.`
    : `Task Name: "${taskName}"\n\nAnalyze this task and provide your response in JSON format.`;

  try {
    console.log(`🧠 Understanding task: "${taskName}"`);

    const response = await callOpenRouter([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);

    // Parse JSON response
    const parsed = JSON.parse(response) as TaskUnderstanding;

    // Validate required fields
    if (
      !parsed.interpretedTopic ||
      !Array.isArray(parsed.searchQueries) ||
      typeof parsed.needsClarification !== 'boolean'
    ) {
      throw new Error('Invalid response format');
    }

    console.log(
      `✅ Task understood: "${parsed.interpretedTopic}" (confidence: ${parsed.confidence})`
    );

    return {
      interpretedTopic: parsed.interpretedTopic,
      searchQueries: parsed.searchQueries.slice(0, 5), // Max 5 queries
      needsClarification: parsed.needsClarification,
      clarificationQuestion: parsed.clarificationQuestion || undefined,
      suggestedFocusAreas: parsed.suggestedFocusAreas || [],
      confidence: parsed.confidence || 0.5,
    };
  } catch (error) {
    console.error('❌ Error understanding task:', error);

    // Return a fallback understanding
    return {
      interpretedTopic: taskName,
      searchQueries: [
        `${taskName} overview`,
        `${taskName} information`,
        `${taskName} details`,
      ],
      needsClarification: true,
      clarificationQuestion: `I'd like to research "${taskName}". What specific aspects would you like me to focus on?`,
      suggestedFocusAreas: ['General Overview', 'Key Details', 'Recent Updates'],
      confidence: 0.3,
    };
  }
}

/**
 * Refine understanding based on user's clarification response
 */
export async function refineUnderstanding(
  taskName: string,
  originalUnderstanding: TaskUnderstanding,
  userClarification: string
): Promise<TaskUnderstanding> {
  const systemPrompt = `You are a research assistant. The user has provided clarification for a research task.

Original task: "${taskName}"
Original interpretation: "${originalUnderstanding.interpretedTopic}"
User's clarification: "${userClarification}"

Based on this clarification, generate refined search queries and focus areas.

RESPOND ONLY IN JSON FORMAT with this exact structure:
{
  "interpretedTopic": "string - refined understanding based on clarification",
  "searchQueries": ["array of 3-5 specific search queries incorporating the user's focus"],
  "needsClarification": false,
  "clarificationQuestion": null,
  "suggestedFocusAreas": ["array of 2-4 focus areas based on user's interest"],
  "confidence": number between 0 and 1 (should be higher now)
}`;

  try {
    console.log(`🔄 Refining understanding with: "${userClarification}"`);

    const response = await callOpenRouter([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Generate the refined research plan based on the clarification.' },
    ]);

    const parsed = JSON.parse(response) as TaskUnderstanding;

    console.log(`✅ Refined understanding: "${parsed.interpretedTopic}"`);

    return {
      interpretedTopic: parsed.interpretedTopic || originalUnderstanding.interpretedTopic,
      searchQueries: parsed.searchQueries?.slice(0, 5) || originalUnderstanding.searchQueries,
      needsClarification: false,
      clarificationQuestion: undefined,
      suggestedFocusAreas: parsed.suggestedFocusAreas || originalUnderstanding.suggestedFocusAreas,
      confidence: parsed.confidence || 0.9,
    };
  } catch (error) {
    console.error('❌ Error refining understanding:', error);

    // Fall back to appending clarification to original queries
    return {
      ...originalUnderstanding,
      interpretedTopic: `${originalUnderstanding.interpretedTopic} - ${userClarification}`,
      searchQueries: originalUnderstanding.searchQueries.map(
        (q) => `${q} ${userClarification}`
      ),
      needsClarification: false,
      clarificationQuestion: undefined,
      confidence: 0.8,
    };
  }
}

/**
 * Generate a simple topic analysis without search queries
 * Useful for quick categorization
 */
export async function analyzeTopic(
  taskName: string
): Promise<{
  topic: string;
  category: string;
  complexity: 'simple' | 'moderate' | 'complex';
}> {
  const systemPrompt = `Analyze this task/topic and categorize it.

RESPOND ONLY IN JSON FORMAT:
{
  "topic": "string - main topic/subject",
  "category": "string - category like Technology, Education, Business, Science, Personal, etc.",
  "complexity": "simple" | "moderate" | "complex"
}`;

  try {
    const response = await callOpenRouter([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Task: "${taskName}"` },
    ]);

    return JSON.parse(response);
  } catch {
    return {
      topic: taskName,
      category: 'General',
      complexity: 'moderate',
    };
  }
}
