import type { ResumeView, ResumeWriteReq } from '@shared/types'

// The resume editor's form state. It is sent whole as the PUT body, so every field the server stores must be carried
// through here (a missing `skills` once wiped a resume's grants on any edit).
export type Form = ResumeWriteReq & { slug: string }

export const blank = (): Form => ({
  slug: '', title: '', description: '', harness: 'claude', model: null, effort: null, can_hire: [],
  limits: { quiet_minutes: 15, max_call_minutes: 90 }, body: '', skills: [], helper: false, one_shot: false,
})
export const fromView = (r: ResumeView): Form => ({
  slug: r.slug, title: r.title, description: r.description, harness: r.harness, model: r.model, effort: r.effort,
  can_hire: [...r.can_hire], limits: { ...r.limits }, body: r.body, skills: [...(r.skills ?? [])],
  helper: !!r.helper, one_shot: !!r.one_shot,
})
