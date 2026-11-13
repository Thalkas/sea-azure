/// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./core.d.ts" />

//@ts-ignore
function init() {
    $ui.register((ctx) => {
        const TAG = "[AzureIllusion]"
        // Talks to the AzureIllusion API directly (no Nuvio addon / worker in between)
        const API_BASE = "https://subs.azureillusion.ovh"
        const MAX_TRACKS = 8
        // Drop releases the catalogue filed under the wrong anime (side stories, spin-offs)
        const FILTER_SIDE_STORIES = true
        const ANIMAP_URL = "https://animap.id/api/anilist"
        const SIDE_RELATIONS = ["SIDE_STORY", "SPIN_OFF", "SUMMARY", "ALTERNATIVE", "OTHER", "COMPILATION"]
        const INJECT_DELAY_MS = 2000

        const FALLBACK_NAME = "AzureIllusion"
        const ALWAYS_SHOW_DETAILS = false

        let lastKey = ""
        let isInjecting = false

        // Maskowanie klucza API w logach
        function redact(text: string): string {
            try {
                const key = ($getUserPreference("apiKey") || "").trim()
                if (!key) return text
                return text.split(key).join("[REDACTED]")
            } catch (_) {
                return text
            }
        }

        function groupFromId(id: string): string {
            return id.replace(/\s*\[(ASS|SSA|SRT)\].*$/i, "").trim()
        }

        function srtToVtt(srt: string): string {
            const body = srt
                .replace(/^﻿/, "")
                .replace(/\r+\n/g, "\n")
                .replace(/\r/g, "\n")
                .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
            return "WEBVTT\n\n" + body
        }
        
        function detectType(url: string, content: string): "ass" | "vtt" | "srt" {
            const clean = (url || "").split("?")[0].toLowerCase()
            if (clean.endsWith(".ass") || clean.endsWith(".ssa")) return "ass"
            if (clean.endsWith(".vtt")) return "vtt"
            if (clean.endsWith(".srt")) return "srt"
            const head = (content || "").slice(0, 200)
            if (head.includes("[Script Info]")) return "ass"
            if (head.trim().startsWith("WEBVTT")) return "vtt"
            return "srt"
        }

        function readEpisodeNumber(info: any, state: any): number | null {
            const candidates = [
                info?.episode?.progressNumber,
                info?.episode?.episodeNumber,
                info?.episodeNumber,
                state?.playbackInfo?.episode?.progressNumber,
                state?.playbackInfo?.episode?.episodeNumber,
                state?.playbackInfo?.episodeNumber,
            ]
            for (const c of candidates) {
                const n = Number(c)
                if (c !== undefined && c !== null && !isNaN(n) && n > 0) return n
            }
            return null
        }

        // Video source the release is synced to, as named in its filename
        function releaseSource(filename: string): string | null {
            const has = (pattern: string) =>
                new RegExp(`(^|[^a-z0-9])(${pattern})([^a-z0-9]|$)`, "i").test(filename)
            if (has("BD|BDRip|Blu-?Ray|BDMV")) return "BD"
            if (has("WEB|WEB-?DL|WEB-?Rip|CR|AMZN|NF|SubsPlease|Erai-raws")) return "WEB"
            if (has("DVD|DVDRip")) return "DVD"
            if (has("HDTV|TV")) return "TV"
            return null
        }

        // ---------- side stories + matching the played file (ported from the worker) ----------

        function normalizeTitle(value: string): string {
            return String(value ?? "")
                .normalize("NFKD")
                .replace(/[̀-ͯ]/g, "")
                .toLowerCase()
                .replace(/[^\p{L}\p{N}]+/gu, " ")
                .trim()
        }

        function normalizeAll(titles: any[]): string[] {
            return titles.filter(Boolean).map(normalizeTitle).filter(Boolean)
        }

        // "[Demo Subs] Kage-Jitsu! 2nd 01 [BD 1080p].ass" -> "kage jitsu 2nd"
        function releaseTitle(filename: string, groupName: string | null): string {
            let text = filename
                .replace(/\.[a-z0-9]{2,4}$/i, "")
                .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
                .replace(/[_.]+/g, " ")
            text = text.replace(/(^|\s)(-\s*)?(S\d+)?E?\d{1,4}(v\d)?(\s.*|$)/i, " ")
            let title = normalizeTitle(text)
            const group = groupName ? normalizeTitle(groupName) : ""
            if (group && title.startsWith(group + " ")) title = title.slice(group.length + 1)
            return title
        }

        // Plain fetch for third-party hosts: never sends the AzureIllusion key
        async function plainGet(url: string): Promise<any> {
            const f = (ctx as any).fetch ?? (globalThis as any).fetch
            const res = await f(url)
            if (!res.ok) throw new Error(`HTTP ${res?.status}`)
            return res.json()
        }

        // Titles of side stories / spin-offs of this anime (from the animap.id AniList mirror), cached per session
        const titlesCache: Record<string, any> = {}
        async function getSideStoryTitles(anilistId: number): Promise<any> {
            if (titlesCache[anilistId] !== undefined) return titlesCache[anilistId]
            const raw = await plainGet(`${ANIMAP_URL}/${anilistId}/raw`)
            const media = raw?.data?.Media ?? raw
            if (!media?.title) return null
            const own = normalizeAll([media.title.romaji, media.title.english, media.title.native, ...(media.synonyms ?? [])])
            const sideIds = (media.relations?.edges ?? [])
                .filter((e: any) => SIDE_RELATIONS.includes(e.relationType) && e.node?.type === "ANIME" && e.node?.id)
                .map((e: any) => e.node.id)
            const related = await Promise.all(sideIds.map((id: any) => plainGet(`${ANIMAP_URL}/${id}`).catch(() => null)))
            const sideTitles = related
                .filter(Boolean)
                .flatMap((e: any) => normalizeAll([e.title_romaji, e.title_english, e.title_native, ...(e.synonyms ?? [])]))
                .filter((t: string) => !own.some((o) => o === t || o.startsWith(t + " ")))
            const result = { own, sideTitles: Array.from(new Set(sideTitles)) }
            titlesCache[anilistId] = result
            return result
        }

        function isSideStoryRelease(release: any, titles: any): boolean {
            if (!titles || !release.filename) return false
            const title = releaseTitle(release.filename, release.group)
            return !!title && titles.sideTitles.includes(title) && !titles.own.includes(title)
        }

        // Name of the file being played, if Seanime exposes one (used to prefer subtitles synced to it)
        function readPlayedFilename(info: any, state: any): string | null {
            const candidates = [
                info?.filename, info?.fileName, info?.localFile?.path, info?.localFile?.name,
                info?.path, info?.filepath, info?.torrent?.name, info?.episode?.localFile?.path,
                state?.playbackInfo?.filename, state?.playbackInfo?.localFile?.path,
            ]
            for (const c of candidates) {
                if (typeof c === "string" && c.trim()) return c.split(/[\\/]/).pop() as string
            }
            return null
        }

        // Raw release group ("[SubsPlease] ...") and source of the played file
        function videoHints(filename: string | null): any {
            if (!filename) return null
            const group = /^\s*\[([^\]]+)\]/.exec(filename)?.[1]
            return { group: group ? normalizeTitle(group) : null, source: releaseSource(filename) }
        }

        // Same raw release (+2) or at least the same source (+1) = likely in sync
        function matchScore(release: any, hints: any): number {
            if (!hints || !release.filename) return 0
            let score = 0
            if (hints.group && ` ${normalizeTitle(release.filename)} `.includes(` ${hints.group} `)) score += 2
            if (hints.source && releaseSource(release.filename) === hints.source) score += 1
            return score
        }

        // ---------- AzureIllusion API ----------

        function apiFetch(url: string, apiKey: string): Promise<any> {
            // ctx.fetch is the UI-context fetch; fall back to the global one
            const f = (ctx as any).fetch ?? (globalThis as any).fetch
            return f(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } })
        }

        // Every JSON answer is wrapped as { ok, data } or { ok: false, error: { message } }
        async function apiGet(path: string, apiKey: string): Promise<any> {
            const res = await apiFetch(API_BASE + path, apiKey)
            let envelope: any = null
            try {
                envelope = await res.json()
            } catch (_) {
                // not JSON, handled below
            }
            if (!res.ok || envelope?.ok !== true) {
                const err: any = new Error(envelope?.error?.message ?? `API HTTP ${res?.status}`)
                err.status = res?.status
                throw err
            }
            return envelope.data
        }

        async function searchReleases(anilistId: number, episode: number, apiKey: string): Promise<any[]> {
            const data = await apiGet(
                `/api/public/v1/subtitles/search?anilistId=${anilistId}&episode=${episode}` +
                `&format=${encodeURIComponent("ASS,SRT")}&limit=100`,
                apiKey,
            )
            return (data?.releases ?? [])
                .map((r: any) => ({
                    id: r.id,
                    format: String(r.format ?? "").toUpperCase(),
                    group: r.group?.name ?? null,
                    groupSlug: r.group?.slug ?? null,
                    filename: r.filename ?? "",
                    sizeBytes: Number(r.sizeBytes) || 0,
                    publishedAt: r.publishedAt ?? null,
                    language: String(r.language ?? "pl").toLowerCase(),
                }))
                .filter((r: any) => r.language.startsWith("pl"))
                .filter((r: any) => r.id && (r.format === "ASS" || r.format === "SSA" || r.format === "SRT"))
        }

        // Per-group translation progress ("12/12"), keyed by release id and group slug. Optional.
        async function getProgress(anilistId: number, apiKey: string): Promise<any> {
            const data = await apiGet(`/api/public/v1/anime/${anilistId}/subtitles`, apiKey)
            const byRelease: Record<string, any> = {}
            const byGroup: Record<string, any> = {}
            for (const pkg of data?.packages ?? []) {
                const progress = {
                    translated: Number(pkg.translatedEpisodes) || 0,
                    total: Number(pkg.totalEpisodes) || 0,
                    percent: Number(pkg.progressPercent) || 0,
                }
                if (pkg.group?.slug && !byGroup[pkg.group.slug]) byGroup[pkg.group.slug] = progress
                for (const rel of pkg.releases ?? []) byRelease[rel.id] = progress
            }
            return { byRelease, byGroup }
        }

        function progressFor(progress: any, release: any): any {
            return progress?.byRelease?.[release.id]
                ?? (release.groupSlug ? progress?.byGroup?.[release.groupSlug] : null)
                ?? null
        }

        // Complete translations first, then the API's group order; within a group the larger file first
        function orderReleases(releases: any[], progress: any, hints: any): any[] {
            const keyOf = (r: any) => `${r.groupSlug ?? r.group}|${r.format}`
            const order: string[] = []
            const byGroup: Record<string, any[]> = {}
            for (const r of releases) {
                const k = keyOf(r)
                if (!byGroup[k]) {
                    byGroup[k] = []
                    order.push(k)
                }
                byGroup[k].push(r)
            }
            const ordered: any[] = []
            for (const k of order) {
                ordered.push(...byGroup[k].slice().sort((a, b) => b.sizeBytes - a.sizeBytes))
            }
            const complete = ordered.filter((r) => (progressFor(progress, r)?.percent ?? 0) >= 100)
            const byProgress = [...complete, ...ordered.filter((r) => !complete.includes(r))]
            // Releases matching the played file come first, even from groups that aren't finished
            return byProgress
                .map((release, index) => ({ release, index, score: matchScore(release, hints) }))
                .sort((a, b) => b.score - a.score || a.index - b.index)
                .map((x) => x.release)
        }

        // Downloads the subtitle file (the API wants the key in a header, so the player can't do it itself)
        async function downloadFile(releaseId: string, apiKey: string): Promise<string> {
            const res = await apiFetch(
                `${API_BASE}/api/public/v1/subtitles/file?type=subtitle&id=${encodeURIComponent(releaseId)}`,
                apiKey,
            )
            if (!res.ok) throw new Error(`HTTP ${res?.status}`)
            return await res.text()
        }

        async function injectSubtitles() {
            if (isInjecting) return
            isInjecting = true

            try {
                const apiKey = ($getUserPreference("apiKey") || "").trim()

                if (!apiKey) {
                    console.error(TAG, "Brak klucza API w ustawieniach wtyczki.")
                    return
                }

                const media: any = ctx.videoCore?.getCurrentMedia()
                const info: any = ctx.videoCore?.getCurrentPlaybackInfo()
                const state: any = ctx.videoCore?.getPlaybackState()

                if (!media || !info) return

                const anilistId = media?.id
                const episode = readEpisodeNumber(info, state)

                if (!anilistId || !episode) return

                const key = `${anilistId}:${episode}`
                if (key === lastKey) return
                lastKey = key

                const targetStr = String(info?.target || "").toLowerCase().trim()
                const isMpvCore = targetStr.includes("mpv") || info?.player === "mpv" || (ctx as any).currentVideoPlayer === "mpvcore"
                console.log(TAG, "diag:", JSON.stringify({
                    target: targetStr,
                    isMpvCore,
                    hasMpv: !!(ctx as any).mpv,
                    getConnection: typeof (ctx as any).mpv?.getConnection,
                }))

                // Ask the API (search + optional progress), then build the same list the worker used to return
                let releases: any[] = []
                let progress: any = null
                try {
                    const [found, prog] = await Promise.all([
                        searchReleases(anilistId, episode, apiKey),
                        getProgress(anilistId, apiKey).catch(() => null), // only improves ordering/labels
                    ])
                    releases = found
                    progress = prog
                } catch (e: any) {
                    lastKey = ""
                    if (e?.status === 401) ctx.videoCore.showMessage("AzureIllusion: nieprawidłowy klucz API", 3000)
                    console.error(TAG, "Błąd API:", redact(String(e?.message ?? e)))
                    return
                }

                // Burned-in Polish subtitles (Docchi streams end with .docc): nothing to add
                const played = readPlayedFilename(info, state)
                if (played && played.endsWith(".docc")) return

                if (FILTER_SIDE_STORIES) {
                    const titles = await getSideStoryTitles(anilistId).catch(() => null) // optional
                    releases = releases.filter((r) => !isSideStoryRelease(r, titles))
                }

                const ordered = orderReleases(releases, progress, videoHints(played)).slice(0, MAX_TRACKS)

                const perGroup: Record<string, number> = {}
                for (const r of ordered) {
                    const k = `${r.groupSlug ?? r.group}|${r.format}`
                    perGroup[k] = (perGroup[k] || 0) + 1
                }

                const subs: any[] = ordered.map((r) => {
                    const group = (r.group || FALLBACK_NAME).slice(0, 60)
                    const p = progressFor(progress, r)
                    const episodes = p ? (p.total ? ` ${p.translated}/${p.total}` : ` ${p.translated} odc.`) : ""
                    const source = releaseSource(r.filename)
                    let id = `${group} [${r.format}]${episodes}${source ? " " + source : ""}`
                    if (perGroup[`${r.groupSlug ?? r.group}|${r.format}`] > 1 && r.publishedAt) {
                        const d = new Date(r.publishedAt)
                        if (!isNaN(d.getTime())) id += ` (${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")})`
                    }
                    return {
                        id: r.group ? id : "",
                        format: r.format,
                        url: `${API_BASE}/api/public/v1/subtitles/file?type=subtitle&id=${encodeURIComponent(r.id)}`,
                    }
                })
                if (!subs.length) {
                    ctx.videoCore.showMessage("AzureIllusion: brak napisów PL", 2500)
                    return
                }

                let added = 0
                const nameCount: Record<string, number> = {}
                const groupCounts: Record<string, number> = {}

                for (const s of subs) {
                    const g = typeof s?.id === "string" ? groupFromId(s.id) : ""
                    if (g) groupCounts[g] = (groupCounts[g] || 0) + 1
                }
                
                for (const sub of subs) {
                    if (!sub?.url) continue
                    try {
                        const subRes = await apiFetch(sub.url, apiKey)
                        if (!subRes.ok) continue

                        const text: string = await subRes.text()
                        const type = detectType("file." + String(sub.format).toLowerCase(), text)
                        const fullId = typeof sub.id === "string" ? sub.id.trim() : ""
                        const group = fullId ? groupFromId(fullId) : ""
                        const base = !group
                            ? FALLBACK_NAME
                            : (ALWAYS_SHOW_DETAILS || groupCounts[group] > 1) ? fullId : group
                        nameCount[base] = (nameCount[base] || 0) + 1
                        const label = nameCount[base] > 1 ? `${base} #${nameCount[base]}` : base

                        // The API wants the key in a header, so mpv gets the text itself (memory://)
                        const mpvSource = "memory://" + text.replace(/^\uFEFF/, "")

                        // 1. Wstrzykiwanie przez MPV IPC (jeśli odtwarzacz to mpvcore)
                        let mpvInjected = false
                        if (isMpvCore && ctx.mpv && typeof ctx.mpv.getConnection === "function") {
                            try {
                                const mpvConn = await ctx.mpv.getConnection()
                                console.log(TAG, "diag conn:", typeof mpvConn, mpvConn ? Object.keys(mpvConn).join(",") : "")
                                if (mpvConn && typeof mpvConn.command === "function") {
                                    await mpvConn.command(["sub-add", mpvSource, "select", label, "pl"])
                                    mpvInjected = true
                                } else if (mpvConn && typeof mpvConn.send === "function") {
                                    await mpvConn.send(["sub-add", mpvSource, "select", label, "pl"])
                                    mpvInjected = true
                                }
                            } catch (mpvErr) {
                                console.error(TAG, "Błąd IPC MPV:", redact(String(mpvErr)))
                            }
                        }

                        // 2. Fallback na standardowy VideoCore
                        if (!mpvInjected) {
                            if (isMpvCore) {
                                ctx.videoCore.addExternalSubtitleTrack({
                                    label,
                                    language: "pl",
                                    type: type === "srt" ? "vtt" : type,
                                    format: type === "srt" ? "vtt" : type,
                                    url: mpvSource,
                                    uri: mpvSource,
                                    sourceUrl: mpvSource,
                                    src: mpvSource,
                                } as any)
                            } else {
                                ctx.videoCore.addExternalSubtitleTrack({
                                    label,
                                    language: "pl",
                                    type: type === "srt" ? "vtt" : type,
                                    content: type === "srt" ? srtToVtt(text) : text,
                                })
                            }
                        }

                        added++
                    } catch (e) {
                        console.error(TAG, "Błąd dodawania ścieżki:", redact(String(e)))
                    }
                }

                if (added > 0) {
                    ctx.videoCore.showMessage(`AzureIllusion: dodano napisy PL (${added})`, 2500)
                } else {
                    lastKey = ""
                }
            } catch (err) {
                console.error(TAG, "Wyjątek:", redact(String(err)))
                lastKey = ""
            } finally {
                isInjecting = false
            }
        }

        ctx.videoCore.addEventListener("video-can-play", () => {
            const wait = (ctx as any).setTimeout ?? (globalThis as any).setTimeout
            wait(() => injectSubtitles(), INJECT_DELAY_MS)
        })

        ctx.videoCore.addEventListener("video-loaded", () => {
            lastKey = ""
        })

        console.log(TAG, "Wtyczka załadowana pomyślnie.")
    })
}
