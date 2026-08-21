// SPDX-License-Identifier: MPL-2.0

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const toolsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readQuotedVersion(source, pattern, label) {
  const version = source.match(pattern)?.[1];
  if (!version) throw new Error(`无法从 ${label} 读取版本号`);
  return version;
}

export async function readVersionState(root = toolsRoot) {
  const [manifestSource, packageSource, policySource, installSource, privacySource] = await Promise.all([
    readFile(path.join(root, "manifest.json"), "utf8"),
    readFile(path.join(root, "package.json"), "utf8"),
    readFile(path.join(root, "src/shared/policy.js"), "utf8"),
    readFile(path.join(root, "INSTALL-FIRST.md"), "utf8"),
    readFile(path.join(root, "pages/privacy.html"), "utf8")
  ]);

  const manifest = JSON.parse(manifestSource);
  const packageJson = JSON.parse(packageSource);
  return {
    manifest: manifest.version,
    package: packageJson.version,
    policy: readQuotedVersion(
      policySource,
      /EXTENSION_VERSION\s*=\s*["']([^"']+)["']/,
      "src/shared/policy.js"
    ),
    install: readQuotedVersion(installSource, /拾光存档\s+([0-9]+\.[0-9]+\.[0-9]+)/, "INSTALL-FIRST.md"),
    privacy: readQuotedVersion(privacySource, /拾光存档\s+([0-9]+\.[0-9]+\.[0-9]+)/, "pages/privacy.html")
  };
}

export async function assertVersionConsistency(root = toolsRoot) {
  const versions = await readVersionState(root);
  const expected = versions.manifest;
  const mismatches = Object.entries(versions).filter(([, version]) => version !== expected);
  if (mismatches.length) {
    const detail = Object.entries(versions)
      .map(([source, version]) => `${source}=${version}`)
      .join(", ");
    throw new Error(`版本号不一致（manifest.json 为发布版本单一来源）：${detail}`);
  }
  return expected;
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const version = await assertVersionConsistency();
  console.log(`版本一致：${version}`);
}
