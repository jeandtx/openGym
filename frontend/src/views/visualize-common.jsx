// What the three Visualize screens share: names, the effort in the profile's own scale, one
// set's description for a tooltip, and the sheet that says what an estimated 1RM is.
import { EXIDX } from '../lib/exercises.js'
import { exerciseNameText, fmtNum } from '../lib/format.js'
import { t } from '../lib/i18n.js'
import { setLabel } from '../lib/history.js'
import { displayScale, scaleName, toScale } from '../lib/effort.js'
import { speedUnitOf } from '../lib/speed.js'
import { estimate1RM, formulaOf, FORMULA_NAMES } from '../lib/onerm.js'
import { useUI } from '../store/useUI.js'
import { clockOf } from '../components/VizCharts.jsx'

/** An exercise's name; one missing from the catalogue (deleted custom) reads from its entry. */
export function exerciseName(id, entry) {
  if (EXIDX[id]) return exerciseNameText(EXIDX[id])
  return entry?.muscleSnapshot?.n || entry?.n || t('Unknown exercise')
}

/** fmtEffort(rir) → "RPE 8.5" / "RIR 1.5", in whatever scale the profile reads. */
export function effortFormatter(S) {
  const kind = displayScale(S)
  return rir => (rir == null ? '–' : scaleName(kind) + ' ' + fmtNum(toScale(kind, rir)))
}

/** describe(lane, set) → "12:16:05 · Squat · Set 2 · 60×8 · RPE 8" */
export function setDescriber(S) {
  const fmtEffort = effortFormatter(S)
  const speed = speedUnitOf(S)
  return (lane, s) => [
    s.at != null ? clockOf(s.at, true) : null,
    exerciseName(lane.id, lane.entry),
    s.warm ? t('Warm-up') : t('Set {0}', s.n),
    setLabel(lane.id, s.row, lane.entry?.target || null, speed),
    s.rir != null ? fmtEffort(s.rir) : null,
  ].filter(Boolean).join(' · ')
}

// The explainer behind every ⓘ next to "Est. 1RM": what it is, worked out on one of your own sets
// when there is one, and why it is the number the trend follows.
function OneRmExplainer({ S, example }) {
  const formula = formulaOf(S)
  const ex = example && example.w > 0 && example.r > 0 ? example : { w: 60, r: 8 }
  const est = estimate1RM(ex.w, ex.r, formula)
  return <>
    <h3>{t('What is the estimated 1RM?')}</h3>
    <p className="small" style={{ lineHeight: 1.5 }}>{t('Your 1RM (one-rep max) is the heaviest weight you could lift for a single repetition.')}</p>
    <p className="small" style={{ lineHeight: 1.5 }}>{t('Nobody tests it every session: the app estimates it from your best set with a formula. The more reps you do at a weight, the higher the estimate.')}</p>
    {est != null && <div className="card" style={{ margin: '10px 0' }}>
      <div className="small muted">{example ? t('From your best set') : t('For example')}</div>
      <div style={{ fontWeight: 600, marginTop: 4 }}>{fmtNum(ex.w)} {S.unit} × {ex.r} → ≈ {fmtNum(Math.round(est * 10) / 10)} {S.unit}</div>
    </div>}
    <p className="small" style={{ lineHeight: 1.5 }}>{t('It puts the weight and the reps on one scale, so a heavier set with fewer reps and a lighter set with more reps can be compared. That is why the trend follows it.')}</p>
    <p className="small muted" style={{ lineHeight: 1.5 }}>{t('1RM formula')}: {FORMULA_NAMES[formula] || t('Blend of all')}</p>
  </>
}
export const oneRmSheet = (S, example) => useUI.getState().openSheet(() => <OneRmExplainer S={S} example={example} />)
