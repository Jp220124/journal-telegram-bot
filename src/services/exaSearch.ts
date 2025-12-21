/**
 * Exa AI Search Service
 * Semantic search for research automation
 * https://exa.ai
 */

import Exa from 'exa-js';
import { config } from '../config/env.js';
import type { SearchResult } from '../types/research.js';

// Initialize Exa client (only if API key is configured)
let exaClient: Exa | null = null;

if (config.exaApiKey) {
  exaClient = new Exa(config.exaApiKey);
  console.log('✅ Exa AI client initialized');
} else {
  console.log('⚠️ Exa API key not configured, Exa search disabled');
}

/**
 * Check if Exa search is available
 */
export function isExaAvailable(): boolean {
  return exaClient !== null;
}

/**
 * Perform semantic search with Exa AI
 */
export async function searchWithExa(
  query: string,
  options: {
    numResults?: number;
    type?: 'auto' | 'neural' | 'keyword';
    useAutoprompt?: boolean;
    startPublishedDate?: string;
    endPublishedDate?: string;
    includeDomains?: string[];
    excludeDomains?: string[];
  } = {}
): Promise<SearchResult[]> {
  if (!exaClient) {
    console.warn('Exa client not initialized, skipping Exa search');
    return [];
  }

  const {
    numResults = 10,
    type = 'auto',
    useAutoprompt = true,
    startPublishedDate,
    endPublishedDate,
    includeDomains,
    excludeDomains,
  } = options;

  try {
    console.log(`🔍 Exa search: "${query}" (${numResults} results)`);

    const response = await exaClient.searchAndContents(query, {
      numResults,
      type,
      useAutoprompt,
      text: {
        maxCharacters: 3000,
        includeHtmlTags: false,
      },
      highlights: {
        numSentences: 3,
        highlightsPerUrl: 2,
      },
      ...(startPublishedDate && { startPublishedDate }),
      ...(endPublishedDate && { endPublishedDate }),
      ...(includeDomains && { includeDomains }),
      ...(excludeDomains && { excludeDomains }),
    });

    const results: SearchResult[] = response.results.map((r: any) => ({
      title: r.title || 'Untitled',
      url: r.url,
      content: r.text || r.highlights?.join('\n\n') || '',
      publishedDate: r.publishedDate || undefined,
      author: r.author || undefined,
      score: r.score,
      source: 'exa' as const,
    }));

    console.log(`✅ Exa returned ${results.length} results`);
    return results;
  } catch (error) {
    console.error('❌ Exa search error:', error);
    return [];
  }
}

/**
 * Search for recent news and articles
 */
export async function searchRecentNews(
  query: string,
  daysBack: number = 30
): Promise<SearchResult[]> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysBack);

  return searchWithExa(query, {
    numResults: 10,
    type: 'neural',
    startPublishedDate: startDate.toISOString().split('T')[0],
  });
}

/**
 * Search for academic/research content
 */
export async function searchAcademic(query: string): Promise<SearchResult[]> {
  return searchWithExa(query, {
    numResults: 10,
    type: 'neural',
    includeDomains: [
      'arxiv.org',
      'scholar.google.com',
      'researchgate.net',
      'ncbi.nlm.nih.gov',
      'ieee.org',
      'acm.org',
      'nature.com',
      'sciencedirect.com',
    ],
  });
}

/**
 * Search with specific domain focus
 */
export async function searchDomains(
  query: string,
  domains: string[]
): Promise<SearchResult[]> {
  return searchWithExa(query, {
    numResults: 10,
    type: 'neural',
    includeDomains: domains,
  });
}

/**
 * Find similar content to a URL
 */
export async function findSimilar(
  url: string,
  numResults: number = 5
): Promise<SearchResult[]> {
  if (!exaClient) {
    return [];
  }

  try {
    const response = await exaClient.findSimilarAndContents(url, {
      numResults,
      text: { maxCharacters: 2000 },
    });

    return response.results.map((r: any) => ({
      title: r.title || 'Untitled',
      url: r.url,
      content: r.text || '',
      publishedDate: r.publishedDate || undefined,
      author: r.author || undefined,
      score: r.score,
      source: 'exa' as const,
    }));
  } catch (error) {
    console.error('Exa findSimilar error:', error);
    return [];
  }
}
