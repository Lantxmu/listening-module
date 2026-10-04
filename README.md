# Listening Module

A standalone English listening practice app built with VitePress, Vue, Express, and browser speech synthesis. Requires Node.js 20 or newer.

## Setup

```powershell
Copy-Item .env.example .env
```

Set `LISTENING_API_KEY` in `.env`. The key is used only by the server; do not commit `.env`.

```powershell
npm install
npm run dev
```

Open `http://localhost:5173/listening`. The development server proxies `/api` requests to the Express API on port 3001. Set `PORT` in `.env` to change the API port and update the Vite proxy in `docs/.vitepress/config.mjs` to match.

## Production

```powershell
npm run build
npm start
```

Express serves the generated site and API together at `http://localhost:3001/listening` (or the configured `PORT`).

## Tests

```powershell
npm test
```

The tests inject a fake model provider and do not use API credits. Browser tests are optional; install the Chromium browser once with `npx playwright install chromium`, then run `npm run test:browser` after building the site. The browser test starts a temporary test server and injects a fake model and speech engine.

## Configuration

- `LISTENING_API_KEY`: required model API key.
- `LISTENING_API_URL`: optional OpenAI-compatible chat completions URL; defaults to DeepSeek.
- `LISTENING_MODEL`: optional model name; defaults to `deepseek-chat`.
- `PORT`: optional production/API port; defaults to `3001`.

The generation API accepts optional `topic` (up to 120 characters). When omitted or blank, the model chooses a topic at random. Practice sessions are stored in memory and expire after one hour; restarting the server clears them.
