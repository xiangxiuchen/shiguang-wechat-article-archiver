// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertVersionConsistency, readVersionState } from "../../tools/version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("manifest 是发布版本单一来源，所有用户可见版本必须一致", async () => {
  const versions = await readVersionState(root);
  assert.equal(await assertVersionConsistency(root), versions.manifest);
  assert.deepEqual(new Set(Object.values(versions)), new Set([versions.manifest]));
});
