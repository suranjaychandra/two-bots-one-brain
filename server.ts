/**
 * Two Bots, One Brain: local game server.
 *
 *   npm start           # bots ask the real Jev (needs TYPESAFE_API_KEY in .env)
 *   npm run offline     # bots use the local rules instead of Jev, to try the game without a key
 *
 * The API key stays in this process. The browser only sends numbers, never text for Jev.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { ACTIONS, QUESTION, RULES, jevState, policy, rawState, type BotInput } from "./brain.js";

const OFFLINE = process.argv.includes("--offline");
const PORT = Number(process.env.PORT) || 3001;

if (!OFFLINE) {
  try {
    process.loadEnvFile(".env");
  } catch {}
  if (!process.env.TYPESAFE_API_KEY?.trim()) {
    console.error("TYPESAFE_API_KEY is missing. Copy .env.example to .env, paste your key, and save. Or run: npm run offline");
    process.exit(1);
  }
}
const client = OFFLINE ? null : new TypeSafeClient();

type Brain = "raw" | "jev-state";

const num = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function readInput(b: any): BotInput {
  const maxHp = num(b.maxHp, 1, 10_000, 250);
  return {
    maxHp,
    hp: num(b.hp, 0, maxHp, maxHp),
    ammo: Math.round(num(b.ammo, 0, 99, 0)),
    medkits: Math.round(num(b.medkits, 0, 9, 0)),
    enemyDistances: (Array.isArray(b.enemyDistances) ? b.enemyDistances : [])
      .map((d: unknown) => num(d, 0, 1000, Number.NaN)).filter(Number.isFinite).slice(0, 5),
    noiseSecondsAgo: b.noiseSecondsAgo == null ? null : num(b.noiseSecondsAgo, 0, 86_400, 0),
    position: { x: num(b.position?.x, -1e4, 1e4, 0), y: num(b.position?.y, -1e4, 1e4, 0) },
    heading: num(b.heading, -360, 360, 0),
    tick: Math.round(num(b.tick, 0, 1e9, 0)),
  };
}

async function decide(brain: Brain, input: BotInput) {
  const raw = rawState(input);
  const state = brain === "raw" ? raw : jevState(raw);
  const expected = policy(input);
  const t0 = performance.now();
  if (OFFLINE) {
    return { action: expected, confidence: 1, expected, tokens: 0, ms: 0, chars: JSON.stringify(state).length };
  }
  const res = await client!.systemOne({ state: state as never, questions: { action: QUESTION } });
  return {
    action: res.answers.action.choice,
    confidence: res.answers.action.confidence,
    expected,
    tokens: res.usage.input_tokens,
    ms: Math.round(performance.now() - t0),
    chars: JSON.stringify(state).length,
  };
}

// ---------- Terminal log ----------

const color = { dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", pink: "\x1b[35m", yellow: "\x1b[33m", reset: "\x1b[0m" };
const tally = { raw: { n: 0, ok: 0 }, "jev-state": { n: 0, ok: 0 } };

function log(brain: Brain, input: BotInput, d: Awaited<ReturnType<typeof decide>>) {
  const t = tally[brain];
  t.n++;
  if (d.action === d.expected) t.ok++;
  const name = brain === "raw" ? `${color.yellow}RAW BOT      ${color.reset}` : `${color.pink}JEV-STATE BOT${color.reset}`;
  const mark = d.action === d.expected ? `${color.green}✅${color.reset}` : `${color.red}❌ should be ${d.expected}${color.reset}`;
  const situation = `hp ${Math.round(input.hp)}/${input.maxHp} · ammo ${input.ammo} · enemy ${input.enemyDistances.length ? `${input.enemyDistances[0]!.toFixed(1)}m` : "none"}`;
  console.log(
    `${color.dim}${new Date().toLocaleTimeString("en-GB")}${color.reset} ${name} ${d.action.padEnd(11)} ${d.confidence.toFixed(2)} ${mark}` +
      `  ${color.dim}${situation} · ${t.ok}/${t.n} correct${color.reset}`,
  );
}

// ---------- HTTP ----------

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css" };

function send(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function body(req: IncomingMessage): Promise<any> {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 20_000) throw new Error("Request too large");
  }
  return data ? JSON.parse(data) : {};
}

createServer(async (req, res) => {
  try {
    const url = (req.url ?? "/").split("?")[0]!;
    if (req.method === "GET" && (url === "/" || url === "/game.js")) {
      const file = url === "/" ? "index.html" : "game.js";
      res.writeHead(200, { "content-type": TYPES[extname(file)]! });
      return res.end(readFileSync(new URL(`./public/${file}`, import.meta.url)));
    }
    if (req.method === "GET" && url === "/api/info") {
      return send(res, 200, { offline: OFFLINE, rules: RULES, actions: ACTIONS });
    }
    if (req.method === "POST" && url === "/api/decide") {
      const b = await body(req);
      const brain: Brain = b.brain === "raw" ? "raw" : "jev-state";
      const input = readInput(b.input ?? {});
      const d = await decide(brain, input);
      log(brain, input, d);
      return send(res, 200, d);
    }
    res.writeHead(404).end("Not found");
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : "Unknown error";
    console.error(`${color.red}Error: ${message}${color.reset}`);
    send(res, 500, { error: message });
  }
}).listen(PORT, () => {
  console.log(`\n  Two Bots, One Brain  ${OFFLINE ? `${color.yellow}OFFLINE: bots use local rules, not Jev${color.reset}` : `${color.green}live Jev${color.reset}`}`);
  console.log(`  Open http://localhost:${PORT}\n`);
});
