/**
 * YouTube Video Analysis Service
 * Uses Gemini API to understand YouTube video content
 */

import { config } from '../config/env.js';

// ============================================================================
// Types
// ============================================================================

export interface VideoAnalysis {
  videoUrl: string;
  videoId: string;
  summary: string;
  keyPoints: string[];
  topics: string[];
  timestamps: Array<{
    time: string;
    description: string;
  }>;
  analyzedAt: string;
  error?: string;
}

// ============================================================================
// YouTube URL Detection
// ============================================================================

// Patterns to match various YouTube URL formats
const YOUTUBE_PATTERNS = [
  // Standard watch URLs: youtube.com/watch?v=VIDEO_ID
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?(?:[^&]+&)*v=([a-zA-Z0-9_-]{11})/gi,
  // Short URLs: youtu.be/VIDEO_ID
  /(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})/gi,
  // Shorts URLs: youtube.com/shorts/VIDEO_ID
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/gi,
  // Embed URLs: youtube.com/embed/VIDEO_ID
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/gi,
  // Mobile URLs: m.youtube.com/watch?v=VIDEO_ID
  /(?:https?:\/\/)?m\.youtube\.com\/watch\?(?:[^&]+&)*v=([a-zA-Z0-9_-]{11})/gi,
];

// Pattern to extract full URLs from text
const URL_EXTRACTION_PATTERN = /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^&\s]+&)*v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})(?:[^\s]*)?/gi;

/**
 * Check if a URL is a YouTube URL
 */
export function isYouTubeUrl(url: string): boolean {
  return YOUTUBE_PATTERNS.some(pattern => {
    pattern.lastIndex = 0; // Reset regex state
    return pattern.test(url);
  });
}

/**
 * Extract video ID from a YouTube URL
 */
export function extractVideoId(url: string): string | null {
  for (const pattern of YOUTUBE_PATTERNS) {
    pattern.lastIndex = 0; // Reset regex state
    const match = pattern.exec(url);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

/**
 * Extract all YouTube URLs from text content
 */
export function extractYouTubeUrls(text: string): string[] {
  const urls: string[] = [];
  let match;

  // Reset the pattern
  URL_EXTRACTION_PATTERN.lastIndex = 0;

  while ((match = URL_EXTRACTION_PATTERN.exec(text)) !== null) {
    // Reconstruct full URL
    let fullUrl = match[0];

    // Ensure URL has https://
    if (!fullUrl.startsWith('http')) {
      fullUrl = 'https://' + fullUrl;
    }

    // Clean up URL (remove trailing characters that might be punctuation)
    fullUrl = fullUrl.replace(/[),.\]]+$/, '');

    urls.push(fullUrl);
  }

  // Deduplicate by video ID
  const seenIds = new Set<string>();
  return urls.filter(url => {
    const id = extractVideoId(url);
    if (id && !seenIds.has(id)) {
      seenIds.add(id);
      return true;
    }
    return false;
  });
}

/**
 * Normalize YouTube URL to standard format
 */
export function normalizeYouTubeUrl(url: string): string | null {
  const videoId = extractVideoId(url);
  if (!videoId) return null;
  return `https://www.youtube.com/watch?v=${videoId}`;
}

// ============================================================================
// Gemini API Video Analysis
// ============================================================================

/**
 * Check if YouTube video analysis is available
 */
export function isYouTubeAnalysisAvailable(): boolean {
  return Boolean(config.geminiApiKey);
}

/**
 * Analyze a YouTube video using Gemini API
 */
export async function analyzeYouTubeVideo(url: string): Promise<VideoAnalysis> {
  const videoId = extractVideoId(url);

  if (!videoId) {
    throw new Error(`Invalid YouTube URL: ${url}`);
  }

  if (!config.geminiApiKey) {
    throw new Error('Gemini API key not configured');
  }

  // Normalize the URL for Gemini
  const normalizedUrl = normalizeYouTubeUrl(url);

  console.log(`🎬 Analyzing YouTube video: ${videoId}`);

  const prompt = `Analyze this YouTube video comprehensively. Provide a detailed analysis in the following JSON format:

{
  "summary": "A 2-3 sentence summary of the video's main content and message",
  "keyPoints": [
    "Key point 1 - specific and actionable insight from the video",
    "Key point 2 - another important takeaway",
    "Key point 3 - additional valuable insight",
    "Key point 4 - if applicable",
    "Key point 5 - if applicable"
  ],
  "topics": ["topic1", "topic2", "topic3"],
  "timestamps": [
    {"time": "0:00", "description": "Introduction/Opening"},
    {"time": "X:XX", "description": "Key moment description"}
  ]
}

Focus on:
1. The main message or lesson being conveyed
2. Actionable insights viewers can apply
3. Key topics or themes discussed
4. Notable moments with timestamps if identifiable

Return ONLY valid JSON, no markdown code blocks or additional text.`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${config.geminiApiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              {
                file_data: {
                  file_uri: normalizedUrl
                }
              }
            ]
          }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 2000,
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Gemini API error: ${response.status}`, errorText);
      throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };

    // Extract text from response
    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!responseText) {
      throw new Error('Empty response from Gemini API');
    }

    console.log(`📝 Raw Gemini response (first 500 chars): ${responseText.substring(0, 500)}`);

    // Parse JSON from response (handle potential markdown code blocks)
    let jsonText = responseText;

    // Remove markdown code blocks if present
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonText = jsonMatch[1].trim();
    }

    // Find JSON object in text
    const jsonObjectMatch = jsonText.match(/\{[\s\S]*\}/);
    if (!jsonObjectMatch) {
      console.error('❌ Could not find JSON in response:', responseText);
      throw new Error('Could not parse JSON from Gemini response');
    }

    const analysis = JSON.parse(jsonObjectMatch[0]);

    console.log(`✅ Video analysis complete for ${videoId}`);

    return {
      videoUrl: url,
      videoId,
      summary: analysis.summary || 'Video analysis completed.',
      keyPoints: analysis.keyPoints || [],
      topics: analysis.topics || [],
      timestamps: analysis.timestamps || [],
      analyzedAt: new Date().toISOString(),
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`❌ Error analyzing YouTube video ${videoId}:`, errorMessage);

    // Return partial result with error
    return {
      videoUrl: url,
      videoId,
      summary: '',
      keyPoints: [],
      topics: [],
      timestamps: [],
      analyzedAt: new Date().toISOString(),
      error: errorMessage,
    };
  }
}

/**
 * Analyze multiple YouTube videos
 */
export async function analyzeMultipleVideos(urls: string[]): Promise<VideoAnalysis[]> {
  // Analyze videos in parallel (but limit concurrency)
  const results: VideoAnalysis[] = [];

  // Process up to 3 videos at a time
  const BATCH_SIZE = 3;

  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const batch = urls.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(url => analyzeYouTubeVideo(url).catch(err => ({
        videoUrl: url,
        videoId: extractVideoId(url) || 'unknown',
        summary: '',
        keyPoints: [],
        topics: [],
        timestamps: [],
        analyzedAt: new Date().toISOString(),
        error: err.message,
      })))
    );
    results.push(...batchResults);
  }

  return results;
}

/**
 * Format video analysis for inclusion in research note
 */
export function formatVideoAnalysisForNote(analysis: VideoAnalysis): string {
  if (analysis.error) {
    return `## Video Analysis Failed

**Video:** [YouTube Video](${analysis.videoUrl})
**Error:** ${analysis.error}

_Unable to analyze this video. It may be private, unavailable, or there was an API error._
`;
  }

  let content = `## Video Insights

**Video:** [Watch on YouTube](${analysis.videoUrl})

### Summary
${analysis.summary}

### Key Takeaways
${analysis.keyPoints.map((point, i) => `${i + 1}. ${point}`).join('\n')}
`;

  if (analysis.topics.length > 0) {
    content += `
### Topics Covered
${analysis.topics.map(topic => `- ${topic}`).join('\n')}
`;
  }

  if (analysis.timestamps.length > 0) {
    content += `
### Key Moments
${analysis.timestamps.map(ts => `- **${ts.time}** - ${ts.description}`).join('\n')}
`;
  }

  return content;
}

/**
 * Format multiple video analyses for note
 */
export function formatMultipleVideoAnalysesForNote(analyses: VideoAnalysis[]): string {
  if (analyses.length === 0) return '';

  if (analyses.length === 1) {
    return formatVideoAnalysisForNote(analyses[0]);
  }

  // Multiple videos
  let content = `## Video Insights (${analyses.length} videos)\n\n`;

  analyses.forEach((analysis, index) => {
    content += `### Video ${index + 1}\n`;
    content += formatVideoAnalysisForNote(analysis).replace('## Video Insights\n\n', '');
    content += '\n---\n\n';
  });

  return content;
}
