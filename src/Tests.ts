import { TrueRandom as rngType } from './TrueRandom.js';
import { Debug } from './Debug.js';
import { RandomAPI } from './RandomAPI.js';
// import { Hooks } from './Foundry-Types/Hooks';

// @ts-ignore
Hooks.on("ready", () =>
{
	// create a dummy truerng
	let rng = new rngType();
	// It validates these two properties so we need something there.
	rng.RandomGenerator = new RandomAPI("dummy-api-key");
	rng.RandomNumbers.push(1.0, 1.0, 1.0, 1.0, 1.0);
	rng.UpdatePoint = Number.MAX_SAFE_INTEGER;

	//#region PreHook overwrite function

	rng.GetRandomNumber();

	//#endregion

	//#region PreHook overwrite function #2

	Debug.WriteLine(`Testing that prehook function was overwrote Again...`);
	Debug.Assert(rng.LastRandomNumber  === 0.0, rng.LastRandomNumber, 0.0);
	Debug.WriteLine(`Passed!`);

	//#endregion

	//#region PreHook return early
	rng.GetRandomNumber();
	//#endregion

	//#region PostHook overwrite return value
	rng.GetRandomNumber();
	Debug.WriteLine(`Testing that post hook is able to overwrite random numbers`);
	Debug.Assert(rng.LastRandomNumber === 2.0, rng.LastRandomNumber, 2.0);
	//#endregion

	Debug.WriteLine(`All test have passed!!!`);

});
