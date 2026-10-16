# RaceVector

RaceVector is an open-source Formula 1 data exploration and race-analysis app powered by the [OpenF1 API](https://openf1.org). It is intended for F1 fans and data-minded users who want to explore race results, driver telemetry, pace, tyre strategy, and race events.

## Features

- **Race Insights dashboard** - evidence-led verdicts, race pace rankings, lap-time evolution, and links to driver-level data.
- **Race analysis** - pace, sectors, tyre degradation, strategy, pit stops, overtakes, battles, weather, and track views, subject to available session data.
- **Driver views** - lap and sector data, position history, stints, weather, race control, and telemetry comparisons.
- **AI Race Engineer** - ask questions about a session and receive an evidence-based response.
- **Agent tool calling** - the agent can list available race-facts tables and inspect their rows; unavailable tables return explicit errors rather than invented data.
- **Agent baseline evaluation** - eight deterministic tests cover results, numeric pace comparison, tool lookup, missing data, aggregated pit-stop data, unknown entities, unsupported tables, and malformed tool calls.
- **Shareable session and driver routes**, structured race-facts JSON export, and responsive charts and tables.

## Technology

| Component | Technology | Role |
|---|---|---|
| Web app | React 18, TypeScript, React Router 7 | Session navigation, analysis pages, and interactions |
| Development/build | Vite 6 and `@cloudflare/vite-plugin` | Local app server and Cloudflare Worker build |
| Race-data engine | Pure TypeScript under `src/engine` | Builds a `SessionModel`, runs gated analyses, and produces `buildFacts()` |
| Charts and UI | Reusable React components, custom SVG/canvas charts, D3 scales/shapes | Render the analysis without adding a charting framework |
| Data source | OpenF1 API | Session, timing, telemetry, and race-control data |
| Server/runtime | Cloudflare Workers with Worker static assets | API routing, OpenF1 proxy/cache, server-rendered pages, and scheduled work |
| Persistence/analytics | Cloudflare R2 and Workers Analytics Engine bindings | Cached race data, derived session data, and optional usage analytics |
| AI | Groq API, default model `openai/gpt-oss-120b` | Server-side streaming analysis and agent responses |
| Tests | Vitest and Testing Library | Engine, UI, route, and deterministic agent-tool checks |

## Architecture and request flow

1. The React app routes users to a season, meeting, session analysis, or driver view.
2. The browser requests session inputs from `GET /api/session/:sessionKey/bundle`. The Worker assembles the bundle from cached OpenF1 resources in R2 and upstream data when needed; missing optional feeds are reported as missing rather than inferred.
3. The client maps the bundle to engine inputs and builds one shared `SessionModel`. Analysis components use that model for metrics, verdicts, charts, and tables. The same engine can produce structured race facts through `buildFacts()`.
4. AI analysis sends those facts to `POST /api/analyze`, which proxies the request to Groq and streams the response. The AI Race Engineer sends the question and facts to `POST /api/agent`; the Worker exposes `list_race_tables` and `inspect_race_table` tools over the supplied facts and returns the answer and tool names used.
5. The Worker serves the built app through its asset binding and handles `/api/*` routes. A scheduled Worker trigger runs the configured post-session processing. R2, Analytics Engine, and schedule configuration are in `f1-app/wrangler.jsonc`.

The Groq credential is read only by the Worker. It must not be placed in frontend source, `VITE_*` variables, or browser-visible configuration.

## Local setup

Use Node.js `>=22.12` and npm.

```powershell
cd f1-app
npm ci
npm run dev
```

Vite prints the local address when the development server starts. The non-AI app can be explored without a Groq key. To use the AI analysis or agent locally, create `f1-app/.dev.vars` (ignored by Git) with a real key on your machine:

```dotenv
GROQ_API_KEY=YOUR_GROQ_API_KEY
# Optional; defaults to the model listed above.
GROQ_MODEL=YOUR_GROQ_MODEL
# Optional; only needed for protected operator endpoints.
ADMIN_TOKEN=YOUR_ADMIN_TOKEN
```

Do not commit or share `.dev.vars` or generated Worker build output containing local vars. For a deployed Worker, configure secrets with Wrangler rather than putting secret values in `wrangler.jsonc`.

### Environment and bindings

| Name | Required? | Purpose |
|---|---|---|
| `GROQ_API_KEY` | Required for `/api/analyze` and `/api/agent` | Server-side Groq credential |
| `GROQ_MODEL` | Optional | Overrides the default Groq model |
| `ADMIN_TOKEN` | Optional | Protects `/api/admin/*` operator routes |
| `GA_ID` | Optional; currently configured as a public Worker variable | Analytics measurement ID for Worker-rendered pages; not a secret |
| `F1_DATA` | Cloudflare binding | R2 bucket binding configured in Wrangler |
| `ANALYTICS` | Optional Cloudflare binding | Workers Analytics Engine dataset configured in Wrangler |
| `ASSETS` | Cloudflare binding | Built client assets configured in Wrangler |

## Tests and build

Run these commands from `f1-app`:

```powershell
npm run test:agent-eval
npm test
npm run build
```

The latest reported baseline evaluation run passed **8 of 8** agent-tool cases. The latest reported full test run passed **234 of 234** tests across 14 files (2026-10-15). These are recorded baseline results, not claims about production AI accuracy.

The focused evaluation is deterministic: it tests the local tool executor against fixed facts and does not call Groq or the network. It checks whether the agent's tools expose the right evidence and missing-data errors; it does not test model tool selection or judge generated prose. Live-model behavior can vary and requires a configured API key, so these results do not measure production accuracy or hallucination rates.

## Deployment

The checked-in deployment configuration targets a Cloudflare Worker named `racevector` and serves the Vite-built client through the Worker asset binding. It also declares an R2 bucket, an Analytics Engine dataset, and a 15-minute scheduled trigger. This is a Worker deployment, not an independently configured Pages deployment.

After verifying the Cloudflare account, required bindings, and production data are ready, set the AI credential in that account and deploy from `f1-app`:

```powershell
npx wrangler secret put GROQ_API_KEY
npm run deploy
```

`npm run deploy` runs the build and then `wrangler deploy`. Deployment is a manual operator action; no deployment is performed by the test or build commands.

## Project layout

```text
f1-app/
  src/
    App.tsx                         # Client route table
    pages/                          # Home, analysis, driver, and season views
    components/                     # Dashboard, charts, tables, and interactions
    engine/                         # Session model, analyses, verdicts, and facts
    lib/                            # Client API and shared app utilities
    server/
      index.ts                      # Cloudflare Worker routes and AI endpoints
      bundle.ts                     # Session-data bundle assembly
      agent-tools.ts                # Agent tool definitions and executor
      __tests__/                    # Deterministic agent baseline evaluations
  package.json                      # Development, test, build, and deploy scripts
  wrangler.jsonc                    # Worker, bindings, assets, and cron configuration
```

## License

MIT
