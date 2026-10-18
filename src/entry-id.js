/** Shared content IDs; preserve source spelling and never normalize stored keys. */
export const ENTRY_ID_SOURCE = '[\\p{L}\\p{N}\\p{M}_$-]+'

const ENTRY_ID_RE = new RegExp('^(?:' + ENTRY_ID_SOURCE + ')$', 'u')
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])

export function isEntryId(value) {
  return typeof value === 'string' && ENTRY_ID_RE.test(value) && !RESERVED.has(value)
}
