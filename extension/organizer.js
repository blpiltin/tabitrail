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
    keepCategoriesTogether: true,
    lazyTabs: true,
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

// The digest keeps every link ever saved, not just the tabs open right now.
function savedTotalNote() {
  const n = store.links.filter((l) => l.category !== SKIPPED).length;
  return `Digest holds ${n} saved link${n === 1 ? '' : 's'} in total (including closed tabs).`;
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
    const queued = new Set();
    for (const tab of httpTabs) {
      const existing = byUrl.get(tab.url);
      if (existing && existing.category === SKIPPED) continue;
      if (queued.has(tab.url)) continue; // same URL open in several tabs: classify once
      queued.add(tab.url);
      queue.push({ id: tab.id, windowId: tab.windowId, windowLabel: windowLabels.get(tab.windowId), url: tab.url, title: tab.title || tab.url });
    }
    reviewIndex = 0;

    if (!queue.length) {
      setStatus('No open tabs to re-categorize (all are permanently skipped).');
      return;
    }
    setStatus(`Re-categorizing ${queue.length} open tab${queue.length === 1 ? '' : 's'} with AI... ${savedTotalNote()}`);
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
    existingUrls.add(tab.url); // same URL open in several tabs/windows: file it once per scan

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
  setStatus((parts.length ? parts.join('; ') + '.' : 'No new tabs found.') + ` Scanned ${httpTabs.length} open tab${httpTabs.length === 1 ? '' : 's'}. ${savedTotalNote()}`);

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
  updatePrefixHint();
}

// If the user's categories follow a "Prefix: Name" pattern, offer their prefixes as one-click buttons
// whenever a new category name is being typed without one.
function updatePrefixHint() {
  const hint = document.getElementById('prefixHint');
  const input = document.getElementById('newCategoryInput');
  const pattern = prefixPattern(categories);
  const value = input.value.trim();
  hint.innerHTML = '';
  if (input.hidden || !pattern.active || primaryOf(value)) {
    hint.hidden = true;
    return;
  }
  hint.hidden = false;
  hint.appendChild(document.createTextNode('Your categories look like "Prefix: Name". Add a prefix: '));
  for (const p of pattern.prefixes.slice(0, 8)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'prefix-chip';
    b.textContent = p;
    b.addEventListener('click', () => {
      input.value = `${p}: ${value}`;
      input.focus();
      updatePrefixHint();
    });
    hint.appendChild(b);
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
    'propose a new category and set isNew to true. Before naming it, study the existing category names for a ' +
    'naming pattern: for example a shared "Prefix: Name" structure (like "Home: Finances"), or consistent ' +
    'capitalization and length. If there is a pattern, name the new category in exactly the same pattern, reusing ' +
    'one of the existing prefixes when one fits and only introducing a new prefix if none do. If there are no ' +
    'existing categories or no clear pattern, use a short Title Case name (1-3 words).';

  const userText =
    `Existing categories: ${existingCategories.length ? existingCategories.slice(0, 150).join(', ') : '(none yet — propose one)'}\n\n` +
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
    let category = parsed.category.trim();
    // Match the user's existing prefix spelling ("home: X" -> "Home: X") and reuse an exact existing category.
    const m = category.match(/^([^:]{1,40}):\s*(\S.*)$/);
    if (m) {
      const known = prefixPattern(existingCategories).prefixes.find((p) => p.toLowerCase() === m[1].trim().toLowerCase());
      if (known) category = `${known}: ${m[2].trim()}`;
    }
    const exact = existingCategories.find((c) => c.toLowerCase() === category.toLowerCase());
    if (exact) return { category: exact, isNew: false };
    return { category, isNew: !!parsed.isNew };
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
      // Hidden in rendered Markdown; read back by parseMarkdownDigest so windows survive export/import.
      const win = l.window ? ` <!-- window: ${l.window.replace(/--+/g, '-').replace(/[<>]/g, '')} -->` : '';
      out += `- [${l.title || l.url}](${l.url})${desc}${win}\n`;
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
  const windowRe = /\s*<!--\s*window:\s*(.*?)\s*-->\s*$/;
  for (let line of lines) {
    let win = null;
    const wm = line.match(windowRe);
    if (wm) {
      win = wm[1] || null;
      line = line.replace(windowRe, '');
    }
    const h = line.match(headingRe);
    if (h) {
      currentCategory = h[1].trim();
      continue;
    }
    const m = line.match(itemRe);
    if (m && currentCategory) {
      links.push({ title: m[1].trim(), url: m[2].trim(), category: currentCategory, summary: m[3] ? m[3].trim() : null, window: win });
    }
  }
  return links;
}

// Each URL is loaded once, even if a digest lists it several times (e.g. a page that was open in many tabs).
function uniqueByUrl(links) {
  const seen = new Set();
  return links.filter((l) => !seen.has(l.url) && seen.add(l.url));
}

function getActiveLinks() {
  if (importedLinks) return uniqueByUrl(importedLinks);
  return uniqueByUrl(
    store.links
      .filter((l) => l.category !== SKIPPED)
      .map((l) => ({ url: l.url, title: l.title, category: l.category, summary: l.summary, window: l.window }))
  );
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

// "Home: Finances" -> "Home". Categories named "Prefix: Name" belong to the workspace/window called Prefix.
function primaryOf(category) {
  const m = (category || '').match(/^([^:]{1,40}):\s*\S/);
  return m ? m[1].trim() : null;
}

// Detects a "Prefix: Name" naming pattern among category names (active when most categories use one).
function prefixPattern(cats) {
  const unique = [...new Set(cats.filter((c) => c && c !== SKIPPED))];
  const counts = {};
  let prefixed = 0;
  for (const c of unique) {
    const p = primaryOf(c);
    if (p) {
      counts[p] = (counts[p] || 0) + 1;
      prefixed++;
    }
  }
  const prefixes = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  return { active: prefixed >= 2 && prefixed / unique.length >= 0.5, prefixes };
}

// Returns a function mapping a link to the window label it should open in (null = the current window).
// - "Restore windows" off: everything opens in the current window.
// - "Keep each category in one window" off: each link opens in the window it was saved from.
// - On (default): "Prefix: Name" categories all go to one window named Prefix, with the categories as tab
//   groups inside it. Categories without a prefix go to a window called "Other" when most of the user's
//   categories use prefixes; otherwise to the window that held most of their links.
// Always computed from ALL active links so loading a subset behaves the same as loading everything.
function windowResolver(allLinks) {
  if (settings.restoreWindows === false) return () => null;
  if (settings.keepCategoriesTogether === false) return (l) => l.window || null;
  const usesPrefixes = prefixPattern(allLinks.map((l) => l.category)).active;
  const counts = {};
  for (const l of allLinks) {
    if (!l.window || primaryOf(l.category)) continue;
    counts[l.category] = counts[l.category] || {};
    counts[l.category][l.window] = (counts[l.category][l.window] || 0) + 1;
  }
  const home = {};
  for (const [cat, byWin] of Object.entries(counts)) {
    home[cat] = Object.entries(byWin).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { numeric: true }))[0][0];
  }
  return (l) => primaryOf(l.category) || (usesPrefixes ? 'Other' : home[l.category] || l.window || null);
}

function populateLoadCategorySelect() {
  const links = getActiveLinks();
  const cats = getActiveCategories();
  const select = document.getElementById('loadCategorySelect');
  const prevCat = select.value;
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
  if ([...select.options].some((o) => o.value === prevCat)) select.value = prevCat;

  const winSelect = document.getElementById('loadWindowSelect');
  const prevWin = winSelect.value;
  winSelect.innerHTML = '';
  const allWin = document.createElement('option');
  allWin.value = '__all__';
  allWin.textContent = 'All windows';
  winSelect.appendChild(allWin);
  const resolve = windowResolver(links);
  const winCounts = {};
  let noWindow = 0;
  for (const l of links) {
    const w = resolve(l);
    if (w) winCounts[w] = (winCounts[w] || 0) + 1;
    else noWindow++;
  }
  for (const w of Object.keys(winCounts).sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))) {
    const opt = document.createElement('option');
    opt.value = w;
    opt.textContent = `${w} (${winCounts[w]})`;
    winSelect.appendChild(opt);
  }
  if (noWindow && Object.keys(winCounts).length) {
    const opt = document.createElement('option');
    opt.value = '__none__';
    opt.textContent = `(current window) (${noWindow})`;
    winSelect.appendChild(opt);
  }
  if ([...winSelect.options].some((o) => o.value === prevWin)) winSelect.value = prevWin;
}

// Links matching both the category and window pickers.
function selectedLinks() {
  const cat = document.getElementById('loadCategorySelect').value;
  const win = document.getElementById('loadWindowSelect').value;
  const all = getActiveLinks();
  const resolve = windowResolver(all);
  return all.filter((l) => {
    const w = resolve(l);
    return (cat === '__all__' || l.category === cat) && (win === '__all__' || (win === '__none__' ? !w : w === win));
  });
}

// --- Opening tabs: safety limits ---
// Opening hundreds of tabs/windows at once can freeze the browser or the whole computer, so loads are
// capped, throttled in batches, abortable, and stop by themselves if the user closes a destination window.
const LOAD_CONFIRM_OVER = 12; // ask before opening more tabs than this
const LOAD_WARN_OVER = 150; // add a stronger warning above this
const LOAD_HARD_LIMIT = 1000; // refuse to open more tabs than this in one go
const LOAD_MAX_WINDOWS = 20; // refuse to open more windows than this in one go
const BATCH_SIZE = 10; // pause after this many tabs
const BATCH_PAUSE_MS = 400;
const WINDOW_PAUSE_MS = 2500; // wait between finishing one window and starting the next
const MAX_CONSECUTIVE_FAILURES = 5;

let loadRunning = false;
let loadAbort = false; // false, or a reason string
const loadWindowIds = new Set();
// Sleeps in short slices so the Stop button (or a closed window) takes effect immediately.
async function pause(ms) {
  for (let waited = 0; waited < ms && !loadAbort; waited += 100) await new Promise((r) => setTimeout(r, 100));
}

// Closing one of the windows being filled means the user wants out: stop, don't re-create it.
if (chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener((id) => {
    if (loadRunning && loadWindowIds.has(id) && !loadAbort) loadAbort = 'a window being filled was closed';
  });
}

async function windowExists(id) {
  try {
    await chrome.windows.get(id);
    return true;
  } catch (e) {
    return false;
  }
}

// Lazy mode: instead of the real URL, open a tiny local placeholder (lazy.html) that shows the saved title and
// only loads the real page once the tab is viewed. Real pages never start loading, so hundreds of tabs cost
// almost nothing. The placeholder is then discarded so it uses no memory either.
function placeholderUrl(link) {
  return `${chrome.runtime.getURL('lazy.html')}?u=${encodeURIComponent(link.url)}&t=${encodeURIComponent(link.title || link.url)}`;
}

async function discardWhenReady(ids) {
  await Promise.all(
    ids.map(async (id) => {
      for (let i = 0; i < 40; i++) {
        try {
          if ((await chrome.tabs.get(id)).status === 'complete') break; // placeholder finished loading (title set)
        } catch (e) {
          return; // tab was closed
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      try {
        await chrome.tabs.discard(id);
      } catch (e) {
        // can't discard: it just stays a tiny local page
      }
    })
  );
}

// Opens a tab in the window saved for this link (creating that window on first use).
// A null label means "the current window". winMap maps label -> window id for this load.
// recreate=false (bulk loads): if the window is gone this throws instead of opening a replacement.
async function openTabInWindow(url, label, winMap, { recreate = false } = {}) {
  if (!label) return chrome.tabs.create({ url, active: false });
  if (winMap[label] !== undefined) {
    try {
      return await chrome.tabs.create({ url, windowId: winMap[label], active: false });
    } catch (e) {
      if (!recreate) throw e;
      delete winMap[label];
    }
  }
  const win = await chrome.windows.create({ url, focused: false });
  winMap[label] = win.id;
  loadWindowIds.add(win.id);
  return win.tabs && win.tabs[0] ? win.tabs[0] : (await chrome.tabs.query({ windowId: win.id }))[0];
}

// Returns { opened, windows, total, stopped } where stopped is null or the reason the load ended early.
async function openLinksGrouped(links, onProgress) {
  settings = await loadSettings();
  const allCats = [...new Set(links.map((l) => l.category))].sort((a, b) => a.localeCompare(b));
  const labelOf = windowResolver(getActiveLinks());
  const labels = [...new Set(links.map(labelOf))].sort((a, b) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b, undefined, { numeric: true })));
  const winMap = {};
  const lazy = settings.lazyTabs !== false;
  let pendingDiscard = [];
  let opened = 0;
  let failures = 0;

  let firstLabel = true;
  outer: for (const label of labels) {
    if (!firstLabel) {
      if (onProgress) onProgress(opened, links.length, 'waiting before the next window');
      await pause(WINDOW_PAUSE_MS);
      if (loadAbort) break;
    }
    firstLabel = false;
    const inWindow = links.filter((l) => labelOf(l) === label);
    const cats = [...new Set(inWindow.map((l) => l.category))].sort((a, b) => a.localeCompare(b));
    for (const cat of cats) {
      const tabIds = [];
      let groupWindowId;
      for (const l of inWindow.filter((x) => x.category === cat)) {
        if (loadAbort) break;
        const isNewWindow = label && winMap[label] === undefined;
        try {
          const tab = await openTabInWindow(lazy ? placeholderUrl(l) : l.url, label, winMap);
          tabIds.push(tab.id);
          if (lazy) {
            pendingDiscard.push(tab.id);
            if (pendingDiscard.length >= BATCH_SIZE) {
              await discardWhenReady(pendingDiscard);
              pendingDiscard = [];
            }
          }
          if (groupWindowId === undefined) groupWindowId = tab.windowId;
          opened++;
          failures = 0;
          if (onProgress) onProgress(opened, links.length);
          if (opened % BATCH_SIZE === 0) await pause(BATCH_PAUSE_MS);
        } catch (e) {
          if (label && winMap[label] !== undefined && !(await windowExists(winMap[label]))) {
            loadAbort = loadAbort || 'a window being filled was closed';
          } else if (++failures >= MAX_CONSECUTIVE_FAILURES) {
            loadAbort = loadAbort || 'too many tabs failed to open in a row';
          }
          // otherwise: skip links the browser refuses to open (e.g. malformed URL)
        }
      }
      if (tabIds.length) {
        try {
          // Without createProperties.windowId Chrome puts the new group in the CURRENT window, which would
          // drag these tabs out of the window they were just opened in.
          const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId: groupWindowId } });
          await chrome.tabGroups.update(groupId, { title: cat, color: colorForCategory(cat, allCats) });
        } catch (e) {
          // tabs are still open even if grouping failed
        }
      }
      if (lazy && pendingDiscard.length) {
        await discardWhenReady(pendingDiscard);
        pendingDiscard = [];
      }
      if (loadAbort) break outer;
    }
  }
  return { opened, windows: Object.keys(winMap).length, total: links.length, stopped: loadAbort || null };
}

function windowsNote(n) {
  return n > 0 ? ` in ${n} new window${n === 1 ? '' : 's'}` : '';
}

function setLoading(on) {
  loadRunning = on;
  if (on) {
    loadAbort = false;
    loadWindowIds.clear();
  }
  for (const id of ['loadAllBtn', 'loadCategoryBtn', 'startOneByOneBtn']) document.getElementById(id).disabled = on;
  document.getElementById('stopLoadBtn').hidden = !on;
}

async function runLoad(links) {
  if (loadRunning) return;
  if (!links.length) {
    alert('No links match that selection.');
    return;
  }
  settings = await loadSettings();
  const resolve = windowResolver(getActiveLinks());
  const wins = new Set(links.map(resolve).filter(Boolean)).size;
  const moved = links.filter((l) => l.window && resolve(l) && resolve(l) !== l.window).length;
  const movedNote = moved ? `\n\n${moved} of ${links.length} links will open in a different window than they were saved in, to keep each category together.` : '';
  if (links.length > LOAD_HARD_LIMIT || wins > LOAD_MAX_WINDOWS) {
    alert(
      `That's ${links.length} tabs${wins ? ` in ${wins} windows` : ''} — more than Tabitrail will open at once ` +
        `(limit: ${LOAD_HARD_LIMIT} tabs and ${LOAD_MAX_WINDOWS} windows), because it could freeze your browser or computer.\n\n` +
        'Pick a single window or category above (or use "Load one by one"), then try again.'
    );
    return;
  }
  if (
    links.length > LOAD_CONFIRM_OVER &&
    !confirm(`This will open ${links.length} tabs${wins ? ` in ${wins} new window${wins === 1 ? '' : 's'}` : ''}. Continue?${movedNote}${links.length > LOAD_WARN_OVER ? '\n\nThat is a lot of tabs and may make your browser slow for a while. Consider loading one category at a time.' : ''}\n\nYou can press "Stop loading" at any time.`)
  ) {
    return;
  }
  setLoading(true);
  setLoadStatus(`Opening tabs... 0 / ${links.length}`);
  let result;
  try {
    result = await openLinksGrouped(links, (done, total, note) => setLoadStatus(`Opening tabs... ${done} / ${total}${note ? ` (${note})` : ''}`));
  } catch (e) {
    result = { opened: 0, windows: 0, total: links.length, stopped: `error: ${e.message}` };
  } finally {
    setLoading(false);
  }
  setLoadStatus(
    `Opened ${result.opened} of ${result.total} tabs${windowsNote(result.windows)}.` + (result.stopped ? ` Stopped early: ${result.stopped}.` : '')
  );
}

function loadAll() {
  return runLoad(getActiveLinks());
}

function loadSelectedCategory() {
  return runLoad(selectedLinks());
}

function startOneByOne() {
  const target = selectedLinks().slice();
  if (!target.length) {
    alert('No links match that selection.');
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
  document.getElementById('oneByOneCategory').textContent = link.category + (windowResolver(getActiveLinks())(link) ? ` · ${windowResolver(getActiveLinks())(link)}` : '');
  const a = document.getElementById('oneByOneUrl');
  a.textContent = link.url;
  a.href = link.url;
  document.getElementById('oneByOneSummary').textContent = link.summary || '';
}

async function oneByOneOpen() {
  const link = oneByOneQueue[oneByOneIndex];
  try {
    const label = windowResolver(getActiveLinks())(link);
    const tab = await openTabInWindow(link.url, label, oneByOneWindowMap, { recreate: true });
    const key = `${label || ''}||${link.category}`;
    let groupId = oneByOneGroupMap[key];
    if (groupId === undefined) {
      groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
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
  const byWindow = {};
  for (const l of store.links) {
    if (l.category === SKIPPED || !l.window) continue;
    (byWindow[l.window] = byWindow[l.window] || []).push(l);
  }
  const names = Object.keys(byWindow).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!names.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No windows saved yet. Scan your open tabs to record them.';
    listEl.appendChild(p);
    return;
  }
  for (const name of names) {
    const links = byWindow[name];
    const item = document.createElement('div');
    item.className = 'window-item';

    const row = document.createElement('div');
    row.className = 'window-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = name;
    const count = document.createElement('span');
    count.className = 'muted window-count';
    count.textContent = `${links.length} link${links.length === 1 ? '' : 's'}`;
    const btn = document.createElement('button');
    btn.textContent = 'Rename';
    btn.addEventListener('click', () => renameWindow(name, input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') renameWindow(name, input.value);
    });
    row.appendChild(input);
    row.appendChild(count);
    row.appendChild(btn);
    item.appendChild(row);

    // Summary so a window can be recognized before it's renamed: its biggest categories...
    const catCounts = {};
    for (const l of links) catCounts[l.category] = (catCounts[l.category] || 0) + 1;
    const ranked = Object.entries(catCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const top = ranked.slice(0, 3).map(([c, n]) => `${c} (${n})`).join(', ');
    const summary = document.createElement('p');
    summary.className = 'hint window-summary';
    summary.textContent = `Mostly: ${top}${ranked.length > 3 ? `, +${ranked.length - 3} more` : ''}`;
    item.appendChild(summary);

    // ...and the actual links, one click away.
    const details = document.createElement('details');
    details.className = 'window-links';
    const dsum = document.createElement('summary');
    dsum.textContent = 'Show links';
    details.appendChild(dsum);
    const ul = document.createElement('ul');
    const sorted = links.slice().sort((x, y) => x.category.localeCompare(y.category) || (x.title || '').localeCompare(y.title || ''));
    for (const l of sorted) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = l.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = l.title || l.url;
      const cat = document.createElement('span');
      cat.className = 'muted';
      cat.textContent = ` — ${l.category}`;
      li.appendChild(a);
      li.appendChild(cat);
      ul.appendChild(li);
    }
    details.appendChild(ul);
    item.appendChild(details);

    listEl.appendChild(item);
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
  document.getElementById('keepTogetherCheckbox').checked = s.keepCategoriesTogether !== false;
  document.getElementById('lazyTabsCheckbox').checked = s.lazyTabs !== false;
  document.getElementById('newCategoryBehaviorSelect').value = s.newCategoryBehavior === 'auto' ? 'auto' : 'ask';
}

async function saveSettingsFromForm() {
  const newSettings = {
    apiKey: document.getElementById('apiKeyInput').value.trim(),
    model: document.getElementById('modelInput').value.trim() || DEFAULT_MODEL,
    autoMode: document.getElementById('autoModeCheckbox').checked,
    recategorizeAllOnScan: document.getElementById('recategorizeAllCheckbox').checked,
    restoreWindows: document.getElementById('restoreWindowsCheckbox').checked,
    keepCategoriesTogether: document.getElementById('keepTogetherCheckbox').checked,
    lazyTabs: document.getElementById('lazyTabsCheckbox').checked,
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
  updatePrefixHint();
});
document.getElementById('newCategoryInput').addEventListener('input', updatePrefixHint);
document.getElementById('saveSettingsBtn').addEventListener('click', saveSettingsFromForm);
for (const [id, key] of [['restoreWindowsCheckbox', 'restoreWindows'], ['keepTogetherCheckbox', 'keepCategoriesTogether'], ['lazyTabsCheckbox', 'lazyTabs']]) {
  document.getElementById(id).addEventListener('change', async (e) => {
    settings = await loadSettings();
    settings[key] = e.target.checked;
    await saveSettings(settings);
    populateLoadCategorySelect(); // the Window picker depends on both options
  });
}
document.getElementById('loadAllBtn').addEventListener('click', loadAll);
document.getElementById('loadCategoryBtn').addEventListener('click', loadSelectedCategory);
document.getElementById('startOneByOneBtn').addEventListener('click', startOneByOne);
document.getElementById('stopLoadBtn').addEventListener('click', () => {
  if (loadRunning) loadAbort = 'you pressed Stop';
});
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
  if (!document.getElementById('loadSourceImport').checked) populateLoadCategorySelect();
  await scan();
}

init();
