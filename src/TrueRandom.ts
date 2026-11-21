
import { Debug } from "./Debug.js";
import { RandomAPI } from "./RandomAPI.js";
import { JsonRPCRequest } from './JsonRPC';
import { LocalStorage } from './BrowserConfig.js';

declare var Hooks;
declare var game;
declare var CONFIG;
declare var ChatMessage;
declare var ui;

export class TrueRandom {
    /** Backoff added per consecutive failure before another refill is attempted. */
    public static readonly RetryDelayMs: number = 30_000;
    /** Ceiling for the failure backoff. */
    public static readonly MaxRetryDelayMs: number = 300_000;

    public RandomNumbers: number[] = [];
    public RandomGenerator: RandomAPI | null = null;
    public AwaitingResponse: boolean;
    public MaxCachedNumbers: number;
    public UpdatePoint: number;
    public HasAlerted: boolean;
    public LastRandomNumber: number;
    /** Consecutive failed random.org fetches. Reset to 0 by the next success. */
    public ApiFailureCount: number;
    /** Set once per outage so a broken API produces one notification, not one per refill attempt. */
    public HasNotifiedApiFailure: boolean;
    /** Set once per key so a low-quota warning doesn't fire on every refill. */
    public HasNotifiedLowQuota: boolean;
    /** True when a failure notice was raised but could not be displayed (e.g. before 'ready'). */
    public PendingApiFailureNotice: boolean;
    /** Epoch ms before which no refill is attempted, so a broken API isn't hammered once per roll. */
    public NextRetryTime: number;

    constructor() {
        this.AwaitingResponse = false;
        this.MaxCachedNumbers = 50;
        this.UpdatePoint = 0.5;
        this.HasAlerted = false;
        this.LastRandomNumber = Math.random();
        this.ApiFailureCount = 0;
        this.HasNotifiedApiFailure = false;
        this.HasNotifiedLowQuota = false;
        this.PendingApiFailureNotice = false;
        this.NextRetryTime = 0;
    }

    public UpdateAPIKey(key: string): void {
        this.RandomGenerator = new RandomAPI(key);
        // a new key deserves a fresh set of warnings
        this.HasAlerted = false;
        this.ApiFailureCount = 0;
        this.HasNotifiedApiFailure = false;
        this.HasNotifiedLowQuota = false;
        this.PendingApiFailureNotice = false;
        // a corrected key should be tried at once rather than sitting out the previous backoff
        this.NextRetryTime = 0;
        this.UpdateRandomNumbers();
    }

    /** True when this client is a logged-in GM, who is the only one who can act on an API problem. */
    private get IsGM(): boolean {
        return !!game?.user?.isGM;
    }

    /** True when this client has picked TrueRandom as the source for at least one die. */
    // TODO this could probably be private
    public get IsInUse(): boolean {
        try {
            const config = game.settings.get("core", "diceConfiguration") as Record<string, string> | undefined;
            if (!config) return false;
            return Object.values(config).some(method => method === "truerandom");
        }
        catch (error) {
            return false;
        }
    }

    /**
     * Surface a message to the user, and report whether it was actually shown.
     *
     * `ui.notifications` does not exist until Foundry's 'ready' hook, but a roll can happen before
     * then. The message is always mirrored to the console, and the return value lets callers hold
     * their "already warned" flag open until a toast genuinely reached the user - otherwise a
     * single pre-'ready' failure would latch the flag and suppress the warning for the whole
     * session.
     */
    public Notify(level: "info" | "warn" | "error", message: string): boolean {
        Debug.WriteLine(message);
        try {
            const notifications = ui?.notifications;
            if (!notifications || typeof notifications[level] !== "function") return false;

            notifications[level](`TrueRandom | ${message}`, { permanent: level === "error" });
            return true;
        }
        catch (error) {
            console.warn(`TrueRandom | Could not display notification: ${message}`);
            return false;
        }
    }

    /** Turn whatever fetch/JSON-RPC threw into a single human-readable line. */
    public static DescribeError(reason: any): string {
        if (!reason) return "unknown error";
        if (typeof reason === "string") return reason;
        if (reason.message) return reason.message;
        if (reason.code != undefined) return `error ${reason.code}`;
        return String(reason);
    }

    public UpdateRandomNumbers(): void {
        if (!this.IsInUse || this.AwaitingResponse || !this.RandomGenerator) return;

        // Don't fetch unless the cache is below its refill threshold.
        if (this.RandomNumbers.length >= this.MaxCachedNumbers * this.UpdatePoint) return;

        // While the API is down the cache stays empty, so every single roll would otherwise fire
        // another request. Back off instead of hammering random.org once per die.
        if (Date.now() < this.NextRetryTime) return;

        this.AwaitingResponse = true;
        this.RandomGenerator.GenerateDecimals({ decimalPlaces: 5, n: this.MaxCachedNumbers })
            .then((response) => {
                this.RandomNumbers = this.RandomNumbers.concat(response.data);
                this.OnApiSuccess();

                // Show seeds in chat if enabled. Kept in its own try/catch: the fetch has already
                // succeeded, so a failure to post the chat card must not fall through to the
                // .catch below and be reported to the user as a random.org outage.
                try {
                    if (game.settings.get("truerandom", "SHOWSEEDS")) {
                        const seedList = response.data.join(", ");
                        const message = `<div style="border: 1px solid #444; padding: 8px; margin: 4px 0; background: rgba(0,0,0,0.1);">
                        <strong>🎲 TrueRandom Seeds Fetched:</strong><br>
                        <small style="font-family: monospace;">${seedList}</small><br>
                        <em style="color: #888; font-size: 11px;">Retrieved ${response.data.length} true random seeds from random.org</em>
                    </div>`;

                        ChatMessage.create({
                            content: message,
                            whisper: game.users.filter(u => u.isGM).map(u => u.id),
                            speaker: { alias: "TrueRandom System" }
                        }).catch((error) => Debug.WriteLine(`Could not post the seed message: ${TrueRandom.DescribeError(error)}`));
                    }
                }
                catch (error) {
                    Debug.WriteLine(`Could not post the seed message: ${TrueRandom.DescribeError(error)}`);
                }
            })
            .catch((reason) => this.OnApiFailure(reason))
            .finally(() => this.AwaitingResponse = false);
    }

    /**
     * Clear the outage state after a successful fetch, telling the user if we had previously
     * warned them, and warn once when the key's daily allowance is nearly gone.
     */
    private OnApiSuccess(): void {
        this.ApiFailureCount = 0;
        this.NextRetryTime = 0;
        if (this.HasNotifiedApiFailure) {
            this.HasNotifiedApiFailure = false;
            this.Notify("info", "Connection to random.org restored; dice rolls are using true randomness again.");
        }
        this.PendingApiFailureNotice = false;

        if (this.HasNotifiedLowQuota || !this.IsGM || !this.RandomGenerator) return;

        // random.org meters a client on both requests and bits per day; running out of either
        // silently drops every roll back to Foundry's built-in RNG.
        //   requestsLeft <= 0  -> the request allowance really is gone.
        //   bitsLeft <= bitsUsed -> the bits left will not cover another refill this size, so the
        //   next one is the last. That is "about to run out", not "already out" - say so.
        const requestsLeft = this.RandomGenerator.RequestsLeft;
        const bitsLeft = this.RandomGenerator.BitsLeft;
        const outOfRequests = requestsLeft <= 0;
        const bitsNearlyGone = bitsLeft <= this.RandomGenerator.BitsUsed;
        if (!outOfRequests && !bitsNearlyGone) return;

        const state = outOfRequests
            ? "Your random.org daily request allowance is used up"
            : "Your random.org daily bit allowance is nearly used up";
        // only stop warning once the warning has actually been displayed
        this.HasNotifiedLowQuota = this.Notify("warn", `${state} (${requestsLeft} requests / ${bitsLeft} bits left). Once it runs out, rolls fall back to Foundry's built-in randomness until it resets.`);
    }

    /**
     * Report a failed fetch. Notifies once per outage rather than once per attempt, so a key that
     * has been revoked doesn't bury the user under a toast for every dice roll.
     */
    private OnApiFailure(reason: any): void {
        this.ApiFailureCount++;
        // linear backoff, capped at 5 minutes, so a long outage settles into an occasional retry.
        this.NextRetryTime = Date.now() + Math.min(TrueRandom.RetryDelayMs * this.ApiFailureCount, TrueRandom.MaxRetryDelayMs);
        const detail = TrueRandom.DescribeError(reason);
        Debug.WriteLine(`Random.org request #${this.ApiFailureCount} failed: ${detail}`);

        if (this.HasNotifiedApiFailure) return;

        const fallback = "Dice rolls are falling back to Foundry's built-in randomness.";
        const shown = this.Notify("error", this.IsGM
            ? `Could not fetch random numbers from random.org — ${detail}. ${fallback} Check the API key and your daily quota at https://api.random.org/dashboard.`
            : `Could not fetch random numbers from random.org — ${detail}. ${fallback}`);

        // A failure before Foundry's 'ready' hook has nowhere to display. Remember that the user
        // still owes a warning and re-raise it on the next attempt, rather than latching here and
        // staying silent for the rest of the session.
        this.HasNotifiedApiFailure = shown;
        this.PendingApiFailureNotice = !shown;
    }

    public GetRandomNumber(): number | undefined {
        // not selected by this user: tell core to use its default source instead.
        if (!this.IsInUse) {
            return undefined;
        }

        if (!this.RandomGenerator?.ApiKey) {
            // Only the GM can set the world-scoped key, so only the GM is told about it. Both
            // conditions are re-checked every roll and HasAlerted is only latched once the toast
            // was really displayed: on an early roll there is no `ui` and no `game.user` yet, and
            // latching then would mean the GM never sees this at all.
            if (!this.HasAlerted && this.IsGM) {
                this.HasAlerted = this.Notify("warn", "No random.org API key is set, so dice rolls are using Foundry's built-in randomness. Add a key in Module Settings to enable true randomness.");
            }
            return undefined;
        }

        this.UpdateRandomNumbers();

        if (!this.RandomNumbers.length) {
            return undefined;
        }

        const randomNumber = this.PopRandomNumber();
        this.LastRandomNumber = randomNumber;

        Debug.WriteLine(`Using cached random number: ${randomNumber} (${this.RandomNumbers.length} remaining)`);

        return randomNumber;
    }

    public PopRandomNumber(): number {
        const ms = new Date().getTime();
        const index = ms % this.RandomNumbers.length;
        let rng = this.RandomNumbers[index];
        if (rng <= Number.EPSILON) rng = Number.EPSILON;
        this.RandomNumbers.splice(index, 1);
        return rng;
    }
}

var trueRandom = new TrueRandom();
globalThis.TrueRandom = trueRandom;

Hooks.once('init', () => {
    CONFIG.Dice.fulfillment.methods.truerandom = {
        label: "TrueRandom (random.org)",
        icon: "fas fa-dice-d20",
        handler: async (term) => {
            const rng = trueRandom.GetRandomNumber();
            return rng == undefined
                ? undefined
                : 1 + Math.floor(rng * (term.faces ?? 100));
        }
    };

    game.settings.register("truerandom", "APIKEY", {
        name: "Random.org API Key",
        hint: "Put your developer key from https://api.random.org/dashboard here",
        scope: "world", config: true, type: String, default: "",
        onChange: value => trueRandom.UpdateAPIKey(value)
    });

    game.settings.register("truerandom", "MAXCACHEDNUMBERS", {
        name: "Max Cached Numbers",
        hint: "Number of random numbers to cache per client.",
        scope: "world", config: true, type: Number,
        range: { min: 5, max: 200, step: 1 },
        default: 10,
        onChange: value => trueRandom.MaxCachedNumbers = value
    });

    game.settings.register("truerandom", "UPDATEPOINT", {
        name: "Update Point",
        hint: "Percentage of cache to trigger refetch.",
        scope: "world", config: true, type: Number,
        range: { min: 1, max: 100, step: 1 },
        default: 50,
        onChange: value => trueRandom.UpdatePoint = value * 0.01
    });

    game.settings.register("truerandom", "DEBUG", {
        name: "Print Debug Messages",
        hint: "Print debug messages to console",
        scope: "client", config: true, type: Boolean,
        default: true,
        onChange: value => Debug.WriteLine(`Debug: ${value}`)
    });

    game.settings.register("truerandom", "SHOWSEEDS", {
        name: "Show Seeds in Chat",
        hint: "Display fetched random seeds in chat when retrieved from random.org",
        scope: "world", config: true, type: Boolean,
        default: false
    });

    trueRandom.MaxCachedNumbers = parseInt(game.settings.get("truerandom", "MAXCACHEDNUMBERS"));
    trueRandom.UpdatePoint = game.settings.get("truerandom", "UPDATEPOINT") * 0.01;

    const currentKey = game.settings.get("truerandom", "APIKEY");
    if (currentKey?.length) {
        LocalStorage.Set("TrueRandom.ApiKey", currentKey);
        trueRandom.UpdateAPIKey(currentKey);
    } else if (LocalStorage.Get("TrueRandom.ApiKey", null)) {
        const savedKey = LocalStorage.Get<string>("TrueRandom.ApiKey");
        game.settings.set("truerandom", "APIKEY", savedKey);
        trueRandom.UpdateAPIKey(savedKey);
    }
});

Hooks.once("ready", () => {
    if (trueRandom.IsInUse) trueRandom.UpdateRandomNumbers();
});

Hooks.on("clientSettingChanged", (key, value) => {
    if (key !== "core.diceConfiguration") return;

    if (trueRandom.IsInUse) {
        trueRandom.UpdateRandomNumbers();
    }
});

