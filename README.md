# Two Bots, One Brain

Two game bots share one brain: [Jev](https://typesafe.ai), TypeSafe AI's decision model. Every 1.5 seconds each bot asks Jev what to do, with the same rules and the same question. The only difference is what each bot sends:

- **Raw bot:** its raw game state: `hp: 38, maxHp: 250`, exact distances, epoch timestamps, positions, and debug data.
- **jev-state bot:** the same state after [jev-state](https://www.npmjs.com/package/jev-state): `hp: "critical"`, `distance: "near"`, `lastNoiseAt: "just now"`.

You fight both at once in two mirrored arenas. Every decision is checked against the rules, so you can see which bot reads the situation correctly.

## Run it

You need Node.js 22+.

```sh
git clone https://github.com/suranjaychandra/two-bots-one-brain.git
cd two-bots-one-brain
npm install
```

**With Jev** (needs a [TypeSafe](https://typesafe.ai) API key):

```sh
cp .env.example .env     # paste your TYPESAFE_API_KEY and save
npm start                # http://localhost:3001
```

**Without a key:**

```sh
npm run offline          # both bots use the local rules instead of Jev
```

Open http://localhost:3001, choose **YOU PLAY** (WASD to move, click to shoot) or **WATCH** (a scripted player), then press **START ROUND**. Every decision is also printed in the terminal.

## How it works

| File | What it does |
|---|---|
| `brain.ts` | The rules Jev is given, the raw state, the jev-state schema, and the correct answer by the rules |
| `server.ts` | Receives each bot's numbers, builds its state, and asks Jev. The API key stays here. |
| `public/game.js` | The arenas, the bots, and the round. You move the same way in both arenas. |

The bots choose between five actions: **retreat**, **heal**, **attack**, **investigate**, and **patrol**. A minute of play makes about 80 Jev calls, roughly $0.003.

## License

[MIT](LICENSE) © 2026 Suranjay Kumar

Unofficial community project. Not affiliated with or endorsed by TypeSafe AI.
