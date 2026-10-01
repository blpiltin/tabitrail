# Tabitrail

A self-contained browser extension (Brave/Chrome) that organizes your open
tabs into a categorized link digest — no separate script or terminal step
required.

Tabs already in a Brave **tab group** are filed automatically under a
category named after the group. Ungrouped tabs are shown to you one at a
time — with the tab's title, URL, and a summary pulled live from the page —
so you can file each one under an existing category, type a new one, or
skip it. Everything is remembered (by exact URL) so re-scanning only asks
about tabs you haven't filed yet.

## Setup (one-time)

1. Open Brave, go to `brave://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `extension/` folder in this project
4. Pin the "Tabitrail" icon to your toolbar (click the puzzle-piece icon,
   then the pin next to Tabitrail)

The extension asks for permission to read tabs, tab groups, and page
content on `http`/`https` pages. That last one is what lets it pull a page
summary directly from an already-open tab instead of re-fetching it over
the network (which fails on sites that block bots or require login).
Nothing leaves your machine — there's no server component.

## Usage

1. Click the Tabitrail icon. It opens a single organizer tab and
   immediately scans all your open windows.
2. Tabs in a tab group are filed automatically — you'll just see a count.
3. For each new ungrouped tab, you'll get a card with its title, URL, and a
   live-fetched summary, plus:
   - a **Category** dropdown of everything you've used before
   - **+ New category...** to type a new one
   - **Open tab** to jump to it in the browser before deciding
   - **Save**, **Skip (ask later)**, or **Skip permanently**
4. Click **Download Markdown** any time to write the current digest to
   `Downloads\tabitrail-links.md` (grouped by category, sorted). It's safe
   to click repeatedly — it always reflects everything filed so far.
5. Opened more tabs since last time? Click the icon again (or **Re-scan
   open tabs** on the page) — already-filed URLs are skipped automatically.

The page also has a **Manage all links** section to see everything you've
filed, remove a mistaken entry, un-skip permanently-skipped links, or wipe
all data and start over.

## AI categorization (optional)

Open **AI categorization settings** on the organizer page to let Claude
suggest or assign categories instead of doing it by hand:

- **Anthropic API key** — get one from [console.anthropic.com](https://console.anthropic.com).
  Stored only in this extension's local storage for this browser profile,
  and sent only to `api.anthropic.com` (in requests made directly from your
  browser, using Anthropic's supported direct-browser-access mode — nothing
  passes through any other server). It is **not** encrypted at rest, so
  don't share your browser profile data or this extension's storage with
  anyone.
- **Model** — defaults to `claude-opus-5`. For categorizing a large batch of
  tabs cheaply, try `claude-haiku-4-5` instead (faster and far cheaper per
  request; still solid for short classification calls like this one).
- **Automatically categorize new tabs with AI** — when on, ungrouped tabs
  are classified without a per-tab prompt: the AI is given your existing
  category list and the tab's title/URL/summary, and asked to either match
  an existing category or propose a new one.
- **When AI wants to create a new category** — choose **Ask me first** (the
  default; pauses on that one tab so you can confirm or edit the suggested
  name) or **Create it automatically** (files it under the AI's suggested
  name with no pause).

Even with auto mode off, each manual review card has a **Suggest with AI**
button that fills in a suggested category for you to confirm — a one-tab-
at-a-time assist rather than a hands-off pass.

If a request fails with a bad key or a rate limit, the whole batch stops
using AI and drops to the normal manual card for the rest of the queue
(other, one-off errors just skip that single tab back to manual review).

**When scanning, also re-categorize tabs already filed or already in a tab
group** (also under AI categorization settings) turns scanning into a full
re-evaluation instead of the usual "only ask about new tabs" behavior: the
next time you scan (click the icon, or **Re-scan open tabs**), AI
classification re-runs on every currently open tab — including ones already
filed and ones already sitting in a Brave tab group — and updates their
stored category in place if the AI's answer differs. It skips tabs you
previously marked "skip permanently." This stays on for every scan until
you uncheck it, and since it can reshuffle categories you already set by
hand, only turn it on when you actually want that.

**It follows your naming pattern.** The AI is shown your existing categories
and told to name any new category in the same style. If yours look like
`Home: Finances` / `Code: Tools`, a new one should come back as, say,
`Home: Cooking`, reusing one of your prefixes where it fits. Its answer is
tidied to match your exact prefix spelling. When you type a new category
yourself and your categories use prefixes, the review card offers them as
one-click buttons.

## Loading tabs back from the digest

Open **Load tabs from digest** on the organizer page to reopen links —
useful for restoring a session, or moving a category of tabs to a different
browser profile or machine.

- **Source**: **Use current data** reads directly from what's stored in this
  profile. **Import a Markdown digest file** lets you pick a downloaded
  `tabitrail-links.md` (from this profile or a different one) and reads
  links straight out of it instead — handy when the destination profile
  doesn't have this extension's data. Importing only affects what this
  section loads; it doesn't merge anything into your saved links.
- **Load ALL tabs** opens every link in the active source.
- **Load selection** opens the links matching the **Category** and **Window**
  dropdowns (either can be left on "All").
- **Load one by one** steps through the selection one link at a time with
  **Open this tab** / **Skip** / **Stop**, so you can cherry-pick rather
  than opening everything at once.

**Safety limits.** Opening hundreds of tabs and windows at once can freeze a
browser or even the whole computer, so Tabitrail protects you:
- It asks for confirmation above 12 tabs, stating how many tabs and windows
  it will open.
- It adds a stronger warning above 150 tabs, and refuses to open more than
  300 in one go. Load one window or category at a time instead.
- It opens tabs in small batches with short pauses, shows progress, and has a
  **Stop loading** button.
- If you close a window it's filling, the load stops instead of opening
  replacement windows.

All of these recreate your categories as actual Brave tab groups as tabs are
opened (a new tab group per category, colored and titled to match). Opening
more than 12 tabs at once asks for confirmation first.

### Multiple windows

Tabitrail also remembers which browser window each link came from. Windows
are labeled **Window 1**, **Window 2**, and so on (browser window IDs change
every session, so a window keeps the label that most of its already-filed
tabs have). When you load tabs, a new browser window is opened for each saved
window and the links are regrouped inside it. A tab group can't span windows,
so a category that was split across two windows becomes two groups with the
same name.

- **Keep each category in one window** (on by default): categories named like
  `Home: Finances` and `Home: Kids` all open in one window called "Home", each
  category as a tab group inside it. Categories without a `Prefix:` open in a
  window called "Other" (if most of your categories use prefixes), or otherwise in
  the window that held most of their links. The confirmation tells you how many
  links will open somewhere other than where they were saved. Turn it off to
  open every link in the exact window it came from.
- Rename windows under **Digest → Windows** (e.g. "Work", "Research"). Each
  window shows its biggest categories and a **Show links** list, so you can
  recognize it before naming it.
- Untick **Restore tabs into their original windows** (under *Load tabs from
  digest*) to open everything in the current window instead.
- If a link is open in a different window on a later scan, the latest scan wins.
- The downloaded Markdown digest records each link's window in a hidden
  comment (`<!-- window: Name -->`, invisible when the file is rendered), so
  windows are restored when you import a digest too. Digests from earlier
  versions have no window info and open in the current window, as do links
  with no saved window. Incognito windows are not seen.

## Where the data lives

Everything is stored in the extension's local storage (`chrome.storage.local`),
scoped to the browser profile it's installed in. It persists across restarts
but isn't a plain file on disk — if you ever want it as JSON for backup or
scripting, open the organizer page's DevTools console and run:

```js
chrome.storage.local.get('tabitrailLinks', (d) => console.log(JSON.stringify(d.tabitrailLinks, null, 2)))
```

Copy the
result to back it up. A script to convert the downloaded Markdown digest
back into that JSON shape, if you ever need to restore from it, would be
straightforward to add later — just ask.

## Known limitations

- **Multiple browser profiles**: extension storage is per-profile, so each
  profile needs the extension loaded separately, and its links live in that
  profile's own digest.
- **Incognito windows** are excluded unless you enable "Allow in Incognito"
  for the extension in `brave://extensions`.
- **Discarded/suspended background tabs**: Brave sometimes unloads tabs you
  haven't touched in a while to save memory. Reviewing one of these may
  briefly reload it in order to read its summary.
- **Page summaries** are best-effort (title / meta description from the
  live page). Some pages won't have one — you'll still see the title and URL.

## Publishing to the Chrome Web Store

Brave installs extensions straight from the Chrome Web Store (it doesn't
run its own store), so a single listing covers both browsers. Everything
needed to submit — listing copy, permission justifications, packaging
command, and a checklist of the steps only you can do (developer account,
the $5 fee, hosting the privacy policy, screenshots) — is in
[`STORE_LISTING.md`](STORE_LISTING.md). The privacy policy itself is in
[`PRIVACY.md`](PRIVACY.md).

A submission-ready zip is already built at `dist/tabitrail-v1.0.0.zip`;
rebuild it after any change to `extension/` with:

```powershell
Compress-Archive -Path extension\* -DestinationPath dist\tabitrail-v1.0.0.zip -Force
```

The extension icon (`extension/icons/`) is a simple placeholder mascot —
swap it for custom artwork whenever you'd like a different look.
