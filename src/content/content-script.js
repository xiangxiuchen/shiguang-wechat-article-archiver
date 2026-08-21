// SPDX-License-Identifier: MPL-2.0

(() => {
  if (globalThis.__SHIGUANG_ARCHIVE_CONTENT_READY__) return;
  globalThis.__SHIGUANG_ARCHIVE_CONTENT_READY__ = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== "content") return undefined;
    if (!globalThis.ShiguangExtractorCore) {
      sendResponse({
        ok: false,
        error: { code: "SL-CONTENT-01", message: "文章提取器未加载" }
      });
      return undefined;
    }

    try {
      if (message.type === "ANALYZE_ARTICLE") {
        sendResponse({ ok: true, article: globalThis.ShiguangExtractorCore.analyze() });
      } else if (message.type === "EXTRACT_ARTICLE") {
        sendResponse({
          ok: true,
          article: globalThis.ShiguangExtractorCore.extract(document, {
            includeImages: message.includeImages !== false
          })
        });
      }
    } catch (error) {
      sendResponse({
        ok: false,
        error: {
          code: error?.code || "SL-CONTENT-02",
          message: error?.message || "暂时无法识别这篇文章"
        }
      });
    }
    return undefined;
  });
})();
