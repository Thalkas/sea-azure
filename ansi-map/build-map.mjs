// Builds the AniList-id -> ANSI2.0 series map. Run locally (Node 20+):  node build-map.mjs
// Output: ansi-map-kv.json (for `wrangler kv bulk put`) and ansi-unmatched.json (entries to check by hand).
// Resumable: progress is kept in build-map.cache.json. Polite: one request at a time with pauses.
import fs from 'node:fs'

const ANSI = 'https://ansi2-production.shisha-player.workers.dev'
const UA = 'Seanime-AzureIllusion-Addon/1.0 (personal use; small traffic)'
const DEFAULT_GROUPS = ['0-9', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'] // used only if the catalogue navigation can't be read
const PAUSE_MS = 1200 // ANSI2.0 and AniList (limit 90/min)
const CACHE = 'build-map.cache.json'
const FORMAT = { 'serial tv': ['TV', 'TV_SHORT'], ova: ['OVA'], film: ['MOVIE'], ona: ['ONA'], special: ['SPECIAL'], 'odcinek specjalny': ['SPECIAL'] }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const norm = (v) => String(v ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// One request with pauses and retries: connection resets, 429 and 5xx are retried with growing delays
async function get(url, init = {}, attempts = 6) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await sleep(PAUSE_MS * attempt * attempt)
    try {
      const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...(init.headers ?? {}) } })
      if (res.ok) return res
      lastError = new Error(`${res.status} ${url}`)
      if (res.status !== 429 && res.status < 500) throw lastError // not worth retrying (404, 403, ...)
    } catch (error) {
      lastError = error
      if (/^[34]\d\d /.test(String(error.message)) && !/^429 /.test(String(error.message))) throw error
    }
    console.warn(`retry ${attempt}/${attempts - 1}: ${lastError.cause?.code ?? lastError.message}`)
  }
  throw lastError
}

// "<a href=/anime/ID/slug> TITLE · TYPE · YEAR N pozycji napisów </a>" -> { id, slug, type, year }
export function parseCatalogue(html) {
  const out = []
  for (const m of html.matchAll(/<a\b[^>]*href="(?:https:\/\/[^"\/]+)?\/anime\/(\d+)\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const text = m[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    const parts = text.split('·').map((p) => p.trim())
    const year = /(\d{4})/.exec(parts[parts.length - 1] ?? '')?.[1]
    out.push({ id: Number(m[1]), slug: m[2], type: (parts[parts.length - 2] ?? '').toLowerCase(), year: year ? Number(year) : null, text })
  }
  return out
}

// Every group linked from the catalogue navigation ("?litera=0-9", "?litera=A", ...), so new ones are picked up automatically
export function parseGroups(html) {
  const found = [...html.matchAll(/[?&]litera=([^"&#\s]+)/g)].map((m) => decodeURIComponent(m[1].replace(/&amp;/g, '&')))
  return [...new Set(found)]
}

async function crawl() {
  const all = new Map()
  let failed = 0
  const first = await (await get(`${ANSI}/katalog?litera=A`)).text()
  const groups = parseGroups(first)
  console.log(`grupy katalogu: ${groups.length ? groups.join(' ') : 'brak, używam domyślnych'}`)
  for (const letter of groups.length ? groups : DEFAULT_GROUPS) {
    for (let page = 1; page < 200; page++) {
      let html
      try {
        html = await (await get(`${ANSI}/katalog?litera=${encodeURIComponent(letter)}&strona=${page}`)).text()
      } catch (error) {
        console.warn(`katalog ${letter} p${page}: pominięto (${error.cause?.code ?? error.message})`)
        failed++
        break
      }
      const items = parseCatalogue(html)
      const fresh = items.filter((i) => !all.has(i.id))
      fresh.forEach((i) => all.set(i.id, i))
      console.log(`katalog ${letter} p${page}: ${items.length} (${fresh.length} new)`)
      if (!items.length || !fresh.length || !html.includes('strona=' + (page + 1))) break
    }
  }
  if (failed) console.warn(`UWAGA: ${failed} stron katalogu pominięto, lista może być niepełna (poprzednie wpisy zostaną zachowane)`)
  return [...all.values()]
}

// Candidate shape used by pick(): { id (AniList id), format, year, titles: [..] }
const ANILIST_QUERY = `query($q:String){Page(perPage:10){media(search:$q,type:ANIME){id format seasonYear startDate{year} title{romaji english native} synonyms}}}`

async function searchAniList(q) {
  const res = await get('https://graphql.anilist.co', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: ANILIST_QUERY, variables: { q } }) })
  return (await res.json()).data.Page.media.map((m) => ({
    id: m.id,
    format: m.format,
    year: m.seasonYear ?? m.startDate?.year ?? null,
    titles: [m.title?.romaji, m.title?.english, m.title?.native, ...(m.synonyms ?? [])],
  }))
}

// Kitsu is public (no key). The AniList id comes from its "mappings".
const KITSU_FORMAT = { TV: 'TV', ova: 'OVA', movie: 'MOVIE', ONA: 'ONA', special: 'SPECIAL', OVA: 'OVA' }
async function searchKitsu(q) {
  const url = `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(q)}&include=mappings&page[limit]=10`
  const body = await (await get(url, { headers: { Accept: 'application/vnd.api+json' } })).json()
  const mappings = new Map((body.included ?? []).filter((i) => i.type === 'mappings').map((i) => [i.id, i.attributes]))
  return (body.data ?? []).flatMap((anime) => {
    const ids = (anime.relationships?.mappings?.data ?? []).map((r) => mappings.get(r.id)).filter((m) => m?.externalSite === 'anilist/anime')
    const anilistId = ids[0]?.externalId
    if (!anilistId) return []
    const a = anime.attributes
    return [{
      id: Number(anilistId),
      format: KITSU_FORMAT[a.subtype] ?? null,
      year: a.startDate ? Number(a.startDate.slice(0, 4)) : null,
      titles: [a.canonicalTitle, ...Object.values(a.titles ?? {}), ...(a.abbreviatedTitles ?? [])],
    }]
  })
}

// Exactly one candidate whose title equals the slug title, in the same year (and format when known) -> accept
export function pick(entry, candidates) {
  const want = norm(entry.slug.replace(/-/g, ' '))
  const formats = FORMAT[entry.type]
  const good = candidates.filter((c) =>
    c.titles.map(norm).includes(want) &&
    (!entry.year || !c.year || c.year === entry.year) &&
    (!formats || !c.format || formats.includes(c.format)))
  return good.length === 1 ? good[0] : null
}

// RESOLVER=kitsu (default) or anilist. AniList is tried second when Kitsu has no confident match.
const RESOLVERS = (process.env.RESOLVER ?? 'kitsu').split(',').map((r) => r.trim()).filter(Boolean)
const SEARCH = { kitsu: searchKitsu, anilist: searchAniList }

async function resolve(entry) {
  const q = entry.slug.replace(/-/g, ' ')
  let lastError = null
  for (const name of RESOLVERS) {
    try {
      const hit = pick(entry, await SEARCH[name](q))
      if (hit) return hit.id
    } catch (e) { lastError = e }
  }
  if (lastError && RESOLVERS.length === 1) throw lastError
  return null
}

const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : { entries: null, resolved: {} }
// REFRESH=1: crawl the catalogue again (new series appear over time) and retry entries that had no match
if (!cache.entries || process.env.REFRESH) {
  try {
    const fresh = await crawl()
    // keep entries from earlier runs so a partial crawl never shrinks the map
    cache.entries = [...new Map([...(cache.entries ?? []), ...fresh].map((e) => [e.id, e])).values()]
    for (const [id, value] of Object.entries(cache.resolved)) if (value === null) delete cache.resolved[id]
    fs.writeFileSync(CACHE, JSON.stringify(cache))
  } catch (error) {
    // A failed refresh must not throw away what we already know
    if (!cache.entries) throw error
    console.warn(`odświeżenie katalogu nie powiodło się (${error.cause?.code ?? error.message}), używam zapisanej listy (${cache.entries.length})`)
  }
}

for (const [n, entry] of cache.entries.entries()) {
  if (cache.resolved[entry.id] !== undefined) continue
  try {
    cache.resolved[entry.id] = (await resolve(entry)) ?? null
  } catch (e) { console.warn('skip', entry.slug, e.message); continue }
  if (n % 25 === 0) { fs.writeFileSync(CACHE, JSON.stringify(cache)); console.log(`${n}/${cache.entries.length}`) }
}
fs.writeFileSync(CACHE, JSON.stringify(cache))

// One KV key per AniList id. When several ANSI2.0 series map to the same AniList id the match is ambiguous:
// none of them goes to KV, they are listed in ansi-duplicates.json for a manual decision (like ansi-unmatched.json).
const byAnilist = new Map(), unmatched = []
for (const e of cache.entries) {
  const al = cache.resolved[e.id]
  if (al) byAnilist.set(String(al), [...(byAnilist.get(String(al)) ?? []), { id: e.id, slug: e.slug, type: e.type, year: e.year }])
  else unmatched.push({ id: e.id, slug: e.slug, type: e.type, year: e.year })
}
const kv = [], duplicates = []
for (const [key, list] of byAnilist) {
  if (list.length === 1) kv.push({ key, value: JSON.stringify({ id: list[0].id, slug: list[0].slug }) })
  else duplicates.push({ anilistId: key, series: list })
}
for (const d of duplicates) console.log(`duplikat: AniList ${d.anilistId} <- ${d.series.map((x) => x.slug).join(' | ')}`)
fs.writeFileSync('ansi-duplicates.json', JSON.stringify(duplicates, null, 1))
fs.writeFileSync('ansi-map-kv.json', JSON.stringify(kv))
fs.writeFileSync('ansi-unmatched.json', JSON.stringify(unmatched, null, 1))
console.log(`matched ${kv.length}, duplicates ${duplicates.length} (${duplicates.reduce((n, d) => n + d.series.length, 0)} serii), unmatched ${unmatched.length}`)
