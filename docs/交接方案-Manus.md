# 天总切片系统 · 交接方案

写给接手继续开发的人（Manus）。日期：2026-08-07。

---

## 一、现在是什么状态

**代码基本完工，测试 107 个全过，前台已部署在线（有登录门），后端未部署。**

一句话：**卡的不是代码，是腾讯云资源没开通 + 从没跑通过一次完整链路。**

已经真实跑过一次（2026-07-31，6 月 17 日聊播，2 小时 52 分）：转写、双模型文字召回、粗剪 MP4 全部产出，182 条候选躺在移动硬盘 `lipa 2024/天总/天总切片交付/`。但那次停在 `editorial-recall-checkpoint`，**终审没跑完**，所有候选的 `validationStatus` 都是 `editorial_candidate_needs_av_review`。

### 已完成（不要重做）

| 模块 | 位置 |
|---|---|
| 前台三步工作台（2747 行） | `app/page.tsx` |
| 上传（9GB 分片直传 + ETag 逐片校验） | `processor/src/multipart.ts` |
| 豆包 BigASR 转写 | `processor/src/pipeline/doubao-asr.mjs` |
| 编导召回（可选 OpenAI / 豆包 / 双跑对比） | `processor/src/pipeline/candidates.mjs` |
| 候选音视频复核 | `processor/src/pipeline/doubao-av-review.mjs` |
| 终审 | `processor/src/pipeline/candidate-refinement.mjs` |
| FFmpeg 粗剪 / 逐字删留 / 版本化重渲染 | `processor/src/revision-render.ts` |
| MP4 / SRT / XML 导出 | 已接通 |
| **计价台账（2026-08-07 新增）** | `processor/src/pricing.ts`、`GET /v1/jobs/:id/cost` |
| 上线接线手册（腾讯云版） | `docs/上线接线手册.md` |

### 未完成（本文档要交接的）

按优先级排列，下面逐条展开。

---

## 二、任务清单

### P0 — 让它真正上线（不写代码，但必须先做）

**做什么**：照 `docs/上线接线手册.md` 走完 7 步。

需要用户本人完成的（涉及付费和实名）：
- 开通腾讯云 COS 私有桶 + CAM 子账号密钥
- 买腾讯云 CVM（**2核4GB / 100GB 盘起步**，与 COS 同地域）
- 确认 OpenAI 项目已充值、火山引擎三个模型已开通

**验收**：`https://<API_DOMAIN>/readyz` 返回 `ready: true`。

**最大的坑**：`/readyz` 返回 503 十有八九是私有核心指纹配错。对象键、SHA-256、版本号三者必须描述同一个文件：

```
private-core/tianzong-video-clipping-1.2.3-private.1.skill
f5caa9d679bc40fda1222c7b448c37f14465d8baa9a5c3c0661367b8e7b13d06
1.2.3-private.1
```

硬盘 `核心备份/` 里还躺着 1.2.0 / 1.2.1 / 1.2.2 三个旧版，**传错任何一个都会静默失败**。这个错历史上犯过一次。

---

### P1 — 前台显示费用

**为什么**：用户明确要求"系统自己告诉我这场花了多少钱，不用我事后对账"。后端已经做好，前台还看不到。

**后端已就绪**，直接调：

```
GET /v1/jobs/<jobId>/cost
```

返回结构见 `processor/src/pricing.ts` 的 `JobCostSummary`：

```ts
{
  totalCny: 15.16,
  complete: true,              // false 表示有环节没定价
  unpricedStages: [],
  perStageCny: { transcription: 2.30, candidate_recall: 2.52, ... },
  deliveredClipSeconds: 6126,
  deliveredClipCount: 74,
  cnyPerDeliveredSecond: 0.002475,   // complete 为 false 时是 null
  sourceMediaSeconds: 10358.755,
  cnyPerSourceHour: 5.27
}
```

**要做两处 UI**：

1. **选编导模型时预估**（`app/page.tsx` 的 STEP 2 附近）。上传后已知片长，直接乘：

   ```
   ○ 火山 Seed Pro      约 ¥5.3/小时直播   ← 默认
   ○ OpenAI gpt-5.6-sol 约 ¥32/小时直播
   ○ 两家同时跑对比      约 ¥38/小时直播
   ```

2. **跑完显示实际账单**。分环节列出，并显示"每秒成片 ¥X"。

**必须遵守的显示规则**（后端已经这样返回，前台不要绕过）：

- `complete: false` 时**不要显示每秒单价**，改显示"部分环节未计价"并列出 `unpricedStages`。缺一条腿的单价会偏低，用它做决策会亏。
- 未定价的环节显示"未计价"，**不要显示 ¥0**。0 看起来像免费，这是最贵的误判。

**前台改动路径**：`app/page.tsx` + `app/processor-client.ts`（加一个 `fetchJobCost`，照现有 `fetchJob` 的写法）。

**验收**：跑一场真实任务，页面显示的总额与 `GET /v1/jobs/:id/cost` 一致。

---

### P2 — 接入 Kimi 作为第三家编导

**为什么**：用户三家 API 都充了钱，要的是"三家摆在台面上比价比效果"。

**先确认型号**（用户还没定）。价格差 5 倍，选错影响很大：

| 型号 | 输入 | 输出 |
|---|---|---|
| Kimi K2.5 | $0.60/M | $3.00/M |
| Kimi K3 | $3.00/M | $15.00/M |

**硬性前提**：Kimi 必须支持**结构化 JSON 输出**（严格 Schema）。系统的三个 Schema（事实层、剪辑计划、决策台账）是硬门槛，模型返回不合 Schema 任务就失败关闭。**接之前先单独验证这一点**，别等接完才发现不行。

**照哪个写法做**：`processor/src/pipeline/doubao-editor-client.mjs`。豆包编导就是通过 Ark 的 Responses 接口跑同一套结构化契约，Kimi 走 OpenAI 兼容接口，结构几乎一样。

**要改的地方**：

1. 新建 `processor/src/pipeline/kimi-editor-client.mjs`（照豆包那份改）
2. `processor/src/config.ts`：加 `KIMI_API_KEY`、`KIMI_BASE_URL`、`KIMI_EDITOR_MODEL`
3. `processor/src/types.ts`：`EditorialModelMode` 加 `"kimi"`
4. `migrations/007_kimi_editor.sql`：`projects.editor_mode` 的 CHECK 约束加 `'kimi'`
5. `processor/src/worker.ts`：`editorialProviders` 分支加一路
6. **`processor/src/pricing.ts`：把 Kimi 的价目表加进 `MODEL_RATES`**，带上来源网址和查证日期——不加的话台账会如实标成"未定价"，每秒单价直接不显示
7. `app/page.tsx`：模型选择加一项

**验收**：用 6 月 17 日那场跑 Kimi 模式，候选数量合理、Schema 全过、费用接口能算出钱。

---

### P3 — 把那次跑到一半的终审补完

**为什么**：182 条候选和 4GB MP4 已经在硬盘上了，只差最后一步就能用。

后端起来之后，用 6 月 17 日原片重跑一遍完整链路（不是接着旧 checkpoint 跑，那个 checkpoint 的 schema 是 `editorial-recall-checkpoint.v1`，只保存到召回为止）。

**重点看**：终审那一步之前从没成功过，很可能有真实 bug 或者是当时 OpenAI 连不上。跑之前先确认第 4 步的中转配好了，或者直接用豆包编导绕开。

---

### P4 — 输出后处理（字幕 / 包装 / AI 音乐）

用户明确提过的三件事，目前**一件都没有**：

1. **字幕烧录**。现在只导出 `.srt` 文件，不烧进画面、没有样式。
2. **包装**（片头片尾、字幕条、标题卡）。
3. **AI 音乐**。

**建议**：这三件独立于主链路，做成"成片确认后的可选后处理步骤"，不要塞进现有 worker 流程——现在的 worker 已经很长（1500+ 行），且单 Worker 串行，加重活会拖垮处理时效。

---

### P5 — ChatCut 接入

README 里承认了没做。"进入 ChatCut"目前只是说明文字，不创建工程。授权和工程写入都要重做。优先级最低。

---

## 三、红线（不要动这些）

1. **不要重新启用全时间轴视觉召回。**
   `analyzeVisualTimeline` 和 `analyzeDenseVisualRecall` 写好了但生产代码从不调用，`worker.ts` 里视觉结果是写死的空值。**这是有意的，用户 2026-08-07 明确确认过"先挑文字，再看视觉"是对的。** 全场每 2 秒抽帧成本极高。不要当 bug 修。

2. **不要改私有核心的版本锁。**
   `config.ts` 用 `z.literal("1.2.3-private.1")`，`engine-artifacts.ts:718` 还要再核一遍包内 manifest。这是防止静默降级到通用 Prompt 的保险，不是过度设计。

3. **不要用假数据兜底。**
   整个仓库的设计原则是"失败就明确失败"。处理服务不可用时页面必须报错，不能拿样例数据冒充结果。计价台账同理：没价目表就标"未定价"，绝不记 0。

4. **不要把 compose 里的 `tunnel` 服务当生产入口。**
   那是 cloudflared 临时隧道，地址随机、重启就变。生产走 Caddy + 固定域名。

5. **不要把 `numInstances` 改成 2。**
   Worker 挂了持久盘，单实例。真要并行得拆成各自独立工作目录的 Worker。

---

## 四、建议顺序

```
P0 上线（用户开通云资源 + 助理接线）
  └─ 验收 /readyz = true
      ├─ P3 用 6/17 原片重跑，把终审跑通   ← 先证明链路是通的
      ├─ P1 前台显示费用                    ← 后端已就绪，改前台即可
      └─ P2 接 Kimi                          ← 有了台账才比得出值不值
          └─ P4 后处理（字幕/包装/音乐）
              └─ P5 ChatCut
```

**P0 不做完，后面全部没意义**——没有跑起来的系统，费用展示和第三家模型都是纸上谈兵。

---

## 五、交接前必须确认的三个未知数

1. **腾讯云 COS 和 CVM 到底有没有开？** 用户说不确定。这是 P0 的前提。
2. **Kimi 开的是哪个型号？** K2.5 和 K3 差 5 倍价，且要先验证结构化输出能力。
3. **终审为什么从没跑成功？** 是 OpenAI 连不上，还是代码有 bug？只有跑一次才知道。

---

## 附：关键数字（2026-08-07 实测）

基于 6 月 17 日那场 2 小时 52 分直播：

| 编导 | 单场 | 切出 | 每秒成片 | 每小时直播 |
|---|---:|---:|---:|---:|
| 豆包 Seed 2.0 Pro | ¥15.16 | 74 条 / 6,126 秒 | ¥0.0025 | ¥5.27 |
| OpenAI gpt-5.6-sol | ¥93.09 | 108 条 / 8,879 秒 | ¥0.0105 | ¥32.36 |

每秒单价基本不随直播时长变化。5 小时直播豆包约 ¥26、OpenAI 约 ¥162；**但 5 小时撞的是机器上限（内存、磁盘、9GB 上传上限），不是钱**。
