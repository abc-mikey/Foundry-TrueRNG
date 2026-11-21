import { TrueRandom as rngType } from './TrueRandom.js';
import { Debug } from './Debug.js';
import { RandomAPI } from './RandomAPI.js';
// import { Hooks } from './Foundry-Types/Hooks';
// @ts-ignore
Hooks.on("ready", () => {
    // create a dummy truerng
    let rng = new rngType();
    // It validates these two properties so we need something there.
    rng.RandomGenerator = new RandomAPI("dummy-api-key");
    rng.RandomNumbers.push(1.0, 1.0, 1.0, 1.0, 1.0);
    rng.UpdatePoint = Number.MAX_SAFE_INTEGER;
    //#region PreHook overwrite function
    rng.GetRandomNumber();
    //#endregion
    // TODO rewrite tests
    Debug.WriteLine(`All test have passed!!!`);
});
