// SPDX-License-Identifier: MPL-2.0

export const EXTENSION_VERSION = "0.4.0";

export const LIMITS = Object.freeze({
  maxBodyBytes: 2 * 1024 * 1024,
  maxBodyNodes: 25_000,
  maxImages: 100,
  maxImageBytes: 6 * 1024 * 1024,
  maxTotalImageBytes: 24 * 1024 * 1024,
  maxFinalHtmlBytes: 40 * 1024 * 1024,
  maxImageWidth: 16_384,
  maxImageHeight: 16_384,
  maxImagePixels: 40_000_000,
  maxImageFramePixels: 120_000_000,
  maxTotalImagePixels: 120_000_000,
  maxTotalFramePixels: 120_000_000,
  maxAnimatedFrames: 300,
  maxImageUrlLength: 4_096,
  imageConcurrency: 2,
  imageTimeoutMs: 15_000,
  jobTimeoutMs: 90_000,
  downloadHandoffTimeoutMs: 15_000,
  downloadCancelSettleMs: 5_000,
  downloadStatusPollMs: 100,
  downloadTimeoutMs: 120_000,
  finishedJobRetentionMs: 5 * 60_000
});

export const ARTICLE_HOST = "mp.weixin.qq.com";
export const IMAGE_HOST = "mmbiz.qpic.cn";
export const IMAGE_PERMISSION = `https://${IMAGE_HOST}/*`;

const ARTICLE_QUERY_ALLOWLIST = new Set([
  "__biz",
  "mid",
  "idx",
  "sn",
  "chksm"
]);

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

export class ArchivePolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ArchivePolicyError";
    this.code = code;
  }
}

export function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value ?? "")).byteLength;
}

export function cleanText(value, maxLength = 240) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(BIDI_CONTROLS, "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function validateArticleUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new ArchivePolicyError("SL-URL-01", "链接格式无效");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== ARTICLE_HOST ||
    url.port ||
    url.username ||
    url.password ||
    !(url.pathname === "/s" || url.pathname.startsWith("/s/"))
  ) {
    throw new ArchivePolicyError(
      "SL-URL-02",
      "目前仅支持公开公众号文章链接"
    );
  }

  return url;
}

export function canonicalizeArticleUrl(value) {
  const input = validateArticleUrl(value);
  const canonical = new URL(`${input.origin}${input.pathname}`);
  if (input.pathname === "/s") {
    for (const [key, item] of input.searchParams.entries()) {
      if (ARTICLE_QUERY_ALLOWLIST.has(key) && item) {
        canonical.searchParams.append(key, item.slice(0, 512));
      }
    }
  }
  return canonical.href;
}

export function validateImageUrl(value) {
  if (String(value ?? "").length > LIMITS.maxImageUrlLength) {
    throw new ArchivePolicyError("SL-IMG-01", "图片链接过长");
  }

  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new ArchivePolicyError("SL-IMG-02", "图片链接无效");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== IMAGE_HOST ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new ArchivePolicyError("SL-IMG-03", "图片来源不在允许范围内");
  }

  url.hash = "";
  return url;
}

export function detectRasterMime(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return "image/png";
  }
  if (data.length >= 6) {
    const signature = String.fromCharCode(...data.slice(0, 6));
    if (signature === "GIF87a" || signature === "GIF89a") {
      return "image/gif";
    }
  }
  if (
    data.length >= 12 &&
    String.fromCharCode(...data.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...data.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function readUint24LE(data, offset) {
  return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
}

function readUint32BE(data, offset) {
  return (
    data[offset] * 0x1000000 +
    (data[offset + 1] << 16) +
    (data[offset + 2] << 8) +
    data[offset + 3]
  ) >>> 0;
}

function readUint32LE(data, offset) {
  return (
    data[offset] +
    (data[offset + 1] << 8) +
    (data[offset + 2] << 16) +
    data[offset + 3] * 0x1000000
  ) >>> 0;
}

function inspectJpeg(data) {
  let offset = 2;
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
  ]);
  while (offset + 8 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (data[offset] === 0xff) offset += 1;
    const marker = data[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 1 >= data.length) return null;
    const length = (data[offset] << 8) | data[offset + 1];
    if (length < 2 || offset + length > data.length) return null;
    if (startOfFrame.has(marker)) {
      if (length < 7) return null;
      return {
        width: (data[offset + 5] << 8) | data[offset + 6],
        height: (data[offset + 3] << 8) | data[offset + 4],
        frameCount: 1
      };
    }
    offset += length;
  }
  return null;
}

function inspectPng(data) {
  if (data.length < 33 || String.fromCharCode(...data.slice(12, 16)) !== "IHDR") {
    return null;
  }
  const width = readUint32BE(data, 16);
  const height = readUint32BE(data, 20);
  let frameCount = 1;
  let sawEnd = false;
  let offset = 8;
  while (offset + 12 <= data.length) {
    const length = readUint32BE(data, offset);
    if (length > data.length - offset - 12) return null;
    const type = String.fromCharCode(...data.slice(offset + 4, offset + 8));
    if (type === "acTL" && length >= 8) {
      frameCount = Math.max(1, readUint32BE(data, offset + 8));
    }
    offset += 12 + length;
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
  }
  return sawEnd ? { width, height, frameCount } : null;
}

function skipGifSubBlocks(data, start) {
  let offset = start;
  while (offset < data.length) {
    const size = data[offset];
    offset += 1;
    if (size === 0) return offset;
    if (offset + size > data.length) return -1;
    offset += size;
  }
  return -1;
}

function inspectGif(data) {
  if (data.length < 14) return null;
  const width = data[6] | (data[7] << 8);
  const height = data[8] | (data[9] << 8);
  const globalColorTableSize = data[10] & 0x80
    ? 3 * (2 ** ((data[10] & 0x07) + 1))
    : 0;
  let offset = 13 + globalColorTableSize;
  let frameCount = 0;
  while (offset < data.length) {
    const marker = data[offset++];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      if (offset >= data.length) return null;
      offset += 1;
      offset = skipGifSubBlocks(data, offset);
      if (offset < 0) return null;
      continue;
    }
    if (marker !== 0x2c || offset + 9 > data.length) return null;
    const packed = data[offset + 8];
    offset += 9;
    if (packed & 0x80) offset += 3 * (2 ** ((packed & 0x07) + 1));
    if (offset >= data.length) return null;
    offset += 1;
    offset = skipGifSubBlocks(data, offset);
    if (offset < 0) return null;
    frameCount += 1;
  }
  if (!frameCount) return null;
  return { width, height, frameCount };
}

function inspectWebp(data) {
  if (data.length < 20) return null;
  let offset = 12;
  let width = 0;
  let height = 0;
  let animated = false;
  let frameCount = 0;
  while (offset + 8 <= data.length) {
    const type = String.fromCharCode(...data.slice(offset, offset + 4));
    const length = readUint32LE(data, offset + 4);
    const payload = offset + 8;
    if (length > data.length - payload) return null;
    if (type === "VP8X" && length >= 10) {
      animated = Boolean(data[payload] & 0x02);
      width = readUint24LE(data, payload + 4) + 1;
      height = readUint24LE(data, payload + 7) + 1;
    } else if (type === "VP8L" && length >= 5 && data[payload] === 0x2f) {
      width = 1 + data[payload + 1] + ((data[payload + 2] & 0x3f) << 8);
      height = 1 + ((data[payload + 2] >> 6) | (data[payload + 3] << 2) | ((data[payload + 4] & 0x0f) << 10));
    } else if (type === "VP8 " && length >= 10 && data[payload + 3] === 0x9d && data[payload + 4] === 0x01 && data[payload + 5] === 0x2a) {
      width = (data[payload + 6] | (data[payload + 7] << 8)) & 0x3fff;
      height = (data[payload + 8] | (data[payload + 9] << 8)) & 0x3fff;
    } else if (type === "ANMF") {
      frameCount += 1;
    }
    offset = payload + length + (length % 2);
  }
  if (!width || !height || (animated && !frameCount)) return null;
  return { width, height, frameCount: animated ? frameCount : 1 };
}

export function inspectRasterMetadata(bytes, mime = detectRasterMime(bytes)) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (!mime) return null;
  const result = mime === "image/jpeg"
    ? inspectJpeg(data)
    : mime === "image/png"
      ? inspectPng(data)
      : mime === "image/gif"
        ? inspectGif(data)
        : mime === "image/webp"
          ? inspectWebp(data)
          : null;
  if (!result || !result.width || !result.height || !result.frameCount) return null;
  return { mime, ...result };
}

export function assertRasterBudget(metadata) {
  if (
    !metadata ||
    !Number.isSafeInteger(metadata.width) ||
    !Number.isSafeInteger(metadata.height) ||
    !Number.isSafeInteger(metadata.frameCount) ||
    metadata.width <= 0 ||
    metadata.height <= 0 ||
    metadata.frameCount <= 0
  ) {
    throw new ArchivePolicyError("SL-IMG-17", "图片结构损坏或不完整");
  }
  const pixelCount = metadata.width * metadata.height;
  if (
    metadata.width > LIMITS.maxImageWidth ||
    metadata.height > LIMITS.maxImageHeight ||
    pixelCount > LIMITS.maxImagePixels
  ) {
    throw new ArchivePolicyError("SL-IMG-18", "图片尺寸或像素数量超过安全上限");
  }
  if (metadata.frameCount > LIMITS.maxAnimatedFrames) {
    throw new ArchivePolicyError("SL-IMG-19", "动图帧数超过安全上限");
  }
  if (pixelCount * metadata.frameCount > LIMITS.maxImageFramePixels) {
    throw new ArchivePolicyError("SL-IMG-22", "单张动图解码量超过安全上限");
  }
  return metadata;
}

export function assertDecodedRasterBudget(metadata, width, height) {
  const declared = assertRasterBudget(metadata);
  const decoded = { ...declared, width, height };
  if (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width * height > declared.width * declared.height
  ) {
    throw new ArchivePolicyError("SL-IMG-25", "图片解码尺寸与文件声明不一致");
  }
  return assertRasterBudget(decoded);
}

export function createRasterBudget() {
  return { pixelCount: 0, framePixelCount: 0 };
}

export function reserveRasterBudget(budget, metadata) {
  const safeMetadata = assertRasterBudget(metadata);
  if (
    !budget ||
    !Number.isSafeInteger(budget.pixelCount) ||
    !Number.isSafeInteger(budget.framePixelCount) ||
    budget.pixelCount < 0 ||
    budget.framePixelCount < 0
  ) {
    throw new ArchivePolicyError("SL-IMG-17", "图片预算状态无效");
  }

  const pixelCount = safeMetadata.width * safeMetadata.height;
  const framePixelCount = pixelCount * safeMetadata.frameCount;
  const nextPixelCount = budget.pixelCount + pixelCount;
  const nextFramePixelCount = budget.framePixelCount + framePixelCount;
  if (nextPixelCount > LIMITS.maxTotalImagePixels) {
    throw new ArchivePolicyError("SL-IMG-23", "文章图片总像素量超过安全上限");
  }
  if (nextFramePixelCount > LIMITS.maxTotalFramePixels) {
    throw new ArchivePolicyError("SL-IMG-24", "文章图片总解码量超过安全上限");
  }

  // This check-and-reserve path is deliberately synchronous. Concurrent image
  // workers cannot interleave between validation and mutation in one JS realm.
  budget.pixelCount = nextPixelCount;
  budget.framePixelCount = nextFramePixelCount;
  return { pixelCount, framePixelCount };
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (const char of String(value ?? "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function extractDate(value, fallbackDate) {
  const match = String(value ?? "").match(
    /(20\d{2})\s*(?:年|[-/.])\s*(1[0-2]|0?[1-9])\s*(?:月|[-/.])\s*(3[01]|[12]\d|0?[1-9])(?!\d)/
  );
  if (match) {
    return `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`;
  }
  return fallbackDate.toISOString().slice(0, 10);
}

function sanitizeFilenamePart(value, fallback, maxCodePoints) {
  let result = cleanText(value, 320)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[. ]+$/g, "")
    .replace(/^[. ]+/g, "")
    .replace(/_+/g, "_");

  if (!result) result = fallback;
  if (WINDOWS_RESERVED_NAMES.test(result)) result = `_${result}`;
  return Array.from(result).slice(0, maxCodePoints).join("");
}

export function makeArchiveFilename(article, now = new Date()) {
  const date = extractDate(article?.publishTime, now);
  const account = sanitizeFilenamePart(article?.account, "公众号", 20);
  const title = sanitizeFilenamePart(article?.title, "未命名文章", 46);
  const source = canonicalizeArticleUrl(article?.sourceUrl);
  return `${date}_${account}_${title}_${fnv1a(source)}.html`;
}

export function assertArticlePayload(article) {
  if (!article || typeof article !== "object" || Array.isArray(article)) {
    throw new ArchivePolicyError("SL-DATA-01", "文章数据无效");
  }

  const sourceUrl = canonicalizeArticleUrl(article.sourceUrl);
  const bodyHtml = String(article.bodyHtml ?? "");
  if (!bodyHtml.trim()) {
    throw new ArchivePolicyError("SL-DATA-02", "没有识别到文章正文");
  }
  if (utf8ByteLength(bodyHtml) > LIMITS.maxBodyBytes) {
    throw new ArchivePolicyError("SL-DATA-03", "文章正文超过安全上限");
  }

  const images = Array.isArray(article.images) ? article.images : [];
  if (images.length > LIMITS.maxImages) {
    throw new ArchivePolicyError("SL-DATA-04", "文章图片数量超过安全上限");
  }

  const safeImages = images.map((image, index) => {
    if (!image || typeof image !== "object") {
      throw new ArchivePolicyError("SL-DATA-05", "图片数据无效");
    }
    const id = cleanText(image.id, 80);
    if (!/^sg-img-\d+$/.test(id)) {
      throw new ArchivePolicyError("SL-DATA-06", "图片编号无效");
    }
    const url = validateImageUrl(image.url).href;
    return {
      id,
      url,
      alt: cleanText(image.alt || `文章图片 ${index + 1}`, 180)
    };
  });

  const lossManifest = Array.isArray(article.lossManifest)
    ? article.lossManifest.slice(0, 20).map((loss) => {
      if (!loss || typeof loss !== "object") {
        throw new ArchivePolicyError("SL-DATA-07", "内容损失记录无效");
      }
      const type = cleanText(loss.type, 60);
      const label = cleanText(loss.label, 120);
      const count = Math.max(0, Math.min(999, Number.parseInt(loss.count, 10) || 0));
      if (!/^[a-z0-9-]+$/.test(type) || !label || !count) {
        throw new ArchivePolicyError("SL-DATA-07", "内容损失记录无效");
      }
      return { type, label, count };
    })
    : [];

  return {
    sourceUrl,
    title: cleanText(article.title, 240) || "未命名文章",
    account: cleanText(article.account, 120) || "未知公众号",
    author: cleanText(article.author, 120),
    publishTime: cleanText(article.publishTime, 80),
    bodyHtml,
    images: safeImages,
    lossManifest,
    unsupportedMediaCount: Math.max(
      0,
      Math.min(999, Number(article.unsupportedMediaCount) || 0)
    )
  };
}
