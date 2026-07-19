"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

type Mode = "聊播" | "带货";
type WorkflowStep = 1 | 2 | 3;
type Decision = "keep" | "remove";
type PersonaMode = "实战老板" | "强姐姐" | "视觉吸引" | "搞笑女" | "脆弱真实";

type TranscriptLine = {
  id: string;
  time: string;
  seconds: number;
  text: string;
  defaultDecision: Decision;
  reason: string;
  evidenceLevel: "原声逐字" | "逐字稿摘录" | "策划摘要";
  speaker?: string;
};

type ScorePart = {
  label: string;
  score: number;
  max: number;
};

type ClipIdea = {
  id: string;
  kind: Mode;
  index: string;
  title: string;
  duration: string;
  sourceTime: string;
  sourceStart: number;
  score: number;
  summary: string;
  contentType: string;
  durationMode: string;
  durationWindow: string;
  durationReason: string;
  selectionReasons: string[];
  scoreBreakdown: ScorePart[];
  priority: "S" | "A" | "B";
  factGate: string;
  calibrationStatus: string;
  thumbnail: string;
  video: string;
  transcript: TranscriptLine[];
};

const corpusBaseline = {
  version: "内测 BETA 1.0",
};

const personaSpectrum: { label: PersonaMode; description: string }[] = [
  { label: "实战老板", description: "有公司、品牌、直播、电商、供应链与用人经验。" },
  { label: "强姐姐", description: "面向女性观众，嘴快、结论直接、主意很正。" },
  { label: "视觉吸引", description: "漂亮、会穿、会展示，镜头里有稳定吸引力。" },
  { label: "搞笑女", description: "随时唱跳、做饭翻车、逗猫，也会装逼失败。" },
  { label: "脆弱真实", description: "会谈自卑、原生家庭、爱情、失去与疲惫。" },
];

const corePersonality = [
  "结论先行：常用“不要、先、根本、一定、直接”把立场摆在前面。",
  "老板视角：习惯讲用户、痛点、数据、成本、效率、复购、供应链与结果。",
  "姐妹语境：高频称“姐妹、宝贝”，把强势判断包进熟人式照顾。",
  "自信但不端着：会展示财富、身材、业务和能力，也会马上自嘲或翻车。",
  "强控制感：主张先行动、先试、看数据、复盘，不把决定权交给伴侣或环境。",
  "敢露脆弱：会承认自卑、身材焦虑、丧、爱情创伤和家庭距离。",
];

const stableValues = [
  "女性先建立经济能力、工作能力与生活掌控感。",
  "赚钱与事业不同，短期收入与长期价值也不同。",
  "做事先看真实用户和数据，不只凭想象。",
  "学历是重要的一张牌，但不是整副人生。",
  "不把男人、婚姻、别人评价或一次失败当人生中心。",
  "自媒体不是低门槛捷径，普通日常需要具体观看价值。",
  "读书、学习和行动应形成闭环，不能只靠听鸡汤获得安慰。",
  "美和穿衣应服务本人，不用参加女性之间的竞争。",
];

const coreAudience = [
  "18–35 岁，处在求学、求职、转岗、创业或自媒体起步期的女性。",
  "想做直播、电商、个人 IP、穿搭美妆或小生意的人。",
  "在分手、催婚、关系边界、独处或自我价值上需要明确答案的人。",
  "喜欢漂亮女性、穿搭、身材、唱跳、做饭和宠物的人。",
  "把她当“电子闺蜜、强姐姐、会发疯的老板”的长期粉丝。",
];

const scoreLabels = [
  { label: "前三秒", max: 20 },
  { label: "情绪", max: 20 },
  { label: "金句", max: 20 },
  { label: "共鸣", max: 15 },
  { label: "闭环", max: 15 },
  { label: "反转", max: 10 },
];

function scoreParts(scores: number[]): ScorePart[] {
  return scoreLabels.map((item, index) => ({ ...item, score: scores[index] }));
}

type ClipIdeaBase = Omit<
  ClipIdea,
  | "contentType"
  | "durationMode"
  | "durationWindow"
  | "durationReason"
  | "selectionReasons"
  | "scoreBreakdown"
  | "priority"
  | "factGate"
  | "calibrationStatus"
>;

const longTermTranscript: TranscriptLine[] = [
  { id: "long-1", time: "00:00", seconds: 0, text: "如果你是想赚快钱的话，带货不适合，带货是长线的问题。", defaultDecision: "keep", reason: "天总原生反常识判断，直接承担前三秒钩子。", evidenceLevel: "原声逐字" },
  { id: "long-2", time: "00:06", seconds: 6, text: "那我想做的是什么电商来着……", defaultDecision: "remove", speaker: "连麦人", reason: "连麦人插话，不属于天总主体表达，删除后上下句仍可自然衔接。", evidenceLevel: "原声逐字" },
  { id: "long-3", time: "00:10", seconds: 10, text: "上来做电商，起码要学两年。", defaultDecision: "keep", reason: "具体时间成本是天总商业判断的关键证据。", evidenceLevel: "原声逐字" },
  { id: "long-4", time: "00:15", seconds: 15, text: "很多人觉得电商很简单。", defaultDecision: "keep", reason: "点出观众的错误预期，承接“两年”判断。", evidenceLevel: "原声逐字" },
  { id: "long-5", time: "00:19", seconds: 19, text: "货品、团队、商务、人群、内容、平台规则，你都要学。", defaultDecision: "keep", reason: "六项学习成本把反常识判断解释完整，不能只留狠话。", evidenceLevel: "原声逐字" },
  { id: "long-6", time: "00:30", seconds: 30, text: "所以完整学下来，估计起码得两年。", defaultDecision: "keep", reason: "回扣具体时间成本并自然收口，形成独立逻辑闭环。", evidenceLevel: "原声逐字" },
];

function planningTranscript(prefix: string, hook: string, support: string): TranscriptLine[] {
  return [
    { id: `${prefix}-1`, time: "待定位", seconds: 0, text: hook, defaultDecision: "keep", reason: "策划阶段识别为强判断；接入原片后必须替换为真实逐字与词级时间码。", evidenceLevel: "策划摘要" },
    { id: `${prefix}-2`, time: "待定位", seconds: 0, text: support, defaultDecision: "keep", reason: "策划阶段承担必要解释；待原片核对是否存在更完整的证据句。", evidenceLevel: "策划摘要" },
    { id: `${prefix}-3`, time: "待定位", seconds: 0, text: "删除与主判断无关的提问、重复和第二案例。", defaultDecision: "remove", reason: "这是编导删除策略，不冒充天总原话。", evidenceLevel: "策划摘要" },
    { id: `${prefix}-4`, time: "待定位", seconds: 0, text: "在结论或可信证据落地后及时结束。", defaultDecision: "keep", reason: "这是候选结构目标；正式落刀前必须回到原声核验。", evidenceLevel: "策划摘要" },
  ];
}

const ideaEvidence: Record<
  string,
  Pick<
    ClipIdea,
    | "contentType"
    | "durationMode"
    | "durationWindow"
    | "durationReason"
    | "selectionReasons"
    | "scoreBreakdown"
    | "priority"
    | "factGate"
    | "calibrationStatus"
  >
> = {
  "chat-longterm": {
    contentType: "搞钱事业 · 商业判断",
    durationMode: "custom",
    durationWindow: "无硬窗口 · 语义闭环优先",
    durationReason: "38 秒不是由目标时长倒推，而是删除连麦插话与旁支后，仍需保留“长线—不适合快钱—至少两年—学习成本—结论”的完整因果链。",
    selectionReasons: ["“带货是长线”首句即成立，反常识且有行业识别度。", "“至少两年”与六项学习成本提供具体证据，不是空泛金句。", "删掉连麦人和过渡句后，天总原话仍能自然闭环。"],
    scoreBreakdown: scoreParts([20, 18, 20, 15, 15, 10]),
    priority: "S",
    factGate: "黄 · “两年”与六项成本须回看原片",
    calibrationStatus: "已按用户反馈校准",
  },
  "chat-ip": {
    contentType: "搞钱事业 · 职业路径",
    durationMode: "custom",
    durationWindow: "无硬窗口 · 待原片校准",
    durationReason: "68 秒来自“先有本职工作—副业验证—再发展个人 IP”的三步路径；若为追短而删前提，会改变天总给出的真实执行顺序。",
    selectionReasons: ["命中“工作还是自媒体”的高频真实决策。", "天总给出可执行路径，而不是只做情绪鼓励。", "结论回到能力与现金流，符合她的创业者人设。"],
    scoreBreakdown: scoreParts([19, 18, 19, 15, 15, 10]),
    priority: "S",
    factGate: "绿 · 无外部功效或价格承诺",
    calibrationStatus: "历史语料策划样例 · 待原片时间码校准",
  },
  "chat-rules": {
    contentType: "情感清醒 · 关系边界",
    durationMode: "custom",
    durationWindow: "无硬窗口 · 待原片校准",
    durationReason: "46 秒用于完整保留“行为判断—君子论迹—稳定行动”的机制解释，避免只剪一句极端狠话；情感类型尚无真实视频时长样本。",
    selectionReasons: ["“君子论迹不论心”是高辨识度强定义。", "议题具备评论与转发共鸣。", "狠话之后仍保留关系判断依据，符合“可以狠，但要有理”。"],
    scoreBreakdown: scoreParts([20, 18, 19, 15, 15, 8]),
    priority: "S",
    factGate: "绿 · 价值判断，无事实数字",
    calibrationStatus: "历史语料策划样例 · 待原片时间码校准",
  },
  "chat-energy": {
    contentType: "真实生活 · 状态管理",
    durationMode: "custom",
    durationWindow: "无硬窗口 · 待原片校准",
    durationReason: "52 秒用于保留“道理都懂—精力不足—先恢复身体与注意力—再谈执行”的完整递进；不是把 52 秒当作平台最优值。",
    selectionReasons: ["“缺的不是办法，是精力”具备清晰命名能力。", "命中焦虑、内耗与执行力的高频共鸣。", "结尾给到恢复顺序，不停留在安慰。"],
    scoreBreakdown: scoreParts([19, 17, 18, 15, 15, 9]),
    priority: "A",
    factGate: "黄 · 身体与精力表述不得剪成医疗建议",
    calibrationStatus: "历史语料策划样例 · 待原片时间码校准",
  },
  "chat-problems": {
    contentType: "搞钱事业 · 创业现实",
    durationMode: "custom",
    durationWindow: "无硬窗口 · 待原片校准",
    durationReason: "47 秒保留创业痛苦、持续解决问题与心态锻炼三层关系；删掉后续无关互动后在结论处及时结束。",
    selectionReasons: ["“每天都在解决问题”呈现真实创业反差。", "内容去掉了成功学包装，强化天总女老板可信度。", "痛苦—问题—能力形成完整闭环。"],
    scoreBreakdown: scoreParts([18, 17, 18, 14, 15, 9]),
    priority: "A",
    factGate: "绿 · 个人经验判断",
    calibrationStatus: "历史语料策划样例 · 待原片时间码校准",
  },
  "chat-money": {
    contentType: "搞钱事业 · 长期主义",
    durationMode: "custom",
    durationWindow: "无硬窗口 · 待原片校准",
    durationReason: "58 秒用于保留“赚钱不是目标—动作会变形—钱是奖励—具体例子”的解释链；只留首句会变成空洞鸡汤。",
    selectionReasons: ["“赚钱是奖励，不是目标”具备反常识传播力。", "奶茶与卖衣服案例让商业逻辑可理解。", "最终回到把事情做好，稳定强化核心人设。"],
    scoreBreakdown: scoreParts([18, 16, 17, 14, 15, 9]),
    priority: "A",
    factGate: "绿 · 无需外部事实核验",
    calibrationStatus: "历史语料策划样例 · 待原片时间码校准",
  },
  "sales-dress": {
    contentType: "成交型带货 · 穿搭",
    durationMode: "custom",
    durationWindow: "无硬窗口 · 带货样本待校准",
    durationReason: "42 秒来自三种穿法、收腰效果和度假场景的逐项画面证明；18–45 秒仅是历史编辑先验，五条真实视频校准尚未覆盖带货。",
    selectionReasons: ["一个核心购买理由：一条裙子解决三种穿法。", "卖点可由上身画面直接验证。", "场景、人群和版型信息同片闭环。"],
    scoreBreakdown: scoreParts([20, 18, 19, 15, 15, 10]),
    priority: "S",
    factGate: "黄 · 三穿结构与上身画面逐项核对",
    calibrationStatus: "带货策划样例 · 待 SKU 与原片校准",
  },
  "sales-mainpick": {
    contentType: "自然带货 · 信任建立",
    durationMode: "standard",
    durationWindow: "28–35 秒 · 带货样本待校准",
    durationReason: "35 秒恰好进入 standard 参考，但保留它的真正原因是“商家为何主推—库存或利润—回到真实需求”的劝退逻辑完整；不能把窗口重合误写成效果证明。",
    selectionReasons: ["“不要买主推”是强反常识钩子。", "天总以带货从业者身份解释库存和利润动机。", "不是机械喊单，而是给用户选择标准。"],
    scoreBreakdown: scoreParts([20, 18, 19, 15, 15, 8]),
    priority: "S",
    factGate: "黄 · 涉及商家动机，需保持个人判断语气",
    calibrationStatus: "历史语料策划样例 · 待原片时间码校准",
  },
  "sales-bag": {
    contentType: "成交型带货 · 功能展示",
    durationMode: "custom",
    durationWindow: "无硬窗口 · 带货样本待校准",
    durationReason: "八个口袋需要按真实展示顺序交代用途，54 秒无法在不损失功能证明的前提下压缩；因此由自然语义与画面验证决定，不称作超窗。",
    selectionReasons: ["功能数量明确，天然形成观看顺序。", "每个口袋均能由实物画面验证。", "删除母子包以外岔题后仍是单一购买理由。"],
    scoreBreakdown: scoreParts([19, 16, 18, 14, 15, 10]),
    priority: "A",
    factGate: "黄 · 口袋数量与用途必须逐帧核对",
    calibrationStatus: "带货策划样例 · 待 SKU 与原片校准",
  },
  "sales-shape": {
    contentType: "成交型带货 · 版型证明",
    durationMode: "custom",
    durationWindow: "无硬窗口 · 带货样本待校准",
    durationReason: "49 秒用于同时保留适合人群、劝退人群、腰线与肩颈画面证明；天总带货规则要求限制条件同片保留，因此不为追短删除边界。",
    selectionReasons: ["“显瘦看比例，不看尺码”具有观点型卖点。", "上身画面可验证腰线与肩颈结构。", "保留不适合人群的劝退，增强可信度。"],
    scoreBreakdown: scoreParts([18, 15, 18, 14, 15, 10]),
    priority: "A",
    factGate: "黄 · 不得剪成普遍身材承诺",
    calibrationStatus: "带货策划样例 · 待 SKU 与原片校准",
  },
  "sales-fans": {
    contentType: "搞钱事业 · 直播运营",
    durationMode: "custom",
    durationWindow: "无硬窗口 · 待原片校准",
    durationReason: "51 秒用于保留新客、老客、高黏性用户与沟通策略的分层关系；这是直播运营观点，不套单品成交先验。",
    selectionReasons: ["粉丝分层是直播运营的高价值知识。", "人群—话术—成交路径形成完整商业闭环。", "不与单品卖货候选混用评分窗口。"],
    scoreBreakdown: scoreParts([18, 14, 17, 14, 15, 10]),
    priority: "A",
    factGate: "绿 · 方法论，不含 SKU 承诺",
    calibrationStatus: "历史语料策划样例 · 待原片时间码校准",
  },
  "sales-reason": {
    contentType: "成交型带货 · 话术方法",
    durationMode: "custom",
    durationWindow: "无硬窗口 · 带货样本待校准",
    durationReason: "44 秒完整保留“不要堆卖点—锁定一个问题—让画面证明”的方法链，结论落地后立即结束；历史 18–45 秒只作编辑先验。",
    selectionReasons: ["直接回答切片团队如何处理卖点。", "一个购买理由对应一个视频，规则清晰可执行。", "口播与画面验证关系明确，可直接进入编导流程。"],
    scoreBreakdown: scoreParts([18, 14, 16, 13, 15, 10]),
    priority: "A",
    factGate: "绿 · 内部方法论",
    calibrationStatus: "带货策划样例 · 待原片时间码校准",
  },
};

const baseIdeas: ClipIdeaBase[] = [
  {
    id: "chat-longterm",
    kind: "聊播",
    index: "01",
    title: "带货是长线，不是赚快钱",
    duration: "00:38",
    sourceTime: "00:59:46 — 01:00:24",
    sourceStart: 3586,
    score: 98,
    summary: "保留天总的完整判断，删除连麦人的问题，直接接“起码两年”。",
    thumbnail: "/thumbnails/chat-longterm.png",
    video: "/previews/chat-rules.mp4",
    transcript: longTermTranscript,
  },
  {
    id: "chat-ip",
    kind: "聊播",
    index: "02",
    title: "本职工作和个人 IP，不是二选一",
    duration: "01:08",
    sourceTime: "00:30:21 — 00:31:29",
    sourceStart: 1821,
    score: 96,
    summary: "从二选一误区切入，给出边工作边验证个人 IP 的执行路径。",
    thumbnail: "/thumbnails/chat-selfmedia.png",
    video: "/previews/chat-problems.mp4",
    transcript: planningTranscript("ip", "策划摘要：本职工作与个人 IP 可以并行，不是非二选一。", "策划摘要：先用本职工作稳定现金流，再把真实经验拆成内容验证个人 IP。"),
  },
  {
    id: "chat-rules",
    kind: "聊播",
    index: "03",
    title: "成年人最直白的相处规则",
    duration: "00:46",
    sourceTime: "01:22:10 — 01:22:56",
    sourceStart: 4930,
    score: 95,
    summary: "观点结论先行，删除来回确认，只保留天总的完整逻辑链。",
    thumbnail: "/thumbnails/sales-value.png",
    video: "/previews/chat-rules.mp4",
    transcript: planningTranscript("rules", "策划摘要：成年人相处先看行动，不替别人解释。", "策划摘要：用“君子论迹不论心”落到长期、稳定的行为判断。"),
  },
  {
    id: "chat-energy",
    kind: "聊播",
    index: "04",
    title: "你缺的不是办法，是精力",
    duration: "00:52",
    sourceTime: "02:05:33 — 02:06:25",
    sourceStart: 7533,
    score: 93,
    summary: "从“道理都懂”切入，把解决办法落到恢复精力与降低内耗。",
    thumbnail: "/thumbnails/chat-selfmedia.png",
    video: "/previews/chat-energy.mp4",
    transcript: planningTranscript("energy", "策划摘要：不是不知道怎么办，而是已经没有精力去做。", "策划摘要：先恢复睡眠、身体和注意力，再谈执行力。"),
  },
  {
    id: "chat-problems",
    kind: "聊播",
    index: "05",
    title: "每天都在解决各种各样的问题",
    duration: "00:47",
    sourceTime: "02:46:18 — 02:47:05",
    sourceStart: 9978,
    score: 91,
    summary: "把创业的真实感讲清楚，不包装成励志口号。",
    thumbnail: "/thumbnails/chat-longterm.png",
    video: "/previews/chat-problems.mp4",
    transcript: planningTranscript("problems", "策划摘要：创业不是每天都在赢，而是每天都在解决问题。", "策划摘要：持续解决问题会锻炼心态，也会沉淀成团队能力。"),
  },
  {
    id: "chat-money",
    kind: "聊播",
    index: "06",
    title: "做事不要把赚钱当唯一目标",
    duration: "00:58",
    sourceTime: "01:15:09 — 01:16:07",
    sourceStart: 4509,
    score: 89,
    summary: "保留反常识结论，再解释能力、作品和长期回报的关系。",
    thumbnail: "/thumbnails/chat-selfmedia.png",
    video: "/previews/chat-energy.mp4",
    transcript: planningTranscript("money", "策划摘要：赚钱可以是结果，但不能成为做每件事的唯一目标。", "策划摘要：先把事情做好，能力和作品形成复利后，钱才会成为稳定奖励。"),
  },
  {
    id: "sales-dress",
    kind: "带货",
    index: "01",
    title: "一条度假裙，为什么要做三种穿法",
    duration: "00:42",
    sourceTime: "05:16:00 — 05:16:42",
    sourceStart: 18960,
    score: 97,
    summary: "一个视频只讲三穿、收腰和度假场景，画面必须跟上口播。",
    thumbnail: "/thumbnails/sales-detail.png",
    video: "/previews/sales-mainpick.mp4",
    transcript: planningTranscript("dress", "策划摘要：一条度假裙用“三种穿法”作为唯一购买理由。", "策划摘要：长袖、一字肩、吊带与腰线效果都必须由上身画面逐项证明。"),
  },
  {
    id: "sales-mainpick",
    kind: "带货",
    index: "02",
    title: "不要只买主推，先看你真正需要什么",
    duration: "00:35",
    sourceTime: "00:52:31 — 00:53:06",
    sourceStart: 3151,
    score: 95,
    summary: "用反常识钩子建立信任，再把选择标准说清楚。",
    thumbnail: "/thumbnails/sales-value.png",
    video: "/previews/sales-mainpick.mp4",
    transcript: planningTranscript("mainpick", "策划摘要：不要因为商品是主推，就默认它最适合自己。", "策划摘要：先解释库存或利润动机，再回到使用场景、预算和真实需求。"),
  },
  {
    id: "sales-bag",
    kind: "带货",
    index: "03",
    title: "一个猫包，八个口袋到底怎么装",
    duration: "00:54",
    sourceTime: "02:33:45 — 02:34:39",
    sourceStart: 9225,
    score: 92,
    summary: "按口袋顺序展示，删除与母子包结构无关的岔题。",
    thumbnail: "/thumbnails/sales-value.png",
    video: "/previews/sales-mainpick.mp4",
    transcript: planningTranscript("bag", "策划摘要：猫包的购买理由是把出门所需物品有序装下。", "策划摘要：八个口袋的数量、位置和用途都要跟随实物展示逐项核验。"),
  },
  {
    id: "sales-shape",
    kind: "带货",
    index: "04",
    title: "真正显瘦的是比例，不是尺码",
    duration: "00:49",
    sourceTime: "03:18:50 — 03:19:39",
    sourceStart: 11930,
    score: 90,
    summary: "用上身效果证明腰线与肩颈比例，不做无法验证的身材承诺。",
    thumbnail: "/thumbnails/sales-detail.png",
    video: "/previews/sales-mainpick.mp4",
    transcript: planningTranscript("shape", "策划摘要：显瘦的重点是比例，不是把人塞进更小尺码。", "策划摘要：腰线与肩颈留白必须有上身画面证明，并保留不适合人群。"),
  },
  {
    id: "sales-fans",
    kind: "带货",
    index: "05",
    title: "直播间粉丝从来不是一种人",
    duration: "00:51",
    sourceTime: "01:08:12 — 01:09:03",
    sourceStart: 4092,
    score: 88,
    summary: "把人群分层讲清楚，只保留与成交路径直接相关的部分。",
    thumbnail: "/thumbnails/chat-longterm.png",
    video: "/previews/chat-rules.mp4",
    transcript: planningTranscript("fans", "策划摘要：直播间粉丝不是同一种人，不能用同一句话沟通。", "策划摘要：先区分新客、老客和高黏性用户，再决定每一段的内容与行动。"),
  },
  {
    id: "sales-reason",
    kind: "带货",
    index: "06",
    title: "一条视频，只保留一个购买理由",
    duration: "00:44",
    sourceTime: "04:41:03 — 04:41:47",
    sourceStart: 16863,
    score: 86,
    summary: "删除卖点堆砌，让一个核心理由贯穿口播和展示。",
    thumbnail: "/thumbnails/sales-detail.png",
    video: "/previews/sales-mainpick.mp4",
    transcript: planningTranscript("reason", "策划摘要：一条切片不堆十个卖点，只建立一个购买理由。", "策划摘要：锁定最能解决问题的一点，再让口播与画面共同证明。"),
  },
];

const ideas: ClipIdea[] = baseIdeas.map((idea) => ({
  ...idea,
  ...ideaEvidence[idea.id],
}));

const initialDecisions = Object.fromEntries(
  ideas.flatMap((idea) => idea.transcript.map((line) => [line.id, line.defaultDecision])),
) as Record<string, Decision>;

const stepLabels: { step: WorkflowStep; label: string }[] = [
  { step: 1, label: "上传与类型" },
  { step: 2, label: "内容地图" },
  { step: 3, label: "文字精剪" },
];

export default function Home() {
  const [step, setStep] = useState<WorkflowStep>(1);
  const [mode, setMode] = useState<Mode | null>(null);
  const [fileName, setFileName] = useState("");
  const [uploadedPreviewUrl, setUploadedPreviewUrl] = useState("");
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisReady, setAnalysisReady] = useState(false);
  const [activeClipId, setActiveClipId] = useState(ideas[0].id);
  const [selectedIds, setSelectedIds] = useState<string[]>([ideas[0].id]);
  const [decisions, setDecisions] = useState<Record<string, Decision>>(initialDecisions);
  const [currentTime, setCurrentTime] = useState(0);
  const [generationState, setGenerationState] = useState<"idle" | "working" | "done">("idle");
  const [feedbackQueued, setFeedbackQueued] = useState(false);
  const [highPotentialOnly, setHighPotentialOnly] = useState(false);
  const [toast, setToast] = useState("");
  const [showArchitecture, setShowArchitecture] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    return () => {
      if (uploadedPreviewUrl) URL.revokeObjectURL(uploadedPreviewUrl);
    };
  }, [uploadedPreviewUrl]);

  const modeIdeas = useMemo(
    () => ideas.filter((idea) => idea.kind === (mode ?? "聊播")),
    [mode],
  );
  const displayedIdeas = useMemo(
    () => highPotentialOnly ? modeIdeas.filter((idea) => idea.priority === "S") : modeIdeas,
    [highPotentialOnly, modeIdeas],
  );
  const discoveredCount = analysisReady ? modeIdeas.length : 0;

  const activeClip = ideas.find((idea) => idea.id === activeClipId) ?? modeIdeas[0];
  const activeLineIndex = activeClip.transcript.findIndex((line, index) => {
    if (line.evidenceLevel !== "原声逐字") return false;
    const next = activeClip.transcript[index + 1]?.seconds ?? Number.POSITIVE_INFINITY;
    return currentTime >= line.seconds && currentTime < next;
  });
  const keptCount = activeClip.transcript.filter((line) => decisions[line.id] === "keep").length;
  const reviewChangeCount = activeClip.transcript.filter(
    (line) => (decisions[line.id] ?? line.defaultDecision) !== line.defaultDecision,
  ).length;
  const totalReviewChangeCount = ideas.reduce(
    (total, idea) => total + idea.transcript.filter(
      (line) => (decisions[line.id] ?? line.defaultDecision) !== line.defaultDecision,
    ).length,
    0,
  );
  const excludedRanges = activeClip.transcript.flatMap((line, index) => {
    if (line.evidenceLevel !== "原声逐字") return [];
    if (decisions[line.id] !== "remove") return [];
    const next = activeClip.transcript[index + 1]?.seconds ?? line.seconds + 5;
    return [{ start: line.seconds, end: next }];
  });

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3600);
  }

  function switchMode(nextMode: Mode) {
    if (mode === nextMode) return;
    const shouldExplainReset = step > 1;
    setMode(nextMode);
    const first = ideas.find((idea) => idea.kind === nextMode) ?? ideas[0];
    setActiveClipId(first.id);
    setSelectedIds([first.id]);
    setAnalysisReady(false);
    setAnalysisProgress(0);
    setStep(1);
    setGenerationState("idle");
    setFeedbackQueued(false);
    setHighPotentialOnly(false);
    setCurrentTime(0);
    if (shouldExplainReset) {
      window.setTimeout(() => showToast(`已切换为${nextMode}切片，请重新生成这一场的内容地图。`), 0);
    }
  }

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (uploadedPreviewUrl) URL.revokeObjectURL(uploadedPreviewUrl);
    setFileName(file.name);
    setUploadedPreviewUrl(URL.createObjectURL(file));
  }

  function startAnalysis() {
    if (!mode) {
      showToast("请先选择聊播切片或带货切片。");
      return;
    }
    setAnalysisProgress(8);
    let value = 8;
    const timer = window.setInterval(() => {
      value += value < 50 ? 14 : value < 82 ? 9 : 6;
      if (value >= 100) {
        window.clearInterval(timer);
        setAnalysisProgress(100);
        setAnalysisReady(true);
        const modelResultCandidates = ideas.filter((idea) => idea.kind === mode);
        const modelResultCount = modelResultCandidates.length;
        const first = modelResultCandidates[0] ?? ideas[0];
        setActiveClipId(first.id);
        setSelectedIds([first.id]);
        window.setTimeout(() => setStep(2), 320);
        showToast(`天总内容地图初筛完成：本场识别 ${modelResultCount} 条候选，待逐字和原片复核。`);
        return;
      }
      setAnalysisProgress(value);
    }, 260);
  }

  function openStep(nextStep: WorkflowStep) {
    if (nextStep === 1 || analysisReady) setStep(nextStep);
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  function activateClip(id: string) {
    setActiveClipId(id);
    setCurrentTime(0);
    setGenerationState("idle");
    setFeedbackQueued(false);
  }

  function enterTranscript() {
    if (!selectedIds.length) {
      showToast("请先选择至少一个切片候选。");
      return;
    }
    if (!selectedIds.includes(activeClip.id)) activateClip(selectedIds[0]);
    setStep(3);
  }

  function seekTo(seconds: number) {
    const video = videoRef.current;
    if (!video) return;
    const absoluteSeconds = (uploadedPreviewUrl ? activeClip.sourceStart : 0) + seconds;
    video.currentTime = Math.min(absoluteSeconds, Number.isFinite(video.duration) ? Math.max(video.duration - 0.1, 0) : absoluteSeconds);
    void video.play();
  }

  function setLineDecision(id: string, decision: Decision) {
    setDecisions((current) => ({ ...current, [id]: decision }));
    setGenerationState("idle");
    setFeedbackQueued(false);
  }

  function generateClip() {
    setGenerationState("working");
    window.setTimeout(() => {
      setGenerationState("done");
      setFeedbackQueued(true);
      showToast(`句级预听已更新；${reviewChangeCount} 项人工纠偏已记为本次回标演示，当前不会写入后台或生成正式 MP4。`);
    }, 1300);
  }

  function handoffToChatCut() {
    showToast("演示：已准备可编辑时间线。正式版连接 ChatCut 后会写入用户工程。");
  }

  function toggleIdeaFilter() {
    const next = !highPotentialOnly;
    setHighPotentialOnly(next);
    if (next && activeClip.priority !== "S") {
      const firstHighPotential = modeIdeas.find((idea) => idea.priority === "S");
      if (firstHighPotential) activateClip(firstHighPotential.id);
    }
  }

  function explainAllIdeas() {
    showToast(`本场共 ${discoveredCount} 条候选。数量由完整语义闭环、同题去重和风险门禁决定，不设目标条数。`);
  }

  const previewSource = uploadedPreviewUrl || activeClip.video;

  return (
    <main className="cutline-app">
      <header className="masthead">
        <div className="masthead-brand">
          <button className="wordmark" onClick={() => setStep(1)} aria-label="返回上传步骤">天总直播切片系统</button>
          <span>内测 BETA 1.0</span>
        </div>

        <nav className="step-rail" aria-label="切片工作流">
          {stepLabels.map((item) => (
            <button
              key={item.step}
              className={step === item.step ? "active" : step > item.step ? "complete" : ""}
              disabled={item.step > 1 && !analysisReady}
              onClick={() => openStep(item.step)}
              aria-current={step === item.step ? "step" : undefined}
            >
              <b>{item.step}</b>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="masthead-actions">
          {step > 1 && (
            <div className="mode-switch" aria-label="切片类型">
              {(["带货", "聊播"] as Mode[]).map((item) => (
                <button
                  key={item}
                  className={mode === item ? "active" : ""}
                  onClick={() => switchMode(item)}
                  aria-pressed={mode === item}
                >
                  {item}切片
                </button>
              ))}
            </div>
          )}
          <button className="text-action" onClick={() => setShowArchitecture(true)}>天总切片规则</button>
        </div>
      </header>

      {step === 1 && (
        <section className="intake-view" aria-labelledby="intake-title">
          <div className="intake-intro">
            <span className="edition-label">天总人物与直播内容系统</span>
            <h1 id="intake-title">只剪天总，也以她当前的直播逻辑为准。</h1>
            <p>一个有实战能力、嘴很快、主意很正的女老板；她帮姐妹把赚钱、关系和生活讲明白，又总在最有权威感的时候被现实拆台。</p>
          </div>

          <section className="profile-editorial" aria-labelledby="profile-title">
            <header className="profile-thesis">
              <span>天总人物判断 · {corpusBaseline.version}</span>
              <div>
                <h2 id="profile-title">真正稀缺的，不是某一句商业金句，也不是单纯的颜值、身材或“霸总”人设。</h2>
                <blockquote>一个有实战能力、嘴很快、主意很正的女老板；她帮姐妹把赚钱、关系和生活讲明白，又总在最有权威感的时候被现实拆台。</blockquote>
              </div>
            </header>

            <div className="identity-switch">
              <span>她能在同一个人身上连续切换</span>
              <div>
                {personaSpectrum.map((item) => (
                  <article className="identity-pill" key={item.label}>
                    <b>{item.label}</b>
                    <p>{item.description}</p>
                  </article>
                ))}
              </div>
            </div>

            <div className="profile-columns">
              <article className="profile-chapter">
                <span>01 / 核心人格</span>
                <h3>她为什么让人相信</h3>
                <ul className="profile-list">
                  {corePersonality.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </article>
              <article className="profile-chapter">
                <span>02 / 稳定价值观</span>
                <h3>她反复在讲什么</h3>
                <ul className="profile-list">
                  {stableValues.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </article>
              <article className="profile-chapter">
                <span>03 / 核心观众</span>
                <h3>谁会长期留下来</h3>
                <ul className="profile-list">
                  {coreAudience.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </article>
            </div>

            <p className="profile-close">她不是永远强大，也不是只负责漂亮。真正让人留下来的，是“有本事、有判断、像姐妹、会发疯、也会受伤”同时成立。</p>
          </section>

          <div className="intake-grid">
            <section className="upload-editorial" aria-label="上传直播录屏">
              <div className="section-number">01 / 天总原片</div>
              <h2>上传天总完整直播</h2>
              <p>MP4 / MOV · 保留整场上下文，避免只凭单句话误判天总真正想表达的意思。</p>
              <button className="upload-field" onClick={() => fileRef.current?.click()}>
                <span>{fileName || "选择直播录屏"}</span>
                <small>{fileName ? "已在浏览器中读取，尚未上传" : "也可以直接使用校准样片体验"}</small>
              </button>
              <input ref={fileRef} type="file" accept="video/mp4,video/quicktime" hidden onChange={handleFile} />
              {uploadedPreviewUrl && (
                <video className="upload-preview" src={uploadedPreviewUrl} controls playsInline preload="metadata" />
              )}
            </section>

            <section className="mode-editorial" aria-labelledby="mode-title">
              <div className="section-number">02 / 直播类型</div>
              <h2 id="mode-title">选择天总本场直播类型</h2>
              <div className="mode-covers">
                <button
                  className={mode === "聊播" ? "selected" : ""}
                  onClick={() => switchMode("聊播")}
                  aria-pressed={mode === "聊播"}
                >
                  <b>聊播</b>
                  <span>保留天总完整观点</span>
                  <p>先保留会改变答案的问题前提，再保留天总的判断、理由、案例和落点；只删无效寒暄、重复、串场和等待。</p>
                </button>
                <button
                  className={mode === "带货" ? "selected" : ""}
                  onClick={() => switchMode("带货")}
                  aria-pressed={mode === "带货"}
                >
                  <b>带货</b>
                  <span>执行天总带货方法</span>
                  <p>先锁定一个购买理由：精准人群 → 卖点与场景 → 痛点强化 → 价值收口；劝退、限制和实物证明同片保留。</p>
                </button>
              </div>
            </section>
          </div>

          <div className="intake-footer">
            <div>
              <strong>天总切片判断链</strong>
              <span>完整直播 → 三向分流 → 自然闭环 → 事实门禁 → 逐字复核</span>
            </div>
            <button className="pink-action" onClick={startAnalysis} disabled={!mode || (analysisProgress > 0 && analysisProgress < 100)}>
              {analysisProgress > 0 && analysisProgress < 100 ? `正在生成内容地图 ${Math.min(analysisProgress, 99)}%` : "开始生成内容地图"}
            </button>
          </div>

          {analysisProgress > 0 && analysisProgress < 100 && (
            <div className="analysis-strip" aria-live="polite">
              <span style={{ width: `${analysisProgress}%` }} />
            </div>
          )}

          <p className="prototype-note">当前为内部内测：仅演示校准样片、候选依据和句级预听；真实上传、全场转写、候选生成、视频渲染与 ChatCut 写入尚未接通。</p>
        </section>
      )}

      {step === 2 && (
        <section className="map-view" aria-labelledby="map-title">
          <aside className="idea-index">
            <div className="panel-heading">
              <div><span>本场自然发现</span><b>{discoveredCount} 条候选</b></div>
              <button onClick={toggleIdeaFilter} aria-pressed={highPotentialOnly}>{highPotentialOnly ? "查看全部" : "只看 S 级"}</button>
            </div>
            <p className="panel-intro">按完整语义、同题去重与风险门禁召回；自然返回多少就是多少，不设目标、不设保底，也不补齐。</p>
            <div className="version-context"><span>{corpusBaseline.version}</span><p>{mode}规则 · 近期直播最高权重</p></div>
            <div className="idea-list">
              {displayedIdeas.map((idea) => (
                <article className={`idea-row ${activeClip.id === idea.id ? "active" : ""}`} key={idea.id}>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(idea.id)}
                    onChange={() => toggleSelected(idea.id)}
                    aria-label={`选择 ${idea.title}`}
                  />
                  <button onClick={() => activateClip(idea.id)}>
                    <span>{idea.priority} · {idea.index}</span>
                    <strong>{idea.title}</strong>
                    <small>{idea.duration}</small>
                  </button>
                </article>
              ))}
            </div>
            <button className="outline-action full" onClick={explainAllIdeas}>查看全部候选（{discoveredCount}）</button>
          </aside>

          <section className="map-preview" aria-label="候选原片预览">
            <div className="story-header">
              <span>天总候选 · {activeClip.index}</span>
              <b>编辑适配分 {activeClip.score} / 100</b>
            </div>
            <h1 id="map-title">{activeClip.title}</h1>
            <p>{activeClip.summary}</p>
            <div className="evidence-status">
              <span>优先级 {activeClip.priority}</span>
              <span>{activeClip.factGate}</span>
              <span>{activeClip.calibrationStatus}</span>
            </div>
            <VideoPreview
              videoRef={videoRef}
              source={previewSource}
              poster={activeClip.thumbnail}
              uploaded={Boolean(uploadedPreviewUrl)}
              sourceStart={activeClip.sourceStart}
              excludedRanges={excludedRanges}
              roughPreview={false}
              onTimeUpdate={setCurrentTime}
            />
            <div className="source-facts">
              <span>原片位置</span><strong>{activeClip.sourceTime}</strong>
              <span>预计成片</span><strong>{activeClip.duration}</strong>
            </div>
            <section className="evidence-panel" aria-label="候选成立依据">
              <div className="decision-proof">
                <span>为什么召回</span>
                <strong>{activeClip.contentType}</strong>
                <ol>{activeClip.selectionReasons.map((reason) => <li key={reason}>{reason}</li>)}</ol>
              </div>
              <div className="score-evidence">
                <span>为什么是 {activeClip.score} 分</span>
                <p>这是编辑适配分，不是爆款概率；每一项都要能回到原句或画面。</p>
                <div className="score-grid">
                  {activeClip.scoreBreakdown.map((part) => (
                    <div key={part.label}><span>{part.label}</span><b>{part.score}</b><small>/ {part.max}</small></div>
                  ))}
                </div>
              </div>
              <div className="duration-proof">
                <span>为什么是 {activeClip.duration}</span>
                <strong>{activeClip.durationMode} · {activeClip.durationWindow}</strong>
                <p>{activeClip.durationReason}</p>
              </div>
            </section>
          </section>

          <aside className="map-notes">
            <div className="panel-heading"><div><span>句级依据</span><b>语义初筛 · 待原片复核</b></div></div>
            <div className="legend"><span>保留片段</span><span>建议删除 · 每句有理由</span></div>
            <div className="snapshot-lines">
              {activeClip.transcript.map((line) => (
                <button
                  key={line.id}
                  className={decisions[line.id] === "remove" ? "removed" : ""}
                  disabled={line.evidenceLevel !== "原声逐字"}
                  onClick={() => line.evidenceLevel === "原声逐字" && seekTo(line.seconds)}
                >
                  <time>{line.time}</time>
                  <span className="evidence-badge">{line.evidenceLevel}</span>
                  <span>{line.text}</span>
                  <small className="line-rationale">{line.reason}</small>
                </button>
              ))}
            </div>
            <div className="selection-summary">
              <span>已选 {selectedIds.length} 条 · 本场识别 {discoveredCount} 条 · 不为凑数补候选</span>
              <button className="pink-action" onClick={enterTranscript}>选中后进入文字精剪</button>
            </div>
          </aside>
        </section>
      )}

      {step === 3 && (
        <section className="cut-room" aria-labelledby="cut-title">
          <aside className="idea-index compact">
            <div className="panel-heading">
              <div><span>本场自然发现</span><b>{discoveredCount} 条候选</b></div>
              <button onClick={toggleIdeaFilter} aria-pressed={highPotentialOnly}>{highPotentialOnly ? "查看全部" : "只看 S 级"}</button>
            </div>
            <p className="panel-intro">数量由天总专属判断自然得出，不设上限，也不补齐。</p>
            <div className="version-context"><span>{corpusBaseline.version}</span><p>当前候选沿用已发布判断 · 人工差异进入回标</p></div>
            <div className="idea-list">
              {displayedIdeas.map((idea) => (
                <button
                  className={`compact-idea ${activeClip.id === idea.id ? "active" : ""}`}
                  key={idea.id}
                  onClick={() => activateClip(idea.id)}
                >
                  <span>{idea.priority} · {idea.index}</span><strong>{idea.title}</strong><small>{idea.duration}</small>
                </button>
              ))}
            </div>
            <button className="outline-action full" onClick={explainAllIdeas}>查看全部候选（{discoveredCount}）</button>
          </aside>

          <section className="cut-preview" aria-label="文字精剪视频预览">
            <div className="story-header"><span>正在精剪 · {activeClip.index}</span><b>编辑适配分 {activeClip.score}</b></div>
            <h1 id="cut-title">{activeClip.title}</h1>
            <div className="evidence-status">
              <span>优先级 {activeClip.priority}</span>
              <span>{activeClip.factGate}</span>
            </div>
            <VideoPreview
              videoRef={videoRef}
              source={previewSource}
              poster={activeClip.thumbnail}
              uploaded={Boolean(uploadedPreviewUrl)}
              sourceStart={activeClip.sourceStart}
              excludedRanges={excludedRanges}
              roughPreview={generationState === "done"}
              onTimeUpdate={setCurrentTime}
            />
            <div className="generation-proof" aria-live="polite">
              <span>{generationState === "done" ? "句级预听已更新 · 不代表最终落刀" : "当前播放器为原片上下文预览"}</span>
              <b>{keptCount} 段保留 · {activeClip.transcript.length - keptCount} 段删除</b>
            </div>
            <p className="raw-output-note">目标输出：无字幕 · 无效果 · 保留原声</p>
            <section className="output-rationale" aria-label="最终输出判断依据">
              <div>
                <span>为什么这样成片</span>
                <h2>{activeClip.duration} · {activeClip.durationMode}</h2>
                <p>{activeClip.durationReason}</p>
              </div>
              <div className="output-rationale-grid">
                <p><span>内容类型</span><b>{activeClip.contentType}</b></p>
                <p><span>事实门禁</span><b>{activeClip.factGate}</b></p>
                <p><span>校准状态</span><b>{activeClip.calibrationStatus}</b></p>
                <p><span>人工回标</span><b>{reviewChangeCount} 项本条差异 · {totalReviewChangeCount} 项本场累计</b></p>
              </div>
              <small>{feedbackQueued ? "本次差异已记录为本地回标演示；正式版需后台评审与回测后才影响下一知识版本。" : "当编导改写系统建议时，差异将成为回标候选；不会立即覆盖当前全局规则。"}</small>
            </section>
          </section>

          <section className="transcript-editor" aria-labelledby="transcript-title">
            <div className="transcript-head">
              <div>
                <h2 id="transcript-title">文字精剪</h2>
                <p>原声逐字可定位播放；策划摘要只展示结构判断，接入原片前不能当作天总原话。</p>
              </div>
              <span>{corpusBaseline.version} · 句级依据</span>
            </div>
            <div className="legend"><span>保留内容</span><span>建议删除 · 修改会形成回标差异</span></div>
            <div className="transcript-lines">
              {activeClip.transcript.map((line, index) => {
                const decision = decisions[line.id] ?? line.defaultDecision;
                return (
                  <article
                    key={line.id}
                    className={`${decision === "remove" ? "removed" : ""} ${activeLineIndex === index ? "playing" : ""}`}
                  >
                    <button
                      className="transcript-seek"
                      disabled={line.evidenceLevel !== "原声逐字"}
                      onClick={() => line.evidenceLevel === "原声逐字" && seekTo(line.seconds)}
                      aria-label={line.evidenceLevel === "原声逐字" ? `从 ${line.time} 播放：${line.text}` : `${line.evidenceLevel}，待原片定位：${line.text}`}
                    >
                      <time>{line.time}</time>
                      <p>
                        <span className="evidence-badge">{line.evidenceLevel}</span>
                        {line.speaker && <small className="speaker-label">{line.speaker}</small>}
                        {line.text}
                        <small className="line-rationale">{line.reason}</small>
                      </p>
                    </button>
                    <div>
                      <button className={decision === "keep" ? "active" : ""} onClick={() => setLineDecision(line.id, "keep")}>保留</button>
                      <button className={decision === "remove" ? "active remove" : ""} onClick={() => setLineDecision(line.id, "remove")}>删除</button>
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="cut-actions">
              <button className="outline-action" onClick={() => setStep(2)}>返回内容地图</button>
              {generationState === "done" ? (
                <div className="output-actions">
                  <a className="outline-action" href={activeClip.video} download>下载演示样片</a>
                  <button className="pink-action" onClick={handoffToChatCut}>送入 ChatCut 精修（演示）</button>
                </div>
              ) : (
                <button className="pink-action" onClick={generateClip} disabled={generationState === "working"}>
                  {generationState === "working" ? "正在更新句级预听…" : "更新句级预听"}
                </button>
              )}
            </div>
          </section>
        </section>
      )}

      {showArchitecture && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowArchitecture(false)}>
          <section className="architecture-modal" role="dialog" aria-modal="true" aria-labelledby="architecture-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowArchitecture(false)} aria-label="关闭">关闭</button>
            <span className="edition-label">天总专属系统 · 内测 BETA 1.0</span>
            <h2 id="architecture-title">这里沉淀的不是通用剪辑方法，而是我们对天总直播的全部判断。</h2>
            <div className="architecture-list">
              <div><b>01</b><strong>完整直播</strong><p>保留问题前提、说话人、原片时间和连续上下文，让每个判断能回到原话核对。</p></div>
              <div><b>02</b><strong>候选策划</strong><p>按聊播、成交型带货、非成交产品/生活三向分流，再按自然语义闭环建立候选。</p></div>
              <div><b>03</b><strong>逐字与事实复核</strong><p>核对完整句、数字、SKU、限制与画面证明；编辑适配分不能越过事实门禁。</p></div>
              <div><b>04</b><strong>干净 A-roll 交付</strong><p>通过声音、画面与正常观看验收后，交付无字幕、无效果、保留原声的干净切片。</p></div>
              <div><b>05</b><strong>人工回标反哺</strong><p>编导每次改动形成回标候选；只有经过后台研究、归因与回测，才进入下一知识版本。</p></div>
            </div>
          </section>
        </div>
      )}

      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    </main>
  );
}

function VideoPreview({
  videoRef,
  source,
  poster,
  uploaded,
  sourceStart,
  excludedRanges,
  roughPreview,
  onTimeUpdate,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  source: string;
  poster: string;
  uploaded: boolean;
  sourceStart: number;
  excludedRanges: { start: number; end: number }[];
  roughPreview: boolean;
  onTimeUpdate: (time: number) => void;
}) {
  return (
    <video
      key={`${source}-${sourceStart}`}
      ref={videoRef}
      className="main-video"
      src={source}
      poster={poster}
      controls
      playsInline
      preload="metadata"
      onLoadedMetadata={(event) => {
        if (!uploaded) return;
        const video = event.currentTarget;
        if (Number.isFinite(video.duration) && video.duration > 0) {
          video.currentTime = Math.min(sourceStart, Math.max(video.duration - 0.1, 0));
        }
      }}
      onTimeUpdate={(event) => {
        const video = event.currentTarget;
        const baseOffset = uploaded ? sourceStart : 0;
        const relativeTime = Math.max(0, video.currentTime - baseOffset);
        const excluded = roughPreview
          ? excludedRanges.find((range) => relativeTime >= range.start && relativeTime < range.end)
          : undefined;

        if (excluded) {
          const nextAbsoluteTime = baseOffset + excluded.end + 0.01;
          if (Number.isFinite(video.duration) && nextAbsoluteTime >= video.duration - 0.05) {
            video.pause();
          } else {
            video.currentTime = nextAbsoluteTime;
          }
          return;
        }

        onTimeUpdate(relativeTime);
      }}
    >
      你的浏览器暂不支持在线播放该视频。
    </video>
  );
}
