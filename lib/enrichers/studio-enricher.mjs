import { log } from '../shared.mjs';

/**
 * StudioEnricher - Categorize JAV items by studio/maker
 * 
 * Uses:
 * - makers.json: Studio definitions with metadata
 * - maker_aliases.json: Alternative studio names
 */

export class StudioEnricher {
  constructor(options = {}) {
    this.options = {
      makers: {},
      makerAliases: {},
      dryRun: false,
      ...options
    };
    
    // Build lookup tables
    this.studioLookup = this.buildStudioLookup();
  }
  
  /**
   * Build lookup tables for quick studio matching
   */
  buildStudioLookup() {
    const lookup = {
      byCode: {},      // Match by code prefix
      byName: {},      // Match by studio name
      byAlias: {}      // Match by alias
    };
    
    const { makers, makerAliases } = this.options;
    
    // Process each maker
    for (const [makerId, makerData] of Object.entries(makers)) {
      if (!makerData || typeof makerData !== 'object') continue;
      
      // Add by maker ID
      lookup.byName[makerId.toLowerCase()] = makerData;
      
      // Add by code prefixes
      if (makerData.codePrefixes && Array.isArray(makerData.codePrefixes)) {
        for (const prefix of makerData.codePrefixes) {
          lookup.byCode[prefix.toLowerCase()] = makerData;
        }
      }
      
      // Add alternative names
      if (makerData.alternativeNames && Array.isArray(makerData.alternativeNames)) {
        for (const altName of makerData.alternativeNames) {
          lookup.byName[altName.toLowerCase()] = makerData;
        }
      }
    }
    
    // Process aliases
    for (const [alias, canonical] of Object.entries(makerAliases)) {
      if (makers[canonical]) {
        lookup.byAlias[alias.toLowerCase()] = makers[canonical];
      }
    }
    
    return lookup;
  }
  
  /**
   * Enrich item with studio information
   * @param {Object} item - JAV item metadata
   * @returns {Object} Studio enrichment data
   */
  enrich(item) {
    if (this.options.dryRun) {
      log(`DRY RUN: Would enrich studio info for ${item.code}`, 'debug');
      return this.generateMockStudioInfo(item);
    }
    
    const result = {
      studio: null,
      studioInfo: null,
      studioMatchedBy: null
    };
    
    // Try to match by code prefix first (most reliable)
    const codeMatch = this.matchByCode(item.code);
    if (codeMatch) {
      result.studio = codeMatch.canonicalName;
      result.studioInfo = codeMatch;
      result.studioMatchedBy = 'code-prefix';
      return result;
    }
    
    // Try to extract studio from title
    const titleMatch = this.matchByTitle(item.title || item.cleanTitle);
    if (titleMatch) {
      result.studio = titleMatch.canonicalName;
      result.studioInfo = titleMatch;
      result.studioMatchedBy = 'title';
      return result;
    }
    
    // No match found
    log(`No studio match found for ${item.code}`, 'debug');
    return result;
  }
  
  /**
   * Match studio by JAV code prefix
   */
  matchByCode(javCode) {
    if (!javCode) return null;
    
    // Extract prefix (usually 2-4 letters before dash)
    const prefixMatch = javCode.match(/^([A-Z]{2,4})-/);
    if (!prefixMatch) return null;
    
    const prefix = prefixMatch[1].toLowerCase();
    
    // Check direct prefix match
    if (this.studioLookup.byCode[prefix]) {
      return {
        ...this.studioLookup.byCode[prefix],
        canonicalName: this.getCanonicalName(this.studioLookup.byCode[prefix])
      };
    }
    
    return null;
  }
  
  /**
   * Match studio by title keywords
   */
  matchByTitle(title) {
    if (!title) return null;
    
    const titleLower = title.toLowerCase();
    
    // Check for studio names in title
    for (const [studioName, studioInfo] of Object.entries(this.studioLookup.byName)) {
      if (titleLower.includes(studioName.toLowerCase())) {
        return {
          ...studioInfo,
          canonicalName: this.getCanonicalName(studioInfo)
        };
      }
    }
    
    // Check aliases
    for (const [alias, studioInfo] of Object.entries(this.studioLookup.byAlias)) {
      if (titleLower.includes(alias.toLowerCase())) {
        return {
          ...studioInfo,
          canonicalName: this.getCanonicalName(studioInfo),
          matchedByAlias: alias
        };
      }
    }
    
    return null;
  }
  
  /**
   * Get canonical name from studio info
   */
  getCanonicalName(studioInfo) {
    if (!studioInfo || typeof studioInfo !== 'object') return null;
    
    // Use displayName if available, otherwise use the first property name
    return studioInfo.displayName || 
           studioInfo.name || 
           Object.keys(this.options.makers).find(
             key => this.options.makers[key] === studioInfo
           );
  }
  
  /**
   * Generate mock studio info for dry run
   */
  generateMockStudioInfo(item) {
    return {
      studio: 'Mock Studio',
      studioInfo: {
        displayName: 'Mock Studio',
        codePrefixes: [item.code.substring(0, 3)],
        description: 'Mock studio for testing',
        website: 'https://example.com'
      },
      studioMatchedBy: 'mock',
      dryRun: true
    };
  }
  
  /**
   * Test the enricher
   */
  static test() {
    const testMakers = {
      'S1': {
        displayName: 'S1 No. 1 Style',
        codePrefixes: ['SSIS', 'SSNI'],
        description: 'Premium studio',
        website: 'https://s1s1s1.com'
      },
      'IDEAPOCKET': {
        displayName: 'IdeaPocket',
        codePrefixes: ['IPX', 'IPTD'],
        alternativeNames: ['Idea Pocket', 'IP'],
        description: 'High quality productions'
      }
    };
    
    const testAliases = {
      's1': 'S1',
      'idea pocket': 'IDEAPOCKET'
    };
    
    const enricher = new StudioEnricher({
      makers: testMakers,
      makerAliases: testAliases,
      dryRun: true
    });
    
    const testCases = [
      { code: 'SSIS-001', expected: 'S1 No. 1 Style' },
      { code: 'IPX-777', expected: 'IdeaPocket' },
      { code: 'ABC-123', expected: null }
    ];
    
    console.log('Testing StudioEnricher:');
    for (const testCase of testCases) {
      const result = enricher.enrich({ code: testCase.code });
      const passed = result.studio === testCase.expected;
      console.log(`  ${testCase.code} -> ${result.studio} ${passed ? '✓' : '✗'}`);
    }
  }
}