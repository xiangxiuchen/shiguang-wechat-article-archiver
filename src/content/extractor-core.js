// SPDX-License-Identifier: MPL-2.0

(() => {
  if (globalThis.ShiguangExtractorCore) return;

  const MAX_BODY_NODES = 25_000;
  const MAX_IMAGES = 100;
  const ARTICLE_HOST = "mp.weixin.qq.com";
  const IMAGE_HOST = "mmbiz.qpic.cn";

  const ALLOWED_TAGS = new Set([
    "A",
    "ABBR",
    "ARTICLE",
    "B",
    "BLOCKQUOTE",
    "BR",
    "CODE",
    "DEL",
    "DIV",
    "EM",
    "FIGCAPTION",
    "FIGURE",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HR",
    "I",
    "IMG",
    "LI",
    "OL",
    "P",
    "PRE",
    "S",
    "SECTION",
    "SPAN",
    "STRONG",
    "SUB",
    "SUP",
    "TABLE",
    "TBODY",
    "TD",
    "TFOOT",
    "TH",
    "THEAD",
    "TR",
    "U",
    "UL"
  ]);

  const DROP_WITH_CONTENT = new Set([
    "BASE",
    "CANVAS",
    "EMBED",
    "FORM",
    "IFRAME",
    "INPUT",
    "LINK",
    "MATH",
    "META",
    "NOSCRIPT",
    "OBJECT",
    "OPTION",
    "SCRIPT",
    "SELECT",
    "SOURCE",
    "STYLE",
    "SVG",
    "TEMPLATE",
    "TEXTAREA"
  ]);

  const DROPPED_MARKUP_TAGS = new Set([
    "FORM",
    "INPUT",
    "NOSCRIPT",
    "OPTION",
    "SELECT",
    "TEMPLATE",
    "TEXTAREA"
  ]);

  const MEDIA_SELECTOR = [
    "audio",
    "video",
    "iframe",
    "mpvoice",
    "mp-common-audio",
    "mp-common-videosnap",
    "mp-common-profile",
    "mp-miniprogram"
  ].join(",");

  const ALLOWED_STYLE_PROPERTIES = [
    "background-color",
    "border",
    "border-bottom",
    "border-bottom-color",
    "border-bottom-style",
    "border-bottom-width",
    "border-color",
    "border-left",
    "border-left-color",
    "border-left-style",
    "border-left-width",
    "border-radius",
    "border-right",
    "border-right-color",
    "border-right-style",
    "border-right-width",
    "border-style",
    "border-top",
    "border-top-color",
    "border-top-style",
    "border-top-width",
    "border-width",
    "color",
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "height",
    "letter-spacing",
    "line-height",
    "margin",
    "margin-bottom",
    "margin-left",
    "margin-right",
    "margin-top",
    "max-width",
    "padding",
    "padding-bottom",
    "padding-left",
    "padding-right",
    "padding-top",
    "text-align",
    "text-decoration",
    "text-indent",
    "vertical-align",
    "white-space",
    "width",
    "word-break"
  ];

  const DANGEROUS_CSS = /url\s*\(|expression\s*\(|@import|javascript\s*:|data\s*:|file\s*:|blob\s*:|var\s*\(|behavior\s*:|-moz-binding/i;
  const VISUAL_TAGS = new Set(["CANVAS", "EMBED", "MATH", "OBJECT", "SVG"]);
  const LOSS_LABELS = Object.freeze({
    "css-background-image": "CSS 背景图",
    "complex-layout": "Flex/Grid 等复杂布局",
    "visual-effect": "裁切、滤镜或变换效果",
    "unsupported-visual": "SVG、Canvas 或嵌入式视觉内容",
    "custom-component": "未支持的自定义组件",
    "dropped-markup": "表单、模板或其他特殊结构内容"
  });

  function cleanText(value, maxLength = 240) {
    return String(value ?? "")
      .normalize("NFKC")
      .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLength);
  }

  function assertArticlePage(locationHref = location.href) {
    let url;
    try {
      url = new URL(locationHref);
    } catch {
      throw Object.assign(new Error("链接格式无效"), { code: "SL-PAGE-01" });
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== ARTICLE_HOST ||
      url.port ||
      url.username ||
      url.password ||
      !(url.pathname === "/s" || url.pathname.startsWith("/s/"))
    ) {
      throw Object.assign(new Error("请先打开一篇公开公众号文章"), {
        code: "SL-PAGE-02"
      });
    }
    return url;
  }

  function findArticleRoot(root = document) {
    return (
      root.querySelector("#js_content") ||
      root.querySelector(".rich_media_content")
    );
  }

  function firstText(selectors, root = document) {
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      const value = cleanText(element?.textContent, 240);
      if (value) return value;
    }
    return "";
  }

  function metaContent(selectors, root = document) {
    for (const selector of selectors) {
      const value = cleanText(root.querySelector(selector)?.content, 240);
      if (value) return value;
    }
    return "";
  }

  function metadata(root = document) {
    const title =
      firstText(["#activity-name", ".rich_media_title"], root) ||
      metaContent(['meta[property="og:title"]'], root) ||
      cleanText(root.title, 240).replace(/\s*[-_｜|]\s*微信公众平台\s*$/i, "");
    const account =
      firstText(
        [
          "#js_name",
          ".rich_media_meta_nickname",
          "#js_profile_qrcode .profile_nickname"
        ],
        root
      ) || metaContent(['meta[property="og:site_name"]'], root);
    const publishTime =
      firstText(["#publish_time", ".rich_media_meta_text"], root) ||
      metaContent(['meta[property="article:published_time"]'], root);
    const author = firstText(
      ["#js_author_name", ".rich_media_meta.rich_media_meta_text"],
      root
    );
    return {
      title: title || "未命名文章",
      account: account || "未知公众号",
      publishTime,
      author
    };
  }

  function countNodes(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ALL);
    let count = 0;
    while (walker.nextNode()) {
      count += 1;
      if (count > MAX_BODY_NODES) break;
    }
    return count;
  }

  function resolveImageCandidate(image) {
    const candidates = ["data-src", "data-original", "data-backsrc", "src"]
      .map((name) => image.getAttribute(name))
      .filter(Boolean);
    for (const candidate of candidates) {
      if (candidate.startsWith("data:")) continue;
      try {
        const absolute = new URL(candidate, location.href);
        if (absolute.protocol === "http:" && absolute.hostname === IMAGE_HOST) {
          absolute.protocol = "https:";
        }
        if (
          absolute.protocol !== "https:" ||
          absolute.hostname !== IMAGE_HOST ||
          absolute.port ||
          absolute.username ||
          absolute.password
        ) {
          continue;
        }
        absolute.hash = "";
        return absolute.href;
      } catch {
        // Keep checking lower-priority lazy-load attributes.
      }
    }
    return null;
  }

  function countImages(root) {
    const unique = new Set();
    let unsupported = 0;
    for (const image of root.querySelectorAll("img")) {
      const url = resolveImageCandidate(image);
      if (url) unique.add(url);
      else unsupported += 1;
    }
    return { imageCount: unique.size, unsupportedImageCount: unsupported };
  }

  function sanitizeStyle(style) {
    const declarations = [];
    for (const property of ALLOWED_STYLE_PROPERTIES) {
      const value = style.getPropertyValue(property).trim();
      if (!value || value.length > 220 || DANGEROUS_CSS.test(value)) continue;
      const priority = style.getPropertyPriority(property) === "important" ? " !important" : "";
      declarations.push(`${property}:${value}${priority}`);
    }
    return declarations.join(";");
  }

  function safeLink(value) {
    if (!value) return null;
    try {
      const url = new URL(value, location.href);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password
      ) {
        return null;
      }
      url.hash = "";
      return url.href;
    } catch {
      return null;
    }
  }

  function unwrap(element) {
    const parent = element.parentNode;
    if (!parent) return;
    while (element.firstChild) parent.insertBefore(element.firstChild, element);
    element.remove();
  }

  function createMediaPlaceholder() {
    const placeholder = document.createElement("p");
    placeholder.textContent = "此处为音视频或互动内容，请返回原文查看。";
    placeholder.setAttribute("data-shiguang-media-placeholder", "true");
    return placeholder;
  }

  function createVisualPlaceholder() {
    const placeholder = document.createElement("p");
    placeholder.textContent = "此处的图形或特殊视觉内容无法安全离线保留，请返回原文查看。";
    placeholder.setAttribute("data-shiguang-visual-placeholder", "true");
    return placeholder;
  }

  function hasDroppedMarkupContent(element, tagName) {
    if (!DROPPED_MARKUP_TAGS.has(tagName)) return false;
    const contentRoot = tagName === "TEMPLATE" && element.content
      ? element.content
      : element;
    if (cleanText(contentRoot.textContent, 1)) return true;
    if (contentRoot.querySelector?.("*")) return true;
    return Boolean(cleanText(
      element.getAttribute("value") ||
      element.getAttribute("placeholder") ||
      element.getAttribute("aria-label"),
      1
    ));
  }

  function addLoss(losses, type, count = 1) {
    if (!count || !LOSS_LABELS[type]) return;
    losses.set(type, (losses.get(type) || 0) + count);
  }

  function lossManifestFromMap(losses) {
    return Array.from(losses, ([type, count]) => ({
      type,
      label: LOSS_LABELS[type],
      count
    }));
  }

  function inspectComputedVisualLosses(articleRoot) {
    const losses = new Map();
    const view = articleRoot.ownerDocument?.defaultView;
    if (!view?.getComputedStyle) return losses;
    for (const element of [articleRoot, ...articleRoot.querySelectorAll("*")]) {
      if (!(element instanceof Element)) continue;
      let style;
      try {
        style = view.getComputedStyle(element);
      } catch {
        continue;
      }
      const inlineBackground = element.style?.backgroundImage;
      if (
        (element === articleRoot || !inlineBackground) &&
        style.backgroundImage &&
        style.backgroundImage !== "none"
      ) {
        addLoss(losses, "css-background-image");
      }
      if (["flex", "inline-flex", "grid", "inline-grid"].includes(style.display)) {
        addLoss(losses, "complex-layout");
      }
      if (
        (style.transform && style.transform !== "none") ||
        (style.filter && style.filter !== "none") ||
        (style.clipPath && style.clipPath !== "none") ||
        (style.maskImage && style.maskImage !== "none")
      ) {
        addLoss(losses, "visual-effect");
      }
    }
    return losses;
  }

  function mergeLosses(target, source) {
    for (const [type, count] of source) addLoss(target, type, count);
    return target;
  }

  function sanitizeClone(clone) {
    let unsupportedMediaCount = 0;
    for (const media of Array.from(clone.querySelectorAll(MEDIA_SELECTOR))) {
      if (!media.parentNode) continue;
      media.replaceWith(createMediaPlaceholder());
      unsupportedMediaCount += 1;
    }

    const imageIdsByUrl = new Map();
    const images = [];
    let nextImageId = 1;
    const losses = new Map();

    for (const element of Array.from(clone.querySelectorAll("*"))) {
      if (!element.parentNode || !clone.contains(element)) continue;
      const tagName = String(element.tagName || "").toUpperCase();

      if (!ALLOWED_TAGS.has(tagName)) {
        if (VISUAL_TAGS.has(tagName)) {
          element.replaceWith(createVisualPlaceholder());
          addLoss(losses, "unsupported-visual");
        } else if (tagName.includes("-")) {
          element.replaceWith(createVisualPlaceholder());
          addLoss(losses, "custom-component");
        } else if (DROP_WITH_CONTENT.has(tagName)) {
          if (hasDroppedMarkupContent(element, tagName)) {
            addLoss(losses, "dropped-markup");
          }
          element.remove();
        } else unwrap(element);
        continue;
      }

      if (element.style?.backgroundImage && element.style.backgroundImage !== "none") {
        addLoss(losses, "css-background-image");
      }

      const safeStyle = sanitizeStyle(element.style);
      const href = tagName === "A" ? safeLink(element.getAttribute("href")) : null;
      const imageUrl = tagName === "IMG" ? resolveImageCandidate(element) : null;
      const alt = tagName === "IMG" ? cleanText(element.getAttribute("alt"), 180) : "";
      const colSpan = ["TD", "TH"].includes(tagName)
        ? Number.parseInt(element.getAttribute("colspan"), 10)
        : NaN;
      const rowSpan = ["TD", "TH"].includes(tagName)
        ? Number.parseInt(element.getAttribute("rowspan"), 10)
        : NaN;
      const listStart = tagName === "OL"
        ? Number.parseInt(element.getAttribute("start"), 10)
        : NaN;

      for (const attribute of element.getAttributeNames()) {
        element.removeAttribute(attribute);
      }
      if (safeStyle) element.setAttribute("style", safeStyle);

      if (tagName === "A" && href) {
        element.setAttribute("href", href);
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer");
      }

      if (tagName === "IMG") {
        let id;
        if (imageUrl && imageIdsByUrl.has(imageUrl)) {
          id = imageIdsByUrl.get(imageUrl);
        } else {
          id = `sg-img-${nextImageId++}`;
          if (imageUrl && images.length < MAX_IMAGES) {
            imageIdsByUrl.set(imageUrl, id);
            images.push({ id, url: imageUrl, alt: alt || `文章图片 ${images.length + 1}` });
          }
        }
        element.setAttribute("data-shiguang-image", id);
        element.setAttribute("alt", alt);
      }

      if (Number.isInteger(colSpan) && colSpan >= 1 && colSpan <= 20) {
        element.setAttribute("colspan", String(colSpan));
      }
      if (Number.isInteger(rowSpan) && rowSpan >= 1 && rowSpan <= 100) {
        element.setAttribute("rowspan", String(rowSpan));
      }
      if (Number.isInteger(listStart) && Math.abs(listStart) <= 10_000) {
        element.setAttribute("start", String(listStart));
      }
    }

    return { images, unsupportedMediaCount, losses };
  }

  function analyze(root = document) {
    assertArticlePage(root.location?.href || location.href);
    const articleRoot = findArticleRoot(root);
    const hasArchivableVisual = Boolean(articleRoot && (
      articleRoot.querySelector("img,svg,canvas,object,embed,math") ||
      articleRoot.querySelector(MEDIA_SELECTOR) ||
      Array.from(articleRoot.querySelectorAll("*")).some(
        (element) => String(element.tagName || "").includes("-")
      )
    ));
    if (!articleRoot || (
      !cleanText(articleRoot.textContent, 20) &&
      !hasArchivableVisual
    )) {
      throw Object.assign(new Error("没有识别到可保存的文章正文"), {
        code: "SL-PAGE-03"
      });
    }
    const nodes = countNodes(articleRoot);
    if (nodes > MAX_BODY_NODES) {
      throw Object.assign(new Error("文章结构超过安全上限"), {
        code: "SL-PAGE-04"
      });
    }
    return {
      ...metadata(root),
      ...countImages(articleRoot),
      nodeCount: nodes,
      sourceUrl: root.location?.href || location.href
    };
  }

  function extract(root = document, { includeImages = true } = {}) {
    const summary = analyze(root);
    const articleRoot = findArticleRoot(root);
    const clone = articleRoot.cloneNode(true);
    const computedLosses = inspectComputedVisualLosses(articleRoot);
    const { images, unsupportedMediaCount, losses } = sanitizeClone(clone);
    mergeLosses(losses, computedLosses);
    return {
      ...summary,
      bodyHtml: clone.innerHTML,
      images: includeImages ? images : [],
      unsupportedMediaCount,
      lossManifest: lossManifestFromMap(losses)
    };
  }

  globalThis.ShiguangExtractorCore = Object.freeze({
    analyze,
    extract,
    sanitizeClone,
    assertArticlePage
  });
})();
