const ORGANIZER_PATH = 'organizer.html';

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL(ORGANIZER_PATH);
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});
