# FrameForge knowledge contract

Read `index.md` first. This project vault is distinct from private runtime episode data.

1. Keep `raw/` immutable. Correct mistakes through a new source or a wiki note, never by rewriting a capture.
2. Public captures must omit account addresses, tokens, session IDs and private media. Label excerpts and redactions; never present an excerpt as a complete transcript.
3. Each ingest adds a source summary, related concept/entity links, an index entry and a chronological log entry.
4. Every `wiki/**/*.md` atom has OKF v0.1 `type`, `title`, `description`, and an observation/update `timestamp`. Types here are Source, Concept, Entity and Report.
5. Use wiki links for navigation and relative Markdown citations to raw captures or code. State observed facts separately from intended contracts and inference.
6. File durable answers into `wiki/queries/` or `wiki/reports/`. Do not turn a test plan into a test result.
7. Lint broken links, orphans and required paths; review stale claims and contradictions separately. Update `index.md` and `log.md` after a lint pass.
