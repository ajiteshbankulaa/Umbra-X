# Reproducible Usability Evaluation Protocol (5 Participants)

**Status:** Protocol ready to execute; **0 human participants tested to date (`Results: Unavailable / Pending`).** No usability outcome is claimed or extrapolated in advance of actual testing.

## 1. Study Goal & Target Sample

Evaluate whether diverse reviewers — spanning mission/technical and non-technical backgrounds — can understand Umbra-X's counterfactual launch-delay story, interpret constraint consequences, discover a viable alternative, and recognize explicit model boundaries within 2 minutes per core task without coaching.

- **Sample (`N = 5` consenting adults):**
  - `P1`: Aerospace / astrodynamics engineer or graduate student (`Planner` mode, `Detailed` verbosity)
  - `P2`: Systems / mechanical / electrical software engineer (`Planner` mode, `Moderate` verbosity)
  - `P3`: STEM educator / science communicator (`Learner` mode, `Moderate` verbosity)
  - `P4`: General technical designer or data analyst (`Planner` / `Learner` toggle)
  - `P5`: Non-technical lay participant with no space-mission training (`Learner` mode, `Minimal` verbosity)
- **Consent & Ethics:** Verbal/written informed consent recorded prior to session; no PII published in metrics table; participants may stop at any time.
- **Environment:** Live built application served locally or over HTTPS (`1440×900` desktop for `P1–P4`; include `390×844` mobile check for at least 2 participants). Unmoderated timing per task with think-aloud notes captured by facilitator.

## 2. Standardized 5-Task Test Script (No Coaching)

Initialize the app at default Shackleton Ridge comparison (`Pad #481`, `0h` vs `+48h` launch delay preset or baseline start).

| Task # | Prompt Given to Participant | Observable Success Criterion | Target Time |
| --- | --- | --- | --- |
| **T1** | *"Identify why the original landing scenario (`Baseline`, Pad #481 at 0 h) fails."* | Correctly names Earth blackout (`> 72 h`, `103.7 h`), low-light outage (`> 48 h`, `52.3 h` / `52.25 h`), and slope (`> 5°`, `5.60°`) | ≤ 60 s |
| **T2** | *"Apply or inspect a +48-hour launch delay on the Baseline pad (`14 -> 16 Nov`)."* | Uses `+48h` control, date picker, or `+48h Launch Delay` study preset to inspect shifted start | ≤ 45 s |
| **T3** | *"Explain what changed in the delayed scenario — did everything pass?"* | Reports that Earth outage improved sharply (`103.7 -> 55.7 h`, passing `≤ 72 h`), while low light (`52.3 h`) and slope (`5.60°`) still fail | ≤ 60 s |
| **T4** | *"Find a candidate landing alternative that recovers feasibility across lighting, Earth link, and slope."* | Opens `Recover Pads` (Pareto search) and selects a feasible candidate such as `Pad #301` or nearby `Pad #479` | ≤ 90 s |
| **T5** | *"Identify at least one physical limitation or unmodeled factor in the result."* | Points out an explicit boundary (`Not modeled`: boulders/craters `< 20 m`, RF link budget/DSN scheduling, LOLA/PGDA LDSM slope difference, PSR ice ground-truth, or `2σ` sensitivity) | ≤ 60 s |

**Technical Reproducibility Sub-Task (`P1` or `P2`):** Download `umbra-x-decision-certificate.json`, verify `deterministicFingerprint`, and record whether source metadata (SHA-256 `vectorHash`, `localHash`, LOLA `20 m + 80 m`, DE440) is sufficient for independent verification using JPL Horizons / GDAL.

## 3. Metrics & Results Ledger Template

Record verbatim results after real sessions only (`[ ] Completed`, elapsed seconds, exact correctness score `0/1`, and observed friction):

| Participant | Background | Viewport | Mode / Detail | T1 (s / pass) | T2 (s / pass) | T3 (s / pass) | T4 (s / pass) | T5 (s / pass) | Key Friction / Confusion Point |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `P1` | Unassigned | TBD | Planner / Detailed | — | — | — | — | — | *Pending execution (0 tested)* |
| `P2` | Unassigned | TBD | Planner / Moderate | — | — | — | — | — | *Pending execution (0 tested)* |
| `P3` | Unassigned | TBD | Learner / Moderate | — | — | — | — | — | *Pending execution (0 tested)* |
| `P4` | Unassigned | TBD | Planner / Learner | — | — | — | — | — | *Pending execution (0 tested)* |
| `P5` | Unassigned | TBD | Learner / Minimal | — | — | — | — | — | *Pending execution (0 tested)* |

## 4. Triage & Iteration Rule

Prioritize fixes strictly from observed participant failure/hesitation patterns using severity tiers:
- **P0 (Blocker):** Task failure (`>= 2/5` participants) or misinterpreting an infeasible/nominal-only scenario as fully certified. Fix immediately before submission lock.
- **P1 (Confusion):** Participant exceeds target time (`> 90 s`) or misreads units/labels. Simplify label hierarchy or progressive disclosure.
- **P2 (Polish):** Visual spacing, redundant clicks, or shortcut discoverability.
Re-run the affected task(s) on fresh testers after any P0/P1 UI change and archive before/after session logs.
