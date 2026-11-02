# FRAME editing workspace

FrameForge keeps the supplied sage/white FRAME direction and borrows Premiere's **task-oriented panel hierarchy**, not its complete feature set or a dark skin. The source-backed [research report](../llm-wiki/wiki/reports/premiere-workspace-2026-10-20.md) separates Adobe observations, design inferences and implemented behavior.

## Blog operations — 2026-10-25

The sidebar's `/blog.html` is a separate multi-blog workspace, not a replacement video editor. Use the Korean [blog workflow runbook](blog-workflow.md) for canonical source conflicts, five account tabs, Jev prerequisites, version-bound owner/Git approvals, draft-only scheduling and pending verification. Public destination discovery is not login, publication or deployment proof; existing video behavior remains unchanged.

## Single node workbench — 2026-10-25 authoring target 1.7.0

The selected project's node canvas is the sole default workbench. Open Studio scene editing, source/rights, review/delivery, results, history, settings and other tools as native dialog overlays from the visible project/tool menus. Implementation reuses the API-backed `public/app.js`, `public/workflow.js`, `public/production-tools.js` and shared presentation primitives; keep one live scene inspector and unique control IDs. The historical 1.6 A/B contract and the older dated design/verification sections below are not instructions for the current shell or renewed deployment claims. Authoring 1.7.0 becomes selected only when Main completes its gates and promotes the immutable bundle.

Opening menus, tooltips and overlays or switching project/channel/stage performs no save, render, narration, generation or upload. Complete independent episode and graph drafts retain stable selections, saved baselines, original base versions and dirty/revision state, including hidden stashes in `beforeunload`. Closing an overlay preserves its draft; returning never silently rebases it. Ctrl/Command+S saves only the active scene editor or graph owner. An explicit stale save retains the draft and returns 409. Native-dialog close/focus and queued scroll callbacks must belong to the current overlay; older callbacks cannot dismiss a replacement or steal its focus.

Use right-click, Shift+F10, the context-menu key or the touch-accessible more button on the intended target. Shared menus clamp to the viewport, explain disabled actions and support keyboard dismissal/focus restoration; tooltips support hover, focus and touch. Node settings/results/connections/history use that exact node ID. Confirmed node removal changes only that draft node and its incident edges; exact-edge unlink changes only the named edge. No automatic reconnection, media/history deletion or server save occurs. Undo/Redo restores draft edits, the final node is protected, and validation plus explicit expected-version Save is required after repairing disconnected drafts.

The scene overlay resolves the invoked node's explicit stable `sceneId` and optional `slotId` in the same owned episode. A missing or mismatched target fails rather than opening a similarly positioned scene; an unbound node keeps the project's existing scene selection. Role, node order and coordinates never infer a scene. Async source/upload/tool reads capture target identities and revisions before awaiting and reconcile only a matching clean active draft. Late results cannot switch projects, mutate hidden/dirty stashes or attach a deleted slot's media to its scene fallback; superseded tool reads are discarded. Mount/destroy uses only sanitized local GET reads, no provider/model search or writes. Unknown origin, audience and AI disclosure stay unanswered.

Project removal is **archive**, with a separate confirmation and authenticated same-origin admin `POST /api/episodes/:id/archive`; restore uses `POST /api/episodes/:id/unarchive`. Both accept only a positive safe-integer `expectedVersion`. Opening/canceling confirmation writes nothing. Confirmed actions append versions/history while retaining the same project, scenes, workflow, media, runs and approvals. Active production jobs and in-flight provider/browser/quote preflights block archive. Archived projects leave the active list and reject editing/effects until restored; retained history/media and cached browser inspection stay readable. Restore returns the same project to draft at a new version, not renewed generation or publication consent.

`createWorkflowEditor` retains its existing lifecycle/load/save/html/hasChanges/openGeneration interface. Its read-only `bindProject({episodeId,channelId})` and `getContext()` expose exact workflow/version/episode/channel/selected-node/run/review/render identities and optional snapshots; unowned or ambiguous identities are null. Multiple supported role instances use distinct node IDs within a 128-node/256-edge connected DAG. Actual edges determine deterministic topological execution, with lexical node-ID ties and nearest same-role prerequisite boundaries through intermediate roles. Missing/ambiguous required input rejects; `selectedStages`/`startStage` are node-ID-only. Canvas labels/order do not define execution semantics or imply specialist-agent invocation.

Native login first refreshes authenticated state, awaits workflow loading, then binds the exact selected project and renders; loading/error UI remains until that sequence succeeds, and superseded initialization responses are discarded. Verify the project's actual saved nodes/edges, not a newer or first matching graph. A project without an owned workflow legitimately shows an empty canvas with existing template-to-project-copy guidance. Selecting and explicitly copying a template creates an independent owned graph; opening the empty workbench never fabricates or auto-saves one.

Reusable blueprints instantiate fresh independently versioned project-owned workflows, preserving immutable template ID/version and exact episode/channel ownership. Graph/config edits affect that project alone; copies retain no run/job/session/paid/publication authority. Template updates create explicit new versions; importing later changes into diverged projects remains explicit, not automatic. Preserve existing channel styling, captions/layout, shared tokens, keyboard/focus and responsive source/rights/approval state.

Source search is Commons discovery, not permission. Import supported JPEG/PNG or WebM originals into physically probed/hash-verified local uploads, then record explicit rights/source/attribution/retrieval/trim history. Public article/RSS/og:image thumbnails need their own clearance. With no cleared visual, retain the selected story in an original text-only title card; invent no image license and trigger no paid call. Required actual scene/slot credits appear legibly in the render and in the final server description. Repeated scene-specific generation nodes need a combined exact-input quote, separate persistent jobs, human disclosure and no-replay recovery. Stable `sceneId` is preferred; legacy `sceneIndex` remains accepted.

Technical candidate review, generation consent and owner final publication approval are separate. Review is branch-specific by mandatory `reviewNodeId` and connected render/hash, stored in `run.reviews`, with no new `run.review` alias. Current workflow publish output is local staging with publication not attempted. The publication UI prepares a server approval without provider traffic, displays its complete fingerprinted manifest/final description/credits, then publishes only that ID after `최종 승인하고 공개`. Field/episode changes invalidate preview. Channel-bound OAuth drives private upload, verification, same-video public update and final public readback; only that readback completes delivery. Uncertain results reconcile the saved session/video identity without duplicate insert. Studio is a manual handoff and automated YouTube controls are disabled. Credentials and opaque upload URLs stay in encrypted private runtime files, outside browser state/history/knowledge/logs.

For news, a nonempty explicit `query` wins unchanged over episode title/topic, connected trends and supplemental keywords. Only an empty/omitted query derives context. Requested Google News RSS errors or a response with no verified articles fail explicitly, with no sample or cached-article success. News-only collection preserves the saved episode and starts no quote, paid generation, render or publication. The real current-news exercise uses 국민연금공단, two publishers and official NPS guidance to distinguish a proposal from enacted policy, followed by original text cards, installed SAPI narration, local MP4 and `awaiting_review`. This is source-only candidate evidence, not creative acceptance, paid generation or final public approval; final counts and the Docker cutover require their own receipts.

The forthcoming [sanitized node-workbench receipt](../artifacts/node-native-workbench/verification.json) will record Main's exact stable-source commands/results, source/artifact hashes, preserved failures and remaining prerequisites. Current focused commands are `node --test tests/node-workbench.test.mjs` and `node --test tests/project-archive.test.mjs tests/news-query.test.mjs`, with the recorded local browser module/executable environment. The [1.6 receipt](../artifacts/production-workspace-implementation/verification.json) and [former browser journey](../artifacts/production-workspace-implementation/journey-receipt.json) remain historical. Application tests use explicit `loginToken:''`, `publicOrigin:''`, temporary DBs/ephemeral ports and fixture-only external transport. They do not prove live generation, account authorization, public delivery or Docker cutover. See [the harness contract](harness.md) and [promotion gates](harness-versioning.md).

## Focused project-discovery UX update — 2026-11-03

The project workbench identifies the selected project by its stable ID as well as its title; the selected sidebar entry is marked current. Direct **결과 보기** and **프로젝트 기록** actions open the selected project's export results and version history. These remain distinct from workflow run history and from the separate **검토 · 공개** surface. Opening these destinations or switching projects does not save a draft, render, generate media, or publish. Unsaved scene drafts remain attached to their project while switching away and back.

At narrow widths, the project actions wrap rather than requiring horizontal scrolling. The mobile workflow graph presents connected-stage relationships in its stacked node list with keyboard-operable links to the related node. The relationship summary is improved; graph execution semantics remain unchanged. Source discovery is not a rights grant; generation consent, technical review, and owner publication approval remain separate gates. No source permission or publication readiness is inferred from a visible result.

**Isolated verification:** `project-navigation-discovery.test.mjs` passed 1/1 in disposable Chromium at 1440×844 and 390×844, covering project identity, direct results/history/review entry, keyboard focus, and unsaved scene-draft preservation; it observed no page writes and blocked external/provider traffic. The responsible agent also reported `workflow-ux-mobile-history.test.mjs` passed for 390px connected-stage summaries and keyboard navigation, direct results/run-history entry, project-scoped result/history behavior, and review/publish dialog boundaries. `workflow-run-history-scope.test.mjs` was reported passed for project/channel filtering, pagination, scoped detail access, legacy response compatibility, and compact history records that omit result payloads. These are isolated fixture checks only; no full-suite, production database, deployment, paid generation, or publication check is established.

## Historical original design-system packet — 2026-10-20

**Scope:** the existing eight application views, channel navigation, Studio editing and workflow design. Shared controls remain dependency-free HTML/CSS and the existing delegated actions; no parallel component framework or backend was introduced.

- **Foundations:** existing semantic CSS tokens now use a sage canvas, white panels, green selection/focus and compact rectangular controls. System Korean-capable fonts remain local; the supplied mock's Google Fonts requests were not added. Existing warning/error/success meanings, visible focus and reduced-motion rules remain intact.
- **Primitives:** reuse `.panel`, `.panel-header`, `.primary`, `.badge`, native buttons, disclosures and dialogs. Scene and channel IDs remain identities; display titles never become keys.
- **Surface hierarchy:** the left rail groups actual registered channels by platform. A single top task navigation changes application views. The Studio has a real scene project bin, sequence preview/program monitor, the existing selection-driven scene inspector, and a timeline below the preview. Workflow design gains section navigation, stage numbering and a blueprint grid while retaining its existing focused inspector dialogs.
- **Responsive behavior:** desktop can dock the project bin beside the monitor; narrower working windows place the bin above it with local scrolling. Mobile uses a non-sticky platform chooser with native disclosures, and the task bar scrolls independently. Existing workspace presets, custom sizes and overlay tools remain available.
- **Accessibility baseline:** native controls retain keyboard operation. Scene selection restores focus after rerender; task/channel navigation focuses the new main content. Workflow history links open their real disclosure and focus its summary. Essential contrast pairs are measured by the existing operational browser gate; status is also expressed in text.
- **Ownership:** shared visual rules stay in `public/styles.css`; workflow-specific presentation stays in `public/workflow.css`; shell breakpoint behavior stays in `public/workspace.css`. Feature behavior stays in the existing application/workflow modules.

## Historical original implemented behavior and limits — 2026-10-20

The project bin and timeline select the same persisted scene identity and synchronize the preview and inspector. Unsaved inspector title edits immediately update the bin. Timeline start times and lengths derive from real scene durations; audio labels say whether an audio file is attached. These labels are **not** independent audio/video tracks, generated waveforms, or a frame-accurate NLE.

The browser monitor is the existing sequence/scene preview, not proof of the final rendered MP4. Existing preview/final-caption differences remain possible. Local MP4 export and exact-version/hash human review remain separate from external publication.

Workflow section links opened existing execution history, version history and review output. Stored-list numbering was an orientation aid; edges defined execution dependencies. Adding a node used supported types, validation, draft undo and explicit save. That 2026-10-20 change did not add arbitrary AI tasks, conditional branching, scheduling or skip/bypass semantics. Its lack of automated YouTube publication is a historical limit; the current separate approval/API delivery contract is described above. Recorded `skipped` statuses remain distinct from skip/bypass controls.

All existing expected-version, administrator, generation quote/consent and immutable-history boundaries remain in place. Navigation itself starts no render, narration or paid generation.

## Historical observed verification — 2026-10-20

| Gate | Actual result | Boundary |
| --- | --- | --- |
| `npm run check` | 65 modules passed in the candidate image. | Source syntax, not UI behavior. |
| `npm test` | 283 passed, zero failed/skipped in isolated Linux Docker. | Includes three new workflow-navigation regressions. |
| `npm run test:render` | Actual 1080×1920 H.264/AAC output, 2 seconds. | Disposable container; no production media. |
| New workspace browser gate | 72 checks passed; zero page errors. | Disposable API fixtures; all eight views at 1600/1440/1024/768/375/320px; keyboard focus, scene identity, save/versioning, insertion dialogs and mobile channel selection. |
| Existing operational browser gate | 105 checks passed, including contrast, admin/read-only presentation, histories and responsive reflow. | Separate disposable fixtures; no external/provider execution. |
| Docker refresh | Production container recreated, healthy, read-only root, existing volume retained; 57 runtime files match checkout. | The deployed image is bound by source hashes, not a newly created Git commit. |
| Data preservation | SQLite integrity `ok`; entity IDs, episode/workflow versions, table counts and 22 media hashes unchanged. | Verified against a fresh consistent private pre-update snapshot. |
| Private Tailscale HTTPS | Authenticated Windows-host browser displayed the new bin/monitor/workflow UI; unauthenticated state returned 401; Secure/HttpOnly/SameSite=Strict cookie verified. | Existing Serve proxy stayed on loopback 4310; no client upgrade, Funnel, public sharing or independent remote-device test. |

Node's SQLite experimental-API warning remains visible. Git also reports CRLF-to-LF normalization on affected tracked files; neither warning was suppressed. The guarded launcher reported the bridge and Aside inbox already running; they were not restarted.

Receipts: [browser and contrast evidence](../artifacts/premiere-workspace-browser.json), [Docker/data/HTTPS evidence](../artifacts/premiere-workspace-deployment.json), [research/tooling boundaries](../artifacts/premiere-workspace-research.json). The six [screenshots](assets/premiere-workspace/) contain only disposable fixtures, never private production media.

## Historical verification and rollout procedure

The commands and rollout below document the earlier release only; they are not entrypoints for the current node-workbench gate above. Documentation alignment runs no suites, browser/provider scripts, production operations, deployment or Git commands. Main owns scoped isolated verification and eventual bundle promotion; these historical receipts cannot satisfy its new final gates.

Run from the repository root with Node 22.13+ and the existing local Playwright/Chromium installation:

```text
npm run check
npm test
npm run test:render
node scripts/premiere-workspace-browser-smoke.mjs
node scripts/ops-workspace-browser-smoke.mjs
```

The browser scripts use an OS-temporary database and remove it in `finally`. `OPS_PLAYWRIGHT_MODULE` can select an already installed Playwright module; the scripts do not install dependencies or download browsers. Evidence is printed as an OS-temporary directory path. They block HTTP egress and provider execution and never use port 4310 or the production database.

For production, follow [Docker operations](docker-operations.md): check for active jobs, retain the current image, take a new no-overwrite snapshot as the volume owner, test a candidate without the production volume, and use `scripts/start-docker.ps1`. Verify runtime hashes and the private HTTPS route after replacement. Reusing the same Tailscale Serve proxy is sufficient when its loopback backend is unchanged; do not reset Serve or enable Funnel merely to deploy UI assets.

The latest private snapshot path and rollback tag are in the deployment receipt. Image rollback preserves the named volume and does not undo later database edits. Git commit, push and pull remain separately authorized operations; these local verification and deployment receipts do not claim that a new commit was published.

## Historical knowledge/graph verification boundary — 2026-10-20

MEX source refresh and context checks passed with no drift. Graphify's existing refresh path now removes checkout-local agent state and generated vault metadata before normalization/export; four offline regression tests cover exact-edge normalization, incident/local-origin edge removal, Windows paths and idempotence. This prevents local helper copies from entering the canonical structural graph.

The **full wiki checks did not pass**. The generic linter reports existing raw-capture wiki links even when their target files exist, because it excludes `raw/` from resolution, and flags a generated vault graph report as orphaned. The existing project validator additionally reports pre-existing auto-capture/schema issues. No capture, validator or assertion was rewritten/excluded to manufacture a passing wiki result. The new source/report navigation and citations were checked separately without replacing those failing full-vault diagnostics. See [knowledge verification](../artifacts/premiere-workspace-knowledge.json).
