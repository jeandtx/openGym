// Visualize (Stats → Visualize): every workout, to open one drawn set by set, and every exercise,
// to follow it across its sessions. Read-only; nothing here changes the log.
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { t, tn } from '../lib/i18n.js'
import { fmtDate } from '../lib/format.js'
import { EXIDX, matchExercise } from '../lib/exercises.js'
import { exerciseIndex } from '../lib/exercise-evolution.js'
import { WorkoutRow } from '../sheets.jsx'
import { Button, Segmented, SearchField } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import { tappable } from '../lib/use-sheet-keyboard.js'
import { exerciseName } from './visualize-common.jsx'
import './Visualize.css'

const PAGE = 30

// The newest entry of an exercise, for the name of one no longer in the catalogue.
function entryOf(S, id) {
  for (let i = (S.workouts || []).length - 1; i >= 0; i--) {
    const en = (S.workouts[i].entries || []).find(e => e?.id === id)
    if (en) return en
  }
  return null
}

export default function Visualize() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'exercises' ? 'exercises' : 'sessions'
  const setTab = v => setParams(v === 'exercises' ? { tab: v } : {}, { replace: true })
  const [shown, setShown] = useState(PAGE)
  const [q, setQ] = useState('')
  const workouts = useMemo(() => [...(S.workouts || [])].reverse(), [S.workouts])
  const exercises = useMemo(() => exerciseIndex(S).map(x => {
    const entry = EXIDX[x.id] ? null : entryOf(S, x.id)
    return { ...x, name: exerciseName(x.id, entry), matcher: EXIDX[x.id] || { id: x.id, n: entry?.n || '' } }
  }), [S.workouts])
  const filtered = q.trim() ? exercises.filter(x => matchExercise(x.matcher, q) || x.name.toLowerCase().includes(q.trim().toLowerCase())) : exercises

  return <>
    <div className="hdr"><button className="iconbtn" data-back="/stats" onClick={() => nav('/stats')} aria-label={t('Stats')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 12 }}><h1>{t('Visualize')}</h1>
        <div className="sub">{t('Every workout set by set, and each exercise over time.')}</div></div></div>
    {!workouts.length ? <div className="empty"><div className="ico"><Icon name="chartLine" /></div>{t('No workouts yet. Your first one will land here.')}</div> : <>
      <Segmented className="seg-range" value={tab} onChange={setTab}
        options={[{ value: 'sessions', label: t('Sessions') }, { value: 'exercises', label: t('Exercises') }]} />
      {tab === 'sessions' ? <>
        <div className="list">{workouts.slice(0, shown).map(w => <WorkoutRow key={w.id} w={w} onClick={() => nav('/visualize/session/' + encodeURIComponent(w.id))} />)}</div>
        {workouts.length > shown && <Button variant="ghost" style={{ marginTop: 10 }} onClick={() => setShown(n => n + PAGE)}>{t('Show more')}</Button>}
      </> : <>
        <div style={{ marginBottom: 10 }}><SearchField value={q} onChange={e => setQ(e.target.value)} onClear={() => setQ('')} placeholder={t('Search…')} aria-label={t('Search…')} /></div>
        {filtered.length ? <div className="list">{filtered.map(x => <div key={x.id} className="item" {...tappable(() => nav('/visualize/exercise/' + encodeURIComponent(x.id)))}>
          <span className="lrow-i" style={{ width: 34, height: 34, borderRadius: 8, fontSize: 19 }}><Icon name="chartLine" /></span>
          <div className="grow"><div className="tt">{x.name}</div>
            <div className="ss">{[tn('{0} session', '{0} sessions', x.sessions), x.lastD ? fmtDate(x.lastD, true) : null].filter(Boolean).join(' · ')}</div></div>
          <Icon name="chevronRight" className="chev" />
        </div>)}</div> : <div className="empty small">{t('No match')}</div>}
      </>}
    </>}
  </>
}
