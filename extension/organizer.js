const SKIPPED = '__skipped__';
const DEFAULT_MODEL = 'claude-opus-5';

let store = { links: [] };
let queue = [];
let reviewIndex = 0;
let categories = [];
let settings = { apiKey: '', model: DEFAULT_MODEL, autoMode: false, newCategoryBehavior: 'ask', recategorizeAllOnScan: false };
let forceAIMode = false; // true while running "Re-categorize ALL open tabs"
let aiDisabledUntilRescan = false; // tripped by a persistent error (bad key / rate limit) mid-batch

let importedLinks = null; // null = load from current data; array = loaded from an imported Markdown file
let oneByOneQueue = null;
let oneByOneIndex = 0;
let oneByOneGroupMap = {};
let oneByOneWindowMap = {};
const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange', 'grey'];

// One-time migration from the pre-rename "linktron*" storage keys.
async function migrateLegacyKeys() {
  const old = await chrome.storage.local.get(['linktronLinks', 'linktronSettings', 'tabitrailLinks', 'tabitrailSettings']);
  const move = {};
  if (old.linktronLinks && !old.tabitrailLinks) move.tabitrailLinks = old.linktronLinks;
  if (old.linktronSettings && !old.tabitrailSettings) move.tabitrailSettings = old.linktronSettings;
  if (Object.keys(move).length) await chrome.storage.local.set(move);
  if (old.linktronLinks || old.linktronSettings) {
    await chrome.storage.local.remove(['linktronLinks', 'linktronSettings']);
  }
}

async function loadLinks() {
  await migrateLegacyKeys();
  const data = await chrome.storage.local.get('tabitrailLinks');
  return data.tabitrailLinks || { links: [] };
}

async function saveLinks(s) {
  await chrome.storage.local.set({ tabitrailLinks: s });
}

async function loadSettings() {
  await migrateLegacyKeys();
  const data = await chrome.storage.local.get('tabitrailSettings');
  return {
    apiKey: '',
    model: DEFAULT_MODEL,
    autoMode: false,
    newCategoryBehavior: 'ask',
    recategorizeAllOnScan: false,
    restoreWindows: true,
    ...(data.tabitrailSettings || {})
  };
}

async function saveSettings(s) {
  await chrome.storage.local.set({ tabitrailSettings: s });
}

function setStatus(text) {
  document.getElementById('status').textContent = text;
}

function recomputeCategories() {
  categories = [...new Set(store.links.filter((l) => l.category !== SKIPPED).map((l) => l.category))].sort((a, b) =>
    a.localeCompare(b)
  );
}

// Browser window ids change every session, so we save a stable label ("Window 1", or a name
// the user chose) per link instead. A currently open window keeps the label that most of its
// already-filed tabs have; windows with no match get the next free "Window N".
function assignWindowLabels(httpTabs) {
  const byWindow = new Map();
  for (const t of httpTabs) {
    if (!byWindow.has(t.windowId)) byWindow.set(t.windowId, []);
    byWindow.get(t.windowId).push(t);
  }
  const known = new Map(store.links.filter((l) => l.window).map((l) => [l.url, l.window]));
  const candidates = [];
  for (const [wid, ts] of byWindow) {
    const counts = {};
    for (const t of ts) {
      const lab = known.get(t.url);
      if (lab) counts[lab] = (counts[lab] || 0) + 1;
    }
    for (const [lab, n] of Object.entries(counts)) candidates.push({ wid, lab, n });
  }
  candidates.sort((a, b) => b.n - a.n);

  const labels = new Map();
  const used = new Set();
  for (const c of candidates) {
    if (labels.has(c.wid) || used.has(c.lab)) continue;
    labels.set(c.wid, c.lab);
    used.add(c.lab);
  }
  const taken = new Set(store.links.map((l) => l.window).filter(Boolean));
  let n = 1;
  for (const wid of byWindow.keys()) {
    if (labels.has(wid)) continue;
    while (taken.has(`Window ${n}`) || used.has(`Window ${n}`)) n++;
    labels.set(wid, `Window ${n}`);
    used.add(`Window ${n}`);
  }
  return labels;
}

// Most recent scan wins when an already-filed link has moved to a different window.
async function syncWindowLabels(httpTabs, labels) {
  const byUrl = new Map(store.links.map((l) => [l.url, l]));
  let changed = false;
  for (const tab of httpTabs) {
    const existing = byUrl.get(tab.url);
    const label = labels.get(tab.windowId);
    if (existing && existing.category !== SKIPPED && label && existing.window !== label) {
      existing.window = label;
      changed = true;
    }
  }
  if (changed) await saveLinks(store);
}

async function scan() {
  setStatus('Scanning open tabs...');
  aiDisabledUntilRescan = false;
  settings = await loadSettings();

  const tabs = await chrome.tabs.query({});
  const httpTabs = tabs.filter((t) => t.url && /^https?:\/\//i.test(t.url));
  const windowLabels = assignWindowLabels(httpTabs);
  await syncWindowLabels(httpTabs, windowLabels);

  if (settings.recategorizeAllOnScan && !settings.apiKey) {
    setStatus('"Also re-categorize already-filed tabs" is on, but no API key is set — add one under AI categorization settings. Scanning normally for now.');
  }

  if (settings.recategorizeAllOnScan && settings.apiKey) {
    forceAIMode = true;
    const byUrl = new Map(store.links.map((l) => [l.url, l]));
    queue = [];
    for (const tab of httpTabs) {
      const existing = byUrl.get(tab.url);
      if (existing && existing.category === SKIPPED) continue;
      queue.push({ id: tab.id, windowId: tab.windowId, windowLabel: windowLabels.get(tab.windowId), url: tab.url, title: tab.title || tab.url });
    }
    reviewIndex = 0;

    if (!queue.length) {
      setStatus('No open tabs to re-categorize (all are permanently skipped).');
      return;
    }
    setStatus(`Re-categorizing ${queue.length} open tab${queue.length === 1 ? '' : 's'} with AI...`);
    await renderReview();
    return;
  }

  forceAIMode = false;
  const existingUrls = new Set(store.links.map((l) => l.url));
  const groupCache = {};
  const newGrouped = [];
  const newUngrouped = [];

  for (const tab of httpTabs) {
    if (existingUrls.has(tab.url)) continue;

    let groupTitle = null;
    let groupColor = null;
    if (typeof tab.groupId === 'number' && tab.groupId !== -1) {
      if (!(tab.groupId in groupCache)) {
        try {
          groupCache[tab.groupId] = await chrome.tabGroups.get(tab.groupId);
        } catch (e) {
          groupCache[tab.groupId] = null;
        }
      }
      const g = groupCache[tab.groupId];
      if (g) {
        groupTitle = g.title && g.title.trim() ? g.title.trim() : null;
        groupColor = g.color || null;
      }
    }

    const category = groupTitle || (groupColor ? `Untitled group (${groupColor})` : null);
    if (category) {
      newGrouped.push({ url: tab.url, title: tab.title || tab.url, category, window: windowLabels.get(tab.windowId) });
    } else {
      newUngrouped.push({ id: tab.id, windowId: tab.windowId, windowLabel: windowLabels.get(tab.windowId), url: tab.url, title: tab.title || tab.url });
    }
  }

  if (newGrouped.length) {
    const now = new Date().toISOString();
    for (const g of newGrouped) {
      store.links.push({ url: g.url, title: g.title, category: g.category, summary: null, source: 'tab-group', window: g.window, addedAt: now });
    }
    await saveLinks(store);
    recomputeCategories();
    renderManage();
  }

  queue = newUngrouped;
  reviewIndex = 0;

  const parts = [];
  if (newGrouped.length) parts.push(`auto-filed ${newGrouped.length} tab${newGrouped.length === 1 ? '' : 's'} from tab groups`);
  if (newUngrouped.length) parts.push(`${newUngrouped.length} new ungrouped tab${newUngrouped.length === 1 ? '' : 's'} to review`);
  setStatus(parts.length ? parts.join('; ') + '.' : 'No new tabs found.');

  await renderReview();
}

// tab.summary: undefined = not fetched yet, null = fetched but none found, string = found
async function ensureSummary(tab) {
  if (tab.summary !== undefined) return tab.summary;
  const result = await getTabSummary(tab.id);
  if (!result) {
    tab.summary = null;
    return null;
  }
  const text = (result.description || (result.title && result.title !== tab.title ? result.title : '') || '')
    .replace(/\s+/g, ' ')
    .trim();
  tab.summary = text ? (text.length > 240 ? text.slice(0, 237) + '...' : text) : null;
  return tab.summary;
}

async function getTabSummary(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        function meta(name) {
          const el = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
          return el ? el.getAttribute('content') : null;
        }
        return { title: document.title || null, description: meta('og:description') || meta('description') || null };
      }
    });
    return result;
  } catch (e) {
    return null;
  }
}

async function loadSummaryFor(tab) {
  const summaryEl = document.getElementById('cardSummary');
  const summary = await ensureSummary(tab);
  if (queue[reviewIndex] !== tab) return; // user already moved on
  summaryEl.textContent = summary || '(no summary available)';
}

async function fileTab(tab, category, source) {
  const existing = store.links.find((l) => l.url === tab.url);
  if (existing) {
    existing.category = category;
    existing.title = tab.title || existing.title;
    existing.summary = tab.summary !== undefined ? tab.summary : existing.summary;
    existing.source = source;
    if (category !== SKIPPED && tab.windowLabel) existing.window = tab.windowLabel;
    existing.updatedAt = new Date().toISOString();
  } else {
    store.links.push({
      url: tab.url,
      title: tab.title,
      category,
      summary: tab.summary || null,
      source,
      window: category !== SKIPPED ? tab.windowLabel : undefined,
      addedAt: new Date().toISOString()
    });
  }
  if (category !== SKIPPED && !categories.includes(category)) {
    categories.push(category);
    categories.sort((a, b) => a.localeCompare(b));
  }
  await saveLinks(store);
  renderManage();
}

// Main driver: decides, per queued tab, whether to auto-classify with AI or show the manual card.
async function renderReview() {
  const section = document.getElementById('reviewSection');
  if (reviewIndex >= queue.length) {
    section.hidden = true;
    return;
  }

  const tab = queue[reviewIndex];
  settings = await loadSettings();

  if ((settings.autoMode || forceAIMode) && settings.apiKey && !aiDisabledUntilRescan) {
    section.hidden = true;
    setStatus(`${forceAIMode ? 'Re-categorizing' : 'Auto-categorizing'} with AI... ${reviewIndex + 1} / ${queue.length}`);
    await ensureSummary(tab);
    const result = await classifyWithAI(tab, categories);

    if (result.error) {
      const persistent = result.error === 'invalid API key' || result.error === 'rate limited, try again shortly';
      if (persistent) {
        aiDisabledUntilRescan = true;
        setStatus(`AI categorization stopped for the rest of this batch (${result.error}). Remaining tabs need manual review.`);
      } else {
        setStatus(`AI error on this tab (${result.error}). Showing it for manual review.`);
      }
      renderManualCard(tab);
      return;
    }
    if (result.isNew && settings.newCategoryBehavior !== 'auto') {
      renderManualCard(tab, result);
      return;
    }
    await fileTab(tab, result.category, 'ai');
    reviewIndex++;
    await renderReview();
    return;
  }

  renderManualCard(tab);
}

function renderManualCard(tab, aiSuggestion) {
  const section = document.getElementById('reviewSection');
  section.hidden = false;

  document.getElementById('progress').textContent = `${reviewIndex + 1} / ${queue.length}`;
  document.getElementById('cardTitle').textContent = tab.title;
  const link = document.getElementById('cardUrl');
  link.textContent = tab.url;
  link.href = tab.url;

  const summaryEl = document.getElementById('cardSummary');
  if (tab.summary === undefined) {
    summaryEl.textContent = 'Fetching summary...';
    loadSummaryFor(tab);
  } else {
    summaryEl.textContent = tab.summary || '(no summary available)';
  }

  const select = document.getElementById('categorySelect');
  select.innerHTML = '';
  for (const c of categories) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    select.appendChild(opt);
  }
  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = '+ New category...';
  select.appendChild(newOpt);

  const newInput = document.getElementById('newCategoryInput');
  const aiNote = document.getElementById('aiNote');

  if (aiSuggestion) {
    aiNote.hidden = false;
    aiNote.textContent = aiSuggestion.isNew
      ? `AI suggests a new category: "${aiSuggestion.category}"`
      : `AI suggests: "${aiSuggestion.category}"`;
    if (aiSuggestion.isNew) {
      select.value = '__new__';
      newInput.hidden = false;
      newInput.value = aiSuggestion.category;
    } else {
      select.value = aiSuggestion.category;
      newInput.hidden = true;
      newInput.value = '';
    }
  } else {
    aiNote.hidden = true;
    aiNote.textContent = '';
    select.selectedIndex = 0;
    newInput.hidden = categories.length > 0;
    newInput.value = '';
  }
}

async function suggestWithAI() {
  const tab = queue[reviewIndex];
  settings = await loadSettings();
  if (!settings.apiKey) {
    alert('Add your Anthropic API key under "AI categorization settings" first.');
    return;
  }
  const btn = document.getElementById('suggestBtn');
  btn.disabled = true;
  const aiNote = document.getElementById('aiNote');
  aiNote.hidden = false;
  aiNote.textContent = 'Asking AI...';

  await ensureSummary(tab);
  const result = await classifyWithAI(tab, categories);
  btn.disabled = false;

  if (result.error) {
    aiNote.textContent = `AI error: ${result.error}`;
    return;
  }
  renderManualCard(tab, result);
}

// Calls the Anthropic Messages API directly from the browser using the user's own key.
// Uses structured outputs (output_config.format) so the response is guaranteed valid JSON.
async function classifyWithAI(tab, existingCategories) {
  const schema = {
    type: 'object',
    properties: {
      category: { type: 'string' },
      isNew: { type: 'boolean' }
    },
    required: ['category', 'isNew'],
    additionalProperties: false
  };

  const system =
    'You are a categorization assistant for a personal browser-tab organizer. Given a webpage\'s title, URL, ' +
    'and summary, decide which category it belongs to. If it clearly fits one of the user\'s existing categories, ' +
    'return that exact category name with isNew set to false. If none of the existing categories fit well, ' +
    'propose a new short category name (Title Case, 1-3 words) and set isNew to true.';

  const userText =
    `Existing categories: ${existingCategories.length ? existingCategories.join(', ') : '(none yet — propose one)'}\n\n` +
    `Tab:\nTitle: ${tab.title}\nURL: ${tab.url}\nSummary: ${tab.summary || '(no summary available)'}`;

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: settings.model || DEFAULT_MODEL,
        max_tokens: 256,
        system,
        output_config: { format: { type: 'json_schema', schema } },
        messages: [{ role: 'user', content: userText }]
      })
    });
  } catch (e) {
    return { error: `network error (${e.message})` };
  }

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = (body && body.error && body.error.message) || '';
    } catch (e) {
      // ignore
    }
    if (res.status === 401) return { error: 'invalid API key' };
    if (res.status === 429) return { error: 'rate limited, try again shortly' };
    return { error: detail || `API error ${res.status}` };
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') return { error: 'model declined to classify this page' };

  const block = data.content && data.content[0];
  if (!block || block.type !== 'text') return { error: 'unexpected response format' };

  try {
    const parsed = JSON.parse(block.text);
    if (typeof parsed.category !== 'string' || !parsed.category.trim()) {
      return { error: 'empty category returned' };
    }
    return { category: parsed.category.trim(), isNew: !!parsed.isNew };
  } catch (e) {
    return { error: 'could not parse model response' };
  }
}

function currentCategoryChoice() {
  const select = document.getElementById('categorySelect');
  if (select.value === '__new__') {
    return document.getElementById('newCategoryInput').value.trim();
  }
  return select.value;
}

async function saveCurrent() {
  const tab = queue[reviewIndex];
  const category = currentCategoryChoice();
  if (!category) {
    alert('Enter a category name or pick an existing one.');
    return;
  }
  await fileTab(tab, category, 'manual');
  reviewIndex++;
  await renderReview();
}

async function skipPermanent() {
  const tab = queue[reviewIndex];
  await fileTab(tab, SKIPPED, 'manual');
  reviewIndex++;
  await renderReview();
}

async function skipTemp() {
  reviewIndex++;
  await renderReview();
}

async function openCurrentTab() {
  const tab = queue[reviewIndex];
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (e) {
    window.open(tab.url, '_blank');
  }
}

function generateMarkdown() {
  const byCategory = {};
  for (const link of store.links) {
    if (link.category === SKIPPED) continue;
    if (!byCategory[link.category]) byCategory[link.category] = [];
    byCategory[link.category].push(link);
  }
  const cats = Object.keys(byCategory).sort((a, b) => a.localeCompare(b));
  const total = cats.reduce((n, c) => n + byCategory[c].length, 0);

  let out = `# Tabitrail — Organized Links\n\n`;
  out += `_${total} link${total === 1 ? '' : 's'} across ${cats.length} categor${cats.length === 1 ? 'y' : 'ies'} · last updated ${new Date().toISOString()}_\n\n`;

  for (const c of cats) {
    out += `## ${c}\n\n`;
    const links = byCategory[c].slice().sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    for (const l of links) {
      const desc = l.summary ? ` — ${l.summary}` : '';
      out += `- [${l.title || l.url}](${l.url})${desc}\n`;
    }
    out += `\n`;
  }
  return out;
}

async function downloadMarkdown() {
  const md = generateMarkdown();
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename: 'tabitrail-links.md', conflictAction: 'overwrite', saveAs: false });
}

// --- Load tabs from digest (current data or an imported Markdown file) ---

function parseMarkdownDigest(text) {
  const lines = text.split(/\r?\n/);
  const links = [];
  let currentCategory = null;
  const headingRe = /^##\s+(.+)$/;
  const itemRe = /^-\s+\[(.*?)\]\((.*?)\)(?:\s+—\s+(.*))?$/;
  for (const line of lines) {
    const h = line.match(headingRe);
    if (h) {
      currentCategory = h[1].trim();
      continue;
    }
    const m = line.match(itemRe);
    if (m && currentCategory) {
      links.push({ title: m[1].trim(), url: m[2].trim(), category: currentCategory, summary: m[3] ? m[3].trim() : null });
    }
  }
  return links;
}

function getActiveLinks() {
  if (importedLinks) return importedLinks;
  return store.links
    .filter((l) => l.category !== SKIPPED)
    .map((l) => ({ url: l.url, title: l.title, category: l.category, summary: l.summary, window: l.window }));
}

function getActiveCategories() {
  return [...new Set(getActiveLinks().map((l) => l.category))].sort((a, b) => a.localeCompare(b));
}

function colorForCategory(category, sortedCategories) {
  const idx = sortedCategories.indexOf(category);
  return GROUP_COLORS[idx >= 0 ? idx % GROUP_COLORS.length : 0];
}

function setLoadStatus(text) {
  document.getElementById('loadStatus').textContent = text;
}

function populateLoadCategorySelect() {
  const select = document.getElementById('loadCategorySelect');
  const links = getActiveLinks();
  const cats = getActiveCategories();
  select.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = '__all__';
  allOpt.textContent = `All categories (${links.length})`;
  select.appendChild(allOpt);
  for (const c of cats) {
    const count = links.filter((l) => l.category === c).length;
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = `${c} (${count})`;
    select.appendChild(opt);
  }
}

// Opens a tab in the window saved for this link (creating that window on first use).
// A null label means "the current window". winMap maps label -> window id for this load.
async function openTabInWindow(url, label, winMap) {
  if (!label) return chrome.tabs.create({ url, active: false });
  if (winMap[label] !== undefined) {
    try {
      return await chrome.tabs.create({ url, windowId: winMap[label], active: false });
    } catch (e) {
      delete winMap[label]; // window was closed mid-load; start a fresh one
    }
  }
  const win = await chrome.windows.create({ url, focused: false });
  winMap[label] = win.id;
  return win.tabs[0];
}

// Returns the number of browser windows the links were opened into.
async function openLinksGrouped(links) {
  settings = await loadSettings();
  const useWindows = settings.restoreWindows !== false;
  const allCats = [...new Set(links.map((l) => l.category))].sort((a, b) => a.localeCompare(b));
  const labelOf = (l) => (useWindows && l.window ? l.window : null);
  const labels = [...new Set(links.map(labelOf))].sort((a, b) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b, undefined, { numeric: true })));
  const winMap = {};

  for (const label of labels) {
    const inWindow = links.filter((l) => labelOf(l) === label);
    const cats = [...new Set(inWindow.map((l) => l.category))].sort((a, b) => a.localeCompare(b));
    for (const cat of cats) {
      const tabIds = [];
      for (const l of inWindow.filter((x) => x.category === cat)) {
        try {
          const tab = await openTabInWindow(l.url, label, winMap);
          tabIds.push(tab.id);
        } catch (e) {
          // skip links the browser refuses to open (e.g. malformed URL)
        }
      }
      if (tabIds.length) {
        try {
          const groupId = await chrome.tabs.group({ tabIds });
          await chrome.tabGroups.update(groupId, { title: cat, color: colorForCategory(cat, allCats) });
        } catch (e) {
          // tabs are still open even if grouping failed
        }
      }
    }
  }
  return Object.keys(winMap).length;
}

function windowsNote(n) {
  return n > 0 ? ` in ${n} new window${n === 1 ? '' : 's'}` : '';
}

async function loadAll() {
  const links = getActiveLinks();
  if (!links.length) {
    alert('No links to load from the current source.');
    return;
  }
  if (links.length > 12 && !confirm(`This will open ${links.length} tabs across ${getActiveCategories().length} groups. Continue?`)) {
    return;
  }
  setLoadStatus(`Opening ${links.length} tabs...`);
  const wins = await openLinksGrouped(links);
  setLoadStatus(`Opened ${links.length} tabs across ${getActiveCategories().length} groups${windowsNote(wins)}.`);
}

async function loadSelectedCategory() {
  const value = document.getElementById('loadCategorySelect').value;
  const links = getActiveLinks();
  const target = value === '__all__' ? links : links.filter((l) => l.category === value);
  if (!target.length) {
    alert('No links in that category.');
    return;
  }
  if (target.length > 12 && !confirm(`This will open ${target.length} tabs. Continue?`)) return;
  setLoadStatus(`Opening ${target.length} tabs...`);
  const wins = await openLinksGrouped(target);
  setLoadStatus(`Opened ${target.length} tabs${windowsNote(wins)}.`);
}

function startOneByOne() {
  const value = document.getElementById('loadCategorySelect').value;
  const links = getActiveLinks();
  const target = (value === '__all__' ? links : links.filter((l) => l.category === value)).slice();
  if (!target.length) {
    alert('No links in that category.');
    return;
  }
  oneByOneQueue = target;
  oneByOneIndex = 0;
  oneByOneGroupMap = {};
  oneByOneWindowMap = {};
  document.getElementById('oneByOneSection').hidden = false;
  renderOneByOne();
}

function renderOneByOne() {
  const section = document.getElementById('oneByOneSection');
  if (!oneByOneQueue || oneByOneIndex >= oneByOneQueue.length) {
    section.hidden = true;
    if (oneByOneQueue) setLoadStatus('Finished stepping through the selection.');
    oneByOneQueue = null;
    return;
  }
  const link = oneByOneQueue[oneByOneIndex];
  document.getElementById('oneByOneProgress').textContent = `${oneByOneIndex + 1} / ${oneByOneQueue.length}`;
  document.getElementById('oneByOneTitle').textContent = link.title || link.url;
  document.getElementById('oneByOneCategory').textContent = link.category + (link.window && settings.restoreWindows !== false ? ` · ${link.window}` : '');
  const a = document.getElementById('oneByOneUrl');
  a.textContent = link.url;
  a.href = link.url;
  document.getElementById('oneByOneSummary').textContent = link.summary || '';
}

async function oneByOneOpen() {
  const link = oneByOneQueue[oneByOneIndex];
  try {
    const label = settings.restoreWindows !== false && link.window ? link.window : null;
    const tab = await openTabInWindow(link.url, label, oneByOneWindowMap);
    const key = `${label || ''}||${link.category}`;
    let groupId = oneByOneGroupMap[key];
    if (groupId === undefined) {
      groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      await chrome.tabGroups.update(groupId, { title: link.category, color: colorForCategory(link.category, getActiveCategories()) });
      oneByOneGroupMap[key] = groupId;
    } else {
      await chrome.tabs.group({ tabIds: [tab.id], groupId });
    }
  } catch (e) {
    // tab still opens even if grouping failed
  }
  oneByOneIndex++;
  renderOneByOne();
}

function oneByOneSkip() {
  oneByOneIndex++;
  renderOneByOne();
}

function oneByOneStop() {
  oneByOneQueue = null;
  document.getElementById('oneByOneSection').hidden = true;
  setLoadStatus('Stopped.');
}

function renderManage() {
  const byCategory = {};
  for (const link of store.links) {
    if (link.category === SKIPPED) continue;
    if (!byCategory[link.category]) byCategory[link.category] = [];
    byCategory[link.category].push(link);
  }
  const cats = Object.keys(byCategory).sort((a, b) => a.localeCompare(b));
  const total = cats.reduce((n, c) => n + byCategory[c].length, 0);
  document.getElementById('digestCount').textContent = `(${total} links, ${cats.length} categories)`;
  if (!document.getElementById('loadSourceImport').checked) populateLoadCategorySelect();

  const listEl = document.getElementById('categoryList');
  listEl.innerHTML = '';
  for (const c of cats) {
    const div = document.createElement('div');
    div.className = 'category-row';
    div.textContent = `${c} — ${byCategory[c].length}`;
    listEl.appendChild(div);
  }

  renderWindowList();

  const tbody = document.getElementById('linksTableBody');
  tbody.innerHTML = '';
  const sorted = store.links
    .slice()
    .sort((a, b) => (a.category || '').localeCompare(b.category || '') || (a.title || '').localeCompare(b.title || ''));

  for (const link of sorted) {
    const tr = document.createElement('tr');

    const tdTitle = document.createElement('td');
    const a = document.createElement('a');
    a.href = link.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = link.title || link.url;
    tdTitle.appendChild(a);

    const tdCat = document.createElement('td');
    tdCat.textContent = link.category === SKIPPED ? '(skipped)' : link.category;

    const tdActions = document.createElement('td');
    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.className = 'link-remove';
    removeBtn.addEventListener('click', async () => {
      store.links = store.links.filter((l) => l.url !== link.url);
      await saveLinks(store);
      recomputeCategories();
      renderManage();
    });
    tdActions.appendChild(removeBtn);

    tr.appendChild(tdTitle);
    tr.appendChild(tdCat);
    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  }
}

function renderWindowList() {
  const listEl = document.getElementById('windowList');
  listEl.innerHTML = '';
  const counts = {};
  for (const l of store.links) {
    if (l.category === SKIPPED || !l.window) continue;
    counts[l.window] = (counts[l.window] || 0) + 1;
  }
  const names = Object.keys(counts).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!names.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No windows saved yet. Scan your open tabs to record them.';
    listEl.appendChild(p);
    return;
  }
  for (const name of names) {
    const row = document.createElement('div');
    row.className = 'window-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = name;
    const count = document.createElement('span');
    count.className = 'muted';
    count.textContent = `${counts[name]} link${counts[name] === 1 ? '' : 's'}`;
    const btn = document.createElement('button');
    btn.textContent = 'Rename';
    btn.addEventListener('click', () => renameWindow(name, input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') renameWindow(name, input.value);
    });
    row.appendChild(input);
    row.appendChild(count);
    row.appendChild(btn);
    listEl.appendChild(row);
  }
}

async function renameWindow(oldName, newName) {
  newName = newName.trim();
  if (!newName || newName === oldName) {
    renderWindowList();
    return;
  }
  if (store.links.some((l) => l.window === newName) && !confirm(`A window named "${newName}" already exists. Merge them?`)) return;
  for (const l of store.links) {
    if (l.window === oldName) l.window = newName;
  }
  await saveLinks(store);
  renderManage();
}

async function unskipAll() {
  const before = store.links.length;
  store.links = store.links.filter((l) => l.category !== SKIPPED);
  const removed = before - store.links.length;
  await saveLinks(store);
  renderManage();
  setStatus(`Un-skipped ${removed} link${removed === 1 ? '' : 's'}. Click "Re-scan open tabs" to review them again (tabs must still be open).`);
}

async function resetAll() {
  if (!confirm('This deletes all saved Tabitrail links and categories. Continue?')) return;
  store = { links: [] };
  await saveLinks(store);
  recomputeCategories();
  renderManage();
  setStatus('All data cleared.');
}

function populateSettingsForm(s) {
  document.getElementById('apiKeyInput').value = s.apiKey || '';
  document.getElementById('modelInput').value = s.model || DEFAULT_MODEL;
  document.getElementById('autoModeCheckbox').checked = !!s.autoMode;
  document.getElementById('recategorizeAllCheckbox').checked = !!s.recategorizeAllOnScan;
  document.getElementById('restoreWindowsCheckbox').checked = s.restoreWindows !== false;
  document.getElementById('newCategoryBehaviorSelect').value = s.newCategoryBehavior === 'auto' ? 'auto' : 'ask';
}

async function saveSettingsFromForm() {
  const newSettings = {
    apiKey: document.getElementById('apiKeyInput').value.trim(),
    model: document.getElementById('modelInput').value.trim() || DEFAULT_MODEL,
    autoMode: document.getElementById('autoModeCheckbox').checked,
    recategorizeAllOnScan: document.getElementById('recategorizeAllCheckbox').checked,
    restoreWindows: document.getElementById('restoreWindowsCheckbox').checked,
    newCategoryBehavior: document.getElementById('newCategoryBehaviorSelect').value
  };
  await saveSettings(newSettings);
  settings = newSettings;
  const statusEl = document.getElementById('saveSettingsStatus');
  statusEl.textContent = 'Saved.';
  setTimeout(() => {
    statusEl.textContent = '';
  }, 2000);
}

document.getElementById('scanBtn').addEventListener('click', scan);
document.getElementById('downloadBtn').addEventListener('click', downloadMarkdown);
document.getElementById('saveBtn').addEventListener('click', saveCurrent);
document.getElementById('skipTempBtn').addEventListener('click', skipTemp);
document.getElementById('skipPermBtn').addEventListener('click', skipPermanent);
document.getElementById('openTabBtn').addEventListener('click', openCurrentTab);
document.getElementById('suggestBtn').addEventListener('click', suggestWithAI);
document.getElementById('unskipBtn').addEventListener('click', unskipAll);
document.getElementById('resetBtn').addEventListener('click', resetAll);
document.getElementById('categorySelect').addEventListener('change', (e) => {
  document.getElementById('newCategoryInput').hidden = e.target.value !== '__new__';
  if (e.target.value === '__new__') document.getElementById('newCategoryInput').focus();
});
document.getElementById('saveSettingsBtn').addEventListener('click', saveSettingsFromForm);
document.getElementById('restoreWindowsCheckbox').addEventListener('change', async (e) => {
  settings = await loadSettings();
  settings.restoreWindows = e.target.checked;
  await saveSettings(settings);
});
document.getElementById('loadAllBtn').addEventListener('click', loadAll);
document.getElementById('loadCategoryBtn').addEventListener('click', loadSelectedCategory);
document.getElementById('startOneByOneBtn').addEventListener('click', startOneByOne);
document.getElementById('oneByOneOpenBtn').addEventListener('click', oneByOneOpen);
document.getElementById('oneByOneSkipBtn').addEventListener('click', oneByOneSkip);
document.getElementById('oneByOneStopBtn').addEventListener('click', oneByOneStop);
document.querySelectorAll('input[name="loadSource"]').forEach((radio) => {
  radio.addEventListener('change', (e) => {
    const useImport = e.target.value === 'import';
    document.getElementById('mdFileRow').hidden = !useImport;
    if (!useImport) {
      importedLinks = null;
      document.getElementById('loadSourceStatus').textContent = '';
    }
    populateLoadCategorySelect();
  });
});
document.getElementById('mdFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const links = parseMarkdownDigest(text);
  if (!links.length) {
    alert('Could not find any links in that file. Make sure it\'s a Tabitrail-generated Markdown digest.');
    return;
  }
  importedLinks = links;
  const cats = new Set(links.map((l) => l.category));
  document.getElementById('loadSourceStatus').textContent = `Imported ${links.length} links across ${cats.size} categories from "${file.name}".`;
  populateLoadCategorySelect();
});
document.getElementById('toggleKeyBtn').addEventListener('click', () => {
  const input = document.getElementById('apiKeyInput');
  const btn = document.getElementById('toggleKeyBtn');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? 'Hide' : 'Show';
});

async function init() {
  store = await loadLinks();
  recomputeCategories();
  renderManage();
  settings = await loadSettings();
  populateSettingsForm(settings);
  await scan();
}

init();
