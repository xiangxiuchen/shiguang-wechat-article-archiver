// SPDX-License-Identifier: MPL-2.0

import { buildArchiveHtml } from "../shared/archive.js";
import {
  LIMITS,
  assertDecodedRasterBudget,
  assertRasterBudget,
  assertArticlePayload,
  createRasterBudget,
  detectRasterMime,
  inspectRasterMetadata,
  reserveRasterBudget,
  validateImageUrl
} from "../shared/policy.js";
import {
  classifyAbortReason,
  findBusyJob,
  findRecoverableJob,
  isTerminalJob
} from "../shared/job-state.js";
import { withTimeout } from "../shared/download-state.js";

const jobs = new Map();
const blobs = new Map();
const activeDownloads = new Map();

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    message: job.message,
    completedImages: job.completedImages,
    totalImages: job.totalImages,
    savedImages: job.savedImages,
    failedImages: job.failedImages,
    filename: job.filename || "",
    downloadId: job.downloadId ?? null,
    sourceUrl: job.sourceUrl || "",
    articleTitle: job.articleTitle || "",
    unsupportedMediaCount: job.unsupportedMediaCount || 0,
    contentLossCount: job.contentLossCount || 0,
    lossManifest: job.lossManifest || [],
    error: job.error || null,
    updatedAt: job.updatedAt
  };
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  chrome.runtime.sendMessage({
    target: "popup",
    type: "JOB_STATE",
    job: publicJob(job)
  }).catch(() => {});
}

function serializeError(error, fallbackCode = "SL-JOB-01") {
  const code = typeof error?.code === "string" && error.code.startsWith("SL-")
    ? error.code
    : fallbackCode;
  return {
    code,
    message: error?.message || "这次没有保存成功"
  };
}

function throwIfAborted(job) {
  if (job.controller.signal.aborted) {
    throw job.controller.signal.reason || new DOMException("任务已取消", "AbortError");
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")), { once: true });
    reader.addEventListener("error", () => reject(Object.assign(
      new Error("图片转换失败"),
      { code: "SL-IMG-20" }
    )), { once: true });
    reader.readAsDataURL(blob);
  });
}

function createLinkedController(jobSignal, budgetSignal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(Object.assign(new Error("图片下载超时"), {
      name: "TimeoutError",
      code: "SL-IMG-TIMEOUT"
    }));
  }, LIMITS.imageTimeoutMs);
  const onJobAbort = () => controller.abort(jobSignal.reason);
  const onBudgetAbort = () => controller.abort(budgetSignal.reason);
  jobSignal.addEventListener("abort", onJobAbort, { once: true });
  budgetSignal.addEventListener("abort", onBudgetAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeoutId);
      jobSignal.removeEventListener("abort", onJobAbort);
      budgetSignal.removeEventListener("abort", onBudgetAbort);
    }
  };
}

function aggregateBudgetError(code, message) {
  return Object.assign(new Error(message), { code });
}

function markAggregateBudgetExhausted(budget, error) {
  if (!budget.exhausted) {
    budget.exhausted = error;
    budget.controller.abort(error);
  }
  return budget.exhausted;
}

function throwIfAggregateBudgetExhausted(budget, sealFullBudget = false) {
  if (budget.exhausted) throw budget.exhausted;
  if (!sealFullBudget) return;
  if (budget.usedBytes >= LIMITS.maxTotalImageBytes) {
    throw markAggregateBudgetExhausted(
      budget,
      aggregateBudgetError("SL-IMG-13", "文章图片总量超过安全上限")
    );
  }
  if (budget.raster.pixelCount >= LIMITS.maxTotalImagePixels) {
    throw markAggregateBudgetExhausted(
      budget,
      aggregateBudgetError("SL-IMG-23", "文章图片总像素量超过安全上限")
    );
  }
  if (budget.raster.framePixelCount >= LIMITS.maxTotalFramePixels) {
    throw markAggregateBudgetExhausted(
      budget,
      aggregateBudgetError("SL-IMG-24", "文章图片总解码量超过安全上限")
    );
  }
}

async function decodeAndValidateImage(bytes, mime, budget) {
  const metadata = assertRasterBudget(inspectRasterMetadata(bytes, mime));
  throwIfAggregateBudgetExhausted(budget);
  try {
    reserveRasterBudget(budget.raster, metadata);
  } catch (error) {
    if (["SL-IMG-23", "SL-IMG-24"].includes(error?.code)) {
      throw markAggregateBudgetExhausted(budget, error);
    }
    throw error;
  }
  const blob = new Blob([bytes], { type: mime });
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw Object.assign(new Error("图片无法解码，可能已损坏"), {
      code: "SL-IMG-21"
    });
  }
  try {
    try {
      assertDecodedRasterBudget(metadata, bitmap.width, bitmap.height);
    } catch (error) {
      if (error?.code === "SL-IMG-25") {
        throw markAggregateBudgetExhausted(budget, error);
      }
      throw error;
    }
  } finally {
    bitmap.close();
  }
  return { blob, metadata };
}

async function readLimited(response, budget, signal) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > LIMITS.maxImageBytes) {
    throw Object.assign(new Error("图片超过单张大小上限"), {
      code: "SL-IMG-11"
    });
  }
  if (
    Number.isFinite(contentLength) &&
    contentLength > 0 &&
    budget.usedBytes + contentLength > LIMITS.maxTotalImageBytes
  ) {
    const error = markAggregateBudgetExhausted(
      budget,
      aggregateBudgetError("SL-IMG-13", "文章图片总量超过安全上限")
    );
    await response.body?.cancel(error).catch(() => {});
    throw error;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw Object.assign(new Error("图片响应无法读取"), { code: "SL-IMG-12" });
  }

  const chunks = [];
  let size = 0;
  while (true) {
    if (signal.aborted) throw signal.reason;
    if (budget.exhausted) {
      await reader.cancel(budget.exhausted).catch(() => {});
      throw budget.exhausted;
    }
    const { value, done } = await reader.read();
    if (done) break;
    if (budget.exhausted) {
      await reader.cancel(budget.exhausted).catch(() => {});
      throw budget.exhausted;
    }
    size += value.byteLength;
    if (size > LIMITS.maxImageBytes) {
      await reader.cancel();
      throw Object.assign(new Error("图片超过单张大小上限"), {
        code: "SL-IMG-11"
      });
    }
    if (budget.usedBytes + value.byteLength > LIMITS.maxTotalImageBytes) {
      await reader.cancel();
      throw markAggregateBudgetExhausted(
        budget,
        aggregateBudgetError("SL-IMG-13", "文章图片总量超过安全上限")
      );
    }
    budget.usedBytes += value.byteLength;
    chunks.push(value);
  }

  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function fetchImage(image, jobSignal, budget) {
  throwIfAggregateBudgetExhausted(budget, true);
  const imageUrl = validateImageUrl(image.url);
  const linked = createLinkedController(jobSignal, budget.controller.signal);
  try {
    const response = await fetch(imageUrl.href, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: linked.signal
    });
    if (!response.ok) {
      throw Object.assign(new Error(`图片请求失败（${response.status}）`), {
        code: "SL-IMG-14"
      });
    }
    validateImageUrl(response.url);
    const bytes = await readLimited(response, budget, linked.signal);
    const mime = detectRasterMime(bytes);
    if (!mime) {
      throw Object.assign(new Error("图片格式不在安全范围内"), {
        code: "SL-IMG-15"
      });
    }
    const { blob, metadata } = await decodeAndValidateImage(bytes, mime, budget);
    const dataUrl = await blobToDataUrl(blob);
    return {
      id: image.id,
      ok: true,
      dataUrl,
      byteLength: bytes.byteLength,
      mime,
      width: metadata.width,
      height: metadata.height,
      frameCount: metadata.frameCount
    };
  } finally {
    linked.cleanup();
  }
}

async function fetchAllImages(article, job) {
  const results = new Array(article.images.length);
  const budget = {
    usedBytes: 0,
    raster: createRasterBudget(),
    exhausted: null,
    controller: new AbortController()
  };
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= article.images.length) return;
      const image = article.images[index];
      if (job.controller.signal.aborted) throw job.controller.signal.reason;
      let result;
      if (budget.exhausted) {
        result = {
          id: image.id,
          ok: false,
          error: serializeError(budget.exhausted, "SL-IMG-16")
        };
      } else {
        try {
          result = await fetchImage(image, job.controller.signal, budget);
        } catch (error) {
          if (job.controller.signal.aborted) throw job.controller.signal.reason;
          result = {
            id: image.id,
            ok: false,
            error: serializeError(budget.exhausted || error, "SL-IMG-16")
          };
        }
      }
      results[index] = result;
      if (result.ok) job.savedImages += 1;
      else job.failedImages += 1;
      job.completedImages += 1;
      updateJob(job, {
        stage: "fetching-images",
        message: `正在下载图片 ${job.completedImages} / ${job.totalImages}`
      });
    }
  };

  const workers = Array.from(
    { length: Math.min(LIMITS.imageConcurrency, article.images.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

function createBlobRecord(jobId, html) {
  const blobId = crypto.randomUUID();
  const blobUrl = URL.createObjectURL(
    new Blob([html], { type: "text/html;charset=utf-8" })
  );
  const expiry = setTimeout(() => {
    const record = blobs.get(blobId);
    if (record) {
      URL.revokeObjectURL(record.url);
      blobs.delete(blobId);
    }
  }, 10 * 60_000);
  blobs.set(blobId, { id: blobId, jobId, url: blobUrl, expiry });
  return { blobId, blobUrl };
}

function revokeBlob(blobId) {
  const record = blobs.get(blobId);
  if (!record) return;
  clearTimeout(record.expiry);
  URL.revokeObjectURL(record.url);
  blobs.delete(blobId);
}

async function createDownloadWithTimeout(message) {
  let timedOut = false;
  const request = chrome.runtime.sendMessage(message);
  request.then((response) => {
    if (timedOut && response?.ok && Number.isInteger(response.downloadId)) {
      chrome.runtime.sendMessage({
        target: "background",
        type: "ABANDON_DOWNLOAD",
        jobId: message.jobId,
        downloadId: response.downloadId
      }).catch(() => {});
    }
  }).catch(() => {});

  const timeoutError = Object.assign(
    new Error("浏览器下载交接超时，请重新尝试"),
    { code: "SL-DOWNLOAD-09" }
  );
  return withTimeout(
    request,
    LIMITS.downloadHandoffTimeoutMs,
    timeoutError,
    () => {
      timedOut = true;
    }
  );
}

async function runJob(job, rawArticle) {
  let pendingBlobId = null;
  const totalTimeout = setTimeout(() => {
    job.controller.abort(Object.assign(new Error("保存任务超时，请检查网络后重试"), {
      name: "TimeoutError",
      code: "SL-JOB-TIMEOUT"
    }));
  }, LIMITS.jobTimeoutMs);

  try {
    const article = assertArticlePayload(rawArticle);
    job.totalImages = article.images.length;
    updateJob(job, {
      status: "running",
      stage: "extracting",
      message: "正在整理正文"
    });

    let imageResults = [];
    if (article.images.length) {
      updateJob(job, {
        stage: "fetching-images",
        message: `正在下载图片 0 / ${article.images.length}`
      });
      imageResults = await fetchAllImages(article, job);
    }

    throwIfAborted(job);
    updateJob(job, {
      stage: "building-file",
      message: "正在生成离线文件"
    });
    const archive = buildArchiveHtml(article, imageResults);
    throwIfAborted(job);
    const { blobId, blobUrl } = createBlobRecord(job.id, archive.html);
    pendingBlobId = blobId;
    throwIfAborted(job);
    clearTimeout(totalTimeout);

    updateJob(job, {
      stage: "downloading",
      message: "正在交给浏览器下载",
      filename: archive.filename,
      savedImages: archive.savedImages,
      failedImages: archive.failedImages,
      unsupportedMediaCount: archive.unsupportedMediaCount,
      contentLossCount: archive.contentLossCount,
      lossManifest: archive.lossManifest,
      blobId
    });

    const response = await createDownloadWithTimeout({
      target: "background",
      type: "CREATE_DOWNLOAD",
      jobId: job.id,
      blobId,
      blobUrl,
      filename: archive.filename,
      result: {
        status: archive.status,
        filename: archive.filename,
        savedImages: archive.savedImages,
        failedImages: archive.failedImages,
        unsupportedMediaCount: archive.unsupportedMediaCount,
        contentLossCount: archive.contentLossCount,
        lossManifest: archive.lossManifest,
        totalImages: archive.savedImages + archive.failedImages
      }
    });

    if (!response?.ok) {
      revokeBlob(blobId);
      throw Object.assign(new Error(response?.error?.message || "浏览器没有完成下载"), {
        code: response?.error?.code || "SL-DOWNLOAD-01"
      });
    }

    job.downloadId = response.downloadId;
    activeDownloads.set(job.id, {
      jobId: job.id,
      downloadId: response.downloadId,
      blobId,
      result: response.result,
      cancelRequested: job.controller.signal.aborted
    });
    pendingBlobId = null;

    if (job.controller.signal.aborted) {
      const active = activeDownloads.get(job.id);
      if (active) active.cancelRequested = true;
      await chrome.runtime.sendMessage({
        target: "background",
        type: "CANCEL_DOWNLOAD",
        jobId: job.id,
        downloadId: response.downloadId
      }).catch(() => {});
      throwIfAborted(job);
    }

    updateJob(job, {
      stage: "downloading",
      message: "浏览器正在写入下载文件",
      downloadId: response.downloadId
    });
    chrome.runtime.sendMessage({
      target: "background",
      type: "DOWNLOAD_HEARTBEAT",
      jobId: job.id,
      downloadId: response.downloadId,
      blobId,
      result: response.result
    }).catch(() => {});
  } catch (error) {
    clearTimeout(totalTimeout);
    if (pendingBlobId) revokeBlob(pendingBlobId);
    const aborted = job.controller.signal.aborted;
    const abortReason = aborted ? job.controller.signal.reason : null;
    const abortOutcome = aborted ? classifyAbortReason(abortReason) : null;
    if (!isTerminalJob(job)) {
      if (aborted && activeDownloads.has(job.id)) {
        updateJob(job, {
          status: "running",
          stage: "cancelling",
          message: "正在取消浏览器下载",
          error: null
        });
      } else {
        updateJob(job, {
          status: abortOutcome?.status || "error",
          stage: abortOutcome?.status || "error",
          message: abortOutcome?.message || "这次没有保存成功",
          error: serializeError(
            aborted
              ? Object.assign(new Error(abortReason?.message || abortOutcome.message), {
                code: abortOutcome.code
              })
              : error,
            aborted ? abortOutcome.code : "SL-JOB-02"
          )
        });
      }
    }
  } finally {
    job.processing = false;
  }
}

setInterval(() => {
  for (const active of activeDownloads.values()) {
    chrome.runtime.sendMessage({
      target: "background",
      type: "DOWNLOAD_HEARTBEAT",
      ...active
    }).catch(() => {});
  }
  const now = Date.now();
  for (const [jobId, job] of jobs) {
    if (
      isTerminalJob(job) &&
      !job.processing &&
      !activeDownloads.has(jobId) &&
      now - Number(job.updatedAt || 0) > LIMITS.finishedJobRetentionMs
    ) {
      jobs.delete(jobId);
    }
  }
}, 10_000);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return undefined;

  if (message.type === "RUN_ARCHIVE_JOB") {
    if (jobs.has(message.jobId)) {
      sendResponse({ ok: false, error: { code: "SL-JOB-03", message: "任务已存在" } });
      return undefined;
    }
    const busyJob = findBusyJob(jobs, activeDownloads);
    if (busyJob) {
      sendResponse({
        ok: false,
        error: {
          code: "SL-JOB-BUSY",
          message: "已有一篇文章正在保存，请完成后再保存下一篇。"
        }
      });
      return undefined;
    }
    const job = {
      id: message.jobId,
      controller: new AbortController(),
      processing: true,
      status: "running",
      stage: "queued",
      message: "准备保存",
      completedImages: 0,
      totalImages: 0,
      savedImages: 0,
      failedImages: 0,
      filename: "",
      downloadId: null,
      sourceUrl: message.article?.sourceUrl || "",
      articleTitle: message.article?.title || "",
      unsupportedMediaCount: 0,
      contentLossCount: 0,
      lossManifest: [],
      error: null,
      updatedAt: Date.now()
    };
    jobs.set(job.id, job);
    runJob(job, message.article);
    sendResponse({ ok: true, job: publicJob(job) });
    return undefined;
  }

  if (message.type === "GET_JOB_STATE") {
    const job = findRecoverableJob(jobs, {
      jobId: message.jobId,
      sourceUrl: message.sourceUrl,
      includeGlobalBusy: Boolean(message.includeGlobalBusy)
    }, activeDownloads);
    sendResponse({ ok: true, job: publicJob(job) });
    return undefined;
  }

  if (message.type === "CANCEL_JOB") {
    const job = jobs.get(message.jobId);
    if (job && !isTerminalJob(job)) {
      if (!job.controller.signal.aborted) {
        job.controller.abort(Object.assign(new Error("用户取消"), {
          name: "AbortError",
          code: "SL-CANCELLED"
        }));
      }
      const active = activeDownloads.get(job.id);
      if (active) active.cancelRequested = true;
      updateJob(job, {
        status: "running",
        stage: "cancelling",
        message: job.downloadId === null
          ? "正在停止保存任务"
          : "正在取消浏览器下载",
        error: null
      });
      sendResponse({ ok: true, downloadId: job.downloadId });
    } else {
      sendResponse({ ok: false, error: { code: "SL-CANCEL-01", message: "任务无法取消" } });
    }
    return undefined;
  }

  if (message.type === "LOOKUP_DOWNLOAD") {
    const active = Array.from(activeDownloads.values()).find(
      (item) => item.downloadId === message.downloadId
    );
    sendResponse({ ok: Boolean(active), active: active || null });
    return undefined;
  }

  if (message.type === "FINALIZE_DOWNLOAD") {
    const active = activeDownloads.get(message.jobId);
    const job = jobs.get(message.jobId);
    if (active) {
      revokeBlob(active.blobId);
      activeDownloads.delete(message.jobId);
    }
    if (job && !isTerminalJob(job)) {
      updateJob(job, {
        status: message.outcome.status,
        stage: message.outcome.status,
        message: message.outcome.message,
        filename: message.outcome.filename || job.filename,
        downloadId: message.outcome.downloadId ?? job.downloadId,
        savedImages: message.outcome.savedImages ?? job.savedImages,
        failedImages: message.outcome.failedImages ?? job.failedImages,
        unsupportedMediaCount: message.outcome.unsupportedMediaCount ?? job.unsupportedMediaCount,
        contentLossCount: message.outcome.contentLossCount ?? job.contentLossCount,
        lossManifest: message.outcome.lossManifest ?? job.lossManifest,
        error: message.outcome.error || null
      });
    }
    sendResponse({ ok: true });
    return undefined;
  }

  return undefined;
});
