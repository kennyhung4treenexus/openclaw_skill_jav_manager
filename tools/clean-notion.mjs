/**
 * Clean all Notion records from JAV database.
 * Usage: node tools/clean-notion.mjs
 */
import 'dotenv/config';
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
if (!DATABASE_ID) { console.error('NOTION_DATABASE_ID required'); process.exit(1); }

let total = 0, archived = 0, errors = 0;
let cursor = undefined;

do {
  const { results, next_cursor, has_more } = await notion.databases.query({
    database_id: DATABASE_ID,
    page_size: 100,
    start_cursor: cursor,
  });
  cursor = next_cursor;
  total += results.length;

  for (const page of results) {
    try {
      await notion.pages.update({ page_id: page.id, archived: true });
      archived++;
      await new Promise(r => setTimeout(r, 350)); // rate limit
    } catch (e) {
      errors++;
      console.error(`Error archiving ${page.id}: ${e.message}`);
    }
  }
  console.log(`Progress: ${archived}/${total} archived, ${errors} errors`);
} while (cursor);

console.log(`\nDone: ${archived} pages archived, ${errors} errors`);
