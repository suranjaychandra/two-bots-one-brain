import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { ACTIONS, QUESTION, jevState, policy, rawState, type Action, type BotInput } from "../brain.js";

const NOW = 1_800_000_000_000;
const input = (overrides: Partial<BotInput> = {}): BotInput => ({
  hp: 80, maxHp: 100, ammo: 10, medkits: 0, enemyDistances: [], noiseSecondsAgo: null,
  position: { x: 1, y: 2 }, heading: 90, tick: 42, ...overrides,
});

const cases: [string, Partial<BotInput>, Action][] = [
  ["critical health retreats from a near enemy", { hp: 19, enemyDistances: [5] }, "retreat"],
  ["critical health retreats from a far visible enemy", { hp: 19, medkits: 1, enemyDistances: [25] }, "retreat"],
  ["retreat takes priority even without ammo", { hp: 19, ammo: 0, medkits: 1, enemyDistances: [25] }, "retreat"],
  ["critical health without visible enemies can heal", { hp: 19, medkits: 1 }, "heal"],
  ["exactly 20 percent is not critical", { hp: 20, enemyDistances: [25] }, "attack"],
  ["fractional health below 20 percent is critical", { hp: 19.99, enemyDistances: [25] }, "retreat"],
  ["low health heals ahead of attacking a far enemy", { hp: 49, medkits: 1, enemyDistances: [25] }, "heal"],
  ["exactly 50 percent is not low", { hp: 50, medkits: 1, enemyDistances: [25] }, "attack"],
  ["a near enemy prevents healing", { hp: 40, medkits: 1, enemyDistances: [9.99] }, "attack"],
  ["exactly 10 meters is not near", { hp: 40, medkits: 1, enemyDistances: [10] }, "heal"],
  ["healing requires a medkit", { hp: 40, medkits: 0 }, "patrol"],
  ["health thresholds use maxHp", { hp: 90, maxHp: 500, enemyDistances: [25] }, "retreat"],
  ["visible enemies with ammo cause attack", { enemyDistances: [30] }, "attack"],
  ["no ammo does not invent a reload or take-cover action", { ammo: 0, enemyDistances: [5] }, "patrol"],
  ["no enemies and recent noise cause investigation", { noiseSecondsAgo: 59.999 }, "investigate"],
  ["exactly 60 seconds is not recent", { noiseSecondsAgo: 60 }, "patrol"],
  ["no noise means patrol", {}, "patrol"],
  ["healing takes priority over investigation", { hp: 40, medkits: 1, noiseSecondsAgo: 1 }, "heal"],
  ["visible enemies prevent investigation without ammo", { ammo: 0, enemyDistances: [25], noiseSecondsAgo: 1 }, "patrol"],
];

for (const [name, overrides, expected] of cases) {
  test(name, () => assert.equal(policy(input(overrides)), expected));
}

test("question options match the five supported actions", () => {
  assert.deepEqual(ACTIONS, ["retreat", "heal", "attack", "investigate", "patrol"]);
  assert.deepEqual(Object.keys(QUESTION.criteria), [...ACTIONS]);
});

test("raw state uses the supplied clock and preserves relevant integer inputs", () => {
  const b = input({ hp: 40, medkits: 1, enemyDistances: [5, 25], noiseSecondsAgo: 30 });
  const raw = rawState(b, NOW);
  assert.equal(raw.npc.hp, b.hp);
  assert.equal(raw.npc.maxHp, b.maxHp);
  assert.equal(raw.npc.ammo, b.ammo);
  assert.equal(raw.npc.medkits, b.medkits);
  assert.deepEqual(raw.enemies.map((enemy) => enemy.distance), b.enemyDistances);
  assert.equal(raw.currentTime, NOW);
  assert.equal(raw.lastNoiseAt, NOW - 30_000);
  assert.equal(rawState(input(), NOW).lastNoiseAt, null);
});

test("projection labels health and distance at exact boundaries", () => {
  for (const [hp, expected] of [[19, "critical"], [20, "low"], [49, "low"], [50, "healthy"]] as const) {
    const state = jevState(rawState(input({ hp, enemyDistances: [30, 10, 9.9] }), NOW));
    assert.equal(state.npc.hp, expected);
    assert.deepEqual(state.enemies.map((enemy: { distance: string }) => enemy.distance), ["near", "medium", "far"]);
  }
});

test("projection keeps nearest enemies, counts visibility and removes engine detail", () => {
  const state = jevState(rawState(input({ ammo: 0, medkits: 1, enemyDistances: [50, 40, 30, 20, 10, 5] }), NOW));
  assert.deepEqual(state, {
    npc: { hp: "healthy", ammo: "none", medkits: "one" },
    enemiesVisible: "several",
    enemies: ["near", "medium", "medium", "far", "far"].map((distance) => ({ type: "player", distance })),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
});

test("state preparation does not mutate the bot input or raw state", () => {
  const b = input({ enemyDistances: [25, 5], noiseSecondsAgo: 30 });
  const beforeInput = structuredClone(b);
  const raw = rawState(b, NOW);
  const beforeRaw = structuredClone(raw);
  const state = jevState(raw);
  assert.deepEqual(b, beforeInput);
  assert.deepEqual(raw, beforeRaw);
  assert.equal(typeof state.lastNoiseAt, "string");
});

test("raw state keeps snapshot numbers exactly, so the judge and both bots see the same values", () => {
  // The browser rounds once (whole hp, 0.1 m, 0.1 s). rawState must not change those values again.
  for (const [hp, distance, noise] of [[19, 9.9, 59.9], [20, 10, 60], [49, 29.9, 0.1], [50, 30, 12.3]] as const) {
    const b = input({ hp, medkits: 1, enemyDistances: [distance], noiseSecondsAgo: noise });
    const raw = rawState(b, NOW);
    assert.equal(raw.npc.hp, hp);
    assert.equal(raw.enemies[0]!.distance, distance);
    assert.equal((raw.currentTime - raw.lastNoiseAt!) / 1000, noise);
    assert.equal(policy({ ...b, hp: raw.npc.hp, enemyDistances: raw.enemies.map((e) => e.distance) }), policy(b));
  }
});

test("browser snapshots round once before the decision, and the judge uses the same snapshot", () => {
  // Run the actual browser script without starting rendering or making network calls.
  // Its startup awaits our unresolved info request; snapshot() itself stays directly testable.
  const context = createContext({
    document: { getElementById: () => ({ addEventListener() {} }) },
    window: { addEventListener() {} },
    fetch: () => new Promise(() => {}),
    world: { bot: { ...input({ hp: 19.4 }), x: 9.94, y: 0 }, noise: { t: 0.06 } },
  });
  runInContext(readFileSync(new URL("../public/game.js", import.meta.url), "utf8"), context);
  const snapshot = JSON.parse(runInContext("player = { x: 0, y: 0 }; t = 60; JSON.stringify(snapshot(world))", context)) as BotInput;
  assert.equal(snapshot.hp, 19);
  assert.deepEqual(snapshot.enemyDistances, [9.9]);
  assert.equal(snapshot.noiseSecondsAgo, 59.9);
  assert.equal(policy(snapshot), "retreat");
  const state = jevState(rawState(snapshot, NOW));
  assert.equal(state.npc.hp, "critical");
  assert.equal(state.enemies[0].distance, "near");
  const outside = JSON.parse(runInContext("world.bot.x = VISION; world.noise = null; JSON.stringify(snapshot(world))", context)) as BotInput;
  assert.deepEqual(outside.enemyDistances, []);
  assert.equal(outside.noiseSecondsAgo, null);
});
