/**
 * Tavily Search Service
 * AI-optimized search for research automation
 * https://tavily.com
 */

import { tavily } from '@tavily/core';
import { config } from '../config/env.js';
import type { SearchResult } from '../types/research.js';

// Initialize Tavily client (only if API key is configured)
let tavilyClient: ReturnType<typeof tavily> | null = null;

if (config.tavilyApiKey) {
  tavilyClient = tavily({ apiKey: config.tavilyApiKey });
  console.log('✅ Tavily client initialized');
} else {
  console.log('⚠️ Tavily API key not configured, Tavily search disabled');
}

/**
 * Check if Tavily search is available
 */
export function isTavilyAvailable(): boolean {
  return tavilyClient !== null;
}

/**
 * Perform search with Tavily
 */
export async function searchWithTavily(
  query: string,
  options: {
    maxResults?: number;
    searchDepth?: 'basic' | 'advanced';
    topic?: 'general' | 'news';
    includeAnswer?: boolean;
    includeRawContent?: boolean;
    includeDomains?: string[];
    excludeDomains?: string[];
  } = {}
): Promise<SearchResult[]> {
  if (!tavilyClient) {
    console.warn('Tavily client not initialized, skipping Tavily search');
    return [];
  }

  const {
    maxResults = 10,
    searchDepth = 'advanced',
    topic = 'general',
    includeAnswer = false,
    includeRawContent = true,
    includeDomains,
    excludeDomains,
  } = options;

  try {
    console.log(`🔍 Tavily search: "${query}" (${maxResults} results)`);

    const response = await tavilyClient.search(query, {
      maxResults,
      searchDepth,
      topic,
      includeAnswer,
      // Note: includeRawContent has been removed in newer Tavily SDK versions
      ...(includeDomains && { includeDomains }),
      ...(excludeDomains && { excludeDomains }),
    });

    const results: SearchResult[] = response.results.map((r: any) => ({
      title: r.title || 'Untitled',
      url: r.url,
      content: r.rawContent || r.content || '',
      score: r.score,
      source: 'tavily' as const,
    }));

    console.log(`✅ Tavily returned ${results.length} results`);
    return results;
  } catch (error) {
    console.error('❌ Tavily search error:', error);
    return [];
  }
}

/**
 * Quick search with basic depth (faster, less comprehensive)
 */
export async function quickSearch(
  query: string,
  maxResults: number = 5
): Promise<SearchResult[]> {
  return searchWithTavily(query, {
    maxResults,
    searchDepth: 'basic',
    includeRawContent: false,
  });
}

/**
 * Deep search with advanced depth (slower, more comprehensive)
 */
export async function deepSearch(
  query: string,
  maxResults: number = 10
): Promise<SearchResult[]> {
  return searchWithTavily(query, {
    maxResults,
    searchDepth: 'advanced',
    includeRawContent: true,
  });
}

/**
 * Search for recent news
 */
export async function searchNews(
  query: string,
  maxResults: number = 10
): Promise<SearchResult[]> {
  return searchWithTavily(query, {
    maxResults,
    searchDepth: 'basic',
    topic: 'news',
  });
}

/**
 * Get a direct answer to a question
 */
export async function getAnswer(
  question: string
): Promise<{ answer: string; sources: SearchResult[] }> {
  if (!tavilyClient) {
    return { answer: '', sources: [] };
  }

  try {
    const response = await tavilyClient.search(question, {
      maxResults: 5,
      searchDepth: 'advanced',
      includeAnswer: true,
    });

    const sources: SearchResult[] = response.results.map((r: any) => ({
      title: r.title || 'Untitled',
      url: r.url,
      content: r.content || '',
      score: r.score,
      source: 'tavily' as const,
    }));

    return {
      answer: response.answer || '',
      sources,
    };
  } catch (error) {
    console.error('Tavily getAnswer error:', error);
    return { answer: '', sources: [] };
  }
}

/**
 * Extract content from a specific URL
 */
export async function extractFromUrl(url: string): Promise<string> {
  if (!tavilyClient) {
    return '';
  }

  try {
    const response = await tavilyClient.extract([url]);
    if (response.results && response.results.length > 0) {
      return response.results[0].rawContent || '';
    }
    return '';
  } catch (error) {
    console.error('Tavily extract error:', error);
    return '';
  }
}
