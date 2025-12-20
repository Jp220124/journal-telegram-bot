/**
 * Combined Research Engine Service
 * Orchestrates searches across Exa AI and Tavily
 * Deduplicates and ranks results
 */

import { searchWithExa, isExaAvailable } from './exaSearch.js';
import { searchWithTavily, isTavilyAvailable } from './tavilySearch.js';
import type {
  SearchResult,
  ResearchData,
  ResearchDepth,
  RESEARCH_SETTINGS,
} from '../types/research.js';

// Research settings by depth
const SETTINGS = {
  quick: {
    maxQueriesPerSource: 2,
    resultsPerQuery: 5,
    maxTotalSources: 10,
  },
  medium: {
    maxQueriesPerSource: 3,
    resultsPerQuery: 8,
    maxTotalSources: 15,
  },
  deep: {
    maxQueriesPerSource: 5,
    resultsPerQuery: 10,
    maxTotalSources: 25,
  },
} as const;

/**
 * Check if research is available (at least one search provider)
 */
export function isResearchAvailable(): boolean {
  return isExaAvailable() || isTavilyAvailable();
}

/**
 * Perform comprehensive research using multiple sources
 */
export async function performDeepResearch(
  queries: string[],
  depth: ResearchDepth = 'medium'
): Promise<ResearchData> {
  const settings = SETTINGS[depth];
  const selectedQueries = queries.slice(0, settings.maxQueriesPerSource);

  console.log(
    `🔬 Starting ${depth} research with ${selectedQueries.length} queries`
  );

  // Run searches in parallel
  const searchPromises: Promise<SearchResult[]>[] = [];

  for (const query of selectedQueries) {
    // Exa search
    if (isExaAvailable()) {
      searchPromises.push(
        searchWithExa(query, { numResults: settings.resultsPerQuery })
      );
    }

    // Tavily search
    if (isTavilyAvailable()) {
      searchPromises.push(
        searchWithTavily(query, { maxResults: settings.resultsPerQuery })
      );
    }
  }

  // Wait for all searches to complete
  const results = await Promise.allSettled(searchPromises);

  // Combine and process results
  const allResults: SearchResult[] = [];
  let exaCount = 0;
  let tavilyCount = 0;

  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const item of result.value) {
        allResults.push(item);
        if (item.source === 'exa') exaCount++;
        if (item.source === 'tavily') tavilyCount++;
      }
    }
  }

  // Deduplicate by URL
  const deduplicatedResults = deduplicateResults(allResults);

  // Sort by score (higher is better)
  deduplicatedResults.sort((a, b) => (b.score || 0) - (a.score || 0));

  // Limit to max sources
  const finalResults = deduplicatedResults.slice(0, settings.maxTotalSources);

  console.log(
    `✅ Research complete: ${finalResults.length} unique sources (Exa: ${exaCount}, Tavily: ${tavilyCount})`
  );

  return {
    queries: selectedQueries,
    results: finalResults,
    totalSources: finalResults.length,
    searchedAt: new Date().toISOString(),
    exaResultCount: exaCount,
    tavilyResultCount: tavilyCount,
  };
}

/**
 * Deduplicate results by URL, keeping the one with higher score
 */
function deduplicateResults(results: SearchResult[]): SearchResult[] {
  const urlMap = new Map<string, SearchResult>();

  for (const result of results) {
    const normalizedUrl = normalizeUrl(result.url);
    const existing = urlMap.get(normalizedUrl);

    if (!existing || (result.score || 0) > (existing.score || 0)) {
      urlMap.set(normalizedUrl, result);
    } else if (existing && result.content.length > existing.content.length) {
      // Prefer longer content if scores are equal
      urlMap.set(normalizedUrl, {
        ...result,
        score: existing.score, // Keep the higher score
      });
    }
  }

  return Array.from(urlMap.values());
}

/**
 * Normalize URL for deduplication
 */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove trailing slash, www prefix, and query params
    return parsed.hostname.replace(/^www\./, '') + parsed.pathname.replace(/\/$/, '');
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Quick research with minimal depth
 */
export async function quickResearch(query: string): Promise<ResearchData> {
  return performDeepResearch([query], 'quick');
}

/**
 * Research with a specific topic focus
 */
export async function focusedResearch(
  queries: string[],
  focusArea: string
): Promise<ResearchData> {
  // Append focus area to each query
  const focusedQueries = queries.map((q) => `${q} ${focusArea}`);
  return performDeepResearch(focusedQueries, 'medium');
}

/**
 * Research with custom settings
 */
export async function customResearch(
  queries: string[],
  options: {
    maxQueries?: number;
    resultsPerQuery?: number;
    maxTotalSources?: number;
    useExa?: boolean;
    useTavily?: boolean;
  }
): Promise<ResearchData> {
  const {
    maxQueries = 3,
    resultsPerQuery = 8,
    maxTotalSources = 15,
    useExa = true,
    useTavily = true,
  } = options;

  const selectedQueries = queries.slice(0, maxQueries);
  const searchPromises: Promise<SearchResult[]>[] = [];

  for (const query of selectedQueries) {
    if (useExa && isExaAvailable()) {
      searchPromises.push(searchWithExa(query, { numResults: resultsPerQuery }));
    }
    if (useTavily && isTavilyAvailable()) {
      searchPromises.push(
        searchWithTavily(query, { maxResults: resultsPerQuery })
      );
    }
  }

  const results = await Promise.allSettled(searchPromises);
  const allResults: SearchResult[] = [];
  let exaCount = 0;
  let tavilyCount = 0;

  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const item of result.value) {
        allResults.push(item);
        if (item.source === 'exa') exaCount++;
        if (item.source === 'tavily') tavilyCount++;
      }
    }
  }

  const deduplicatedResults = deduplicateResults(allResults);
  deduplicatedResults.sort((a, b) => (b.score || 0) - (a.score || 0));
  const finalResults = deduplicatedResults.slice(0, maxTotalSources);

  return {
    queries: selectedQueries,
    results: finalResults,
    totalSources: finalResults.length,
    searchedAt: new Date().toISOString(),
    exaResultCount: exaCount,
    tavilyResultCount: tavilyCount,
  };
}

/**
 * Get summary statistics about research capabilities
 */
export function getResearchCapabilities(): {
  exaAvailable: boolean;
  tavilyAvailable: boolean;
  isOperational: boolean;
} {
  return {
    exaAvailable: isExaAvailable(),
    tavilyAvailable: isTavilyAvailable(),
    isOperational: isResearchAvailable(),
  };
}
