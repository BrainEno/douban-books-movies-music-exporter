// ==UserScript==
// @name         豆瓣书影音目录导出（修复抓取 + Notion排序版）
// @namespace    https://chat.openai.com/
// @version      1.1.0
// @description  批量导出豆瓣书籍、电影、音乐目录，生成通用 CSV、Notion CSV、JSON；修复当前页抓取失败，并按创作者/国家/年份排序
// @author       OpenAI
// @match        https://www.douban.com/people/*
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
  const RATE_LIMIT_MS = 800;
  const RETRY_TIMES = 2;
  const REQUEST_TIMEOUT_MS = 20000;
  const DOWNLOAD_URL_KEEP_MS = 5 * 60 * 1000;

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

  function isExportMode() {
    return new URLSearchParams(location.search).get(EXPORT_FLAG) === '1';
  }

  function getPeopleIdFromUrl() {
    const match = location.pathname.match(/\/people\/([^/]+)\//);
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
    return '';
  }

  function getListModeFromUrl() {
    return location.pathname.includes('/wish') ? 'wish' : 'collect';
  }

  function getExportPayloadFromUrl() {
    const params = new URLSearchParams(location.search);
    return {
      media: params.get('media') || getMediaTypeFromHost(),
      mode: params.get('mode') || getListModeFromUrl(),
      format: params.get('format') || 'all',
    };
  }

  function getStorageKey(people, media, mode) {
    return `${STORAGE_PREFIX}:${people}:${media}:${mode}`;
  }

  function loadState(people, media, mode) {
    const raw = sessionStorage.getItem(getStorageKey(people, media, mode));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (error) {
      console.error('[豆瓣目录导出] 读取状态失败：', error);
      return null;
    }
  }

  function saveState(people, media, mode, state) {
    sessionStorage.setItem(getStorageKey(people, media, mode), JSON.stringify(state));
  }

  function clearState(people, media, mode) {
    sessionStorage.removeItem(getStorageKey(people, media, mode));
  }

  function createNewState(people, media, mode) {
    return {
      runId: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      people,
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
      'width:320px',
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

  function buildExportLink(media, people, mode, format) {
    const host = MEDIA[media].host;
    const url = new URL(`https://${host}/people/${people}/${mode}`);
    url.searchParams.set('start', '0');
    url.searchParams.set('sort', 'time');
    url.searchParams.set('rating', 'all');
    url.searchParams.set('filter', 'all');
    url.searchParams.set('mode', 'list');
    url.searchParams.set(EXPORT_FLAG, '1');
    url.searchParams.set('media', media);
    url.searchParams.set('mode', mode);
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
        导出书籍、电影、音乐目录，自动翻页并补抓详情页。输出：
        <br>1. 通用表格 CSV
        <br>2. Notion 专用 CSV
        <br>3. JSON 备份
      </div>

      <label style="display:block;margin-bottom:6px;font-weight:600;">导出格式</label>
      <select id="douban-media-export-format"
              style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;margin-bottom:12px;">
        <option value="all" selected>全部导出（表格 CSV + Notion CSV + JSON）</option>
        <option value="spreadsheet">只导出表格 CSV</option>
        <option value="notion">只导出 Notion CSV</option>
        <option value="json">只导出 JSON</option>
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
        const format = select?.value || 'all';
        location.href = buildExportLink(media, people, mode, format);
      });
      buttonsWrap.appendChild(btn);
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
      countryOrRegion: '',
      dateText: '',
      year: '',
      publisherOrStudio: '',
      identifier: '',
      price: '',
      genre: '',
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

  function parseCurrentPageItems(media, mode) {
    const statusText =
      mode === 'collect' ? MEDIA[media].statusCollect : MEDIA[media].statusWish;
    const items = [];

    // 关键修复：不要只匹配 li.item
    const listItems = qsa('.grid-view .item, .article .item, .item');

    listItems.forEach((node) => {
      const titleAnchor =
        qs('.title a', node) ||
        qs('li.title a', node) ||
        qs('em a', node) ||
        qs('a[href*="/subject/"]', node);

      if (!titleAnchor) return;

      const href = titleAnchor.getAttribute('href');
      if (!href || !/subject\/\d+/.test(href)) return;

      const link = new URL(href, location.href).href;
      const subjectId = extractSubjectId(link);
      if (!subjectId) return;

      const title = normalizeText(titleAnchor.textContent);
      if (!title) return;

      const item = buildEmptyItem(media, mode, statusText, {
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

      const commentEl = qs('.comment', node);
      if (commentEl) {
        item.comment = normalizeText(commentEl.textContent);
      }

      const introEl = qs('.intro', node);
      if (introEl) {
        item.intro = normalizeText(introEl.textContent);
      }

      items.push(item);
    });

    // 去重
    const deduped = [];
    const seen = new Set();
    for (const item of items) {
      if (!seen.has(item.subjectId)) {
        seen.add(item.subjectId);
        deduped.push(item);
      }
    }

    return deduped;
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

  function extractInfoMap(doc) {
    const infoEl = qs('#info', doc);
    const infoMap = {};
    if (!infoEl) return infoMap;

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
    return infoMap;
  }

  function parseDetailByMedia(media, item, doc) {
    const infoMap = extractInfoMap(doc);
    const title =
      normalizeText(
        qs('#wrapper h1 span', doc)?.textContent ||
        qs('h1 span', doc)?.textContent ||
        qs('h1', doc)?.textContent ||
        item.title
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
        qs('.related_info .indent', doc)?.textContent
      ) || '';

    let creators = '';
    let countryOrRegion = '';
    let dateText = '';
    let year = '';
    let publisherOrStudio = '';
    let identifier = '';
    let price = '';
    let genre = '';

    if (media === 'book') {
      creators = infoMap['作者'] || item.intro || '';
      countryOrRegion = infoMap['原作名'] || '';
      dateText = infoMap['出版年'] || '';
      year = (dateText.match(/\d{4}/) || [''])[0];
      publisherOrStudio = infoMap['出版社'] || '';
      identifier = infoMap['ISBN'] || '';
      price = infoMap['定价'] || '';
      genre = '';
    }

    if (media === 'movie') {
      const genres = qsa('[property="v:genre"]', doc)
        .map((el) => normalizeText(el.textContent))
        .filter(Boolean);
      const releaseDates = qsa('[property="v:initialReleaseDate"]', doc)
        .map((el) => normalizeText(el.textContent))
        .filter(Boolean);
      const yearText =
        normalizeText(qs('#content h1 .year', doc)?.textContent).replace(/[()]/g, '') || '';

      creators = infoMap['导演'] || item.intro || '';
      countryOrRegion = infoMap['制片国家/地区'] || '';
      dateText = releaseDates.join(' / ') || yearText || '';
      year = (yearText.match(/\d{4}/) || [''])[0] || (dateText.match(/\d{4}/) || [''])[0];
      publisherOrStudio = countryOrRegion;
      identifier = infoMap['IMDb'] || '';
      price = '';
      genre = genres.join(' / ');
    }

    if (media === 'music') {
      creators = infoMap['表演者'] || infoMap['艺术家'] || item.intro || '';
      countryOrRegion = infoMap['介质'] || '';
      dateText = infoMap['发行时间'] || '';
      year = (dateText.match(/\d{4}/) || [''])[0];
      publisherOrStudio = infoMap['出版者'] || infoMap['厂牌'] || '';
      identifier = infoMap['条形码'] || infoMap['ISBN'] || '';
      price = infoMap['定价'] || '';
      genre = infoMap['流派'] || '';
    }

    return {
      ...item,
      title,
      cover,
      doubanRating,
      summary,
      creators: normalizeText(creators),
      countryOrRegion: normalizeText(countryOrRegion),
      dateText: normalizeText(dateText),
      year: normalizeText(year),
      publisherOrStudio: normalizeText(publisherOrStudio),
      identifier: normalizeText(identifier),
      price: normalizeText(price),
      genre: normalizeText(genre),
      rawInfo: infoMap,
      fetchStatus: 'ok',
      fetchError: '',
    };
  }

  async function enrichItem(media, item) {
    try {
      const html = await fetchWithRetry(item.link);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return parseDetailByMedia(media, item, doc);
    } catch (error) {
      return {
        ...item,
        fetchStatus: 'failed',
        fetchError: String(error?.message || error || 'unknown error'),
      };
    }
  }

  async function enrichItemsSequentially(media, items) {
    const enriched = [];

    for (let i = 0; i < items.length; i++) {
      const current = items[i];
      setOverlayStatus(
        `正在抓取详情页...\n` +
        `分类：${media}\n` +
        `当前页进度：${i + 1}/${items.length}\n` +
        `标题：${current.title || current.subjectId}`
      );

      const detailItem = await enrichItem(media, current);
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

  function buildNextPageUrl(nextHref, runId, media, mode, format) {
    const nextUrl = new URL(nextHref, location.href);
    nextUrl.searchParams.set(EXPORT_FLAG, '1');
    nextUrl.searchParams.set('run_id', runId);
    nextUrl.searchParams.set('media', media);
    nextUrl.searchParams.set('mode', mode);
    nextUrl.searchParams.set('format', format);
    return nextUrl.toString();
  }

  function getNextPageUrl(runId, media, mode, format) {
    const nextHref = getRawNextPageHref();
    if (!nextHref) return '';
    return buildNextPageUrl(nextHref, runId, media, mode, format);
  }

  function mergeItemsIntoState(state, newItems) {
    const existingKeys = new Set(state.items.map((item) => `${item.subjectId}`));

    newItems.forEach((item) => {
      const key = `${item.subjectId}`;
      if (!existingKeys.has(key)) {
        state.items.push(item);
        existingKeys.add(key);
      }
    });
  }

  function escapeCsvValue(value) {
    const normalized = String(value ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    const escaped = normalized.replaceAll('"', '""');
    const shouldQuote =
      escaped.includes(',') ||
      escaped.includes('"') ||
      escaped.includes('\n');
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
      const creatorCompare = normalizeSortText(a.creators).localeCompare(normalizeSortText(b.creators), 'zh');
      if (creatorCompare !== 0) return creatorCompare;

      const countryCompare = normalizeSortText(a.countryOrRegion).localeCompare(normalizeSortText(b.countryOrRegion), 'zh');
      if (countryCompare !== 0) return countryCompare;

      const yearCompare = normalizeSortYear(a.year) - normalizeSortYear(b.year);
      if (yearCompare !== 0) return yearCompare;

      return normalizeSortText(a.title).localeCompare(normalizeSortText(b.title), 'zh');
    });
  }

  function buildSpreadsheetRows(items) {
    return items.map((item) => ({
      mediaType: item.media,
      status: item.status,
      title: item.title,
      creators: item.creators,
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

  function buildHeadersForSpreadsheet() {
    return [
      { key: 'mediaType', label: '类型' },
      { key: 'status', label: '标记状态' },
      { key: 'title', label: '标题' },
      { key: 'creators', label: '创作者' },
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
  }

  function buildHeadersForNotion() {
    return [
      { key: 'Name', label: 'Name' },
      { key: 'Media Type', label: 'Media Type' },
      { key: 'Status', label: 'Status' },
      { key: 'Creator', label: 'Creator' },
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
  }

  function createDownloads(items, media, mode) {
    const sortedItems = sortItemsForArchive(items);
    const datePart = new Date().toISOString().split('T')[0].replaceAll('-', '');
    const base = `douban-${media}-${mode}-${datePart}`;

    const spreadsheetRows = buildSpreadsheetRows(sortedItems);
    const notionRows = buildNotionRows(sortedItems);

    const spreadsheetCsv = createCsvText(spreadsheetRows, buildHeadersForSpreadsheet());
    const notionCsv = createCsvText(notionRows, buildHeadersForNotion());
    const jsonText = JSON.stringify(sortedItems, null, 2);

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
        url: createBlobUrl(jsonText, 'application/json;charset=utf-8;'),
      },
    };
  }

  async function exportAll(people, media, mode, state, format) {
    const items = state.items;

    setOverlayStatus(
      `准备导出...\n` +
      `用户：${people}\n` +
      `类型：${media}\n` +
      `状态：${mode}\n` +
      `总条目数：${items.length}`
    );

    if (!items.length) {
      alert('当前页条目未被识别。通常是豆瓣页面结构与脚本选择器不一致。现在这版已放宽选择器，请重新从第一页导出一次。');
      clearState(people, media, mode);
      return;
    }

    const downloads = createDownloads(items, media, mode);

    if (format === 'spreadsheet' || format === 'all') {
      triggerDownload(downloads.spreadsheet.url, downloads.spreadsheet.fileName);
      await sleep(1200);
    }

    if (format === 'notion' || format === 'all') {
      triggerDownload(downloads.notion.url, downloads.notion.fileName);
      await sleep(1200);
    }

    if (format === 'json' || format === 'all') {
      triggerDownload(downloads.json.url, downloads.json.fileName);
    }

    setOverlayStatus(
      `导出完成。\n` +
      `用户：${people}\n` +
      `类型：${media}\n` +
      `状态：${mode}\n` +
      `条目数：${items.length}\n` +
      `已按 创作者 / 国家地区 / 年份 / 标题 排序。`
    );

    setOverlayActions(`
      <div style="display:flex;flex-direction:column;gap:8px;">
        <a href="${downloads.spreadsheet.url}" download="${downloads.spreadsheet.fileName}"
           style="display:inline-block;background:#42bd56;color:#fff;text-decoration:none;padding:8px 12px;border-radius:6px;text-align:center;">
          重新下载表格 CSV
        </a>
        <a href="${downloads.notion.url}" download="${downloads.notion.fileName}"
           style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:8px 12px;border-radius:6px;text-align:center;">
          重新下载 Notion CSV
        </a>
        <a href="${downloads.json.url}" download="${downloads.json.fileName}"
           style="display:inline-block;background:#2d8cf0;color:#fff;text-decoration:none;padding:8px 12px;border-radius:6px;text-align:center;">
          重新下载 JSON
        </a>
      </div>
    `);

    clearState(people, media, mode);
  }

  async function runExport() {
    const people = getPeopleIdFromUrl();
    const currentStart = getCurrentStart();
    const payload = getExportPayloadFromUrl();
    const media = payload.media;
    const mode = payload.mode;
    const format = payload.format;

    if (!people || !media || !mode) {
      alert('无法识别当前导出上下文');
      return;
    }

    let state = loadState(people, media, mode);
    if (currentStart === 0 || !state) {
      state = createNewState(people, media, mode);
      saveState(people, media, mode, state);
    }

    if (!Array.isArray(state.visitedStarts) || !Array.isArray(state.items)) {
      state = createNewState(people, media, mode);
      saveState(people, media, mode, state);
    }

    if (state.visitedStarts.includes(currentStart)) {
      const nextPageUrl = getNextPageUrl(state.runId, media, mode, format);
      if (nextPageUrl) {
        setOverlayStatus(`检测到当前页已处理过，准备跳到下一页...\n当前 start=${currentStart}`);
        location.href = nextPageUrl;
        return;
      }
      await exportAll(people, media, mode, state, format);
      return;
    }

    setOverlayStatus(
      `正在抓取列表页...\n` +
      `用户：${people}\n` +
      `类型：${media}\n` +
      `状态：${mode}\n` +
      `当前 start=${currentStart}`
    );

    const pageItems = parseCurrentPageItems(media, mode);

    if (!pageItems.length) {
      setOverlayStatus(
        `当前页没有识别到条目。\n` +
        `类型：${media}\n状态：${mode}\nstart=${currentStart}\n` +
        `你可以先打开控制台查看页面里是否仍存在 .item 结构。`
      );

      const nextPageUrl = getNextPageUrl(state.runId, media, mode, format);
      if (nextPageUrl) {
        location.href = nextPageUrl;
        return;
      }
      await exportAll(people, media, mode, state, format);
      return;
    }

    const enrichedItems = await enrichItemsSequentially(media, pageItems);

    state.visitedStarts.push(currentStart);
    mergeItemsIntoState(state, enrichedItems);
    saveState(people, media, mode, state);

    const nextPageUrl = getNextPageUrl(state.runId, media, mode, format);
    if (nextPageUrl) {
      setOverlayStatus(
        `当前页完成。\n` +
        `已累计条目：${state.items.length}\n` +
        `准备跳转下一页...`
      );
      location.href = nextPageUrl;
      return;
    }

    await exportAll(people, media, mode, state, format);
  }

  if (isHomepage()) {
    injectHomepageLinks();
  }

  if (isMediaListPage() && isExportMode()) {
    runExport().catch((error) => {
      console.error('[豆瓣书影音目录导出] 运行失败：', error);
      setOverlayStatus(`运行失败：\n${String(error?.message || error)}`);
      alert('脚本运行失败，请打开控制台查看错误');
    });
  }
})();
