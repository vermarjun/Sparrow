// Mirror of renderResumeText in src/server/resumes.ts (web cannot import server code): keep the two in step.
// Fills {{harness}} {{model}} {{effort}} {{runtime}} from a resume's current settings; unknown {{x}} stay as is.
export const RESUME_VARS = ['{{harness}}', '{{model}}', '{{effort}}', '{{runtime}}'] as const

export function renderResumeText(text: string, s: { harness: string; model?: string | null; effort?: string | null }): string {
  const model = s.model || 'harness default'
  const effort = s.effort || 'default'
  const vars: Record<string, string> = { harness: s.harness, model, effort, runtime: `${s.harness} · ${model} · effort ${effort}` }
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (all, k: string) => (Object.hasOwn(vars, k) ? vars[k] : all))
}
