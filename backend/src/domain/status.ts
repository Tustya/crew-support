export type QueueStatus =
  | 'unchanged'
  | 'needs_baseline'
  | 'waiting'
  | 'preparing'
  | 'needs_review'
  | 'reviewed'
  | 'handed_off'
  | 'sent'
  | 'stale'
  | 'needs_decision'

export function resolveQueueStatus(input: {
  hasBaseline: boolean
  changeCount: number
  blocking: boolean
  draftStatus: string | null
  drifted: boolean
  preparing: boolean
}): QueueStatus {
  if (input.preparing) return 'preparing'
  if (input.blocking) return 'needs_decision'
  if (!input.hasBaseline) return 'needs_baseline'
  if (input.changeCount === 0) {
    if (input.draftStatus === 'handed_off') return 'handed_off'
    if (input.draftStatus === 'sent' || input.draftStatus === 'external_confirmed') return 'sent'
    return 'unchanged'
  }
  if (input.draftStatus && input.drifted) return 'stale'
  if (input.draftStatus === 'reviewed') return 'reviewed'
  if (input.draftStatus === 'handed_off') return 'handed_off'
  if (input.draftStatus === 'sending') return 'preparing'
  if (input.draftStatus === 'active') return 'needs_review'
  return 'waiting'
}
