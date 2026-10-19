# FrameForge Studio — Design Contract

## 0. Research log

- **User-supplied static concept** — `C:\Users\bangg\AppData\Local\hermes\cache\scratch\frameforge-ops-concept\concept.png` at 1440×1040 and its editable `concept.html` were visually inspected. The screenshot establishes an operational, queue-first hierarchy, warm neutral surfaces, a single blue accent, concise status marks, an asymmetric main/rail composition, and a persistent navigation shell. Palette and font values below were extracted from the concept source CSS. Its people, tasks, dates, metrics, assets, bridge, backup, storage, and Tailscale status are fictional and are not product requirements or observed data.
- **Existing product source** — `public/index.html`, `public/styles.css`, `public/app.js`, `server/app.mjs`, `server/store.mjs`, `.mex/context/architecture.md`, and `.mex/context/decisions.md` were inspected. The real product is a local-first vanilla-JS editor with seven existing views, SQLite-backed entities, episode/workflow version history, render/generation/narration jobs, and integration/trend status. `/api/state` is the current aggregate read model. Preserve these workflows and use their actual records.
- **Design-data lookup (skipped)** — `omh design data --kind palette|font|ux --context dashboard` was attempted earlier but the `omh` executable was unavailable (exit 127); no curated rows were returned. The local candidate paths also contained no executable. Do not claim this contract is backed by that dataset.
- **Jev review (pre-implementation, advisory)** — a real default-profile review of the scoped proposal returned `proposal_only` on an `unvalidated` tier (jev-1.13.0); there was no source diff to review. Treat this as a warning, not permission or a code verdict.
- **Current rendered-product capture (observed after implementation)** — final overview, Studio, Workflow, and supporting views were captured after the last UI edit at 1440px, 768px, and 375px where applicable. The scoped evidence and screenshots are in `artifacts/ops-workspace/`; the browser run used isolated Korean fixtures, not production records. The final visual receipt reports 94/100 PASS with no listed differences.

## 1. Atmosphere & identity

- **Audience:** Korean-speaking producers who need to see what is being produced, inspect outputs and history, and understand the actual state of the local production system.
- **Primary task:** scan current production records, find the next item requiring attention, and open its existing editor or job detail without losing provenance.
- **Primary direction:** **Operational** — information density and trustworthy state over editorial drama. Borrow the concept's warm-neutral/blue visual signature only; do not copy its fictional project identity, wordmark, records, copy, or data model.
- **Reads as:** composed, traceable, dependable.
- **Signature:** a real-data work queue paired with a compact provenance/operations rail; every count links to records that produce it.
- **Scope:** add an operational overview to the current shared app shell and harmonize the existing Studio, Workflow, Trends, Templates, History, Knowledge, and Settings views. Keep all current editor and production actions intact. This is not a replacement product or a static mock.

## 2. Color

Use semantic tokens; components must not introduce one-off palette values. Approximate visual budget: 70% warm ground/surface, 25% text/borders/secondary surfaces, 5% accent and semantic status colors. Status is never conveyed by color alone. All text/surface pairs must meet WCAG 2.2 AA contrast (4.5:1 normal text, 3:1 large text and essential UI graphics); verify actual rendered pairs before claiming a pass.

| Token | Value | Role |
|---|---|---|
| `--canvas` | `#f5f4ef` | Main application ground |
| `--surface` | `#fffefa` | Primary content and panels |
| `--surface-side` | `#eeede6` | Navigation/support surface |
| `--surface-subtle` | `#f0f2e9` | Quiet inset, selected-neutral and callout surface |
| `--ink` | `#242c35` | Primary text |
| `--text-secondary` | `#46514f` | Secondary text; keep readable on both surfaces |
| `--muted` | `#606966` | Supporting copy only after contrast verification |
| `--line` | `#ddded5` | Dividers and subtle boundaries |
| `--line-strong` | `#858b82` | Inputs and controls requiring clear boundaries |
| `--accent` | `#2851c8` | Primary action, links, selected navigation |
| `--accent-soft` | `#e9eefc` | Accent selection/background |
| `--success` / `--success-soft` | `#326655` / `#edf3ed` | Confirmed completed/healthy state |
| `--warning` / `--warning-soft` | `#8a5b22` / `#fbf1df` | Attention state |
| `--danger` / `--danger-soft` | `#a34437` / `#faeee9` | Failed/destructive state |
| `--focus` | `#173ea8` | Dedicated high-contrast focus ring; never rely on the surface accent alone |

The supporting-copy token was darkened from concept #68706e to #606966 for AA contrast on the warm sidebar, and placeholders use this text token rather than a control-boundary token.

The control-boundary token was darkened from concept #a6aaa0 to #858b82 to meet the 3:1 essential-control contrast requirement. Existing editor preview media keeps authored content colors; UI chrome uses the semantic tokens. Legacy token names alias these values.

The listed concept values are starting values, not a contrast certification. Adjust a token in this contract if a measured pair fails; do not patch a single component with a non-contract color. Light theme only for this scope; no dark theme or component-level theme branches.

## 3. Typography

- **Typeface stack:** `"Segoe UI", "Pretendard", "Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`. No downloaded font or network dependency. Use one family stack for interface and data; distinguish hierarchy by size, weight, and spacing, not a second decorative face.
- **Scale:** page title 28–32px/1.25, section title 18–20px/1.35, card/row title 15–16px/1.45, Korean body 14px/1.6 minimum, compact metadata 12px/1.45 minimum, micro-label 10–11px/1.4 only for nonessential uppercase/metadata.
- **Weights:** 400 body, 550–600 labels and row titles, 650–700 primary headings/actions; avoid making every label bold.
- Use tabular numerals for counts, versions, durations, timestamps, and progress. Keep Korean word wrapping natural (`word-break: keep-all` for prose; `overflow-wrap: anywhere` for long IDs/URLs). Never clip a status, version, or CJK text without an accessible full-value route.

## 4. Spacing & layout

- **Base rhythm:** 4px; use 4, 8, 12, 16, 20, 24, 32, 40px. Panel radius 9px; control radius 5px; 1px dividers. Use no decorative framework grid or blanket card grid.
- **Large desktop (≥1280px):** persistent 188px navigation; 64px top bar; fluid content capped at 1600px. Overview uses a 12-column asymmetric composition: queue takes the primary 8–9 columns, provenance/operations rail 3–4 columns. Summary figures are derived from the same data as their destination lists. Avoid four equal KPI cards when the information weights differ.
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
- **Buttons/inputs:** default, hover, focus-visible, pressed, disabled, loading, and validation-error states. Button minimum height 40px; destructive actions remain secondary and explicit.
- **Badges/status:** text label plus shape/icon; semantic color pair from §2. Progress has an accessible label and current value. Avoid relying on tiny dots alone.
- **Tables/lists:** semantic headings/captions, keyboard-accessible sorting with `aria-sort`, stable row identity, empty/loading/error states, and explicit row action.
- **Dialogs/menus:** native `<dialog>` or existing accessible pattern; labelled, keyboard close/cancel, focus contained/restored, no hidden action on selection.
- **Loading/empty/error:** loading skeleton or status text reflects an actual in-flight request; empty means a successful empty result; error preserves prior data when safe and offers retry. Never replace an API failure with demo rows or fabricated success.

## 6. Motion & interaction

- Motion is limited to state transitions and feedback: 120–180ms ease-out for hover/selection, 160–220ms for opening/closing a dialog. No bounce, scroll hijacking, parallax, or auto-advancing content.
- Respect `prefers-reduced-motion: reduce` by removing nonessential transitions/animations. No new motion dependency.
- Focus, keyboard selection, filtering, sorting, pagination/scrolling, and dialog flows must work without a pointer. Do not steal focus during background polling or replace a focused editor field during refresh.

## 7. Depth & surface

- Flat surfaces with clear 1px boundaries establish hierarchy. No glass, blur, gradient, or shadow on every card. A single restrained shadow is allowed for modal/dialog elevation; the main page uses color and spacing, not elevation, to organize information.
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
