// ==UserScript==
// @name         豆瓣书影音目录导出（系统导入 + Notion CSV + 豆列支持）
// @namespace    https://chat.openai.com/
// @version      1.3.0
// @description  批量导出豆瓣书籍、电影、音乐目录；支持豆列/书单；额外生成与 Flutter 图书管理系统 ProductModel 对齐的导入 JSON/CSV，并修复作者识别
// @author       OpenAI
// @match        https://www.douban.com/people/*
// @match        https://www.douban.com/doulist/*
// @match        https://book.douban.com/people/*/collect*
// @match        https://book.douban.com/people/*/wish*
// @match        https://movie.douban.com/people/*/collect*
// @match        https://movie.douban.com/people/*/wish*
// @match        https://music.douban.com/people/*/collect*
// @match        https://music.douban.com/people/*/wish*
// @grant        GM_xmlhttpRequest
// @connect      book.douban.com
// @connect      movie.douban.com
// @connect      music.douban.com
// @connect      www.douban.com
// ==/UserScript==

(function () {
  'use strict';

  const EXPORT_FLAG = 'douban_media_export=1';
  const STORAGE_PREFIX = 'douban_media_export_state';
  const RATE_LIMIT_MS = 900;
  const RETRY_TIMES = 2;
  const REQUEST_TIMEOUT_MS = 20000;
  const DOWNLOAD_URL_KEEP_MS = 5 * 60 * 1000;

  const DEFAULT_OPTION = '不区分';
  const DEFAULT_OPERATOR = 'douban-import-script';
  const DEFAULT_STOCK_UNIT = '册';
  const DEFAULT_AUTHOR = '不详';

  const MEDIA = {
    book: {
      key: 'book',
      host: 'book.douban.com',
      collectText: '导出读过的书',
      wishText: '导出想读',
      statusCollect: '读过',
      statusWish: '想读',
      iconColor: '#42bd56',
    },
    movie: {
      key: 'movie',
      host: 'movie.douban.com',
      collectText: '导出看过的片',
      wishText: '导出想看',
      statusCollect: '看过',
      statusWish: '想看',
      iconColor: '#f59f00',
    },
    music: {
      key: 'music',
      host: 'music.douban.com',
      collectText: '导出听过的碟',
      wishText: '导出想听',
      statusCollect: '听过',
      statusWish: '想听',
      iconColor: '#2d8cf0',
    },
    mixed: {
      key: 'mixed',
      host: 'www.douban.com',
      collectText: '导出当前豆列 / 书单',
      wishText: '导出当前豆列 / 书单',
      statusCollect: '豆列',
      statusWish: '豆列',
      iconColor: '#8a5a2b',
    },
  };

  const EXPORT_FORMATS = {
    ALL: 'all',
    SPREADSHEET: 'spreadsheet',
    NOTION: 'notion',
    JSON: 'json',
    PRODUCT_IMPORT: 'product-import',
  };

  const ACTIVE_OBJECT_URLS = [];

  function qs(selector, root = document) {
    return root.querySelector(selector);
  }

  function qsa(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
  }

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isHomepage() {
    return location.hostname === 'www.douban.com' && /^\/people\/[^/]+\/?$/.test(location.pathname);
  }

  function isMediaListPage() {
    return /^(book|movie|music)\.douban\.com$/.test(location.hostname) &&
      /^\/people\/[^/]+\/(collect|wish)/.test(location.pathname);
  }

  function isDoulistPage() {
    return location.hostname === 'www.douban.com' && /^\/doulist\/\d+\/?/.test(location.pathname);
  }

  function isSupportedExportPage() {
    return isMediaListPage() || isDoulistPage();
  }

  function isExportMode() {
    return new URLSearchParams(location.search).get(EXPORT_FLAG) === '1';
  }

  function getPeopleIdFromUrl() {
    const match = location.pathname.match(/\/people\/([^/]+)\//);
    return match ? match[1] : '';
  }

  function getDoulistIdFromUrl() {
    const match = location.pathname.match(/\/doulist\/(\d+)\/?/);
    return match ? match[1] : '';
  }

  function getCurrentStart() {
    const params = new URLSearchParams(location.search);
    return Number(params.get('start') || '0');
  }

  function getMediaTypeFromHost() {
    if (location.hostname.startsWith('book.')) return 'book';
    if (location.hostname.startsWith('movie.')) return 'movie';
    if (location.hostname.startsWith('music.')) return 'music';
    return 'mixed';
  }

  function getListModeFromUrl() {
    if (isDoulistPage()) return 'doulist';
    return location.pathname.includes('/wish') ? 'wish' : 'collect';
  }

  function getSourceIdFromUrl() {
    if (isDoulistPage()) return `doulist-${getDoulistIdFromUrl()}`;
    return getPeopleIdFromUrl();
  }

  function getExportPayloadFromUrl() {
    const params = new URLSearchParams(location.search);
    return {
      sourceId: params.get('source_id') || getSourceIdFromUrl(),
      media: params.get('media') || getMediaTypeFromHost(),
      mode: params.get('mode') || getListModeFromUrl(),
      format: params.get('format') || EXPORT_FORMATS.ALL,
    };
  }

  function getStorageKey(sourceId, media, mode) {
    return `${STORAGE_PREFIX}:${sourceId}:${media}:${mode}`;
  }

  function loadState(sourceId, media, mode) {
    const raw = sessionStorage.getItem(getStorageKey(sourceId, media, mode));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (error) {
      console.error('[豆瓣目录导出] 读取状态失败：', error);
      return null;
    }
  }

  function saveState(sourceId, media, mode, state) {
    sessionStorage.setItem(getStorageKey(sourceId, media, mode), JSON.stringify(state));
  }

  function clearState(sourceId, media, mode) {
    sessionStorage.removeItem(getStorageKey(sourceId, media, mode));
  }

  function createNewState(sourceId, media, mode) {
    return {
      runId: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      sourceId,
      media,
      mode,
      createdAt: new Date().toISOString(),
      items: [],
      visitedStarts: [],
    };
  }

  function registerObjectUrl(url) {
    ACTIVE_OBJECT_URLS.push(url);
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch (_) {}
      const index = ACTIVE_OBJECT_URLS.indexOf(url);
      if (index >= 0) ACTIVE_OBJECT_URLS.splice(index, 1);
    }, DOWNLOAD_URL_KEEP_MS);
  }

  window.addEventListener('beforeunload', () => {
    ACTIVE_OBJECT_URLS.forEach((url) => {
      try {
        URL.revokeObjectURL(url);
      } catch (_) {}
    });
    ACTIVE_OBJECT_URLS.length = 0;
  });

  function createFloatingPanel() {
    let panel = document.getElementById('douban-media-export-panel');
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = 'douban-media-export-panel';
    panel.style.cssText = [
      'position:fixed',
      'right:20px',
      'bottom:20px',
      'z-index:999999',
      'background:#fff',
      'border:1px solid #d9d9d9',
      'border-radius:10px',
      'box-shadow:0 8px 24px rgba(0,0,0,.15)',
      'padding:12px',
      'width:350px',
      'font-size:13px',
      'line-height:1.5',
      'color:#333',
    ].join(';');

    document.body.appendChild(panel);
    return panel;
  }

  function ensureOverlay() {
    let overlay = document.getElementById('douban-media-export-overlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'douban-media-export-overlay';
    overlay.style.cssText = [
      'position:fixed',
      'right:20px',
      'bottom:20px',
      'z-index:1000000',
      'width:410px',
      'background:#fff',
      'border:1px solid #d9d9d9',
      'border-radius:12px',
      'box-shadow:0 8px 24px rgba(0,0,0,.18)',
      'padding:14px',
      'font-size:13px',
      'line-height:1.6',
      'color:#333',
    ].join(';');

    overlay.innerHTML = `
      <div style="font-weight:700;margin-bottom:8px;">豆瓣书影音目录导出</div>
      <div id="douban-media-export-status" style="white-space:pre-wrap;color:#444;"></div>
      <div id="douban-media-export-actions" style="margin-top:10px;"></div>
    `;
    document.body.appendChild(overlay);
    return overlay;
  }

  function setOverlayStatus(message) {
    const overlay = ensureOverlay();
    const el = qs('#douban-media-export-status', overlay);
    if (el) el.textContent = message;
  }

  function setOverlayActions(html) {
    const overlay = ensureOverlay();
    const el = qs('#douban-media-export-actions', overlay);
    if (el) el.innerHTML = html;
  }

  function buildPeopleExportLink(media, people, mode, format) {
    const host = MEDIA[media].host;
    const url = new URL(`https://${host}/people/${people}/${mode}`);
    url.searchParams.set('start', '0');
    url.searchParams.set('sort', 'time');
    url.searchParams.set('rating', 'all');
    url.searchParams.set('filter', 'all');
    url.searchParams.set('mode', 'list');
    url.searchParams.set(EXPORT_FLAG, '1');
    url.searchParams.set('source_id', people);
    url.searchParams.set('media', media);
    url.searchParams.set('mode', mode);
    url.searchParams.set('format', format);
    return url.toString();
  }

  function buildDoulistExportLink(format) {
    const doulistId = getDoulistIdFromUrl();
    const url = new URL(`https://www.douban.com/doulist/${doulistId}/`);
    url.searchParams.set('start', '0');
    url.searchParams.set(EXPORT_FLAG, '1');
    url.searchParams.set('source_id', `doulist-${doulistId}`);
    url.searchParams.set('media', 'mixed');
    url.searchParams.set('mode', 'doulist');
    url.searchParams.set('format', format);
    return url.toString();
  }

  function injectHomepageLinks() {
    const people = getPeopleIdFromUrl();
    if (!people) return;

    const panel = createFloatingPanel();
    panel.innerHTML = `
      <div style="font-weight:700;margin-bottom:8px;">豆瓣书影音目录导出</div>
      <div style="color:#666;margin-bottom:10px;">
        导出书籍、电影、音乐目录。
        <br>图书管理系统请用 <b>*.product-import.json</b>。
        <br>Notion 请用 <b>*.notion.csv</b>。
      </div>

      <label style="display:block;margin-bottom:6px;font-weight:600;">导出格式</label>
      <select id="douban-media-export-format"
              style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;margin-bottom:12px;">
        <option value="all" selected>全部导出</option>
        <option value="product-import">只导出图书管理系统导入文件（书籍 JSON + CSV）</option>
        <option value="spreadsheet">只导出通用表格 CSV</option>
        <option value="notion">只导出 Notion CSV</option>
        <option value="json">只导出原始 JSON</option>
      </select>

      <div style="display:flex;flex-direction:column;gap:8px;" id="douban-media-export-buttons"></div>
    `;

    const buttonsWrap = qs('#douban-media-export-buttons', panel);
    const select = qs('#douban-media-export-format', panel);

    [
      ['book', 'collect'],
      ['book', 'wish'],
      ['movie', 'collect'],
      ['movie', 'wish'],
      ['music', 'collect'],
      ['music', 'wish'],
    ].forEach(([media, mode]) => {
      const conf = MEDIA[media];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.style.cssText = `
        border:none;
        background:${conf.iconColor};
        color:#fff;
        padding:8px 10px;
        border-radius:6px;
        cursor:pointer;
      `;
      btn.textContent = mode === 'collect' ? conf.collectText : conf.wishText;
      btn.addEventListener('click', () => {
        const format = select?.value || EXPORT_FORMATS.ALL;
        location.href = buildPeopleExportLink(media, people, mode, format);
      });
      buttonsWrap.appendChild(btn);
    });
  }

  function injectDoulistLinks() {
    const doulistId = getDoulistIdFromUrl();
    if (!doulistId) return;

    const panel = createFloatingPanel();
    panel.innerHTML = `
      <div style="font-weight:700;margin-bottom:8px;">豆列 / 书单导出</div>
      <div style="color:#666;margin-bottom:10px;">
        当前豆列 ID：${doulistId}
        <br>会抓取当前豆列里的书/电影/音乐条目。
        <br>你的图书管理系统只会使用其中的书籍条目。
      </div>

      <label style="display:block;margin-bottom:6px;font-weight:600;">导出格式</label>
      <select id="douban-media-export-format"
              style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;margin-bottom:12px;">
        <option value="all" selected>全部导出</option>
        <option value="product-import">只导出图书管理系统导入文件（只含书籍 JSON + CSV）</option>
        <option value="spreadsheet">只导出通用表格 CSV</option>
        <option value="notion">只导出 Notion CSV</option>
        <option value="json">只导出原始 JSON</option>
      </select>

      <button id="douban-doulist-export-button"
              style="width:100%;border:none;background:#8a5a2b;color:#fff;padding:9px 10px;border-radius:6px;cursor:pointer;">
        导出当前豆列 / 书单
      </button>
    `;

    const select = qs('#douban-media-export-format', panel);
    const button = qs('#douban-doulist-export-button', panel);
    button?.addEventListener('click', () => {
      const format = select?.value || EXPORT_FORMATS.ALL;
      location.href = buildDoulistExportLink(format);
    });
  }

  function buildEmptyItem(media, mode, statusText, overrides = {}) {
    return Object.assign({
      media,
      status: statusText,
      title: '',
      link: '',
      subjectId: '',
      myRating: '',
      markedAt: '',
      comment: '',
      intro: '',
      cover: '',
      doubanRating: '',
      summary: '',
      creators: '',
      author: '',
      countryOrRegion: '',
      dateText: '',
      year: '',
      publisherOrStudio: '',
      publisher: '',
      identifier: '',
      isbn: '',
      price: '',
      priceValue: '',
      genre: '',
      binding: '',
      edition: '',
      rawInfo: {},
      fetchStatus: 'pending',
      fetchError: '',
      mode,
    }, overrides);
  }

  function extractSubjectId(link) {
    const match = String(link || '').match(/subject\/(\d+)/);
    return match ? match[1] : '';
  }

  function detectMediaFromSubjectUrl(link) {
    if (/book\.douban\.com\/subject\//.test(link)) return 'book';
    if (/movie\.douban\.com\/subject\//.test(link)) return 'movie';
    if (/music\.douban\.com\/subject\//.test(link)) return 'music';
    return '';
  }

  function mediaAcceptsLink(selectedMedia, link) {
    const actual = detectMediaFromSubjectUrl(link);
    if (!actual) return false;
    if (selectedMedia === 'mixed') return true;
    return selectedMedia === actual;
  }

  function statusTextForItem(selectedMedia, actualMedia, mode) {
    const media = MEDIA[actualMedia] || MEDIA[selectedMedia] || MEDIA.mixed;
    if (mode === 'doulist') return '豆列';
    return mode === 'collect' ? media.statusCollect : media.statusWish;
  }

  function parseCurrentPageItems(selectedMedia, mode) {
    const items = [];
    const seen = new Set();
    const anchors = qsa('a[href*="/subject/"]');

    anchors.forEach((anchor) => {
      const href = anchor.getAttribute('href');
      if (!href || !/subject\/\d+/.test(href)) return;

      const link = new URL(href, location.href).href;
      const subjectId = extractSubjectId(link);
      if (!subjectId || seen.has(subjectId)) return;
      if (!mediaAcceptsLink(selectedMedia, link)) return;

      const actualMedia = detectMediaFromSubjectUrl(link);
      const title = normalizeText(anchor.textContent || anchor.getAttribute('title'));
      if (!title) return;

      let container = anchor;
      while (container && container !== document.body) {
        if (
          container.matches &&
          (
            container.matches('.item') ||
            container.matches('li') ||
            container.matches('.grid-view > div') ||
            container.matches('.article > div') ||
            container.matches('.doulist-item') ||
            container.matches('.subject-item')
          )
        ) {
          break;
        }
        container = container.parentElement;
      }

      const node = container || anchor;
      const item = buildEmptyItem(actualMedia, mode, statusTextForItem(selectedMedia, actualMedia, mode), {
        title,
        link,
        subjectId,
        cover:
          qs('.pic img', node)?.getAttribute('src') ||
          qs('img', node)?.getAttribute('src') ||
          '',
      });

      const dateEl = qs('.date', node);
      if (dateEl) {
        const dateClone = dateEl.cloneNode(true);
        const ratingSpan = qs('span', dateClone);
        if (ratingSpan) {
          const className = ratingSpan.getAttribute('class') || '';
          const ratingMatch = className.match(/rating(\d)-t/);
          item.myRating = ratingMatch ? ratingMatch[1] : '';
          ratingSpan.remove();
        }
        item.markedAt = normalizeText(dateClone.textContent).replaceAll('-', '/');
      }

      const commentEl = qs('.comment', node) || qs('.doulist-subject-comment', node);
      if (commentEl) item.comment = normalizeText(commentEl.textContent);

      const introEl = qs('.intro', node) || qs('.abstract', node);
      if (introEl) item.intro = normalizeText(introEl.textContent);

      seen.add(subjectId);
      items.push(item);
    });

    return items;
  }

  function httpGetText(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          timeout: REQUEST_TIMEOUT_MS,
          anonymous: false,
          headers: {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          onload(response) {
            if (response.status >= 200 && response.status < 400 && response.responseText) {
              resolve(response.responseText);
            } else {
              reject(new Error(`HTTP ${response.status}`));
            }
          },
          onerror(err) {
            reject(err || new Error('GM_xmlhttpRequest error'));
          },
          ontimeout() {
            reject(new Error('GM_xmlhttpRequest timeout'));
          },
        });
        return;
      }

      fetch(url, { credentials: 'include' })
        .then((resp) => {
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return resp.text();
        })
        .then(resolve)
        .catch(reject);
    });
  }

  async function fetchWithRetry(url, attempt = 0) {
    try {
      return await httpGetText(url);
    } catch (error) {
      if (attempt < RETRY_TIMES) {
        await sleep(RATE_LIMIT_MS * (attempt + 1));
        return fetchWithRetry(url, attempt + 1);
      }
      throw error;
    }
  }

  function cleanInfoLabel(label) {
    return normalizeText(label)
      .replace(/[：:]\s*$/, '')
      .replace(/\s+/g, '')
      .trim();
  }

  function cleanInfoValue(value, label = '') {
    let text = normalizeText(value)
      .replace(/^[:：]\s*/, '')
      .replace(/\s*\/\s*/g, ' / ')
      .trim();
    if (label) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(`^${escaped}\s*[:：]?\s*`), '').trim();
    }
    return text;
  }

  function extractInfoMap(doc) {
    const infoEl = qs('#info', doc);
    const infoMap = {};
    if (!infoEl) return infoMap;

    // 方案 A：按 innerText 行解析。豆瓣图书页最稳定，能正确处理嵌套 span / a。
    const lines = String(infoEl.innerText || infoEl.textContent || '')
      .split(/\n+/)
      .map((line) => normalizeText(line))
      .filter(Boolean);

    let currentLabel = '';
    for (const line of lines) {
      const match = line.match(/^([^:：]{1,20})\s*[:：]\s*(.*)$/);
      if (match) {
        currentLabel = cleanInfoLabel(match[1]);
        const value = cleanInfoValue(match[2], currentLabel);
        if (currentLabel && value) {
          infoMap[currentLabel] = infoMap[currentLabel]
            ? `${infoMap[currentLabel]} / ${value}`
            : value;
        } else if (currentLabel && !(currentLabel in infoMap)) {
          infoMap[currentLabel] = '';
        }
      } else if (currentLabel && line) {
        const previous = infoMap[currentLabel] || '';
        infoMap[currentLabel] = previous ? `${previous} ${line}` : line;
      }
    }

    // 方案 B：再按 .pl 标签兜底。修复部分页面 innerText 合并异常。
    qsa('#info .pl', doc).forEach((pl) => {
      const label = cleanInfoLabel(pl.textContent);
      if (!label) return;

      let value = '';
      if (pl.parentElement && pl.parentElement !== infoEl) {
        value = cleanInfoValue(
          pl.parentElement.textContent.replace(pl.textContent, ''),
          label,
        );
      }

      if (!value) {
        const parts = [];
        let node = pl.nextSibling;
        let guard = 0;
        while (node && guard < 30) {
          guard += 1;
          if (node.nodeType === 1 && node.tagName === 'BR') break;
          if (node.nodeType === 1 && node.classList?.contains('pl')) break;
          parts.push(node.textContent || '');
          node = node.nextSibling;
        }
        value = cleanInfoValue(parts.join(' '), label);
      }

      if (value && !infoMap[label]) {
        infoMap[label] = value;
      }
    });

    return infoMap;
  }

  function getInfoValue(infoMap, labels) {
    for (const label of labels) {
      const key = cleanInfoLabel(label);
      const value = normalizeText(infoMap[key] || infoMap[label] || '');
      if (value) return value;
    }
    return '';
  }

  function extractJsonLdObjects(doc) {
    const objects = [];
    qsa('script[type="application/ld+json"]', doc).forEach((script) => {
      const raw = script.textContent?.trim();
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          objects.push(...parsed);
        } else {
          objects.push(parsed);
        }
      } catch (_) {}
    });
    return objects;
  }

  function extractAuthorFromJsonLd(doc) {
    const objects = extractJsonLdObjects(doc);
    for (const object of objects) {
      const author = object?.author;
      if (!author) continue;
      if (typeof author === 'string') return normalizeText(author);
      if (Array.isArray(author)) {
        const text = author
          .map((entry) => typeof entry === 'string' ? entry : entry?.name)
          .filter(Boolean)
          .join(' / ');
        if (normalizeText(text)) return normalizeText(text);
      }
      if (author?.name) return normalizeText(author.name);
    }
    return '';
  }

  function parseAuthorFromIntro(intro) {
    const text = normalizeText(intro);
    if (!text) return '';
    const parts = text.split(/\s*\/\s*/).map((part) => normalizeText(part)).filter(Boolean);
    const first = parts[0] || '';
    if (!first) return '';
    if (/出版社|出版|发行|\d{4}|ISBN|定价|平装|精装|Paperback|Hardcover/i.test(first)) return '';
    return first;
  }

  function cleanBookAuthor(value) {
    let text = cleanInfoValue(value, '作者');
    text = text
      .replace(/^(作者|作者\/译者|编者|译者|绘者)\s*[:：]?\s*/, '')
      .replace(/\s*(出版社|出品方|原作名|译者|出版年|页数|定价|装帧|ISBN)\s*[:：].*$/g, '')
      .replace(/\s*\/\s*/g, ' / ')
      .trim();
    return text;
  }

  function extractBookAuthor(infoMap, doc, item) {
    const fromInfo = getInfoValue(infoMap, [
      '作者',
      '作者/译者',
      '作者／译者',
      '编者',
      '著者',
      '绘者',
    ]);
    const cleaned = cleanBookAuthor(fromInfo);
    if (cleaned) return cleaned;

    const jsonLdAuthor = cleanBookAuthor(extractAuthorFromJsonLd(doc));
    if (jsonLdAuthor) return jsonLdAuthor;

    const propertyAuthor = cleanBookAuthor(
      qsa('[property="book:author"], [rel="v:author"]', doc)
        .map((el) => normalizeText(el.textContent))
        .filter(Boolean)
        .join(' / '),
    );
    if (propertyAuthor) return propertyAuthor;

    const introAuthor = cleanBookAuthor(parseAuthorFromIntro(item?.intro || ''));
    if (introAuthor) return introAuthor;

    return '';
  }

  function parsePriceNumber(raw) {
    const match = String(raw || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
    return match ? Number(match[1]) : 0;
  }

  function parseDoubanRating(raw) {
    const match = String(raw || '').match(/(\d+(?:\.\d+)?)/);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  }

  function extractBookPublisher(infoMap) {
    return getInfoValue(infoMap, ['出版社', '出版者', 'Publisher']) || DEFAULT_OPTION;
  }

  function extractBookPublicationYear(infoMap) {
    return getInfoValue(infoMap, ['出版年', '出版日期', '出版时间', 'Published']) || null;
  }

  function parseDetailByMedia(media, item, doc) {
    const infoMap = extractInfoMap(doc);
    const title =
      normalizeText(
        qs('#wrapper h1 span', doc)?.textContent ||
        qs('h1 span', doc)?.textContent ||
        qs('h1', doc)?.textContent ||
        item.title,
      ) || item.title;

    const cover =
      qs('#mainpic img', doc)?.getAttribute('src') ||
      qs('.nbg img', doc)?.getAttribute('src') ||
      item.cover ||
      '';

    const doubanRating =
      normalizeText(qs('strong[property="v:average"]', doc)?.textContent) ||
      normalizeText(qs('strong.rating_num', doc)?.textContent) ||
      '';

    const summary =
      normalizeText(
        qs('#link-report-intra span.all.hidden', doc)?.textContent ||
        qs('#link-report span[property="v:summary"]', doc)?.textContent ||
        qs('.related_info .indent span.all.hidden', doc)?.textContent ||
        qs('.related_info .indent', doc)?.textContent,
      ) || '';

    let creators = '';
    let author = '';
    let countryOrRegion = '';
    let dateText = '';
    let year = '';
    let publisherOrStudio = '';
    let publisher = '';
    let identifier = '';
    let isbn = '';
    let price = '';
    let priceValue = '';
    let genre = '';
    let binding = '';
    let edition = '';

    if (media === 'book') {
      author = extractBookAuthor(infoMap, doc, item);
      creators = author;
      countryOrRegion = '';
      dateText = extractBookPublicationYear(infoMap) || '';
      year = (dateText.match(/\d{4}/) || [''])[0];
      publisher = extractBookPublisher(infoMap);
      publisherOrStudio = publisher;
      identifier = getInfoValue(infoMap, ['ISBN', 'isbn']);
      isbn = identifier;
      price = getInfoValue(infoMap, ['定价', '价格', 'Price']);
      priceValue = String(parsePriceNumber(price) || '');
      binding = getInfoValue(infoMap, ['装帧', 'Binding']) || DEFAULT_OPTION;
      edition = getInfoValue(infoMap, ['版次', 'Edition']);
      genre = '';
    }

    if (media === 'movie') {
      const genres = qsa('[property="v:genre"]', doc)
        .map((el) => normalizeText(el.textContent))
        .filter(Boolean);
      const releaseDates = qsa('[property="v:initialReleaseDate"]', doc)
        .map((el) => normalizeText(el.textContent))
        .filter(Boolean);
      const yearText = normalizeText(qs('#content h1 .year', doc)?.textContent).replace(/[()]/g, '') || '';

      creators = getInfoValue(infoMap, ['导演']) || item.intro || '';
      countryOrRegion = getInfoValue(infoMap, ['制片国家/地区', '国家/地区']);
      dateText = releaseDates.join(' / ') || yearText || '';
      year = (yearText.match(/\d{4}/) || [''])[0] || (dateText.match(/\d{4}/) || [''])[0];
      publisherOrStudio = countryOrRegion;
      identifier = getInfoValue(infoMap, ['IMDb']);
      genre = genres.join(' / ');
    }

    if (media === 'music') {
      creators = getInfoValue(infoMap, ['表演者', '艺术家', '作者']) || item.intro || '';
      countryOrRegion = getInfoValue(infoMap, ['介质']);
      dateText = getInfoValue(infoMap, ['发行时间', '出版时间']);
      year = (dateText.match(/\d{4}/) || [''])[0];
      publisherOrStudio = getInfoValue(infoMap, ['出版者', '厂牌', '发行者']);
      identifier = getInfoValue(infoMap, ['条形码', 'ISBN']);
      price = getInfoValue(infoMap, ['定价', '价格']);
      genre = getInfoValue(infoMap, ['流派']);
    }

    return {
      ...item,
      title,
      cover,
      doubanRating,
      summary,
      creators: normalizeText(creators),
      author: normalizeText(author),
      countryOrRegion: normalizeText(countryOrRegion),
      dateText: normalizeText(dateText),
      year: normalizeText(year),
      publisherOrStudio: normalizeText(publisherOrStudio),
      publisher: normalizeText(publisher),
      identifier: normalizeText(identifier),
      isbn: normalizeText(isbn),
      price: normalizeText(price),
      priceValue: normalizeText(priceValue),
      genre: normalizeText(genre),
      binding: normalizeText(binding),
      edition: normalizeText(edition),
      rawInfo: infoMap,
      fetchStatus: 'ok',
      fetchError: '',
    };
  }

  async function enrichItem(item) {
    try {
      const html = await fetchWithRetry(item.link);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return parseDetailByMedia(item.media, item, doc);
    } catch (error) {
      return {
        ...item,
        fetchStatus: 'failed',
        fetchError: String(error?.message || error || 'unknown error'),
      };
    }
  }

  async function enrichItemsSequentially(items) {
    const enriched = [];
    for (let i = 0; i < items.length; i++) {
      const current = items[i];
      setOverlayStatus(
        `正在抓取详情页...\n` +
        `分类：${current.media}\n` +
        `当前页进度：${i + 1}/${items.length}\n` +
        `标题：${current.title || current.subjectId}`,
      );
      const detailItem = await enrichItem(current);
      enriched.push(detailItem);
      await sleep(RATE_LIMIT_MS);
    }
    return enriched;
  }

  function getRawNextPageHref() {
    const selectors = [
      '.paginator span.next a',
      '.paginator .next a',
      'span.next a',
      'a.next',
      '.next a',
    ];
    for (const selector of selectors) {
      const anchor = qs(selector);
      if (anchor && anchor.getAttribute('href')) return anchor.getAttribute('href');
    }
    return '';
  }

  function buildNextPageUrl(nextHref, runId, media, mode, format, sourceId) {
    const nextUrl = new URL(nextHref, location.href);
    nextUrl.searchParams.set(EXPORT_FLAG, '1');
    nextUrl.searchParams.set('run_id', runId);
    nextUrl.searchParams.set('source_id', sourceId);
    nextUrl.searchParams.set('media', media);
    nextUrl.searchParams.set('mode', mode);
    nextUrl.searchParams.set('format', format);
    return nextUrl.toString();
  }

  function getNextPageUrl(runId, media, mode, format, sourceId) {
    const nextHref = getRawNextPageHref();
    if (!nextHref) return '';
    return buildNextPageUrl(nextHref, runId, media, mode, format, sourceId);
  }

  function mergeItemsIntoState(state, newItems) {
    const existingKeys = new Set(state.items.map((item) => `${item.media}:${item.subjectId}`));
    newItems.forEach((item) => {
      const key = `${item.media}:${item.subjectId}`;
      if (!existingKeys.has(key)) {
        state.items.push(item);
        existingKeys.add(key);
      }
    });
  }

  function escapeCsvValue(value) {
    const normalized = String(value ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    const escaped = normalized.replaceAll('"', '""');
    const shouldQuote = escaped.includes(',') || escaped.includes('"') || escaped.includes('\n');
    return shouldQuote ? `"${escaped}"` : escaped;
  }

  function createCsvText(rows, headers) {
    const buffer = [];
    buffer.push('\uFEFF' + headers.map((h) => escapeCsvValue(h.label)).join(','));
    rows.forEach((row) => {
      buffer.push(headers.map((h) => escapeCsvValue(row[h.key] ?? '')).join(','));
    });
    return buffer.join('\r\n');
  }

  function createBlobUrl(content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    registerObjectUrl(url);
    return url;
  }

  function triggerDownload(url, fileName) {
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function normalizeSortText(value) {
    return normalizeText(value).toLowerCase();
  }

  function normalizeSortYear(value) {
    const year = Number((String(value || '').match(/\d{4}/) || ['0'])[0]);
    return Number.isFinite(year) ? year : 0;
  }

  function sortItemsForArchive(items) {
    return [...items].sort((a, b) => {
      const mediaCompare = normalizeSortText(a.media).localeCompare(normalizeSortText(b.media), 'zh');
      if (mediaCompare !== 0) return mediaCompare;
      const creatorCompare = normalizeSortText(a.creators).localeCompare(normalizeSortText(b.creators), 'zh');
      if (creatorCompare !== 0) return creatorCompare;
      const countryCompare = normalizeSortText(a.countryOrRegion).localeCompare(normalizeSortText(b.countryOrRegion), 'zh');
      if (countryCompare !== 0) return countryCompare;
      const yearCompare = normalizeSortYear(a.year) - normalizeSortYear(b.year);
      if (yearCompare !== 0) return yearCompare;
      return normalizeSortText(a.title).localeCompare(normalizeSortText(b.title), 'zh');
    });
  }

  function normalizeAsciiSegment(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[\'"`’‘]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function buildBaseSelfEncoding(title, subjectId) {
    const ascii = normalizeAsciiSegment(title);
    if (ascii && /[a-z]/.test(ascii)) return ascii;
    return `DB-${subjectId || 'UNKNOWN'}`;
  }

  function ensureUniqueSuffix(base, usedSet) {
    let candidate = base;
    let index = 2;
    while (usedSet.has(candidate)) {
      candidate = `${base}-${index}`;
      index += 1;
    }
    usedSet.add(candidate);
    return candidate;
  }

  function toProductImportObjects(items) {
    const bookItems = items.filter((item) => item.media === 'book');
    const usedProductIds = new Set();
    const usedSelfEncodings = new Set();

    return bookItems.map((item) => {
      const isbn = normalizeText(item.isbn || item.identifier) || null;
      const subjectId = normalizeText(item.subjectId);
      const priceNumber = parsePriceNumber(item.priceValue || item.price);
      const doubanRating = parseDoubanRating(item.doubanRating);
      const productIdBase = isbn || `DB-${subjectId || 'UNKNOWN'}`;
      const productId = ensureUniqueSuffix(productIdBase, usedProductIds);
      const selfEncodingBase = buildBaseSelfEncoding(item.title, subjectId);
      const selfEncoding = ensureUniqueSuffix(selfEncodingBase, usedSelfEncodings);
      const author = normalizeText(item.author || item.creators) || DEFAULT_AUTHOR;

      return {
        id: 0,
        productId,
        title: normalizeText(item.title),
        author,
        isbn,
        price: priceNumber,
        category: DEFAULT_OPTION,
        categoryId: null,
        publisher: normalizeText(item.publisher) || DEFAULT_OPTION,
        publisherId: null,
        selfEncoding,
        internalPricing: null,
        purchasePrice: priceNumber || null,
        publicationYear: normalizeText(item.dateText) || null,
        edition: normalizeText(item.edition) || null,
        binding: normalizeText(item.binding) || DEFAULT_OPTION,
        doubanRating,
        retailDiscount: null,
        wholesaleDiscount: null,
        wholesalePrice: null,
        memberDiscount: null,
        purchaseSaleMode: DEFAULT_OPTION,
        purchaseSaleModeId: null,
        bookmark: null,
        packaging: DEFAULT_OPTION,
        property: DEFAULT_OPTION,
        statisticalClass: DEFAULT_OPTION,
        status: 1,
        stockUnit: DEFAULT_STOCK_UNIT,
        stockLowerLimitQty: null,
        stockUpperLimitQty: null,
        createdBy: null,
        updatedBy: null,
        operator: DEFAULT_OPERATOR,
        createdAt: null,
        updatedAt: null,
      };
    });
  }

  function buildSpreadsheetRows(items) {
    return items.map((item) => ({
      mediaType: item.media,
      status: item.status,
      title: item.title,
      creators: item.creators,
      author: item.author,
      countryOrRegion: item.countryOrRegion,
      doubanRating: item.doubanRating,
      myRating: item.myRating,
      markedAt: item.markedAt,
      dateText: item.dateText,
      year: item.year,
      publisherOrStudio: item.publisherOrStudio,
      identifier: item.identifier,
      price: item.price,
      genre: item.genre,
      comment: item.comment,
      summary: item.summary,
      cover: item.cover,
      link: item.link,
      subjectId: item.subjectId,
      fetchStatus: item.fetchStatus,
      fetchError: item.fetchError,
      rawInfo: JSON.stringify(item.rawInfo || {}),
    }));
  }

  function buildNotionRows(items) {
    return items.map((item) => ({
      Name: item.title,
      'Media Type': item.media,
      Status: item.status,
      Creator: item.creators,
      Author: item.author,
      'Country / Region': item.countryOrRegion,
      'Archive Sort Creator': item.creators,
      'Archive Sort Country': item.countryOrRegion,
      'Archive Sort Year': item.year,
      'Douban Rating': item.doubanRating,
      'My Rating': item.myRating,
      'Marked At': item.markedAt,
      'Release / Publish Date': item.dateText,
      Year: item.year,
      'Publisher / Studio / Label': item.publisherOrStudio,
      Identifier: item.identifier,
      Price: item.price,
      Genre: item.genre,
      Comment: item.comment,
      Summary: item.summary,
      'Cover URL': item.cover,
      'Douban URL': item.link,
      'Subject ID': item.subjectId,
      'Raw Info': JSON.stringify(item.rawInfo || {}),
    }));
  }

  function buildProductImportCsvRows(productItems) {
    return productItems.map((item) => ({
      title: item.title,
      productId: item.productId,
      author: item.author,
      isbn: item.isbn || '',
      price: item.price,
      publisher: item.publisher,
      publicationYear: item.publicationYear || '',
      binding: item.binding,
      doubanRating: item.doubanRating ?? '',
      selfEncoding: item.selfEncoding,
      category: item.category,
      purchasePrice: item.purchasePrice ?? '',
      purchaseSaleMode: item.purchaseSaleMode,
      packaging: item.packaging,
      property: item.property,
      statisticalClass: item.statisticalClass,
      stockUnit: item.stockUnit,
      operator: item.operator,
    }));
  }

  const SPREADSHEET_HEADERS = [
    { key: 'mediaType', label: '类型' },
    { key: 'status', label: '标记状态' },
    { key: 'title', label: '标题' },
    { key: 'creators', label: '创作者' },
    { key: 'author', label: '作者' },
    { key: 'countryOrRegion', label: '国家/地区' },
    { key: 'doubanRating', label: '豆瓣评分' },
    { key: 'myRating', label: '我的评分' },
    { key: 'markedAt', label: '标记日期' },
    { key: 'dateText', label: '发行/出版日期' },
    { key: 'year', label: '年份' },
    { key: 'publisherOrStudio', label: '出版社/片源地区/厂牌' },
    { key: 'identifier', label: 'ISBN/条形码/IMDb' },
    { key: 'price', label: '定价' },
    { key: 'genre', label: '流派/类型' },
    { key: 'comment', label: '简评' },
    { key: 'summary', label: '摘要' },
    { key: 'cover', label: '封面链接' },
    { key: 'link', label: '条目链接' },
    { key: 'subjectId', label: '条目ID' },
    { key: 'fetchStatus', label: '抓取状态' },
    { key: 'fetchError', label: '抓取错误' },
    { key: 'rawInfo', label: '原始信息' },
  ];

  const NOTION_HEADERS = [
    { key: 'Name', label: 'Name' },
    { key: 'Media Type', label: 'Media Type' },
    { key: 'Status', label: 'Status' },
    { key: 'Creator', label: 'Creator' },
    { key: 'Author', label: 'Author' },
    { key: 'Country / Region', label: 'Country / Region' },
    { key: 'Archive Sort Creator', label: 'Archive Sort Creator' },
    { key: 'Archive Sort Country', label: 'Archive Sort Country' },
    { key: 'Archive Sort Year', label: 'Archive Sort Year' },
    { key: 'Douban Rating', label: 'Douban Rating' },
    { key: 'My Rating', label: 'My Rating' },
    { key: 'Marked At', label: 'Marked At' },
    { key: 'Release / Publish Date', label: 'Release / Publish Date' },
    { key: 'Year', label: 'Year' },
    { key: 'Publisher / Studio / Label', label: 'Publisher / Studio / Label' },
    { key: 'Identifier', label: 'Identifier' },
    { key: 'Price', label: 'Price' },
    { key: 'Genre', label: 'Genre' },
    { key: 'Comment', label: 'Comment' },
    { key: 'Summary', label: 'Summary' },
    { key: 'Cover URL', label: 'Cover URL' },
    { key: 'Douban URL', label: 'Douban URL' },
    { key: 'Subject ID', label: 'Subject ID' },
    { key: 'Raw Info', label: 'Raw Info' },
  ];

  const PRODUCT_IMPORT_HEADERS = [
    { key: 'title', label: '书名' },
    { key: 'productId', label: '商品编码' },
    { key: 'author', label: '作者' },
    { key: 'isbn', label: 'ISBN' },
    { key: 'price', label: '售价' },
    { key: 'publisher', label: '出版社' },
    { key: 'publicationYear', label: '出版年' },
    { key: 'binding', label: '装帧' },
    { key: 'doubanRating', label: '豆瓣评分' },
    { key: 'selfEncoding', label: '自编码' },
    { key: 'category', label: '商品类别' },
    { key: 'purchasePrice', label: '进货价' },
    { key: 'purchaseSaleMode', label: '购销方式' },
    { key: 'packaging', label: '包装' },
    { key: 'property', label: '商品属性' },
    { key: 'statisticalClass', label: '统计分类' },
    { key: 'stockUnit', label: '库存单位' },
    { key: 'operator', label: '操作人员' },
  ];

  function createDownloads(items, selectedMedia, mode) {
    const sortedItems = sortItemsForArchive(items);
    const datePart = new Date().toISOString().split('T')[0].replaceAll('-', '');
    const base = `douban-${selectedMedia}-${mode}-${datePart}`;
    const productItems = toProductImportObjects(sortedItems);

    const spreadsheetCsv = createCsvText(buildSpreadsheetRows(sortedItems), SPREADSHEET_HEADERS);
    const notionCsv = createCsvText(buildNotionRows(sortedItems), NOTION_HEADERS);
    const rawJsonText = JSON.stringify(sortedItems, null, 2);
    const productJsonText = JSON.stringify(productItems, null, 2);
    const productCsv = createCsvText(buildProductImportCsvRows(productItems), PRODUCT_IMPORT_HEADERS);

    return {
      spreadsheet: {
        fileName: `${base}.csv`,
        url: createBlobUrl(spreadsheetCsv, 'text/csv;charset=utf-8;'),
      },
      notion: {
        fileName: `${base}.notion.csv`,
        url: createBlobUrl(notionCsv, 'text/csv;charset=utf-8;'),
      },
      json: {
        fileName: `${base}.json`,
        url: createBlobUrl(rawJsonText, 'application/json;charset=utf-8;'),
      },
      productJson: {
        fileName: `${base}.product-import.json`,
        url: createBlobUrl(productJsonText, 'application/json;charset=utf-8;'),
      },
      productCsv: {
        fileName: `${base}.product-import.csv`,
        url: createBlobUrl(productCsv, 'text/csv;charset=utf-8;'),
      },
      productCount: productItems.length,
    };
  }

  async function exportAll(sourceId, selectedMedia, mode, state, format) {
    const items = state.items;
    setOverlayStatus(
      `准备导出...\n` +
      `来源：${sourceId}\n` +
      `类型：${selectedMedia}\n` +
      `状态：${mode}\n` +
      `总条目数：${items.length}`,
    );

    if (!items.length) {
      alert('当前页条目未被识别。请重新从第一页导出，或把页面结构截图发给我继续适配。');
      clearState(sourceId, selectedMedia, mode);
      return;
    }

    const downloads = createDownloads(items, selectedMedia, mode);

    if (format === EXPORT_FORMATS.PRODUCT_IMPORT || format === EXPORT_FORMATS.ALL) {
      triggerDownload(downloads.productJson.url, downloads.productJson.fileName);
      await sleep(1200);
      triggerDownload(downloads.productCsv.url, downloads.productCsv.fileName);
      await sleep(1200);
    }
    if (format === EXPORT_FORMATS.SPREADSHEET || format === EXPORT_FORMATS.ALL) {
      triggerDownload(downloads.spreadsheet.url, downloads.spreadsheet.fileName);
      await sleep(1200);
    }
    if (format === EXPORT_FORMATS.NOTION || format === EXPORT_FORMATS.ALL) {
      triggerDownload(downloads.notion.url, downloads.notion.fileName);
      await sleep(1200);
    }
    if (format === EXPORT_FORMATS.JSON || format === EXPORT_FORMATS.ALL) {
      triggerDownload(downloads.json.url, downloads.json.fileName);
    }

    setOverlayStatus(
      `导出完成。\n` +
      `来源：${sourceId}\n` +
      `类型：${selectedMedia}\n` +
      `状态：${mode}\n` +
      `原始条目数：${items.length}\n` +
      `图书管理系统商品数：${downloads.productCount}\n` +
      `系统导入请优先使用 *.product-import.json。`,
    );

    setOverlayActions(`
      <div style="display:flex;flex-direction:column;gap:8px;">
        <a href="${downloads.productJson.url}" download="${downloads.productJson.fileName}"
           style="display:inline-block;background:#8a5a2b;color:#fff;text-decoration:none;padding:8px 12px;border-radius:6px;text-align:center;">
          重新下载系统导入 JSON
        </a>
        <a href="${downloads.productCsv.url}" download="${downloads.productCsv.fileName}"
           style="display:inline-block;background:#a66f38;color:#fff;text-decoration:none;padding:8px 12px;border-radius:6px;text-align:center;">
          重新下载系统导入 CSV
        </a>
        <a href="${downloads.notion.url}" download="${downloads.notion.fileName}"
           style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:8px 12px;border-radius:6px;text-align:center;">
          重新下载 Notion CSV
        </a>
        <a href="${downloads.spreadsheet.url}" download="${downloads.spreadsheet.fileName}"
           style="display:inline-block;background:#42bd56;color:#fff;text-decoration:none;padding:8px 12px;border-radius:6px;text-align:center;">
          重新下载通用 CSV
        </a>
        <a href="${downloads.json.url}" download="${downloads.json.fileName}"
           style="display:inline-block;background:#2d8cf0;color:#fff;text-decoration:none;padding:8px 12px;border-radius:6px;text-align:center;">
          重新下载原始 JSON
        </a>
      </div>
    `);

    clearState(sourceId, selectedMedia, mode);
  }

  async function runExport() {
    const currentStart = getCurrentStart();
    const payload = getExportPayloadFromUrl();
    const sourceId = payload.sourceId;
    const selectedMedia = payload.media;
    const mode = payload.mode;
    const format = payload.format;

    if (!sourceId || !selectedMedia || !mode) {
      alert('无法识别当前导出上下文');
      return;
    }

    let state = loadState(sourceId, selectedMedia, mode);
    if (currentStart === 0 || !state) {
      state = createNewState(sourceId, selectedMedia, mode);
      saveState(sourceId, selectedMedia, mode, state);
    }

    if (!Array.isArray(state.visitedStarts) || !Array.isArray(state.items)) {
      state = createNewState(sourceId, selectedMedia, mode);
      saveState(sourceId, selectedMedia, mode, state);
    }

    if (state.visitedStarts.includes(currentStart)) {
      const nextPageUrl = getNextPageUrl(state.runId, selectedMedia, mode, format, sourceId);
      if (nextPageUrl) {
        setOverlayStatus(`检测到当前页已处理过，准备跳到下一页...\n当前 start=${currentStart}`);
        location.href = nextPageUrl;
        return;
      }
      await exportAll(sourceId, selectedMedia, mode, state, format);
      return;
    }

    setOverlayStatus(
      `正在抓取列表页...\n` +
      `来源：${sourceId}\n` +
      `类型：${selectedMedia}\n` +
      `状态：${mode}\n` +
      `当前 start=${currentStart}`,
    );

    const pageItems = parseCurrentPageItems(selectedMedia, mode);

    if (!pageItems.length) {
      if (Array.isArray(state.items) && state.items.length > 0) {
        setOverlayStatus(
          `当前页未识别到条目，但前面已累计 ${state.items.length} 条。\n` +
          `停止继续翻页，直接导出已有数据。`,
        );
        await exportAll(sourceId, selectedMedia, mode, state, format);
        return;
      }
      setOverlayStatus(
        `当前页没有识别到条目，已停止导出。\n` +
        `来源：${sourceId}\n类型：${selectedMedia}\n状态：${mode}\nstart=${currentStart}`,
      );
      alert(`未识别到当前页条目：${selectedMedia}/${mode}/start=${currentStart}。已停止继续翻页。`);
      clearState(sourceId, selectedMedia, mode);
      return;
    }

    const enrichedItems = await enrichItemsSequentially(pageItems);
    state.visitedStarts.push(currentStart);
    mergeItemsIntoState(state, enrichedItems);
    saveState(sourceId, selectedMedia, mode, state);

    const nextPageUrl = getNextPageUrl(state.runId, selectedMedia, mode, format, sourceId);
    if (nextPageUrl) {
      setOverlayStatus(
        `当前页完成。\n` +
        `已累计条目：${state.items.length}\n` +
        `准备跳转下一页...`,
      );
      location.href = nextPageUrl;
      return;
    }

    await exportAll(sourceId, selectedMedia, mode, state, format);
  }

  if (isHomepage()) injectHomepageLinks();
  if (isDoulistPage() && !isExportMode()) injectDoulistLinks();

  if (isSupportedExportPage() && isExportMode()) {
    runExport().catch((error) => {
      console.error('[豆瓣书影音目录导出] 运行失败：', error);
      setOverlayStatus(`运行失败：\n${String(error?.message || error)}`);
      alert('脚本运行失败，请打开控制台查看错误');
    });
  }
})();
