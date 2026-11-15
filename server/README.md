# Umbra-X study service

Run the compiled NASA planner data checks in PLANNER.md, then use Node 24 or later. Start the API and web preview in separate terminals.

```powershell
npm --prefix web run study-api
npm --prefix web run dev -- --host 127.0.0.1 --port 5174
```

Open Ask Umbra-X. The local API needs no key. It queues studies, runs them off the HTTP thread, and stores inputs and results in SQLite. The saved study record contains the normalized request and data and solver fingerprints. Runs interrupted by a server restart return to the queue. A single local server process owns the SQLite database.

For live model tool calling, set these in the **API terminal** before starting the service.

```powershell
$env:UMBRA_MODEL_URL = '<full Chat Completions compatible endpoint>'
$env:UMBRA_MODEL = '<tool-capable model identifier>'
# Set UMBRA_MODEL_KEY in the terminal environment if your provider requires one.
npm --prefix web run study-api
```

Use HTTPS for hosted endpoints. HTTP is accepted for a loopback model server. The API uses the Chat Completions tool-call shape and expects the provider to support named and required tool choices. A model sends a question and the current planner context to the configured provider. Keep the provider key server-side. If the provider is off, Ask uses its local parser. Manual runs in the browser without the API.

| Route | Behavior |
|---|---|
| GET /api/study/coverage | Read the pinned release, supported regions, and model availability |
| POST /api/study/interpret | Inspect coverage and prepare a validated draft through model tools |
| POST /api/study/runs | Queue a reviewed study, or return a matching run |
| GET /api/study/runs/{id} | Retrieve run state and results |
| DELETE /api/study/runs/{id} | Cancel a queued or running study |

The service binds to loopback for local development. Vite proxies /api/study to port 8787. The current database and cancellation endpoints assume one trusted local operator. Public deployment needs an access model for saved studies, cancellation, and model usage.

Run the orchestration tests with `node --test server/agent.test.mjs`. They use a scripted provider and cover the validation and tool feedback loop. A real provider run requires the settings above.
