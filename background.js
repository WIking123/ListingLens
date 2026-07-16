// Background service worker — injects content script on SPA navigation
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.url &&
    (
      changeInfo.url.includes("zillow.com/homedetails/") ||
      changeInfo.url.includes("realtor.com/realestateandhomes-detail/")
    )
  ) {
    // URL changed to a listing page — inject content script
    chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    }).catch(() => {}); // ignore if already injected
  }
});
