import assert from "node:assert/strict";
import test from "node:test";

import { hasHan, normalizeFsPath, sha256 } from "../lib/paths.mjs";
import { shouldRefreshField } from "../lib/storage.mjs";

test("detects Chinese source text", () => {
  assert.equal(hasHan("Browser"), false);
  assert.equal(hasHan("原生插件中文化"), true);
});

test("normalizes extended Windows paths", () => {
  assert.equal(
    normalizeFsPath("\\\\?\\C:\\Users\\Admin\\.codex\\plugins"),
    "C:\\Users\\Admin\\.codex\\plugins",
  );
});

test("keeps source hash when the manifest already contains cached Chinese", () => {
  const source = "Control the in-app browser";
  const previous = {
    source,
    sourceHash: sha256(source),
    translation: "控制应用内浏览器",
    originalPresent: true,
    originalValue: source,
  };
  const refreshed = shouldRefreshField(
    previous,
    "控制应用内浏览器",
    {},
    "shortDescription",
  );
  assert.equal(refreshed.changed, false);
  assert.equal(refreshed.source, source);
  assert.equal(refreshed.sourceHash, sha256(source));
});

test("marks changed English as requiring a new translation", () => {
  const previous = {
    source: "Old source",
    sourceHash: sha256("Old source"),
    translation: "旧文本",
    originalPresent: true,
    originalValue: "Old source",
  };
  const refreshed = shouldRefreshField(previous, "New source", {}, "longDescription");
  assert.equal(refreshed.changed, true);
  assert.equal(refreshed.sourceHash, sha256("New source"));
});
