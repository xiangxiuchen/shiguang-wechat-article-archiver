// SPDX-License-Identifier: MPL-2.0

import {
  EXTENSION_VERSION,
  IMAGE_PERMISSION,
  canonicalizeArticleUrl,
  validateArticleUrl
} from "../shared/policy.js";
import {
  browserLabel,
  buildSafeFeedback,
  openDownloadFromUserGesture,
  platformLabel
} from "./popup-helpers.js";

const extensionApi = globalThis.chrome;
const hasExtensionApi = Boolean(extensionApi?.runtime?.id);
const stateSections = Array.from(document.querySelectorAll("[data-state]"));
let currentTab = null;
let currentArticle = null;
let currentJobId = null;
let currentDownloadId = null;
let currentSourceUrl = null;
let permissionNoticeSequence = 0;
const diagnosticEnvironment = {
  version: hasExtensionApi
    ? extensionApi.runtime.getManifest().version
    : EXTENSION_VERSION,
  platform: platformLabel({}, navigator),
  browser: browserLabel(navigator)
};
const feedbackSnapshot = {
  status: "detecting",
  stage: "detecting",
  errorCode: "",
  savedImages: 0,
  failedImages: 0,
  totalImages: 0,
  unsupportedMediaCount: 0,
  contentLossCount: 0
};
const previewSample = {
  title: "我们为什么需要记录生活？关于记录的意义与方法",
  account: "拾光笔记",
  publishTime: "2026-08-20 10:30",
  imageCount: 18
};

const byId = (id) => document.getElementById(id);

function updateFeedback(patch = {}) {
  Object.assign(feedbackSnapshot, patch);
}

async function initializeDiagnosticEnvironment() {
  byId("versionLabel").textContent = `v${diagnosticEnvironment.version}`;
  if (!hasExtensionApi || typeof extensionApi.runtime.getPlatformInfo !== "function") return;
  try {
    const info = await extensionApi.runtime.getPlatformInfo();
    diagnosticEnvironment.platform = platformLabel(info, navigator);
  } catch {
    // The navigator-derived generic platform label is sufficient for safe feedback.
  }
}

function showState(name) {
  for (const section of stateSections) {
    section.hidden = section.dataset.state !== name;
  }
}

function openHelp() {
  if (hasExtensionApi) {
    extensionApi.tabs.create({ url: extensionApi.runtime.getURL("pages/welcome.html") });
  }
}

function renderReady(article) {
  currentArticle = article;
  byId("articleTitle").textContent = article.title || "未命名文章";
  byId("articleAccount").textContent = article.account || "未知公众号";
  byId("articleDate").textContent = article.publishTime || "原文未显示";
  byId("articleImageCount").textContent = `${article.imageCount || 0} 张`;
  updateFeedback({
    status: "ready",
    stage: "detected",
    errorCode: "",
    savedImages: 0,
    failedImages: 0,
    totalImages: Number(article.imageCount) || 0,
    unsupportedMediaCount: 0,
    contentLossCount: 0
  });
  updatePermissionNotice(Number(article.imageCount) || 0);
  showState("ready");
}

async function updatePermissionNotice(imageCount) {
  const sequence = ++permissionNoticeSequence;
  const notice = byId("permissionNotice");
  notice.hidden = imageCount <= 0;
  if (imageCount <= 0 || !hasExtensionApi) return;
  try {
    const granted = await extensionApi.permissions.contains({ origins: [IMAGE_PERMISSION] });
    if (sequence === permissionNoticeSequence) notice.hidden = granted;
  } catch {
    if (sequence === permissionNoticeSequence) notice.hidden = false;
  }
}

function progressForJob(job) {
  if (job.stage === "fetching-images" && job.totalImages > 0) {
    return Math.max(18, Math.round((job.completedImages / job.totalImages) * 70) + 15);
  }
  return {
    queued: 6,
    extracting: 12,
    "building-file": 88,
    downloading: 96
  }[job.stage] || 10;
}

function renderJob(job) {
  if (!job) return;
  if (job.id && currentJobId && job.id !== currentJobId) currentDownloadId = null;
  currentJobId = job.id || currentJobId;
  if (Object.hasOwn(job, "downloadId")) {
    currentDownloadId = Number.isInteger(job.downloadId) ? job.downloadId : null;
  }
  updateFeedback({
    status: ["success", "partial", "error", "cancelled"].includes(job.status)
      ? job.status
      : "running",
    stage: job.stage || feedbackSnapshot.stage,
    errorCode: job.error?.code || "",
    savedImages: job.savedImages,
    failedImages: job.failedImages,
    totalImages: job.totalImages,
    unsupportedMediaCount: job.unsupportedMediaCount,
    contentLossCount: job.contentLossCount
  });

  if (["success", "partial"].includes(job.status)) {
    renderSuccess(job);
    return;
  }
  if (["error", "cancelled"].includes(job.status)) {
    renderError(job.error || {
      code: job.status === "cancelled" ? "SL-CANCELLED" : "SL-1000",
      message: job.message || "这次没有保存成功"
    });
    return;
  }

  byId("savingTitle").textContent = job.stage === "fetching-images"
    ? "正在整理正文和图片…"
    : job.message || "正在保存到本地…";
  byId("savingMessage").textContent = job.id
    ? "任务已转到后台；现在关闭弹窗也会继续保存。"
    : "请暂时保持文章页和此弹窗打开。";
  byId("progressDetail").textContent = job.message || "正在整理正文";
  const progress = progressForJob(job);
  const track = byId("progressTrack");
  track.classList.toggle("is-indeterminate", !["fetching-images", "building-file", "downloading"].includes(job.stage));
  track.setAttribute("aria-valuenow", String(progress));
  byId("progressFill").style.width = `${progress}%`;
  byId("cancelButton").disabled = !job.id || job.stage === "cancelling";
  showState("saving");
}

function renderSuccess(job) {
  const failed = Number(job.failedImages) || 0;
  const unsupported = Number(job.unsupportedMediaCount) || 0;
  const contentLossCount = Number(job.contentLossCount) || 0;
  const lossManifest = Array.isArray(job.lossManifest) ? job.lossManifest : [];
  const partial = job.status === "partial" || failed > 0 || unsupported > 0 || contentLossCount > 0;
  currentDownloadId = Number.isInteger(job.downloadId) ? job.downloadId : null;
  const saved = Number(job.savedImages) || 0;
  updateFeedback({
    status: partial ? "partial" : "success",
    stage: "completed",
    errorCode: "",
    savedImages: saved,
    failedImages: failed,
    totalImages: saved + failed,
    unsupportedMediaCount: unsupported,
    contentLossCount
  });
  byId("successTitle").textContent = partial ? "文章已保存" : "已保存到下载文件夹";
  byId("successSummary").textContent = partial
    ? "正文已保存，部分内容未能完整离线保留。"
    : "正文和图片已整理完成，可在本地查看。";
  byId("savedFilename").textContent = job.filename || "拾光存档_文章.html";
  byId("savedImageCount").textContent = `${saved} / ${saved + failed} 张已保存`;
  byId("openDownloadButton").disabled = !Number.isInteger(currentDownloadId);
  byId("showDownloadButton").disabled = !Number.isInteger(currentDownloadId);
  byId("resultActionStatus").textContent = Number.isInteger(currentDownloadId)
    ? ""
    : "下载记录已失效，请到浏览器下载列表查找文件。";
  byId("partialWarning").hidden = !partial;
  if (partial) {
    const details = [];
    if (failed) details.push(`${failed} 张图片已用本地占位提示替代`);
    if (unsupported) details.push(`${unsupported} 个音视频或互动组件未纳入离线文件`);
    for (const loss of lossManifest) {
      if (Number(loss?.count) > 0 && loss?.label) {
        details.push(`${Number(loss.count)} 处${loss.label}未能完整保留`);
      }
    }
    if (!details.length) details.push("部分内容未能离线保留");
    byId("partialWarningTitle").textContent = "部分内容未能完整保留";
    byId("partialWarningText").textContent = `${details.join("；")}。打开文件时不会再次请求远程资源。`;
  }
  showState("success");
}

function renderError(error) {
  const cancelled = error?.code === "SL-CANCELLED";
  updateFeedback({
    status: cancelled ? "cancelled" : "error",
    stage: feedbackSnapshot.stage === "completed" ? "failed" : feedbackSnapshot.stage,
    errorCode: error?.code || "SL-1000"
  });
  byId("errorTitle").textContent = cancelled
    ? "保存已取消"
    : error?.code === "SL-JOB-TIMEOUT"
      ? "保存任务超时"
      : "这次没有保存成功";
  byId("errorMessage").textContent = error?.message || "请刷新文章页后重试。";
  byId("errorCode").textContent = `错误编号：${error?.code || "SL-1000"}`;
  showState("error");
}

async function injectExtractor(tabId) {
  await extensionApi.scripting.executeScript({
    target: { tabId },
    files: [
      "src/content/extractor-core.js",
      "src/content/content-script.js"
    ],
    world: "ISOLATED"
  });
}

async function contentMessage(type, options = {}) {
  if (!currentTab?.id) throw new Error("没有找到当前文章标签页");
  await injectExtractor(currentTab.id);
  return extensionApi.tabs.sendMessage(currentTab.id, {
    target: "content",
    type,
    ...options
  });
}

async function detectCurrentArticle() {
  updateFeedback({
    status: "detecting",
    stage: "detecting",
    errorCode: "",
    savedImages: 0,
    failedImages: 0,
    totalImages: 0,
    unsupportedMediaCount: 0,
    contentLossCount: 0
  });
  showState("detecting");
  try {
    [currentTab] = await extensionApi.tabs.query({ active: true, currentWindow: true });
    validateArticleUrl(currentTab?.url);
    currentSourceUrl = canonicalizeArticleUrl(currentTab.url);
    currentJobId = null;
    currentDownloadId = null;
    const response = await contentMessage("ANALYZE_ARTICLE");
    if (!response?.ok) throw Object.assign(new Error(response?.error?.message), response?.error);
    renderReady(response.article);
  } catch (error) {
    if (error?.code?.startsWith("SL-PAGE") || error?.code?.startsWith("SL-URL")) {
      updateFeedback({ status: "unsupported", stage: "detecting", errorCode: error?.code || "" });
      showState("unsupported");
    } else {
      renderError({
        code: error?.code || "SL-DETECT-01",
        message: error?.message || "文章还没有加载完成，请刷新后重试。"
      });
    }
  }
}

async function recoverRecentJob() {
  try {
    const response = await extensionApi.runtime.sendMessage({
      target: "background",
      type: "QUERY_JOB",
      jobId: currentJobId,
      sourceUrl: currentSourceUrl,
      includeGlobalBusy: true
    });
    if (
      response?.ok &&
      response.job &&
      (response.job.status === "running" || response.job.sourceUrl === currentSourceUrl)
    ) {
      renderJob(response.job);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function requestImagePermission() {
  try {
    return await extensionApi.permissions.request({ origins: [IMAGE_PERMISSION] });
  } catch {
    return false;
  }
}

async function startSave() {
  byId("saveButton").disabled = true;
  currentJobId = null;
  currentDownloadId = null;
  try {
    const includeImages = !currentArticle?.imageCount || await requestImagePermission();
    renderJob({
      id: currentJobId,
      status: "running",
      stage: "extracting",
      message: includeImages
        ? "正在整理正文"
        : "未授权图片访问，将只保存正文",
      completedImages: 0,
      totalImages: currentArticle?.imageCount || 0
    });
    const extracted = await contentMessage("EXTRACT_ARTICLE", { includeImages });
    if (!extracted?.ok) {
      throw Object.assign(new Error(extracted?.error?.message), extracted?.error);
    }
    const response = await extensionApi.runtime.sendMessage({
      target: "background",
      type: "START_ARCHIVE",
      article: extracted.article,
      tabId: currentTab?.id
    });
    if (!response?.ok) throw Object.assign(new Error(response?.error?.message), response?.error);
    currentJobId = response.jobId;
    renderJob(response.job);
  } catch (error) {
    renderError({
      code: error?.code || "SL-SAVE-01",
      message: error?.message || "保存没有完成，请重新尝试。"
    });
  } finally {
    byId("saveButton").disabled = false;
  }
}

async function cancelSave() {
  if (!currentJobId) return;
  const response = await extensionApi.runtime.sendMessage({
    target: "background",
    type: "CANCEL_JOB",
    jobId: currentJobId
  });
  if (!response?.ok) {
    renderError(response?.error || {
      code: "SL-CANCEL-01",
      message: "当前任务已经结束，无法再次取消。"
    });
  }
}

async function showDownload() {
  if (!Number.isInteger(currentDownloadId)) {
    byId("resultActionStatus").textContent = "下载记录已失效，请打开浏览器下载列表查找。";
    return;
  }
  try {
    const response = await extensionApi.runtime.sendMessage({
      target: "background",
      type: "SHOW_DOWNLOAD",
      downloadId: currentDownloadId
    });
    if (!response?.ok) throw new Error("show failed");
  } catch {
    byId("resultActionStatus").textContent = "无法定位文件，请打开浏览器下载列表查找。";
  }
}

function openDownloadedArticle() {
  byId("resultActionStatus").textContent = "";
  openDownloadFromUserGesture(
    extensionApi.downloads,
    currentDownloadId,
    ({ opened, fallbackShown }) => {
      if (opened) {
        byId("resultActionStatus").textContent = "已交给浏览器打开。";
      } else if (fallbackShown) {
        byId("resultActionStatus").textContent = "无法直接打开，已在文件夹中为你定位。";
      } else {
        byId("resultActionStatus").textContent = "下载记录已失效，请打开浏览器下载列表查找。";
      }
    }
  );
}

async function copySafeFeedback() {
  const feedback = buildSafeFeedback({
    ...diagnosticEnvironment,
    ...feedbackSnapshot
  });
  const status = byId("feedbackStatus");
  status.classList.remove("is-error");
  try {
    if (navigator.clipboard?.writeText) {
      const copyAttempt = navigator.clipboard.writeText(feedback);
      await copyAttempt;
    } else if (!copyFeedbackWithLegacySelection(feedback)) {
      throw new Error("clipboard unavailable");
    }
    status.textContent = "已复制，可通过原分享渠道发送。";
  } catch {
    if (copyFeedbackWithLegacySelection(feedback)) {
      status.textContent = "已复制，可通过原分享渠道发送。";
    } else {
      status.classList.add("is-error");
      status.textContent = "无法自动复制，已打开手动复制文本。";
      showManualFeedback(feedback);
    }
  }
}

function copyFeedbackWithLegacySelection(feedback) {
  const textarea = document.createElement("textarea");
  textarea.value = feedback;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.append(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  textarea.remove();
  return copied;
}

function showManualFeedback(feedback) {
  const panel = byId("manualFeedbackPanel");
  const textarea = byId("manualFeedbackText");
  textarea.value = feedback;
  panel.hidden = false;
  textarea.focus();
  textarea.select();
}

function closeManualFeedback() {
  byId("manualFeedbackPanel").hidden = true;
  byId("feedbackButton").focus();
}

function setupPreview() {
  const preview = new URLSearchParams(location.search).get("preview") || "ready";
  if (preview === "ready") renderReady(previewSample);
  else if (preview === "saving") {
    renderJob({
      id: "preview-job",
      status: "running",
      stage: "fetching-images",
      message: "正在下载图片 8 / 12",
      completedImages: 8,
      totalImages: 12
    });
  } else if (preview === "success") {
    renderSuccess({
      status: "partial",
      filename: "2026-08-20_拾光笔记_我们为什么需要记录生活_a1b2c3d4.html",
      savedImages: 10,
      failedImages: 2,
      downloadId: 1
    });
  } else if (preview === "error") {
    renderError({ code: "SL-DETECT-01", message: "文章页面结构可能发生变化，请刷新后重试。" });
  } else showState("unsupported");
}

function handlePreviewSave() {
  renderJob({
    id: "preview-job",
    status: "running",
    stage: "fetching-images",
    message: "正在下载图片 8 / 12",
    completedImages: 8,
    totalImages: 12
  });
}

function returnToPreviewReady() {
  renderReady(previewSample);
}

byId("helpButton").addEventListener("click", openHelp);
byId("unsupportedHelpButton").addEventListener("click", openHelp);
byId("closeButton").addEventListener("click", () => hasExtensionApi ? window.close() : returnToPreviewReady());
byId("saveButton").addEventListener("click", hasExtensionApi ? startSave : handlePreviewSave);
byId("cancelButton").addEventListener("click", hasExtensionApi ? cancelSave : returnToPreviewReady);
byId("retryButton").addEventListener("click", hasExtensionApi ? detectCurrentArticle : returnToPreviewReady);
byId("openDownloadButton").addEventListener("click", hasExtensionApi ? openDownloadedArticle : returnToPreviewReady);
byId("showDownloadButton").addEventListener("click", hasExtensionApi ? showDownload : returnToPreviewReady);
byId("feedbackButton").addEventListener("click", copySafeFeedback);
byId("closeManualFeedbackButton").addEventListener("click", closeManualFeedback);

initializeDiagnosticEnvironment();

if (hasExtensionApi) {
  extensionApi.runtime.onMessage.addListener((message) => {
    if (!message || message.target !== "popup") return;
    if (message.type === "JOB_STATE" && message.job?.id === currentJobId) {
      renderJob(message.job);
    }
    if (message.type === "JOB_FINISHED") {
      if (!currentJobId || message.jobId !== currentJobId) return;
      if (message.outcome.status === "error") renderError(message.outcome.error);
      else if (message.outcome.status === "cancelled") {
        renderError(message.outcome.error || {
          code: "SL-CANCELLED",
          message: "已取消保存，没有继续写入文件。"
        });
      }
      else renderSuccess({ ...message.outcome, status: message.outcome.status });
    }
  });
  (async () => {
    try {
      [currentTab] = await extensionApi.tabs.query({ active: true, currentWindow: true });
      validateArticleUrl(currentTab?.url);
      currentSourceUrl = canonicalizeArticleUrl(currentTab.url);
      const recovered = await recoverRecentJob();
      if (!recovered) await detectCurrentArticle();
    } catch {
      await detectCurrentArticle();
    }
  })();
} else {
  setupPreview();
}
