import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  TianClipCoreError,
  computeTianClipCoreSha256,
  loadTianClipCore,
  loadTianClipCoreFromEnv,
} from "../index.js";

const referencePaths = [
  "references/private-core-model.md",
  "references/persona-and-topic-system.md",
  "references/editing-playbook.md",
  "references/duration-calibration.md",
  "references/full-production-rules-v1.1.md",
  "references/candidate-generation-and-validation-v1.md",
  "references/chat-and-sales-rules-v1.1.md",
  "references/evidence-version-policy.md",
  "references/risk-and-quality.md",
  "references/service-runtime-contract.md",
];

const manifestRequiredReferences = [
  "references/private-core-model.md",
  "references/full-production-rules-v1.1.md",
  "references/candidate-generation-and-validation-v1.md",
  "references/chat-and-sales-rules-v1.1.md",
  "references/evidence-version-policy.md",
  "references/risk-and-quality.md",
  "references/service-runtime-contract.md",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function manifest(overrides = {}) {
  return {
    core_id: "synthetic-tzcore",
    name: "synthetic-tianclip-test-core",
    version: "1.2.0-test.1",
    release_status: "test",
    schema_version: "1.1.0",
    fact_schema_version: "1.0.0",
    ledger_schema_version: "1.0.0",
    prompt_version: "1.2.0-test",
    minimum_backend_version: "1.1.0",
    modes: ["chat", "sales"],
    candidate_count_policy: "natural_no_target_no_padding",
    fail_closed: true,
    required_private_references: manifestRequiredReferences,
    fact_layer_schema: "schemas/fact-layer.json",
    engine_run_ledger_schema: "schemas/engine-ledger.json",
    output_schema: "schemas/edit-plan.json",
    owner_only: true,
    public_repository_allowed: false,
    ...overrides,
  };
}

function schemaFixtures() {
  const metadataProperties = {
    core_version: { type: "string" },
    core_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    prompt_version: { type: "string" },
    mode: { enum: ["chat", "sales"] },
  };
  return {
    "schemas/fact-layer.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:synthetic:fact:1.0.0",
      type: "object",
      additionalProperties: false,
      required: ["fact_schema_version", "project_id"],
      properties: {
        fact_schema_version: { const: "1.0.0" },
        project_id: { type: "string", minLength: 1 },
      },
    },
    "schemas/engine-ledger.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:synthetic:ledger:1.0.0",
      type: "object",
      additionalProperties: false,
      required: ["ledger_schema_version", "run_metadata"],
      properties: {
        ledger_schema_version: { const: "1.0.0" },
        run_metadata: {
          type: "object",
          additionalProperties: false,
          required: [
            "core_version",
            "core_sha256",
            "prompt_version",
            "fact_schema_version",
            "ledger_schema_version",
            "edit_plan_schema_version",
            "mode",
          ],
          properties: {
            ...metadataProperties,
            fact_schema_version: { const: "1.0.0" },
            ledger_schema_version: { const: "1.0.0" },
            edit_plan_schema_version: { const: "1.1.0" },
          },
        },
      },
    },
    "schemas/edit-plan.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:synthetic:edit:1.1.0",
      type: "object",
      additionalProperties: false,
      required: ["run_metadata"],
      properties: {
        run_metadata: {
          type: "object",
          additionalProperties: false,
          required: [
            "core_version",
            "core_sha256",
            "prompt_version",
            "schema_version",
            "mode",
          ],
          properties: {
            ...metadataProperties,
            schema_version: { const: "1.1.0" },
          },
        },
      },
    },
  };
}

function syntheticEntries(manifestOverrides = {}) {
  const entries = new Map();
  entries.set("manifest.json", Buffer.from(JSON.stringify(manifest(manifestOverrides))));
  entries.set("SKILL.md", Buffer.from("# Synthetic test skill\nNo private production content."));
  for (const path of referencePaths) {
    entries.set(path, Buffer.from(`# Synthetic test reference\npath=${path}`));
  }
  for (const [path, schema] of Object.entries(schemaFixtures())) {
    entries.set(path, Buffer.from(JSON.stringify(schema)));
  }
  return entries;
}

async function writeFixtureDirectory(entries) {
  const root = await mkdtemp(join(tmpdir(), "tianclip-core-test-"));
  for (const [path, content] of entries) {
    const destination = join(root, ...path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  return root;
}

function storedZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let localOffset = 0;

  for (const [path, content] of entries) {
    const name = Buffer.from(path);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localChunk = Buffer.concat([local, name, content]);
    localChunks.push(localChunk);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralChunks.push(Buffer.concat([central, name]));
    localOffset += localChunk.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localChunks, centralDirectory, end]);
}

function loadOptions(corePath, expectedSha256, overrides = {}) {
  return {
    corePath,
    expectedSha256,
    expectedVersion: "1.2.0-test.1",
    expectedPromptVersion: "1.2.0-test",
    expectedSchemaVersion: "1.1.0",
    expectedFactSchemaVersion: "1.0.0",
    expectedLedgerSchemaVersion: "1.0.0",
    allowedReleaseStatuses: ["test"],
    mode: "chat",
    ...overrides,
  };
}

function boundLedger(core) {
  return {
    ledger_schema_version: "1.0.0",
    run_metadata: {
      core_version: core.provenance.coreVersion,
      core_sha256: core.provenance.coreSha256,
      prompt_version: core.provenance.promptVersion,
      fact_schema_version: core.provenance.factSchemaVersion,
      ledger_schema_version: core.provenance.ledgerSchemaVersion,
      edit_plan_schema_version: core.provenance.schemaVersion,
      mode: core.provenance.mode,
    },
  };
}

function boundEditPlan(core) {
  return {
    run_metadata: {
      core_version: core.provenance.coreVersion,
      core_sha256: core.provenance.coreSha256,
      prompt_version: core.provenance.promptVersion,
      schema_version: core.provenance.schemaVersion,
      mode: core.provenance.mode,
    },
  };
}

test("loads an external directory, builds provenance, and validates all outputs", async (t) => {
  const root = await writeFixtureDirectory(syntheticEntries());
  t.after(() => rm(root, { recursive: true, force: true }));
  const digest = await computeTianClipCoreSha256(root);
  const core = await loadTianClipCore(loadOptions(root, digest.sha256));

  assert.equal(core.provenance.packageKind, "directory");
  assert.equal(core.provenance.coreHashKind, "canonical_directory_sha256_v1");
  assert.equal(core.provenance.coreSha256, digest.sha256);
  assert.equal(core.provenance.coreVersion, "1.2.0-test.1");
  assert.equal(core.provenance.mode, "chat");
  assert.match(core.prompt.text, /TIANCLIP_PRIVATE_RUNTIME/);
  assert.match(core.prompt.text, /mode=chat/);
  assert.equal(core.prompt.documents.length, referencePaths.length + 1);
  assert.equal(core.prompt.sha256, sha256(core.prompt.text));
  assert.equal(core.provenance.promptBundleSha256, core.prompt.sha256);
  assert.equal(Object.keys(core.provenance.referenceSha256).length, referencePaths.length);

  assert.doesNotThrow(() => core.validators.validateFactLayer({
    fact_schema_version: "1.0.0",
    project_id: "project-1",
  }));
  assert.doesNotThrow(() => core.validators.validateEngineRunLedger(boundLedger(core)));
  assert.doesNotThrow(() => core.validators.validateEditPlan(boundEditPlan(core)));
});

test("loads a .skill ZIP and verifies the raw archive SHA-256", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tianclip-core-zip-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = storedZip(syntheticEntries());
  const archivePath = join(root, "synthetic.skill");
  await writeFile(archivePath, archive);

  const digest = await computeTianClipCoreSha256(archivePath);
  const core = await loadTianClipCore(loadOptions(archivePath, digest.sha256, { mode: "sales" }));

  assert.equal(digest.sha256, sha256(archive));
  assert.equal(core.provenance.packageKind, "skill_zip");
  assert.equal(core.provenance.coreHashKind, "archive_sha256");
  assert.equal(core.provenance.mode, "sales");
  assert.match(core.prompt.text, /mode=sales/);
});

test("environment loader requires path, SHA, and version pins", async () => {
  await assert.rejects(
    loadTianClipCoreFromEnv("chat", {}),
    (error) => error instanceof TianClipCoreError && error.code === "CONFIG_MISSING",
  );
});

test("fails closed on a SHA mismatch before parsing private documents", async (t) => {
  const root = await writeFixtureDirectory(syntheticEntries());
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    loadTianClipCore(loadOptions(root, "0".repeat(64))),
    (error) => error instanceof TianClipCoreError && error.code === "CORE_HASH_MISMATCH",
  );
});

test("fails closed when a mandatory reference is missing", async (t) => {
  const entries = syntheticEntries();
  entries.delete("references/private-core-model.md");
  const root = await writeFixtureDirectory(entries);
  t.after(() => rm(root, { recursive: true, force: true }));
  const digest = await computeTianClipCoreSha256(root);

  await assert.rejects(
    loadTianClipCore(loadOptions(root, digest.sha256)),
    (error) => error instanceof TianClipCoreError && error.code === "CORE_ENTRY_MISSING",
  );
});

test("fails closed on version, mode, and schema-version disagreement", async (t) => {
  const root = await writeFixtureDirectory(syntheticEntries({ modes: ["chat"] }));
  t.after(() => rm(root, { recursive: true, force: true }));
  const digest = await computeTianClipCoreSha256(root);

  await assert.rejects(
    loadTianClipCore(loadOptions(root, digest.sha256, { expectedVersion: "wrong" })),
    (error) => error instanceof TianClipCoreError && error.code === "VERSION_MISMATCH",
  );
  await assert.rejects(
    loadTianClipCore(loadOptions(root, digest.sha256, { mode: "sales" })),
    (error) => error instanceof TianClipCoreError && error.code === "MODE_UNAVAILABLE",
  );
  await assert.rejects(
    loadTianClipCore(loadOptions(root, digest.sha256, { expectedSchemaVersion: "9.9.9" })),
    (error) => error instanceof TianClipCoreError && error.code === "SCHEMA_VERSION_MISMATCH",
  );
});

test("AJV validation and provenance binding both fail closed", async (t) => {
  const root = await writeFixtureDirectory(syntheticEntries());
  t.after(() => rm(root, { recursive: true, force: true }));
  const digest = await computeTianClipCoreSha256(root);
  const core = await loadTianClipCore(loadOptions(root, digest.sha256));

  assert.throws(
    () => core.validators.validateFactLayer({
      fact_schema_version: "1.0.0",
      project_id: "",
    }),
    (error) => error instanceof TianClipCoreError && error.code === "OUTPUT_SCHEMA_INVALID",
  );

  const ledger = boundLedger(core);
  ledger.run_metadata.core_sha256 = "f".repeat(64);
  assert.throws(
    () => core.validators.validateEngineRunLedger(ledger),
    (error) => error instanceof TianClipCoreError
      && error.code === "OUTPUT_PROVENANCE_MISMATCH",
  );

  const plan = boundEditPlan(core);
  plan.run_metadata.mode = "sales";
  assert.throws(
    () => core.validators.validateEditPlan(plan),
    (error) => error instanceof TianClipCoreError
      && error.code === "OUTPUT_PROVENANCE_MISMATCH",
  );
});
