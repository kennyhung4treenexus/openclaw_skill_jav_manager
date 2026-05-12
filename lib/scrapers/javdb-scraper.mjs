import { log, getSkillPath, writeJsonAtomic, sleep } from '../shared.mjs';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// Dynamic imports for CJS packages in ESM context
const { load: cheerioLoad } = await import('cheerio');

const SESSION_DIR = join(getSkillPath('session'));
const COOKIES_FILE = join(SESSION_DIR, 'cookies.json');

/**
 * JavDB Scraper — pure scraping adapter.
 *
 * Transport (FlareSolverr) is injected via constructor.
 * Orchestration (delay, retry, queue) lives in the caller.
 */
export class JavDBScraper {
  constructor(options = {}) {
    this.options = {
      aliases: {},
      graveyard: {},
      makerAliases: {},
      dryRun: false,
      verbose: false,
      enableBrowserSession: false,
      timeout: 60000,
      ...options
    };

    this.flaresolverr = options.flaresolverr || null;
    this.workerPort = options.workerPort || null;
    this.workerSession = options.workerSession || null;
    this.browser = null;
    this.page = null;
    this.sessionActive = false;
  }

  // ── FlareSolverr (injected) ───────────────────────────

  /**
   * Fetch a URL via injected FlareSolverr pool.
   * @param {string} url
   * @param {number} maxTimeout
   * @returns {Promise<{html: string, cookies: Array}>}
   */
  async _fetchUrl(url, options = {}) {
    const { maxTimeout = 60000, forceFreshSession = false } = options;
    if (!this.flaresolverr) {
      throw new Error('No FlareSolverr pool injected — pass flaresolverr option to constructor');
    }
    // Bypass JavDB age-verification modal
    const javdbCookies = [{ name: 'over18', value: '1', domain: '.javdb.com' }];
    const result = await this.flaresolverr.requestGet(url, {
      maxTimeout,
      forceFreshSession,
      cookies: javdbCookies,
      preferredPort: this.workerPort,
      session: this.workerSession || undefined,
    });
    return result; // { html, cookies, port }
  }

  // ── Browser Session (optional, for 18+ modal) ─────────

  _ensureSessionDir() {
    if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
  }

  _saveCookies(cookies) {
    try {
      this._ensureSessionDir();
      writeJsonAtomic(COOKIES_FILE, cookies);
      log(`Saved ${cookies.length} cookies to ${COOKIES_FILE}`, 'info');
    } catch (error) {
      log(`Failed to save cookies: ${error.message}`, 'warn');
    }
  }

  async initBrowserSession() {
    if (this.options.dryRun) {
      log('DRY RUN: Browser session would be initialized', 'info');
      this.sessionActive = true;
      return;
    }

    try {
      log('Initializing JavDB browser session with puppeteer-real-browser (turnstile mode)...', 'info');

      const viewportWidth  = 1280 + Math.floor(Math.random() * 500);
      const viewportHeight = 720  + Math.floor(Math.random() * 400);

      const prbMod = await import('puppeteer-real-browser');
      const connect = prbMod.default?.connect || prbMod.connect || (prbMod.default ?? prbMod);

      const conn = await connect({
        headless: false,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-setuid-sandbox',
          '--no-zygote',
          '--disable-blink-features=AutomationControlled',
          '--exclude-switches=enable-automation',
          '--disable-infobars',
          '--disable-browser-side-navigation',
          '--disable-features=IsolateOrigins,site-per-process',
        ],
        disableXvfb: false,
        turnstile: true,
        customConfig: {
          executablePath: process.env.CHROME_PATH || '/usr/bin/chromium-browser',
          protocolTimeout: 180000
        }
      });

      this.browser = conn.browser;
      this.page = conn.page;

      await this.page.setViewport({ width: viewportWidth, height: viewportHeight });
      await this.page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });
      await this.page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      await this.page.goto('https://javdb.com/', { waitUntil: 'domcontentloaded', timeout: this.options.timeout });

      try {
        const ageModal = await this.page.$('.over18-modal');
        if (ageModal) {
          log('18+ age modal detected — clicking "是" to proceed', 'info');
          const clicked = await this.page.evaluate(() => {
            const btn = document.querySelector('.over18-modal a.button.is-success');
            if (btn) { btn.click(); return true; }
            return false;
          });
          if (clicked) {
            await new Promise(r => setTimeout(r, 2000));
            log('Age verification accepted', 'info');
          }
        }
      } catch (e) {
        log(`Age modal handling error: ${e.message}`, 'warn');
      }

      try {
        await this.page.waitForSelector('.video-title, h2.title, nav, .navbar', { timeout: 20000 });
        const cookies = await this.page.cookies();
        if (cookies.length > 0) this._saveCookies(cookies);
      } catch { /* CF challenge on init — non-fatal */ }

      this.sessionActive = true;
      log('Browser session initialized successfully', 'info');

    } catch (error) {
      log(`Failed to initialize browser session: ${error.message}`, 'error');
      await this.close();
      throw error;
    }
  }

  /**
   * Initialize scraper. Optionally starts browser session.
   */
  async initialize() {
    if (this.options.enableBrowserSession) {
      return this.initBrowserSession();
    }
    this.sessionActive = true;
    log('Scraper initialized (FlareSolverr mode, no browser session)', 'info');
  }

  // ── Scraping ─────────────────────────────────────────────────

  /**
   * List items from a maker's page.
   */
  async listMakerItems(makerUrl, page = 1) {
    if (this.options.dryRun) {
      const makerMatch = makerUrl.match(/\/makers\/([^?]+)/);
      const makerKey = (makerMatch?.[1] || 'DRV').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      const prefix = (makerKey.slice(0, 3) || 'DRV').padEnd(3, 'X');
      return [
        { code: `${prefix}-${page}01`, url: `https://javdb.com/v/${prefix}-${page}01` },
        { code: `${prefix}-${page}02`, url: `https://javdb.com/v/${prefix}-${page}02` }
      ];
    }

    const sep = makerUrl.includes('?') ? '&' : '?';
    const url = page === 1 ? makerUrl : `${makerUrl}${sep}page=${page}`;
    const MAX_RETRIES = 3;
    const BACKOFF_MS = [10000, 60000, 180000]; // 10s, 60s, 180s — global pause handles CF

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Keep same session on retry — fresh session destroys CF trust
      // (same pattern as scrapeItem retry fix)
      try {
        const retryLabel = attempt > 0 ? ` (retry ${attempt}/${MAX_RETRIES})` : '';
        log(`Fetching maker page: ${url}${retryLabel}`, 'debug');

        const { html, port } = await this._fetchUrl(url, { maxTimeout: attempt > 0 ? 120000 : 60000 });

        // JavDB rate limit detection
        if (html.toLowerCase().includes('please take a rest')) {
          if (attempt < MAX_RETRIES) {
            const rateBackoff = 30000 + (attempt * 15000);
            log(`Rate limited on listing page ${page}, backing off ${rateBackoff / 1000}s…`, 'warn');
            await sleep(rateBackoff);
            continue;
          }
          log(`Listing page ${page} rate limited after ${MAX_RETRIES + 1} attempts`, 'error');
          return [];
        }

        const $ = cheerioLoad(html);

        const items = [];
        $('a[href*="/v/"]').each((_, link) => {
          const href = $(link).attr('href') || '';
          const titleEl = $(link).find('.video-title strong');
          const code = titleEl.text().trim();
          if (code && !items.find(r => r.code === code)) {
            items.push({
              code,
              url: href.startsWith('http') ? href : `https://javdb.com${href}`
            });
          }
        });

        if (items.length > 0) {
          const recovered = attempt > 0 ? ` (recovered on retry ${attempt})` : '';
          log(`Found ${items.length} items on page ${page}${recovered}`, 'debug');
          return items;
        }

        // Empty items → likely blank page / rate-limited → report to pool
        if (port && this.flaresolverr?.reportContentFailure) {
          this.flaresolverr.reportContentFailure(port);
        }
        if (attempt < MAX_RETRIES) {
          const backoff = BACKOFF_MS[attempt];
          log(
            `Page ${page} returned 0 items (blank page / rate limited) port=${port}, retrying in ${backoff / 1000}s…`,
            'warn'
          );
          await sleep(backoff);
        }

      } catch (error) {
        if (attempt < MAX_RETRIES) {
          const backoff = BACKOFF_MS[attempt];
          log(
            `Page ${page} fetch failed: ${error.message}, retrying in ${backoff / 1000}s…`,
            'warn'
          );
          await sleep(backoff);
        } else {
          log(
            `Failed to list maker items after ${MAX_RETRIES + 1} attempts: ${error.message}`,
            'error'
          );
          return [];
        }
      }
    }

    // All attempts returned 0 items
    log(`Page ${page} returned 0 items after ${MAX_RETRIES + 1} attempts`, 'error');
    return [];
  }

  /**
   * Scrape a single JAV item with retry-on-blank-page logic.
   *
   * When the detail page returns blank/empty HTML (stale FlareSolverr session),
   * retry up to MAX_RETRIES times with backoff and longer timeout per attempt.
   */
  async scrapeItem(item) {
    const MAX_RETRIES = 3;

    if (this.options.dryRun) {
      log(`DRY RUN: Would scrape ${item.code || item.url}`, 'info');
      return this.generateMockMetadata(item);
    }

    const { code, url } = item;

    if (this.options.graveyard[code]) {
      log(`Skipping graveyard item: ${code}`, 'warn');
      return null;
    }

    const targetUrl = url || `https://javdb.com/v/${code}`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const label = attempt === 0 ? 'info' : 'warn';

      try {
        // Short backoff — global CF pause handles long waits at pool level
        if (attempt > 0) {
          const backoffMs = [0, 10000, 60000, 180000][attempt] || 60000; // 10s, 60s, 180s
          log(`Retry ${attempt}/${MAX_RETRIES} for ${code} (backoff ${backoffMs / 1000}s)...`, 'warn');
          await new Promise(r => setTimeout(r, backoffMs));
        } else {
          log(`Fetching: ${targetUrl}`, 'info');
        }

        // Longer timeout on retries for Cloudflare challenge solving
        const reqTimeout = attempt > 0 ? 120000 : 60000;
        const { html, port } = await this._fetchUrl(targetUrl, {
          maxTimeout: reqTimeout,
        });

        // Check for real JavDB 404 pages only.
        // Do not scan the whole document for generic words like 「找不到」:
        // valid movie titles / magnet names can contain those words (e.g. CAWD-902).
        const htmlLower = html.toLowerCase();
        if (this.isNotFoundPage(html)) {
          log(`Item not found: ${code}`, 'warn');
          return null;
        }

        // JavDB rate limit: "Please take a rest" → longer backoff
        if (htmlLower.includes('please take a rest')) {
          if (attempt < MAX_RETRIES) {
            const rateBackoff = 30000 + (attempt * 15000); // 30s, 45s, 60s
            log(
              `Rate limited by JavDB for ${code}, backing off ${rateBackoff / 1000}s…`,
              'warn'
            );
            await new Promise(r => setTimeout(r, rateBackoff));
            continue;
          }
          log(`All ${MAX_RETRIES + 1} attempts failed for ${code} (rate limited)`, 'error');
          return null;
        }

        // Quick health check: did we get real content?
        const pageTitle = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
        if (!pageTitle || pageTitle.includes('Just a moment') || pageTitle.includes('Security')) {
          if (attempt < MAX_RETRIES) {
            log(
              `Blank/CF page for ${code} (title: "${pageTitle}" port=${port}), retrying...`,
              'warn'
            );
            continue;
          }
          log(`All ${MAX_RETRIES + 1} attempts failed for ${code} (blank page)`, 'error');
          return null;
        }

        // Extract metadata from HTML
        const metadata = this.extractMetadataFromHtml(html);

        // If title extraction failed, retry with fresh session
        if (metadata._titleMissing) {
          if (attempt < MAX_RETRIES) {
            log(
              `Title extraction failed for ${code} (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying...`,
              'warn'
            );
            continue;
          }
          log(`All ${MAX_RETRIES + 1} attempts failed to extract title for ${code}`, 'error');
          return null;
        }

        // Success — build final metadata
        if (metadata.actresses && this.options.aliases) {
          metadata.actresses = metadata.actresses.map(a => this.options.aliases[a] || a);
        }

        metadata.cleanTitle = this.cleanTitle(metadata.title, metadata.actresses);
        metadata.source = 'javdb';
        metadata.scrapedAt = new Date().toISOString();
        if (!metadata.code) metadata.code = code || this.extractCodeFromUrl(targetUrl);

        const retryNote = attempt > 0 ? ` (retry ${attempt})` : '';
        log(`Extracted metadata for ${metadata.code}: ${metadata.cleanTitle}${retryNote}`, 'info');
        return metadata;

      } catch (error) {
        if (attempt < MAX_RETRIES) {
          log(
            `Fetch error for ${code} (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${error.message}, retrying...`,
            'warn'
          );
          continue;
        }
        throw error;
      }
    }

    return null; // unreachable
  }

  // ── HTML Parsing ─────────────────────────────────────────────

  isNotFoundPage(html) {
    const $ = cheerioLoad(html);
    const title = $('title').first().text().trim().toLowerCase();
    const heading = $('h1').first().text().trim().toLowerCase();
    const bodyClass = $('body').attr('class') || '';

    if (bodyClass.split(/\s+/).includes('rails-default-error-page')) return true;

    const has404 = title.includes('404') || heading.includes('404');
    const looksLikeNotFound = /page\s+not\s+found|not\s+found|頁面未找到/.test(title)
      || /page\s+not\s+found|not\s+found|頁面未找到/.test(heading);

    return has404 && looksLikeNotFound;
  }

  extractMetadataFromHtml(html) {
    const $ = cheerioLoad(html);
    const result = {};

    // Extract title
    const titleSelectors = [
      'h2.title strong.current-title',
      'h2.title .current-title',
      '.current-title',
      'h2.title',
      '.video-title',
      '.movie-panel-info h2',
      'h1.title',
    ];

    for (const sel of titleSelectors) {
      const el = $(sel).first();
      if (el.length) { result.title = el.text().trim(); break; }
    }

    if (!result.title) {
      log(`Title not found. Page title: "${$('title').text().trim()}"`, 'warn');
    }

    // Extract actresses (♀ marker)
    result.actresses = $('a[href*="/actors/"]').filter((_, el) => {
      return $(el).next('strong.symbol.female').text().includes('♀');
    }).map((_, el) => $(el).text().trim()).get().filter(n => n.length > 0);

    if (result.actresses.length === 0) {
      result.actresses = $('.value a[href*="/actors/"]').map((_, el) => $(el).text().trim()).get().filter(n => n.length > 0);
    }

    // Extract metadata from panel blocks
    const metadataItems = $('.movie-panel-info .panel-block');
    log(`Found ${metadataItems.length} metadata panel-blocks`, 'debug');

    metadataItems.each((_, el) => {
      const $el = $(el);
      const label = $el.find('> strong').text().trim().toLowerCase();
      const valueEl = $el.find('> .value');
      const value = valueEl.text().trim();

      if (label.includes('日期') || label.includes('released date')) {
        const m = value.match(/(\d{4}-\d{2}-\d{2})/);
        if (m) { result.date = m[1]; log(`Extracted date: ${result.date}`, 'debug'); }
      }

      if (label.includes('片商') || label.includes('maker')) {
        const link = valueEl.find('a[href*="/makers/"]');
        result.maker = this.resolveMakerAlias(link.length ? link.text().trim() : value);
        log(`Extracted maker: ${result.maker}`, 'info');
      }

      if (label.includes('導演') || label.includes('director')) {
        const link = valueEl.find('a[href*="/directors/"]');
        result.director = link.length ? link.text().trim() : value;
        if (result.director) log(`Extracted director: ${result.director}`, 'debug');
      }
    });

    // Extract cover image
    const fancyboxLink = $('a[data-fancybox="gallery"]').first();
    if (fancyboxLink.length) {
      const href = fancyboxLink.attr('href');
      if (href) {
        result.coverUrl = href.startsWith('//') ? `https:${href}` : href;
        log(`Extracted cover URL: ${result.coverUrl.substring(0, 60)}...`, 'debug');
      }
    }

    if (!result.coverUrl) {
      for (const sel of ['.video-cover img', '.cover img', 'img[src*="/cover"]']) {
        const img = $(sel).first();
        const src = img.attr('src') || img.attr('data-src');
        if (src) {
          result.coverUrl = src.startsWith('//') ? `https:${src}` : src;
          log(`Extracted cover URL (${sel}): ${result.coverUrl.substring(0, 60)}...`, 'debug');
          break;
        }
      }
    }

    // Extract code from page header
    const codeRegex = /^[A-Za-z]+-[0-9]+/;
    const headerCode = $('h2.title strong').first().text().trim().match(codeRegex);
    if (headerCode) result.code = headerCode[0];

    if (!result.title) {
      // Don't throw — let caller decide whether to retry
      result._titleMissing = true;
    }

    return result;
  }

  // ── Helpers ──────────────────────────────────────────

  resolveMakerAlias(maker) {
    if (!maker || !this.options.makerAliases) return maker;
    return this.options.makerAliases[maker] || maker;
  }

  cleanTitle(title, actresses = []) {
    if (!title) return title;
    let clean = title.replace(/\s+/g, ' ').trim();
    for (const actress of (actresses || [])) {
      if (clean.endsWith(actress)) {
        clean = clean.slice(0, -actress.length).trim();
        log(`Removed actress "${actress}" from end of title`, 'debug');
        break;
      }
    }
    return clean;
  }

  extractCodeFromUrl(url) {
    const m = url.match(/\/v\/([A-Z0-9-]+)/);
    return m ? m[1] : null;
  }

  generateMockMetadata(item) {
    const code = item.code || 'TEST-001';
    return {
      code,
      title: `${code} Sample Title`,
      cleanTitle: 'Sample Title',
      actresses: ['Sample Actress'],
      date: '2024-01-01',
      coverUrl: `https://example.com/covers/${code}.jpg`,
      source: 'javdb',
      scrapedAt: new Date().toISOString(),
      dryRun: true
    };
  }

  /**
   * Download cover image via fetch() (static CDN, no browser needed).
   */
  async downloadCover(metadata) {
    if (!metadata.coverUrl) {
      log(`No cover URL for ${metadata.code}`, 'warn');
      return null;
    }

    // Use item-store's cover dir if available, otherwise fallback
    let coverDir;
    try {
      const { ensureCoverDir } = await import('../ingest/item-store.mjs');
      coverDir = ensureCoverDir();
    } catch {
      coverDir = getSkillPath('cache/ingest/covers');
      if (!existsSync(coverDir)) mkdirSync(coverDir, { recursive: true });
    }

    const ext = metadata.coverUrl.split('.').pop().split('?')[0] || 'jpg';
    const filePath = join(coverDir, `${metadata.code}.${ext}`);

    try {
      log(`Downloading cover: ${metadata.coverUrl} to ${filePath}`, 'info');
      const resp = await fetch(metadata.coverUrl, {
        headers: {
          'Referer': 'https://javdb.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      writeFileSync(filePath, Buffer.from(await resp.arrayBuffer()));
      log(`Downloaded cover: ${filePath}`, 'info');
      return filePath;
    } catch (error) {
      log(`Failed to download cover for ${metadata.code}: ${error.message}`, 'error');
      return null;
    }
  }

  // ── Cleanup ──────────────────────────────────────────

  async close() {
    if (this.page && this.sessionActive) {
      try {
        const cookies = await this.page.cookies();
        if (cookies.length > 0) this._saveCookies(cookies);
      } catch {}
    }

    if (this.browser) {
      try { await this.browser.close(); log('Browser closed', 'info'); } catch {}
    }

    this.browser = null;
    this.page = null;
    this.sessionActive = false;
  }

  static async test() {
    const scraper = new JavDBScraper({ dryRun: true, verbose: true });
    try {
      await scraper.initialize();
      const result = await scraper.scrapeItem({ code: 'TEST-001' });
      await scraper.close();
      return result;
    } catch (error) {
      await scraper.close();
      throw error;
    }
  }
}
