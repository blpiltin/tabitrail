# Chrome Web Store submission notes

Everything here is copy/checklist material for the Chrome Web Store
developer dashboard (https://chrome.google.com/webstore/devconsole). Brave
doesn't run its own extension store — Brave users install straight from the
Chrome Web Store, so one listing covers both.

## Checklist

1. ~~Create a developer account~~ — done.
2. ~~Host the privacy policy~~ — done. Use this URL in the dashboard:
   `https://raw.githubusercontent.com/blpiltin/tabitrail/main/PRIVACY.md`
   (repo: https://github.com/blpiltin/tabitrail)
3. Screenshots: the store requires **exactly 1280x800 or 640x400 px** (JPEG or
   24-bit PNG, no transparency). At least one, up to five. Check them for
   personal info (open tabs, links, email addresses, API keys) before uploading.
4. Upload `dist/tabitrail-v1.0.0.zip`, paste the listing copy below, fill in
   the Privacy practices tab from the sections below, link the privacy policy,
   and submit for review (review typically takes a few days to ~2 weeks for
   extensions requesting broad host permissions).

## Packaging

Re-run this after any change to `extension/`:

```bash
python3 -c "import zipfile,os; z=zipfile.ZipFile('dist/tabitrail-v1.0.0.zip','w',zipfile.ZIP_DEFLATED); [z.write(os.path.join(r,f), os.path.relpath(os.path.join(r,f),'extension')) for r,_,fs in os.walk('extension') for f in fs]"
```

(Windows' `Compress-Archive` can write backslash paths inside the zip, which
the store may reject. The command above always uses forward slashes, and
`manifest.json` must be at the zip's top level.)

Upload the resulting `.zip` — not the folder — to the dashboard.

## Listing copy

**Name:** Tabitrail

**Summary (short description, ≤132 characters):**
Corral your open tabs into categorized links — by tab group or AI — and reload them anytime.

**Category:** Productivity

**Single purpose (required by the dashboard):**
Tabitrail's single purpose is to let a user organize their currently open
browser tabs into named categories and later reopen any category's tabs.

**Detailed description** (the dashboard box is plain text — Markdown such as `**bold**`
or `>` is NOT rendered and would show up literally, so paste this block as-is.
Line breaks are kept; `•` bullets are fine; max 16,000 characters):

```text
Too many tabs open across too many windows? Tabitrail turns the chaos into an organized, categorized digest, and lets you reload any part of it later as real tabs, regrouped automatically.

ORGANIZE
• Tabs already in a Brave tab group are filed automatically under a category named after the group.
• Every other tab is shown to you one at a time with its title, URL, and a live summary, so you can file it under an existing category, create a new one, or skip it.
• Already-filed tabs are remembered, so re-scanning only asks about what's new.

OPTIONAL AI ASSIST
• Add your own Anthropic API key to let AI suggest, or fully auto-assign, categories for you, matching existing categories first and proposing new ones only when nothing fits.
• A "re-categorize everything" setting can re-evaluate every open tab at once, including tabs already filed or grouped.

RELOAD ANYTIME
• Load every tab back at once, load just one category, or step through a category one tab at a time. Tabitrail recreates the category structure as real, colored Brave tab groups as it reopens them.
• Remembers which browser window each tab was in and reopens them into the same windows (optional; rename windows to whatever you like).
• Works from an exported Markdown digest too, so you can move a category of tabs to a different browser profile or machine.

PRIVATE BY DESIGN
• Everything is stored locally in your browser. There is no server, no account, and no tracking. Tabitrail's developer never sees your tabs, your links, or your API key.
• AI requests (only when you enable that optional feature) go directly from your browser to Anthropic's API, using a key only you control.
```

## Permission justifications (paste into the dashboard's Privacy practices tab)

- **tabs** — "Reads the URL, title, tab-group membership, and browser window of open tabs so they can be organized into categories and later reopened into the same windows."
- **tabGroups** — "Reads existing tab-group names/colors to auto-categorize grouped tabs, and creates new tab groups when reopening a saved category."
- **downloads** — "Saves the user's categorized link digest as a Markdown file to their Downloads folder, only when they click Download."
- **storage** — "Stores the user's categorized links and settings locally in the browser; nothing is sent to any server operated by the developer."
- **scripting** — "Reads the page title and meta description of a tab the user is organizing (the one being reviewed, or each new tab when the user turns on AI auto-categorization) to show or generate a short summary. Only bundled code is injected."
- **Host permission (all http/https sites)** — "The scripting permission needs host access to read a summary from whichever site the user's tab happens to be on, since that isn't known in advance."

## Remote code (Privacy practices tab)

**Are you using remote code? → No.** All JavaScript ships inside the
package: one bundled page script (`organizer.js`) and the service worker
(`background.js`). There are no external scripts, CDN libraries, remote
stylesheets, iframes, `eval`, `new Function`, or dynamic imports. The only
network request is the optional call to `api.anthropic.com`, whose JSON
response is parsed as data and never executed.

## Data usage disclosures (Privacy practices tab)

Google counts data sent to any third party as "collected", so disclose the
optional AI feature conservatively. Tick these:

- **Web history** — URLs of open tabs (sent to Anthropic only with AI on).
- **Website content** — page title and meta description (same condition).
- **Authentication information** — the user's own API key, sent to Anthropic
  as the request credential.

Do **not** tick the others (personally identifiable info, health, financial,
location, communications, user activity). Then check all three certifications:
data is not sold to third parties; not used or transferred for purposes
unrelated to the item's single purpose; not used for creditworthiness or
lending. Link `PRIVACY.md` as the privacy policy.

## Notes for the review team (optional, but speeds up review)

Tabitrail does not send any user data to the developer, and never sells
data. The one exception to local-only processing is the optional AI feature:
only if the user enters their own Anthropic API key, the tab's title, URL,
and summary (plus category names) are sent directly to api.anthropic.com to
get a category suggestion. The broad host permission is used solely to
read page metadata (title/meta description) from tabs the user has open,
purely client-side, to generate a short summary shown back to the user in
the extension's own UI. See `PRIVACY.md` for full detail.
