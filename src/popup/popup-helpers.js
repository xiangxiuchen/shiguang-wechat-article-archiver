// SPDX-License-Identifier: MPL-2.0

const STATUS_LABELS = Object.freeze({
  detecting: "检测中",
  unsupported: "当前页不支持",
  ready: "已识别",
  running: "保存中",
  success: "完整保存",
  partial: "部分保存",
  cancelled: "已取消",
  error: "失败"
});

const STAGE_LABELS = Object.freeze({
  detecting: "识别页面",
  detected: "等待保存",
  extracting: "整理正文",
  queued: "排队中",
  "fetching-images": "下载图片",
  "building-file": "生成文件",
  downloading: "写入下载",
  cancelling: "正在取消",
  completed: "已完成",
  failed: "已终止",
  error: "已终止",
  cancelled: "已取消"
});

function safeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function safeInternalLabel(value, fallback, maximum = 40) {
  const normalized = String(value || "")
    .replace(/[^A-Za-z0-9 ._()\-/]/g, "")
    .trim()
    .slice(0, maximum);
  return normalized || fallback;
}

export function browserLabel(navigatorLike = {}) {
  const brands = Array.isArray(navigatorLike.userAgentData?.brands)
    ? navigatorLike.userAgentData.brands
    : [];
  const preferred = ["Microsoft Edge", "Google Chrome", "Chromium"];
  for (const name of preferred) {
    const match = brands.find((brand) => brand?.brand === name);
    const major = String(match?.version || "").match(/\d+/)?.[0];
    if (match) return `${name}${major ? ` ${major}` : ""}`;
  }

  const userAgent = String(navigatorLike.userAgent || "");
  const edge = userAgent.match(/Edg\/(\d+)/);
  if (edge) return `Microsoft Edge ${edge[1]}`;
  const chrome = userAgent.match(/Chrome\/(\d+)/);
  if (chrome) return `Google Chrome ${chrome[1]}`;
  return "Chromium";
}

export function platformLabel(platformInfo = {}, navigatorLike = {}) {
  const mapped = {
    mac: "macOS",
    win: "Windows",
    android: "Android",
    cros: "ChromeOS",
    linux: "Linux",
    openbsd: "OpenBSD"
  }[platformInfo?.os];
  if (mapped) return mapped;

  const platform = String(navigatorLike.userAgentData?.platform || navigatorLike.platform || "");
  if (/mac/i.test(platform)) return "macOS";
  if (/win/i.test(platform)) return "Windows";
  if (/android/i.test(platform)) return "Android";
  if (/linux/i.test(platform)) return "Linux";
  return "未知";
}

export function buildSafeFeedback({
  version,
  platform,
  browser,
  status,
  stage,
  errorCode,
  savedImages,
  failedImages,
  totalImages,
  unsupportedMediaCount,
  contentLossCount
} = {}) {
  const saved = safeCount(savedImages);
  const failed = safeCount(failedImages);
  const total = Math.max(safeCount(totalImages), saved + failed);
  const unsupported = safeCount(unsupportedMediaCount);
  const contentLoss = safeCount(contentLossCount);
  const safeCode = safeInternalLabel(errorCode, "无", 32);

  return [
    "拾光存档安全反馈",
    `版本：${safeInternalLabel(version, "未知", 16)}`,
    `平台：${safeInternalLabel(platform, "未知", 24)}`,
    `浏览器：${safeInternalLabel(browser, "Chromium", 40)}`,
    `状态：${STATUS_LABELS[status] || "未知"}`,
    `阶段：${STAGE_LABELS[stage] || "未知"}`,
    `错误编号：${safeCode}`,
    `图片：共 ${total} 张，已保存 ${saved} 张，失败 ${failed} 张`,
    `内容损失：互动组件 ${unsupported} 处，结构 ${contentLoss} 处`,
    "隐私：未包含文章标题、公众号、正文、完整网址、Cookie、文件名或任务标识。"
  ].join("\n");
}

export function openDownloadFromUserGesture(downloadsApi, downloadId, onResult = () => {}) {
  if (!Number.isInteger(downloadId)) {
    onResult({ opened: false, fallbackShown: false, reason: "invalid-download-id" });
    return;
  }

  const showFallback = (reason) => {
    let showAttempt;
    try {
      showAttempt = downloadsApi.show(downloadId);
    } catch {
      onResult({ opened: false, fallbackShown: false, reason });
      return;
    }
    Promise.resolve(showAttempt).then(
      () => onResult({ opened: false, fallbackShown: true, reason }),
      () => onResult({ opened: false, fallbackShown: false, reason })
    );
  };

  let openAttempt;
  try {
    // downloads.open must be initiated synchronously from the user's click handler.
    openAttempt = downloadsApi.open(downloadId);
  } catch {
    showFallback("open-threw");
    return;
  }

  Promise.resolve(openAttempt).then(
    () => onResult({ opened: true, fallbackShown: false, reason: "opened" }),
    () => showFallback("open-rejected")
  );
}
