// The Visualize page's two drawings, in plain SVG like the rest of the charts (no chart library):
// the timeline of a session on its own clock, and one exercise's sets as bars. Colours are the
// app's system colours, so both themes and every accent read the same.
import { useId, useState } from 'react'
import { t, dateLocale } from '../lib/i18n.js'
import { fmtNum } from '../lib/format.js'
import { barValue } from '../lib/session-view.js'

// One colour per block (an exercise, or a superset as a whole), in session order.
export const BLOCK_COLORS = ['var(--blue)', 'var(--orange)', 'var(--green)', 'var(--yellow)', 'var(--pink)', 'var(--purple)', 'var(--teal)', 'var(--indigo)', 'var(--red)', 'var(--mint)', 'var(--brown)']
export const blockColor = b => BLOCK_COLORS[(b || 0) % BLOCK_COLORS.length]

/** Seconds as m:ss ("1:30"), an hour and over as h:mm:ss. */
export function mmss(sec) {
  if (sec == null || !Number.isFinite(sec)) return '–'
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(r).padStart(2, '0')
}
/** A wall-clock time in the UI language: "12:16", or "12:16:05" with seconds. */
export const clockOf = (ms, sec = false) => new Date(ms).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', ...(sec ? { second: '2-digit' } : {}) })

/** The short label a set carries on the charts: "60×8", "8" (reps), "45s", "20'". */
export function shortSet(set, metric) {
  if (metric === 'sec') return fmtNum(set.sec) + 's'
  if (metric === 'min') return fmtNum(set.min) + '′'
  if (metric === 'r') return set.w > 0 ? '+' + fmtNum(set.w) + '×' + set.r : String(set.r)
  return fmtNum(set.w) + '×' + set.r
}

const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/* ------------------------------------------------------------ timeline -- */
// One lane per exercise on the real clock: a dot per ticked set with its numbers, the time spent
// on the exercise as a tinted band, and on the right that time and the average gap between its
// work sets. Under the lanes, the Rest row: each gap between two rounds, the part within the rest
// timer light, the part over it in orange, a change of exercise as a thin grey bar.
// `describe(lane, set)` gives a set's tooltip, `nameOf(lane)` a lane's name.
export function SessionTimeline({ view, nameOf, describe }) {
  const [tip, setTip] = useState(null)
  const { t0, t1, lanes, intervals, blocks } = view
  const W = 900, L = 128, Rt = 132, laneH = 38, top = 28
  const C1 = W - 70, C2 = W - 8
  const restY = top + lanes.length * laneH + 18, restH = 24, H = restY + restH + 38
  const span = Math.max(60000, t1 - t0)
  const x = ms => L + ((ms - t0) / span) * (W - L - Rt)
  const minutes = span / 60000
  const stepMin = minutes > 150 ? 30 : minutes > 75 ? 15 : minutes > 35 ? 10 : 5
  const step = stepMin * 60000
  const grid = []
  for (let g = Math.ceil(t0 / step) * step; g <= t1; g += step) grid.push(g)
  const show = (px, py, text) => setTip({ left: (px / W) * 100 + '%', top: (py / H) * 100 + '%', text })
  const hide = () => setTip(null)
  const restCount = intervals.filter(iv => iv.kind === 'rest' && !iv.afterWarm)
  const restAvg = restCount.length ? restCount.reduce((a, iv) => a + iv.sec, 0) / restCount.length : null
  const blockName = b => blocks[b].idxs.map(i => lanes.find(l => l.idx === i)).filter(Boolean).map(nameOf).join(' + ')

  return <div className="viz-scroll" onPointerLeave={hide}>
    <div className="viz-tl">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('Session timeline')}>
        {grid.map(g => <g key={g}>
          <line x1={x(g)} x2={x(g)} y1={top - 6} y2={restY + restH} className="viz-grid" />
          <text x={x(g)} y={H - 20} textAnchor="middle" className="viz-ax">{clockOf(g)}</text>
        </g>)}
        <text x={C1} y={14} textAnchor="end" className="viz-ax">{t('Time')}</text>
        <text x={C2} y={14} textAnchor="end" className="viz-ax">{t('Avg gap')}</text>
        <line x1={W - Rt + 16} x2={W - Rt + 16} y1={top - 6} y2={restY + restH} className="viz-grid" />
        {lanes.map((l, li) => {
          const cy = top + li * laneH + laneH / 2
          const color = blockColor(l.block)
          const ticked = l.sets.filter(s => s.at != null)
          const xs = ticked.map(s => x(s.at))
          let below = false
          return <g key={l.idx}>
            {li % 2 === 0 && <rect x={L - 6} y={cy - laneH / 2} width={W - L - Rt + 12} height={laneH} className="viz-stripe" />}
            <text x={L - 12} y={cy + 4} textAnchor="end" className="viz-lane">{cut(nameOf(l), 18)}</text>
            {l.spanFrom != null && <rect x={x(l.spanFrom)} y={cy - 13} width={Math.max(0, x(l.spanTo) - x(l.spanFrom))} height={26} rx={6} fill={color} fillOpacity={0.1} />}
            <text x={C1} y={cy + 4} textAnchor="end" className="viz-lane viz-num">{l.timeMs ? mmss(l.timeMs / 1000) : '–'}</text>
            <text x={C2} y={cy + 4} textAnchor="end" className="viz-lane viz-num">{mmss(l.avgGapSec)}</text>
            {xs.length > 1 && <line x1={xs[0]} x2={xs.at(-1)} y1={cy} y2={cy} stroke={color} strokeWidth={2} strokeOpacity={0.35} />}
            {ticked.map((s, i) => {
              const cx = xs[i]
              // Labels of sets close together alternate above and below the line.
              below = i > 0 && cx - xs[i - 1] < 44 && !below
              const hold = s.sec > 0 && l.metric === 'sec'
              return <g key={s.i}>
                {hold && <rect x={x(s.at - s.sec * 1000)} y={cy - 4} width={Math.max(2, x(s.at) - x(s.at - s.sec * 1000))} height={8} rx={3} fill={color} fillOpacity={0.45} />}
                <circle cx={cx} cy={cy} r={6} fill={s.warm ? 'var(--surface)' : color} stroke={s.warm ? color : 'var(--surface)'} strokeWidth={2} />
                <text x={cx} y={below ? cy + 19 : cy - 10} textAnchor="middle" className="viz-val">{shortSet(s, l.metric)}</text>
                <circle cx={cx} cy={cy} r={14} className="viz-hit" tabIndex={-1}
                  onPointerEnter={() => show(cx, cy - 8, describe(l, s))} onClick={() => show(cx, cy - 8, describe(l, s))} />
              </g>
            })}
          </g>
        })}
        <text x={L - 12} y={restY + restH / 2 + 4} textAnchor="end" className="viz-lane">{t('Rest')}</text>
        <text x={C2} y={restY + restH / 2 + 4} textAnchor="end" className="viz-lane viz-num">{mmss(restAvg)}</text>
        {intervals.map((iv, i) => {
          const x0 = x(iv.from) + 1.5, x1 = Math.max(x0 + 1, x(iv.to) - 1.5)
          const xp = iv.planSec > 0 ? Math.min(x1, x(iv.from + iv.planSec * 1000)) : x1
          const label = iv.kind === 'switch' ? t('Change of exercise') + ' → ' + blockName(iv.block)
            : iv.kind === 'break' ? t('Break')
              : t('Rest') + ' · ' + blockName(iv.block) + (iv.planSec > 0 ? (iv.overSec > 0 ? ' · ' + t('{0} over the timer', '+' + mmss(iv.overSec)) : ' · ' + t('Within the timer')) : '')
          return <g key={i}>
            {iv.kind === 'rest' ? <>
              <rect x={x0} y={restY} width={Math.max(1, xp - x0)} height={restH} rx={3} className={iv.afterWarm ? 'viz-rest viz-rest-w' : 'viz-rest'} />
              {x1 > xp + 1 && <rect x={xp + 1} y={restY} width={x1 - xp - 1} height={restH} rx={3} className="viz-over" />}
              {x1 - x0 > 30 && <text x={(x0 + x1) / 2} y={restY + restH / 2 + 3.5} textAnchor="middle" className="viz-val">{mmss(iv.sec)}</text>}
            </> : <rect x={x0} y={restY + 9} width={Math.max(1, x1 - x0)} height={restH - 18} rx={3} className={iv.kind === 'break' ? 'viz-break' : 'viz-switch'} />}
            <rect x={x0} y={restY - 4} width={Math.max(6, x1 - x0)} height={restH + 8} className="viz-hit"
              onPointerEnter={() => show((x0 + x1) / 2, restY, mmss(iv.sec) + ' · ' + label)} onClick={() => show((x0 + x1) / 2, restY, mmss(iv.sec) + ' · ' + label)} />
          </g>
        })}
        <text x={x(t0)} y={H - 4} textAnchor="start" className="viz-ax">{clockOf(t0)}</text>
        <text x={x(t1)} y={H - 4} textAnchor="end" className="viz-ax">{clockOf(t1)}</text>
      </svg>
      {tip && <div className="viz-tip" style={{ left: tip.left, top: tip.top }}>{tip.text}</div>}
    </div>
  </div>
}

/* -------------------------------------------------------------- bars -- */
// One exercise's sets as bars: height the load (or reps, seconds, minutes), the reps above, the
// set number and effort below. A warm-up is a lighter bar; a drop set's drops stand hatched
// beside its main bar.
export function SetBars({ lane, color, fmtEffort, unit, describe }) {
  const id = useId().replace(/:/g, '')
  const [tip, setTip] = useState(null)
  const { metric, sets } = lane
  const W = 300, H = 150, Lp = 32, Rp = 6, T = 18, B = 34
  const vals = sets.flatMap(s => [barValue(s, metric), ...(metric === 'w' ? s.drops.map(d => d.w) : [])])
  const top = Math.max(1, ...vals) * 1.12
  const raw = top / 3, mag = 10 ** Math.floor(Math.log10(raw))
  const stepV = [1, 2, 2.5, 5, 10].map(m => m * mag).find(v => v >= raw)
  const ticks = Math.ceil(top / stepV), max = ticks * stepV
  const y = v => T + (1 - v / max) * (H - T - B)
  const n = sets.length, slot = (W - Lp - Rp) / n, bw = Math.min(40, slot * 0.58)
  const base = y(0)
  return <div className="viz-bars" onPointerLeave={() => setTip(null)}>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={lane.name}>
      <defs>
        <pattern id={'h' + id} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={6} height={6} fill={color} fillOpacity={0.22} />
          <line x1={0} y1={0} x2={0} y2={6} stroke={color} strokeWidth={2} />
        </pattern>
      </defs>
      {Array.from({ length: ticks + 1 }, (_, i) => stepV * i).map(v => <g key={v}>
        <line x1={Lp} x2={W - Rp} y1={y(v)} y2={y(v)} className="viz-grid" />
        <text x={Lp - 5} y={y(v) + 3.5} textAnchor="end" className="viz-ax">{fmtNum(Math.round(v * 10) / 10)}</text>
      </g>)}
      <text x={Lp - 5} y={9} textAnchor="end" className="viz-ax">{unit}</text>
      {sets.map((s, i) => {
        const cx = Lp + slot * (i + 0.5), v = barValue(s, metric), tp = y(v), h = Math.max(2, base - tp), rr = Math.min(4, h / 2)
        const x0 = cx - bw / 2, x1 = cx + bw / 2
        const drops = metric === 'w' ? s.drops : []
        const dw = drops.length ? (bw * 0.45) / drops.length : 0
        const text = describe(lane, s)
        return <g key={s.i}>
          <path d={`M${x0},${base} V${tp + rr} Q${x0},${tp} ${x0 + rr},${tp} H${x1 - rr} Q${x1},${tp} ${x1},${tp + rr} V${base} Z`} fill={color} fillOpacity={s.warm ? 0.3 : 1} />
          {drops.map((d, j) => {
            const dx = x1 + 2 + j * (dw + 1), dt = y(d.w)
            return <g key={j}>
              <rect x={dx} y={dt} width={dw} height={Math.max(1, base - dt)} rx={2} fill={`url(#h${id})`} />
              <text x={dx + dw / 2} y={dt - 4} textAnchor="middle" className="viz-val">×{d.r}</text>
            </g>
          })}
          <text x={cx} y={tp - 5} textAnchor="middle" className="viz-val">{metric === 'w' ? '×' + s.r : shortSet(s, metric)}</text>
          <text x={cx} y={base + 13} textAnchor="middle" className="viz-ax">{s.warm ? '·' : s.n}</text>
          <text x={cx} y={base + 26} textAnchor="middle" className="viz-val">{s.rir != null ? fmtEffort(s.rir) : '–'}</text>
          <rect x={cx - slot / 2} y={T} width={slot} height={H - T} className="viz-hit"
            onPointerEnter={() => setTip({ left: (cx / W) * 100 + '%', top: (tp / H) * 100 + '%', text })}
            onClick={() => setTip({ left: (cx / W) * 100 + '%', top: (tp / H) * 100 + '%', text })} />
        </g>
      })}
      <line x1={Lp} x2={W - Rp} y1={base} y2={base} className="viz-base" />
    </svg>
    {tip && <div className="viz-tip" style={{ left: tip.left, top: tip.top }}>{tip.text}</div>}
  </div>
}
