// SPDX-License-Identifier: MPL-2.0

import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { friendGuideFilename } from "./build.mjs";

export const friendExtensionDirectory = "shiguang-archive-extension";

export async function stageFriendPackage({ extensionDir, guidePath, destination }) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await Promise.all([
    cp(extensionDir, path.join(destination, friendExtensionDirectory), { recursive: true }),
    cp(guidePath, path.join(destination, friendGuideFilename))
  ]);
  return {
    root: destination,
    guidePath: path.join(destination, friendGuideFilename),
    extensionPath: path.join(destination, friendExtensionDirectory)
  };
}
