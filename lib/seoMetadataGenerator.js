/**
 * SEO Metadata Generator Module
 * 
 * Generates SEO-optimized metadata for workflow output images:
 * - Uses AI vision to analyze image and extract main keyword
 * - Fetches Google suggestions for keyword expansion
 * - Generates AI-powered SEO title
 * - Returns metadata object for EXIF injection (title, keywords, comments, rating)
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { readKey } = require('./utils');
const { executeOpenAIRequest } = require('./openaiQueue');
const { executeAnthropicRequest } = require('./anthropicQueue');
const { executeGoogleAIRequest } = require('./googleAIQueue');
const { vcai } = require('../automations/vcai');

// Constants for image optimization
const MAX_IMAGE_DIMENSION = 512;
const JPEG_QUALITY = 70;

// VC AI circuit breaker — skip VC AI and use OpenAI for 20 minutes after a failure
const VCAI_COOLDOWN_MS = 20 * 60 * 1000; // 20 minutes
let vcaiFailedAt = 0; // timestamp of last VC AI failure

/**
 * Check if VC AI is in cooldown (failed recently)
 * @returns {boolean}
 */
function isVcaiInCooldown() {
  if (vcaiFailedAt === 0) return false;
  if (Date.now() - vcaiFailedAt >= VCAI_COOLDOWN_MS) {
    // Cooldown expired, reset and let it try again
    vcaiFailedAt = 0;
    console.log('[SEOMetadata] VC AI cooldown expired, will attempt VC AI again');
    return false;
  }
  return true;
}

/**
 * Mark VC AI as failed, starting the cooldown period
 */
function markVcaiFailed() {
  vcaiFailedAt = Date.now();
  const expiresIn = Math.round(VCAI_COOLDOWN_MS / 60000);
  console.log(`[SEOMetadata] VC AI marked as unavailable, falling back to OpenAI for ${expiresIn} minutes`);
}

/**
 * Optimize an image for AI vision analysis
 * Resizes to 512px max and compresses to minimize tokens
 * @param {string} imagePath - Path to the image file
 * @returns {Promise<string>} - Base64 data URL
 */
async function optimizeImageForAnalysis(imagePath) {
  try {
    const inputBuffer = fs.readFileSync(imagePath);
    const metadata = await sharp(inputBuffer).metadata();
    const { width, height, hasAlpha } = metadata;

    // Calculate new dimensions maintaining aspect ratio
    let newWidth = width;
    let newHeight = height;

    if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
      if (width > height) {
        newWidth = MAX_IMAGE_DIMENSION;
        newHeight = Math.round((height / width) * MAX_IMAGE_DIMENSION);
      } else {
        newHeight = MAX_IMAGE_DIMENSION;
        newWidth = Math.round((width / height) * MAX_IMAGE_DIMENSION);
      }
    }

    // Process image with sharp - always use JPEG for smaller size
    const outputBuffer = await sharp(inputBuffer)
      .resize(newWidth, newHeight, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();

    const base64 = outputBuffer.toString('base64');
    return `data:image/jpeg;base64,${base64}`;
  } catch (error) {
    console.error('[SEOMetadata] Error optimizing image:', error.message);
    throw error;
  }
}

/**
 * Extract the main keyword from an image using AI vision, or from text context using VC AI
 * @param {string} base64Image - Base64 data URL of the image (not used for vcai)
 * @param {string} aiProvider - AI provider: 'openai', 'anthropic', 'googleai', 'vcai'
 * @param {Object} aiSettings - Settings containing API keys, models etc.
 * @param {string|null} promptContext - The generation prompt used to create the image (for vcai text-based extraction)
 * @returns {Promise<string>} - Extracted keyword (1-3 words)
 */
async function extractKeywordFromImage(base64Image, aiProvider, aiSettings, promptContext = null) {
  const timeout = 60000; // 60 seconds

  try {
    // VC AI: Use text-based keyword extraction (no image sent)
    if (aiProvider === 'vcai') {
      let textPrompt;
      if (promptContext) {
        textPrompt = `You are an SEO keyword expert. Given the following text content related to an image, respond with ONLY the single most relevant keyword (1-3 words maximum) that describes the main subject or theme. No explanation, no punctuation, just the keyword.\n\nContent: "${promptContext}"\n\nExamples of good responses: "burger", "sunset beach", "cute puppy", "red sports car"`;
      } else {
        throw new Error('VC AI requires prompt context for keyword extraction');
      }

      const vcaiResult = await vcai('', textPrompt, 0.3, null, null, 100, timeout);
      if (!vcaiResult.success) {
        throw new Error(`VC AI failed: ${vcaiResult.value}`);
      }
      const keyword = vcaiResult.value
        .replace(/["'.,!?]/g, '')
        .trim()
        .toLowerCase()
        .substring(0, 50);
      console.log(`[SEOMetadata] Extracted keyword: "${keyword}" using vcai (text-based)`);
      return keyword;
    }

    const prompt = `Analyze this image and respond with ONLY the single most relevant keyword (1-3 words maximum) that describes the main subject or theme. No explanation, no punctuation, just the keyword. Examples of good responses: "burger", "sunset beach", "cute puppy", "red sports car"`;
    let result;

    switch (aiProvider) {
      case 'openai':
        result = await executeOpenAIRequest(
          prompt,
          aiSettings.openaiModel || 'gpt-5-nano',
          0.3, // Low temperature for consistent results
          base64Image,
          timeout
        );
        break;

      case 'anthropic':
        result = await executeAnthropicRequest(
          prompt,
          aiSettings.anthropicModel || 'claude-3-haiku-20240307',
          0.3,
          base64Image,
          null, // systemPrompt
          100, // maxTokens - we only need a few words
          timeout
        );
        break;

      case 'googleai':
        result = await executeGoogleAIRequest(
          prompt,
          aiSettings.googleaiModel || 'gemini-1.5-flash',
          0.3,
          base64Image,
          null, // systemPrompt
          100, // maxTokens
          timeout
        );
        break;

      default:
        // Default to OpenAI
        result = await executeOpenAIRequest(
          prompt,
          'gpt-5-nano',
          0.3,
          base64Image,
          timeout
        );
    }

    if (!result?.message) {
      throw new Error('No response from AI');
    }

    // Clean up the response - remove quotes, punctuation, extra whitespace
    const keyword = result.message
      .replace(/["'.,!?]/g, '')
      .trim()
      .toLowerCase()
      .substring(0, 50); // Limit length

    console.log(`[SEOMetadata] Extracted keyword: "${keyword}" using ${aiProvider}`);
    return keyword;
  } catch (error) {
    console.error(`[SEOMetadata] Error extracting keyword with ${aiProvider}:`, error.message);
    throw error;
  }
}

/**
 * Fetch Google search suggestions for a keyword
 * Uses proxy for country-specific suggestions
 * @param {string} keyword - The keyword to get suggestions for
 * @param {Object|null} proxy - Proxy config {ip, port, username, password} or null
 * @returns {Promise<string[]>} - Array of suggestion strings
 */
async function fetchGoogleSuggestions(keyword, proxy = null) {
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(keyword)}`;

  try {
    const fetchOptions = {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 15000,
    };

    // Add proxy agent if proxy is configured
    if (proxy && proxy.ip && proxy.ip !== 'NULL') {
      let proxyUrl;
      if (proxy.username && proxy.username !== 'NULL' && proxy.password && proxy.password !== 'NULL') {
        proxyUrl = `http://${proxy.username}:${proxy.password}@${proxy.ip}:${proxy.port}`;
      } else {
        proxyUrl = `http://${proxy.ip}:${proxy.port}`;
      }
      fetchOptions.agent = new HttpsProxyAgent(proxyUrl);
      console.log(`[SEOMetadata] Fetching Google suggestions via proxy: ${proxy.ip}:${proxy.port}`);
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    
    // Response format: ["keyword", ["suggestion1", "suggestion2", ...], [], {...}]
    if (Array.isArray(data) && Array.isArray(data[1])) {
      const suggestions = data[1].slice(0, 10); // Max 10 suggestions
      console.log(`[SEOMetadata] Got ${suggestions.length} Google suggestions for "${keyword}"`);
      return suggestions;
    }

    // If no suggestions, return the original keyword
    console.log(`[SEOMetadata] No Google suggestions found, using keyword as fallback`);
    return [keyword];
  } catch (error) {
    console.error('[SEOMetadata] Error fetching Google suggestions:', error.message);
    // Return keyword as fallback on error
    return [keyword];
  }
}

/**
 * Generate an SEO-optimized title using AI
 * @param {string} keyword - Main keyword extracted from image
 * @param {string[]} suggestions - Google suggestions array
 * @param {string} aiProvider - AI provider: 'openai', 'anthropic', 'googleai'
 * @param {Object} aiSettings - Settings containing API keys, models etc.
 * @returns {Promise<string>} - SEO-optimized title
 */
async function generateSEOTitle(keyword, suggestions, aiProvider, aiSettings) {
  const suggestionsText = suggestions.slice(0, 5).join(', ');
  
  const prompt = `Create a short, SEO-optimized title (maximum 60 characters) for an image about "${keyword}".

Related popular searches: ${suggestionsText}

Requirements:
- Use the main keyword naturally
- Make it engaging and descriptive
- Include 1-2 related keywords if they fit naturally
- Do NOT use quotes, hashtags, or special characters
- Respond with ONLY the title, nothing else

Example good titles:
- "Delicious Homemade Burger Recipe Ideas"
- "Beautiful Sunset Beach Photography"
- "Cute Golden Retriever Puppy Portrait"`;

  const timeout = 60000;

  try {
    let result;

    switch (aiProvider) {
      case 'vcai': {
        const vcaiResult = await vcai('', prompt, 0.7, null, null, 100, timeout);
        if (!vcaiResult.success) throw new Error(`VC AI failed: ${vcaiResult.value}`);
        result = { message: vcaiResult.value };
        break;
      }

      case 'openai':
        result = await executeOpenAIRequest(
          prompt,
          aiSettings.openaiModel || 'gpt-5-nano',
          0.7, // Higher temperature for creativity
          null, // No image needed
          timeout
        );
        break;

      case 'anthropic':
        result = await executeAnthropicRequest(
          prompt,
          aiSettings.anthropicModel || 'claude-3-haiku-20240307',
          0.7,
          null,
          null,
          100,
          timeout
        );
        break;

      case 'googleai':
        result = await executeGoogleAIRequest(
          prompt,
          aiSettings.googleaiModel || 'gemini-1.5-flash',
          0.7,
          null,
          null,
          100,
          timeout
        );
        break;

      default:
        result = await executeOpenAIRequest(
          prompt,
          'gpt-5-nano',
          0.7,
          null,
          timeout
        );
    }

    if (!result?.message) {
      throw new Error('No response from AI');
    }

    // Clean up the title
    let title = result.message
      .replace(/^["']|["']$/g, '') // Remove surrounding quotes
      .replace(/[\n\r]/g, ' ')     // Remove newlines
      .trim();

    // Ensure title is not too long
    if (title.length > 60) {
      title = title.substring(0, 57) + '...';
    }

    console.log(`[SEOMetadata] Generated SEO title: "${title}"`);
    return title;
  } catch (error) {
    console.error(`[SEOMetadata] Error generating title with ${aiProvider}:`, error.message);
    // Fallback: capitalize the keyword
    return keyword.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
}

/**
 * Generate complete SEO metadata for an image
 * Main orchestrator function
 * @param {string} imagePath - Path to the image file
 * @param {Object} settings - SEO settings
 * @param {string} settings.aiProvider - AI provider to use
 * @param {Object} settings.aiSettings - AI-specific settings (models)
 * @param {Object|null} settings.proxy - Proxy for Google suggestions
 * @returns {Promise<Object>} - SEO metadata object
 */
async function generateSEOMetadata(imagePath, settings) {
  const { aiProvider: requestedProvider = 'openai', aiSettings = {}, proxy = null, prompt: promptContext = null } = settings;

  // Circuit breaker: if VC AI is in cooldown, transparently fall back to OpenAI
  let aiProvider = requestedProvider;
  if (aiProvider === 'vcai' && isVcaiInCooldown()) {
    const remainingMin = Math.round((VCAI_COOLDOWN_MS - (Date.now() - vcaiFailedAt)) / 60000);
    console.log(`[SEOMetadata] VC AI in cooldown (~${remainingMin} min left), using OpenAI fallback`);
    aiProvider = 'openai';
  }

  // VC AI needs prompt context for text-based extraction — skip if missing
  if (aiProvider === 'vcai' && !promptContext) {
    console.log('[SEOMetadata] No prompt context available for VC AI, skipping SEO metadata');
    return {
      success: false,
      skipped: true,
      error: 'No text context available for VC AI keyword extraction (no prompt/title provided to this node)',
    };
  }

  console.log(`[SEOMetadata] Generating SEO metadata for: ${path.basename(imagePath)} (provider: ${aiProvider})`);

  try {
    let base64Image = null;

    // Step 1: Optimize image for AI analysis (skip for vcai — uses text instead)
    if (aiProvider !== 'vcai') {
      console.log('[SEOMetadata] Step 1/4: Optimizing image for analysis...');
      base64Image = await optimizeImageForAnalysis(imagePath);
    } else {
      console.log('[SEOMetadata] Step 1/4: Skipping image optimization (VC AI uses text-based extraction)...');
    }

    // Step 2: Extract main keyword using AI vision (or text context for vcai)
    console.log('[SEOMetadata] Step 2/4: Extracting keyword...');
    let keyword;
    try {
      keyword = await extractKeywordFromImage(base64Image, aiProvider, aiSettings, promptContext);
    } catch (keywordError) {
      // If VC AI failed, engage circuit breaker and retry with OpenAI
      if (aiProvider === 'vcai') {
        markVcaiFailed();
        console.log('[SEOMetadata] Retrying keyword extraction with OpenAI fallback...');
        base64Image = await optimizeImageForAnalysis(imagePath);
        aiProvider = 'openai';
        keyword = await extractKeywordFromImage(base64Image, aiProvider, aiSettings, promptContext);
      } else {
        throw keywordError;
      }
    }

    // Step 3: Fetch Google suggestions
    console.log('[SEOMetadata] Step 3/4: Fetching Google suggestions...');
    const suggestions = await fetchGoogleSuggestions(keyword, proxy);

    // Step 4: Generate SEO title
    console.log('[SEOMetadata] Step 4/4: Generating SEO title...');
    let title;
    try {
      title = await generateSEOTitle(keyword, suggestions, aiProvider, aiSettings);
    } catch (titleError) {
      // If VC AI failed on title generation, engage circuit breaker and retry with OpenAI
      if (aiProvider === 'vcai') {
        markVcaiFailed();
        console.log('[SEOMetadata] Retrying title generation with OpenAI fallback...');
        aiProvider = 'openai';
        title = await generateSEOTitle(keyword, suggestions, aiProvider, aiSettings);
      } else {
        throw titleError;
      }
    }

    // Build the SEO metadata object
    const seoMetadata = {
      title: title,
      object: title, // Same as title per requirements
      rating: 5, // Always 5 stars per requirements
      keywords: suggestions, // Array of keywords from Google suggestions
      comments: suggestions.join('\n'), // Keywords joined with newlines (one per line)
    };

    console.log('[SEOMetadata] Successfully generated SEO metadata:', {
      title: seoMetadata.title,
      keywordsCount: seoMetadata.keywords.length,
      rating: seoMetadata.rating,
    });

    return {
      success: true,
      metadata: seoMetadata,
    };
  } catch (error) {
    console.error('[SEOMetadata] Failed to generate SEO metadata:', error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Load SEO metadata settings from storage
 * @returns {Promise<Object>} - Settings object
 */
async function loadSEOSettings() {
  const settings = readKey('seoMetadataSettings') || {
    enabled: false,
    platforms: {
      facebook: true,
      pinterest: true,
    },
    aiProvider: 'openai',
  };
  return settings;
}

module.exports = {
  optimizeImageForAnalysis,
  extractKeywordFromImage,
  fetchGoogleSuggestions,
  generateSEOTitle,
  generateSEOMetadata,
  loadSEOSettings,
};
