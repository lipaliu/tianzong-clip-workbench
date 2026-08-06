import Fastify, { type FastifyInstance } from "fastify";
import type { ProcessorConfig } from "./config.js";
import { sha256Hex } from "./canonical.js";
import { checkDatabase, type Database } from "./db.js";
import { publicError } from "./errors.js";
import { verifyInternalRequest } from "./auth.js";
import { ProcessorRepository } from "./repository.js";
import { registerRoutes } from "./routes.js";
import { PrivateObjectStorage } from "./storage.js";

const progressPageHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>天总直播切片系统 · 实时进度</title>
  <style>
    :root{color-scheme:light;--ink:#2c2929;--muted:#7b7377;--line:#eadde2;--pink:#e7bfd0;--pink2:#f8eef2;--ok:#4f8069;--bad:#a84f5f}
    *{box-sizing:border-box}body{margin:0;background:#fffafa;color:var(--ink);font-family:"Songti SC","Noto Serif SC",serif}
    main{width:min(1120px,calc(100% - 32px));margin:0 auto;padding:42px 0 64px}
    header{display:flex;justify-content:space-between;gap:24px;align-items:end;border-bottom:1px solid var(--line);padding-bottom:20px}
    h1{font-size:clamp(30px,5vw,58px);font-weight:400;line-height:1.05;margin:8px 0}.kicker,.mono{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:#bd7896}
    .summary{text-align:right}.summary b{font:italic 48px/1 Georgia,serif;font-weight:400}.summary small{display:block;color:var(--muted);margin-top:6px}
    .now{margin:28px 0;padding:24px;border:1px solid #ddb5c5;background:linear-gradient(120deg,#fff,#faedf2)}
    .now h2{font-size:24px;font-weight:500;margin:8px 0}.now p{font-size:17px;line-height:1.65;margin:0;color:#5f575b}.bar{height:8px;background:#eadde2;margin-top:18px;overflow:hidden}.bar i{display:block;height:100%;background:#cf89a7;transition:width .6s ease}
    .steps{display:grid;grid-template-columns:repeat(7,1fr);gap:0;margin:34px 0}.step{min-height:148px;border:1px solid var(--line);border-right:0;padding:16px 14px;background:#fff}.step:last-child{border-right:1px solid var(--line)}
    .step b{display:block;font:italic 26px/1 Georgia,serif;color:#c596aa}.step strong{display:block;font-size:15px;margin:18px 0 8px}.step small{color:var(--muted);line-height:1.5}.step.done{background:#fbf3f6}.step.active{background:#e9c5d4;border-color:#cf89a7}.step.active b,.step.active small{color:#6e3e52}
    .models{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.model{border:1px solid var(--line);padding:18px;background:#fff}.model h3{font-size:20px;font-weight:500;margin:4px 0 12px}.status{font-size:14px;color:var(--muted)}
    .events{margin-top:34px}.events h2{font-size:22px;font-weight:500}.events ol{list-style:none;padding:0;margin:0;border-top:1px solid var(--line)}.events li{display:grid;grid-template-columns:82px 1fr 160px;gap:16px;padding:14px 0;border-bottom:1px solid var(--line);line-height:1.5}.events time{color:var(--muted);font-size:13px;text-align:right}
    .warn{color:var(--bad)}.ready{color:var(--ok)}
    @media(max-width:850px){header{display:block}.summary{text-align:left;margin-top:20px}.steps{grid-template-columns:1fr}.step{min-height:0;border-right:1px solid var(--line);border-bottom:0}.step:last-child{border-bottom:1px solid var(--line)}.models{grid-template-columns:1fr}.events li{grid-template-columns:58px 1fr}.events time{display:none}}
  </style>
</head>
<body><main>
  <header><div><div class="kicker">天总直播切片系统 · 内测</div><h1 id="title">正在读取项目</h1><div id="meta" class="mono"></div></div><div class="summary"><b id="percent">0%</b><small id="updated">等待后台状态</small></div></header>
  <section class="now"><div class="kicker">当前真实动作</div><h2 id="stage">连接处理服务</h2><p id="message">正在读取后台日志，不使用模拟动画。</p><div class="bar"><i id="bar" style="width:0%"></i></div></section>
  <section id="steps" class="steps"></section>
  <section class="models"><article class="model"><div class="kicker">主编一</div><h3>OpenAI</h3><div id="openai" class="status">等待本场记录</div></article><article class="model"><div class="kicker">主编二</div><h3>火山 Seed Pro</h3><div id="doubao" class="status">等待本场记录</div></article><article class="model"><div class="kicker">主编三</div><h3>Kimi K3</h3><div id="kimi" class="status">等待本场记录</div></article></section>
  <section class="events"><h2>后台处理记录</h2><ol id="events"></ol></section>
</main><script>
const STAGES=[
  ["原片入库","上传、私有核心与媒体时基校验",["queued","uploading","downloading","binding_private_core","probing"]],
  ["听清直播","中文逐字稿、说话人与时间码",["transcribing"]],
  ["整场召回","从完整直播召回全部候选主题",["full_timeline_evidence_preparation","private_core_reasoning"]],
  ["看懂现场","表情、动作、语气与商品展示复核",["candidate_native_av_review"]],
  ["主编终审","本场选定模型执行天总 Skill 与完整性校验",["private_core_reasoning_partial","candidate_dense_refinement"]],
  ["硬校验","主题、金句、头尾、时长与说话人门禁",["validating_private_contract"]],
  ["粗剪交付","生成候选 MP4、字幕与时间线",["rendering_previews","review_ready"]]
];
const projectId=location.pathname.split("/").filter(Boolean).pop();
function esc(v){return String(v??"").replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function stageIndex(stage,progress){let i=STAGES.findIndex(x=>x[2].includes(stage));if(i<0){if(progress>=100)i=6;else if(progress>=85)i=3;else if(progress>=64)i=2;else if(progress>=25)i=1;else i=0}return i}
function providerStatus(events,name){const rows=events.filter(e=>e.message.includes(name));if(!rows.length)return "等待本场记录";const text=rows[0].message;return text.includes("暂时不可用")?'<span class="warn">'+esc(text)+'</span>':text.includes("已完成")?'<span class="ready">'+esc(text)+'</span>':esc(text)}
async function refresh(){try{const r=await fetch("/progress-data/"+projectId,{cache:"no-store"});if(!r.ok)throw new Error("HTTP "+r.status);const d=await r.json();const j=d.job,p=d.project,e=d.events||[],latest=e[0];const review=e.map(x=>x.message.match(/(\d+)\/(\d+)/)).find(Boolean);const countLabel=review?"复核 "+review[1]+"/"+review[2]+" · 已发布 "+d.candidateCount:"已发布候选 "+d.candidateCount;document.getElementById("title").textContent=p.title;document.getElementById("meta").textContent=p.projectDate+" · "+p.mode+" · "+p.editorMode+" · "+countLabel;document.getElementById("percent").textContent=j.progress+"%";document.getElementById("updated").textContent="最近更新 "+new Date(j.updatedAt).toLocaleString("zh-CN");document.getElementById("stage").textContent="第 "+(stageIndex(j.stage,j.progress)+1)+"/7 步 · "+STAGES[stageIndex(j.stage,j.progress)][0];document.getElementById("message").textContent=latest?.message||j.error||"后台处理中";document.getElementById("bar").style.width=j.progress+"%";const active=stageIndex(j.stage,j.progress);document.getElementById("steps").innerHTML=STAGES.map((s,i)=>'<article class="step '+(i<active?"done":i===active?"active":"")+'"><b>0'+(i+1)+'</b><strong>'+s[0]+'</strong><small>'+s[1]+'</small></article>').join("");document.getElementById("openai").innerHTML=providerStatus(e,"OpenAI");document.getElementById("doubao").innerHTML=providerStatus(e,"火山").replace("等待本场记录",providerStatus(e,"豆包"));document.getElementById("kimi").innerHTML=providerStatus(e,"Kimi");document.getElementById("events").innerHTML=e.slice(0,20).map(x=>'<li><span class="mono">'+esc(x.progress)+'% · '+esc(x.stage)+'</span><span>'+esc(x.message)+'</span><time>'+new Date(x.createdAt).toLocaleString("zh-CN")+'</time></li>').join("");}catch(err){document.getElementById("stage").textContent="进度页暂时无法读取后台";document.getElementById("message").textContent=String(err)}}
refresh();setInterval(refresh,5000);
</script></body></html>`;

export type AppDependencies = {
  config: ProcessorConfig;
  database: Database;
  repository?: ProcessorRepository;
  storage?: PrivateObjectStorage;
};

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const { config, database } = dependencies;
  const repository = dependencies.repository ?? new ProcessorRepository(database, config);
  const storage = dependencies.storage ?? new PrivateObjectStorage(config);
  const coreVerificationTtlMs = 5 * 60 * 1_000;
  let coreVerifiedAt = 0;
  let coreVerificationInFlight: Promise<void> | null = null;

  const verifyPinnedPrivateCore = async () => {
    if (Date.now() - coreVerifiedAt < coreVerificationTtlMs) return;
    if (coreVerificationInFlight) return coreVerificationInFlight;

    coreVerificationInFlight = (async () => {
      const coreObject = await storage.head(config.core.objectKey);
      if (!coreObject.ContentLength || coreObject.ContentLength <= 0) {
        throw new Error("private core object is empty");
      }
      const coreBytes = await storage.getBuffer(config.core.objectKey);
      if (
        coreBytes.byteLength !== coreObject.ContentLength
        || sha256Hex(coreBytes) !== config.core.sha256
      ) {
        throw new Error("private core object does not match the pinned SHA-256");
      }
      coreVerifiedAt = Date.now();
    })();

    try {
      await coreVerificationInFlight;
    } finally {
      coreVerificationInFlight = null;
    }
  };

  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    return payload;
  });

  app.get("/healthz", async () => ({
    ok: true,
    service: "tianclip-processor",
    version: "0.1.0",
  }));

  app.get("/readyz", async (_request, reply) => {
    try {
      await checkDatabase(database);
      await verifyPinnedPrivateCore();
      if (!await repository.hasRecentWorkerHeartbeat()) {
        throw new Error("no recent background worker heartbeat");
      }
      return {
        ready: true,
        service: "tianclip-processor",
        dependencies: {
          database: true,
          privateStorage: true,
          privateCoreObject: true,
          privateCorePinnedSha256: true,
          backgroundWorker: true,
        },
      };
    } catch (error) {
      app.log.error({ err: error }, "readiness check failed");
      return reply.code(503).send({
        ready: false,
        error: { code: "not_ready", message: "处理服务尚未就绪。" },
      });
    }
  });

  app.get("/progress/:projectId", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(projectId);
    return reply.type("text/html; charset=utf-8").send(progressPageHtml);
  });

  app.get("/progress-data/:projectId", async (request) => {
    const { projectId } = request.params as { projectId: string };
    const project = await repository.getProject(projectId);
    const job = await repository.getLatestJobForProject(projectId);
    const [eventHistory, candidateCount] = await Promise.all([
      repository.listJobEvents(job.id, 200),
      repository.countCandidatesForJob(job.id),
    ]);
    const latestQueueIndex = eventHistory.findIndex((event) => event.stage === "queued");
    const events = latestQueueIndex >= 0
      ? eventHistory.slice(0, latestQueueIndex + 1)
      : eventHistory;
    return { project, job, events, candidateCount };
  });

  app.addHook("preHandler", async (request) => {
    if (!request.url.startsWith("/v1/")) return;
    const verified = await verifyInternalRequest(request, config, database);
    request.internalKeyId = verified.keyId;
    request.internalActor = verified.actor;
  });

  await registerRoutes(app, { config, repository, storage });

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({
      error: { code: "not_found", message: "接口不存在。" },
    }));

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ err: error }, "request failed");
    const response = publicError(error);
    return reply.code(response.statusCode).send(response.body);
  });

  return app;
}
