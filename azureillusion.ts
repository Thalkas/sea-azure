// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./core.d.ts" />

//@ts-ignore
function init() {
    $ui.register((ctx) => {
        const TAG = "[AzureIllusion]"
        const DEFAULT_BASE = "https://azureillusion-nuvio-addon.skoruppa.workers.dev"
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

        async function doFetch(url: string): Promise<any> {
            const f = (ctx as any).fetch ?? (globalThis as any).fetch
            return await f(url)
        }

        async function injectSubtitles() {
            if (isInjecting) return
            isInjecting = true

            try {
                const apiKey = ($getUserPreference("apiKey") || "").trim()
                const baseUrl = (($getUserPreference("baseUrl") || DEFAULT_BASE) as string).replace(/\/+$/, "")

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

                const url = `${baseUrl}/${apiKey}/subtitles/anime/anilist:${anilistId}:${episode}.json`
                const res = await doFetch(url)
                
                if (!res || !res.ok) {
                    lastKey = ""
                    return
                }

                const data = await res.json()
                const subs: any[] = data?.subtitles ?? []
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
                        const subRes = await doFetch(sub.url)
                        if (!subRes.ok) continue

                        const text: string = await subRes.text()
                        const type = detectType(sub.url, text)
                        const fullId = typeof sub.id === "string" ? sub.id.trim() : ""
                        const group = fullId ? groupFromId(fullId) : ""
                        const base = !group
                            ? FALLBACK_NAME
                            : (ALWAYS_SHOW_DETAILS || groupCounts[group] > 1) ? fullId : group
                        nameCount[base] = (nameCount[base] || 0) + 1
                        const label = nameCount[base] > 1 ? `${base} #${nameCount[base]}` : base

                        // 1. Wstrzykiwanie przez MPV IPC (jeśli odtwarzacz to mpvcore)
                        let mpvInjected = false
                        if (isMpvCore && ctx.mpv && typeof ctx.mpv.getConnection === "function") {
                            try {
                                const mpvConn = await ctx.mpv.getConnection()
                                if (mpvConn && typeof mpvConn.command === "function") {
                                    await mpvConn.command(["sub-add", sub.url, "select", label, "pl"])
                                    mpvInjected = true
                                } else if (mpvConn && typeof mpvConn.send === "function") {
                                    await mpvConn.send(["sub-add", sub.url, "select", label, "pl"])
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
                                    url: sub.url,
                                    uri: sub.url,
                                    sourceUrl: sub.url,
                                    src: sub.url,
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
