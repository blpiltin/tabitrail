# Chrome Web Store submission notes

Everything here is copy/checklist material for the Chrome Web Store
developer dashboard (https://chrome.google.com/webstore/devconsole). Brave
doesn't run its own extension store — Brave users install straight from the
Chrome Web Store, so one listing covers both.

## What you'll need to do yourself (can't be automated from here)

1. Create a developer account at the dashboard above (one-time $5 fee).
2. Host `PRIVACY.md` somewhere public and grab its URL — easiest options:
   - A raw GitHub link (push this repo, then use
     `https://raw.githubusercontent.com/<you>/<repo>/main/PRIVACY.md`), or
   - GitHub Pages, or a public Google Doc / Notion page with the same text.
3. Take a few screenshots (1280x800 or 640x400 px) of the organizer page —
   the review card, the settings panel, and the digest/manage view all make
   good screenshots. The store requires at least one.
4. Upload `dist/tabitrail-v1.0.0.zip` (built below) in the dashboard, paste
   the listing copy below, fill in the permission justifications, link the
   privacy policy, and submit for review (review typically takes a few days
   to ~2 weeks for extensions requesting broad host permissions).

## Packaging

Re-run this after any change to `extension/`:

```powershell
Compress-Archive -Path extension\* -DestinationPath dist\tabitrail-v1.0.0.zip -Force
```

Upload the resulting `.zip` — not the folder — to the dashboard.

## Listing copy

**Name:** Tabitrail

**Summary (short description, ≤132 characters):**
Corral your open tabs into categorized links — by tab group or AI — and reload them anytime.

**Category:** Productivity

**Single purpose (required by the dashboard):**
Tabitrail's single purpose is to let a user organize their currently open
browser tabs into named categories and later reopen any category's tabs.

**Detailed description:**

> Too many tabs open across too many windows? Tabitrail turns the chaos
> into an organized, categorized digest — and lets you reload any part of
> it later, as real tabs, regrouped automatically.
>
> **Organize**
> - Tabs already in a Brave tab group are filed automatically under a
>   category named after the group.
> - Every other tab is shown to you one at a time with its title, URL, and
>   a live summary, so you can file it under an existing category, create a
>   new one, or skip it.
> - Already-filed tabs are remembered, so re-scanning only asks about what's
>   new.
>
> **Optional AI assist**
> - Add your own Anthropic API key to let AI suggest — or fully
>   auto-assign — categories for you, matching existing categories first and
>   proposing new ones only when nothing fits.
> - A "re-categorize everything" mode can re-evaluate every open tab at
>   once, including tabs already filed or grouped.
>
> **Reload anytime**
> - Load every tab back at once, load just one category, or step through a
>   category one tab at a time — Tabitrail recreates the category structure
>   as real, colored Brave tab groups as it reopens them.
> - Remembers which browser window each tab was in and reopens them into
>   the same windows (optional; rename windows to whatever you like).
> - Works from an exported Markdown digest too, so you can move a category
>   of tabs to a different browser profile or machine.
>
> **Private by design**
> - Everything is stored locally in your browser. There's no server, no
>   account, and no tracking — Tabitrail's developer never sees your tabs,
>   your links, or your API key.
> - AI requests (only when you enable that optional feature) go directly
>   from your browser to Anthropic's API, using a key only you control.

## Permission justifications (paste into the dashboard's Privacy practices tab)

- **tabs** — "Reads the URL, title, and tab-group membership of open tabs so they can be organized into categories."
- **tabGroups** — "Reads existing tab-group names/colors to auto-categorize grouped tabs, and creates new tab groups when reopening a saved category."
- **downloads** — "Saves the user's categorized link digest as a Markdown file to their Downloads folder, only when they click Download."
- **storage** — "Stores the user's categorized links and settings locally in the browser; nothing is sent to any server operated by the developer."
- **scripting** — "Reads the page title and meta description of the specific tab the user is currently reviewing, to show a short summary."
- **Host permission (all http/https sites)** — "The scripting permission needs host access to read a summary from whichever site the user's tab happens to be on, since that isn't known in advance."

## Notes for the review team (optional, but speeds up review)

Tabitrail does not collect, transmit, or sell any user data to the
developer or any third party. The broad host permission is used solely to
read page metadata (title/meta description) from tabs the user has open,
purely client-side, to generate a short summary shown back to the user in
the extension's own UI. See `PRIVACY.md` for full detail.
