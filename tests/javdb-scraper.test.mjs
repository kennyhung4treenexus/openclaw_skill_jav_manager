import test from 'node:test';
import assert from 'node:assert/strict';
import { JavDBScraper } from '../lib/scrapers/javdb-scraper.mjs';

test('isNotFoundPage detects real JavDB Rails 404 page', () => {
  const scraper = new JavDBScraper();
  const html = `
    <html>
      <head><title>頁面未找到 (404) - JavDB</title></head>
      <body class="rails-default-error-page">
        <h1>頁面未找到(404)</h1>
      </body>
    </html>
  `;

  assert.equal(scraper.isNotFoundPage(html), true);
});

test('isNotFoundPage does not treat valid movie text containing 找不到 as 404', () => {
  const scraper = new JavDBScraper();
  const html = `
    <html class="has-navbar-fixed-top">
      <head>
        <title>CAWD-902 【FANZA限定】どこかにいそうでどこにもいない。キセキ美少女 石井恋花 AV DEBUT | JavDB</title>
      </head>
      <body>
        <h2 class="title"><strong class="current-title">CAWD-902 Valid Title</strong></h2>
        <a href="magnet:?xt=urn:btih:test" title="Right click and select Copy Link">
          <span class="name">CAWD-902 好像在哪看過卻又哪都找不到的奇蹟美少女石井戀花AV出道</span>
        </a>
      </body>
    </html>
  `;

  assert.equal(scraper.isNotFoundPage(html), false);
});
