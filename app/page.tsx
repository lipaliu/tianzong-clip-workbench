"use client";

import { ChangeEvent, useMemo, useRef, useState } from "react";

type ClipKind = "聊播" | "带货";
type ClipStatus = "高潜" | "可用" | "待复核";

type Clip = {
  id: string;
  kind: ClipKind;
  status: ClipStatus;
  score: number;
  duration: string;
  sourceRange: string;
  title: string;
  hook: string;
  body: string;
  reason: string;
  thumbnail: string;
  color: string;
  risk?: string;
};

const clips: Clip[] = [
  {
    id: "chat-07",
    kind: "聊播",
    status: "高潜",
    score: 96,
    duration: "31 秒",
    sourceRange: "00:59:46 — 01:00:46",
    title: "把带货当快钱的人，第一步就错了",
    hook: "如果你想赚快钱，带货不适合。带货是长线的问题。",
    body: "直接接“起码两年”，再解释货品、团队、商务、人群、内容和平台规则为什么都要学。",
    reason: "结论先行 · 认知反差 · 能力清单完整",
    thumbnail: "/thumbnails/chat-longterm.png",
    color: "#e8dcff",
    risk: "“两年”需保留为个人经验，不包装成行业认证周期。",
  },
  {
    id: "chat-03",
    kind: "聊播",
    status: "高潜",
    score: 93,
    duration: "68 秒",
    sourceRange: "00:30:21 — 00:31:43",
    title: "本职工作和个人 IP，根本不是二选一",
    hook: "这两个完全可以一起做，这不是非二选一的东西。",
    body: "把本职成绩拆成账号内容，用真实业务经验建立信用，再逐渐验证个人 IP。",
    reason: "高频困惑 · 方法可执行 · 观点鲜明",
    thumbnail: "/thumbnails/chat-selfmedia.png",
    color: "#dff7eb",
    risk: "弱化收入数字，避免形成收益承诺。",
  },
  {
    id: "sales-25",
    kind: "带货",
    status: "可用",
    score: 89,
    duration: "42 秒",
    sourceRange: "05:16:00 — 05:17:25",
    title: "一条度假裙，为什么要做三种穿法",
    hook: "这件衣服一共是三穿。",
    body: "长袖、一字肩、吊带三种穿法，配合收腰位置和裙摆展示，最后落到度假场景。",
    reason: "卖点单一 · 画面强 · 使用场景明确",
    thumbnail: "/thumbnails/sales-detail.png",
    color: "#ffe9d9",
  },
  {
    id: "sales-51",
    kind: "带货",
    status: "待复核",
    score: 84,
    duration: "54 秒",
    sourceRange: "02:33:45 — 02:36:55",
    title: "一个猫包，八个口袋到底怎么装",
    hook: "它不是只解决把猫背出去，是把你一路要用的东西都装进去。",
    body: "围绕八口袋与双肩带逐一展示，不混入另一段母子包结构，保持一个视频只讲一个核心。",
    reason: "结构可视化 · 细节密度高 · 购买理由明确",
    thumbnail: "/thumbnails/sales-value.png",
    color: "#dcecff",
    risk: "需要复核每个口袋对应画面，避免口播与展示错位。",
  },
];

const stages = ["上传直播", "逐字转写", "内容地图", "候选评分", "事实复核", "人工审核", "送入 ChatCut"];

export default function Home() {
  const [activeClipId, setActiveClipId] = useState(clips[0].id);
  const [selectedIds, setSelectedIds] = useState<string[]>([clips[0].id, clips[1].id]);
  const [filter, setFilter] = useState<"全部" | ClipKind>("全部");
  const [query, setQuery] = useState("");
  const [instruction, setInstruction] = useState("保留“带货是长线的问题”，删掉连麦人的提问，直接接“起码两年”。");
  const [revisionState, setRevisionState] = useState<"idle" | "working" | "done">("idle");
  const [toast, setToast] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [showArchitecture, setShowArchitecture] = useState(false);
  const [fileName, setFileName] = useState("");
  const [demoRunning, setDemoRunning] = useState(false);
  const [demoProgress, setDemoProgress] = useState(100);
  const fileRef = useRef<HTMLInputElement>(null);

  const activeClip = clips.find((clip) => clip.id === activeClipId) ?? clips[0];

  const filteredClips = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return clips.filter((clip) => {
      const matchesKind = filter === "全部" || clip.kind === filter;
      const matchesQuery =
        !normalized ||
        `${clip.title}${clip.hook}${clip.reason}`.toLowerCase().includes(normalized);
      return matchesKind && matchesQuery;
    });
  }, [filter, query]);

  function toggleSelected(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  function runRevision() {
    if (!instruction.trim()) return;
    setRevisionState("working");
    window.setTimeout(() => {
      setRevisionState("done");
      setToast("演示：修改意图已记录。接入剪辑后台后会生成新版时间轴。");
      window.setTimeout(() => setToast(""), 3600);
    }, 950);
  }

  function runDemo() {
    setShowUpload(false);
    setDemoRunning(true);
    setDemoProgress(12);
    let value = 12;
    const timer = window.setInterval(() => {
      value += value < 58 ? 18 : 11;
      if (value >= 100) {
        window.clearInterval(timer);
        setDemoProgress(100);
        setDemoRunning(false);
        setToast("示例分析完成：已载入 4 条人工校准过的候选切片。");
        window.setTimeout(() => setToast(""), 3600);
        return;
      }
      setDemoProgress(value);
    }, 420);
  }

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) setFileName(file.name);
  }

  function handoffToChatCut() {
    setToast(
      selectedIds.length
        ? `演示：已准备 ${selectedIds.length} 条切片；真实发送需接入 ChatCut 授权。`
        : "请先勾选至少一条候选切片。",
    );
    window.setTimeout(() => setToast(""), 3800);
  }

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand-mark" aria-label="切片台">
          <span>切</span>
        </div>
        <nav className="side-nav">
          <button className="side-nav-item active" aria-label="任务工作台" title="任务工作台">
            <span>▦</span>
          </button>
          <button className="side-nav-item" aria-label="人设库" title="人设库">
            <span>◇</span>
          </button>
          <button className="side-nav-item" aria-label="剪辑规则" title="剪辑规则">
            <span>≋</span>
          </button>
          <button className="side-nav-item" aria-label="成片库" title="成片库">
            <span>▶</span>
          </button>
        </nav>
        <button className="avatar-button" aria-label="账号">
          L
        </button>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <div className="eyebrow-row">
              <span className="eyebrow">CUTLINE · 切片工作台</span>
              <span className="demo-pill">交互原型</span>
            </div>
            <h1>从整场直播，到值得发的切片。</h1>
          </div>
          <div className="topbar-actions">
            <button className="ghost-button" onClick={() => setShowArchitecture(true)}>
              后台怎么跑？
            </button>
            <button className="primary-button" onClick={() => setShowUpload(true)}>
              <span>＋</span> 新建直播任务
            </button>
          </div>
        </header>

        <div className="honesty-banner" role="status">
          <span className="honesty-dot" />
          当前展示的是<strong>已人工校准的天总样片流程</strong>。上传、真实转写、模型分析与 ChatCut 发送接口尚未接入，不会假装处理你上传的内容。
        </div>

        <section className="job-overview" aria-labelledby="job-title">
          <div className="job-copy">
            <div className="job-meta-row">
              <span className="live-dot" />
              <span>示例任务 · 聊播</span>
              <span>2026.06.17</span>
            </div>
            <h2 id="job-title">竺天天整场直播</h2>
            <p>03:12:46 · 已完成逐字阅读与人设校准</p>
          </div>

          <div className="metrics" aria-label="任务概览">
            <div><strong>28</strong><span>候选片段</span></div>
            <div><strong>12</strong><span>高潜片段</span></div>
            <div><strong>06</strong><span>可直接送审</span></div>
          </div>

          <div className="pipeline" aria-label="处理流程">
            {stages.map((stage, index) => (
              <div className="pipeline-step" key={stage}>
                <span className="step-check">{demoRunning && index > 1 ? index + 1 : "✓"}</span>
                <span>{stage}</span>
                {index < stages.length - 1 && <i />}
              </div>
            ))}
          </div>

          {demoRunning && (
            <div className="analysis-progress" aria-live="polite">
              <div>
                <span>正在模拟：逐字稿分段 → 价值判断 → 人设校准</span>
                <strong>{Math.min(demoProgress, 100)}%</strong>
              </div>
              <progress max="100" value={Math.min(demoProgress, 100)} />
            </div>
          )}
        </section>

        <section className="review-section" aria-labelledby="review-heading">
          <div className="section-heading-row">
            <div>
              <span className="section-kicker">人工审核</span>
              <h2 id="review-heading">候选切片</h2>
            </div>
            <div className="review-toolbar">
              <label className="search-box">
                <span>⌕</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜观点、卖点或话题"
                  aria-label="搜索候选切片"
                />
              </label>
              <div className="filter-tabs" aria-label="候选类型">
                {(["全部", "聊播", "带货"] as const).map((item) => (
                  <button
                    key={item}
                    className={filter === item ? "active" : ""}
                    onClick={() => setFilter(item)}
                    aria-pressed={filter === item}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="review-grid">
            <div className="candidate-column">
              <div className="candidate-list-head">
                <span>按内容价值排序</span>
                <span>{filteredClips.length} 条样例</span>
              </div>

              <div className="candidate-list">
                {filteredClips.map((clip) => {
                  const active = clip.id === activeClip.id;
                  const selected = selectedIds.includes(clip.id);
                  return (
                    <article
                      className={`clip-card ${active ? "active" : ""}`}
                      key={clip.id}
                      onClick={() => setActiveClipId(clip.id)}
                    >
                      <button
                        className={`check-button ${selected ? "checked" : ""}`}
                        aria-label={`${selected ? "取消" : "选择"}${clip.title}`}
                        aria-pressed={selected}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleSelected(clip.id);
                        }}
                      >
                        {selected ? "✓" : ""}
                      </button>
                      <div className="clip-thumb">
                        <img src={clip.thumbnail} alt="天总直播候选片段画面" />
                        <span>{clip.duration}</span>
                        <button aria-label={`预览${clip.title}`} onClick={(event) => event.stopPropagation()}>
                          ▶
                        </button>
                      </div>
                      <div className="clip-card-body">
                        <div className="clip-labels">
                          <span className="kind-label" style={{ background: clip.color }}>{clip.kind}</span>
                          <span className={`status-label status-${clip.status}`}>{clip.status}</span>
                          <span className="source-time">{clip.sourceRange}</span>
                        </div>
                        <h3>{clip.title}</h3>
                        <p>“{clip.hook}”</p>
                        <div className="reason-row">
                          <span>{clip.reason}</span>
                          <strong>{clip.score}<small>/100</small></strong>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>

            <aside className="inspector" aria-label="切片审核详情">
              <div className="inspector-head">
                <div>
                  <span className="section-kicker">当前切片</span>
                  <h2>{activeClip.title}</h2>
                </div>
                <span className="score-chip">价值分 {activeClip.score}</span>
              </div>

              <div className="preview-frame">
                <img src={activeClip.thumbnail} alt="当前候选切片预览" />
                <div className="preview-overlay">
                  <button aria-label="播放当前候选切片">▶</button>
                  <span>样片画面</span>
                </div>
                <div className="caption-preview">{activeClip.hook}</div>
              </div>

              <div className="mini-timeline" aria-label="示意时间轴">
                <div className="timeline-labels"><span>入点 00:00.0</span><span>出点 {activeClip.duration}</span></div>
                <div className="waveform" aria-hidden="true">
                  {Array.from({ length: 34 }, (_, index) => (
                    <i key={index} style={{ height: `${12 + ((index * 13) % 30)}px` }} />
                  ))}
                </div>
                <div className="timeline-selection"><span /><span /></div>
              </div>

              <div className="script-block">
                <div className="script-block-head"><span>结构建议</span><button>查看逐字稿</button></div>
                <div className="script-row"><b>钩子</b><p>{activeClip.hook}</p></div>
                <div className="script-row"><b>展开</b><p>{activeClip.body}</p></div>
                <div className="script-row"><b>理由</b><p>{activeClip.reason}</p></div>
              </div>

              {activeClip.risk && (
                <div className="risk-note"><span>!</span><p><strong>复核提醒</strong>{activeClip.risk}</p></div>
              )}

              <label className="instruction-box">
                <span>告诉剪辑助手怎么改</span>
                <textarea
                  value={instruction}
                  onChange={(event) => {
                    setInstruction(event.target.value);
                    setRevisionState("idle");
                  }}
                  rows={4}
                />
              </label>
              <div className="inspector-actions">
                <button className="secondary-button" onClick={() => setInstruction("")}>清空</button>
                <button className="dark-button" onClick={runRevision} disabled={revisionState === "working" || !instruction.trim()}>
                  {revisionState === "working" ? "正在理解修改…" : revisionState === "done" ? "已记录修改 ✓" : "按这句话重剪"}
                </button>
              </div>
            </aside>
          </div>
        </section>

        <footer className="batch-bar">
          <div>
            <span className="batch-count">{selectedIds.length}</span>
            <p><strong>已选择候选</strong><span>先人工确认，再生成可编辑时间轴</span></p>
          </div>
          <div>
            <button className="ghost-button" onClick={() => setSelectedIds([])}>取消选择</button>
            <button className="primary-button" onClick={handoffToChatCut}>送入 ChatCut <span>→</span></button>
          </div>
        </footer>
      </section>

      {showUpload && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowUpload(false)}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="upload-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" aria-label="关闭" onClick={() => setShowUpload(false)}>×</button>
            <span className="section-kicker">新建任务</span>
            <h2 id="upload-title">放进一场完整直播</h2>
            <p className="modal-lead">第一版先用样片体验完整审核流程。真实上传接口接入后，会在后台完成转写、找段与时间轴生成。</p>
            <button className="upload-zone" onClick={() => fileRef.current?.click()}>
              <span className="upload-icon">⇧</span>
              <strong>{fileName || "选择直播录屏"}</strong>
              <small>{fileName ? "文件只在当前浏览器中选中，尚未上传" : "MP4 / MOV，真实版本将支持断点上传"}</small>
            </button>
            <input ref={fileRef} type="file" accept="video/mp4,video/quicktime" hidden onChange={handleFile} />
            <div className="privacy-note"><span>隐私</span><p>真实版本会在上传前说明保存期限、模型处理方式与删除入口。</p></div>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setShowUpload(false)}>稍后再说</button>
              <button className="primary-button" onClick={runDemo}>用校准样片体验流程</button>
            </div>
          </section>
        </div>
      )}

      {showArchitecture && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowArchitecture(false)}>
          <section className="modal architecture-modal" role="dialog" aria-modal="true" aria-labelledby="architecture-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" aria-label="关闭" onClick={() => setShowArchitecture(false)}>×</button>
            <span className="section-kicker">真实运行方式</span>
            <h2 id="architecture-title">用户不需要登录 Codex</h2>
            <p className="modal-lead">Codex 是我们开发和校准工作流的工具。公开产品由你的网站账号承接，后台统一调用模型与媒体服务。</p>
            <div className="architecture-flow">
              <div><b>01</b><span>对象存储</span><p>直播断点上传、代理文件、自动删除</p></div>
              <div><b>02</b><span>逐字转写</span><p>语音识别＋说话人区分＋词级时间戳</p></div>
              <div><b>03</b><span>语义剪辑</span><p>模型按人设、价值与节奏生成候选脚本</p></div>
              <div><b>04</b><span>交付成片</span><p>ChatCut 授权生成可编辑时间轴，或后台渲染</p></div>
            </div>
            <div className="cost-grid">
              <div><span>需要 Token</span><strong>是</strong><p>用于理解逐字稿、评分、重组与接受修改意见。</p></div>
              <div><span>需要 GPU</span><strong>按需</strong><p>托管 API 不需自备 GPU；自建转写或批量渲染时才需要。</p></div>
              <div><span>建议模型</span><strong>分层调用</strong><p>便宜模型初筛，平衡型模型终审；高风险内容再升级。</p></div>
              <div><span>用户登录</span><strong>产品账号</strong><p>无需 Codex；需要可编辑工程时，再授权自己的 ChatCut。</p></div>
            </div>
          </section>
        </div>
      )}

      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    </main>
  );
}
