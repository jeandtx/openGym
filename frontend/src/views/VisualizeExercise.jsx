// One exercise across its sessions (Visualize → an exercise): where it stands, the change from the
// session before, which way the period is heading, the curve, and the sessions themselves drawn
// as the same bars the session page uses, side by side. Numbers from lib/exercise-evolution.js.
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { t, tn } from '../lib/i18n.js'
import { fmtDate, fmtNum, fmtVol } from '../lib/format.js'
import { EXIDX, isAssisted } from '../lib/exercises.js'
import { exerciseEvolution } from '../lib/exercise-evolution.js'
import { sessionView } from '../lib/session-view.js'
import { perSetSessions, perSetLines } from '../lib/per-set.js'
import { formulaOf } from '../lib/onerm.js'
import LineChart from '../components/LineChart.jsx'
import { SetBars, mmss } from '../components/VizCharts.jsx'
import { Button, Segmented } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import { exerciseName, effortFormatter, setDescriber, oneRmSheet } from './visualize-common.jsx'
import './Visualize.css'

const SET_COLORS = ['var(--blue)', 'var(--green)', 'var(--orange)', 'var(--purple)', 'var(--pink)']
const LAST = 10
const DAY = 86400000
const rangeOptions = () => [{ value: 'last', label: String(LAST) }, { value: 90, label: '3M' }, { value: 180, label: '6M' }, { value: 0, label: t('All') }]

export default function VisualizeExercise() {
  const nav = useNavigate()
  const { exId } = useParams()
  const S = useStore(s => s.S)
  const [range, setRange] = useState('last')
  const [curve, setCurve] = useState('key')
  const [shown, setShown] = useState(LAST)
  const formula = formulaOf(S)
  // Picked once per range, not per render, so the chart's points keep their identity.
  const since = useMemo(() => (typeof range === 'number' && range > 0 ? Date.now() - range * DAY : 0), [range])
  const ev = useMemo(() => exerciseEvolution(S, exId, { since, last: range === 'last' ? LAST : 0, formula }), [S.workouts, exId, since, range, formula])
  const lastEntry = useMemo(() => {
    for (let i = (S.workouts || []).length - 1; i >= 0; i--) {
      const en = (S.workouts[i].entries || []).find(e => e?.id === exId)
      if (en) return en
    }
    return null
  }, [S.workouts, exId])
  const name = exerciseName(exId, EXIDX[exId] ? null : lastEntry)
  const fmtEffort = effortFormatter(S)
  const describe = setDescriber(S)

  const key = ev.key
  const keyOf = s => (key === 'e1rm' ? s.e1rm : s.value)
  const unit = key === 'sec' ? 's' : key === 'min' ? t('min') : key === 'reps' ? t('reps') : S.unit
  const fmtKey = v => (v == null ? '–' : key === 'sec' ? mmss(v) : fmtNum(Math.round(v * 10) / 10) + ' ' + unit)
  const fmtDelta = (v, u = unit) => (v == null ? null : (v > 0 ? '+' : v < 0 ? '−' : '±') + (key === 'sec' && u === unit ? mmss(Math.abs(v)) : fmtNum(Math.round(Math.abs(v) * 10) / 10) + ' ' + u))
  const counted = ev.sessions.filter(s => !s.excluded && keyOf(s) != null && keyOf(s) > 0)
  const latest = counted.at(-1)

  // The curve: the tracking number, the volume, or one line per set number.
  const points = useMemo(() => counted.map(s => ({ t: s.t, d: s.d, y: keyOf(s), note: key === 'e1rm' && s.e1rmFrom ? fmtNum(s.e1rmFrom.w) + '×' + s.e1rmFrom.r : undefined })), [ev])
  const volPts = useMemo(() => ev.sessions.filter(s => !s.excluded && s.volume > 0).map(s => ({ t: s.t, d: s.d, y: Math.round(s.volume) })), [ev])
  const perSet = useMemo(() => {
    if (ev.mode !== 'reps') return null
    const ids = new Set(ev.sessions.filter(s => !s.excluded).map(s => s.id))
    const workouts = (S.workouts || []).filter(w => ids.has(w.id))
    const metric = key === 'e1rm' && !isAssisted(exId) ? 'e1rm' : 'reps'
    const sessions = perSetSessions(workouts, exId, { metric, formula })
    if (sessions.length < 2 || !sessions.some(s => s.sets.length >= 2)) return null
    const { lines } = perSetLines(sessions)
    return {
      metric,
      series: lines.map(l => ({ n: l.n, points: l.points, color: SET_COLORS[l.n - 1] })),
      anchors: sessions.map(s => ({ t: s.t, d: s.d, y: Math.max(...s.sets.map(x => x.y)), note: s.sets.map(x => x.n + ': ' + (metric === 'reps' ? x.r : fmtNum(x.w) + '×' + x.r)).join(' · ') })),
      ns: lines.map(l => l.n),
    }
  }, [ev, S.workouts, exId, key, formula])
  const curveOpts = [{ value: 'key', label: key === 'e1rm' ? t('Est. 1RM') : key === 'weight' ? t('Top set') : key === 'reps' ? t('Reps') : key === 'sec' ? t('Time') : t('Duration') }]
  if (volPts.length >= 2) curveOpts.push({ value: 'vol', label: t('Volume') })
  if (perSet) curveOpts.push({ value: 'sets', label: t('Per set') })
  const cur = curveOpts.some(o => o.value === curve) ? curve : 'key'

  // Each session as the same bars the session page draws, newest first.
  const cards = useMemo(() => {
    const byId = new Map((S.workouts || []).map(w => [w.id, w]))
    return [...ev.sessions].reverse().slice(0, shown).map(s => {
      const w = byId.get(s.id)
      const v = w ? sessionView({ ...w, entries: w.entries.filter(e => e?.id === exId) }) : null
      return { s, lanes: v ? v.lanes : [] }
    })
  }, [ev, S.workouts, exId, shown])

  const back = <button className="iconbtn" data-back="/visualize?tab=exercises" onClick={() => nav('/visualize?tab=exercises')} aria-label={t('Visualize')}><Icon name="chevronLeft" /></button>
  if (!ev.total) return <>
    <div className="hdr">{back}<div style={{ flex: 1, marginInlineStart: 12 }}><h1>{name}</h1></div></div>
    <div className="empty"><div className="ico"><Icon name="history" /></div>{t('No sessions logged yet')}</div>
  </>

  const tr = ev.trend
  const trendCls = tr ? (tr.dir === 'up' ? 'viz-up' : tr.dir === 'down' ? 'viz-down' : 'viz-flat') : ''
  const trendWord = tr ? (tr.dir === 'up' ? t('Progressing') : tr.dir === 'down' ? t('Declining') : t('Steady')) : null
  const deltaCls = v => (v > 0 ? 'viz-up' : v < 0 ? 'viz-down' : 'viz-flat')
  const info = key === 'e1rm' && <button className="viz-info" onClick={() => oneRmSheet(S, latest?.e1rmFrom)} aria-label={t('What is the estimated 1RM?')}><Icon name="info" /></button>

  return <>
    <div className="hdr">{back}
      <div style={{ flex: 1, marginInlineStart: 12 }}><h1>{name}</h1>
        <div className="sub">{tn('{0} session', '{0} sessions', ev.total)}</div></div></div>

    <Segmented className="seg-range" value={range} onChange={v => { setRange(v); setShown(LAST) }} options={rangeOptions()} />

    <div className="card">
      <h2 className="row" style={{ gap: 4 }}>{curveOpts[0].label}{info}</h2>
      <div className="viz-trend">
        <div className="big">{latest ? fmtKey(keyOf(latest)) : '–'}</div>
        {latest?.delta?.key != null && <span className={'viz-delta ' + deltaCls(latest.delta.key)}>{fmtDelta(latest.delta.key)} {t('vs last time')}</span>}
      </div>
      {key === 'e1rm' && latest?.e1rmFrom && <div className="small muted" style={{ marginTop: 4 }}>{t('From your best set')} · {fmtNum(latest.e1rmFrom.w)} {S.unit} × {latest.e1rmFrom.r} · {fmtDate(latest.d, true)}</div>}
      {tr && <div className="small" style={{ marginTop: 8 }}>
        <b className={trendCls}>{tr.dir === 'up' ? '↗' : tr.dir === 'down' ? '↘' : '→'} {trendWord}</b>
        <span className="muted"> · {fmtDelta(tr.change)} ({tr.pct > 0 ? '+' : ''}{fmtNum(Math.round(tr.pct * 1000) / 10)} %) {t('over the period')}</span>
      </div>}
      {ev.best && <div className="small row" style={{ margin: '6px 0 0', gap: 5 }}>
        <Icon name="trophy" style={{ fontSize: 14, color: 'var(--yellow)' }} />{t('Best:')} <b className="accent">{fmtKey(ev.best.y)}</b> <span className="muted">· {fmtDate(ev.best.d, true)}</span>
      </div>}
    </div>

    <div className="card">
      {curveOpts.length > 1 && <Segmented className="seg-range" value={cur} onChange={setCurve} options={curveOpts} />}
      <div className="chart">
        {cur === 'sets'
          ? <LineChart points={perSet.anchors} series={perSet.series} h={160} unit={perSet.metric === 'reps' ? t('reps') : S.unit} />
          : cur === 'vol'
            ? <LineChart points={volPts} h={160} unit={S.unit} color="var(--green)" />
            : points.length >= 2 ? <LineChart points={points} h={160} unit={unit} color="var(--blue)" />
              : <div className="empty small">{t('Fewer than two workouts in this period. Pick a longer one.')}</div>}
      </div>
      {cur === 'sets' && <div className="row small" style={{ gap: 12, flexWrap: 'wrap', marginTop: 6 }}>
        {perSet.ns.map(n => <span key={n} className="row" style={{ gap: 5, alignItems: 'center' }}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 4, background: SET_COLORS[n - 1] }} />{t('Set {0}', n)}
        </span>)}
      </div>}
      <div className="small dim" style={{ marginTop: 8 }}>
        {cur === 'sets' ? (perSet.metric === 'reps' ? t('Reps in each working set, one line per set number') : t('Estimated 1RM of each working set, one line per set number'))
          : cur === 'vol' ? t('Volume per session')
            : key === 'e1rm' ? t('Estimated 1RM per workout') : key === 'sec' ? t('Longest hold per workout') : key === 'reps' ? t('Most reps in a set per workout') : key === 'min' ? t('Minutes per session') : t('Best set weight per workout')}
      </div>
    </div>

    <h4 className="sec">{t('Sessions')}</h4>
    <div className="viz-cards">{cards.map(({ s, lanes }) => <div key={s.id} className={'card' + (s.excluded ? ' viz-excluded' : '')}>
      <div className="viz-card-top">
        <span className="viz-card-name"><span>{fmtDate(s.d, true)}</span>{s.pr && <span className="pr"><Icon name="trophy" />PR</span>}</span>
        {!s.excluded && s.delta?.key != null && <span className={'viz-delta ' + deltaCls(s.delta.key)}>{fmtDelta(s.delta.key)}</span>}
      </div>
      <div className="viz-card-tag">{[s.name, keyOf(s) != null && keyOf(s) > 0 ? fmtKey(keyOf(s)) : null, s.volume > 0 ? fmtVol(Math.round(s.volume), S.unit) : null, s.effortRir != null ? fmtEffort(s.effortRir) : null].filter(Boolean).join(' · ')}</div>
      {s.excluded && <div className="viz-card-tag">{t('Not counted for progression')}</div>}
      {lanes.map(l => <SetBars key={l.idx} lane={{ ...l, name }} color="var(--blue)" fmtEffort={fmtEffort} describe={describe}
        unit={l.metric === 'sec' ? 's' : l.metric === 'min' ? t('min') : l.metric === 'r' ? t('reps') : S.unit} />)}
      <div className="viz-card-foot"><span />
        <Button size="sm" variant="ghost" trailingIcon="chevronRight" onClick={() => nav('/visualize/session/' + encodeURIComponent(s.id))}>{t('Workout')}</Button>
      </div>
    </div>)}</div>
    {ev.sessions.length > shown && <Button variant="ghost" onClick={() => setShown(n => n + LAST)}>{t('Show more')}</Button>}
  </>
}
