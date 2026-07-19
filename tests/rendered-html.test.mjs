import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import test from "node:test";

async function openPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function render() {
  const port = await openPort();
  const cwd = new URL("../dist/server/", import.meta.url);
  const wrangler = new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url);
  const wranglerLog = new URL("../.wrangler/wrangler-test.log", import.meta.url);
  const child = spawn(
    process.execPath,
    [wrangler.pathname, "dev", "--config", "wrangler.json", "--port", String(port)],
    {
      cwd: cwd.pathname,
      env: { ...process.env, NO_COLOR: "1", WRANGLER_LOG_PATH: wranglerLog.pathname },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`wrangler did not start:\n${output}`)), 15_000);
      const onData = (chunk) => {
        output += chunk.toString();
        if (output.includes("Ready on")) {
          clearTimeout(timeout);
          resolve();
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`wrangler exited with ${code}:\n${output}`));
      });
    });
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }

  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { accept: "text/html" },
    });
    return {
      status: response.status,
      headers: response.headers,
      text: await response.text(),
    };
  } finally {
    child.kill("SIGTERM");
  }
}

test("server-renders the Tianzong project workbench", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = response.text;
  assert.match(html, /<meta name="robots" content="noindex, nofollow, noarchive"\s*\/?>/);
  assert.match(html, /天总直播切片系统/);
  assert.match(html, /内测 BETA 1\.0/);
  assert.match(html, /她不是永远强大，也不是只负责漂亮。/);
  assert.match(html, /她真正珍贵的的，是“有本事、有判断、像姐妹、会发疯、也会受伤”同时在一个人身上成立。/);
  assert.equal(html.match(/class="model-copy-line"/g)?.length, 2);
  assert.match(html, /\/photos\/tz_street_tall\.jpg/);
  assert.match(html, /\/photos\/tz_pose_tall\.jpg/);
  assert.match(html, /\/photos\/tz_car_face\.jpg/);
  assert.match(html, /\/photos\/tz_neon_tall\.jpg/);
  assert.match(html, /\/photos\/tz_pink_dress\.jpg/);
  assert.match(html, /\/photos\/tz_lake_dusk\.jpg/);
  assert.match(html, /\/photos\/tz_lake_front\.jpg/);
  assert.match(html, /\/photos\/tz_neon_face\.jpg/);
  assert.match(html, /\/photos\/tz_street_wide\.jpg/);
  assert.equal(html.match(/class="model-gallery-photo"/g)?.length, 9);
  assert.match(html, /左右滑动 · 拖动或滚动浏览/);
  assert.match(html, /今天要剪哪一场直播/);
  assert.match(html, /上传整场直播，开始找天总切片/);
  assert.match(html, /STEP 1/);
  assert.match(html, /上传直播/);
  assert.match(html, /STEP 2/);
  assert.match(html, /选择类型/);
  assert.match(html, /每场直播一个项目/);
  assert.match(html, /项目记录已保存/);
  assert.match(html, /聊播/);
  assert.match(html, /带货/);

  const modelPosition = html.indexOf("她不是永远强大");
  const headlinePosition = html.indexOf("今天要剪哪一场直播");
  const stepOnePosition = html.indexOf("STEP 1");
  const stepTwoPosition = html.indexOf("STEP 2");
  const uploadPosition = html.indexOf("上传整场直播，开始找天总切片");
  const statementSectionPosition = html.indexOf('<section class="model-statement"');
  const gallerySectionPosition = html.indexOf('<aside class="model-mini"');
  const projectPosition = html.indexOf("每场直播一个项目");
  assert.ok(headlinePosition >= 0 && headlinePosition < stepOnePosition);
  assert.ok(stepOnePosition < stepTwoPosition);
  assert.ok(stepTwoPosition < uploadPosition);
  assert.ok(uploadPosition < modelPosition);
  assert.ok(statementSectionPosition >= 0 && statementSectionPosition < gallerySectionPosition);
  assert.ok(modelPosition < projectPosition);

  assert.doesNotMatch(html, /天总视觉素材/);
  assert.doesNotMatch(html, /\/editorial\//);
  assert.match(html, /model-mini/);
  assert.match(html, /model-statement/);
  assert.match(html, /workflow-composer/);
  assert.match(html, /intake-stepper/);
  assert.match(html, /intake-stage/);
  assert.match(html, /project-library/);
  assert.doesNotMatch(html, /intake-atmosphere/);
  assert.doesNotMatch(html, /intake-upload-preview/);
  assert.doesNotMatch(html, /intake-support/);
  assert.doesNotMatch(html, /intake-collage/);
  assert.doesNotMatch(html, /intake-grid/);
  assert.doesNotMatch(html, /profile-brief/);
  assert.doesNotMatch(html, /knowledge-note/);
  assert.doesNotMatch(html, /Research release/);

  assert.doesNotMatch(html, /CUTLINE/);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /Your site is taking shape/);
});

test("ships product metadata and removes the disposable starter preview", async () => {
  const [page, layout, packageJson, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /本场自然发现/);
  assert.match(page, /目标输出：无字幕 · 无效果 · 保留原声/);
  assert.match(page, /Source review \/ 原片校对窗/);
  assert.match(page, /Proofing view \/ 逐字校对/);
  assert.match(page, /直接下载成片/);
  assert.match(page, /进入 ChatCut 精修/);
  assert.match(page, /导出到专业剪辑软件/);
  assert.match(page, /导入 SRT 字幕/);
  assert.match(page, /Premiere \/ DaVinci Resolve/);
  assert.match(page, /真实 MP4 渲染和 ChatCut 工程写入尚未接通/);
  assert.match(page, /type LocalExportOption = "mp4" \| "srt" \| "xml"/);
  assert.match(page, /const \[selectedLocalExports, setSelectedLocalExports\]/);
  assert.match(page, /function toggleLocalExport/);
  assert.match(page, /function downloadSelectedLocalOutputs/);
  assert.match(page, /下载所选到本地/);
  assert.match(page, /项本地格式已选/);
  assert.match(page, /ChatCut 是独立交付，不参与批量下载/);
  assert.match(page, /className="delivery-option chatcut"/);
  assert.equal(page.match(/onChange=\{\(\) => toggleLocalExport\("/g)?.length, 3);
  assert.match(page, /function exportXmlTimeline/);
  assert.match(page, /function exportSrtSubtitle/);
  assert.match(page, /function importSrt/);
  assert.match(page, /downloadBlob\(importedSubtitle\.content/);
  assert.match(page, /application\/xml;charset=utf-8/);
  assert.match(page, /application\/x-subrip/);
  assert.match(page, /scrollIntoView\(\{ behavior: "smooth", block: "nearest" \}\)/);
  assert.doesNotMatch(page, /下载演示样片/);
  assert.doesNotMatch(page, /\/previews\//);
  assert.doesNotMatch(page, /\/thumbnails\//);
  assert.match(page, /不设目标、不设保底，也不补齐/);
  assert.match(page, /const discoveredCount = analysisReady \? modeIdeas\.length : 0/);
  assert.doesNotMatch(page, /demoDiscoveryCounts/);
  assert.match(page, /句级依据/);
  assert.match(page, /确认本条剪辑决定/);
  assert.match(page, /这次选择如何反哺系统/);
  assert.match(page, /后台研究归因/);
  assert.match(page, /固定评测集回测/);
  assert.match(page, /通过评审后才改变生产规则/);
  assert.match(page, /uploadedPreviewUrl \? activeClip\.sourceStart : 0/);
  assert.match(page, /className="model-mini"/);
  assert.match(page, /className="model-statement"/);
  assert.match(page, /className=\{`model-mini-gallery/);
  assert.match(page, /onPointerDown=\{startGalleryDrag\}/);
  assert.match(page, /onWheel=\{scrollGallery\}/);
  assert.match(page, /onKeyDown=\{navigateGallery\}/);
  assert.match(page, /event\.pointerType === "touch"/);
  assert.match(page, /const canMove = event\.deltaY > 0/);
  assert.equal(page.match(/className="model-copy-line"/g)?.length, 2);
  assert.match(page, /className=\{`workflow-composer/);
  assert.match(page, /className="intake-stepper"/);
  assert.match(page, /className="intake-stage"/);
  assert.match(page, /className="mode-choice-cards"/);
  assert.match(page, /聊播切片 · 先判断，再闭环/);
  assert.match(page, /不是摘一句狠话，是让她把一件事讲明白/);
  assert.match(page, /带货切片 · 一个理由，一条片/);
  assert.match(page, /不是堆满卖点，是让一个购买理由被看见、被相信/);
  assert.match(page, /聊播保护观点、因果链和人物反差；带货保护产品证据、适配边界与信任感/);
  assert.match(page, /剪判断如何成立/);
  assert.match(page, /剪购买理由如何被证明/);
  assert.match(page, /className="project-library"/);
  assert.match(page, /按日期保存项目/);
  assert.match(page, /projectDateFromFile/);
  assert.match(page, /formatProjectDate/);
  assert.match(page, /fetch\("\/api\/projects"/);
  assert.match(page, /method: "POST"/);
  assert.match(page, /method: "PATCH"/);
  assert.match(page, /\$\{projectDate\.label\} · \$\{selectedMode\}切片/);
  assert.match(page, /\$\{project\.clipCount\} 条切片/);
  assert.match(page, /disabled=\{!uploadedPreviewUrl \|\| !mode/);
  assert.doesNotMatch(page, /className="intake-upload-preview"/);
  assert.doesNotMatch(page, /className="intake-support"/);
  assert.doesNotMatch(page, /className="intake-intro"/);
  assert.doesNotMatch(page, /className="intake-grid"/);
  assert.doesNotMatch(page, /className="profile-brief"/);
  assert.doesNotMatch(page, /className="knowledge-note"/);
  assert.doesNotMatch(page, /editorialImages/);
  assert.match(page, /实战老板/);
  assert.match(page, /强姐姐/);
  assert.match(page, /视觉吸引/);
  assert.match(page, /搞笑女/);
  assert.match(page, /脆弱真实/);
  assert.match(page, /className="persona-proof"/);
  assert.match(page, /为什么是天总/);
  assert.match(page, /activeClip\.personaModes/);
  assert.match(page, /activeClip\.personaReason/);
  assert.match(page, /className="output-persona"/);
  assert.match(page, /这条保住的人物线/);
  assert.doesNotMatch(page, /\/Users\/lipaliu/);
  assert.doesNotMatch(page, /xwechat_files/);
  assert.doesNotMatch(page, /RWTemp/);
  assert.doesNotMatch(page, /codex-clipboard/);
  assert.doesNotMatch(page, /AmbientVideo/);
  assert.doesNotMatch(page, /01 \/ 核心人格/);
  assert.doesNotMatch(page, /profile-editorial/);
  assert.doesNotMatch(page, /research-metrics/);
  assert.doesNotMatch(page, /calibration-strip/);
  assert.doesNotMatch(page, /duration-reference/);
  assert.doesNotMatch(page, /新增投喂/);
  assert.match(layout, /天总直播切片系统 · 内测 BETA 1\.0/);
  assert.match(layout, /applicationName: "天总直播切片系统"/);
  assert.match(layout, /index: false/);
  assert.match(layout, /follow: false/);
  assert.match(layout, /noarchive: true/);
  assert.doesNotMatch(layout, /og\.png/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(styles, /\.output-persona p,[\s\S]*?font-size: 16px/);
  assert.match(styles, /\.model-statement p[\s\S]*?font-family: var\(--font-display\)[\s\S]*?font-size: clamp\(13px, 1\.05vw, 15px\)[\s\S]*?font-style: oblique 7deg/);
  assert.match(styles, /\.model-copy-line[\s\S]*?display: block/);
  assert.match(styles, /\.model-mini-gallery[\s\S]*?grid-auto-flow: column[\s\S]*?grid-auto-columns: clamp\(196px, 19vw, 236px\)[\s\S]*?overflow-x: auto[\s\S]*?scroll-snap-type: x mandatory/);
  assert.match(styles, /\.model-mini-gallery img[\s\S]*?width: 100%[\s\S]*?height: 100%[\s\S]*?opacity: 1[\s\S]*?filter: none/);
  assert.doesNotMatch(styles, /\.model-mini p/);
  assert.doesNotMatch(styles, /\.model-mini-gallery img[\s\S]*?margin-left: -20px/);
  assert.match(styles, /\.output-rationale-grid b[\s\S]*?font-size: 16px/);
  assert.match(styles, /\.feedback-path li > p[\s\S]*?font-size: 16px/);
  assert.match(styles, /\.delivery-option > label > strong,[\s\S]*?font-size: 18px/);
  assert.match(styles, /\.delivery-choice-grid[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.delivery-option\.selected[\s\S]*?box-shadow/);
  assert.doesNotMatch(styles, /\.delivery-main-actions/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});

test("persists dated project metadata in D1", async () => {
  const [schema, route, hosting, migration] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/projects/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0000_blushing_morg.sql", import.meta.url), "utf8"),
  ]);

  assert.match(schema, /sqliteTable\(\s*"projects"/);
  assert.match(schema, /projectDate: text\("project_date"\)/);
  assert.match(schema, /sourceName: text\("source_name"\)/);
  assert.match(schema, /clipCount: integer\("clip_count"\)/);
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function POST/);
  assert.match(route, /export async function PATCH/);
  assert.match(route, /crypto\.randomUUID\(\)/);
  assert.match(hosting, /"d1"\s*:\s*"DB"/);
  assert.match(hosting, /"r2"\s*:\s*null/);
  assert.match(migration, /CREATE TABLE `projects`/);
  assert.match(migration, /CREATE INDEX `projects_created_at_idx`/);
});
