import { describe, expect, it } from 'vitest'
import { addMinutes, DEMO_START_ISO } from './time'
import { defaultSettings } from './templates'
import { selectGroups } from './view'
import { loadScenario } from '../fixtures/scenarios'
import { advance, applySettings, beginSend, finishSend, injectDelay } from '../state/ops'

const angel = 'hotel-angel|SVX|2026-10-09'

describe('crew support domain', () => {
  it('keeps one hotel timer when another hotel changes', () => {
    const data = loadScenario('calm', defaultSettings(), 'specialist')
    const dueAt = data.groupTimers[angel]?.dueAt
    const checked = advance(data, 60_000)
    expect(checked.snapshots).toHaveLength(data.snapshots.length)
    expect(checked.groupTimers[angel]?.dueAt).toBe(dueAt)
    const delayed = injectDelay(checked)
    expect(delayed.groupTimers[angel]?.dueAt).not.toBe(dueAt)
    expect(delayed.groupTimers['hotel-neva|LED|2026-10-09']).toBeUndefined()
  })

  it('prepares one draft after the quiet period', () => {
    const data = loadScenario('calm', defaultSettings(), 'specialist')
    expect(data.drafts).toHaveLength(0)
    const ready = advance(data, 10 * 60_000)
    expect(ready.drafts).toHaveLength(1)
    const review = selectGroups(ready).filter((group) => group.status === 'needs_review')
    expect(review).toHaveLength(1)
    expect(review[0]?.key).toBe(angel)
  })

  it('does not reset a timer when the same snapshot is polled', () => {
    const data = loadScenario('calm', defaultSettings(), 'specialist')
    const dueAt = data.groupTimers[angel]?.dueAt
    const polled = advance(data, 5 * 60_000)
    expect(polled.groupTimers[angel]?.dueAt).toBe(dueAt)
    expect(polled.snapshots).toHaveLength(2)
    expect(polled.drafts).toHaveLength(0)
  })

  it('keeps delays independent and counts eighteen events', () => {
    const data = loadScenario('delays', defaultSettings(), 'specialist')
    const groups = selectGroups(data).filter((group) => group.changes.length > 0)
    const events = groups.reduce((sum, group) => sum + group.changes.length, 0)
    expect(events).toBe(18)
    expect(groups.filter((group) => group.status === 'needs_review')).toHaveLength(1)
    expect(groups.filter((group) => group.status === 'waiting').length).toBeGreaterThan(1)
    expect(data.drafts).toHaveLength(1)
  })

  it('drops a reverted diff and keeps both checks in history', () => {
    const data = loadScenario('reverted', defaultSettings(), 'specialist')
    expect(selectGroups(data).every((group) => group.changes.length === 0)).toBe(true)
    expect(data.activities.filter((item) => item.groupKey === angel).length).toBeGreaterThan(1)
  })

  it('does not treat an unknown baseline as a pile of new bookings', () => {
    const data = loadScenario('unknown_base', defaultSettings(), 'specialist')
    const groups = selectGroups(data)
    expect(groups.every((group) => group.changes.length === 0)).toBe(true)
    expect(groups.some((group) => group.status === 'needs_baseline')).toBe(true)
    expect(data.drafts).toHaveLength(0)
  })

  it('links a replacement and a cross-midnight move', () => {
    const data = loadScenario('replacement', defaultSettings(), 'specialist')
    const events = selectGroups(data).flatMap((group) => group.changes)
    expect(events.some((event) => event.replacementId?.startsWith('repl-'))).toBe(true)
    const linked = new Set(events.filter((event) => event.linkedGroupKey).flatMap((event) => [event.groupKey, event.linkedGroupKey]))
    expect(linked.size).toBeGreaterThan(1)
  })

  it('keeps the baseline after a mail error and records one success', () => {
    const data = loadScenario('send_error', defaultSettings(), 'specialist')
    const draft = data.drafts.find((item) => item.groupKey === angel)
    expect(draft?.status).toBe('reviewed')
    const before = JSON.stringify(data.baselines[angel])
    const started = beginSend(data, draft?.id ?? '')
    expect(started.payload).not.toBeNull()
    const failed = finishSend({ ...started.data, sendingDraftId: draft?.id ?? '' }, started.payload)
    expect(JSON.stringify(failed.baselines[angel])).toBe(before)
    expect(failed.notifications.filter((item) => item.transport === 'sent')).toHaveLength(0)
    const retried = beginSend(failed, draft?.id ?? '')
    const sent = finishSend({ ...retried.data, sendingDraftId: draft?.id ?? '' }, retried.payload)
    expect(sent.notifications.filter((item) => item.transport === 'sent')).toHaveLength(1)
    const again = finishSend({ ...sent, sendingDraftId: draft?.id ?? '' }, retried.payload)
    expect(again.notifications.filter((item) => item.transport === 'sent')).toHaveLength(1)
    expect(selectGroups(sent).find((group) => group.key === angel)?.changes).toHaveLength(0)
  })

  it('changes only the touched hotel when quiet minutes change', () => {
    const data = loadScenario('calm', defaultSettings(), 'lead')
    const next = applySettings(data, { ...data.settings, quietMinutes: 25 })
    expect(Date.parse(next.groupTimers[angel]?.dueAt ?? '') - Date.parse(next.groupTimers[angel]?.lastChangeAt ?? '')).toBe(25 * 60_000)
    expect(next.drafts).toHaveLength(0)
    expect(addMinutes(DEMO_START_ISO, 25)).toBe(next.groupTimers[angel]?.dueAt)
  })
})
