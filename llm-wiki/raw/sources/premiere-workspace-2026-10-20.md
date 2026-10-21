# Aside public Adobe research synthesis capture

Observed: 2026-10-20T17:07:33.999065+00:00

This capture is the delegated agent's final public-source synthesis, not a complete browsing transcript or an independent parent verification of every linked page. Ephemeral citation handles were removed; no account addresses, credentials, session IDs or private media are included. The agent reported 12 inspected pages and supplied 14 references. Research recommendations are not implementation or deployment evidence.

## Adobe observations

I inspected 12 public Adobe Premiere Help pages in the Aside browser.

- Premiere offers task-oriented workspaces, including vertical video, assembly, review, and production. Users can customize and save layouts, and panels resize to fit the window. Docking zones resize neighboring groups; grouping zones let panels stack or share tabs. Adobe uses flexible, task-based panel layouts rather than one fixed screen.
- The Source Monitor is for an individual clip; the Program Monitor shows the active sequence from the Timeline. The Timeline separates the time ruler, playhead/timecode, work area, and zoom/scroll controls. The work area can define a preview or export range. Monitor and timeline controls make source, sequence, and navigation state distinct.
- The Properties panel changes with the selection, surfaces common controls, and supports shared edits across multiple selected clips. Mixed values are shown distinctly. The inspector is contextual, not a generic settings drawer.
- Keyboard navigation includes panel cycling and visible focus. Adobe also documents limits: some panels and editing actions are not keyboard-accessible, and screen-reader support is limited. Treat Adobe’s workflow as a useful pattern, not an accessibility bar to copy.
- Export involves choosing the sequence, destination, filename/location, format and preset, with a preview to scrub. Direct export and a separate Media Encoder queue are both supported. Export is a deliberate output step with settings and destination.
- Frame.io review supports frame-specific comments and annotations. Comments can be tied back to the exact timeline frame; the Adobe guide also notes that its legacy panel is not compatible with Frame.io V4. Review is linked to versions and frames, with a version-specific integration caveat.

## 8 prioritized recommendations

1. **P0: Keep the supplied sage/white shell.** Preserve the platform/channel rail, breadcrumb, work tabs, flow canvas, stage cards, insert-stage popup, and visible skipped route. Borrow Premiere’s task-oriented layouts as **Create, Review, Deliver** views or saved panel arrangements, not as a dark visual skin.
2. **P0: Establish a monitor-over-timeline hierarchy.** Give the preview the main visual area and place the timeline or sequence scrubber below it in edit mode. Distinguish a selected stage/source preview from the active run’s final/program preview. Keep playhead/timecode separate from timeline zoom and pan. This adapts Premiere’s monitor roles without turning the DAG into a linear edit timeline.
3. **P0: Make the right inspector selection-driven.** Selecting a stage, clip, or artifact should show only its relevant properties and actions. Put common controls first, advanced settings behind disclosure, and show mixed values clearly for multi-select. Keep edits undoable.
4. **P0: Make the DAG legible at a glance.** Stage cards should show status, inputs/outputs, dependencies, latest artifact, and run time. Selecting a card should focus the corresponding preview and inspector. Keep dependency edges visible while panels open.
5. **P1: Make “Insert stage” a safe planning point.** Show compatible stages, required inputs, and downstream effects before insertion. Confirm the change, provide undo, and avoid silently rerunning dependent stages.
6. **P1: Preserve the skipped route as meaningful state.** Show why a route was skipped and distinguish skipped from blocked, failed, stale, or incomplete. Keep its connections visible and offer an explicit resume/enable action.
7. **P1: Keep review and export local-first.** Default to local render and local output. Before writing or sharing, show the chosen run, destination, filename, format/preset, and any overwrite or upload consequence. Treat upload/review-link creation as a separate, explicit external-sharing confirmation. Keep comments timestamped and associated with a specific output version.
8. **P1: Reflow panels without losing workflow context.** On narrower screens, collapse the channel rail and inspector into accessible drawers; keep work tabs reachable, make the canvas pan/zoom, and stack preview and timeline rather than shrinking both to unusable sizes. Ensure keyboard focus, screen-reader labels, non-color status cues, and adequate contrast. Make drag operations optional, not the only way to navigate or edit.

**Tradeoffs:** Docked panels and a large preview suit desktop; drawers and stacked views suit smaller screens but add navigation steps. A compact timeline is useful on mobile, but detailed edits may need a dedicated expanded view. Local-first defaults protect privacy, while any external review or publishing flow needs a clear destination and affirmative confirmation.

## Exact source URLs

1. [Premiere workspaces and home screen overview](https://helpx.adobe.com/premiere/desktop/get-started/tour-the-workspace/what-are-workspaces.html)
2. [Dock, group, or undock panels](https://helpx.adobe.com/premiere/desktop/get-started/tour-the-workspace/dock-group-undock-panels.html)
3. [Navigate panels](https://helpx.adobe.com/premiere/desktop/get-started/tour-the-workspace/navigate-the-panels.html)
4. [Source and Program Monitor overview](https://helpx.adobe.com/premiere/desktop/get-started/source-and-program-monitor-adjustments/about-source-monitor-and-program-monitor.html)
5. [Timeline navigation controls](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/navigation-controls-in-the-timeline.html)
6. [Properties panel](https://helpx.adobe.com/premiere/desktop/add-text-images/stylize-text/about-properties-panel.html)
7. [Navigate Premiere using the keyboard](https://helpx.adobe.com/premiere/desktop/get-started/set-up-accessibility-features/navigate-premiere-using-the-keyboard.html)
8. [Screen reader and accessibility support](https://helpx.adobe.com/premiere/desktop/get-started/set-up-accessibility-features/screen-reader-screen-magnifier-and-operating-system-accessibility-support.html)
9. [Export video](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-video.html)
10. [Export options in Premiere](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-options-in-premiere.html)
11. [Export settings reference](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/overview-of-export-settings.html)
12. [Share for review with Frame.io](https://helpx.adobe.com/premiere/desktop/collaborate-with-others/share-for-review-using-frame-io/share-for-review-with-frame-io.html)
13. [Add comments on shared projects](https://helpx.adobe.com/premiere/desktop/collaborate-with-others/share-for-review-using-frame-io/add-comments-on-shared-projects.html)
14. [Export directly to Adobe Media Encoder](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-directly-to-adobe-media-encoder.html)

**Jev boundary:** The assigned profile was active. I ran one manual advisory review without changing its configuration or including credentials. It returned `proposal_only`; the backend tier was unvalidated, and its evidence-support check was below the stated threshold. Do not treat that result as approval or independent confirmation. The profile’s integrated review setting was off, and I did not reconfigure it.
