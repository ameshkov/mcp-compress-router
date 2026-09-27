# Coding task: TODO web application

Build a small TODO web application in the current working directory.

## Requirements

- **Runtime:** Node.js with built-in modules only. Do not install any
  dependencies: use `node:http` for the server, `node:sqlite` for
  storage, and `node:test` for the tests.
- **Files:** create exactly these files and nothing else:
  - `server.js` — the HTTP server and REST API, listening on port 3000.
  - `db.js` — SQLite access; keep the database in `todos.db` in the
    project root.
  - `public/index.html` — the frontend page served by the backend.
  - `test/api.test.js` — the end-to-end API test.
  - `package.json` — with `"type": "module"` and `"test": "node --test"`.
  - `README.md` — install and run instructions.
- **REST API:**
  - `GET /api/todos` — list all TODOs
  - `POST /api/todos` — create a TODO (`{ "title": "..." }`)
  - `PATCH /api/todos/:id` — toggle `completed`
  - `DELETE /api/todos/:id` — delete a TODO
- **Frontend:** `public/index.html` lists TODOs, adds one, toggles one,
  and deletes one through the API.
- **Tests:** `test/api.test.js` exercises the API end to end and passes
  with `npm test`.

## Finishing

- Run `npm test` once and make sure it passes.
- Do not start the server or do any other verification.

## Constraints

- Work only inside the current directory.
- Do not use any MCP tools. The MCP servers connected to this session are
  unavailable stubs; use your local shell and file tools instead.
- Keep the implementation small and complete. Do not add unrelated
  features.
