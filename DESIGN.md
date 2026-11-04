# FrameForge Studio — Design Contract

## 0. Research log

- **User-supplied static concept** — `C:\Users\bangg\AppData\Local\hermes\cache\scratch\frameforge-ops-concept\concept.png` at 1440×1040 and its editable `concept.html` were visually inspected. The screenshot establishes an operational, queue-first hierarchy, warm neutral surfaces, a single blue accent, concise status marks, an asymmetric main/rail composition, and a persistent navigation shell. Palette and font values below were extracted from the concept source CSS. Its people, tasks, dates, metrics, assets, bridge, backup, storage, and Tailscale status are fictional and are not product requirements or observed data.
- **Existing product source** — `public/index.html`, `public/styles.css`, `public/app.js`, `server/app.mjs`, `server/store.mjs`, `.mex/context/architecture.md`, and `.mex/context/decisions.md` were inspected. The real product is a local-first vanilla-JS editor with seven existing views, SQLite-backed entities, episode/workflow version history, render/generation/narration jobs, and integration/trend status. `/api/state` is the current aggregate read model. Preserve these workflows and use their actual records.
- **Design-data lookup (skipped)** — `omh design data --kind palette|font|ux --context dashboard` was attempted earlier but the `omh` executable was unavailable (exit 127); no curated rows were returned. The local candidate paths also contained no executable. Do not claim this contract is backed by that dataset.
- **Jev review (pre-implementation, advisory)** — a real default-profile review of the scoped proposal returned `proposal_only` on an `unvalidated` tier (jev-1.13.0); there was no source diff to review. Treat this as a warning, not permission or a code verdict.
- **Current rendered-product capture (observed after implementation)** — final overview, Studio, Workflow, and supporting views were captured after the last UI edit at 1440px, 768px, and 375px where applicable. The scoped evidence and screenshots are in `artifacts/ops-workspace/`; the browser run used isolated Korean fixtures, not production records. The final visual receipt reports 94/100 PASS with no listed differences.

- **Bright redesign (2026-10-30)** — superseded the earlier warm-neutral palette and the shared dark default that the blog and, through `styles.css`, the workbench rendered. Jev API routing (`jeopi` profile, served `jev-1.14.0`, tier `unvalidated`) ranked `design-taste-frontend` highest (fit 0.44); its consistency locks, AA gates, em-dash ban and reduced-motion rules were applied, while its landing-page aesthetics were not, because it disclaims operational workbenches. Design read: operational production workbench, bright polished studio language, token-driven native CSS. Dials: DESIGN_VARIANCE 4, MOTION_INTENSITY 4, VISUAL_DENSITY 6. An advisory Jev review of the proposal returned `proposal_only` (evidence_supports 0.64 below its 0.80 threshold; receipt `062b43d9702d6a126a1ea7baae6999e50526bb3c8a4cb6b9be9d3c6b95dca5c7`), which is a warning, not approval. An independent vision critique of the prior screenshots drove the hierarchy fixes (one primary per surface, visible unsaved state, clearer disabled state, layered surfaces).

## 1. Atmosphere & identity

- **Audience:** Korean-speaking producers who need to see what is being produced, inspect outputs and history, and understand the actual state of the local production system.
- **Primary task:** scan current production records, find the next item requiring attention, and open its existing editor or job detail without losing provenance.
- **Primary direction:** **Operational** — information density and trustworthy state over editorial drama. Visual signature: bright cool-neutral surfaces with a single blue accent (section 2), evolved from the concept's queue-first hierarchy; do not copy its fictional project identity, wordmark, records, copy, or data model.
- **Reads as:** bright, composed, traceable, dependable.
- **Signature:** a real-data work queue paired with a compact provenance/operations rail; every count links to records that produce it.
- **Scope:** add an operational overview to the current shared app shell and harmonize the existing Studio, Workflow, Trends, Templates, History, Knowledge, and Settings views. Keep all current editor and production actions intact. This is not a replacement product or a static mock.

## 2. Color

Use semantic tokens; components must not introduce one-off palette values. Approximate visual budget: 72% bright cool ground/surface, 23% text/borders/secondary surfaces, 5% accent and semantic status colors. Status is never conveyed by color alone. All text/surface pairs must meet WCAG 2.2 AA contrast (4.5:1 normal text, 3:1 large text and essential UI graphics); verify actual rendered pairs before claiming a pass.

The studio workbench (`index.html`) and the blog workspace (`blog.html`) share one bright theme declared once in `public/styles.css` `:root`. Page stylesheets may set density (the workbench raises `--control-height` to 40px) but never redeclare color or shape tokens.

| Token | Value | Role |
|---|---|---|
| `--canvas` | `#f6f7fb` | Main application ground and node-canvas base |
| `--surface` | `#ffffff` | Panels, top bar, dialogs, node cards |
| `--surface-side` | `#f1f3f9` | Navigation rail and dialog footers |
| `--surface-subtle` | `#eef1f8` | Quiet inset, hover-neutral and callout surface |
| `--ink` | `#1b2130` | Primary text; toast ground |
| `--text-secondary` | `#485166` | Secondary text |
| `--muted` | `#5b6478` | Supporting copy and placeholders |
| `--line` | `#e1e5ee` | Dividers, panel and dialog boundaries |
| `--line-control` | `#cdd3df` | Decorative card edges (node cards); never the only control boundary |
| `--line-strong` | `#868fa3` | Inputs and controls requiring clear boundaries |
| `--accent` | `#3451e0` | Primary action, links, selection, section labels |
| `--accent-bright` / `--accent-strong` | `#4a66f0` / `#2c46cf` | Primary-action gradient top / hover (pressed uses `--focus`) |
| `--accent-soft` | `#ebefff` | Accent selection/background |
| `--on-accent` | `#ffffff` | Text on accent, gradient and ink grounds |
| `--success` / `--success-soft` | `#1c7350` / `#e6f5ed` | Confirmed completed/healthy state |
| `--warning` / `--warning-soft` | `#8f5600` / `#fff3dc` | Attention state, including the unsaved-changes chip |
| `--danger` / `--danger-soft` | `#b93a2c` / `#fdecea` | Failed/destructive state |
| `--focus` | `#1f36b8` | Dedicated high-contrast focus ring; never rely on the surface accent alone |
| `--canvas-dot` | `#d5dbe7` | Decorative node-canvas grid dots only |

Measured 2026-10-30 from these values: ink on canvas 15.01:1, secondary on surface 7.94:1, muted on the rail 5.35:1, accent on surface 6.18:1, white on the primary gradient 4.72:1 (top) to 6.18:1 (bottom), danger on danger-soft 4.96:1, control boundary on canvas 3.03:1, focus ring on surface 9.22:1. `tests/workbench-theme-tokens.test.mjs` recomputes the essential pairs from the live rendered tokens on both pages.

Existing editor preview media keeps authored content colors; UI chrome uses the semantic tokens. Legacy token names (`--bg`, `--border`, `--primary`, `--text`, `--raised`, `--surface-hover` = `--surface-subtle`, `--surface-input` = `--surface`) alias these values. `--media-surface` (`#11141c`) is the dark ground of media frames only and `--overlay-backdrop` tints dialog backdrops. Adjust a token in this contract if a measured pair fails; do not patch a single component with a non-contract color. Bright theme only; no dark theme or component-level theme branches.

## 3. Typography

- **Typeface stack:** `"Segoe UI", "Pretendard", "Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`. No downloaded font or network dependency. Use one family stack for interface and data; distinguish hierarchy by size, weight, and spacing, not a second decorative face.
- **Scale:** page title 28–32px/1.25, section title 18–20px/1.35, card/row title 15–16px/1.45, Korean body 14px/1.6 minimum, compact metadata 12px/1.45 minimum, micro-label 10–11px/1.4 only for nonessential uppercase/metadata.
- **Weights:** 400 body, 550–600 labels and row titles, 650–700 primary headings/actions; avoid making every label bold.
- Use tabular numerals for counts, versions, durations, timestamps, and progress. Keep Korean word wrapping natural (`word-break: keep-all` for prose; `overflow-wrap: anywhere` for long IDs/URLs). Never clip a status, version, or CJK text without an accessible full-value route.

## 4. Spacing & layout

- **Base rhythm:** 4px; use 4, 8, 12, 16, 20, 24, 32, 40px. One radius scale: `--radius-small` 6px (chips, avatars), `--radius-control` 8px (buttons, inputs), `--radius-inner` 10px (inset boxes, scene cards), `--radius-panel` 12px (panels, node cards, floating canvas controls), `--radius-dialog` 16px; status badges and pills use `--radius-pill` (fully rounded), while a status chip that can wrap to several lines (unsaved changes, narration status) uses `--radius-small`. 1px dividers. Use no decorative framework grid or blanket card grid.
- **Large desktop (≥1280px):** persistent 216px navigation (user-resizable 160-400px, stored browser-locally); 64px top bar; fluid content capped at 1600px. Overview uses a 12-column asymmetric composition: queue takes the primary 8–9 columns, provenance/operations rail 3–4 columns. Summary figures are derived from the same data as their destination lists. Avoid four equal KPI cards when the information weights differ.
- **Tablet (700–1279px):** navigation may collapse to a 64–72px icon rail only when every icon retains an accessible name and tooltip; queue stays first, secondary rail stacks below or moves to a clearly labelled tab. Tables may scroll horizontally within their own labelled region; the document itself must not overflow.
- **Mobile (<700px, QA at 375px):** use a compact header and labelled, horizontally scrollable navigation (minimum 44px touch targets). Stack panels; keep queue filters/actions reachable; use a responsive row/card presentation when a table would require unusably wide scrolling. No icon-only primary navigation. Dialogs fit the viewport and remain keyboard-operable.
- **Scroll ownership:** document owns page scroll; long tables/lists may scroll in their own labelled region only when necessary. Never lock body scroll for routine view changes.

## 5. Components and state behavior

- **Application shell:** brand, primary navigation, current workspace/channel context, actual API/session state, and main landmark. Active route uses `aria-current` and a visible selected treatment.
- **Overview summary:** counts are computed from current fetched records only. Each count links to a filtered queue. A failed/unavailable source is “확인할 수 없음,” not zero or healthy.
- **Production queue:** display actual episodes as production records, with only fields the model actually provides (title, channel, current status, version, updated time). Do not invent owner, deadline, blocker, priority, or task ID. Preserve stable episode IDs and open the existing Studio editor. Filters, sort, and shown columns are configurable presentation state only.
- **Saved views/configuration:** user-defined filters, sort, and column visibility may be stored in the existing browser-local workspace store/localStorage. Name the storage boundary in the UI. Configuration must never create episodes, alter status enums, save server layouts, or mutate production records. Persisted preferences get a safe reset and invalid-storage fallback.
- **Deliverables:** derive entries from real episode scene media, `generationJobs.outputs`, and completed render jobs/exports. Show available version/hash/format only when the API record supplies it. Link to existing authenticated local media routes. Empty state must say no matching deliverables were found; no placeholder artwork or sample records.
- **History/provenance:** use `events`, existing episode history, workflow history/runs, and stable entity/version IDs. Do not invent people or diff summaries. Restore remains the existing append-new-version flow with its concurrency guard; never rewrite history.
- **Operations:** reflect `integrations`, trend collector state, and actual queued/running/completed/failed jobs. Distinguish configured, available, and exercised states. Do not show fictional backup, storage utilization, Tailscale, latency, or bridge health unless a current API explicitly reports it. Unknown and stale states are explicit.
- **Actions:** existing Studio, Workflow, generation, narration, render, restore, and review controls retain their current confirmation/version/idempotency protections. Opening an overview or configuring a view performs no server write, provider call, render, upload, paid generation, or publication.
- **Buttons/inputs:** default, hover, focus-visible, pressed, disabled, loading, and validation-error states. At most one gradient `.primary` action per dialog, panel or form (scene editor header: 변경 저장; workflow toolbar: 워크플로우 실행; stage dialog: 선택 단계 시작, or 실패 실행에서 재개 when a failed run can resume). Selection state (active layout slot, current history page) uses `aria-pressed`/`aria-current` with the accent-soft treatment, never `.primary`, and actions repeated on every list item (apply template, apply generation result) use the default button. Disabled controls show muted text on the subtle surface with a not-allowed cursor instead of an opacity fade, so they read as unavailable rather than broken. Button minimum height 40px; destructive actions remain secondary and explicit.
- **Badges/status:** text label plus shape/icon; semantic color pair from §2. Progress has an accessible label and current value. Avoid relying on tiny dots alone.
- **Tables/lists:** semantic headings/captions, keyboard-accessible sorting with `aria-sort`, stable row identity, empty/loading/error states, and explicit row action.
- **Dialogs/menus:** native `<dialog>` or existing accessible pattern; labelled, keyboard close/cancel, focus contained/restored, no hidden action on selection.
- **Loading/empty/error:** loading skeleton or status text reflects an actual in-flight request; empty means a successful empty result; error preserves prior data when safe and offers retry. Never replace an API failure with demo rows or fabricated success.

## 6. Motion & interaction

- Motion is limited to state transitions and feedback: 150-180ms `--ease-out` for hover, input focus border and elevation changes; 200ms scale-and-fade for opening a dialog; 220ms rise-and-fade for a toast. Hover elevation changes shadow only, never geometry, so pointer targets and measured layout stay still. No bounce, scroll hijacking, parallax, or auto-advancing content.
- Respect `prefers-reduced-motion: reduce` by removing nonessential transitions/animations. No new motion dependency.
- Focus, keyboard selection, filtering, sorting, pagination/scrolling, and dialog flows must work without a pointer. Do not steal focus during background polling or replace a focused editor field during refresh.

## 7. Depth & surface

- Layered bright surfaces establish hierarchy: white panels on the cool canvas with a 1px `--line` boundary and `--shadow-soft`; `--shadow-raised` for hovered cards and floating canvas controls (zoom, minimap); `--shadow-overlay` for dialogs and the toast. No glass or blur anywhere.
- Gradient is reserved for three deliberate surfaces: the primary action (`--gradient-accent`), the brandmark tile, and the media stage (`--stage-surface`, a soft light radial wash behind the program monitor, the scene-editor preview and the review-video screen that frames the dark media, which carries `--shadow-raised`). The node canvas uses a static 20px dot grid. Node cards carry their stage color (one saturated hue per stage type in `public/workflow.js` `TYPES`: teal, sky, indigo, violet, amber, orange, magenta, red, blue, green) as a pure-hue 4px top strip (decorative, not a text pair), a 12% header tint and an icon mixed 55% with ink; measured icon-on-tint contrast is at least 3.8:1 and header text at least 11.7:1; the selected node adds a 6px accent halo. Open disclosure sections keep ink titles and signal state with an accent chevron, not a recolored heading.
- Keep the queue visually dominant and use the right rail as supporting evidence. Do not reproduce the concept screenshot as a fixed canvas.

## 8. Accessibility constraints & accepted debt

- Target WCAG 2.2 AA: contrast, semantic landmarks/headings, visible focus, keyboard parity, accessible names, status announcements, and no color-only state. Verify at 375, 768, and 1440px with Korean content and browser zoom/reflow checks.
- Respect 14px minimum Korean body copy; maintain 44px mobile touch targets and sufficiently large desktop controls.
- Existing application navigation is client-rendered and the server currently has no standalone task or complete uploads-list endpoint. For this iteration, the overview must compose existing `/api/state`, episode/workflow history endpoints, and the media references already present in returned data; no new task backend or guessed fields. If reliable data cannot be derived, show the missing-data state and record a follow-up rather than fabricating it.
- Keep workspace view preferences client-local. Server-side sharing/collaboration, user/owner assignment, due dates, custom workflow status schema, audit actors, backup/storage telemetry, and remote fleet observability remain out of scope until their models and APIs exist.
- **Performance evidence:** no numeric Core Web Vitals target or “fast” claim is made in this redesign contract because a matched pre-change browser baseline (device, route, load shape, and attribution) has not been captured. Avoid new runtime dependencies and network fonts; compare fresh before/after captures under one named profile before setting a numeric budget.

## 9. Workflow cockpit extension

- Keep the workflow canvas in the full available content width. Node settings, creation, connection, deletion, execution detail, and history detail open as focused native dialogs/popovers over the canvas; do not reserve a persistent inspector column or displace the active canvas.
- Every node exposes a keyboard-accessible details action. Connection choices are based on the saved graph and server validation; show invalid/reversed/duplicate connections as unavailable with a reason, never as fake success.
- Node execution status is derived from persisted workflow-run/node-run records. Show state text, stage counts, timestamps, and error details only when present in the API; no synthesized progress percentages or sample runs.
- Run history is a `<details>` disclosure closed by default. Search and pagination use a bounded server query; each entry shows stable run ID, workflow/episode versions, actual status, and can open the immutable run snapshot and stage outputs in an overlay.
- Dialogs restore focus to the triggering control, contain keyboard focus while open, close on Escape/cancel, and do not steal focus during background polling. Destructive node removal names the node and confirms before applying the draft mutation.

## Implementation and QA gate

1. Keep this file current before changing component code; every new token or interaction state belongs here first.
2. Preserve the baseline editor and all production safeguards. Limit writes to `DESIGN.md` and the scoped UI/CSS/test files agreed in the implementation handoff; do not touch production data, credentials, deployment, or immutable harness bundles.
3. Verify with `npm run check` and `npm test`; run targeted browser tests, including existing editor/workflow behaviors.
4. Capture the running app at 1440px, 768px, and 375px after the final UI edit. Compare each screenshot against this contract and the supplied concept. Record and fix Blocker/High/Medium/Nit differences; no visual PASS without fresh captures.
5. Review the final diff for fabricated data, API/route regressions, security/version regressions, and unrelated changes. No commit or deploy is authorized by this contract.
