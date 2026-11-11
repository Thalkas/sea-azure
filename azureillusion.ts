/// <reference path="../../core.d.ts" />
/// <reference path="../../plugin.d.ts" />
/// <reference path="../../app.d.ts" />
/// <reference path="../../system.d.ts" />

//@ts-ignore
function init() {
    $ui.register((ctx) => {
        const apiKey = $getUserPreference("apiKey");
        const baseUrl = $getUserPreference("baseUrl") || "https://azureillusion-nuvio-addon.skoruppa.workers.dev";

        if (!apiKey) {
            console.log("[AzureIllusion] Brak klucza API w preferencjach.");
            return;
        }

        console.log("[AzureIllusion] Wtyczka załadowana pomyślnie.");
    });
}
