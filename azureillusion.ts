/// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./core.d.ts" />

//@ts-ignore
function init() {
    $ui.register((ctx) => {
        const TAG = "[AzureIllusion]"
        const DEFAULT_BASE = "https://azureillusion-nuvio-addon.skoruppa.workers.dev"

        // Wait a moment after the player is ready, otherwise tracks added during loading can be lost
        const INJECT_DELAY_MS = 2000

        // Menu label when the API gives no name
        const FALLBACK_NAME = "AzureIllusion"

        // The API puts a readable name in each subtitle's "id", e.g.
        //   "Miroro-sub [ASS] 12/12 WEB (05.11)"  = group [format] translated/total source (date)
        // false = the menu shows only the group name ("Miroro-sub"); the full id is used just
        //         when one group has several releases for the episode, so they can be told apart.
        // true  = always show the full id.
        const ALWAYS_SHOW_DETAILS = false

        // Remember what we already injected so one episode isn't injected twice
        let lastKey = ""

        // ---------- helpers ----------

        // Replaces the API key with [REDACTED] in anything we log
        function redact(text: string): string {
            try {
                const key = ($getUserPreference("apiKey") || "").trim()
                if (!key) return text
                return text.split(key).join("[REDACTED]")
            } catch (_) {
                return text
            }
        }

        // "Miroro-sub [ASS] 12/12 WEB (05.11)" -> "Miroro-sub"
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

        // The shape of playback info differs a bit between playback types, so check several places
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

        async function doFetch(url: string): Promise<any> {
            // ctx.fetch is the UI-context fetch; fall back to the global one
            const f = (ctx as any).fetch ?? (globalThis as any).fetch
            return await f(url)
        }

        // MpvCore / MPV: let mpv load the subtitle straight from its URL (works, shows in the menu)
        async function addViaMpv(url: string, label: string): Promise<boolean> {
            const mpv = (ctx as any).mpv
            if (!mpv || typeof mpv.getConnection !== "function") return false
            try {
                const conn = await mpv.getConnection()
                if (conn && typeof conn.command === "function") {
                    await conn.command(["sub-add", url, "select", label, "pl"])
                    return true
                }
                if (conn && typeof conn.send === "function") {
                    await conn.send(["sub-add", url, "select", label, "pl"])
                    return true
                }
            } catch (e) {
                console.error(TAG, "Błąd komunikacji z MPV:", redact(String(e)))
            }
            return false
        }

        // ---------- main logic ----------

        async function injectSubtitles() {
            try {
                const apiKey = ($getUserPreference("apiKey") || "").trim()
                const baseUrl = (($getUserPreference("baseUrl") || DEFAULT_BASE) as string).replace(/\/+$/, "")

                if (!apiKey) {
                    console.error(TAG, "Brak klucza API w ustawieniach wtyczki.")
                    return
                }

                const media: any = ctx.videoCore.getCurrentMedia()
                const info: any = ctx.videoCore.getCurrentPlaybackInfo()
                const state: any = ctx.videoCore.getPlaybackState()

                const anilistId = media?.id
                const episode = readEpisodeNumber(info, state)

                if (!anilistId || !episode) {
                    console.warn(TAG, "Nie udało się ustalić AniList ID / numeru odcinka.", anilistId, episode)
                    return
                }

                const key = `${anilistId}:${episode}`
                if (key === lastKey) return
                lastKey = key

                const isMpvCore = String(info?.target || "").toLowerCase().includes("mpv")

                const res = await doFetch(`${baseUrl}/${apiKey}/subtitles/anime/anilist:${anilistId}:${episode}.json`)
                if (!res.ok) {
                    console.error(TAG, "Błąd HTTP:", res.status)
                    lastKey = "" // allow retry
                    return
                }

                const data = await res.json()
                const subs: any[] = data?.subtitles ?? []
                if (!subs.length) {
                    ctx.videoCore.showMessage("AzureIllusion: brak napisów PL", 2500)
                    return
                }

                // How many releases each group has, to know when the group name alone is ambiguous
                const groupCounts: Record<string, number> = {}
                for (const s of subs) {
                    const g = typeof s?.id === "string" ? groupFromId(s.id) : ""
                    if (g) groupCounts[g] = (groupCounts[g] || 0) + 1
                }

                let added = 0
                const nameCount: Record<string, number> = {}

                for (const sub of subs) {
                    if (!sub?.url) continue
                    try {
                        // Label = fansub group name taken from the id. If the group has several releases
                        // (or ALWAYS_SHOW_DETAILS is on), show the full id (progress, source, date).
                        const fullId = typeof sub.id === "string" ? sub.id.trim() : ""
                        const group = fullId ? groupFromId(fullId) : ""
                        const base = !group
                            ? FALLBACK_NAME
                            : (ALWAYS_SHOW_DETAILS || groupCounts[group] > 1) ? fullId : group
                        nameCount[base] = (nameCount[base] || 0) + 1
                        const label = nameCount[base] > 1 ? `${base} #${nameCount[base]}` : base

                        // 1. MpvCore: add the track through mpv itself
                        let done = false
                        if (isMpvCore) done = await addViaMpv(sub.url, label)

                        // 2. VideoCore (or if the mpv route isn't available): download and hand over the text
                        if (!done) {
                            const subRes = await doFetch(sub.url)
                            if (!subRes.ok) {
                                console.warn(TAG, "Nie udało się pobrać napisów:", redact(sub.url), subRes.status)
                                continue
                            }
                            const text: string = await subRes.text()
                            const type = detectType(sub.url, text)
                            ctx.videoCore.addExternalSubtitleTrack({
                                label,
                                language: "pl",
                                type: type === "srt" ? "vtt" : type,
                                content: type === "srt" ? srtToVtt(text) : text,
                            })
                        }
                        added++
                    } catch (e) {
                        console.error(TAG, "Błąd przy dodawaniu ścieżki:", redact(String(e)))
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
            }
        }

        // Inject once the player is ready (after a short delay)
        ctx.videoCore.addEventListener("video-can-play", () => {
            const wait = (ctx as any).setTimeout ?? (globalThis as any).setTimeout
            wait(() => injectSubtitles(), INJECT_DELAY_MS)
        })

        // Reset on new playback so the next episode gets its subtitles
        ctx.videoCore.addEventListener("video-loaded", () => {
            lastKey = ""
        })
    })
}
