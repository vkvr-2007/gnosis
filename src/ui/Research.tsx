import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
  activityLine,
  citeUrl,
  confidenceLine,
  confidenceTone,
  elapsed,
  isWebUrl,
  laneCounts,
  liveElapsed,
  partActive,
  partCounts,
  partStateLabel,
  platformInfo,
  rankLabel,
  rankedView,
  reviewLine,
  scoreTone,
  scoreWidth,
  splitCites,
  stageSub,
  statusPill,
  withDefaults,
  type RankedResult,
  type Research,
} from '../lib/research'

/**
 * The research progress card — a small card in the dock while one run of the
 * research agent (bridge/research.mjs) is going: the rank, the three or four
 * agents working on their parts of the question, and the reviewer. It is not
 * the result; the data and sources cards are, and they take this card's place
 * when they arrive.
 *
 * In researcher mode (the R key; bridge/deep.mjs, `variant: 'deep'`) the same
 * blade is the RESEARCHER board instead — and there it is the result: it
 * stays once the run is done, with the ranked results and the final answer.
 *
 * It arrives as a `kind: 'research'` blade and is replaced in place on every
 * update (same blade id), so this is a pure function of the state object plus
 * the clock.
 *
 * The question and the part titles came from a model that read the open web,
 * so everything is rendered as React text. There is no innerHTML anywhere in
 * this file, and none should ever be added.
 */
export function ResearchProgress({
  research,
  expanded = false,
  onMore,
}: {
  research: Research
  /** Full screen: the RESEARCHER board shows every ranked result. */
  expanded?: boolean
  /** "Full report": throw the card full screen. */
  onMore?: () => void
}) {
  const r = useMemo(() => withDefaults(research), [research])
  if (r.variant === 'deep') return <ResearcherBoard r={r} expanded={expanded} onMore={onMore} />

  const pill = statusPill(r)
  const rank = rankLabel(r.rank)
  const doing = r.parts.length ? '' : activityLine(r)

  return (
    <div className="rs-progress">
      <div className="rs-top">
        <span className={`rs-pill rs-t-${pill.tone}${pill.pulse ? ' rs-pulse' : ''}`}>
          <i aria-hidden="true" />
          {pill.text}
        </span>
        {rank && <span className="rs-rank">{rank}</span>}
      </div>
      <p className="rs-q" title={r.question}>
        {r.question || 'Research'}
      </p>
      {r.rank && r.rank.reasons.length > 0 && <p className="rs-why">{r.rank.reasons.join(' · ')}</p>}

      {r.parts.length > 0 ? (
        <ol className="rs-parts" aria-label="Agents">
          {r.parts.map((p) => (
            <li key={p.i} className={`rs-part rs-ps-${p.state}`}>
              <span className="rs-pi">{p.i}</span>
              <span className="rs-pt" title={p.question}>
                {p.title || p.question || `Part ${p.i}`}
              </span>
              <span className="rs-chip">
                {partActive(p.state) && <span className="rs-spin" aria-hidden="true" />}
                {partStateLabel(p.state)}
              </span>
              <span className="rs-pc">{p.state === 'fail' && p.error ? p.error : partCounts(p)}</span>
            </li>
          ))}
        </ol>
      ) : (
        doing && (
          <p className="rs-doing">
            <span className="rs-spin" aria-hidden="true" />
            {doing}
          </p>
        )
      )}

      <p className="rs-review">{reviewLine(r)}</p>

      {r.status === 'failed' && (
        <p className="rs-alert rs-t-red" role="alert">
          {r.error || 'The research could not finish.'}
        </p>
      )}
      {r.status === 'stopped' && (
        <p className="rs-alert rs-t-amber">{r.error || 'Stopped before the answer was finished.'}</p>
      )}

      <p className="rs-foot">
        <Elapsed status={r.status} mode={r.mode} startedAt={r.startedAt} ms={r.ms} />
        {' · '}
        {r.stats.calls} Claude {r.stats.calls === 1 ? 'call' : 'calls'}
      </p>
    </div>
  )
}

/** A platform's colour, for the badge and the lane edge (index.css, --plat). */
const plat = (colour: string): CSSProperties => ({ ['--plat' as string]: colour })

/**
 * Researcher mode's board: what the question is after, the four stages
 * (reason → platforms → rank → final), one lane per platform searched, and,
 * once it is done, the answer and the results ranked by relevance — every one
 * a real link with its score.
 */
function ResearcherBoard({ r, expanded, onMore }: { r: Research; expanded: boolean; onMore?: () => void }) {
  const pill = statusPill(r)
  const running = r.status === 'running'
  const { rows, more } = rankedView(r.ranked, expanded)
  const doing = running && !r.parts.length ? activityLine(r) : ''
  const confidence = confidenceLine(r.answer)
  // Docked, a long answer is cut at ten lines (index.css): the rest is a press away.
  const longAnswer = r.answer.text.length > 600

  return (
    <div className={`rs-progress rs-deep${expanded ? ' rs-wide' : ''}`}>
      <div className="rs-top">
        <span className={`rs-pill rs-t-${pill.tone}${pill.pulse ? ' rs-pulse' : ''}`}>
          <i aria-hidden="true" />
          {pill.text}
        </span>
        <span className="rs-rank">Researcher</span>
        <span className="rs-timer">
          <Elapsed status={r.status} mode={r.mode} startedAt={r.startedAt} ms={r.ms} />
        </span>
      </div>
      <p className="rs-q" title={r.question}>
        {r.question || 'Research'}
      </p>

      {r.reasoning && (
        <div className="rs-intent">
          {(r.reasoning.kind || r.reasoning.intent) && (
            <p className="rs-intent-line">
              {r.reasoning.kind && <b>{r.reasoning.kind}</b>}
              {r.reasoning.intent}
            </p>
          )}
          {r.reasoning.criteria.length > 0 && (
            <ul className="rs-crit" aria-label="What a good answer needs">
              {r.reasoning.criteria.map((c, i) => (
                <li key={`${i}-${c}`}>{c}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ol className="rs-stages" aria-label="Stages">
        {r.stages.map((s) => (
          <li key={s.key} className={`rs-stage rs-ss-${s.state}`}>
            <span className="rs-sl">
              {s.state === 'run' && <span className="rs-spin" aria-hidden="true" />}
              {s.label}
            </span>
            <span className="rs-sn" title={s.note}>
              {stageSub(s)}
            </span>
          </li>
        ))}
      </ol>

      {doing && (
        <p className="rs-doing">
          <span className="rs-spin" aria-hidden="true" />
          {doing}
        </p>
      )}

      {r.answer.text && (
        <section className="rs-answer" aria-label="Answer">
          <p className="rs-h">
            Answer
            {confidence && <span className={`rs-conf rs-t-${confidenceTone(r.answer.label)}`}>{confidence}</span>}
          </p>
          <p className="rs-atext">
            {splitCites(r.answer.text).map((x, i) =>
              typeof x === 'number' ? <CiteLink key={i} n={x} url={citeUrl(r, x)} /> : <Fragment key={i}>{x}</Fragment>,
            )}
          </p>
        </section>
      )}

      {rows.length > 0 && (
        <section className="rs-ranked" aria-label="Ranked results">
          <p className="rs-h">Top results · by relevance</p>
          <ol className="rs-hits">
            {rows.map((h) => (
              <Hit key={`${h.n}-${h.url}`} h={h} />
            ))}
          </ol>
        </section>
      )}

      {!expanded && onMore && (more > 0 || longAnswer) && (
        <button type="button" className="bl-more-rows" onClick={onMore} title="Full screen (E)">
          {more > 0 ? `+${more} more · ` : ''}full report
        </button>
      )}

      {r.parts.length > 0 && (
        <ol className="rs-lanes" aria-label="Platforms">
          {r.parts.map((p) => {
            const info = platformInfo(p.platform)
            return (
              <li key={p.i} className={`rs-lane rs-ps-${p.state}`} style={plat(info.colour)}>
                <span className="rs-plat">{p.title || info.label}</span>
                <span className="rs-chip">
                  {partActive(p.state) && <span className="rs-spin" aria-hidden="true" />}
                  {partStateLabel(p.state)}
                </span>
                <span className="rs-pc">{p.state === 'fail' && p.error ? p.error : laneCounts(p)}</span>
                {p.question && (
                  <span className="rs-lq" title={p.question}>
                    {p.question}
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      )}

      {r.status === 'done' && r.gaps.length > 0 && (
        <p className="rs-gaps">
          <b>Not settled</b>
          {r.gaps.slice(0, expanded ? 8 : 3).join(' · ')}
        </p>
      )}

      {r.status === 'failed' && (
        <p className="rs-alert rs-t-red" role="alert">
          {r.error || 'The research could not finish.'}
        </p>
      )}
      {r.status === 'stopped' && (
        <p className="rs-alert rs-t-amber">{r.error || 'Stopped before the answer was finished.'}</p>
      )}

      <p className="rs-foot">
        {r.parts.length} {r.parts.length === 1 ? 'platform' : 'platforms'}
        {' · '}
        {r.stats.found} found · {r.stats.read} read
        {' · '}
        {r.stats.calls} Claude {r.stats.calls === 1 ? 'call' : 'calls'}
      </p>
    </div>
  )
}

/**
 * One ranked result: where it is from, its title as a real link, its score as a
 * bar, why to trust it and what it says. Only http(s) addresses become links,
 * opened the way the sources card opens them; anything else is shown as words.
 */
function Hit({ h }: { h: RankedResult }) {
  const info = platformInfo(h.platform)
  const title = h.title || h.domain || h.url
  const meta = [h.signal, h.domain].filter(Boolean).join(' · ')
  return (
    <li className={`rs-hit rs-t-${scoreTone(h.score)}`} style={plat(info.colour)}>
      <span className="rs-hit-top">
        <span className="rs-n">{h.n}</span>
        <span className="rs-badge" title={info.label}>
          {info.short}
        </span>
        {isWebUrl(h.url) ? (
          <a className="rs-ht" href={h.url} target="_blank" rel="noopener noreferrer" title={h.url}>
            {title}
          </a>
        ) : (
          <span className="rs-ht rs-off">{title}</span>
        )}
        <span className="rs-score" title={`Relevance ${h.relevance}/10`}>
          {h.score}
        </span>
      </span>
      <span className="rs-bar" aria-hidden="true">
        <i style={{ width: `${scoreWidth(h.score)}%` }} />
      </span>
      {meta && <span className="rs-signal">{meta}</span>}
      {h.summary && <span className="rs-sum">{h.summary}</span>}
    </li>
  )
}

/** A citation in the answer: a link to its source when it has a web address. */
function CiteLink({ n, url }: { n: number; url: string }) {
  if (!url) {
    return (
      <sup className="bl-cite" aria-label={`source ${n}`}>
        [{n}]
      </sup>
    )
  }
  return (
    <sup className="bl-cite">
      <a href={url} target="_blank" rel="noopener noreferrer" title={url} aria-label={`source ${n}`}>
        [{n}]
      </a>
    </sup>
  )
}

/**
 * The clock, on its own so its ticks redraw a few characters and not the card.
 * The interval exists only while a live run is going.
 */
function Elapsed(r: Pick<Research, 'status' | 'mode' | 'startedAt' | 'ms'>) {
  const ticking = r.status === 'running' && r.mode === 'live'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(timer)
  }, [ticking])
  return <>{elapsed(liveElapsed(r, now))}</>
}
