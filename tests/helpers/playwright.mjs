// SPDX-License-Identifier: MPL-2.0

import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

export function loadPlaywright(importMetaUrl) {
  const require = createRequire(importMetaUrl);
  try {
    return require("playwright");
  } catch (error) {
    error.message += "\n请先在项目根目录运行 npm ci。";
    throw error;
  }
}

export function resolveChromiumExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
    if (!existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE)) {
      throw new Error("PLAYWRIGHT_CHROMIUM_EXECUTABLE 指向的浏览器不存在");
    }
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  }

  const cacheRoot = process.platform === "darwin"
    ? path.join(os.homedir(), "Library/Caches/ms-playwright")
    : process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || "", "ms-playwright")
      : path.join(os.homedir(), ".cache/ms-playwright");
  if (existsSync(cacheRoot)) {
    const versions = readdirSync(cacheRoot)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((left, right) => Number(right.split("-")[1]) - Number(left.split("-")[1]));
    for (const version of versions) {
      const base = path.join(cacheRoot, version);
      const cachedCandidates = process.platform === "darwin"
        ? [
            path.join(base, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
            path.join(base, "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")
          ]
        : process.platform === "win32"
          ? [path.join(base, "chrome-win64/chrome.exe"), path.join(base, "chrome-win/chrome.exe")]
          : [
              path.join(base, "chrome-linux64/chrome"),
              path.join(base, "chrome-linux/chrome")
            ];
      const cached = cachedCandidates.find((candidate) => existsSync(candidate));
      if (cached) return cached;
    }
  }

  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
      ]
    : process.platform === "win32"
      ? [
          path.join(process.env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
          path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft/Edge/Application/msedge.exe")
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser"
        ];

  return candidates.find((candidate) => candidate && existsSync(candidate));
}
