import { log } from '../shared.mjs';

/**
 * VoyageAIEnricher - Enhance metadata using Voyage AI API
 * 
 * Responsibilities:
 * 1. Generate embeddings for titles/descriptions
 * 2. Classify genres/tags using AI
 * 3. Extract additional metadata
 * 4. Rate limiting and error handling
 * 
 * Note: Requires VOYAGE_API_KEY environment variable
 */

export class VoyageAIEnricher {
  constructor(options = {}) {
    this.options = {
      apiKey: process.env.VOYAGE_API_KEY,
      baseUrl: 'https://api.voyageai.com/v1',
      dryRun: false,
      verbose: false,
      timeout: 30000,
      ...options
    };
    
    if (!this.options.apiKey && !this.options.dryRun) {
      throw new Error('VOYAGE_API_KEY environment variable is required for Voyage AI enrichment');
    }
    
    this.client = null;
  }
  
  /**
   * Initialize the Voyage AI client
   */
  async initialize() {
    if (this.options.dryRun) {
      log('DRY RUN: Voyage AI client would be initialized', 'info');
      return;
    }
    
    try {
      // Note: In a real implementation, you would import and configure
      // the Voyage AI SDK here. For now, we'll use fetch API.
      log('Voyage AI enricher initialized', 'info');
      
    } catch (error) {
      log(`Failed to initialize Voyage AI: ${error.message}`, 'error');
      throw error;
    }
  }
  
  /**
   * Enrich item with Voyage AI
   * @param {Object} item - JAV item metadata
   * @returns {Promise<Object>} AI enrichment data
   */
  async enrich(item) {
    if (this.options.dryRun) {
      log(`DRY RUN: Would enrich with Voyage AI: ${item.code}`, 'debug');
      return this.generateMockAIEnrichment(item);
    }
    
    if (!this.options.apiKey) {
      throw new Error('Voyage AI API key not configured');
    }
    
    try {
      const enrichment = {
        aiEnriched: true,
        aiEnrichedAt: new Date().toISOString()
      };
      
      // 1. Generate embeddings for semantic search
      const embeddings = await this.generateEmbeddings(item);
      if (embeddings) {
        enrichment.embeddings = embeddings;
      }
      
      // 2. Classify genres/tags
      const classification = await this.classifyContent(item);
      if (classification) {
        Object.assign(enrichment, classification);
      }
      
      // 3. Extract key phrases
      const keyPhrases = await this.extractKeyPhrases(item);
      if (keyPhrases) {
        enrichment.keyPhrases = keyPhrases;
      }
      
      log(`Voyage AI enrichment completed for ${item.code}`, 'info');
      return enrichment;
      
    } catch (error) {
      log(`Voyage AI enrichment failed for ${item.code}: ${error.message}`, 'error');
      throw error;
    }
  }
  
  /**
   * Generate embeddings for semantic search
   */
  async generateEmbeddings(item) {
    const texts = [];
    
    // Use title for embedding
    if (item.cleanTitle || item.title) {
      texts.push(item.cleanTitle || item.title);
    }
    
    // Use actresses for embedding
    if (item.actresses && item.actresses.length > 0) {
      texts.push(`Actresses: ${item.actresses.join(', ')}`);
    }
    
    if (texts.length === 0) {
      return null;
    }
    
    try {
      const response = await this.callVoyageAPI('/embeddings', {
        model: 'voyage-2',
        input: texts,
        input_type: 'document'
      });
      
      return {
        model: response.model,
        embeddings: response.data.map(d => d.embedding),
        texts
      };
      
    } catch (error) {
      log(`Embedding generation failed: ${error.message}`, 'warn');
      return null;
    }
  }
  
  /**
   * Classify content (genres, tags, themes)
   */
  async classifyContent(item) {
    const prompt = this.buildClassificationPrompt(item);
    
    try {
      const response = await this.callVoyageAPI('/chat/completions', {
        model: 'voyage-2',
        messages: [
          {
            role: 'system',
            content: 'You are a JAV content classifier. Extract genres, tags, and themes from the provided metadata. Respond with a JSON object.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        response_format: { type: 'json_object' }
      });
      
      const content = response.choices[0].message.content;
      return JSON.parse(content);
      
    } catch (error) {
      log(`Content classification failed: ${error.message}`, 'warn');
      return null;
    }
  }
  
  /**
   * Extract key phrases
   */
  async extractKeyPhrases(item) {
    const text = [
      item.cleanTitle || item.title,
      item.actresses ? `Starring: ${item.actresses.join(', ')}` : ''
    ].filter(Boolean).join('. ');
    
    if (!text) return null;
    
    try {
      const response = await this.callVoyageAPI('/chat/completions', {
        model: 'voyage-2',
        messages: [
          {
            role: 'system',
            content: 'Extract key phrases from the text. Respond with a JSON array of phrases.'
          },
          {
            role: 'user',
            content: `Extract key phrases from: ${text}`
          }
        ],
        response_format: { type: 'json_object' }
      });
      
      const content = response.choices[0].message.content;
      const result = JSON.parse(content);
      return result.phrases || result.keyPhrases || [];
      
    } catch (error) {
      log(`Key phrase extraction failed: ${error.message}`, 'warn');
      return null;
    }
  }
  
  /**
   * Build classification prompt
   */
  buildClassificationPrompt(item) {
    const parts = [];
    
    if (item.cleanTitle || item.title) {
      parts.push(`Title: ${item.cleanTitle || item.title}`);
    }
    
    if (item.actresses && item.actresses.length > 0) {
      parts.push(`Actresses: ${item.actresses.join(', ')}`);
    }
    
    if (item.date) {
      parts.push(`Release Date: ${item.date}`);
    }
    
    if (item.studio) {
      parts.push(`Studio: ${item.studio}`);
    }
    
    const metadataText = parts.join('\\n');
    
    return `Analyze this JAV metadata and provide:

1. Primary genre (e.g., "vanilla", "bukkake", "creampie", "group", "lesbian", "blowjob", "anal", "cosplay", "school", "office")
2. Secondary genres (array, max 5)
3. Tags (array, max 10, specific themes like "glasses", "stockings", "milf", "teen", "pov", "kissing", "toys")
4. Intensity level (1-5, where 1=soft/vanilla, 5=hardcore)
5. Production quality (1-5, where 1=amateur, 5=professional)
6. Brief description (1-2 sentences)

Metadata:
${metadataText}

Respond with a JSON object containing these fields.`;
  }
  
  /**
   * Call Voyage AI API
   */
  async callVoyageAPI(endpoint, data) {
    if (this.options.dryRun) {
      return this.mockAPIResponse(endpoint, data);
    }
    
    const url = `${this.options.baseUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.options.apiKey}`
    };
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.options.timeout);
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(data),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Voyage API error (${response.status}): ${errorText}`);
      }
      
      return await response.json();
      
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error.name === 'AbortError') {
        throw new Error(`Voyage API timeout after ${this.options.timeout}ms`);
      }
      
      throw error;
    }
  }
  
  /**
   * Generate mock API response for dry run
   */
  mockAPIResponse(endpoint, data) {
    log(`DRY RUN: Mock Voyage API call to ${endpoint}`, 'debug');
    
    if (endpoint === '/embeddings') {
      return {
        model: 'voyage-2',
        data: data.input.map(text => ({
          embedding: Array(1024).fill(0).map(() => Math.random() - 0.5),
          index: 0
        }))
      };
    }
    
    if (endpoint === '/chat/completions') {
      const mockResponse = {
        genres: ['vanilla', 'blowjob'],
        tags: ['glasses', 'stockings', 'kissing'],
        intensity: 3,
        quality: 4,
        description: 'A standard production featuring the listed actresses.'
      };
      
      return {
        choices: [{
          message: {
            content: JSON.stringify(mockResponse)
          }
        }]
      };
    }
    
    return { mock: true, endpoint, data };
  }
  
  /**
   * Generate mock AI enrichment for dry run
   */
  generateMockAIEnrichment(item) {
    return {
      aiEnriched: true,
      aiEnrichedAt: new Date().toISOString(),
      genres: ['vanilla', 'blowjob'],
      tags: ['glasses', 'stockings', 'kissing'],
      intensity: 3,
      quality: 4,
      description: `Mock AI enrichment for ${item.code}: ${item.cleanTitle || item.title}`,
      embeddings: {
        model: 'voyage-2-mock',
        texts: [item.cleanTitle || item.title],
        dimensions: 1024
      },
      keyPhrases: [item.code, 'mock', 'enrichment'],
      dryRun: true
    };
  }
  
  /**
   * Close the enricher (cleanup)
   */
  async close() {
    // Nothing to close for HTTP client
    log('Voyage AI enricher closed', 'debug');
  }
  
  /**
   * Test the enricher
   */
  static async test() {
    const enricher = new VoyageAIEnricher({ dryRun: true, verbose: true });
    
    try {
      await enricher.initialize();
      
      const testItem = {
        code: 'TEST-001',
        title: 'TEST-001 Beautiful Actress in Glasses',
        cleanTitle: 'Beautiful Actress in Glasses',
        actresses: ['Test Actress'],
        date: '2024-01-01',
        studio: 'Test Studio'
      };
      
      const result = await enricher.enrich(testItem);
      console.log('Voyage AI Test Result:', JSON.stringify(result, null, 2));
      
      await enricher.close();
      return result;
      
    } catch (error) {
      await enricher.close();
      throw error;
    }
  }
}