// ==UserScript==
// @name         豆瓣读书商品导入版（支持读过/想读/豆列，保留完整出版年）
// @namespace    https://chat.openai.com/
// @version      1.4.0
// @description  从豆瓣读过/想读/豆列抓取图书详情，导出可用于图书管理系统导入的 ProductModel JSON 和表单对齐 CSV；修复豆列详情补抓并保留完整出版年文本
// @author       OpenAI
// @match        https://book.douban.com/people/*/collect*
// @match        https://book.douban.com/people/*/wish*
// @match        https://www.douban.com/people/*
// @match        https://www.douban.com/doulist/*
// @require      https://cdn.jsdelivr.net/gh/zh-lx/pinyin-pro@latest/dist/pinyin-pro.js
// @grant        GM_xmlhttpRequest
// @connect      book.douban.com
// @connect      www.douban.com
// ==/UserScript==

(function () {
  'use strict';

  const EXPORT_FLAG = 'export_product_import=1';
  const STORAGE_PREFIX = 'douban_book_product_import';
  const RATE_LIMIT_MS = 900;
  const RETRY_TIMES = 2;
  const REQUEST_TIMEOUT_MS = 20000;
  const DEFAULT_OPERATOR = 'douban-import-script';
  const DEFAULT_STOCK_UNIT = '册';
  const DEFAULT_OPTION = '不区分';
  const DOWNLOAD_URL_KEEP_MS = 5 * 60 * 1000;

  const EXPORT_FORMATS = {
    JSON: 'json',
    CSV: 'csv',
    BOTH: 'both',
  };

  const SOURCE_TYPES = {
    PEOPLE: 'people',
    DOULIST: 'doulist',
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

  function isBookListPage() {
    return (
      location.hostname === 'book.douban.com' &&
      /^\/people\/[^/]+\/(collect|wish)/.test(location.pathname)
    );
  }

  function isDoulistPage() {
    return location.hostname === 'www.douban.com' && /^\/doulist\/\d+/.test(location.pathname);
  }

  function isExportMode() {
    return new URLSearchParams(location.search).get('export_product_import') === '1';
  }

  function isWishMode() {
    return location.pathname.includes('/wish');
  }

  function getPeopleIdFromUrl() {
    const match = location.pathname.match(/\/people\/([^/]+)\//);
    return match ? match[1] : '';
  }

  function getDoulistIdFromUrl() {
    const match = location.pathname.match(/\/doulist\/(\d+)/);
    return match ? match[1] : '';
  }

  function getCurrentStart() {
    const params = new URLSearchParams(location.search);
    return Number(params.get('start') || '0');
  }

  function getExportFormatFromUrl() {
    const format = new URLSearchParams(location.search).get('format');
    if (
      format === EXPORT_FORMATS.JSON ||
      format === EXPORT_FORMATS.CSV ||
      format === EXPORT_FORMATS.BOTH
    ) {
      return format;
    }
    return EXPORT_FORMATS.BOTH;
  }

  function getSourceType() {
    return isDoulistPage() ? SOURCE_TYPES.DOULIST : SOURCE_TYPES.PEOPLE;
  }

  function getSourceId() {
    return getSourceType() === SOURCE_TYPES.DOULIST
      ? getDoulistIdFromUrl()
      : getPeopleIdFromUrl();
  }

  function getSourceMode() {
    if (getSourceType() === SOURCE_TYPES.DOULIST) {
      return 'doulist';
    }
    return isWishMode() ? 'wish' : 'collect';
  }

  function extractSubjectId(link) {
    const match = String(link || '').match(/subject\/(\d+)\//);
    return match ? match[1] : '';
  }

  function isBookSubjectUrl(url) {
    return /https?:\/\/book\.douban\.com\/subject\/\d+\/?/.test(String(url || ''));
  }

  function buildPeopleExportUrl(people, isWish, format) {
    const mode = isWish ? 'wish' : 'collect';
    return `https://book.douban.com/people/${people}/${mode}?start=0&sort=time&rating=all&filter=all&mode=list&${EXPORT_FLAG}&format=${encodeURIComponent(format)}`;
  }

  function buildDoulistExportUrl(format) {
    const url = new URL(location.href);
    url.searchParams.set('start', '0');
    url.searchParams.set('export_product_import', '1');
    url.searchParams.set('format', format);
    return url.toString();
  }

  function registerObjectUrl(url) {
    ACTIVE_OBJECT_URLS.push(url);
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch (_) {}
      const index = ACTIVE_OBJECT_URLS.indexOf(url);
      if (index >= 0) {
        ACTIVE_OBJECT_URLS.splice(index, 1);
      }
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
    let panel = document.getElementById('douban-book-product-import-panel');
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = 'douban-book-product-import-panel';
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
      'width:300px',
      'font-size:13px',
      'line-height:1.5',
      'color:#333',
    ].join(';');

    document.body.appendChild(panel);
    return panel;
  }

  function injectLauncherPanel() {
    const sourceType = getSourceType();
    const panel = createFloatingPanel();

    if (sourceType === SOURCE_TYPES.DOULIST) {
      const doulistId = getDoulistIdFromUrl();
      panel.innerHTML = `
        <div style="font-weight:700;margin-bottom:8px;">豆瓣读书商品导入版</div>
        <div style="color:#666;margin-bottom:10px;">
          当前页面识别为书单 / 豆列页面。脚本会导出其中图书条目，并强制抓取详情页补齐作者、ISBN、定价、出版年等字段。
          <br><br>当前豆列 ID：${doulistId || '-'}
        </div>

        <label style="display:block;margin-bottom:6px;font-weight:600;">导出格式</label>
        <select id="douban-export-format-select"
                style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;margin-bottom:12px;">
          <option value="json">只导出 JSON</option>
          <option value="csv">只导出 CSV</option>
          <option value="both" selected>导出 JSON + CSV</option>
        </select>

        <div style="display:flex;flex-direction:column;gap:8px;">
          <button id="douban-export-doulist-btn"
                  style="border:none;background:#7b61ff;color:#fff;padding:8px 10px;border-radius:6px;cursor:pointer;">
            导出当前书单为导入文件
          </button>
        </div>
      `;

      const select = qs('#douban-export-format-select', panel);
      const btn = qs('#douban-export-doulist-btn', panel);
      btn?.addEventListener('click', () => {
        const format = select?.value || EXPORT_FORMATS.BOTH;
        location.href = buildDoulistExportUrl(format);
      });
      return;
    }

    const people = getPeopleIdFromUrl();
    if (!people) return;

    panel.innerHTML = `
      <div style="font-weight:700;margin-bottom:8px;">豆瓣读书商品导入版</div>
      <div style="color:#666;margin-bottom:10px;">
        自动抓取 ISBN、出版社、定价、装帧、出版年等字段，并导出为适合导入图书管理系统的文件
      </div>

      <label style="display:block;margin-bottom:6px;font-weight:600;">导出格式</label>
      <select id="douban-export-format-select"
              style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;margin-bottom:12px;">
        <option value="json">只导出 JSON</option>
        <option value="csv">只导出 CSV</option>
        <option value="both" selected>导出 JSON + CSV</option>
      </select>

      <div style="display:flex;flex-direction:column;gap:8px;">
        <button id="douban-export-collect-btn"
                style="border:none;background:#42bd56;color:#fff;padding:8px 10px;border-radius:6px;cursor:pointer;">
          导出读过图书为导入文件
        </button>
        <button id="douban-export-wish-btn"
                style="border:none;background:#2d8cf0;color:#fff;padding:8px 10px;border-radius:6px;cursor:pointer;">
          导出想读图书为导入文件
        </button>
      </div>
    `;

    const select = qs('#douban-export-format-select', panel);
    const collectBtn = qs('#douban-export-collect-btn', panel);
    const wishBtn = qs('#douban-export-wish-btn', panel);

    collectBtn?.addEventListener('click', () => {
      const format = select?.value || EXPORT_FORMATS.BOTH;
      location.href = buildPeopleExportUrl(people, false, format);
    });

    wishBtn?.addEventListener('click', () => {
      const format = select?.value || EXPORT_FORMATS.BOTH;
      location.href = buildPeopleExportUrl(people, true, format);
    });
  }

  function ensureOverlay() {
    let overlay = document.getElementById('douban-book-product-import-overlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'douban-book-product-import-overlay';
    overlay.style.cssText = [
      'position:fixed',
      'right:20px',
      'bottom:20px',
      'z-index:1000000',
      'width:380px',
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
      <div style="font-weight:700;margin-bottom:8px;">豆瓣读书商品导入版</div>
      <div id="douban-book-product-import-status" style="white-space:pre-wrap;color:#444;"></div>
      <div id="douban-book-product-import-actions" style="margin-top:10px;"></div>
    `;

    document.body.appendChild(overlay);
    return overlay;
  }

  function setOverlayStatus(message) {
    const overlay = ensureOverlay();
    const statusEl = qs('#douban-book-product-import-status', overlay);
    if (statusEl) {
      statusEl.textContent = message;
    }
  }

  function setOverlayActions(html) {
    const overlay = ensureOverlay();
    const actionsEl = qs('#douban-book-product-import-actions', overlay);
    if (actionsEl) {
      actionsEl.innerHTML = html;
    }
  }

  function getStorageKey(sourceType, sourceId, sourceMode) {
    return `${STORAGE_PREFIX}:${sourceType}:${sourceId}:${sourceMode}`;
  }

  function loadState(sourceType, sourceId, sourceMode) {
    const raw = sessionStorage.getItem(getStorageKey(sourceType, sourceId, sourceMode));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (error) {
      console.error('[豆瓣商品导入版] 读取状态失败：', error);
      return null;
    }
  }

  function saveState(sourceType, sourceId, sourceMode, state) {
    sessionStorage.setItem(
      getStorageKey(sourceType, sourceId, sourceMode),
      JSON.stringify(state)
    );
  }

  function clearState(sourceType, sourceId, sourceMode) {
    sessionStorage.removeItem(getStorageKey(sourceType, sourceId, sourceMode));
  }

  function createNewState(sourceType, sourceId, sourceMode) {
    return {
      runId: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      sourceType,
      sourceId,
      sourceMode,
      createdAt: new Date().toISOString(),
      items: [],
      visitedStarts: [],
    };
  }

  function buildEmptyItem(overrides = {}) {
    return Object.assign(
      {
        title: '',
        link: '',
        subject_id: '',
        rating: '',
        rating_date: '',
        comment: '',
        release_date: '',
        author: '',
        publisher: '',
        publish_year: '',
        price: '',
        price_value: '',
        price_currency: '',
        binding: '',
        pages: '',
        isbn: '',
        translator: '',
        subtitle: '',
        original_title: '',
        series: '',
        edition: '',
        fetch_status: 'pending',
        fetch_error: '',
      },
      overrides
    );
  }

  function parsePeoplePageItems(isWish) {
    const items = [];
    const listItems = qsa('li.item');

    listItems.forEach((li) => {
      const titleAnchor =
        qs('.title a', li) ||
        qs('h2 a', li) ||
        qs('a[href*="/subject/"]', li);

      if (!titleAnchor) return;

      const link = new URL(titleAnchor.getAttribute('href'), location.href).href;
      const subjectId = extractSubjectId(link);
      if (!subjectId) return;

      const item = buildEmptyItem({
        title: normalizeText(titleAnchor.textContent),
        link,
        subject_id: subjectId,
      });

      if (!isWish) {
        const dateEl = qs('.date', li);
        if (dateEl) {
          const dateClone = dateEl.cloneNode(true);
          const ratingSpan = qs('span', dateClone);
          if (ratingSpan) {
            const className = ratingSpan.getAttribute('class') || '';
            const ratingMatch = className.match(/rating(\d)-t/);
            item.rating = ratingMatch ? ratingMatch[1] : '';
            ratingSpan.remove();
          }
          item.rating_date = normalizeText(dateClone.textContent).replaceAll('-', '/');
        }

        const commentEl = qs('.comment', li);
        if (commentEl) {
          item.comment = normalizeText(commentEl.textContent);
        }
      }

      const introText = normalizeText((qs('.intro', li) || {}).textContent || '');
      if (introText) {
        const introParts = introText.split(' / ').map(normalizeText).filter(Boolean);
        const dateReg = /\d{4}(?:-\d{1,2})?(?:-\d{1,2})?/;

        if (introParts.length && !dateReg.test(introParts[0])) {
          item.author = introParts[0];
        }

        const datePart = introParts.find((part) => dateReg.test(part));
        if (datePart) {
          item.release_date = datePart.replaceAll('-', '/');
        }
      }

      items.push(item);
    });

    return items;
  }

  function parseDoulistPageItems() {
    const items = [];
    const seen = new Set();
    const anchors = qsa('a[href*="book.douban.com/subject/"], a[href*="/subject/"]');

    anchors.forEach((anchor) => {
      const href = anchor.getAttribute('href');
      if (!href) return;

      const link = new URL(href, location.href).href;
      if (!isBookSubjectUrl(link)) return;

      const subjectId = extractSubjectId(link);
      if (!subjectId || seen.has(subjectId)) return;

      const rawTitle = normalizeText(anchor.textContent);
      seen.add(subjectId);

      items.push(
        buildEmptyItem({
          title: rawTitle,
          link,
          subject_id: subjectId,
        })
      );
    });

    return items;
  }

  function parsePriceInfo(priceText) {
    const result = {
      price: priceText || '',
      price_value: '',
      price_currency: '',
    };

    if (!priceText) return result;

    const numMatch = priceText.match(/(\d+(?:\.\d+)?)/);
    result.price_value = numMatch ? numMatch[1] : '';

    if (/元|人民币|RMB|CNY/i.test(priceText)) {
      result.price_currency = 'CNY';
    } else if (/USD|\$|美元/i.test(priceText)) {
      result.price_currency = 'USD';
    } else if (/EUR|€|欧元/i.test(priceText)) {
      result.price_currency = 'EUR';
    } else if (/GBP|£|英镑/i.test(priceText)) {
      result.price_currency = 'GBP';
    } else if (/JPY|日元|円|¥/i.test(priceText)) {
      result.price_currency = 'JPY';
    }

    return result;
  }

  function parseInfoBlock(doc, fallbackTitle = '') {
    const infoEl = qs('#info', doc);
    const result = {
      title: '',
      author: '',
      publisher: '',
      publish_year: '',
      price: '',
      price_value: '',
      price_currency: '',
      binding: '',
      pages: '',
      isbn: '',
      translator: '',
      subtitle: '',
      original_title: '',
      series: '',
      edition: '',
    };

    const titleEl = qs('#wrapper h1 span', doc) || qs('h1 span', doc) || qs('h1', doc);
    result.title = normalizeText(titleEl?.textContent || fallbackTitle || '');

    if (!infoEl) return result;

    const infoMap = {};
    let currentLabel = '';
    let currentParts = [];

    function flush() {
      if (currentLabel) {
        infoMap[currentLabel] = normalizeText(currentParts.join(' '));
      }
      currentLabel = '';
      currentParts = [];
    }

    Array.from(infoEl.childNodes).forEach((node) => {
      if (
        node.nodeType === 1 &&
        node.tagName === 'SPAN' &&
        node.classList.contains('pl')
      ) {
        flush();
        currentLabel = normalizeText(node.textContent).replace(/[：:]\s*$/, '');
      } else if (node.nodeType === 1 && node.tagName === 'BR') {
        flush();
      } else if (currentLabel) {
        const txt = normalizeText(node.textContent || '');
        if (txt) currentParts.push(txt);
      }
    });

    flush();

    result.author = infoMap['作者'] || '';
    result.publisher = infoMap['出版社'] || '';
    result.subtitle = infoMap['副标题'] || '';
    result.original_title = infoMap['原作名'] || '';
    result.publish_year = infoMap['出版年'] || '';
    result.binding = infoMap['装帧'] || '';
    result.pages = infoMap['页数'] || '';
    result.isbn = infoMap['ISBN'] || '';
    result.translator = infoMap['译者'] || '';
    result.series = infoMap['丛书'] || '';
    result.edition = infoMap['版次'] || '';

    const priceInfo = parsePriceInfo(infoMap['定价'] || '');
    result.price = priceInfo.price;
    result.price_value = priceInfo.price_value;
    result.price_currency = priceInfo.price_currency;

    return result;
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
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
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

  async function enrichBookItem(item) {
    try {
      const html = await fetchWithRetry(item.link);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const detail = parseInfoBlock(doc, item.title);

      return {
        ...item,
        ...detail,
        title: detail.title || item.title,
        author: detail.author || item.author,
        fetch_status: 'ok',
        fetch_error: '',
      };
    } catch (error) {
      return {
        ...item,
        fetch_status: 'failed',
        fetch_error: String(error?.message || error || 'unknown error'),
      };
    }
  }

  async function enrichItemsSequentially(items) {
    const enriched = [];

    for (let i = 0; i < items.length; i++) {
      const current = items[i];
      setOverlayStatus(
        `正在抓取详情页...\n` +
          `当前页进度：${i + 1}/${items.length}\n` +
          `书名：${current.title || current.subject_id}`
      );

      const detailItem = await enrichBookItem(current);
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
      if (anchor && anchor.getAttribute('href')) {
        return anchor.getAttribute('href');
      }
    }

    return '';
  }

  function buildNextPageUrl(nextHref, runId, format) {
    const nextUrl = new URL(nextHref, location.href);
    nextUrl.searchParams.set('export_product_import', '1');
    nextUrl.searchParams.set('run_id', runId);
    nextUrl.searchParams.set('format', format);
    return nextUrl.toString();
  }

  function getNextPageUrl(runId, format) {
    const nextHref = getRawNextPageHref();
    if (!nextHref) return '';
    return buildNextPageUrl(nextHref, runId, format);
  }

  function mergeItemsIntoState(state, newItems) {
    const existingKeys = new Set(
      state.items.map((item) => `${item.subject_id}__${item.title}`)
    );

    newItems.forEach((item) => {
      const key = `${item.subject_id}__${item.title}`;
      if (!existingKeys.has(key)) {
        state.items.push(item);
        existingKeys.add(key);
      }
    });
  }

  function safePinyinInitial(char) {
    try {
      if (
        typeof pinyinPro !== 'undefined' &&
        pinyinPro &&
        typeof pinyinPro.pinyin === 'function'
      ) {
        const result = pinyinPro.pinyin(char, {
          pattern: 'first',
          toneType: 'none',
          type: 'array',
        });
        if (Array.isArray(result) && result.length) {
          return String(result[0] || '').toLowerCase();
        }
        if (typeof result === 'string') {
          return result.toLowerCase();
        }
      }
    } catch (error) {
      console.warn('[豆瓣商品导入版] 拼音转换失败：', error);
    }
    return '';
  }

  function isChineseChar(char) {
    return /[\u3400-\u9fff]/.test(char);
  }

  function normalizeAsciiSegment(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/['"`’‘]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function buildBaseSelfEncoding(title, subjectId) {
    const text = normalizeText(title);
    if (!text) return `book-${subjectId || 'unknown'}`;

    let output = '';
    let buffer = '';

    function flushBuffer() {
      if (!buffer) return;
      const normalized = normalizeAsciiSegment(buffer);
      if (normalized) {
        if (output && !output.endsWith('-')) output += '-';
        output += normalized;
      }
      buffer = '';
    }

    for (const char of text) {
      if (isChineseChar(char)) {
        flushBuffer();
        const initial = safePinyinInitial(char);
        if (initial) output += initial;
      } else if (/[A-Za-z0-9]/.test(char)) {
        buffer += char;
      } else {
        flushBuffer();
        if (output && !output.endsWith('-')) output += '-';
      }
    }

    flushBuffer();

    output = output
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();

    return output || `book-${subjectId || 'unknown'}`;
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

  function normalizePublicationText(raw) {
    const text = normalizeText(raw);
    return text || null;
  }

  function parsePriceNumber(raw) {
    const match = String(raw || '').match(/(\d+(?:\.\d+)?)/);
    return match ? Number(match[1]) : 0;
  }

  function dedupeRecords(items) {
    const seen = new Set();
    const result = [];

    items.forEach((item) => {
      const isbn = normalizeText(item.isbn);
      const subjectId = normalizeText(item.subject_id);
      const title = normalizeText(item.title).toLowerCase();
      const author = normalizeText(item.author).toLowerCase();

      const key = isbn
        ? `isbn:${isbn}`
        : subjectId
        ? `subject:${subjectId}`
        : `title:${title}::author:${author}`;

      if (!seen.has(key)) {
        seen.add(key);
        result.push(item);
      }
    });

    return result;
  }

  function toProductImportObjects(items) {
    const deduped = dedupeRecords(items);
    const usedSelfEncodings = new Set();
    const usedProductIds = new Set();

    return deduped.map((item) => {
      const isbn = normalizeText(item.isbn) || null;
      const subjectId = normalizeText(item.subject_id);
      const parsedPrice = parsePriceNumber(item.price_value || item.price);
      const publicationYear = normalizePublicationText(
        item.publish_year || item.release_date
      );

      let productIdBase = isbn || `DB-${subjectId || 'UNKNOWN'}`;
      productIdBase = normalizeText(productIdBase);
      const productId = ensureUniqueSuffix(productIdBase, usedProductIds);

      const selfEncodingBase = buildBaseSelfEncoding(item.title, subjectId);
      const selfEncoding = ensureUniqueSuffix(selfEncodingBase, usedSelfEncodings);

      return {
        id: 0,
        productId,
        title: normalizeText(item.title),
        author: normalizeText(item.author),
        isbn,
        price: parsedPrice,
        category: DEFAULT_OPTION,
        categoryId: null,
        publisher: normalizeText(item.publisher) || DEFAULT_OPTION,
        publisherId: null,
        selfEncoding,
        internalPricing: null,
        purchasePrice: parsedPrice || null,
        publicationYear, // 保留豆瓣原始文本，如 2026-02 / 2026-02-01
        edition: normalizeText(item.edition) || null,
        binding: normalizeText(item.binding) || DEFAULT_OPTION,
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

  function createJsonDownload(fileName, data) {
    const jsonText = JSON.stringify(data);
    const url = createBlobUrl(jsonText, 'application/octet-stream');
    return { fileName, url, size: jsonText.length };
  }

  function createCsvDownload(fileName, rows, headers) {
    const utf8Bom = '\uFEFF';
    let csv = '';
    csv += headers.map((h) => h.label).join(',') + '\r\n';

    rows.forEach((row) => {
      const line = headers
        .map((h) => `"${String(row[h.key] ?? '').replace(/"/g, '""')}"`)
        .join(',');
      csv += line + '\r\n';
    });

    const url = createBlobUrl(utf8Bom + csv, 'text/csv;charset=utf-8;');
    return { fileName, url, size: csv.length };
  }

  function buildFormAlignedCsvRows(productItems) {
    return productItems.map((item) => ({
      title: item.title,
      productId: item.productId,
      author: item.author,
      price: item.price,
      selfEncoding: item.selfEncoding,
      operator: item.operator,
      isbn: item.isbn || '',
      category: item.category || '',
      publisher: item.publisher || '',
      publicationYear: item.publicationYear ?? '',
      purchaseSaleMode: item.purchaseSaleMode || '',
      packaging: item.packaging || '',
      binding: item.binding || '',
      property: item.property || '',
      statisticalClass: item.statisticalClass || '',
      internalPricing: item.internalPricing ?? '',
      purchasePrice: item.purchasePrice ?? '',
      retailDiscount: item.retailDiscount ?? '',
      memberDiscount: item.memberDiscount ?? '',
      wholesaleDiscount: item.wholesaleDiscount ?? '',
      wholesalePrice: item.wholesalePrice ?? '',
      stockUnit: item.stockUnit || '',
      stockLowerLimitQty: item.stockLowerLimitQty ?? '',
      stockUpperLimitQty: item.stockUpperLimitQty ?? '',
      edition: item.edition || '',
      bookmark: item.bookmark || '',
    }));
  }

  async function autoDownloadByFormat(format, jsonDownload, csvDownload) {
    if (format === EXPORT_FORMATS.JSON && jsonDownload) {
      triggerDownload(jsonDownload.url, jsonDownload.fileName);
      return;
    }

    if (format === EXPORT_FORMATS.CSV && csvDownload) {
      triggerDownload(csvDownload.url, csvDownload.fileName);
      return;
    }

    if (format === EXPORT_FORMATS.BOTH) {
      if (csvDownload) {
        triggerDownload(csvDownload.url, csvDownload.fileName);
      }
      await sleep(1500);
      if (jsonDownload) {
        triggerDownload(jsonDownload.url, jsonDownload.fileName);
      }
    }
  }

  function buildManualDownloadButtons(format, jsonDownload, csvDownload) {
    const parts = [];

    if ((format === EXPORT_FORMATS.JSON || format === EXPORT_FORMATS.BOTH) && jsonDownload) {
      parts.push(`
        <a href="${jsonDownload.url}" download="${jsonDownload.fileName}"
           style="display:inline-block;background:#42bd56;color:#fff;text-decoration:none;padding:8px 12px;border-radius:6px;text-align:center;">
          重新下载 JSON
        </a>
      `);
    }

    if ((format === EXPORT_FORMATS.CSV || format === EXPORT_FORMATS.BOTH) && csvDownload) {
      parts.push(`
        <a href="${csvDownload.url}" download="${csvDownload.fileName}"
           style="display:inline-block;background:#2d8cf0;color:#fff;text-decoration:none;padding:8px 12px;border-radius:6px;text-align:center;">
          重新下载 CSV
        </a>
      `);
    }

    if (format === EXPORT_FORMATS.BOTH && jsonDownload && csvDownload) {
      parts.unshift(`
        <button id="douban-redownload-both-btn"
                style="border:none;background:#111;color:#fff;padding:8px 12px;border-radius:6px;cursor:pointer;">
          重新下载两个文件
        </button>
      `);
    }

    return `<div style="display:flex;flex-direction:column;gap:8px;">${parts.join('')}</div>`;
  }

  function attachRedownloadBothListener(jsonDownload, csvDownload) {
    const btn = qs('#douban-redownload-both-btn');
    if (!btn) return;

    btn.addEventListener('click', async () => {
      if (csvDownload) {
        triggerDownload(csvDownload.url, csvDownload.fileName);
      }
      await sleep(1500);
      if (jsonDownload) {
        triggerDownload(jsonDownload.url, jsonDownload.fileName);
      }
    });
  }

  async function exportAll(sourceType, sourceId, sourceMode, state, format) {
    const productItems = toProductImportObjects(state.items);
    const csvRows = buildFormAlignedCsvRows(productItems);

    const datePart = new Date().toISOString().split('T')[0].replaceAll('-', '');
    const baseName =
      sourceType === SOURCE_TYPES.DOULIST
        ? `db-book-product-import-doulist-${sourceId}-${datePart}`
        : `db-book-product-import-${sourceMode === 'wish' ? 'wishlist-' : ''}${datePart}`;

    const jsonFileName = `${baseName}.json`;
    const csvFileName = `${baseName}.csv`;

    setOverlayStatus(
      `准备导出...\n` +
        `来源：${sourceType === SOURCE_TYPES.DOULIST ? `豆列 ${sourceId}` : sourceMode}\n` +
        `总条目数：${productItems.length}\n` +
        `导出格式：${format}`
    );

    if (!productItems.length) {
      alert('没有可导出的商品数据');
      clearState(sourceType, sourceId, sourceMode);
      return;
    }

    const csvHeaders = [
      { key: 'title', label: '书名' },
      { key: 'productId', label: '商品编码' },
      { key: 'author', label: '作者' },
      { key: 'price', label: '售价' },
      { key: 'selfEncoding', label: '自编码' },
      { key: 'operator', label: '操作人员' },
      { key: 'isbn', label: 'ISBN' },
      { key: 'category', label: '商品类别' },
      { key: 'publisher', label: '出版社' },
      { key: 'publicationYear', label: '出版年' },
      { key: 'purchaseSaleMode', label: '购销方式' },
      { key: 'packaging', label: '包装' },
      { key: 'binding', label: '装帧' },
      { key: 'property', label: '商品属性' },
      { key: 'statisticalClass', label: '统计分类' },
      { key: 'internalPricing', label: '内部定价' },
      { key: 'purchasePrice', label: '进货价' },
      { key: 'retailDiscount', label: '零售折扣' },
      { key: 'memberDiscount', label: '会员折扣' },
      { key: 'wholesaleDiscount', label: '批发折扣' },
      { key: 'wholesalePrice', label: '批发价' },
      { key: 'stockUnit', label: '库存单位' },
      { key: 'stockLowerLimitQty', label: '库存下限' },
      { key: 'stockUpperLimitQty', label: '库存上限' },
      { key: 'edition', label: '版次' },
      { key: 'bookmark', label: '书标' },
    ];

    let jsonDownload = null;
    let csvDownload = null;

    if (format === EXPORT_FORMATS.JSON || format === EXPORT_FORMATS.BOTH) {
      jsonDownload = createJsonDownload(jsonFileName, productItems);
    }

    if (format === EXPORT_FORMATS.CSV || format === EXPORT_FORMATS.BOTH) {
      csvDownload = createCsvDownload(csvFileName, csvRows, csvHeaders);
    }

    await autoDownloadByFormat(format, jsonDownload, csvDownload);

    const actionHtml = buildManualDownloadButtons(format, jsonDownload, csvDownload);
    setOverlayActions(actionHtml);
    attachRedownloadBothListener(jsonDownload, csvDownload);

    setOverlayStatus(
      `导出完成。\n` +
        `来源：${sourceType === SOURCE_TYPES.DOULIST ? `豆列 ${sourceId}` : sourceMode}\n` +
        `格式：${format}\n` +
        `条目数：${productItems.length}\n` +
        `${jsonDownload ? `JSON：${jsonFileName}\n` : ''}` +
        `${csvDownload ? `CSV：${csvFileName}\n` : ''}` +
        `如果没有自动下载，请点下面的按钮。`
    );

    clearState(sourceType, sourceId, sourceMode);
  }

  async function runExport() {
    const sourceType = getSourceType();
    const sourceId = getSourceId();
    const sourceMode = getSourceMode();
    const currentStart = getCurrentStart();
    const format = getExportFormatFromUrl();

    if (!sourceId) {
      alert('无法识别当前页面来源 ID');
      return;
    }

    let state = loadState(sourceType, sourceId, sourceMode);

    if (currentStart === 0 || !state) {
      state = createNewState(sourceType, sourceId, sourceMode);
      saveState(sourceType, sourceId, sourceMode, state);
    }

    if (!Array.isArray(state.visitedStarts) || !Array.isArray(state.items)) {
      state = createNewState(sourceType, sourceId, sourceMode);
      saveState(sourceType, sourceId, sourceMode, state);
    }

    if (state.visitedStarts.includes(currentStart)) {
      const nextPageUrl = getNextPageUrl(state.runId, format);
      if (nextPageUrl) {
        setOverlayStatus(
          `检测到当前页已处理过，准备跳到下一页...\n当前 start=${currentStart}`
        );
        location.href = nextPageUrl;
        return;
      }

      await exportAll(sourceType, sourceId, sourceMode, state, format);
      return;
    }

    setOverlayStatus(
      `正在抓取列表页...\n` +
        `来源：${sourceType === SOURCE_TYPES.DOULIST ? `豆列 ${sourceId}` : sourceMode}\n` +
        `当前 start=${currentStart}\n` +
        `导出格式：${format}`
    );

    const pageItems =
      sourceType === SOURCE_TYPES.DOULIST
        ? parseDoulistPageItems()
        : parsePeoplePageItems(sourceMode === 'wish');

    if (!pageItems.length) {
      console.warn('[豆瓣商品导入版] 当前页没有识别到图书条目');
      const nextPageUrl = getNextPageUrl(state.runId, format);
      if (nextPageUrl) {
        location.href = nextPageUrl;
        return;
      }
      await exportAll(sourceType, sourceId, sourceMode, state, format);
      return;
    }

    const enrichedItems = await enrichItemsSequentially(pageItems);

    state.visitedStarts.push(currentStart);
    mergeItemsIntoState(state, enrichedItems);
    saveState(sourceType, sourceId, sourceMode, state);

    const nextPageUrl = getNextPageUrl(state.runId, format);
    if (nextPageUrl) {
      setOverlayStatus(
        `当前页完成。\n` +
          `已累计条目：${state.items.length}\n` +
          `准备跳转下一页...`
      );
      location.href = nextPageUrl;
      return;
    }

    await exportAll(sourceType, sourceId, sourceMode, state, format);
  }

  if (isHomepage() || isDoulistPage() || (isBookListPage() && !isExportMode())) {
    injectLauncherPanel();
  }

  if ((isBookListPage() || isDoulistPage()) && isExportMode()) {
    runExport().catch((error) => {
      console.error('[豆瓣商品导入版] 运行失败：', error);
      setOverlayStatus(`运行失败：\n${String(error?.message || error)}`);
      alert('脚本运行失败，请打开控制台查看错误');
    });
  }
})();
