/**
 * The bot's brain: the rules Jev is given, the raw state a game engine has,
 * the jev-state schema, and the correct answer by the rules.
 */
import { choice } from "@typesafe-ai/sdk";
import { band, count, each, pipe, project, prune, time } from "jev-state";

export const RULES = `You control a soldier NPC. Choose its next action.
Definitions:
- Health is "critical" below 20% of max health and "low" below 50% of max health.
- An enemy is "near" when it is closer than 10 meters.
- A noise is "recent" when it was heard less than one minute ago.
Apply the FIRST rule that matches, in this order:
1. retreat: health is critical and at least one enemy is near.
2. heal: health is critical or low, the NPC has at least one medkit, and no enemy is near.
3. attack: at least one enemy is visible and the NPC has ammo.
4. investigate: no enemies are visible and there was a recent noise.
5. patrol: none of the above.`;

export const ACTIONS = ["retreat", "heal", "attack", "investigate", "patrol"] as const;
export type Action = (typeof ACTIONS)[number];

export const QUESTION = choice(RULES, { retreat: null, heal: null, attack: null, investigate: null, patrol: null });

/** What the game knows about one bot at the moment it asks for a decision. */
export interface BotInput {
  hp: number;
  maxHp: number;
  ammo: number;
  medkits: number;
  /** Meters to each visible enemy. */
  enemyDistances: number[];
  /** Seconds since the last noise, or null for none. */
  noiseSecondsAgo: number | null;
  /** Engine detail that a real game would also have; irrelevant to the decision. */
  position: { x: number; y: number };
  heading: number;
  tick: number;
}

/** The correct answer by the rules. Mirrors RULES exactly. */
export function policy(b: BotInput): Action {
  const ratio = b.hp / b.maxHp;
  const near = b.enemyDistances.some((d) => d < 10);
  if (ratio < 0.2 && near) return "retreat";
  if (ratio < 0.5 && b.medkits > 0 && !near) return "heal";
  if (b.enemyDistances.length > 0 && b.ammo > 0) return "attack";
  if (b.enemyDistances.length === 0 && b.noiseSecondsAgo !== null && b.noiseSecondsAgo < 60) return "investigate";
  return "patrol";
}

const r = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/** The raw state, the way a game engine stores it: exact numbers, epoch times, and engine data. */
export function rawState(b: BotInput, now = Date.now()) {
  return {
    npc: {
      id: "bot_1", hp: Math.round(b.hp), maxHp: b.maxHp, ammo: b.ammo, medkits: b.medkits, magazineSize: 12,
      position: { x: r(b.position.x), y: r(b.position.y), z: 0 }, headingDeg: r(b.heading, 1),
      animState: "run", meshId: "mesh_bot_2", lodLevel: 1,
    },
    enemies: b.enemyDistances.map((distance, i) => ({
      entityId: `player_${i}`, type: "player", distance: r(distance, 1), velocity: { x: 0.4, y: 0, z: -0.1 },
      lastUpdateTick: b.tick,
    })),
    lastNoiseAt: b.noiseSecondsAgo === null ? null : now - Math.round(b.noiseSecondsAgo * 1000),
    currentTime: now,
    world: { tick: b.tick, fps: 60 },
    debug: { frameMs: 16.4, drawCalls: 212 },
  };
}

/** The same state after jev-state. This is the only code a jev-state user writes. */
export function jevState(raw: ReturnType<typeof rawState>) {
  return project(
    raw,
    {
      npc: {
        hp: band({ max: (ctx) => ctx.parent.maxHp, cuts: [0.2, 0.5], labels: ["critical", "low", "healthy"] }),
        ammo: count({ few: 4, many: 10 }),
        medkits: count(),
      },
      enemiesVisible: pipe((_, ctx) => ctx.root.enemies, count()),
      enemies: pipe(
        prune({ keep: ["type", "distance"], sortBy: (a, b) => a.distance - b.distance, max: 5 }),
        each({ distance: band({ cuts: [10, 30], labels: ["near", "medium", "far"] }) }),
      ),
      lastNoiseAt: time({ now: (ctx) => ctx.root.currentTime }),
    },
    { unknown: "drop" },
  ).state;
}
