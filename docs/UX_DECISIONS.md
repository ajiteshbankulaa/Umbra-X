# UX & Visual Design Decisions — Umbra-X (Phase 3)

## 1. Visual Language & Editorial Restraint

Umbra-X uses a dark-first Swiss International Typographic editorial system defined in [`web/src/planner/tokens.css`](../web/src/planner/tokens.css) and [`web/src/planner/planner.css`](../web/src/planner/planner.css):

- **Void & Graphite Hierarchy:** Layered matte surfaces (`#07080b`, `#0e1014`, `#15181e`, `#1c2028`) paired with calibrated hairline rules (`rgba(236, 235, 230, 0.09)` to `0.34`), monochrome off-white typography (`#ecebe6`, `#c5c8ce`, `#8e949f`), and purposeful semantic accents (`--solar-ink: #ffc36d`, `--earth-ink: #8ec9ff`, `--good-ink: #34d399`, `--danger-ink: #f87171`).
- **No Decorative Fabrication:** Every readout maps directly to computed physical quantities (solar disk fraction, DEM elevation horizon, `°` terrain slope, `h` blackout windows, `kg` battery sizing, `fnv1a128` verification digest). Zero decorative gauges, synthetic telemetry animations, or ungrounded AI metrics are rendered.
- **Typographic Pairing:** `Instrument Serif` display titles (`clamp(26px, 2.5vw, 35px)`) for editorial clarity, `Plus Jakarta Sans` UI copy, and `JetBrains Mono` (`tabular-nums`) for engineering timestamps, coordinates, and constraint deltas.

---

## 2. Information Architecture: `Mission → Disruption → Consequence → Recovery → Evidence`

Instead of burying the central scientific problem inside multi-tab analytics widgets, [`web/src/planner/Planner.tsx`](../web/src/planner/Planner.tsx) organizes the primary workspace around a visible 5-stage narrative bar (`<nav className="narrative-bar" aria-label="Mission recovery workflow sequence">`):

| Stage | Purpose | Trigger / Workspace Action |
| --- | --- | --- |
| **01 Mission** | Baseline pad & operational limits | Focuses baseline Shackleton Pad #481 scenario & limits drawer |
| **02 Disruption** | Schedule or hardware shift | Applies or edits the +48h launch delay (`14 → 16 Nov`) or constraint change |
| **03 Consequence** | Constraint diff & physics | Scrolls to the Verdict Strip & 4-card trade-off deltas + 3D sky view |
| **04 Recovery** | Pareto frontier search | Opens `Decision` tab and runs/inspects the Rust/WASM 2,883-pad recovery frontier |
| **05 Evidence** | NASA data & certificate | Inspects `umbra-x-decision-certificate.json` or opens `Methods` provenance ledger |

A dedicated **`+48h Recovery Story`** quick action next to the study selector lets reviewers (and Space Apps judges within 30 seconds) immediately execute the complete baseline-to-recovery flow on Shackleton Ridge (`Pad #481` → `+48h` → `Pad #479`).

---

## 3. Mode-Differentiated Experience (`Planner` / `Learner` + `Minimal` / `Moderate` / `Detailed`)

The sidebar mode and verbosity controls (`ScenarioBar.tsx` + `TelemetryPanel.tsx`) adapt language and visible density on an Uncodixify neo-brutalist flat charcoal UI (`#0f0f0f`/`#161616` + `#00d4aa`, `1px` borders, max `4px` radius, zero gradients) without duplicating codebases:

- **`Planner`:** Exposes mission constraints (`48h` dark, `72h` Earth, `5°` slope, `80 kg` payload), `+48h Launch Delay` study presets, counterfactual diffs, `Recover Pads` Pareto frontier + JSON Decision Certificate download, `Power & Cost` budget sizing, and `Methods & Data` provenance.
- **`Learner`:** Frames polar geometry and south-pole insolation concepts (*compare equatorial Apollo 11 vs. polar Shackleton lighting; scrub MET timeline to inspect horizon obstruction; plain-language axial-tilt guide*) over the same live DE440/LOLA state.
- **`Minimal` / `Moderate` / `Detailed` Verbosity:** Condenses secondary telemetry and technical readouts cleanly, paired with lazy-loaded LOLA `80°S–90°S` 3D relief (`IntroOverlay.tsx` + `IntroScene.tsx`) and 7 terrain overlays (`relief`, `viable`, `illumination`, `earth`, `solar_hours`, `slope`, `psr`).

---

## 4. 3D Scene Synchronization, Readouts & WebGL Fallback

In [`web/src/planner/SkyScene.tsx`](../web/src/planner/SkyScene.tsx):

- **Aligned Dual-Clock Toolbar:** `.sky-toolbar-meta` pairs Mission Elapsed Time (`MET +0.0h`) with the scenario's active UTC clock (`2026-11-14 00:00 UTC`) so scrubbing time or switching Baseline vs. Alternative updates both readouts cleanly.
- **Observer Pad Marker (`orbit` mode):** Displays an observer mast column, beacon ring, and `"Observer Pad #<node+1> · <mast>m mast"` marker anchored directly on the DEM surface so pad relocation (`#481 → #479`) registers visually in 3D orbit space.
- **Graceful 2D SVG Horizon Fallback:** `hasWebGLContext()` + `WebGLErrorBoundary` render `WebGLFallbackHorizon`—a `0–360°` azimuth/elevation SVG skyline plot with solar disk, Earth marker, horizon silhouette, and obstruction margin—if WebGL initialization fails or is disabled in headless/restricted browsers.

---

## 5. Accessibility, Keyboard Navigation & Mobile Design

Implemented in [`web/src/planner/Planner.tsx`](../web/src/planner/Planner.tsx) and [`web/src/planner/planner.css`](../web/src/planner/planner.css):

- **Semantic Landmarks & Skip Navigation:** `<header>`, dual `<nav>` regions (`Audience` and `Mission recovery workflow sequence`), and `<main id="main-workspace">` preceded by `.mission a.skip-link` (`background: #ffc36d`, `#05070c` ink, `#ffffff` focus border, appearing at `(10px, 8px)` on keyboard `Tab`).
- **Focus & Motion:** High-contrast `:focus-visible` `2px` outlines across buttons, `<select>`, `<input>`, and range sliders; `@media (prefers-reduced-motion: reduce)` collapses transitions/animations to `0.01ms`.
- **Responsive Breakpoints (`1440×900`, `820×1180`, `390×844`):**
  - **Desktop (`1440×900`):** Two-column `.mission-workspace` keeping the 3D Terrain Plate on the left alongside the Verdict + Decision/Pareto rail on the right.
  - **Tablet (`max-width: 960px`):** `.narrative-bar` wraps to 3+2 columns; `.comparison-strip`, `.scenario-grid`, and `.countdowns` stack vertically cleanly with `0` horizontal overflow.
  - **Mobile (`max-width: 720px`):** Sticky `.mobile-bar` (`01 Base` / `02 Alt` / `Edit`), horizontal swipeable preset pills, `.narrative-bar` 2-column grid, stacked lanes, and enforced `min-height: 38px` (`44px` on `pointer: coarse`) across interactive buttons, tabs, and selects (preserving thin `.lane-track button.outage/.available` range track segments).

---

## 6. Live Browser Inspection Findings & Verified Fixes

Direct browser inspection (`http://127.0.0.1:4173/`) caught four real UI defects in the initial Phase 3 build, all fixed and re-verified on live screenshots:

1. **Duplicate `"UTC UTC"` label:** `.sky-utc` appended `UTC` after `utc(...)` which already returned `"UTC"`. Fixed in [`TelemetryPanel.tsx`](../web/src/planner/TelemetryPanel.tsx) (`MET +0.0h · 2026-11-14 00:00 UTC`).
2. **Low-contrast Skip Link:** Base rule `.mission a` (`color: var(--earth-ink)`) out-sorted `.skip-link` specificity, creating pale blue text on light background. Fixed via `.mission a.skip-link` (`#05070c` dark ink on `#ffc36d` amber fill with `2px solid #ffffff` outline).
3. **Tablet (`820×1180`) Horizontal Overflow:** Initial check measured `scrollWidth = 1425px` (`+605px` overflow). Fixed by adding `html:has(.mission)` / `.mission` clip constraints, `max-width: 100% !important` on `.sky-stage canvas`, and stacking `.comparison-strip` + `.countdowns` under `@media (max-width: 960px)`. Re-test confirmed `scrollWidth = 805px <= 820px` (`0` overflowing elements).
4. **Mobile (`390×844`) Control Sizing & Specificity:** Initial mobile audit measured small 22–28px buttons because `.mission button` (`min-height: 30px`) and class specificity (`inline-shift-btn`, `mobile-switch button`) prevented `display: none` and `min-height: 38px` from taking effect. Fixed CSS specificity and verified `43/43` visible mobile buttons/selects (excluding `.lane-track` bar segments) measure `>= 38.0px` (`0` console/page errors, `scrollWidth = 375px <= 390px`).

---

## 7. Usability Evaluation Status

- Formal 5-participant human evaluation protocol (`T1–T5` scripted tasks across technical and lay roles) is specified in [`docs/USABILITY_PROTOCOL.md`](./USABILITY_PROTOCOL.md).
- **Current empirical human test count:** **0 participants observed (`Results: Pending`)**. No task completion times or satisfaction scores are claimed until human sessions are conducted.
