// SPDX-License-Identifier: MPL-2.0

import {
  LIMITS,
  assertArticlePayload,
  canonicalizeArticleUrl
} from "../shared/policy.js";
import {
  classifyDownloadTerminal,
  mergeTerminalObservation
} from "../shared/download-state.js";

const OFFSCREEN_PATH = "src/offscreen/offscreen.html";
const downloadJobs = new Map();
const finalizingDownloads = new Set();
const abandoningDownloads = new Set();
let creatingOffscreen = null;

function serializeError(error, fallbackCode = "SL-BG-01") {
  return {
    code: error?.code || fallbackCode,
    message: error?.message || "后台处理失败"
  };
}

async function hasOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    return contexts.length > 0;
  }
  const clientsList = await clients.matchAll();
  return clientsList.some((client) => client.url === offscreenUrl);
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["BLOBS"],
        justification: "在本机整理文章图片并创建离线 HTML 文件"
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

function isTrustedOffscreenSender(sender) {
  return sender?.url === chrome.runtime.getURL(OFFSCREEN_PATH);
}

function isTrustedExtensionPageSender(sender) {
  const extensionRoot = chrome.runtime.getURL("");
  return sender?.id === chrome.runtime.id && sender?.url?.startsWith(extensionRoot);
}

function validateBlobUrl(blobUrl) {
  const prefix = `blob:chrome-extension://${chrome.runtime.id}/`;
  if (typeof blobUrl !== "string" || !blobUrl.startsWith(prefix)) {
    const error = new Error("下载文件来源无效");
    error.code = "SL-DOWNLOAD-02";
    throw error;
  }
}

function validateDownloadFilename(filename) {
  if (
    typeof filename !== "string" ||
    !filename.endsWith(".html") ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..") ||
    filename.length > 180
  ) {
    const error = new Error("下载文件名无效");
    error.code = "SL-DOWNLOAD-03";
    throw error;
  }
}

async function forwardToOffscreen(message) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

async function findDownloadMeta(downloadId) {
  const current = downloadJobs.get(downloadId);
  if (current) return current;
  try {
    const response = await forwardToOffscreen({
      type: "LOOKUP_DOWNLOAD",
      downloadId
    });
    if (response?.ok && response.active) {
      const recovered = { ...response.active, ready: true };
      downloadJobs.set(downloadId, recovered);
      return recovered;
    }
  } catch {
    return null;
  }
  return null;
}

async function finalizeDownload(downloadId, state, errorCode = "") {
  if (finalizingDownloads.has(downloadId) || abandoningDownloads.has(downloadId)) return;
  finalizingDownloads.add(downloadId);
  const meta = await findDownloadMeta(downloadId);
  if (!meta) {
    finalizingDownloads.delete(downloadId);
    return;
  }
  if (meta.ready === false) {
    meta.pendingTerminal = mergeTerminalObservation(
      meta.pendingTerminal,
      { state, errorCode }
    );
    downloadJobs.set(downloadId, meta);
    finalizingDownloads.delete(downloadId);
    return;
  }
  if (meta.abandoned) {
    if (state === "complete") {
      await chrome.downloads.removeFile(downloadId).catch(() => {});
    }
    if (state === "complete" || state === "interrupted") {
      downloadJobs.delete(downloadId);
    }
    finalizingDownloads.delete(downloadId);
    return;
  }
  const terminal = classifyDownloadTerminal(state, Boolean(meta.cancelRequested));
  if (!terminal) {
    finalizingDownloads.delete(downloadId);
    return;
  }
  const completed = terminal === "complete";
  const cancelled = terminal === "cancelled";
  const result = meta.result || {};
  const status = cancelled
    ? "cancelled"
    : completed
      ? result.status === "partial" ||
        result.failedImages > 0 ||
        result.unsupportedMediaCount > 0 ||
        result.contentLossCount > 0
      ? "partial"
      : "success"
    : "error";
  const outcome = {
    status,
    message: cancelled
      ? "已取消保存"
      : completed
      ? status === "partial"
        ? "文章已保存，部分内容未能完整离线保留"
        : "已保存到下载文件夹"
      : "浏览器没有完成下载",
    filename: result.filename,
    downloadId,
    savedImages: result.savedImages || 0,
    failedImages: result.failedImages || 0,
    unsupportedMediaCount: result.unsupportedMediaCount || 0,
    contentLossCount: result.contentLossCount || 0,
    lossManifest: result.lossManifest || [],
    error: completed
      ? null
      : cancelled
        ? { code: "SL-CANCELLED", message: "已取消保存，没有继续写入文件。" }
        : { code: errorCode || "SL-DOWNLOAD-04", message: "下载被中断或取消" }
  };

  await forwardToOffscreen({
    type: "FINALIZE_DOWNLOAD",
    jobId: meta.jobId,
    outcome
  }).catch(() => {});
  chrome.runtime.sendMessage({
    target: "popup",
    type: "JOB_FINISHED",
    jobId: meta.jobId,
    outcome
  }).catch(() => {});
  downloadJobs.delete(downloadId);
  finalizingDownloads.delete(downloadId);
}

async function reconcileDownload(downloadId) {
  const [item] = await chrome.downloads.search({ id: downloadId });
  if (!item) return;
  if (item.state === "complete") {
    await finalizeDownload(downloadId, "complete");
  } else if (item.state === "interrupted") {
    await finalizeDownload(downloadId, "interrupted", item.error);
  }
}

async function waitForDownloadTerminal(downloadId) {
  const deadline = Date.now() + LIMITS.downloadCancelSettleMs;
  while (true) {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (!item || item.state === "complete" || item.state === "interrupted") {
      return item || null;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(LIMITS.downloadStatusPollMs, remaining));
    });
  }
}

async function cancelDownload(
  downloadId,
  { userRequested = true, errorCode = "" } = {}
) {
  const meta = await findDownloadMeta(downloadId);
  if (!meta) return { settled: false };
  if (userRequested) meta.cancelRequested = true;
  meta.ready = true;
  downloadJobs.set(downloadId, meta);
  try {
    await chrome.downloads.cancel(downloadId);
  } catch {
    // It may already be complete; the browser's terminal state remains authoritative.
  }
  const item = await waitForDownloadTerminal(downloadId);
  if (item?.state === "complete" || item?.state === "interrupted") {
    await finalizeDownload(downloadId, item.state, errorCode || item.error);
    return { settled: true, state: item.state };
  }
  return { settled: false };
}

async function abandonDownload(downloadId, jobId) {
  const meta = await findDownloadMeta(downloadId);
  if (!meta || meta.jobId !== jobId) return;
  abandoningDownloads.add(downloadId);
  try {
    meta.abandoned = true;
    meta.cancelRequested = true;
    meta.ready = true;
    downloadJobs.set(downloadId, meta);
    try {
      await chrome.downloads.cancel(downloadId);
    } catch {
      // A late handoff can already be complete; remove only this extension-created file below.
    }
    const item = await waitForDownloadTerminal(downloadId);
    if (item?.state === "complete") {
      await chrome.downloads.removeFile(downloadId).catch(() => {});
    }
    if (item?.state === "complete" || item?.state === "interrupted") {
      downloadJobs.delete(downloadId);
    }
  } finally {
    finalizingDownloads.delete(downloadId);
    abandoningDownloads.delete(downloadId);
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("pages/welcome.html") });
  }
});

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === "complete") {
    finalizeDownload(delta.id, "complete");
  } else if (delta.state?.current === "interrupted") {
    finalizeDownload(delta.id, "interrupted", delta.error?.current);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "background") return undefined;

  if (message.type === "START_ARCHIVE") {
    (async () => {
      try {
        if (!isTrustedExtensionPageSender(sender)) {
          throw Object.assign(new Error("任务请求来源无效"), { code: "SL-BG-05" });
        }
        const article = assertArticlePayload(message.article);
        const jobId = crypto.randomUUID();
        const response = await forwardToOffscreen({
          type: "RUN_ARCHIVE_JOB",
          jobId,
          article
        });
        if (!response?.ok) throw Object.assign(new Error(response?.error?.message), response?.error);
        sendResponse({ ok: true, jobId, job: response.job });
      } catch (error) {
        sendResponse({ ok: false, error: serializeError(error, "SL-BG-02") });
      }
    })();
    return true;
  }

  if (message.type === "QUERY_JOB") {
    (async () => {
      try {
        if (!isTrustedExtensionPageSender(sender)) {
          throw Object.assign(new Error("查询请求来源无效"), { code: "SL-BG-05" });
        }
        const response = await forwardToOffscreen({
          type: "GET_JOB_STATE",
          jobId: message.jobId,
          sourceUrl: message.sourceUrl ? canonicalizeArticleUrl(message.sourceUrl) : null,
          includeGlobalBusy: Boolean(message.includeGlobalBusy)
        });
        sendResponse(response || { ok: true, job: null });
      } catch (error) {
        sendResponse({ ok: false, error: serializeError(error, "SL-BG-03") });
      }
    })();
    return true;
  }

  if (message.type === "CANCEL_JOB") {
    (async () => {
      try {
        if (!isTrustedExtensionPageSender(sender)) {
          throw Object.assign(new Error("取消请求来源无效"), { code: "SL-BG-05" });
        }
        const response = await forwardToOffscreen({
          type: "CANCEL_JOB",
          jobId: message.jobId
        });
        if (response?.ok && Number.isInteger(response.downloadId)) {
          await cancelDownload(response.downloadId);
        }
        sendResponse(response);
      } catch (error) {
        sendResponse({ ok: false, error: serializeError(error, "SL-BG-04") });
      }
    })();
    return true;
  }

  if (message.type === "CREATE_DOWNLOAD") {
    (async () => {
      try {
        if (!isTrustedOffscreenSender(sender)) {
          throw Object.assign(new Error("下载请求来源无效"), { code: "SL-DOWNLOAD-05" });
        }
        validateBlobUrl(message.blobUrl);
        validateDownloadFilename(message.filename);
        const downloadId = await chrome.downloads.download({
          url: message.blobUrl,
          filename: message.filename,
          conflictAction: "uniquify",
          saveAs: false
        });
        const meta = {
          jobId: message.jobId,
          downloadId,
          blobId: message.blobId,
          result: message.result,
          startedAt: Date.now(),
          ready: false,
          pendingTerminal: null,
          cancelRequested: false
        };
        downloadJobs.set(downloadId, meta);
        sendResponse({ ok: true, downloadId, result: message.result });
      } catch (error) {
        sendResponse({ ok: false, error: serializeError(error, "SL-DOWNLOAD-06") });
      }
    })();
    return true;
  }

  if (message.type === "DOWNLOAD_HEARTBEAT") {
    (async () => {
      if (!isTrustedOffscreenSender(sender) || !Number.isInteger(message.downloadId)) {
        sendResponse({ ok: false });
        return;
      }
      const existing = downloadJobs.get(message.downloadId);
      const meta = {
        jobId: message.jobId,
        downloadId: message.downloadId,
        blobId: message.blobId,
        result: message.result,
        startedAt: existing?.startedAt || Date.now(),
        ready: true,
        pendingTerminal: existing?.pendingTerminal || null,
        cancelRequested: Boolean(
          existing?.cancelRequested || message.cancelRequested
        )
      };
      downloadJobs.set(message.downloadId, meta);
      if (meta.pendingTerminal) {
        await finalizeDownload(
          message.downloadId,
          meta.pendingTerminal.state,
          meta.pendingTerminal.errorCode
        );
      } else if (meta.cancelRequested) {
        await cancelDownload(message.downloadId, { userRequested: true });
      } else if (Date.now() - meta.startedAt > LIMITS.downloadTimeoutMs) {
        await cancelDownload(message.downloadId, {
          userRequested: false,
          errorCode: "SL-DOWNLOAD-TIMEOUT"
        });
      } else {
        await reconcileDownload(message.downloadId);
      }
      sendResponse({ ok: true });
    })().catch((error) => {
      sendResponse({ ok: false, error: serializeError(error, "SL-DOWNLOAD-08") });
    });
    return true;
  }

  if (message.type === "CANCEL_DOWNLOAD") {
    (async () => {
      if (!isTrustedOffscreenSender(sender) || !Number.isInteger(message.downloadId)) {
        throw Object.assign(new Error("取消下载请求来源无效"), { code: "SL-DOWNLOAD-05" });
      }
      const meta = downloadJobs.get(message.downloadId);
      if (!meta || meta.jobId !== message.jobId) {
        throw Object.assign(new Error("下载任务不匹配"), { code: "SL-CANCEL-02" });
      }
      await cancelDownload(message.downloadId, { userRequested: true });
      sendResponse({ ok: true });
    })().catch((error) => {
      sendResponse({ ok: false, error: serializeError(error, "SL-CANCEL-02") });
    });
    return true;
  }

  if (message.type === "ABANDON_DOWNLOAD") {
    (async () => {
      if (!isTrustedOffscreenSender(sender) || !Number.isInteger(message.downloadId)) {
        throw Object.assign(new Error("超时下载清理请求来源无效"), { code: "SL-DOWNLOAD-05" });
      }
      await abandonDownload(message.downloadId, message.jobId);
      sendResponse({ ok: true });
    })().catch((error) => {
      sendResponse({ ok: false, error: serializeError(error, "SL-DOWNLOAD-10") });
    });
    return true;
  }

  if (message.type === "SHOW_DOWNLOAD") {
    try {
      if (!isTrustedExtensionPageSender(sender)) {
        throw Object.assign(new Error("下载记录请求来源无效"), { code: "SL-BG-05" });
      }
      chrome.downloads.show(Number(message.downloadId));
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: serializeError(error, "SL-DOWNLOAD-07") });
    }
    return undefined;
  }

  return undefined;
});
