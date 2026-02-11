# AGENTS.md

This file is a high-detail operational memory for `/home/stefanorivera/MaterialSearch`.
Its purpose is to let a fresh agent recover context quickly after a context wipe.

## 1) Project Identity

- Project name: `MaterialSearch (Agents SDK)`
- Location: `/home/stefanorivera/MaterialSearch`
- Origin: Migrated from `../CodexGUI` (the original project was intentionally left untouched).
- Current backend engine: OpenAI Agents SDK (`@openai/agents`), not `codex app-server`.
- Primary objective: Deep research over a local corpus of ingredient TXT files, including English and Korean content and OCR-fragmented text.

## 2) Core Behavior Summary

This project provides a browser chat UI with authentication and admin settings. A logged-in user can:

1. Create/resume chat threads.
2. Ask ingredient research questions.
3. Stream model output in real time.
4. Interrupt a running turn.
5. Reload prior messages from the thread history.

The assistant is tool-enabled and expected to perform iterative retrieval (multiple searches and file reads) before final answers.

## 3) Files and Their Roles

- `server.js`
  - Main HTTP server.
  - Contains auth middleware, API routes, Agents SDK orchestration, streaming logic, tool definitions, thread/session management.
- `auth-store.js`
  - Local user/session store using `better-sqlite3`.
  - Handles user creation, authentication, role checks, thread ownership mapping.
- `public/index.html`
  - Main chat UI (login-gated).
  - Uses `/api/turn/stream` for SSE streaming.
- `public/login.html`
  - Username/password login UI.
- `public/admin.html`
  - Admin controls: model, default preamble, user management.
- `public/test.html`
  - Debug/test UI for API behavior.
- `README.md`
  - End-user setup/run instructions.
- `.env.example`
  - Environment variable template.
- `scripts/setup.sh`
  - Setup helper; validates Node version and installs dependencies.

## 4) Runtime Requirements

- Node.js: `>=22` (required by `@openai/agents` package)
- npm
- OpenAI API key in environment (`OPENAI_API_KEY`)

Key packages in `package.json`:

- `@openai/agents`
- `openai`
- `zod`
- `better-sqlite3`

## 5) Environment Variables (Operational)

- `PORT`
  - HTTP listen port. Default: `8788`.
- `OPENAI_API_KEY`
  - Required for model calls.
- `DEFAULT_MODEL`
  - Default model fallback when not configured in app settings. Current fallback in code: `gpt-5-mini`.
- `MAX_TURNS`
  - Max agent loop turns per run (tool-call loops included). Default: `25`.
- `TURN_TIMEOUT_MS`
  - Turn timeout in milliseconds. Default: `600000` (10 min).
- `INGREDIENTS_DIR`
  - Preferred corpus root location in WSL format.
  - Example: `/mnt/d/Ingredient/PDFs/txt`.
- `INGREDIENTS_WINDOWS_DIR`
  - Optional Windows-style alternative.
- `SHARED_READONLY_DIR`
  - Also accepted as legacy fallback source path.
- `SESSION_TTL_MS`
  - Login session TTL.
- `ADMIN_USERNAME`, `ADMIN_PASSWORD`
  - Optional bootstrap admin credentials.

## 6) Path Resolution Rules for Ingredients Corpus

Code path logic is in `resolveIngredientsDir()`:

1. Selects first non-empty source from:
   - `INGREDIENTS_DIR`
   - `INGREDIENTS_WINDOWS_DIR`
   - `SHARED_READONLY_DIR`
2. If none set, uses fallback Windows path:
   - `D:\Ingredient\PDFs\txt`
3. Converts `X:\...` paths to WSL `/mnt/x/...` using `windowsPathToWsl()`.
4. If resulting path is absolute, uses it directly; else resolves relative to project root.

Security constraint for file reads:

- `toSafeRelPath()` prevents path traversal; any attempted escape outside corpus root throws.

## 7) Agent + Session Architecture

### 7.1 Agent SDK usage

- Imports from `@openai/agents`:
  - `Agent`
  - `run`
  - `tool`
  - `OpenAIConversationsSession`
  - `startOpenAIConversationsSession`

### 7.2 Thread model

- Each logical chat thread maps to an OpenAI Conversations Session.
- New thread IDs come from `startOpenAIConversationsSession(openaiClient)`.
- Existing thread IDs reuse `OpenAIConversationsSession({ conversationId })`.

### 7.3 Thread metadata persistence

Stored in `.thread-meta.json`:

- `conversationDir`
- `createdAt`
- `updatedAt`
- `preamble`
- `lastPreview`

### 7.4 App settings persistence

Stored in `.app-settings.json`:

- `defaultModel`
- `defaultThreadPreamble`

## 8) Deep Research Agent Prompting Strategy

`buildAgent()` composes instructions from:

- Thread preamble (custom or default), plus operational directives.

Directives require the model to:

- Use tools before answering.
- Try multiple query variants (synonyms, Korean/English, spacing/hyphen variants).
- Handle OCR/PDF fragmentation by testing normalized terms.
- Continue iterative search until satisfied with recall.
- Provide evidence and file references in final answer.
- Explicitly report uncertainty when evidence is weak.
- Avoid fabricated citations.

## 9) Tooling Implemented for Corpus Research

All tools are local filesystem tools wrapped with `tool({ parameters: z.object(...), execute })`.

### 9.1 `list_ingredient_files`

Purpose:

- Discover available `.txt` files in the corpus.

Inputs:

- `contains?: string`
- `limit?: number` (clamped)

Behavior:

- Recursively scans for `.txt` files.
- Returns relative paths.
- Supports substring filtering.

### 9.2 `search_ingredient_text`

Purpose:

- Search corpus using keyword or regex, repeatedly, with variant patterns.

Inputs:

- `query: string`
- `regex?: boolean`
- `caseSensitive?: boolean`
- `contextLines?: number`
- `maxMatches?: number`
- `glob?: string`

Behavior:

1. Preferred search path: `rg` (`ripgrep`) subprocess.
2. If `rg` unavailable/fails, fallback mode scans files.
3. If no hits, additional normalized scan strips whitespace in both query and line
   (helps with OCR/PDF line-break fragmentation).

Returns:

- `mode` indicating path used (`rg`, `fallback_scan`, `normalized_scan`)
- matched file/line/text tuples.

### 9.3 `read_ingredient_file`

Purpose:

- Read selected file segments for detailed evidence extraction.

Inputs:

- `relativePath: string`
- `startLine?: number`
- `maxLines?: number`

Behavior:

- Enforces root-safe path.
- Reads UTF-8 text.
- Returns line window and metadata.

## 10) API Surface (Server)

### Public + auth/session

- `GET /health`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

### Admin

- `GET /api/admin/settings`
- `POST /api/admin/settings`
- `GET /api/admin/users`
- `POST /api/admin/users`
- `POST /api/admin/users/password`

### Model/account/meta

- `GET /api/models`
- `GET /api/account`

### Threads/conversations

- `GET /api/threads`
- `GET /api/conversations`
- `GET /api/thread/messages?threadId=...`
- `POST /api/thread/ensure`

### Turn execution

- `POST /api/turn`
  - Non-stream run
- `POST /api/turn/stream`
  - SSE stream run
- `POST /api/turn/interrupt`
  - Abort running turn via turnId

## 11) Streaming Protocol (`/api/turn/stream`)

Response is SSE. Events sent as JSON in `data: ...` records.

Current event types produced by backend:

- `status` (`running`)
- `meta` (`threadId`, `turnId`, `conversationDir`)
- `delta` (assistant text chunks)
- `event` (raw/internal stream event passthrough)
- `done` (final status + text)
- `error` (error message)
- terminal marker: `data: [DONE]`

The UI in `public/index.html` consumes these and renders incremental output.

## 12) Interrupt Model

- Server creates `AbortController` per turn.
- Controllers are tracked in-memory in `activeTurns` map by `turnId`.
- `/api/turn/interrupt` aborts matching controller.
- Interrupted runs return `status: interrupted` and partial text if any.

## 13) Authentication and Authorization Model

`auth-store.js` handles:

- User accounts (`admin` and `user` roles)
- Password hashing and verification
- Session token creation/validation
- Thread ownership mapping in `user_threads`

Thread protection rule:

- A user cannot read/run/interact with a thread unless `userOwnsThread` is true.

Admin-only endpoints guard on `session.user.role === 'admin'`.

## 14) Local State and Persistence Files

- `.auth.db`, `.auth.db-*`
  - sqlite auth/session database
- `.thread-meta.json`
  - non-authoritative local metadata for UI convenience
- `.app-settings.json`
  - admin settings
- `conversations/`
  - local per-thread directories created for tracking/organization

These are intentionally local runtime artifacts.

## 15) Frontend Contract Expectations

The frontend expects the server contract inherited from CodexGUI-style endpoints.
Do not rename routes unless you also update the UI pages.

Critical UI assumptions:

- `/api/conversations` returns data array with `id`, timestamps, `preview`.
- `/api/thread/messages` returns message list in `{ role, text }` format.
- `/api/turn/stream` emits SSE JSON events with `meta`, `delta`, `done`, `error`.

## 16) Known Limitations and Practical Notes

- Tool search quality depends on text extraction quality from source PDFs.
- Normalized scan removes whitespace but not all OCR artifacts.
- The backend currently does not enforce strict read-only permissions at OS level; it relies on tool behavior (tools are read-only by design).
- `activeTurns` is in-memory only (interrupt handles don’t survive process restart).
- If you rotate OpenAI keys, restart server to ensure clean runtime behavior.

## 17) How to Start Quickly (Recovery Procedure)

If context is wiped and you need quick re-entry:

1. `cd /home/stefanorivera/MaterialSearch`
2. Confirm Node version: `node -v` (must be >= 22)
3. Ensure env values are set (especially `OPENAI_API_KEY`, `INGREDIENTS_DIR`)
4. `npm install`
5. `npm start`
6. Open `http://127.0.0.1:8788/`
7. Login using local auth credentials
8. Use test UI (`/test`) if debugging API behavior

## 18) Safety and Change Guidelines for Future Agents

When editing this project:

- Keep `../CodexGUI` untouched unless explicitly asked.
- Preserve endpoint compatibility expected by existing HTML pages.
- Maintain thread ownership checks.
- Keep file tools constrained to ingredient root.
- Prefer adding behavior in `server.js` while minimizing UI breakage.
- If changing event names in streaming, update both backend and UI parser.

## 19) Debugging Hints

- Health check: `curl http://127.0.0.1:8788/health`
- If model calls fail, check:
  - `OPENAI_API_KEY`
  - model availability (`/api/models`)
  - network egress
- If no corpus results:
  - verify `INGREDIENTS_DIR` path
  - test `rg` manually inside corpus directory
  - use search tool with Korean/English variants and normalized fragments

## 20) Migration Context (Historical)

This repository was populated as a migration target from `../CodexGUI` with this explicit user constraint:

- Do not delete or modify the original project.
- Build migrated project in this folder (`MaterialSearch`).
- Use OpenAI Agents SDK (not Completion/Responses-only direct flow).
- Support ingredient deep research workflow and iterative searching.
- Support Windows to WSL path conversion for ingredient directory.

This AGENTS.md intentionally captures that migration intent so future turns remain aligned.
