/**
 * Notion code index — fetch all existing codes from Notion database.
 * Extracted from Stage 01 for reuse.
 */

import { log } from '../shared.mjs';

/**
 * Fetch all existing codes from a Notion database.
 * Returns a Set of code strings.
 *
 * @param {object} notionClient - An initialized @notionhq/client instance
 * @returns {Promise<Set<string>>}
 */
export async function fetchExistingCodes(notionClient) {
  const existingCodes = new Set();

  if (!notionClient) {
    log('[notion-code-index] No notion client provided, returning empty set', 'warn');
    return existingCodes;
  }

  try {
    let startCursor = null;
    let hasMore = true;
    let page = 0;

    while (hasMore) {
      page++;
      const queryPayload = {
        database_id: process.env.NOTION_DATABASE_ID,
        page_size: 100,
      };
      if (startCursor) queryPayload.start_cursor = startCursor;

      const response = await notionClient.databases.query(queryPayload);

      for (const item of response.results) {
        try {
          const props = item.properties || {};
          const codeProp = props.Code || props.code;
          if (codeProp?.rich_text?.[0]?.text?.content) {
            existingCodes.add(codeProp.rich_text[0].text.content);
          } else {
            const nameProp = props.Name || props.name;
            if (nameProp?.title?.[0]?.text?.content) {
              existingCodes.add(nameProp.title[0].text.content);
            }
          }
        } catch {
          continue;
        }
      }

      hasMore = response.has_more;
      startCursor = response.next_cursor;
    }

    log(
      `[notion-code-index] Fetched ${existingCodes.size} unique codes from Notion across ${page} pages`,
      'info'
    );
  } catch (error) {
    log(`[notion-code-index] Failed to fetch codes from Notion: ${error.message}`, 'error');
  }

  return existingCodes;
}
