import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

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

test("server-renders a function-first editorial Tianzong intake", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<meta name="robots" content="noindex, nofollow, noarchive"\s*\/?>/);
  assert.match(html, /天总直播切片系统/);
  assert.match(html, /内测 BETA 1\.0/);
  assert.match(html, /她不是永远强大，也不是只负责漂亮/);
  assert.match(html, /有本事、有判断、像姐妹、会发疯、也会受伤/);
  assert.match(html, /上传天总完整直播/);
  assert.match(html, /选择直播录屏/);
  assert.match(html, /选择天总本场直播类型/);
  assert.match(html, /开始生成内容地图/);
  assert.match(html, /当前为内部内测/);
  assert.match(html, /编辑部手记 \/ 我们怎样理解她/);
  assert.match(html, /Research release/);
  assert.match(html, /已经学会/);
  assert.match(html, /怎样继续升级/);
  assert.match(html, /长期研究千余条天总素材/);
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
  const prototypePosition = html.indexOf("当前为内部内测");
  const profilePosition = html.indexOf("编辑部手记 / 我们怎样理解她");
  const releasePosition = html.indexOf("Research release");
  assert.ok(uploadPosition >= 0 && uploadPosition < modePosition);
  assert.ok(modePosition < ctaPosition);
  assert.ok(ctaPosition < prototypePosition);
  assert.ok(prototypePosition < profilePosition);
  assert.ok(profilePosition < releasePosition);

  assert.doesNotMatch(html, /天总视觉素材/);
  assert.doesNotMatch(html, /\/editorial\//);
  assert.doesNotMatch(html, /<img\b/);

  assert.doesNotMatch(html, /CUTLINE/);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /Your site is taking shape/);
});

test("ships product metadata and removes the disposable starter preview", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /本场自然发现/);
  assert.match(page, /目标输出：无字幕 · 无效果 · 保留原声/);
  assert.match(page, /Source review \/ 原片校对窗/);
  assert.match(page, /Proofing view \/ 逐字校对/);
  assert.match(page, /查看输出依据/);
  assert.match(page, /送入 ChatCut 精修（演示）/);
  assert.doesNotMatch(page, /下载演示样片/);
  assert.doesNotMatch(page, /\/previews\//);
  assert.doesNotMatch(page, /\/thumbnails\//);
  assert.match(page, /不设目标、不设保底，也不补齐/);
  assert.match(page, /const discoveredCount = analysisReady \? modeIdeas\.length : 0/);
  assert.doesNotMatch(page, /demoDiscoveryCounts/);
  assert.match(page, /句级预听/);
  assert.match(page, /uploadedPreviewUrl \? activeClip\.sourceStart : 0/);
  assert.match(page, /<details className="profile-brief">/);
  assert.match(page, /编辑部手记 \/ 我们怎样理解她/);
  assert.match(page, /Research release/);
  assert.match(page, /长期研究千余条天总素材/);
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
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});
