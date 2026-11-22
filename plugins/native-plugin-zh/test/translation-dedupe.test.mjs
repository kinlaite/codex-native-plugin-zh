import assert from "node:assert/strict";
import test from "node:test";

const { applyTranslatedItems, groupTranslationItems } = await import(
  "../lib/sync.mjs"
);

function item(overrides) {
  return {
    id: `${overrides.key}|${overrides.field}`,
    key: overrides.key,
    marketplace: "test",
    pluginName: overrides.key,
    field: overrides.field,
    source: overrides.source,
    sourceHash: overrides.sourceHash,
  };
}

test("identical English text is sent to the translator once", () => {
  const groups = groupTranslationItems([
    item({ key: "alpha", field: "displayName", source: "Shared label", sourceHash: "h1" }),
    item({ key: "beta", field: "displayName", source: "Shared label", sourceHash: "h1" }),
    item({ key: "gamma", field: "shortDescription", source: "Other label", sourceHash: "h2" }),
    item({ key: "delta", field: "shortDescription", source: "已经是中文", sourceHash: "h3" }),
    item({ key: "epsilon", field: "longDescription", source: "   ", sourceHash: "h4" }),
  ]);

  assert.equal(groups.length, 2);
  const shared = groups.find((group) => group.source === "Shared label");
  assert.ok(shared);
  assert.equal(shared.aliases.length, 2);
  assert.deepEqual(
    shared.aliases.map((alias) => alias.key),
    ["alpha", "beta"],
  );
});

test("one translation is applied to every alias sharing the source", () => {
  const groups = groupTranslationItems([
    item({ key: "alpha", field: "displayName", source: "Shared label", sourceHash: "h1" }),
    item({ key: "beta", field: "displayName", source: "Shared label", sourceHash: "h1" }),
    item({ key: "gamma", field: "shortDescription", source: "Other label", sourceHash: "h2" }),
  ]);
  const shared = groups.find((group) => group.source === "Shared label");
  const other = groups.find((group) => group.source === "Other label");
  const pack = { schemaVersion: 1, plugins: {} };

  const applied = applyTranslatedItems(pack, groups, [
    { id: shared.id, text: "共享标签" },
    { id: other.id, translation: "其他标签" },
  ]);

  assert.deepEqual(applied, { translated: 3, failed: 0 });
  assert.equal(pack.plugins.alpha.displayName.text, "共享标签");
  assert.equal(pack.plugins.beta.displayName.text, "共享标签");
  assert.equal(pack.plugins.gamma.shortDescription.text, "其他标签");
  assert.equal(pack.plugins.alpha.displayName.sourceHash, "h1");
});

test("missing translations fail all aliases in the group", () => {
  const groups = groupTranslationItems([
    item({ key: "alpha", field: "displayName", source: "Shared label", sourceHash: "h1" }),
    item({ key: "beta", field: "displayName", source: "Shared label", sourceHash: "h1" }),
  ]);
  const pack = { schemaVersion: 1, plugins: {} };

  const applied = applyTranslatedItems(pack, groups, []);

  assert.deepEqual(applied, { translated: 0, failed: 2 });
  assert.deepEqual(pack.plugins, {});
});
