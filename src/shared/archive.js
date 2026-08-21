// SPDX-License-Identifier: MPL-2.0

import {
  EXTENSION_VERSION,
  LIMITS,
  escapeHtml,
  makeArchiveFilename,
  utf8ByteLength
} from "./policy.js";

const IMAGE_MARKER_RE = /<img\b([^>]*?)\sdata-shiguang-image="(sg-img-\d+)"([^>]*)>/gi;

function replaceImageMarkers(bodyHtml, imageResults) {
  const byId = new Map(imageResults.map((item) => [item.id, item]));
  return bodyHtml.replace(
    IMAGE_MARKER_RE,
    (_match, before, id, after) => {
      const result = byId.get(id);
      if (result?.ok && result.dataUrl) {
        return `<img${before} src="${result.dataUrl}"${after}>`;
      }
      return [
        '<figure class="sg-missing-image" role="note">',
        '<div class="sg-missing-image__mark" aria-hidden="true">▧</div>',
        "<figcaption>这张图片未能离线保存，请回到原文查看。</figcaption>",
        "</figure>"
      ].join("");
    }
  );
}

function sourceLine(article) {
  return [article.account, article.author, article.publishTime]
    .filter(Boolean)
    .map(escapeHtml)
    .join(" · ");
}

export function buildArchiveHtml(article, imageResults, archivedAt = new Date()) {
  const markerIds = new Set(
    Array.from(article.bodyHtml.matchAll(IMAGE_MARKER_RE), (match) => match[2])
  );
  const body = replaceImageMarkers(article.bodyHtml, imageResults);
  const savedImages = new Set(
    imageResults.filter((item) => item.ok && markerIds.has(item.id)).map((item) => item.id)
  ).size;
  const failedImages = Math.max(0, markerIds.size - savedImages);
  const unsupportedMediaCount = Math.max(0, Number(article.unsupportedMediaCount) || 0);
  const lossManifest = Array.isArray(article.lossManifest)
    ? article.lossManifest
      .filter((loss) => loss && Number(loss.count) > 0)
      .slice(0, 20)
      .map((loss) => ({
        type: String(loss.type || "unknown").slice(0, 60),
        label: String(loss.label || "未支持内容").slice(0, 120),
        count: Math.min(999, Math.max(1, Number.parseInt(loss.count, 10) || 1))
      }))
    : [];
  const contentLossCount = lossManifest.reduce((sum, loss) => sum + loss.count, 0);
  const title = escapeHtml(article.title);
  const sourceUrl = escapeHtml(article.sourceUrl);
  const generatedAt = escapeHtml(
    archivedAt.toLocaleString("zh-CN", { hour12: false })
  );
  const warningParts = [];
  if (failedImages) {
    warningParts.push(`${failedImages} 张图片未能离线保存，已用本地占位提示替代`);
  }
  if (unsupportedMediaCount) {
    warningParts.push(`${unsupportedMediaCount} 个音视频或互动组件未纳入离线文件`);
  }
  for (const loss of lossManifest) {
    warningParts.push(`${loss.count} 处${escapeHtml(loss.label)}未能完整保留`);
  }
  const warning = warningParts.length
    ? `<p class="sg-notice">${warningParts.join("；")}。打开本文不会再次请求远程资源。</p>`
    : "";

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; style-src 'unsafe-inline'">
  <meta name="generator" content="拾光存档 ${EXTENSION_VERSION}">
  <title>${title}</title>
  <style>
    :root{color-scheme:light;--ink:#1d2a25;--muted:#66746e;--green:#1f5a47;--gold:#b89a56;--paper:#f7f4ee;--line:#ddd8ce;--warn:#94621c;--warn-bg:#fff3d6}
    *{box-sizing:border-box}
    html{background:var(--paper)}
    body{margin:0;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.82;background:#fff}
    .sg-shell{max-width:760px;margin:0 auto;padding:44px 28px 72px}
    .sg-archive-head{padding-bottom:24px;margin-bottom:30px;border-bottom:1px solid var(--line)}
    .sg-archive-brand{font-size:13px;letter-spacing:.12em;color:var(--green);font-weight:700}
    h1.sg-title{font-size:30px;line-height:1.38;letter-spacing:-.02em;margin:14px 0 12px;color:var(--ink)}
    .sg-source{font-size:14px;color:var(--muted);margin:0 0 10px}
    .sg-source-link{font-size:13px;color:var(--green);text-underline-offset:3px}
    .sg-notice{margin:18px 0 0;padding:12px 14px;border-left:3px solid var(--warn);background:var(--warn-bg);color:#6c491a;font-size:13px}
    .sg-content{font-size:17px;overflow-wrap:anywhere}
    .sg-content p{margin:0 0 1.2em}
    .sg-content h1,.sg-content h2,.sg-content h3,.sg-content h4,.sg-content h5,.sg-content h6{line-height:1.48;margin:1.8em 0 .8em;color:var(--ink)}
    .sg-content h2{font-size:24px}.sg-content h3{font-size:20px}
    .sg-content img{display:block;max-width:100%!important;height:auto!important;margin:24px auto}
    .sg-content blockquote{margin:1.4em 0;padding:.4em 1em;border-left:4px solid var(--gold);color:#52605a;background:#faf8f3}
    .sg-content pre{overflow:auto;padding:14px;background:#f3f4f2;border-radius:8px}
    .sg-content code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}
    .sg-content table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse;margin:1.4em 0}
    .sg-content th,.sg-content td{border:1px solid var(--line);padding:8px 10px;vertical-align:top}
    .sg-content a{color:var(--green);text-underline-offset:3px}
    .sg-content hr{border:0;border-top:1px solid var(--line);margin:30px 0}
    .sg-missing-image{margin:24px 0;padding:22px;text-align:center;border:1px dashed #d6c7a5;background:#fcfaf5;color:#756548}
    .sg-missing-image__mark{font-size:28px;line-height:1;margin-bottom:8px}
    .sg-missing-image figcaption{font-size:13px}
    .sg-archive-foot{margin-top:46px;padding-top:18px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
    @media(max-width:560px){.sg-shell{padding:28px 18px 52px}h1.sg-title{font-size:25px}.sg-content{font-size:16px}}
    @media print{html{background:#fff}.sg-shell{max-width:none;padding:0}.sg-source-link{color:#333}}
  </style>
</head>
<body>
  <main class="sg-shell">
    <header class="sg-archive-head">
      <div class="sg-archive-brand">拾光存档 · 本地副本</div>
      <h1 class="sg-title">${title}</h1>
      <p class="sg-source">${sourceLine(article)}</p>
      <a class="sg-source-link" href="${sourceUrl}" target="_blank" rel="noopener noreferrer">查看原文</a>
      ${warning}
    </header>
    <article class="sg-content">${body}</article>
    <footer class="sg-archive-foot">存档于 ${generatedAt} · 来源与著作权归原作者 · 拾光存档本地生成 · 0 Token</footer>
  </main>
</body>
</html>`;

  if (utf8ByteLength(html) > LIMITS.maxFinalHtmlBytes) {
    const error = new Error("生成的离线文件超过安全上限");
    error.code = "SL-FILE-01";
    throw error;
  }

  return {
    html,
    filename: makeArchiveFilename(article, archivedAt),
    savedImages,
    failedImages,
    unsupportedMediaCount,
    lossManifest,
    contentLossCount,
    status: failedImages > 0 || unsupportedMediaCount > 0 || contentLossCount > 0
      ? "partial"
      : "success"
  };
}
