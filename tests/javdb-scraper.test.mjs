import test from 'node:test';
import assert from 'node:assert/strict';
import { JavDBScraper } from '../lib/scrapers/javdb-scraper.mjs';

// ── Helpers ─────────────────────────────────────────────

function panelPage(actorHtml) {
  return `
    <html>
      <head><title>SNOS-444 Sample | JavDB</title></head>
      <body>
        <div class="movie-panel-info">
          <div class="panel-block"><strong>ID:</strong>&nbsp;<span class="value">SNOS-444</span></div>
          <div class="panel-block">
            <strong>演員:</strong>
            &nbsp;<span class="value">
                ${actorHtml}
            </span>
          </div>
        </div>
      </body>
    </html>
  `;
}

function extractActresses(html) {
  const scraper = new JavDBScraper();
  return scraper.extractMetadataFromHtml(html).actresses;
}

// ── Current JavDB markup (class-based gender) ───────────

test('extracts only the actress from current actor-female markup (SNOS-444 live shape)', () => {
  const html = panelPage(`
    <a class="actor-female" href="/actors/eKbAx">星空ねる</a>, <a href="/actors/9gAX">鮫島</a>, <a href="/actors/K4m3Q">貞松大輔</a>, <a href="/actors/xvDYV">武田大樹</a>, <a href="/actors/XWB11">TECH</a>
  `);

  assert.deepEqual(extractActresses(html), ['星空ねる']);
});

test('extracts multiple actor-female performers and skips unmarked actors', () => {
  const html = panelPage(`
    <a class="actor-female" href="/actors/A1">女優A</a>, <a href="/actors/M1">男優B</a>, <a class="actor-female" href="/actors/A2">女優C</a>, <a href="/actors/M2">男優D</a>
  `);

  assert.deepEqual(extractActresses(html), ['女優A', '女優C']);
});

test('deduplicates repeated actor-female names', () => {
  const html = panelPage(`
    <a class="actor-female" href="/actors/A1">女優A</a>, <a class="actor-female" href="/actors/A1">女優A</a>, <a href="/actors/M1">男優B</a>
  `);

  assert.deepEqual(extractActresses(html), ['女優A']);
});

// ── Legacy markup (♀ / ♂ symbols) ───────────────────────

test('still supports legacy ♀ symbol markup and excludes ♂ actors', () => {
  const html = panelPage(`
    <a href="/actors/A1">女優A</a><strong class="symbol female">♀</strong>, <a href="/actors/M1">男優B</a><strong class="symbol male">♂</strong>
  `);

  assert.deepEqual(extractActresses(html), ['女優A']);
});

// ── Fail-closed fallback (regression) ───────────────────

test('returns empty when only unmarked (male) actors exist — old fallback must not leak them', () => {
  const html = panelPage(`
    <a href="/actors/9gAX">鮫島</a>, <a href="/actors/K4m3Q">貞松大輔</a>, <a href="/actors/XWB11">TECH</a>
  `);

  assert.deepEqual(extractActresses(html), []);
});

test('returns empty when actor panel is absent', () => {
  const html = `
    <html>
      <head><title>TEST-001 | JavDB</title></head>
      <body><h2 class="title"><strong class="current-title">TEST-001 No Actors</strong></h2></body>
    </html>
  `;

  assert.deepEqual(extractActresses(html), []);
});

// ── Existing 404 tests ──────────────────────────────────

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
