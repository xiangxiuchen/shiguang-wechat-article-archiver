// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildExtension,
  assertFriendInstallGuide,
  friendGuideFilename,
  friendGuideOutput,
  output
} from "./build.mjs";
import { friendExtensionDirectory, stageFriendPackage } from "./friend-package.mjs";
import { createDeterministicZip, extractDeterministicZip } from "./zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(root, "release");

async function testFiles(...directories) {
  const files = [];
  for (const directory of directories) {
    const names = await readdir(path.join(root, "tests", directory));
    files.push(...names
      .filter((name) => name.endsWith(".test.mjs"))
      .sort()
      .map((name) => path.join(root, "tests", directory, name)));
  }
  return files;
}

async function runTests(label, ...directories) {
  const files = await testFiles(...directories);
  console.log(`\n[${label}] ${files.length} 个测试文件`);
  await new Promise((resolve, reject) => {
    const testArgs = ["--test"];
    if (directories.some((directory) => directory === "browser" || directory === "e2e")) {
      testArgs.push("--test-concurrency=1");
    }
    const child = spawn(process.execPath, [...testArgs, ...files], {
      cwd: root,
      env: process.env,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} 失败（${signal || `exit ${code}`}）`));
    });
  });
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function unusedArchivePath(archiveDir, filename) {
  const parsed = path.parse(filename);
  for (let index = 0; ; index += 1) {
    const suffix = index ? `-archived-${index}` : "";
    const candidate = path.join(archiveDir, `${parsed.name}${suffix}${parsed.ext}`);
    if (!(await exists(candidate))) return candidate;
  }
}

async function archivePreviousReleaseFiles(currentNames) {
  const archiveDir = path.join(releaseDir, "archive");
  await mkdir(archiveDir, { recursive: true });
  const entries = await readdir(releaseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".zip") || currentNames.has(entry.name)) continue;
    await rename(
      path.join(releaseDir, entry.name),
      await unusedArchivePath(archiveDir, entry.name)
    );
  }

  for (const metadataName of ["SHA256.txt", "RELEASE-MANIFEST.json"]) {
    const source = path.join(releaseDir, metadataName);
    if (!(await exists(source))) continue;
    const content = await readFile(source, "utf8");
    const previousVersion = content.match(/(?:"version"\s*:\s*"|拾光存档\s+)(\d+\.\d+\.\d+)/)?.[1]
      || "previous";
    const parsed = path.parse(metadataName);
    const archivedName = `${parsed.name}-v${previousVersion}${parsed.ext}`;
    await rename(source, await unusedArchivePath(archiveDir, archivedName));
  }
}

async function verifyExtractedPackage({ directory, version, wrapper = "", friendGuide = false }) {
  const packageRoot = wrapper ? path.join(directory, wrapper) : directory;
  const [manifest, integrity] = await Promise.all([
    readFile(path.join(packageRoot, "manifest.json"), "utf8").then(JSON.parse),
    readFile(path.join(packageRoot, "BUILD-INTEGRITY.json"), "utf8").then(JSON.parse)
  ]);
  if (manifest.version !== version || integrity.version !== version) {
    throw new Error("解包后的 manifest、完整性清单与发布版本不一致");
  }
  for (const [relative, expected] of Object.entries(integrity.files)) {
    const content = await readFile(path.join(packageRoot, ...relative.split("/")));
    if (sha256(content) !== expected) throw new Error(`解包哈希不匹配：${relative}`);
  }
  if (friendGuide) {
    const guide = await readFile(path.join(directory, friendGuideFilename), "utf8");
    assertFriendInstallGuide(guide, version);
  }
}

await runTests("单元与契约测试", "unit", "contract");
const { version } = await buildExtension();
await runTests("最终构建浏览器测试", "browser", "e2e");
await mkdir(releaseDir, { recursive: true });

const friendName = `拾光存档-v${version}-朋友测试版.zip`;
const storeName = `拾光存档-v${version}-Chrome-Web-Store.zip`;
const friendPath = path.join(releaseDir, friendName);
const storePath = path.join(releaseDir, storeName);
const wrapper = friendExtensionDirectory;
await archivePreviousReleaseFiles(new Set([friendName, storeName]));

const friendStagingRoot = await mkdtemp(path.join(os.tmpdir(), "shiguang-friend-package-"));
let friend;
try {
  await stageFriendPackage({
    extensionDir: output,
    guidePath: friendGuideOutput,
    destination: path.join(friendStagingRoot, "package")
  });
  friend = await createDeterministicZip({
    sourceDir: path.join(friendStagingRoot, "package"),
    destination: friendPath
  });
} finally {
  await rm(friendStagingRoot, { recursive: true, force: true });
}
const store = await createDeterministicZip({
  sourceDir: output,
  destination: storePath
});

const verifyRoot = await mkdtemp(path.join(os.tmpdir(), "shiguang-release-verify-"));
try {
  const friendExtracted = path.join(verifyRoot, "friend");
  const storeExtracted = path.join(verifyRoot, "store");
  await extractDeterministicZip(friendPath, friendExtracted);
  await extractDeterministicZip(storePath, storeExtracted);
  await verifyExtractedPackage({ directory: friendExtracted, version, wrapper, friendGuide: true });
  await verifyExtractedPackage({ directory: storeExtracted, version });
} finally {
  await rm(verifyRoot, { recursive: true, force: true });
}

const releaseManifest = {
  formatVersion: 1,
  product: "拾光存档",
  version,
  packages: {
    friend: {
      file: friendName,
      sha256: friend.sha256,
      manifestPath: `${wrapper}/manifest.json`,
      guidePath: friendGuideFilename
    },
    chromeWebStore: { file: storeName, sha256: store.sha256, manifestPath: "manifest.json" }
  }
};
await writeFile(
  path.join(releaseDir, "RELEASE-MANIFEST.json"),
  `${JSON.stringify(releaseManifest, null, 2)}\n`,
  "utf8"
);
await writeFile(
  path.join(releaseDir, "SHA256.txt"),
  [
    `拾光存档 ${version} 可重复发布校验`,
    "",
    `${friend.sha256}  ${friendName}`,
    `${store.sha256}  ${storeName}`,
    ""
  ].join("\n"),
  "utf8"
);

await runTests("发布包测试", "release");
console.log(`\n发布完成：${releaseDir}`);
console.log(`朋友测试版：${friendName}`);
console.log(`Chrome 商店版：${storeName}`);
