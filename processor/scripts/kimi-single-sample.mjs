import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createKimiEditorClient } from "../pipeline/kimi-editor-client.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return resolve(process.argv[index + 1]);
}

const candidatePath = argument("--candidate");
const skillPath = argument("--skill");
const outputPath = argument("--output");

const [candidateRaw, skill] = await Promise.all([
  readFile(candidatePath, "utf8"),
  readFile(skillPath, "utf8"),
]);
const candidate = JSON.parse(candidateRaw);

const client = createKimiEditorClient({
  apiKey: process.env.KIMI_API_KEY,
  baseUrl: process.env.KIMI_BASE_URL,
  model: process.env.KIMI_EDITOR_MODEL ?? "kimi-k3",
  reasoningEffort: process.env.KIMI_REASONING_EFFORT ?? "max",
});

const schema = {
  type: "object",
  additionalProperties: false,
  required: [
    "publishable",
    "title",
    "theme",
    "hook",
    "goldenQuote",
    "startSec",
    "endSec",
    "durationSec",
    "editDecision",
    "reason",
  ],
  properties: {
    publishable: { type: "boolean" },
    title: { type: "string" },
    theme: { type: "string" },
    hook: { type: "string" },
    goldenQuote: { type: "string" },
    startSec: { type: "number", minimum: 0 },
    endSec: { type: "number", minimum: 0 },
    durationSec: { type: "number", minimum: 0 },
    editDecision: { type: "string" },
    reason: { type: "string" },
  },
};

const instructions = `${skill}\n\n## 本次单条验收的硬约束\n`
  + "你不是重新总结整场直播，只终审输入的一个粗剪候选。\n"
  + "所有表达必须是中文。必须有单一主题、前三秒钩子、明确金句和完整收尾。\n"
  + "不能从场外人的半句话开始，不能戛然而止，不能为追求短而破坏因果。\n"
  + "这是粗剪验收，优先保留完整上下文；除非确有口头废话，不要压向时长下限。\n"
  + "startSec/endSec 使用候选文件内部的相对秒数，必须落在输入时长范围内。";

const keepAlive = setInterval(() => undefined, 1_000);
let response;
try {
  response = await client.createStructuredResponse({
    instructions,
    schema,
    schemaName: "tianzong_kimi_single_sample",
    maxOutputTokens: 4_000,
    input: [{
      role: "user",
      content: [{
        type: "input_text",
        text: JSON.stringify(candidate),
      }],
    }],
  });
} finally {
  clearInterval(keepAlive);
}

const decision = response.parsed;
if (
  decision.endSec <= decision.startSec
  || decision.endSec > candidate.durationSec + 0.25
) {
  throw new Error("Kimi returned an invalid sample boundary");
}

const output = {
  provider: "kimi",
  model: response.model,
  usage: response.usage,
  candidateId: candidate.candidateId,
  sourceFile: candidate.sourceFile,
  decision,
  generatedAt: new Date().toISOString(),
};
process.stdout.write(`${JSON.stringify(output)}\n`);
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
