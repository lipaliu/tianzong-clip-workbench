# 天总直播切片系统 Design QA

## Evidence

- Source visual truth: `/Users/lipaliu/.codex/generated_images/019f6677-49d2-7663-8cde-03afc331bbb0/exec-797d1cd7-e6e4-4307-9c80-0b72acdebf4a.png`
- Browser-rendered implementation: `/Users/lipaliu/Documents/Codex/2026-07-15/li/tianzong-clip-workbench/.sites/local-cut-natural-count-final-v2.png`
- Full-view comparison: `/Users/lipaliu/Documents/Codex/2026-07-15/li/tianzong-clip-workbench/.sites/qa-reference-vs-implementation-pass.png`
- Focused video/transcript comparison: `/Users/lipaliu/Documents/Codex/2026-07-15/li/tianzong-clip-workbench/.sites/qa-focused-video-transcript-pass.png`
- Mobile evidence:
  - `/Users/lipaliu/Documents/Codex/2026-07-15/li/tianzong-clip-workbench/.sites/mobile-final-top.png`
  - `/Users/lipaliu/Documents/Codex/2026-07-15/li/tianzong-clip-workbench/.sites/mobile-final-lines.png`
- Viewport: 1280 × 720 desktop; 390 × 844 mobile.
- State: step 3, 聊播, first idea, AI keep/delete decisions visible, browser rough-cut preview generated, both delivery routes visible.

## Full-view comparison evidence

The final side-by-side comparison preserves the source's editorial hierarchy: oversized Tianzong-specific masthead, numbered three-step rail, near-black canvas, ivory typography, blush selection state, three-column editing room, portrait video, transcript ledger, and flat bottom delivery actions. The implementation uses a naturally returned sample count of 6 instead of the static 67 shown in the visual target; this is an intentional product-correct content difference, not layout drift.

## Focused region comparison evidence

The focused comparison confirms that the portrait video remains the dominant middle-column asset and that the transcript keeps the source's dense horizontal-rule rhythm, timecodes, blush active row, and explicit keep/delete controls. The source and implementation use different frames from real Tianzong media, so crop and pose are treated as dynamic content. No source logo, illustration, or product image was replaced with CSS/SVG artwork.

## Required fidelity surfaces

- Fonts and typography: Bodoni Moda supplies the high-contrast editorial wordmark/display treatment; Geist and Geist Mono provide the compact UI and timecode layers. Hierarchy, optical weight, line height, letter spacing, and truncation remain readable at both tested viewports.
- Spacing and layout rhythm: the desktop keeps the masthead plus left-idea/middle-preview/right-transcript grid, square corners, hairline dividers, and bottom action rail. Mobile deliberately reorders preview → ideas → transcript and keeps the final actions reachable without horizontal overflow.
- Colors and visual tokens: near-black, raised charcoal, warm ivory, muted gray, and blush pink map directly to the visual target. Active, removed, disabled, hover, and keyboard-focus states remain distinguishable.
- Image quality and asset fidelity: the interface uses real Tianzong video and raster poster assets. The close portrait crop differs from the source design's full-body frame because it is a different real calibration clip; sharpness and aspect-ratio handling remain acceptable.
- Copy and content: the app now states that candidate quantity is `candidates.length`, with no target, floor, ceiling, or padding. Prototype-only behavior is labeled honestly; raw delivery is described as the target output, and the downloadable file is called a sample.

## Primary interactions tested

- Select 聊播 and run the deterministic analysis demo.
- Confirm the content map reports 6 ideas because the current model sample contains 6 candidates.
- Toggle “只看高潜 / 查看全部”.
- Open “查看全部灵感” and verify the explanation states that the count comes directly from `candidates.length`.
- Select an idea and enter transcript editing.
- Play the native video preview.
- Seek from a transcript sentence; uploaded-video seeking now adds the clip's source offset.
- Change keep/delete decisions and confirm the retained/deleted totals update.
- Generate the browser rough-cut preview and reveal both download and ChatCut actions.
- Click the already-active mode and verify it does not reset the workflow.
- Verify the 390 × 844 layout, transcript scroll region, and sticky delivery actions.
- Browser console checked: no warnings or errors; only Vite HMR debug messages and the React DevTools informational message.

## Comparison history

### Pass 1 — blocked

- P1: candidate totals were hard-coded to 67/43 while only six candidates existed. Fixed by deriving the displayed total from the actual mode candidate array; the regression test rejects the earlier hard-coded constant.
- P1: the generated state implied that a final file had already been rendered. Fixed by implementing keep/delete-aware browser rough-cut preview behavior and labeling the downloadable file as a sample; production MP4 rendering remains explicitly a backend step.
- P1: transcript seeking used relative seconds against uploaded full livestreams. Fixed by adding `sourceStart` when the active source is an uploaded full recording and normalizing playback highlighting back to clip-relative time.
- P2: clicking the already-selected mode reset all work. Fixed by making the active mode inert and explaining resets only when the mode actually changes.
- P2: filter and “view all” controls were inert. Fixed by adding a high-potential filter and an honest model-result explanation.
- P2: nested interactive controls and non-keyboard transcript rows reduced accessibility. Fixed by separating candidate checkbox/button controls and adding a dedicated, labeled transcript seek button.

### Pass 2 — passed

- Post-fix evidence: `.sites/qa-reference-vs-implementation-pass.png` and `.sites/qa-focused-video-transcript-pass.png`.
- No actionable P0, P1, or P2 fidelity, behavior, accessibility, or responsive findings remain.

## Follow-up polish

- P3: production may replace native browser video chrome with a brand-aligned accessible control skin, but native controls are intentionally retained in this prototype for reliability.
- P3: the current demo downloads a clean calibration sample; the real backend still needs media rendering and ChatCut project creation.
- Non-design test gap: standalone `npx tsc --noEmit` still needs Cloudflare Worker ambient types, while the actual lint, rendered-HTML tests, and production build pass.

final result: passed
