import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";

const editorialAssets = [
  "editorial/tianzong-business-walk-poster.jpg",
  "editorial/tianzong-business-walk.mp4",
  "editorial/tianzong-korea-close.jpg",
  "editorial/tianzong-street-close.jpg",
  "editorial/tianzong-street-dance-poster.jpg",
  "editorial/tianzong-street-dance.mp4",
  "editorial/tianzong-street-full.jpg",
  "editorial/tianzong-sunset-pose-poster.jpg",
  "editorial/tianzong-sunset-pose.mp4",
  "editorial/tianzong-sunset-turn-poster.jpg",
  "editorial/tianzong-sunset-turn.mp4",
];

const editorialVideos = [
  ["/editorial/tianzong-business-walk.mp4", "天总穿着黑色大衣向镜头走来的动态画面"],
  ["/editorial/tianzong-sunset-pose.mp4", "动态画面 · 镜头吸引"],
  ["/editorial/tianzong-sunset-turn.mp4", "动态画面 · 状态切换"],
  ["/editorial/tianzong-street-dance.mp4", "动态画面 · 动作反差"],
];

function mediaTag(html, tagName, assetPath) {
  const tags = html.match(new RegExp(`<${tagName}\\b[^>]*>`, "g")) ?? [];
  const tag = tags.find((candidate) => candidate.includes(`src="${assetPath}"`));
  assert.ok(tag, `expected a server-rendered <${tagName}> for ${assetPath}`);
  return tag;
}

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders a function-first Tianzong clipping intake", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<meta name="robots" content="noindex, nofollow, noarchive"\s*\/?>/);
  assert.match(html, /天总直播切片系统/);
  assert.match(html, /内测 BETA 1\.0/);
  assert.match(html, /上传整场直播，开始找天总切片/);
  assert.match(html, /上传天总完整直播/);
  assert.match(html, /选择直播录屏/);
  assert.match(html, /选择天总本场直播类型/);
  assert.match(html, /开始生成内容地图/);
  assert.match(html, /天总视觉素材/);
  assert.match(html, /aria-label="天总视觉素材"/);
  assert.match(html, /当前为内部内测/);
  assert.match(html, /这个系统怎样理解天总/);
  assert.match(html, /展开人物判断/);
  assert.match(html, /有实战能力、嘴很快、主意很正/);
  assert.match(html, /帮姐妹把赚钱、关系和生活讲明白/);
  assert.match(html, /最有权威感的时候被现实拆台/);
  assert.match(html, /上传与类型/);
  assert.match(html, /内容地图/);
  assert.match(html, /文字精剪/);
  assert.match(html, /聊播/);
  assert.match(html, /带货/);

  const uploadPosition = html.indexOf("上传天总完整直播");
  const modePosition = html.indexOf("选择天总本场直播类型");
  const ctaPosition = html.indexOf("开始生成内容地图");
  const mediaPosition = html.indexOf("天总视觉素材");
  const prototypePosition = html.indexOf("当前为内部内测");
  const profilePosition = html.indexOf("这个系统怎样理解天总");
  assert.ok(uploadPosition >= 0 && uploadPosition < modePosition);
  assert.ok(modePosition < ctaPosition);
  assert.ok(ctaPosition < mediaPosition);
  assert.ok(mediaPosition < prototypePosition);
  assert.ok(prototypePosition < profilePosition);

  for (const asset of editorialAssets) {
    assert.match(html, new RegExp(`(?:src|poster)="/${asset.replaceAll(".", "\\.")}"`));
  }

  assert.match(mediaTag(html, "img", "/editorial/tianzong-street-full.jpg"), /alt="天总在街头回身看向镜头的全身照片"/);
  assert.match(mediaTag(html, "img", "/editorial/tianzong-korea-close.jpg"), /alt="天总在餐厅看向镜头的近景照片"/);
  assert.match(mediaTag(html, "img", "/editorial/tianzong-street-close.jpg"), /alt="天总在街头整理头发的半身照片"/);

  for (const [videoPath, label] of editorialVideos) {
    const tag = mediaTag(html, "video", videoPath);
    assert.match(tag, /muted=""/);
    assert.match(tag, /loop=""/);
    assert.match(tag, /playsInline=""/);
    assert.ok(tag.includes(`aria-label="${label}"`), `expected a semantic label for ${videoPath}`);
  }

  assert.doesNotMatch(html, /CUTLINE/);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /Your site is taking shape/);
});

test("ships every Tianzong editorial media asset as a non-empty public file", async () => {
  const assetStats = await Promise.all(
    editorialAssets.map((asset) => stat(new URL(`../public/${asset}`, import.meta.url))),
  );

  assert.equal(assetStats.length, 11);
  for (const [index, assetStat] of assetStats.entries()) {
    assert.ok(assetStat.isFile(), `${editorialAssets[index]} must be a file`);
    assert.ok(assetStat.size > 0, `${editorialAssets[index]} must not be empty`);
  }
});

test("ships product metadata and removes the disposable starter preview", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /本场自然发现/);
  assert.match(page, /目标输出：无字幕 · 无效果 · 保留原声/);
  assert.match(page, /下载演示样片/);
  assert.match(page, /送入 ChatCut 精修（演示）/);
  assert.match(page, /不设目标、不设保底，也不补齐/);
  assert.match(page, /const discoveredCount = analysisReady \? modeIdeas\.length : 0/);
  assert.doesNotMatch(page, /demoDiscoveryCounts/);
  assert.match(page, /句级预听/);
  assert.match(page, /uploadedPreviewUrl \? activeClip\.sourceStart : 0/);
  assert.match(page, /<details className="profile-brief">/);
  assert.match(page, /这个系统怎样理解天总/);
  assert.match(page, /展开人物判断/);
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
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});
