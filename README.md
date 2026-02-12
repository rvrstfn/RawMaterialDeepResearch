# MaterialSearch (Agents SDK)

This project is a migrated version of the `../CodexGUI` chat, now using the OpenAI Agents SDK (`@openai/agents`) instead of `codex app-server`.

## What it includes

- Existing login/admin/chat UI preserved
- OpenAI Agents SDK backend (`Agent`, `run`, `tool`) for chat turns
- OpenAI conversation-backed sessions (`OpenAIConversationsSession`) per thread
- Deep-research file tools for a TXT corpus:
  - `list_ingredient_files`
  - `search_ingredient_text`
  - `read_ingredient_file`
- Streaming endpoint for incremental UI output (`/api/turn/stream`)
- Interrupt support using abort signals (`/api/turn/interrupt`)

## Requirements

- Node.js 22+ (required by `@openai/agents`)
- OpenAI API key (`OPENAI_API_KEY`)

## Setup

```bash
cd /home/stefanorivera/MaterialSearch
npm run setup
```

## Run

```bash
export OPENAI_API_KEY=...your_key...
npm start
```

Open:

```text
http://127.0.0.1:8788/
```

## Environment variables

```bash
PORT=8788
OPENAI_API_KEY=...
DEFAULT_MODEL=gpt-5-mini
MAX_TURNS=25
TURN_TIMEOUT_MS=600000
# Reasoning summaries (intermediate "thinking summary", not raw chain-of-thought)
# REASONING_SUMMARY: off | auto | concise | detailed
REASONING_SUMMARY=auto
# REASONING_EFFORT: none | minimal | low | medium | high | xhigh
REASONING_EFFORT=low
# Server-side context compaction (Responses API `context_management`)
CONTEXT_COMPACTION_ENABLED=1
CONTEXT_COMPACTION_THRESHOLD=160000
INGREDIENTS_DIR=/mnt/d/Ingredient/PDFs/txt
SESSION_TTL_MS=2592000000
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-me-now
```

Windows path conversion example:

- `D:\Ingredient\PDFs\txt` (Windows)
- `/mnt/d/Ingredient/PDFs/txt` (WSL)

## Notes

- This project does not modify `../CodexGUI`.
- Runtime/local files are excluded from git (`conversations/`, `.thread-meta.json`, `.app-settings.json`, `.auth.db*`).
- If no admin exists, bootstrap logic is unchanged from the original app (`auth-store.js`).

## References

- Agents SDK overview: https://platform.openai.com/docs/guides/agents-sdk
- Agents SDK JS docs: https://openai.github.io/openai-agents-js/
- `run()` and streaming (`stream: true`): https://openai.github.io/openai-agents-js/guides/running-agents/
- Sessions (`OpenAIConversationsSession`): https://openai.github.io/openai-agents-js/guides/sessions/
- Tools (`tool` with Zod schema): https://openai.github.io/openai-agents-js/guides/tools/
