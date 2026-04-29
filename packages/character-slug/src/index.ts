import * as R from 'ramda'

export interface EveCharacter {
  readonly characterId: number
  readonly characterName: string
  readonly owner: string
}

// EVE character names allow spaces, apostrophes, hyphens, and some unicode.
// ATProto handles must be valid DNS labels (RFC 1123): lowercase alphanumeric
// and hyphens, no leading/trailing hyphen, max 63 chars per label.
const toAsciiLower: (s: string) => string = R.pipe(
  R.toLower,
  (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, ''),
)

const removeApostrophes: (s: string) => string = R.replace(/['']/g, '')
const replaceInvalid: (s: string) => string = R.replace(/[^a-z0-9]+/g, '-')
const trimHyphens: (s: string) => string = R.replace(/^-+|-+$/g, '')
const truncate63: (s: string) => string = R.take(63) as (s: string) => string

export const slugifyCharacterName: (name: string) => string = R.pipe(
  toAsciiLower,
  removeApostrophes,
  replaceInvalid,
  trimHyphens,
  truncate63,
  trimHyphens,
)

export const handleFor: (pdsServiceLevelDomains: string, name: string) => string = R.curry(
  (pdsServiceLevelDomains: string, name: string): string =>
    `${slugifyCharacterName(name)}${pdsServiceLevelDomains}`,
)

// Fallback if two characters slugify to the same label - append numeric ID.
export const handleForWithId: (pdsServiceLevelDomains: string, char: EveCharacter) => string = R.curry(
  (pdsServiceLevelDomains: string, char: EveCharacter): string => {
    const base = slugifyCharacterName(char.characterName)
    const maxBase = 63 - String(char.characterId).length - 1
    const truncated = base.slice(0, maxBase).replace(/-+$/, '')
    return `${truncated}-${char.characterId}${pdsServiceLevelDomains}`
  },
)
