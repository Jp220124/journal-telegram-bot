/**
 * Note Synthesis Service
 * Generates structured research notes from search results using LLM
 */

import { config } from '../config/env.js';
import type {
  ResearchData,
  GeneratedNote,
  SourceReference,
  SearchResult,
} from '../types/research.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'z-ai/glm-4.5-air:free';

// Research brief word limits
const MAX_WORDS = 500;
const MAX_TOKENS = 1500;

interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Call OpenRouter API for note generation
 */
async function callOpenRouter(messages: OpenRouterMessage[]): Promise<string> {
  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://daily-journal.app',
      'X-Title': 'Daily Journal Research Synthesis',
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: MAX_TOKENS, // Concise, focused output
      temperature: 0.7, // Balanced creativity and accuracy
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content?: string } }>;
  };
  return data.choices[0]?.message?.content || '';
}

/**
 * Format search results for LLM context
 */
function formatSourcesForContext(results: SearchResult[]): string {
  return results
    .slice(0, 15) // Limit to top 15 sources to fit context window
    .map(
      (r, i) => `
=== Source ${i + 1}: ${r.title} ===
URL: ${r.url}
${r.publishedDate ? `Published: ${r.publishedDate}` : ''}
${r.author ? `Author: ${r.author}` : ''}

Content:
${r.content.slice(0, 2000)}
`
    )
    .join('\n---\n');
}

/**
 * Synthesize research results into a structured note
 */
export async function synthesizeResearchNote(
  taskName: string,
  researchData: ResearchData,
  focusAreas: string[] = []
): Promise<GeneratedNote> {
  const sourcesText = formatSourcesForContext(researchData.results);
  const focusText =
    focusAreas.length > 0 ? `Focus Areas: ${focusAreas.join(', ')}` : '';

  const systemPrompt = `You are an expert research analyst creating a CONCISE research brief. Your output must be scannable, actionable, and under ${MAX_WORDS} words.

STRICT OUTPUT FORMAT (use these exact section headers):

## 🎯 TL;DR
[One powerful sentence capturing the most important insight]

## 📊 Key Numbers
• **[Number/Stat]** — [What it means in context]
• **[Number/Stat]** — [What it means in context]
• **[Number/Stat]** — [What it means in context]
(Include 3-4 most impactful statistics or numbers from the research)

## 💡 Top Insights

### 1. [Insight Title]
[2-3 sentences explaining this insight and why it matters] [1]

### 2. [Insight Title]
[2-3 sentences explaining this insight and why it matters] [2]

### 3. [Insight Title]
[2-3 sentences explaining this insight and why it matters] [3]

## ⚡ Action Items
• [Specific actionable recommendation based on research]
• [Another actionable recommendation]
• [Third actionable recommendation]

## 📚 Top Sources
Use [1], [2], [3] etc. for inline citations. List sources at the end.

RULES:
1. MAXIMUM ${MAX_WORDS} WORDS - be ruthlessly concise
2. Every sentence must add unique value - NO filler
3. Lead with insights, not background
4. Use specific numbers and data points
5. Make it actionable - what should the reader DO?
6. Write for a busy professional who needs quick insights
7. Use inline citations [1], [2], [3] to reference sources`;

  const userPrompt = `RESEARCH TOPIC: "${taskName}"
${focusText}

SOURCES (${researchData.results.length} total):
${sourcesText}

Create a concise research brief following the exact format specified. Remember: MAXIMUM ${MAX_WORDS} words, focus on actionable insights.`;

  try {
    console.log(`📝 Synthesizing note for: "${taskName}"`);

    const content = await callOpenRouter([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);

    // Extract sources from results
    const sources: SourceReference[] = researchData.results
      .slice(0, 15)
      .map((r) => ({
        title: r.title,
        url: r.url,
        author: r.author,
        publishedDate: r.publishedDate,
      }));

    // Parse sections from content
    const sections = extractSections(content);

    console.log(
      `✅ Note synthesized: ${content.length} characters, ${sections.length} sections`
    );

    return {
      title: `Research: ${taskName}`,
      content,
      sources,
      sections,
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error('❌ Error synthesizing note:', error);

    // Return a fallback note with raw data
    return createFallbackNote(taskName, researchData);
  }
}

/**
 * Extract section summaries from markdown content
 */
function extractSections(
  content: string
): Array<{ heading: string; bulletPoints: string[] }> {
  const sections: Array<{ heading: string; bulletPoints: string[] }> = [];
  const lines = content.split('\n');

  let currentHeading = '';
  let currentBullets: string[] = [];

  for (const line of lines) {
    // Check for heading (## or ###)
    const headingMatch = line.match(/^#{2,3}\s+(.+)$/);
    if (headingMatch) {
      // Save previous section
      if (currentHeading) {
        sections.push({
          heading: currentHeading,
          bulletPoints: currentBullets,
        });
      }
      currentHeading = headingMatch[1];
      currentBullets = [];
    }
    // Check for bullet point
    else if (line.match(/^\s*[-*]\s+(.+)$/)) {
      const bulletMatch = line.match(/^\s*[-*]\s+(.+)$/);
      if (bulletMatch) {
        currentBullets.push(bulletMatch[1]);
      }
    }
  }

  // Don't forget the last section
  if (currentHeading) {
    sections.push({
      heading: currentHeading,
      bulletPoints: currentBullets,
    });
  }

  return sections;
}

/**
 * Create a fallback note if synthesis fails
 */
function createFallbackNote(
  taskName: string,
  researchData: ResearchData
): GeneratedNote {
  const sources: SourceReference[] = researchData.results.slice(0, 10).map((r) => ({
    title: r.title,
    url: r.url,
    author: r.author,
    publishedDate: r.publishedDate,
  }));

  const content = `# Research: ${taskName}

## Summary
This is an automated research note compiled from ${researchData.results.length} sources.

## Key Sources

${researchData.results
  .slice(0, 10)
  .map(
    (r, i) => `### ${i + 1}. ${r.title}

${r.content.slice(0, 500)}...

[Read more](${r.url})
`
  )
  .join('\n')}

## Sources

${sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join('\n')}

---
*Note: This note was automatically generated. Review and edit as needed.*
`;

  return {
    title: `Research: ${taskName}`,
    content,
    sources,
    sections: [
      {
        heading: 'Summary',
        bulletPoints: [`Compiled from ${researchData.results.length} sources`],
      },
    ],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Generate a brief summary for Telegram notification
 */
export async function generateNoteSummary(
  note: GeneratedNote,
  maxLength: number = 500
): Promise<string> {
  // Try to extract executive summary from the note
  const summaryMatch = note.content.match(
    /## (?:Executive )?Summary\s*\n([\s\S]*?)(?=\n## |\n# |$)/i
  );

  if (summaryMatch) {
    const summary = summaryMatch[1].trim();
    if (summary.length <= maxLength) {
      return summary;
    }
    return summary.slice(0, maxLength - 3) + '...';
  }

  // Fall back to first paragraph
  const paragraphs = note.content.split('\n\n').filter((p) => !p.startsWith('#'));
  if (paragraphs.length > 0) {
    const firstPara = paragraphs[0].replace(/[#*_]/g, '').trim();
    if (firstPara.length <= maxLength) {
      return firstPara;
    }
    return firstPara.slice(0, maxLength - 3) + '...';
  }

  return `Research note with ${note.sources.length} sources.`;
}

/**
 * Generate a comparison note for multiple topics
 */
export async function synthesizeComparisonNote(
  topics: string[],
  researchData: Record<string, ResearchData>
): Promise<GeneratedNote> {
  const allSources: SearchResult[] = [];

  let sourcesContext = '';
  for (const topic of topics) {
    const data = researchData[topic];
    if (data) {
      sourcesContext += `\n\n### Topic: ${topic}\n`;
      sourcesContext += formatSourcesForContext(data.results.slice(0, 5));
      allSources.push(...data.results.slice(0, 5));
    }
  }

  const systemPrompt = `You are a research synthesizer specializing in comparative analysis.
Create a comprehensive comparison note that:
1. Compares and contrasts the topics objectively
2. Highlights key differences and similarities
3. Provides balanced analysis
4. Uses tables or structured comparisons where helpful

Use Markdown formatting with proper headers and bullet points.`;

  const userPrompt = `Compare these topics: ${topics.join(', ')}

${sourcesContext}

Create a detailed comparison note.`;

  try {
    const content = await callOpenRouter([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);

    const sources: SourceReference[] = allSources.map((r) => ({
      title: r.title,
      url: r.url,
      author: r.author,
      publishedDate: r.publishedDate,
    }));

    return {
      title: `Comparison: ${topics.join(' vs ')}`,
      content,
      sources,
      sections: extractSections(content),
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Error synthesizing comparison note:', error);
    throw error;
  }
}
