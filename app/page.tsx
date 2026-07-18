"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

type Mode = "聊播" | "带货";
type WorkflowStep = 1 | 2 | 3;
type Decision = "keep" | "remove";

type TranscriptLine = {
  id: string;
  time: string;
  seconds: number;
  text: string;
  defaultDecision: Decision;
  speaker?: string;
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
  thumbnail: string;
  video: string;
  transcript: TranscriptLine[];
};

const longTermTranscript: TranscriptLine[] = [
  { id: "long-1", time: "00:00", seconds: 0, text: "带货是长线的问题。", defaultDecision: "keep" },
  { id: "long-2", time: "00:03", seconds: 3, text: "如果你是想赚快钱，我觉得带货不适合。", defaultDecision: "keep" },
  { id: "long-3", time: "00:07", seconds: 7, text: "那我想做的是什么电商来着……", defaultDecision: "remove", speaker: "连麦人" },
  { id: "long-4", time: "00:11", seconds: 11, text: "其实这个问题要看你从什么行业过来。", defaultDecision: "remove" },
  { id: "long-5", time: "00:16", seconds: 16, text: "上来做电商，起码要学两年。", defaultDecision: "keep" },
  { id: "long-6", time: "00:21", seconds: 21, text: "货品、团队、商务、人群、内容、平台规则，你都要学。", defaultDecision: "keep" },
  { id: "long-7", time: "00:29", seconds: 29, text: "所以它不是今天开播，明天就能看到结果的东西。", defaultDecision: "keep" },
];

function transcriptFor(prefix: string, hook: string, support: string): TranscriptLine[] {
  return [
    { id: `${prefix}-1`, time: "00:00", seconds: 0, text: hook, defaultDecision: "keep" },
    { id: `${prefix}-2`, time: "00:05", seconds: 5, text: "有人会问，那是不是所有人都应该这样做？", defaultDecision: "remove", speaker: "提问" },
    { id: `${prefix}-3`, time: "00:10", seconds: 10, text: support, defaultDecision: "keep" },
    { id: `${prefix}-4`, time: "00:17", seconds: 17, text: "我先把另外一个不相关的例子说完。", defaultDecision: "remove" },
    { id: `${prefix}-5`, time: "00:22", seconds: 22, text: "你先把这件事做对，再谈下一步。", defaultDecision: "keep" },
    { id: `${prefix}-6`, time: "00:29", seconds: 29, text: "这才是我真正想给你们的结论。", defaultDecision: "keep" },
  ];
}

const ideas: ClipIdea[] = [
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
    transcript: transcriptFor("ip", "这两个完全可以一起做，这不是非二选一的东西。", "你可以先把本职工作的真实经验拆成内容，再逐渐验证个人 IP。"),
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
    transcript: transcriptFor("rules", "成年人相处，先看行动，不要替别人解释。", "君子论迹不论心，长期关系更应该看稳定的行为。"),
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
    transcript: transcriptFor("energy", "你不是不知道怎么办，你是已经没有精力去做。", "先把睡眠、身体和注意力救回来，再谈执行力。"),
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
    transcript: transcriptFor("problems", "创业不是每天都在赢，是每天都在解决问题。", "你解决问题的速度，最后就会变成团队的能力。"),
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
    transcript: transcriptFor("money", "赚钱可以是结果，但不能是你做每件事唯一的目标。", "当你的能力和作品开始复利，钱才更容易变成稳定结果。"),
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
    transcript: transcriptFor("dress", "这件衣服一共是三穿。", "长袖、一字肩、吊带都能穿，腰线位置还会把比例拉得很好。"),
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
    transcript: transcriptFor("mainpick", "不要因为它是主推，就默认它最适合你。", "先看你的使用场景、预算和最在意的那个问题。"),
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
    transcript: transcriptFor("bag", "它不是只解决把猫背出去，是把一路要用的东西都装进去。", "八个口袋分别对应水、零食、纸巾和随身小物，不会乱。"),
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
    transcript: transcriptFor("shape", "显瘦不是把自己塞进更小的尺码，是先把比例穿对。", "这件的腰线和肩颈留白，才是你上身显利落的原因。"),
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
    transcript: transcriptFor("fans", "直播间粉丝从来不是一种人，你不能用同一句话跟所有人沟通。", "先分清新客、老客和高黏性用户，再决定每一段讲什么。"),
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
    transcript: transcriptFor("reason", "不要在一条切片里塞十个卖点，观众最后一个都记不住。", "先选出最能解决问题的一个理由，让画面把它证明出来。"),
  },
];

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
    () => highPotentialOnly ? modeIdeas.filter((idea) => idea.score >= 95) : modeIdeas,
    [highPotentialOnly, modeIdeas],
  );
  const discoveredCount = analysisReady ? modeIdeas.length : 0;

  const activeClip = ideas.find((idea) => idea.id === activeClipId) ?? modeIdeas[0];
  const activeLineIndex = activeClip.transcript.findIndex((line, index) => {
    const next = activeClip.transcript[index + 1]?.seconds ?? Number.POSITIVE_INFINITY;
    return currentTime >= line.seconds && currentTime < next;
  });
  const keptCount = activeClip.transcript.filter((line) => decisions[line.id] === "keep").length;
  const excludedRanges = activeClip.transcript.flatMap((line, index) => {
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
        showToast(`内容地图已生成：本场自然发现 ${modelResultCount} 条可剪灵感。`);
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
  }

  function enterTranscript() {
    if (!selectedIds.length) {
      showToast("请先选择至少一个内容想法。");
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
  }

  function generateClip() {
    setGenerationState("working");
    window.setTimeout(() => {
      setGenerationState("done");
      showToast("文字粗剪预听已按当前选择更新；正式 MP4 将由后台按这些时间码渲染。");
    }, 1300);
  }

  function handoffToChatCut() {
    showToast("演示：已准备可编辑时间线。正式版连接 ChatCut 后会写入用户工程。");
  }

  function toggleIdeaFilter() {
    const next = !highPotentialOnly;
    setHighPotentialOnly(next);
    if (next && activeClip.score < 95) {
      const firstHighPotential = modeIdeas.find((idea) => idea.score >= 95);
      if (firstHighPotential) activateClip(firstHighPotential.id);
    }
  }

  function explainAllIdeas() {
    showToast(`当前模型样例共返回 ${discoveredCount} 条可播放灵感；正式版同样直接渲染 candidates.length，不预设、不补齐。`);
  }

  const previewSource = uploadedPreviewUrl || activeClip.video;

  return (
    <main className="cutline-app">
      <header className="masthead">
        <div className="masthead-brand">
          <button className="wordmark" onClick={() => setStep(1)} aria-label="返回上传步骤">CUTLINE</button>
          <span>AI LIVESTREAM CLIPPING WORKBENCH</span>
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
          <button className="text-action" onClick={() => setShowArchitecture(true)}>真实后台</button>
        </div>
      </header>

      {step === 1 && (
        <section className="intake-view" aria-labelledby="intake-title">
          <div className="intake-intro">
            <span className="edition-label">NEW PROJECT · 最高质量模型</span>
            <h1 id="intake-title">把整场直播，交给一位真正的主编。</h1>
            <p>先选择内容类型。不同类型使用不同的选题、语境、节奏和风险判断；候选数量完全由本场判断结果决定，不设目标、不设保底，也不补齐。</p>
          </div>

          <div className="intake-grid">
            <section className="upload-editorial" aria-label="上传直播录屏">
              <div className="section-number">01 / SOURCE</div>
              <h2>上传完整直播</h2>
              <p>MP4 / MOV · 正式版支持断点上传、后台转写和原片上下文播放。</p>
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
              <div className="section-number">02 / EDITION</div>
              <h2 id="mode-title">这场直播，要剪成哪一种？</h2>
              <div className="mode-covers">
                <button
                  className={mode === "聊播" ? "selected" : ""}
                  onClick={() => switchMode("聊播")}
                  aria-pressed={mode === "聊播"}
                >
                  <b>聊播</b>
                  <span>完整观点与上下文</span>
                  <p>删除他人提问与无效来回，保留天总原话、情绪和结论。</p>
                </button>
                <button
                  className={mode === "带货" ? "selected" : ""}
                  onClick={() => switchMode("带货")}
                  aria-pressed={mode === "带货"}
                >
                  <b>带货</b>
                  <span>单一卖点与画面验证</span>
                  <p>一个视频只讲一个购买理由，口播、展示与合规逐项对齐。</p>
                </button>
              </div>
            </section>
          </div>

          <div className="intake-footer">
            <div>
              <strong>三遍主编制</strong>
              <span>全场发现 → 结构精剪 → 独立终审</span>
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

          <p className="prototype-note">当前为交互原型：选择本地视频只用于浏览器预览；真实上传、OpenAI 分析与 ChatCut 写入尚未接通。</p>
        </section>
      )}

      {step === 2 && (
        <section className="map-view" aria-labelledby="map-title">
          <aside className="idea-index">
            <div className="panel-heading">
              <div><span>本场发现</span><b>{discoveredCount} 条灵感</b></div>
              <button onClick={toggleIdeaFilter} aria-pressed={highPotentialOnly}>{highPotentialOnly ? "查看全部" : "只看高潜"}</button>
            </div>
            <p className="panel-intro">模型自然返回多少就是多少，不预设、不保底、不凑数。</p>
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
                    <span>{idea.index}</span>
                    <strong>{idea.title}</strong>
                    <small>{idea.duration}</small>
                  </button>
                </article>
              ))}
            </div>
            <button className="outline-action full" onClick={explainAllIdeas}>查看全部灵感（{discoveredCount}）</button>
          </aside>

          <section className="map-preview" aria-label="候选原片预览">
            <div className="story-header">
              <span>SELECTED STORY · {activeClip.index}</span>
              <b>价值判断 {activeClip.score}</b>
            </div>
            <h1 id="map-title">{activeClip.title}</h1>
            <p>{activeClip.summary}</p>
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
          </section>

          <aside className="map-notes">
            <div className="panel-heading"><div><span>文字快照</span><b>AI 初判断</b></div></div>
            <div className="legend"><span>保留片段</span><span>建议删除</span></div>
            <div className="snapshot-lines">
              {activeClip.transcript.map((line) => (
                <button
                  key={line.id}
                  className={decisions[line.id] === "remove" ? "removed" : ""}
                  onClick={() => seekTo(line.seconds)}
                >
                  <time>{line.time}</time>
                  <span>{line.text}</span>
                </button>
              ))}
            </div>
            <div className="selection-summary">
              <span>已选 {selectedIds.length} 条 · 本场模型返回 {discoveredCount} 条</span>
              <button className="pink-action" onClick={enterTranscript}>选中后进入文字精剪</button>
            </div>
          </aside>
        </section>
      )}

      {step === 3 && (
        <section className="cut-room" aria-labelledby="cut-title">
          <aside className="idea-index compact">
            <div className="panel-heading">
              <div><span>本场发现</span><b>{discoveredCount} 条灵感</b></div>
              <button onClick={toggleIdeaFilter} aria-pressed={highPotentialOnly}>{highPotentialOnly ? "查看全部" : "只看高潜"}</button>
            </div>
            <p className="panel-intro">数量由模型自然得出，不设上限，也不补齐。</p>
            <div className="idea-list">
              {displayedIdeas.map((idea) => (
                <button
                  className={`compact-idea ${activeClip.id === idea.id ? "active" : ""}`}
                  key={idea.id}
                  onClick={() => activateClip(idea.id)}
                >
                  <span>{idea.index}</span><strong>{idea.title}</strong><small>{idea.duration}</small>
                </button>
              ))}
            </div>
            <button className="outline-action full" onClick={explainAllIdeas}>查看全部灵感（{discoveredCount}）</button>
          </aside>

          <section className="cut-preview" aria-label="文字精剪视频预览">
            <div className="story-header"><span>正在精剪 · {activeClip.index}</span><b>{activeClip.duration}</b></div>
            <h1 id="cut-title">{activeClip.title}</h1>
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
              <span>{generationState === "done" ? "文字粗剪预听已更新（浏览器演示）" : "当前播放器为原片上下文预览"}</span>
              <b>{keptCount} 段保留 · {activeClip.transcript.length - keptCount} 段删除</b>
            </div>
            <p className="raw-output-note">目标输出：无字幕 · 无效果 · 保留原声</p>
          </section>

          <section className="transcript-editor" aria-labelledby="transcript-title">
            <div className="transcript-head">
              <div>
                <h2 id="transcript-title">文字精剪</h2>
                <p>点文字可定位播放；每一句都能改成保留或删除。</p>
              </div>
              <span>最高质量模型初筛</span>
            </div>
            <div className="legend"><span>保留内容</span><span>建议删除</span></div>
            <div className="transcript-lines">
              {activeClip.transcript.map((line, index) => {
                const decision = decisions[line.id] ?? line.defaultDecision;
                return (
                  <article
                    key={line.id}
                    className={`${decision === "remove" ? "removed" : ""} ${activeLineIndex === index ? "playing" : ""}`}
                  >
                    <button className="transcript-seek" onClick={() => seekTo(line.seconds)} aria-label={`从 ${line.time} 播放：${line.text}`}>
                      <time>{line.time}</time>
                      <p>{line.speaker && <small>{line.speaker}</small>}{line.text}</p>
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
                  <a className="outline-action" href={activeClip.video} download>下载无字幕样片</a>
                  <button className="pink-action" onClick={handoffToChatCut}>送入 ChatCut 精修</button>
                </div>
              ) : (
                <button className="pink-action" onClick={generateClip} disabled={generationState === "working"}>
                  {generationState === "working" ? "正在按文字生成切片…" : "按文字生成切片"}
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
            <span className="edition-label">PRODUCTION ARCHITECTURE</span>
            <h2 id="architecture-title">我们的后台是主脑，OpenAI 是最高质量模型，ChatCut 是剪辑执行层。</h2>
            <div className="architecture-list">
              <div><b>01</b><strong>上传与存储</strong><p>直播断点上传、代理文件、权限和删除周期。</p></div>
              <div><b>02</b><strong>OpenAI 主编</strong><p>最强转写与旗舰模型完成全场发现、结构精剪和独立终审。</p></div>
              <div><b>03</b><strong>人工文字复核</strong><p>用户对每句话做最终保留/删除判断，系统不黑箱下刀。</p></div>
              <div><b>04</b><strong>ChatCut 交付</strong><p>把确认后的时间码写成可编辑时间线，也可直接生成预览成片。</p></div>
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
