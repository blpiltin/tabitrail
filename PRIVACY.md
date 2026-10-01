# Tabitrail Privacy Policy

_Last updated: 2026-10-01_

Tabitrail is a browser extension that runs entirely on your own device. It
has no server, no analytics, and no account system.

## What Tabitrail stores

- **Your organized links** (URL, title, category, a short summary, and a label for the browser window it was in) are
  saved in the extension's local browser storage (`chrome.storage.local`),
  scoped to the browser profile it's installed in.
- **Your settings**, including an optional Anthropic API key if you enable
  AI categorization, are saved the same way.

None of this data is transmitted to Tabitrail's developer or to any server
we operate — because we don't operate one. It stays on your device unless
you explicitly export it (the "Download Markdown" button saves a file to
your own Downloads folder) or you paste it somewhere yourself.

## What Tabitrail reads

To build a category digest, Tabitrail reads the URL, title, and tab-group
name and browser window of your open tabs, and — only for tabs you're
organizing (the one you're reviewing, or each new tab if you turn on AI
auto-categorization, or all open tabs during an explicit "re-categorize"
scan) — the page's `<title>` and meta description, read directly from the already-open
tab. This is used solely to show you a short summary and, if you enable it,
to send to the AI categorization feature described below. It is not logged,
stored elsewhere, or sent anywhere except as described below.

## Optional AI categorization

If you choose to enable AI categorization, you provide your own Anthropic
API key, which Tabitrail stores locally and uses to send the current tab's
title, URL, and summary — plus your existing category names — directly from
your browser to Anthropic's API (`api.anthropic.com`), in order to get a
suggested category back. This happens only for tabs you're reviewing, tabs
auto-categorized because you turned that setting on, or tabs you explicitly
re-categorize, and only if you've entered an API key. No other party receives this data. Anthropic's
own privacy policy governs how they handle requests made with your key:
https://www.anthropic.com/legal/privacy

Your API key is stored, unencrypted, in the extension's local storage. Don't
share your browser profile data with anyone, since it would expose the key.

## Permissions Tabitrail requests, and why

| Permission | Why it's needed |
| --- | --- |
| `tabs` | Read the URL, title, and tab-group membership of your open tabs so they can be organized. |
| `tabGroups` | Read existing Brave tab-group names/colors, and create matching groups when you load tabs back from a digest. |
| `downloads` | Save the Markdown digest to your Downloads folder when you click "Download Markdown." |
| `storage` | Save your organized links and settings locally on your device. |
| `scripting` | Read the `<title>` and meta description of an already-open tab you're organizing, to generate its summary. |
| Host permission on all `http`/`https` sites | Required by `scripting` to read a summary from whichever site the tab you're reviewing happens to be on — Tabitrail doesn't know in advance which sites you'll have open. |

## Changes to this policy

If Tabitrail's data practices change, this file will be updated and the
extension's version bumped accordingly.

## Contact

Questions about this policy can be directed to the developer via the
extension's listing page.
