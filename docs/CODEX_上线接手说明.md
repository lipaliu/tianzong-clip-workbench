# 天总切片系统：Codex 上线接手说明

**仓库：** `lipaliu/tianzong-clip-workbench`
**交接分支：** `main`
**交接基线：** `de34c73`（`Forward processor runtime settings through authenticated Worker`）
**目标：** 恢复并验证“工作台上传完整录屏 → 创建异步任务 → 腾讯云 Worker 处理 → OpenAI / Kimi K3 / 豆包编导 → 候选与成本账单”的真实试用闭环。

> 本文件刻意不包含任何 API Key、COS Secret、会话密钥、Cloudflare Secret、服务器登录密码、私有 Skill 内容或用户视频。它们只能从既有腾讯云受限环境、Cloudflare Secret 或各模型供应商后台读取并配置，绝不能提交到 Git。

## 1. 当前真实状态

| 项目 | 状态 | 说明 |
|---|---|---|
| GitHub 主分支 | 已同步 | 本地与 `origin/main` 一致，交接基线为 `de34c73`。 |
| 前台 | 已发布 | Worker 地址：`https://tianzong-clip-workbench.lipaliu514.workers.dev/`。内部登录、D1 项目记录和页面静态资源可用。 |
| 腾讯云后端 | 已部署 | 已有 API、Worker、PostgreSQL、FFmpeg、私有 COS 与 Cloudflare 隧道链路；不要重装或删除现有数据卷。 |
| 私有 Skill | 已强制校验 | Worker 会校验对象键、版本、SHA-256 与包内清单；不得替换成通用 Prompt 或取消失败关闭。 |
| 模型路由 | 已实现 | `openai`、`doubao`、`kimi`、`compare` 均在源码、数据库迁移、前端与成本台账中接通。 |
| 生产阻塞 | 未完成 | 前台动态路由仍返回“真实分析服务尚未配置”，导致项目创建尚未进入 COS 上传或模型调用。 |

## 2. 已完成的关键代码改动

| 提交 | 内容 |
|---|---|
| `7857398` | 新增 Kimi K3 编导模式、三模型对比和真实成本台账 UI。 |
| `9ec9e8f` | 兼容历史项目的 `compare_all` 值，避免 Kimi 迁移破坏旧项目。 |
| `1180dcb` | 增加已上线系统的试用与验收说明。 |
| `de34c73` | 外层 Cloudflare Worker 从运行时绑定读取处理器配置，并以仅内部可信请求头转交动态应用路由，避免 Git 构建下应用路由模块级环境变量丢失。 |

代码位置如下：

| 文件 | 职责 |
|---|---|
| `worker/index.ts` | 外层 Cloudflare Worker；内部认证、静态资源、D1/ASSETS 绑定和处理器配置转交。 |
| `app/api/runtime/[...path]/route.ts` | 服务端签名代理；将浏览器的 `/api/runtime/*` 请求安全转发至腾讯云处理器 `/v1/*`。 |
| `processor/src/worker.ts` | 腾讯云后台异步处理工作器。 |
| `processor/src/pipeline/kimi-editor-client.mjs` | Kimi K3 的严格结构化编导适配。 |
| `processor/migrations/007_kimi_editor.sql` | Kimi 与历史 `compare_all` 兼容迁移。 |
| `docs/当前上线状态与试用验收.md` | 不含密钥的部署与试用基线。 |

## 3. 当前故障的精确表现与判断

前台可登录、上传本机文件、选择“带货 / 聊播”和“三模型对比”；点击“开始分析”后，D1 中会创建一个项目记录，但 `processorJobId` 为空，随后报错：

> 真实分析服务尚未配置。需要 `PROCESSOR_API_URL`、`PROCESSOR_KEY_ID` 和 `PROCESSOR_API_SECRET`。

这发生在浏览器调用 `POST /api/runtime/projects` 时，**早于** COS 上传、转写、FFmpeg 或三家模型调用，因此不是 OpenAI/Kimi/豆包 Key 缺失，也不会产生模型费用。

已证实 Cloudflare Git 自动部署后的活动 Worker 未能读取这三项配置。根因要优先按“活动生产版本的 Secret/变量没有持久化”处理；不要通过把密钥写进 Git、`wrangler.json`、前端变量或浏览器代码绕过。

## 4. Codex 应执行的修复步骤

### 4.1 先建立安全的 Cloudflare CLI 权限

在具有 Cloudflare 账号权限的环境中执行：

```bash
cd tianzong-clip-workbench
npx wrangler login
npx wrangler whoami
```

确认账号下存在 Worker：`tianzong-clip-workbench`。不要使用不同账户新建同名或相似 Worker，否则会把现有内部登录/D1/地址割裂。

### 4.2 从现有腾讯云受限环境读取值，不要新造密钥

现有腾讯云机器已有处理器与受限 `.env` / 容器配置。只读取以下三类值：

| Cloudflare Secret 名称 | 来源 | 说明 |
|---|---|---|
| `PROCESSOR_API_URL` | 已运行处理器的 HTTPS 隧道或正式 API 域名 | 必须是不带 `/v1` 的基础 URL。现有快速隧道仅供临时试用；后续替换为命名隧道/固定域名。 |
| `PROCESSOR_KEY_ID` | 后端内部 API key 配置 | 当前部署预期身份为 `sites-proxy`。 |
| `PROCESSOR_API_SECRET` | 同一条 `sites-proxy` 内部 API key 的 Secret | 与腾讯云处理器当前校验值必须完全一致。 |

不要在聊天、终端历史、CI 日志、Git diff 或 `wrangler.toml/json` 中打印这些值。

### 4.3 将三项配置写入活动生产 Worker Secret

建议全部以 Secret 存储，即使 URL 与 key ID 不敏感，也能避免 Git 环境变量覆盖的歧义：

```bash
npx wrangler secret put PROCESSOR_API_URL --name tianzong-clip-workbench
npx wrangler secret put PROCESSOR_KEY_ID --name tianzong-clip-workbench
npx wrangler secret put PROCESSOR_API_SECRET --name tianzong-clip-workbench
```

每条命令使用交互式输入，不要把值写在命令行参数中。若部署平台已明确区分 `production` 环境，请确保 Secret 写入的是当前 Workers 域名使用的**生产环境**，而不是 Preview。

`worker/index.ts` 已将这些绑定传入可信内部请求头，`app/api/runtime/[...path]/route.ts` 会优先读取这些头，再回退到运行时绑定。不得允许浏览器自行设置 `x-tianclip-*` 头：外层 Worker 必须继续覆盖客户端输入。

### 4.4 重新部署并验证（无模型费用）

```bash
npm ci
npm run build
npm test
```

随后发布当前 `main`，并在已登录内部工作台会话下进行以下验证：

1. 访问 `GET /api/runtime/projects/<已有项目ID>`，不应返回“真实分析服务尚未配置”。
2. 在前台重新选择一条测试原片，选择“聊播/带货”和任意编导模式。
3. 点击“开始分析”后，先确认 D1 项目得到 `processorJobId`，且页面进入“上传完整直播原片”阶段。
4. 到此为止才允许继续真实素材任务；模型调用、转写与渲染会开始产生实际费用。

如果第 1 步失败，优先检查 Worker 生产 Secret 作用域、Worker 名称和活动部署版本；不要先重启或重装腾讯云后端。

## 5. 真实视频验收后的剩余稳定化

第一条真实视频成功进入队列后，再处理以下事项：

| 优先级 | 项目 | 要求 |
|---|---|---|
| P0 | 临时隧道替换 | 把随机快速隧道替换为 Cloudflare 命名隧道或固定域名；当前临时 URL 可能在服务重启后改变。 |
| P0 | 三家模型 Key 验证 | 分别验证 OpenAI、Kimi K3、豆包的后端 Secret 和授权额度；Key 只留在腾讯云受限环境。 |
| P1 | 单视频端到端验收 | 用一条 10–30 分钟的非敏感 MP4/MOV 跑通候选、粗剪 MP4、SRT/XML、人工复核和成本账单。 |
| P1 | 访问凭证收紧 | 当前内部测试账号应在验收后更换为团队独立的强密码或账号体系。 |
| P2 | 处理器安全维护 | 升级扫描发现的高危依赖；不要在修复 P0 配置时混入大范围依赖升级。 |

## 6. 严格禁止事项

1. 不提交 `.env`、`*.secret`、COS 密钥、模型 Key、会话密钥、隧道 token、私有 Skill 或用户视频。
2. 不修改私有 Skill 的版本锁、校验和或失败关闭逻辑来让任务“看起来能跑”。
3. 不把模型 API Key 下发到 Cloudflare 前端或浏览器。
4. 不删除现有腾讯云 PostgreSQL 数据卷、COS 原片/成片对象、旧容器或历史项目；先备份、再做可回滚变更。
5. 不让真实视频任务绕过人工复核后直接发布内容。

## 7. 建议给 Codex 的任务提示词

```text
请在 lipaliu/tianzong-clip-workbench 的 main 分支接手生产修复。先阅读 docs/CODEX_上线接手说明.md 与 docs/当前上线状态与试用验收.md。当前目标不是重写产品，而是修复 Cloudflare 生产 Worker 读不到 PROCESSOR_API_URL、PROCESSOR_KEY_ID、PROCESSOR_API_SECRET 的问题。严格不提交任何密钥、私有 Skill 或用户视频；保持私有 Skill 的版本/哈希强制校验。使用 Cloudflare Secret 写入当前生产 Worker，验证 /api/runtime/projects/<已有ID> 不再返回未配置错误，然后仅验证项目创建到获得 processorJobId。真实视频与模型费用调用必须在用户明确确认后执行。
```
