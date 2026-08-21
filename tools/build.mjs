// SPDX-License-Identifier: MPL-2.0

import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertVersionConsistency } from "./version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const output = path.join(root, "dist", "shiguang-archive-extension");
export const friendGuideFilename = "00-先看这里-安装导航.html";
export const friendGuideOutput = path.join(root, "dist", "friend-package", friendGuideFilename);
const friendGuideSource = path.join(root, "friend", friendGuideFilename);
const friendGuideVersionToken = "__SHIGUANG_VERSION__";
const include = [
  "manifest.json",
  "src",
  "assets",
  "pages",
  "README.md",
  "INSTALL-FIRST.md",
  "PERMISSIONS.md",
  "KNOWN-LIMITATIONS.md",
  "SUPPORT.md",
  "LICENSE.md",
  "NOTICE.md",
  "TRADEMARKS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md"
];

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function sha256(target) {
  const content = await readFile(target);
  return createHash("sha256").update(content).digest("hex");
}

export function assertFriendInstallGuide(rendered, version) {
  if (rendered.includes(friendGuideVersionToken) || !rendered.includes(`v${version}`)) {
    throw new Error("朋友安装导航版本不正确");
  }
  if (/<script\b[^>]*\bsrc\s*=/i.test(rendered)
      || /<link\b[^>]*\bhref\s*=/i.test(rendered)
      || /https?:\/\//i.test(rendered)
      || /\b(?:fetch|sendBeacon|XMLHttpRequest|WebSocket|EventSource)\s*\(/i.test(rendered)
      || /<iframe\b/i.test(rendered)) {
    throw new Error("朋友安装导航不得包含远程资源、联网调用、外部脚本或 iframe");
  }
}

export function renderFriendInstallGuide(source, version) {
  if (!source.includes(friendGuideVersionToken)) {
    throw new Error(`朋友安装导航缺少版本占位符：${friendGuideVersionToken}`);
  }
  const rendered = source.replaceAll(friendGuideVersionToken, version);
  assertFriendInstallGuide(rendered, version);
  return rendered;
}

export async function buildExtension() {
  const version = await assertVersionConsistency(root);

  await rm(output, { recursive: true, force: true });
  await rm(path.dirname(friendGuideOutput), { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  for (const item of include) {
    const source = path.join(root, item);
    if (!(await exists(source))) throw new Error(`缺少构建文件：${item}`);
    await cp(source, path.join(output, item), { recursive: true });
  }

  const iconSizes = [16, 32, 48, 128];
  for (const size of iconSizes) {
    const icon = path.join(output, "assets", `icon-${size}.png`);
    if (!(await exists(icon))) throw new Error(`缺少图标：assets/icon-${size}.png`);
  }

const runtimeFiles = [
  "manifest.json",
  "src/shared/policy.js",
  "src/shared/download-state.js",
  "src/shared/job-state.js",
  "src/shared/archive.js",
  "src/content/extractor-core.js",
  "src/content/content-script.js",
  "src/background/service-worker.js",
  "src/offscreen/offscreen.html",
  "src/offscreen/offscreen.js",
  "src/popup/popup.html",
  "src/popup/popup.css",
  "src/popup/popup.js",
  "src/popup/popup-helpers.js",
  "pages/welcome.html",
  "pages/welcome.css",
  "pages/privacy.html"
];

  const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
  if (manifest.version !== version) throw new Error("构建目录版本与发布版本不一致");
  const files = {};
  for (const relative of runtimeFiles) {
    files[relative] = await sha256(path.join(output, relative));
  }
  for (const size of iconSizes) {
    const relative = `assets/icon-${size}.png`;
    files[relative] = await sha256(path.join(output, relative));
  }

  await writeFile(
    path.join(output, "BUILD-INTEGRITY.json"),
    `${JSON.stringify({
      formatVersion: 1,
      product: manifest.name,
      version: manifest.version,
      modelCalls: 0,
      telemetryEndpoints: [],
      files
    }, null, 2)}\n`,
    "utf8"
  );

  const guideSource = await readFile(friendGuideSource, "utf8");
  const renderedGuide = renderFriendInstallGuide(guideSource, version);
  await mkdir(path.dirname(friendGuideOutput), { recursive: true });
  await writeFile(friendGuideOutput, renderedGuide, "utf8");

  console.log(`构建完成：${output}`);
  console.log(`朋友安装导航：${friendGuideOutput}`);
  return { output, version, friendGuideOutput };
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) await buildExtension();
