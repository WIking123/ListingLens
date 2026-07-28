// Background service worker — injects content script on SPA navigation
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.url &&
    (
      changeInfo.url.includes("zillow.com/homedetails/") ||
      changeInfo.url.includes("realtor.com/realestateandhomes-detail/") ||
      /redfin\.(com|ca)\/.*\/home\//.test(changeInfo.url)
    )
  ) {
    // URL changed to a listing page — inject content script
    chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    }).catch((err) => {
      console.warn("ListingLens: content script injection failed", err);
    });
  }
});
