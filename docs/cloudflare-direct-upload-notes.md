# Cloudflare 静态资源 Worker 直传要点

来源：[Cloudflare Workers Direct Uploads](https://developers.cloudflare.com/workers/static-assets/direct-upload/)，提取于 2026-08-12。

Cloudflare 官方文档说明，带静态资产的 Worker 通过 API 发布需要三步：先向 `POST /client/v4/accounts/:accountId/workers/scripts/:scriptName/assets-upload-session` 提交包含路径、32 位十六进制 hash 与字节数的资产清单；再按响应的 `buckets` 分组，调用 `POST /client/v4/accounts/:accountId/workers/assets/upload?base64=true` 上传 base64 编码资产；最后向 Worker 脚本上传端点提交模块与 metadata，其中 `assets.jwt` 必须使用资产上传完成后得到的 completion token。

文档指出，资产 session 响应会给出有效期一小时的 JWT 与需要上传的哈希桶；若 `buckets` 为空，可直接使用初始 JWT 进入版本发布。部署 metadata 要指定 `main_module`、`compatibility_date`、`assets.jwt`；若 Worker 代码要读取资产，应在 `bindings` 中保留 `{ "name": "ASSETS", "type": "assets" }`。直接 API 上传是高级流程，官方默认建议使用 Wrangler。

本项目发布保护要求：保留现有 `ASSETS`、`DB` 与认证/处理器 Secret 绑定；不得在任何发布模块、metadata、Git 或日志中暴露 `PROCESSOR_API_SECRET` 或内部认证 Secret。生产 Worker 当前还缺 `PROCESSOR_API_URL` 与 `PROCESSOR_KEY_ID`，在设置实际处理器基础 URL 前不能完成端到端分析验收。

## Reference

- Cloudflare. “Direct Uploads.” https://developers.cloudflare.com/workers/static-assets/direct-upload/

## Worker Settings Patch

Cloudflare OpenAPI spec 查询结果显示，`PATCH /accounts/{account_id}/workers/scripts/{script_name}/settings` 用于更新 Worker 元数据或配置（包括 bindings），请求主体为 `multipart/form-data`，其中 `settings` 表单字段为 JSON。接口文档明确 bindings 是绑定列表；生产变更必须基于当前完整绑定集合构造，避免遗漏 `ASSETS`、`DB`、`INTERNAL_AUTH_CREDENTIALS`、`INTERNAL_AUTH_SESSION_SECRET`、`PROCESSOR_API_SECRET` 等既有绑定。该接口可创建 Worker 新版本，因此更新前后都应复核绑定名和类型。
