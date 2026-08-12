# 生产入口核验记录

核验时间：2026-08-12（GMT+8）

| 地址 | 结果 | 观察 |
|---|---|---|
| `http://localhost:3000/` | 可访问 | 本地开发服务可启动，但未提供测试账号，因此只能核验登录页。 |
| `https://tianzong-clip-workbench.lipaliu514.workers.dev/` | 可访问 | 生产 Worker 可访问并展示内部登录页；截图仍为旧的粉色登录视觉，说明刚推送到 GitHub 的工作台界面改动尚未发布到 Worker。 |

生产 Worker 当前工作，但不能以此证明上传与分析链路可用：Worker 设置缺少 `PROCESSOR_API_URL` 与 `PROCESSOR_KEY_ID`，而云端账户没有可发现的活动命名隧道或 DNS zone，无法从现有账户记录恢复处理器 HTTPS 基础地址。

## 无 Token 控制台路径检查

访问 `https://dash.cloudflare.com/` 后，浏览器进入 Cloudflare 登录页且当前会话无有效登录态；该路径要求账号邮箱/密码、SSO 或第三方登录，并出现验证码错误提示。因此它不能作为“无需用户登录或提供凭据”的自动发布通道，已停止使用，不会要求用户输入 Token。

## 用户浏览器会话

用户浏览器已成功进入 Cloudflare 账户 `Lipaliu514@gmail.com` 的控制台主页，当前账户页面可见 `tianzong-clip-workbench` Worker 与 `tianzong-clip-workbench-db` D1 数据库。因此后续发布可使用该现有会话完成，无需用户提供或输入 API Token。

## 生产 Worker 发布入口

在用户浏览器的 Cloudflare 控制台中，`tianzong-clip-workbench` 显示为已连接 GitHub 仓库 `lipaliu/tianzong-clip-workbench`，最新提交摘要为 `Improve resumable uploads and editorial workbench UX`，时间显示为约 4 小时前。Worker URL 为 `tianzong-clip-workbench.lipaliu514.workers.dev`。这意味着代码已被 Git 集成检测到；下一步需要进入 Worker 详情核查最新部署是否已发布并补齐运行时变量。

## Worker 详情与版本核验

用户浏览器中的 Worker 详情页显示生产版本 `d8aefa5f`，对应提交 `Improve resumable uploads and editorial workbench UX`，已在 `main` 生产环境中发布约 4 小时。该版本是本次上传续传、实时分析反馈和界面重构的提交，说明前端修复实际已上线。Overview 只显示 `ASSETS` 与 `DB` 两个非敏感绑定；历史版本显示 `PROCESSOR_API_SECRET` 曾由控制台添加，但运行时仍缺少 `PROCESSOR_API_URL` 与 `PROCESSOR_KEY_ID`，这正是分析无法启动的唯一生产阻塞点。

## 腾讯云后端恢复路径

用户浏览器已登录腾讯云国际账户。CVM 默认广州区域没有可用实例，但控制台可切换至新加坡（Singapore）等海外区域；项目的对象存储与部署配置均指向 `ap-singapore`，因此新加坡是恢复处理器服务器的首选区域。接下来将只读取新加坡实例清单和现有公网地址，不会新建实例、产生费用或修改服务器。

新加坡区域 CVM 实例列表未显示任何现有实例；控制台仅提供购买 CVM 或 Lighthouse 的入口。为避免产生未授权费用，未执行创建服务器操作。因此，现有处理器不是通过该腾讯云国际账户的新加坡 CVM 运行，或已被删除；不能凭空配置 `PROCESSOR_API_URL`。

腾讯云国际账户的新加坡 Lighthouse 实例列表同样为空，仅显示购买入口。现有账号中没有可用于恢复处理器的 CVM 或 Lighthouse 主机；未进行任何创建或付费操作。

额外检查的 Render 控制台未保留登录态，无法在不进行新的账号登录授权的情况下读取或恢复现有服务，因此没有继续操作。已返回 Cloudflare Worker 的生产设置入口，准备通过用户现有登录会话仅处理可验证的运行时配置。

## 生产变量核验

Cloudflare 生产设置页确认当前仅配置 `INTERNAL_AUTH_CREDENTIALS`、`INTERNAL_AUTH_SESSION_SECRET` 与 `PROCESSOR_API_SECRET` 三个 Secret。根据项目自身的服务约定，可无歧义补充的 `PROCESSOR_KEY_ID` 是固定值 `sites-proxy`；但 `PROCESSOR_API_URL` 必须是真实后端 HTTPS 地址，无法从现有 Cloudflare、腾讯云国际 CVM/Lighthouse 或 Git 历史中恢复，不能凭空填写。

## 腾讯云规格与计费依据

腾讯云官方文档显示，标准实例 S8.LARGE8 和 SA5.LARGE8 都提供 4 vCPU / 8 GB 内存；S8.LARGE8 的标准网络带宽为 2 Gbps、SA5.LARGE8 为 1.5 Gbps，均适合通用计算与中等数据处理。CVM 按量计费可按秒启停，但官方价格页明确 CPU/内存以外的系统盘、数据盘、镜像与公网带宽另计，购买页价格为最终依据。Lighthouse 官方页面的公开套餐展示最高仅 2 vCPU / 4 GB、90 GB SSD、30 Mbps、2.5 TB 月流量（$8.5/月），该档位不适合作为 8GB 原片 FFmpeg + 转写的稳定生产处理器；Lighthouse 同时采用预付费订阅且套餐只能升级不能降级。建议选 CVM 的 4 vCPU / 8 GB、Linux、200 GB SSD、按量计费作为首台处理器，低风险启动且能随工作量扩容。

参考：
- https://www.tencentcloud.com/document/product/213/11518
- https://buy.tencentcloud.com/pricing/cvm?regionId=33&zoneId=330001&lang=en&pg=
- https://intl.cloud.tencent.com/products/lighthouse

腾讯云国际 CVM 购买页已打开并可配置实例。页面提供月付、按量计费与可能被回收的竞价实例；海外地域按量计费页面标示可享 22% 折扣。当前尚未选择实例规格、网络或提交订单，因此未产生任何费用。下一步仅会选定新加坡 4 vCPU / 8 GB 方案并读取确认页总价。

购买页已切换到新加坡并提示该地域处于高需求状态，建议必要时更换地域。新加坡当前默认 2 vCPU / 2 GB 的月付参考价为 $24.60；页面仍在加载实例费率。尚未选定或提交 4 vCPU / 8 GB 的订单，未产生费用。若要优先中国大陆访问体验，香港可作为没有备案前的备选，但与 COS 新加坡跨地域将牺牲处理链路效率；新加坡同区域仍是后端处理最稳妥的首选。

腾讯云新加坡现有 4 vCPU / 8 GB 推荐规格为 `SA9.LARGE8`（AMD EPYC Turin-D，2 Gbps 私网带宽，300k PPS），月付计算资源参考价为 $45.46/月（原价 $59.04/月），不含系统盘、数据盘、镜像和公网带宽。页面提示新加坡资源紧张；按量计费可作为首月验证方案，但最终购买需在包含 200 GB SSD 与公网网络后的确认页以实际总价为准。

已在购买页预选新加坡 Zone 2、`SA9.LARGE8`、Ubuntu、200 GB Balanced SSD 和公网 IP，当前页面仍在查询总费用，尚未进入网络配置或订单确认步骤。未创建实例，未产生费用。

### 最终待确认购买配置

腾讯云国际购买页已完成新加坡 Zone 2 的预配置：Ubuntu、`SA9.LARGE8`（4 vCPU / 8 GB）、200 GB Balanced SSD、1 台、月付。页面显示 CPU/内存月费 $45.46，加入 200 GB 系统盘后的当前配置总额为 **$67.46 首月**（页面显示节省 $13.58；公网网络实际费用和带宽策略仍将在下一步网络配置中确认）。当前仍停在“Next: Configure network and host”前，未提交订单、未创建实例。

## 腾讯云国际付费资源审计入口

腾讯云官方文档确认：国际账户的统一续费与自动续费资源可在 `https://console.tencentcloud.com/expense/renewal` 查看；资源包需要另在 `https://console.tencentcloud.com/expense/resourcepackage` 查看；实时账单明细入口为 `https://console.tencentcloud.com/expense/bill`。续费管理可能不显示未接入统一页的产品或按量计费资源，因此必须同时查看账单与各产品控制台。当前访问的 `/expense/overview` 已失效，不作为审计结果。

参考：
- https://www.tencentcloud.com/document/product/555/7454
- https://www.tencentcloud.com/document/product/555/12212
- https://www.tencentcloud.com/document/product/555/57403

### 腾讯云国际订阅审计结果

已登录账户的 Renewal Management 页面显示：全部产品 0、手动续费 0、自动续费 0、不续费 0，且无资源记录。因此该国际账户目前没有通过统一续费管理可取消的订阅、自动续费实例或预付费资源。
已核验腾讯云国际账户的 Resource Package Management：总项目数为 0，无有效资源包、流量包、存储包或套餐续费记录。
已进入 Cloudflare 账户的 Subscriptions 页面；页面说明订阅除非另行注明均会自动续费。目前产品、状态、付款方式与账单资料仍在加载，尚未执行任何取消操作。
### Cloudflare 订阅审计结果

Cloudflare Billing > Subscriptions 显示唯一产品为 `Workers Free`，状态 Active；账户没有绑定付款方式、账单邮箱或账单地址。因此该账户没有可取消的付费 Worker 计划，也无法产生正常的付费订阅扣款。可计费用量页已打开，仍在加载中，将继续核验不存在隐藏的按量使用费。
### 火山引擎初步审计结果

用户浏览器已登录火山引擎中国大陆主账号。控制台首页显示：待支付订单 0、30 天内到期资源 0、本月已花费 ¥0.00、可用余额 ¥500.00。说明该账户当前没有明显的预付费到期项目；下一步将进入费用中心核验是否存在按量计费资源或历史账单。
火山引擎费用中心显示最近三个月账单均为 ¥0.00、待支付 0、近 7/30 天到期资源均为 0、待开发票 ¥0.00、代金券 0；但账户存在 **8 个资源包**。这些资源包未显示在到期或待支付列表中，可能是免费额度、未启用配额或已购但零消耗资源，必须逐项读取其产品、有效期和续费方式后才能决定是否取消。
### 火山引擎资源包明细

资源包管理页列出 8 项生效资源：

1. 5 项**明确标注“免费在线推理资源包”**的豆包模型额度，每项 50 万 token，均为递减型，分别有效至 2028 年；其中 Doubao-Seed-2.1-turbo 余量 90,018 token，Doubao1.5-vision-pro-32k 余量 348,471 token，其余免费包未消耗或几乎未消耗。
2. 3 项对象存储（TOS）周期型资源包：10 GB 公网流出、10 GiB 标准存储容量、20 万次标准存储请求，均为国内通用、有效至 2026-10-13，当前余量均为 100%。页面提供“续费”而不是“取消”操作，且费用中心近三个月账单仍为 ¥0.00。

因此 5 项豆包包可确定无需取消且不会产生订阅费用；3 项 TOS 包仍需查看原始订单金额和续费设置，确认是否为赠送额度或实际付费后，才讨论关闭或不续费。
火山引擎订单管理在默认最近一个月区间仅显示 2 笔豆包大模型新购订单，均为“已支付”但原价和应付均为 ¥0.00，进一步佐证其为免费资源包。对象存储包购于 2026-04-13，需将订单时间范围切换到该日期后核验其成交金额和是否可退订。

## 云资源付费与续费审计结论

### 腾讯云国际

- 统一续费管理：手动续费 0、自动续费 0、到期不续费 0。
- 资源包管理：0 项。
- 因此没有可取消的预付费套餐或自动续费资源。

### Cloudflare

- 唯一订阅为 `Workers Free`，无付款方式、账单邮箱或账单地址。
- 可计费用量页显示无数据。
- 因此没有付费 Worker 计划或待结算使用费可取消。

### 火山引擎中国大陆

- 最近三个月账单均为 ¥0.00，待支付 0、近 30 天到期 0。
- 5 个豆包资源包均是明确标注的免费在线推理资源包，订单原价/应付均为 ¥0.00。
- 3 个 TOS 资源包的合并订单原价为 ¥37.14，但应付为 **¥0.00**；其当前余量 100%，有效至 2026-10-13。
- 续费管理中的手动续费、自动续费和到期不续费均为 0，表示这些资源没有配置自动扣款或待续费事项。

结论：三套账户中**不存在已经付费且可取消的套餐，也没有自动续费项目**。为避免误删仍有效的免费模型额度和免费 TOS 额度，未执行任何退订操作。
火山引擎首次进入 ECS 创建页要求授权创建跨服务 IAM 角色 `ServiceRoleForECS`，用于访问 TOS、私有网络与弹性块存储。该授权会修改账户权限配置，而当前任务仅处于报价阶段，因此未点击“立即授权”，也未创建服务器或产生费用。
### 火山引擎北京 ECS 实时配置页

已完成 ECS 系统服务角色授权并进入华北2（北京）按量计费购买页，未勾选服务条款、未点击购买。默认可用规格 `ecs.g4i.large` 为 2 vCPU / 8 GiB，实例单价 ¥0.4591/小时；默认 20 GiB PL0 系统盘后，配置费用显示为 ¥0.4801/小时。公网 IP 选择 BGP 按实际流量计费，页面显示 ¥0.8000/GB。控制台内可见 4 vCPU / 16 GiB 的 `ecs.g4i.xlarge`，实例单价 ¥0.9181/小时；暂未选择、不产生费用。

工程上建议将原始视频直传 TOS、ECS 仅接收小型 API 调用和处理 TOS 中的数据，因此无需为 ECS 购买高公网带宽；主要成本为计算和 200 GiB 系统/数据盘。后续会在控制台精确切换磁盘和规格并记录合计小时单价。
火山北京区域控制台当前未提供 4 vCPU / 8 GiB 的通用实例组合；同代可用的最低两档为 2 vCPU / 8 GiB（`ecs.g4i.large`，¥0.4591/小时）和 4 vCPU / 16 GiB（`ecs.g4i.xlarge`，¥0.9181/小时）。按 PL0 系统盘 ¥0.00105/GiB·小时的控制台价格估算，200 GiB 磁盘成本为 ¥0.2100/小时，因此：2核8G+200GiB 的计算与磁盘合计约 **¥0.6691/小时，约 ¥481.75/30天**；4核16G+200GiB 合计约 **¥1.1281/小时，约 ¥812.23/30天**。公网 IP 选择按实际流量计费为 ¥0.80/GB；本方案用浏览器直传 TOS、ECS 与 TOS 同地域内网处理，正常上传流量不经 ECS 公网出口。
控制台筛选后确认北京地区存在实际可用的 4 vCPU / 8 GiB 计算型实例 `ecs.c4i.xlarge`（Intel Granite Rapids，¥0.7132/小时）；它比先前临时比较的 2核8G 更适合视频转码，并比 4核16G 便宜。加 200 GiB PL0 云盘后，基础成本为约 ¥0.9232/小时，连续 48 小时约 ¥44.31，仍在两天测试的可接受成本范围内。已在购买页选中该实例，仅停留在配置阶段，尚未选镜像、设置磁盘或点击购买。
两天测试实例已在火山购买页预配置为 `ecs.c4i.xlarge`（4 vCPU / 8 GiB）、Ubuntu 24.04（安全加固镜像）和 200 GiB PL0 系统盘；公网 IP 保持按实际流量计费且默认 1 Mbps。系统仍在重新计算配置费用；尚未配置登录密钥、开放安全组或勾选服务条款，未创建实例。
已选用默认私有网络、默认子网与默认安全组，公网 IP 为 BGP 按实际流量计费且带宽上限 1 Mbps，EIP 将随实例释放。控制台最终显示计算与200 GiB磁盘的配置费用为 **¥0.9232/小时**（两天约 ¥44.31，不含公网出流量）；登录凭据已配置为仅用于本次测试的高强度临时密码，未在文档或版本库中保存。尚未勾选服务条款或提交创建。

## 2026-08-12 国内处理器认证方案调整

- 火山控制台已成功创建无控制台登录的 IAM 服务用户 `changdao-processor-test`；其初始长期 Access Key 已禁用。由于 My Browser 下载文件不会同步至受控环境，且控制台只遮罩显示已创建 Key 的 Secret，未把任何长期 Secret 写入代码、终端记录或仓库。
- 为避免依赖长期 AK/SK，后端认证改为火山 ECS Instance Role。官方说明确认：ECS 可绑定信任身份为“云服务器”的 IAM 普通服务角色，并通过 IMDSv2 从 `http://100.96.0.96` 取得会自动刷新的 STS 临时凭据；实例上无需保存 SecretKey。下一步将创建仅具测试私有桶对象权限的角色，绑定实例，再改造处理器的 S3 客户端使用该凭据链。
- 参考：
  - https://www.volcengine.com/docs/6396/1278083
  - https://docs.volcengine.com/docs/6257/2100113?lang=zh
  - https://raw.githubusercontent.com/volcengine/volcengine-nodejs-sdk/master/docs/1-Credentials-zh.md

## 2026-08-12 国内处理器临时凭据进展（续）

- 火山北京处理器实例 `changdao-processor-test`（4 vCPU / 8 GiB，200 GiB SSD）已运行，实例 ID 为 `i-yesoa5xn285i3z64ehn0`。
- 私有 TOS 桶 `changdao-clip-test-20260812` 已创建于 `cn-beijing`。
- IAM 角色 `changdao-processor-ecs-role` 已绑定至该实例；IMDSv2 可返回该角色的短期临时凭据，处理器代码已新增对应刷新提供器。
- 正通过 IAM 可视化编辑器创建 `ChangdaoProcessorTosTestPolicy`，仅配置 TOS 的对象上传、读取、删除及分片操作，避免全局 TOS 权限。
- JSON 编辑器未同步其动作数组并报空操作校验错误，已切换到可视化编辑器继续配置。

当前可视化策略已选定五项 TOS 操作：`PutObject`、`GetObject`、`DeleteObject`、`ListMultipartUploadParts` 与 `AbortMultipartUpload`。这些操作覆盖分片上传、刷新后的已上传分片对账、分析读取与异常清理；策略资源正在从“全部资源”收紧至 `changdao-clip-test-20260812` 私有桶。

最小权限策略的资源范围已收紧为对象 TRN `trn:tos:cn-beijing:2124526618:changdao-clip-test-20260812/*`，不包含其他地域、账户、桶或对象路径。

火山可视化权限编辑器已将 TOS 操作限定为当前测试桶范围内的分片终止、分片清单、对象读取与对象写入；控制台对对象删除项采用了标签/版本细分操作，均只作用于测试桶。正式业务验证完成后需一并删除此临时策略和实例角色，避免留下无用权限。

火山北京 ECS 已用实例角色 `changdao-processor-ecs-role` 成功通过 IMDS 临时凭据对私有桶 `changdao-clip-test-20260812` 完成写入、Head 校验与删除测试。S3 SDK 必须使用火山 S3 专属端点；ECS 内网端点为 `https://tos-s3-cn-beijing.ivolces.com`，并保持 virtual-hosted 寻址，不能使用通用 TOS 端点。

火山方舟 Default 项目中新建了专用 API Key：名称 `changdao-processor-test`，资源 ID `apikey-20260812185325-qtp5n`，状态生效，权限为该项目全部资源。旧项目 API Key 未改动。

方舟 API Key 页面交互中，旧项目 Key 的显示控件被误触，已明确忽略该值：未复制、未保存、未写入服务器，后续不会使用或变更旧项目 Key。处理器专用 Key `changdao-processor-test` 仍需单独读取并写入受限配置。

已刷新方舟 Key 管理页，历史项目 Key 均恢复为掩码显示。后续仅操作 `changdao-processor-test` 行的专用 Key 显示控件。

已读取 `changdao-processor-test` 专用方舟 Key 用于受限服务器配置，随后刷新页面并恢复掩码显示；密钥不会写入仓库、文档或用户消息。

豆包语音新版控制台已核验：Default 项目的语音 API Key 列表为空，尚未创建或修改任何语音 Key 或语音服务资源。当前处理器若使用豆包录音文件识别，需单独创建语音 API Key。

豆包语音 Default 项目“我的资源”为 0；录音文件识别尚未开通。购买页已仅查看：提供录音文件识别 2.0 的预付费/后付费选项；当前未勾选条款、未选择规格、未提交订单，金额为 ¥0.00。

官方依据：火山“录音文件识别标准版 HTTP”文档说明新版控制台以 `X-Api-Key` 接入并支持 `volc.seedasr.auc` / `volc.bigasr.auc` 资源 ID：https://www.volcengine.com/docs/6561/1354868 。火山 S3 SDK 文档说明北京 ECS 内网访问应使用 S3 专属 endpoint `https://tos-s3-cn-beijing.ivolces.com`，且仅支持 virtual-hosted 寻址：https://www.volcengine.com/docs/6349/2387330 。

北京处理器实例 `changdao-processor-test` 已核验为运行中，规格 4 vCPU / 8 GiB、200 GiB SSD，公网 IP 为 124.174.9.168、1 Mbps 按实际流量计费；受控环境 SSH 在 banner 阶段超时，下一步仅核查 Default 安全组的入站规则与控制台远程连接。

已核验实例 Default 安全组：TCP 22、80、443 均向 0.0.0.0/0 允许；因此受控环境 SSH banner 超时不是安全组拒绝，需使用控制台终端或继续诊断主机侧 SSH 服务。

ECS Terminal 已打开，当前仅要求实例创建时的临时 root 密码；该凭据已由受控部署流程保存并自动填入，用户无需输入或重置。登录请求已提交，等待终端会话建立。

ECS Terminal 已验证能够以 root 建立实例内会话；网页每次新会话会要求临时密码，但用户无需提供。部署将改用云助手执行，以避免重复交互式密码提示；实例当前运行且默认安全组已放通 22/80/443。

云助手入口的初始直达路径被控制台重定向，仍需从运维导航或前端路由定位。ECS Terminal 已成功建立会话，但浏览器自动化无法向画布式终端注入命令；将优先恢复SSH或使用云助手，而不会要求用户再次输入密码。

北京处理器已完成数据库迁移、运行账户权限、私有核心对象恢复与校验；`/readyz` 返回 200。Caddy 已通过端口 80 将公网入口 `http://124.174.9.168` 反向代理至内部 API，外部 `/healthz` 返回 200。下一步是将生产 Worker 的受限处理器地址和内部签名绑定更新至该入口。

Cloudflare 生产Worker已新增文本变量 `PROCESSOR_API_URL=http://124.174.9.168`；待新增 `PROCESSOR_KEY_ID=sites-proxy` 并将现有 `PROCESSOR_API_SECRET` 更新为与北京处理器一致的受限签名值后，即可完成认证链路测试。

Cloudflare 生产Worker已新增 `PROCESSOR_KEY_ID=sites-proxy`，与现有 `PROCESSOR_API_URL` 一同保存。下一步为覆盖 `PROCESSOR_API_SECRET` 使其与北京处理器的受限内部签名值一致，再从生产入口进行认证路由测试。

Cloudflare生产Worker已发布运行时配置：`PROCESSOR_API_URL` 指向北京处理器，`PROCESSOR_KEY_ID=sites-proxy`，`PROCESSOR_API_SECRET` 已作为加密Secret同步。准备进行生产入口认证与上传契约验证。

北京处理器已通过 `https://124.174.9.168.sslip.io` 获得有效临时HTTPS证书，Cloudflare生产Worker已将 `PROCESSOR_API_URL` 更新并发布至该HTTPS入口。后续需用线上代理接口验证HMAC认证与上传启动契约。

提交 `7e81fe6`（字幕优先国内分析流程与默认火山主编）已推送；Cloudflare Git 自动构建已启动，等待其成为生产活动版本后再做登录态端到端上传验证。

方舟专用Key已通过非计费模型目录验证；北京处理器API与工作线程均为active，私有核心/TOS角色链路保持就绪。Caddy在80/443监听、持有有效sslip.io临时证书，实例本机按SNI访问`/healthz`返回200；需在正式使用前用自有域名替换临时sslip.io地址。Cloudflare Git构建`7e81fe6`仍在进行中。

Cloudflare构建详情显示提交`7e81fe6`的初始化、克隆、依赖安装、构建和部署均完成且为成功状态（总时长1分18秒）。北京数据库迁移账本确认`008_uploaded_subtitles.sql`已应用；处理器发布产物包含`subtitleUploadId`契约与SRT解析器。

生产工作台已实测展示新版双文件上传：原片与可选SRT为独立卡片，标题、说明与状态文案均可读且无重叠；用户可明确看到“上传SRT，跳过自动转写”和缺失SRT才调用语音识别的回退规则。

端到端只读任务请求曾返回“真实分析服务尚未配置”。检查生产设置发现仅`PROCESSOR_API_SECRET`持久存在；已重新以Production文本变量保存`PROCESSOR_API_URL=https://124.174.9.168.sslip.io`和`PROCESSOR_KEY_ID=sites-proxy`，两项现已显示在Worker变量列表中。

最新提交`7db261c`已进入Cloudflare Build History；生成的`dist/server/wrangler.json`确认包含`PROCESSOR_API_URL`与`PROCESSOR_KEY_ID`。此前线上运行时仍返回缺失配置，需要继续核验该构建成为活动版本及运行时绑定传递。

Cloudflare Build #01d945e8 对提交`7db261c`显示绿色成功标记；初始化、克隆、安装、构建、部署五个阶段均完成（总时长1分57秒），部署命令为`npx wrangler deploy --config dist/server/wrangler.json`。

最新生产只读代理已越过缺失变量阶段，但返回525 TLS握手错误。北京实例Caddy监听80/443，且已为`124.174.9.168.sslip.io`成功签发Let's Encrypt证书；从沙箱外部curl仍在TLS握手阶段中断，Caddy近三分钟无对应接入日志，表明请求未到达反向代理，需继续排查云网络入口。

已使用真实团队会话打开生产工作台，确认新版首页显示原片与可选SRT两张上传卡片，说明文字明确“未上传SRT时才调用语音识别”。此前用户看到的ERROR来自只读虚构任务ID验证，登录后该接口正确返回job_not_found，页面现已返回工作台。

真实小样本验收发现火山TOS兼容性差异：AWS S3 SDK默认将对象元数据移入预签名查询参数，随后浏览器按requiredHeaders重发元数据会被TOS以“headers present but not signed”拒绝；移除元数据头又会导致完成接口读取不到项目与SHA-256元数据。修复方式为S3Client使用`requestChecksumCalculation: WHEN_REQUIRED`，并在`getSignedUrl`中将`x-amz-meta-project-id`与`x-amz-meta-sha256`列为`unhoistableHeaders`，使其作为SigV4已签名请求头传递。该修复已通过本地构建和109项测试，并已同步到北京处理器；API和Worker服务均为active。

## 2026-08-13：火山自动转写回退兼容性依据

火山官方“录音文件识别标准版 HTTP”文档说明：新版控制台用 `X-Api-Key` 鉴权；录音文件识别模型 2.0 的资源 ID 是 `volc.seedasr.auc`；提交音频 URL 后返回任务 ID，再轮询结果；列出的容器格式包含 `mp3`，不包含 M4A。来源：https://www.volcengine.com/docs/6561/1354868

火山官方TOS端点表说明：华北2（北京）S3内网端点为 `tos-s3-cn-beijing.ivolces.com`，公网端点为 `tos-s3-cn-beijing.volces.com`。处理器内网读写继续使用内网端点；外部语音服务下载一次性音频时必须生成以公网端点为主机名的预签名 GET URL。来源：https://www.volcengine.com/docs/6349/107356

火山官方AWS S3 SDK文档进一步确认TOS S3端点仅支持虚拟主机样式，且应使用V4签名。来源：https://www.volcengine.com/docs/6349/2387330

## 2026-08-13：端到端生产验收结果

1. **用户SRT优先路径：通过。** 六秒原片与严格校验的SRT已完成受签名上传，任务的 `transcriptSource` 是 `uploaded_srt`，事件流明确记录“跳过自动语音识别”，任务进入 `review_ready`。
2. **自动语音回退路径：通过。** 使用约12.92秒的中文口播测试视频、且不提交SRT，任务的 `transcriptSource` 是 `automatic_asr`。事件顺序实测为：私有TOS下载 → 私有核心校验 → MP3音轨整理 → 豆包录音文件识别2.0 accepted/queued/completed → 时间戳逐字稿 → 2秒密集帧与镜头变化帧 → 火山 Seed Pro 私有Skill分析 → 私有核心复核 → `review_ready`。
3. **自动转写兼容性修复：** 初始静音样本被服务正确返回 `20000003 Normal silence audio`，证明服务与鉴权正常；随后以真实口播样本验证成功。外部模型下载失败 `45000006 Invalid audio URI` 的根因是处理器使用TOS内网预签名地址，已改为“内网读写 + 外网S3端点生成仅供外部提供方下载的一次性GET URL”。
4. **测试成本：** 成功的12.92秒自动转写与分析任务账本总计 `¥0.0731`。本次样本没有自然候选，因此结果为0条候选；系统不虚构切片。
5. **生产安全边界：** 上传仍为浏览器直传私有TOS，支持分片恢复；处理器使用ECS实例角色临时凭据，不在服务器保存TOS长期AK/SK；模型与语音密钥均仅存在于服务器受限环境文件，未写入Git或公开日志。

## 2026-08-13（第二轮）：浏览器上传失败的根因与修复

**用户报告：** 线上工作台再次无法上传。

**诊断过程：** 临时 HTTPS 隧道 `/healthz` 返回 200，处理器 `tianclip-api` 与 `tianclip-worker` 均为 active，说明后端在线。用真实 HMAC 走一遍生产上传契约后发现，`presignUpload` 返回的 PUT 地址主机是 `changdao-clip-test-20260812.tos-s3-cn-beijing.ivolces.com`，从公网发起连接直接 `UND_ERR_CONNECT_TIMEOUT`（尝试地址 100.64.152.225:443，属运营商级内网段）。

**根因：** 交给浏览器的预签名上传地址签在了 **TOS 内网端点**（`.ivolces.com`）上。该端点只在北京 VPC 内可解析可达，用户浏览器永远连不上，因此上传必然卡住直至超时。此前端到端验收是从北京实例内部发起上传，因而未暴露该缺陷。

**修复：**
1. `processor/src/storage.ts`：单文件预签名与分片预签名统一改用公网端点客户端（`providerClient`）签名；处理器自身的读写、HEAD、分片对账、下载仍走内网端点客户端，保持同地域低延迟且不产生公网流量。
2. 新增 `processor/src/tests/browser-upload-endpoint.test.ts`：断言浏览器可见的预签名主机必须是公网端点、不得泄漏 `ivolces.com`，同时断言处理器内部客户端仍指向内网端点。处理器测试 113/113 通过。
3. TOS 桶跨域规则：通过控制台为桶 `changdao-clip-test-20260812` 新增 CORS 规则（来源为线上工作台域名与本地开发地址；方法 PUT/GET/POST/DELETE/HEAD；Allow-Headers `*`；Expose-Headers 含 `ETag`，分片续传必须能读取；Max-Age 3600；开启 `Vary: Origin`）。实例角色为最小权限、不含桶配置写权限，故该项由控制台完成而非脚本执行。

## 2026-08-13：分片上传与断点续传真实验证

**分片体量调整依据：** 从沙箱（跨境链路）实测到北京 TOS 的上行速率仅约 0.2–0.3 MB/s，64 MiB 一片在约 68 秒被对端断开（`curl: (52) Empty reply from server`），而同一链路 8 MiB 分片 PUT 稳定返回 200 与 ETag。这说明分片过大在弱网下会让单片失败代价过高。因此：

- `SINGLE_PUT_MAX_BYTES` 默认值由 512 MiB 下调至 64 MiB（超过即走分片，不再让浏览器用一个脆弱的大请求上传）。
- `MULTIPART_PART_SIZE_BYTES` 默认值由 64 MiB 下调至 8 MiB（失败重传代价小、续传粒度细）。
- 北京实例 `/etc/tianclip/processor.env` 同步更新为 `SINGLE_PUT_MAX_BYTES=67108864`、`MULTIPART_PART_SIZE_BYTES=8388608` 并重启服务。
- 前端 `app/processor-client.ts` 的单片重试次数由 3 次提升到 6 次，退避上限由 4 秒放宽到 8 秒，且每次重试都重新签发分片地址，避免签名过期造成硬失败。

**端到端验证结果（`scripts/verify-resumable-upload.mjs`，全部 PUT 直打预签名主机）：**

| 阶段 | 结果 |
|---|---|
| 分片凭证签发 | 10 片，每片 8 MiB |
| 上传一半后中断 | 已传 5 片 |
| 云端断点对账 | 状态 `uploading`，云端确认已传 5 片，与实际一致 |
| 仅续传缺失分片 | 续传 5 片 |
| 合并完成 | 状态 `uploaded`，合并后 83,886,080 字节与源文件完全一致 |

处理器测试 113/113 通过。
