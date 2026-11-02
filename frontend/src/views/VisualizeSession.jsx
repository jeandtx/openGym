// One workout drawn set by set (Visualize → a session): tiles, the timeline on the session's own
// clock with the rest between rounds, one card per exercise and every set in a table. The numbers
// come from lib/session-view.js; this file only lays them out.
import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { fmtDate, fmtDur, fmtNum, fmtVol, exCount } from '../lib/format.js'
import { setLabel } from '../lib/history.js'
import { speedUnitOf } from '../lib/speed.js'
import { sessionView, LONG_REST_SEC } from '../lib/session-view.js'
import { SessionTimeline, SetBars, blockColor, mmss, clockOf } from '../components/VizCharts.jsx'
import { Button } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import { exerciseName, effortFormatter, setDescriber } from './visualize-common.jsx'
import './Visualize.css'

const metricUnit = (metric, unit) => (metric === 'sec' ? 's' : metric === 'min' ? t('min') : metric === 'r' ? t('reps') : unit)

export default function VisualizeSession() {
  const nav = useNavigate()
  const { id } = useParams()
  const S = useStore(s => s.S)
  const w = (S.workouts || []).find(x => String(x.id) === id)
  const v = useMemo(() => (w ? sessionView(w, { defaultRestSec: S.restSec }) : null), [w, S.restSec])
  const back = <button className="iconbtn" data-back="/visualize" onClick={() => nav('/visualize')} aria-label={t('Visualize')}><Icon name="chevronLeft" /></button>
  if (!w || !v) return <>
    <div className="hdr">{back}<div style={{ flex: 1, marginInlineStart: 12 }}><h1>{t('Visualize')}</h1></div></div>
    <div className="empty"><div className="ico"><Icon name="history" /></div>{t('No sessions logged yet')}</div>
  </>

  const fmtEffort = effortFormatter(S)
  const describe = setDescriber(S)
  const speed = speedUnitOf(S)
  const nameOf = lane => exerciseName(lane.id, lane.entry)
  const tot = v.totals
  const lanesOf = b => v.lanes.filter(l => l.block === b)
  const usedBlocks = v.blocks.filter(B => lanesOf(B.b).length)
  const sub = [fmtDate(w.d, true), v.clock ? clockOf(v.t0) + ' → ' + clockOf(v.t1) : null, exCount(v.lanes.length)].filter(Boolean)

  const tiles = [
    v.durationMs >= 60000 && [t('Duration'), fmtDur(v.durationMs)],
    [t('Work sets'), <>{tot.workSets}{tot.warmSets > 0 && <small>+ {tot.warmSets} {t('Warm-up').toLowerCase()}</small>}</>],
    tot.volume > 0 && [t('Volume'), fmtVol(Math.round(tot.volume), S.unit)],
    tot.restMedianSec != null && [t('Median rest'), <>{mmss(tot.restMedianSec)}{tot.planSec > 0 && <small>/ {mmss(tot.planSec)}</small>}</>],
    tot.effortN > 0 && [t('Effort'), <>{fmtEffort(tot.effortRir)}<small>{t('{0} sets', tot.effortN)}</small></>],
    tot.restCount > 0 && [t('Rests over {0}', mmss(LONG_REST_SEC)), <>{tot.longRests}<small>/ {tot.restCount}</small></>],
  ].filter(Boolean)

  return <>
    <div className="hdr">{back}
      <div style={{ flex: 1, marginInlineStart: 12 }}><h1>{w.name || t('Workout')}</h1><div className="sub">{sub.join(' · ')}</div></div></div>

    <div className="tiles viz-tiles">{tiles.map(([l, val], i) => <div key={i} className="tile"><div className="l">{l}</div><div className="v">{val}</div></div>)}</div>

    <div className="card">
      <h2>{t('Session timeline')}</h2>
      {v.clock ? <>
        <p className="viz-hint">{t('One line per exercise, on the real clock. Each dot is a ticked set with its load and reps; the tinted band is the time spent on the exercise. On the Rest line, each gap between two sets or two superset rounds: grey within the rest timer, orange past it.')}</p>
        <div className="viz-legend">
          {usedBlocks.map(B => <span key={B.b}><i style={{ background: blockColor(B.b) }} />{lanesOf(B.b).map(nameOf).join(' + ')}</span>)}
          <span><i className="viz-rest" style={{ background: 'color-mix(in srgb,var(--label-3) 32%,transparent)' }} />{t('Within the timer')}</span>
          <span><i style={{ background: 'var(--orange)' }} />{t('Over the timer')}</span>
        </div>
        <SessionTimeline view={v} nameOf={nameOf} describe={describe} />
      </> : <p className="viz-hint" style={{ margin: 0 }}>{t('This workout has no set times (imported or logged afterwards), so there is no timeline. The sets are below.')}</p>}
    </div>

    <h4 className="sec">{t('By exercise')}</h4>
    <p className="viz-hint" style={{ padding: '0 4px' }}>{t('Bars: the load of each set, the reps above, the effort below. Warm-ups are lighter; the hatched part of a drop set is the weight drop.')}</p>
    <div className="viz-cards">{v.lanes.map(l => {
      const color = blockColor(l.block)
      const partners = v.blocks[l.block].idxs.length > 1 ? lanesOf(l.block).filter(o => o !== l) : []
      const total = l.metric === 'sec' ? fmtNum(l.sec) + ' s' : l.metric === 'min' ? fmtNum(l.min) + ' ' + t('min') : l.metric === 'r' ? l.reps + ' ' + t('reps') : fmtVol(Math.round(l.volume), S.unit)
      return <div key={l.idx} className="card">
        <div className="viz-card-top">
          <span className="viz-card-name"><i className="viz-dot" style={{ background: color }} /><span>{nameOf(l)}</span></span>
          <span className="viz-card-vol">{total}</span>
        </div>
        {partners.length > 0 && <div className="viz-card-tag"><Icon name="link" /> {t('Superset')} · {partners.map(nameOf).join(', ')}</div>}
        <SetBars lane={{ ...l, name: nameOf(l) }} color={color} fmtEffort={fmtEffort} unit={metricUnit(l.metric, S.unit)} describe={describe} />
        <div className="viz-card-foot">
          <span>{l.timeMs ? '⏱ ' + mmss(l.timeMs / 1000) : ''}</span>
          <Button size="sm" variant="ghost" trailingIcon="chevronRight" onClick={() => nav('/visualize/exercise/' + encodeURIComponent(l.id))}>{t('Evolution')}</Button>
        </div>
      </div>
    })}</div>

    <div className="card">
      <details className="viz-details"><summary>{t('All sets in a table')}</summary>
        <div className="viz-table"><table>
          <thead><tr><th>{t('Time')}</th><th>{t('Gap')}</th><th>{t('Exercise')}</th><th>{t('Sets')}</th><th>{t('Effort')}</th><th>{t('Volume')}</th></tr></thead>
          <tbody>{v.rows.map(({ lane, set, gapSec }, i) => <tr key={i} className={set.warm ? 'dim' : undefined}>
            <td>{set.at != null ? clockOf(set.at, true) : '–'}</td>
            <td>{gapSec != null ? mmss(gapSec) : '–'}</td>
            <td>{nameOf(lane)}{set.warm ? ' · ' + t('Warm-up') : ''}</td>
            <td>{setLabel(lane.id, set.row, lane.entry?.target || null, speed)}</td>
            <td>{set.rir != null ? fmtEffort(set.rir) : '–'}</td>
            <td>{set.volume > 0 && !set.warm ? fmtVol(Math.round(set.volume), S.unit) : '–'}</td>
          </tr>)}</tbody>
        </table></div>
      </details>
    </div>
  </>
}
