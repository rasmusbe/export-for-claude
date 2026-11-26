# Chrome Web Store submission answers

Answers for the Developer Dashboard. The listing texts are in
[listing-en.md](listing-en.md) and [listing-sv.md](listing-sv.md).

## Package

Upload `export-for-claude-<version>.zip` from the GitHub release for the tag
(built by `.github/workflows/release.yml`).

## Store listing

- Category: Productivity
- Icon: `public/icons/icon128.png`
- Screenshots: `store/screenshots/*.png` (1280×800)
- Homepage: https://github.com/rasmusbe/export-for-claude
- Support: https://github.com/rasmusbe/export-for-claude/issues

## Privacy practices

### Single purpose

Export the claude.ai conversation the user has open (Markdown, JSON, PDF) and
download the files in it, on the user's request.

### Permission justifications

- **downloads**: Saves the export the user asked for (Markdown, JSON or a zip
  of the conversation's files) through the browser's Save As dialog.
- **offscreen**: Creates a blob URL for the export inside the extension, so
  that chrome.downloads can save files larger than a data URL allows. No page
  is shown and no data leaves the device.
- **Host permission `https://claude.ai/*`**: Reads the open conversation and
  its files from claude.ai with the user's own session when the user clicks
  export. A script on claude.ai pages observes the page's own requests to learn
  the ids of incognito chats and Cowork sessions, which are not in the URL.

### Remote code

No. All code is in the package; nothing is loaded or evaluated from elsewhere.

### Data usage

Data types handled: **Website content** and **Personal communications** (the
conversation and its files), only to create the export the user requested.

Certify:
- Not sold to third parties.
- Not used or transferred for purposes unrelated to the single purpose.
- Not used or transferred to determine creditworthiness or for lending.

The data is processed locally and is never sent to the developer or third
parties.

### Privacy policy URL

https://github.com/rasmusbe/export-for-claude/blob/main/PRIVACY.md

## Distribution

- Visibility: Public
- Regions: all
- Price: free, no in-app purchases

## Account

Registered as a non-trader (private individual).
