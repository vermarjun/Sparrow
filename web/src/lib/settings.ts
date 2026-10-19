import type { SettingField } from '@shared/types'

/** Settings page check (the server checks again): a whole number within the field's range. Null = fine. */
export function fieldError(f: Pick<SettingField, 'min' | 'max' | 'unit'>, text: string): string | null {
  if (!/^-?\d+$/.test(text.trim())) return `a whole number (${f.unit})`
  const n = Number(text)
  if (n < f.min || n > f.max) return `between ${f.min} and ${f.max}`
  return null
}
