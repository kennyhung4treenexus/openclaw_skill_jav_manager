#!/usr/bin/env node
import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, '.env') });
import { log } from './lib/shared.mjs';
import { execSync } from 'child_process';

/**
 * JAV Manager - Main entry point for the 7-stage sync pipeline
 * 
 * Stages:
 * 1. 01-ingest    - Collect raw data
 * 2. 02-enrich    - Enhance metadata  
 * 3. 03-verify    - Validate integrity
 * 4. 04-rankings  - Apply curation logic
 * 5. 05-archive   - Move to long-term storage
 * 6. 06-notify    - Smart Telegram notification (new videos + triple crowns)
 * 7. 07-delete    - Safely purge resources
 */

function showHelp() {
  console.log(`
JAV Manager - 7-stage sync pipeline

Usage:
  node index.mjs <command> [options]

Commands:
  ingest     - Run stage 1: Collect raw data from JavDB
  enrich     - Run stage 2: Enhance metadata with additional sources
  verify     - Run stage 3: Verify missav.ai URLs (verify-url)
  rankings   - Run stage 4: Apply curation and ranking logic
  archive    - Run stage 5: Move to long-term storage
  notify     - Run stage 6: Smart Telegram notification (new videos + triple crowns)
  delete     - Run stage 7: Safely purge old resources
  all        - Run all stages in sequence
  help       - Show this help message

Options:
  --dry-run  - Simulate operations without making changes
  --verbose  - Show detailed logging
  --stage=<n> - Run specific stage only

Examples:
  node index.mjs ingest --dry-run
  node index.mjs all --verbose
  node index.mjs --stage=3

Control Files:
  The skill maintains JSON control files in the skill root:
  - aliases.json       - Actress name aliases
  - favorites.json     - Favorite items
  - graveyard.json     - Items to exclude
  - maker_aliases.json - Studio/studio aliases  
  - makers.json        - Studio definitions
  `);
}

async function runStage(stageNumber, options = {}) {
  const stages = {
    1: '01-ingest',
    2: '02-enrich', 
    3: '03-verify-url',
    4: '04-rankings',
    5: '05-archive',
    6: '06-notify',
    7: '07-delete'
  };
  
  const stageName = stages[stageNumber];
  if (!stageName) {
    throw new Error(`Invalid stage number: ${stageNumber}`);
  }
  
  log(`Starting stage ${stageNumber}: ${stageName}`, 'info');
  
  // Try to load the stage module
  try {
    const modulePath = `./stages/${stageName}.mjs`;
    const stageModule = await import(modulePath);
    
    if (typeof stageModule.run !== 'function') {
      throw new Error(`Stage ${stageName} does not export a 'run' function`);
    }
    
    const result = await stageModule.run(options);
    log(`Completed stage ${stageNumber}: ${stageName}`, 'info');
    return result;
    
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') {
      log(`Stage ${stageName} not implemented yet`, 'warn');
      return { skipped: true, reason: 'Not implemented' };
    }
    log(`Error in stage ${stageName}: ${error.message}`, 'error');
    throw error;
  }
}

async function cleanupFlareSolverr() {
  const scriptPath = resolve(__dirname, 'post-pipeline.sh');
  log('Post-pipeline: recreating FlareSolverr containers to clear Chrome cache...', 'info');
  try {
    execSync(`bash "${scriptPath}"`, { stdio: 'inherit' });
    log('Post-pipeline: FlareSolverr containers recreated successfully', 'info');
  } catch (err) {
    log(`Post-pipeline: FlareSolverr cleanup failed (non-fatal): ${err.message}`, 'warn');
  }
}

async function runAllStages(options = {}) {
  const results = [];
  
  try {
    for (let stageNum = 1; stageNum <= 7; stageNum++) {
      try {
        const result = await runStage(stageNum, options);
        results.push({ stage: stageNum, result });
      } catch (error) {
        log(`Pipeline failed at stage ${stageNum}`, 'error');
        throw error;
      }
    }
    return results;
  } finally {
    await cleanupFlareSolverr();
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('help') || args.includes('--help')) {
    showHelp();
    process.exit(0);
  }
  
  const limitArg = args.find(arg => arg.startsWith('--limit='));
  const workersArg = args.find(arg => arg.startsWith('--workers='));
  const maxPagesArg = args.find(arg => arg.startsWith('--max-pages-per-maker='));
  const visibleOnlyArg = args.find(arg => arg.startsWith('--visible-only'));
  const retryOnlyArg = args.find(arg => arg.startsWith('--retry-only'));
  const concurrencyArg = args.find(arg => arg.startsWith('--concurrency='));
  const maxRetryArg = args.find(arg => arg.startsWith('--max-retry-items='));
  const options = {
    dryRun: args.includes('--dry-run'),
    verbose: args.includes('--verbose'),
    limit: limitArg ? parseInt(limitArg.split('=')[1]) : 0,
    workers: workersArg ? parseInt(workersArg.split('=')[1]) : undefined,
    maxPagesPerMaker: maxPagesArg ? parseInt(maxPagesArg.split('=')[1]) : undefined,
    visibleOnly: !!visibleOnlyArg,
    retryOnly: !!retryOnlyArg,
    concurrency: concurrencyArg ? parseInt(concurrencyArg.split('=')[1]) : undefined,
    maxRetryItems: maxRetryArg ? parseInt(maxRetryArg.split('=')[1]) : undefined,
  };
  
  // Check for stage-specific option
  const stageArg = args.find(arg => arg.startsWith('--stage='));
  if (stageArg) {
    const stageNum = parseInt(stageArg.split('=')[1]);
    if (isNaN(stageNum) || stageNum < 1 || stageNum > 7) {
      console.error('Error: --stage must be a number between 1 and 7');
      process.exit(1);
    }
    await runStage(stageNum, options);
    return;
  }
  
  // Handle command-based execution
  const command = args[0];
  switch (command) {
    case 'ingest':
      await runStage(1, options);
      break;
    case 'enrich':
      await runStage(2, options);
      break;
    case 'verify':
      await runStage(3, options);
      break;
    case 'rankings':
      await runStage(4, options);
      break;
    case 'archive':
      await runStage(5, options);
      break;
    case 'notify':
      await runStage(6, options);
      break;
    case 'delete':
      await runStage(7, options);
      break;
    case 'all':
      await runAllStages(options);
      break;
    default:
      console.error(`Error: Unknown command '${command}'`);
      showHelp();
      process.exit(1);
  }
}

// Run main if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
