import axios from 'axios';
import { log } from '../shared.mjs';

export class NotionClient {
  constructor(options = {}) {
    this.options = {
      dryRun: false,
      verbose: false,
      ...options
    };
    
    this.client = null;
    this.initialized = false;
  }
  
  async initialize() {
    if (this.options.dryRun) {
      log('DRY RUN: Notion client would be initialized', 'info');
      this.initialized = true;
      return;
    }
    
    if (!process.env.NOTION_TOKEN) {
      throw new Error('NOTION_TOKEN environment variable is required');
    }
    
    if (!process.env.NOTION_DATABASE_ID) {
      throw new Error('NOTION_DATABASE_ID environment variable is required');
    }
    
    try {
      // Dynamic import to avoid requiring @notionhq/client if not used
      const { Client } = await import('@notionhq/client');
      
      this.client = new Client({
        auth: process.env.NOTION_TOKEN
      });
      
      // Test the connection by getting database info
      const dbInfo = await this.client.databases.retrieve({
        database_id: process.env.NOTION_DATABASE_ID
      });
      log(`Notion Database Properties: ${JSON.stringify(Object.keys(dbInfo.properties))}`, 'info');
      
      this.initialized = true;
      log('Notion client initialized and connected', 'info');
      
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND') {
        throw new Error('@notionhq/client package not installed. Run: npm install @notionhq/client');
      }
      throw new Error(`Failed to initialize Notion client: ${error.message}`);
    }
  }
  
  async syncToNotion(item) {
    if (this.options.dryRun) {
      log(`DRY RUN: Would sync ${item.code} to Notion`, 'debug');
      return {
        success: true,
        pageId: 'mock-page-id',
        action: 'created',
        dryRun: true
      };
    }
    
    if (!this.initialized || !this.client) {
      throw new Error('Notion client not initialized');
    }
    
    try {
      // Check if item already exists
      const existingPage = await this.findExistingPage(item.code);
      
      if (existingPage) {
        // Update existing page
        const updatedPage = await this.updatePage(existingPage.id, item);
        return {
          success: true,
          pageId: updatedPage.id,
          action: 'updated',
          existing: true
        };
      } else {
        // Create new page
        const newPage = await this.createPage(item);
        return {
          success: true,
          pageId: newPage.id,
          action: 'created',
          existing: false
        };
      }
      
    } catch (error) {
      log(`Failed to sync ${item.code} to Notion: ${error.message}`, 'error');
      return {
        success: false,
        error: error.message,
        action: 'failed'
      };
    }
  }
  
  async findExistingPage(code) {
    try {
      const response = await this.client.databases.query({
        database_id: process.env.NOTION_DATABASE_ID,
        filter: {
          property: 'Code',
          title: {
            equals: code
          }
        }
      });
      
      return response.results[0] || null;
      
    } catch (error) {
      log(`Error searching for existing page ${code}: ${error.message}`, 'warn');
      return null;
    }
  }
  
  async createPage(item) {
    const properties = this.mapItemToProperties(item);
    
    const pageData = {
      parent: {
        database_id: process.env.NOTION_DATABASE_ID
      },
      properties: properties
    };
    
    // Add cover if available and valid
    if (item.coverUrl) {
      try {
        // Verify the cover URL is accessible
        await this.verifyCoverImage(item);
        pageData.cover = {
          type: 'external',
          external: {
            url: item.coverUrl
          }
        };
      } catch (error) {
        log(`Skipping cover for ${item.code}: ${error.message}`, 'warn');
        // Continue without cover
      }
    }
    
    return await this.client.pages.create(pageData);
  }
  
  async updatePage(pageId, item) {
    const properties = this.mapItemToProperties(item);
    
    const pageData = {
      page_id: pageId,
      properties: properties
    };
    
    // Update cover if available and valid
    if (item.coverUrl) {
      try {
        // Verify the cover URL is accessible
        await this.verifyCoverImage(item);
        pageData.cover = {
          type: 'external',
          external: {
            url: item.coverUrl
          }
        };
      } catch (error) {
        log(`Skipping cover update for ${item.code}: ${error.message}`, 'warn');
        // Continue without updating cover
      }
    }
    
    return await this.client.pages.update(pageData);
  }
  
  mapItemToProperties(item) {
    const properties = {
      'Name': { title: [ { text: { content: item.cleanTitle || item.title || item.code || '' } } ] },
      'Code': { rich_text: [ { text: { content: item.code || '' } } ] },
      'Actress': { rich_text: [ { text: { content: (item.actresses || []).join(', ') } } ] },
      'Date': { date: item.date ? { start: item.date } : null },
      'Favorite': { checkbox: !!item.isFavorite },
      'Maker': { rich_text: [ { text: { content: item.studio || '' } } ] },
      'URL': { url: item.url || null },
      'URL no code': { url: item.urlNoCode || null },
      'URL Chinese': { url: item.urlChinese || null }
    };
    
    // Star fields
    if (item.dailyStar !== undefined) properties['Daily Star'] = { checkbox: !!item.dailyStar };
    if (item.weeklyStar !== undefined) properties['Weekly Star'] = { checkbox: !!item.weeklyStar };
    if (item.monthlyStar !== undefined) properties['Monthly Star'] = { checkbox: !!item.monthlyStar };

    return properties;
  }
  
  async verifyCoverImage(item) {
    if (!item.coverUrl) {
      throw new Error('No cover URL provided');
    }
    
    try {
      // Verify the URL is accessible
      const response = await axios.head(item.coverUrl, {
        timeout: 5000,
        validateStatus: status => status < 400
      });
      
      const contentType = response.headers['content-type'] || '';
      const isImage = contentType.startsWith('image/');
      
      if (!isImage) {
        throw new Error(`URL is not an image: ${contentType}`);
      }
      
      log(`Cover image verified for ${item.code}: ${contentType}`, 'debug');
      
      // Check if URL is already Notion-hosted
      const isNotionHosted = item.coverUrl.includes('notion.so') || 
                            item.coverUrl.includes('notion-static.com');
      
      if (!isNotionHosted) {
        log(`Using external cover URL for ${item.code}. For production, implement proper upload to Notion-compatible storage.`, 'warn');
      }
      
      return item.coverUrl;
      
    } catch (error) {
      log(`Failed to verify cover image for ${item.code}: ${error.message}`, 'warn');
      throw new Error(`Cover URL verification failed: ${error.message}`);
    }
  }
  
  async close() {
    // Nothing to close for HTTP client
    log('Notion client closed', 'debug');
    this.client = null;
    this.initialized = false;
  }
  
  // Test function
  static async test() {
    const client = new NotionClient({ dryRun: true });
    await client.initialize();
    
    const testItem = {
      code: 'TEST-001',
      title: 'Test Title',
      cleanTitle: 'Test Title',
      actresses: ['Test Actress'],
      date: '2024-01-01',
      coverUrl: 'https://example.com/cover.jpg',
      source: 'javdb',
      studio: 'Test Studio',
      genres: ['test'],
      tags: ['test'],
      intensity: 3,
      quality: 4,
      description: 'Test description'
    };
    
    const result = await client.syncToNotion(testItem);
    console.log('Notion client test result:', result);
    
    await client.close();
    return result;
  }
}