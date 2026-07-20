import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function runCommand(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`command exited with ${code}:\n${output}`);
}

async function render() {
  const port = await openPort();
  const cwd = new URL("../dist/server/", import.meta.url);
  const wrangler = new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url);
  const wranglerLog = new URL("../.wrangler/wrangler-test.log", import.meta.url);
  const testUsername = "test-editor";
  const testPassword = "Strong-test-password-2026";
  const raceUsername = "race-editor";
  const persistencePath = await mkdtemp(join(tmpdir(), "tianzong-auth-test-"));

  for (const migration of ["0000_blushing_morg.sql", "0001_chemical_salo.sql"]) {
    await runCommand(
      process.execPath,
      [
        wrangler.pathname,
        "d1",
        "execute",
        "DB",
        "--local",
        "--config",
        "wrangler.json",
        "--persist-to",
        persistencePath,
        "--file",
        new URL(`../drizzle/${migration}`, import.meta.url).pathname,
      ],
      { cwd: cwd.pathname, env: { ...process.env, NO_COLOR: "1" } },
    );
  }

  const child = spawn(
    process.execPath,
    [
      wrangler.pathname,
      "dev",
      "--config",
      "wrangler.json",
      "--port",
      String(port),
      "--persist-to",
      persistencePath,
      "--var",
      `INTERNAL_AUTH_CREDENTIALS:${JSON.stringify({
        [testUsername]: testPassword,
        [raceUsername]: "Another-strong-test-password-2026",
      })}`,
      "--var",
      "INTERNAL_AUTH_SESSION_SECRET:test-session-secret-with-at-least-32-characters",
    ],
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

  // Wrangler can announce its proxy before the first local Worker isolate has
  // finished settling. Give that one-time dev-only reload a brief window so a
  // state-changing auth request is never mistaken for an application 503.
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const manifest = JSON.parse(
      await readFile(new URL("../dist/client/.vite/manifest.json", import.meta.url), "utf8"),
    );
    const builtAsset = Object.values(manifest).find(
      (entry) => typeof entry?.file === "string" && entry.file.endsWith(".js"),
    )?.file;
    assert.ok(builtAsset, "the built client manifest should contain a JavaScript asset");

    const loginPageResponse = await fetch(`${baseUrl}/`, {
      headers: { accept: "text/html" },
    });
    const loginPage = {
      status: loginPageResponse.status,
      headers: loginPageResponse.headers,
      text: await loginPageResponse.text(),
    };

    const [apiWithoutLogin, photoWithoutLogin, assetWithoutLogin] = await Promise.all([
      fetch(`${baseUrl}/api/projects`),
      fetch(`${baseUrl}/photos/tz_street_tall.jpg`),
      fetch(`${baseUrl}/${builtAsset}`),
    ]);

    const missingOriginResponse = await fetch(`${baseUrl}/__auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: testUsername, password: testPassword }),
    });

    const loginResponse = await fetch(`${baseUrl}/__auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseUrl,
      },
      body: JSON.stringify({ username: testUsername, password: testPassword }),
    });
    const cookie = loginResponse.headers.get("set-cookie")?.split(";", 1)[0];
    assert.equal(loginResponse.status, 200);
    assert.ok(cookie, "successful login should set a session cookie");

    const response = await fetch(`${baseUrl}/`, {
      headers: { accept: "text/html", cookie },
    });
    const responseText = await response.text();

    const [missingWriteOrigin, crossOriginWrite, nonJsonWrite] = await Promise.all([
      fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      }),
      fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", origin: "https://evil.example" },
        body: "{}",
      }),
      fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: { cookie, "content-type": "text/plain", origin: baseUrl },
        body: "{}",
      }),
    ]);

    let logoutResponse = await fetch(`${baseUrl}/__auth/logout`, {
      method: "POST",
      headers: { cookie, origin: baseUrl },
    });
    if (logoutResponse.status === 503) {
      const firstLogoutBody = await logoutResponse.text();
      if (/worker restarted mid-request/i.test(firstLogoutBody)) {
        logoutResponse = await fetch(`${baseUrl}/__auth/logout`, {
          method: "POST",
          headers: { cookie, origin: baseUrl },
        });
      }
    }

    // Run rate-limit and concurrency pressure after the ordinary login lifecycle.
    // This keeps a Wrangler-local isolate recycle from obscuring logout behavior.
    const invalidLoginStatuses = [];
    for (let index = 0; index < 5; index += 1) {
      const invalidLogin = await fetch(`${baseUrl}/__auth/login`, {
        method: "POST",
        headers: {
          "cf-connecting-ip": `198.51.100.${index + 1}`,
          "content-type": "application/json",
          origin: baseUrl,
        },
        body: JSON.stringify({ username: `unknown-${index}`, password: "not-the-password" }),
      });
      invalidLoginStatuses.push(invalidLogin.status);
    }
    const blockedUnknownLogin = await fetch(`${baseUrl}/__auth/login`, {
      method: "POST",
      headers: {
        "cf-connecting-ip": "198.51.100.200",
        "content-type": "application/json",
        origin: baseUrl,
      },
      body: JSON.stringify({ username: "another-unknown", password: "not-the-password" }),
    });

    const concurrentRaceLogins = await Promise.all(
      Array.from({ length: 10 }, (_, index) => fetch(`${baseUrl}/__auth/login`, {
        method: "POST",
        headers: {
          "cf-connecting-ip": `203.0.113.${index + 1}`,
          "content-type": "application/json",
          origin: baseUrl,
        },
        body: JSON.stringify({ username: raceUsername, password: `wrong-${index}` }),
      })),
    );
    const concurrentRaceStatuses = concurrentRaceLogins.map((item) => item.status);

    const concurrentSuccessfulLogins = await Promise.all(
      Array.from({ length: 5 }, (_, index) => fetch(`${baseUrl}/__auth/login`, {
        method: "POST",
        headers: {
          "cf-connecting-ip": `192.0.2.${index + 1}`,
          "content-type": "application/json",
          origin: baseUrl,
        },
        body: JSON.stringify({ username: testUsername, password: testPassword }),
      })),
    );
    const concurrentSuccessfulStatuses = concurrentSuccessfulLogins.map((item) => item.status);

    return {
      protectedWithoutLogin: {
        api: apiWithoutLogin.status,
        asset: assetWithoutLogin.status,
        photo: photoWithoutLogin.status,
      },
      missingOriginStatus: missingOriginResponse.status,
      invalidLoginStatuses,
      blockedUnknownStatus: blockedUnknownLogin.status,
      concurrentRaceStatuses,
      concurrentSuccessfulStatuses,
      protectedWriteStatuses: {
        crossOrigin: crossOriginWrite.status,
        missingOrigin: missingWriteOrigin.status,
        nonJson: nonJsonWrite.status,
      },
      logoutCookie: logoutResponse.headers.get("set-cookie"),
      logoutStatus: logoutResponse.status,
      loginPage,
      status: response.status,
      headers: response.headers,
      text: responseText,
    };
  } finally {
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGTERM");
      });
    }
    await rm(persistencePath, { force: true, recursive: true });
  }
}

test("server-renders the Tianzong project workbench", async () => {
  const response = await render();
  assert.equal(response.loginPage.status, 401);
  assert.match(response.loginPage.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.match(response.loginPage.text, /内部工作台，请使用团队账号进入。/);
  assert.match(response.loginPage.text, /用户名/);
  assert.match(response.loginPage.text, /密码/);
  assert.doesNotMatch(response.loginPage.text, /Strong-test-password-2026/);
  assert.deepEqual(response.protectedWithoutLogin, { api: 401, asset: 401, photo: 401 });
  assert.equal(response.missingOriginStatus, 403);
  assert.deepEqual(response.invalidLoginStatuses, [401, 401, 401, 401, 401]);
  assert.equal(response.blockedUnknownStatus, 429);
  assert.equal(response.concurrentRaceStatuses.filter((status) => status === 401).length, 5);
  assert.equal(response.concurrentRaceStatuses.filter((status) => status === 429).length, 5);
  assert.deepEqual(response.concurrentSuccessfulStatuses, [200, 200, 200, 200, 200]);
  assert.deepEqual(response.protectedWriteStatuses, {
    crossOrigin: 403,
    missingOrigin: 403,
    nonJson: 415,
  });
  assert.equal(response.logoutStatus, 200);
  assert.match(response.logoutCookie ?? "", /Max-Age=0/);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(response.headers.get("vary") ?? "", /Cookie/i);
  assert.equal(response.headers.get("x-frame-options"), "DENY");

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
  assert.match(html, /\/photos\/tz_city_dress\.jpg/);
  assert.doesNotMatch(html, /\/photos\/tz_neon_face\.jpg/);
  assert.doesNotMatch(html, /\/photos\/tz_street_wide\.jpg/);
  assert.equal(html.match(/class="model-gallery-photo"/g)?.length, 16);
  assert.equal(html.match(/data-gallery-cycle="0"/g)?.length, 8);
  assert.equal(html.match(/data-gallery-cycle="1"/g)?.length, 8);
  assert.doesNotMatch(html, /自动渐进播放|左右滑动|自动播放/);
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
  assert.match(page, /className="model-mini-gallery"/);
  assert.match(page, /className=\{`model-gallery-track/);
  assert.match(page, /galleryAutoPlaying/);
  assert.match(page, /prefers-reduced-motion: reduce/);
  assert.match(page, /new IntersectionObserver/);
  assert.doesNotMatch(page, /galleryUserPaused|继续播放/);
  assert.doesNotMatch(page, /startGalleryDrag|scrollGallery|navigateGallery/);
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
  assert.match(styles, /\.model-mini-gallery[\s\S]*?overflow: hidden/);
  assert.match(styles, /\.model-gallery-track[\s\S]*?display: flex[\s\S]*?animation: model-gallery-marquee 52s linear infinite/);
  assert.match(styles, /@keyframes model-gallery-marquee[\s\S]*?translate3d\(calc\(-50% - var\(--gallery-half-gap\)\), 0, 0\)[\s\S]*?translate3d\(0, 0, 0\)/);
  assert.match(styles, /\.model-gallery-track\.is-playing[\s\S]*?animation-play-state: running/);
  assert.doesNotMatch(styles, /\.model-gallery-toggle|\.model-gallery-footer/);
  assert.match(styles, /\.model-gallery-track img[\s\S]*?width: auto[\s\S]*?height: 100%[\s\S]*?object-fit: contain[\s\S]*?opacity: 1[\s\S]*?filter: none/);
  assert.doesNotMatch(styles, /\.model-mini p/);
  assert.doesNotMatch(styles, /\.model-gallery-track img[\s\S]*?margin-left: -20px/);
  assert.match(styles, /\.output-rationale-grid b[\s\S]*?font-size: 16px/);
  assert.match(styles, /\.feedback-path li > p[\s\S]*?font-size: 16px/);
  assert.match(styles, /\.delivery-option > label > strong,[\s\S]*?font-size: 18px/);
  assert.match(styles, /\.delivery-choice-grid[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.delivery-option\.selected[\s\S]*?box-shadow/);
  assert.doesNotMatch(styles, /\.delivery-main-actions/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});

test("persists dated project metadata in D1", async () => {
  const [schema, route, hosting, migration, authMigration] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/projects/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0000_blushing_morg.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0001_chemical_salo.sql", import.meta.url), "utf8"),
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
  assert.match(schema, /sqliteTable\(\s*"auth_login_attempts"/);
  assert.match(authMigration, /CREATE TABLE `auth_login_attempts`/);
  assert.match(authMigration, /CREATE INDEX `auth_login_attempts_updated_at_idx`/);
});

test("routes every static request through the authentication worker", async () => {
  const wrangler = JSON.parse(
    await readFile(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"),
  );
  assert.equal(wrangler.assets?.binding, "ASSETS");
  assert.equal(wrangler.assets?.run_worker_first, true);
});
