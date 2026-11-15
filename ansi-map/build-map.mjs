// Builds the AniList-id -> ANSI2.0 series map. Run locally (Node 20+):  node build-map.mjs
// Output: ansi-map-kv.json (for `wrangler kv bulk put`) and ansi-unmatched.json (entries to check by hand).
// Resumable: progress is kept in build-map.cache.json. Polite: one request at a time with pauses.
import fs from 'node:fs'

const ANSI = 'https://ansi2-production.shisha-player.workers.dev'
const UA = 'Seanime-AzureIllusion-Addon/1.0 (personal use; small traffic)'
const LETTERS = ['0-9', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'] // add '0-9' style letters if the catalogue lists them
const PAUSE_MS = 1200 // ANSI2.0 and AniList (limit 90/min)
const CACHE = 'build-map.cache.json'
const FORMAT = { 'serial tv': ['TV', 'TV_SHORT'], ova: ['OVA'], film: ['MOVIE'], ona: ['ONA'], special: ['SPECIAL'], 'odcinek specjalny': ['SPECIAL'] }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const norm = (v) => String(v ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

async function get(url, init = {}) {
  await sleep(PAUSE_MS)
  const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...(init.headers ?? {}) } })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res
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

async function crawl() {
  const all = new Map()
  for (const letter of LETTERS) {
    for (let page = 1; page < 200; page++) {
      const html = await (await get(`${ANSI}/katalog?litera=${letter}&strona=${page}`)).text()
      const items = parseCatalogue(html)
      const fresh = items.filter((i) => !all.has(i.id))
      fresh.forEach((i) => all.set(i.id, i))
      console.log(`katalog ${letter} p${page}: ${items.length} (${fresh.length} new)`)
      if (!items.length || !fresh.length || !html.includes('strona=' + (page + 1))) break
    }
  }
  return [...all.values()]
}

const QUERY = `query($q:String){Page(perPage:10){media(search:$q,type:ANIME){id format seasonYear startDate{year} title{romaji english native} synonyms}}}`

// Exactly one candidate whose title equals the slug title, in the same year (and format when known) -> accept
export function pick(entry, candidates) {
  const want = norm(entry.slug.replace(/-/g, ' '))
  const formats = FORMAT[entry.type]
  const good = candidates.filter((c) => {
    const titles = [c.title?.romaji, c.title?.english, c.title?.native, ...(c.synonyms ?? [])].map(norm)
    const year = c.seasonYear ?? c.startDate?.year
    return titles.includes(want) && (!entry.year || !year || year === entry.year) && (!formats || !c.format || formats.includes(c.format))
  })
  return good.length === 1 ? good[0] : null
}

async function anilist(q) {
  const res = await get('https://graphql.anilist.co', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: QUERY, variables: { q } }) })
  return (await res.json()).data.Page.media
}

const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : { entries: null, resolved: {} }
// REFRESH=1: crawl the catalogue again (new series appear over time) and retry entries that had no match
if (!cache.entries || process.env.REFRESH) {
  cache.entries = await crawl()
  for (const [id, value] of Object.entries(cache.resolved)) if (value === null) delete cache.resolved[id]
  fs.writeFileSync(CACHE, JSON.stringify(cache))
}

for (const [n, entry] of cache.entries.entries()) {
  if (cache.resolved[entry.id] !== undefined) continue
  try {
    const hit = pick(entry, await anilist(entry.slug.replace(/-/g, ' ')))
    cache.resolved[entry.id] = hit ? hit.id : null
  } catch (e) { console.warn('skip', entry.slug, e.message); continue }
  if (n % 25 === 0) { fs.writeFileSync(CACHE, JSON.stringify(cache)); console.log(`${n}/${cache.entries.length}`) }
}
fs.writeFileSync(CACHE, JSON.stringify(cache))

const kv = [], unmatched = []
for (const e of cache.entries) {
  const al = cache.resolved[e.id]
  if (al) kv.push({ key: String(al), value: JSON.stringify({ id: e.id, slug: e.slug }) })
  else unmatched.push({ id: e.id, slug: e.slug, type: e.type, year: e.year })
}
fs.writeFileSync('ansi-map-kv.json', JSON.stringify(kv))
fs.writeFileSync('ansi-unmatched.json', JSON.stringify(unmatched, null, 1))
console.log(`matched ${kv.length}, unmatched ${unmatched.length}`)
