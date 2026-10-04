# Features and implementation details (web-code-reader)

> For getting started (install / run / add a project) see [README](../README.md).
> This is the full version of the capability list, API, shortcuts and known limitations,
> moved out of the README to keep it short.

## Reading and navigation

- Open a project as a **local directory** (`POST /api/projects`; the same path always reuses the same id)
- The file tree lists **every file** in the project (including non-indexable binaries and assets):
  directories first, files after, **collapsed by default**, two colours for dirs vs files;
  filter by time (all / changed today / within 3 days / within 7 days) and by “orphan”
- File-tree badges: `●` just changed (flashes for 20 seconds), heat blocks (brighter = newer),
  `◌` recently changed, `★` hotspot, `?` orphan; right-click a file → “Add to reading queue”
- Monaco syntax highlighting, breadcrumbs (including symbol path with a sibling-symbol menu),
  outline (`Ctrl/Cmd+Shift+O`)
- Go to definition (`F12` / `Ctrl+F12` / Ctrl+Click), find references (`Shift+F12`).
  **A failed jump never just “does nothing”**: a notice bar gives a plain-language explanation and a
  next action (external dependency → “jump to the import line”; unresolvable → “search xxx”;
  indexing → explanation only)
- Search: `Ctrl/Cmd+P` files, `Ctrl/Cmd+T` workspace symbols, `Ctrl/Cmd+Shift+F` project-wide text
  (regex / case / whole word / directory scope / **streaming results you can stop at any time**);
  the Files panel input filters file names and, from 4 characters up, also searches file contents
  grouped by file
- Tabs (limit 8; middle-click or “Open to the side” for split view), recent files (empty query in
  Ctrl+P), position memory (switching back restores the last line and scroll position),
  back / forward (`Alt+←` / `Alt+→`)
- Around the editor: file summary bar (exports / dependencies / dependents + commit history),
  a three-band density bar (code / comment / blank, click to jump), per-line blame view
  (`Ctrl/Cmd+Alt+B`), read-only diff overlay (working tree vs HEAD or a given rev)
- Editor context menu: copy location (`Ctrl/Cmd+Alt+C`), copy selection with provenance,
  add to reading queue, explain this symbol (`Ctrl/Cmd+Alt+E`), call flow
- **Structural explanation** (no model involved): three scopes — selection / enclosing symbol /
  including callers — reporting “what it calls / who calls it / which project definitions it
  references / which external modules it depends on”, plus coverage. Always labelled
  “structural explanation · no model used”
- **Call-flow view**: expand a call chain from a symbol (outgoing / incoming / data flow), depth 1–3;
  data flow is **name-level approximation only** (dashed edges, marked “approximate”) — no type inference

## Project map (overview / dependency graph / time & origin)

When a project is open and no file is selected, the main area is the **project map**
(also reachable via “Overview” in the main area’s top row and the Overview tab in the right dock):

| Section | Contents | Basis |
|---|---|---|
| What it is | Language distribution, file / directory / byte / line counts, package name and scripts, collapsible README | Actual index and filesystem counts; **every number expands into its constituents**, hover shows the exact basis |
| Where to start | Entry-point candidates (naming heuristics + `__main__` / Go main package / Java main method / entries declared in package manifests, **each with its evidence**) + hotspot ranking | Six hotspot metrics: files referencing it / referencing entries / symbol references / definitions / unique dependencies / recency; tests and examples are denoised by default |
| Structure | Circular dependencies (Tarjan SCC), orphan files (in-degree 0 and not an entry, doc or test), largest files, directory roles and layering, complexity | Layering uses role (entry / domain / infrastructure / utility) + dependency direction, with evidence per item; roles quote the source only — when unavailable, a factual sentence is given instead (never generated) |
| Recent | Change counts for today / 3 days / 7 days, recent files, git commit batches | Time comes from file mtime; batches from read-only `git log` |

**An unfinished index never blocks you**: the map shows “partial map + progress” and states what can
be trusted right now and what is still growing — “not indexed yet” is never displayed as 0.

**Dependency graph** (“View dependency graph →” in the overview): directory-level aggregation with
role swimlanes by default (switchable to free force layout); click a directory node to expand to file
level; entries and hotspots promoted to file level stay visible; external dependencies appear as
aggregated nodes (Top 20 by default); edges and nodes in cycles are highlighted. The right-hand panel
follows the selection: **directory** → one-line role + directory-level reverse dependencies (who
depends on it / what it depends on / transitive upstream / key files) + layering evidence;
**file** → top-level symbols (click a symbol to jump to its line) + reverse dependencies (direct
references / transitive upstream / tests covering it); **external dependency** → explained only, no fake jump.

**The map is shareable**: the view is written into the URL (`view` / `tab` / `hot` / `denoise` /
`graph` / `glevel` / `gexpand` / `glayout` / `gext`) and “Copy map link” restores it exactly.

**Time and origin**: read-only git (recent commits / uncommitted changes) plus file mtime heat,
overlaid on the file tree. A host can still report “files (and line ranges) produced by this agent
round” via `POST /api/projects/:id/origin` and read them back via `GET /api/projects/:id/agent-lines`
— but **the current UI no longer draws agent-output badges** (removed on 2026-10-03 at the user’s
request); the endpoints remain for host integrations.

## Right dock: Changes / Commands / Overview

**Changes** (default tab) — git is the source of truth, no self-recorded baseline diffing:

- Data from read-only `git status --porcelain -uall` + `git diff --numstat HEAD` (max 500 entries)
- Each file row shows a status badge (M / A / D / R / C) plus added/removed lines; click the file to
  open it, click the line counts for a read-only diff; toggle “flat ↔ by directory”
- Four write actions (**local-only**, never via a shell, 60 s timeout): `git add -A`,
  `git commit -m`, `git pull --ff-only`, `git push` (push asks for confirmation)
- Non-git directories degrade honestly instead of pretending

**Commands** — only about **the project you currently have open** (narrowed on 2026-10-03):

- “Current project”: index status + git branch and uncommitted changes (each line fails
  independently — **a line that cannot be fetched simply does not appear**)
- “Project commands”: type one sentence (a default prompt is built in) → the backend starts a
  **read-only** Code Agent session to read the project and derive **build / background start /
  background stop / test** commands (commands the repo does not have are only suggested, nothing is
  written to the repo), saved to `~/.ide/commands/plans/<projectId>.json` and re-analysable;
  the analysis session can be watched in the Agent panel
- Clicking “Run / Run in background” on a command **really executes it**: always in the project root,
  always behind a confirmation dialog; `warn`-level commands (`rm -rf`, `git push`, `npm publish`,
  `sudo`, …) additionally require ticking a box; `block`-level commands (`rm -rf /`, `mkfs`,
  fork bombs, …) have their buttons disabled and are rejected by the backend
- Foreground runs are capped at 60 s / 200 KB of output; background runs are hosted by a standalone
  worker (`bin/run-with-log.mjs`) with live logs at `~/.ide/commands/logs/<runId>.log`
- “Background tasks for this project” lists only processes **started from this panel** and still
  running (pid / status / duration / log / stop); services you started yourself in a terminal are
  invisible to the backend and are honestly not shown
- **Available only when bound to localhost** (403 in share mode); the run list lives in memory, so
  after a backend restart you can neither see nor stop them (the background process itself may still run)

**Overview**: the project map’s key numbers (identity card, language distribution, entry candidates
and hotspots, orphans and cycles, directory roles); clicking an item opens the file in the editor.

## Code Agent (optional)

The “Code sessions” tab in the left panel turns the main area into Agent mode — **sessions on the
left, content in the middle**: talk in plain language and let it read / change / generate code;
“Back to code” returns to reading mode (same page, not a new window). Nothing sends a model request
unless you enter this mode.

- A deliberately **minimal** built-in agent: **one loop + one tool set** (no skills, no MCP, no
  sandbox), modelled on the core of pi; the loop is “call the model → execute any tools → feed
  results back → call again”, with events streamed to the UI
- Two kinds of tools: **index tools** (`find_symbol` / `goto_definition` / `find_references` /
  `file_outline` / `search_text`) reusing the same `/api/agent` implementation — asking “where is it
  defined / who calls it” hits the tree-sitter index instead of guessing with grep; and **file
  tools** (`read_file` / `write_file` / `edit_file` / `list_dir` / `glob` / `grep`) that actually let
  it change code. Every file path must stay inside the project root; anything outside is rejected
- When creating a session you pick the backend: **built-in** / **pi** (local
  `pi --mode rpc --no-session`) / **OpenHands** (placeholder that explains how to wire it up);
  only the built-in backend can switch models
- **Where pi comes from** (FR-0007): pi is not part of this source tree. It is looked up in this
  order — the path set in **Settings → Code Agent backend** → the drop-in dir `~/.ide/agents/pi/` →
  `PATH` (the `READER_PI_COMMAND` env var wins over all of them). Either install works:
  `npm install -g @earendil-works/pi-coding-agent` (goes on PATH), or
  `npm install --prefix ~/.ide/agents/pi @earendil-works/pi-coding-agent` (drops into the directory,
  no PATH change needed). When nothing is found, creating a pi session prints the drop-in path and
  both commands in the error (OpenHands only reserves `~/.ide/agents/openhands/`; no adapter yet)
- **Adapter layer**: `backend/src/agent/types.ts` defines the interface and normalised events
  (named after pi’s `agent_start` / `message_*` / `tool_execution_*` / `agent_settled`), and
  `adapter.ts` is the factory; wiring your own agent (pi / OpenHands / in-house) means writing one
  `AgentAdapter` implementation and registering it — **no frontend changes**
- Configure models under “Model” in the top bar (OpenAI-compatible base URL + API key + model id,
  with a default model); the plaintext key is only stored in `~/.ide/model-config.json` (mode 0o600)
  and the UI only ever echoes a masked value
- At most `READER_AGENT_MAX_STEPS` (default 24) tool calls per turn; session history lives in memory
  only and is gone after a restart

## Sharing and export (the courier)

“Share ▾” in the main area’s top row is a single entry point, so no more buttons pile up in the toolbar:

| What | How | What travels with it |
|---|---|---|
| Share a location | “Copy share link” or `Ctrl/Cmd+Alt+C` | `http://…/?project=…&file=…&line=…&col=…`, opening straight at the same line |
| Paste a snippet | Select in the editor → right-click “Copy selection with provenance” | First line `path:line-range`, followed by a fenced code block with the language |
| Paste an interface | ⧉ at the end of an outline row | `name (kind) path:line:col` + signature, without the whole implementation |
| Give a colleague context | “Markdown: current file / current search results / project overview” | Outline + **numbered source** + highlight verdicts (project vs external) |
| Paste into docs / a PR | “Screenshot PNG” or “Screenshot and copy to clipboard” | Self-drawn canvas: line-number gutter + syntax colours + the three-tier semantic palette + provenance footer |
| Archive before review | “Print / save as PDF” | The print view keeps only code and a header (`path:line` + project name), legible in black and white |
| Send to a colleague | “Share with a colleague” (reachable address) | A URL reachable on the same machine / LAN |
| Hand to an agent | “For agents” | The `/api/agent/tools` manifest URL, so agents query symbols instead of guessing with grep |

**Exports never degrade**: reports and screenshots keep the “which is a project symbol, which is an
external dependency” verdict.

## Semantic highlighting (project vs dependencies)

The editor highlights by **symbol ownership** in three tiers, so your own code stands out first:

| Tier | What it covers | Default colour |
|---|---|---|
| **Project** | Functions / classes / methods / properties / constants defined in this project, and references to them | `#ffffff` white + bold + subtle glow |
| **Local** | Local variables and parameters inside a function | `#cfe2ff` light blue |
| **External** | Standard library / third-party packages / built-ins (`os.path.*`, `print`, `process`, …) | `#9aa7b6` grey-blue |

- Verdicts come from backend resolution (`GET /api/projects/:id/highlights?file=`), not from regex guesses
- **Member accesses that cannot be resolved are not coloured** (e.g. `method` in `obj.method()`,
  which would need type inference) — they keep their editor syntax colour; better no highlight than a
  wrong one. `self` / `this` also keep their normal colour
- The three colours are CSS variables (`--hl-project` / `--hl-local` / `--hl-external` at the top of
  `frontend/src/styles.css`)
- If the index has not finished when you open a project, the page re-fetches highlights on the
  `index-ready` event — no refresh needed

## Language support (implementation notes)

The built-in language list and the `wcr lang` commands live in [README](../README.md#language-support);
this section covers the implementation contract.

A plugin is just an ESM package: `package.json` points `wcr.lang` at the entry, and the entry
exports `spec` (the same `LanguageSpec` the built-in languages use — see
`backend/src/languages/plugin.ts`). Three discovery rules: hand-dropped directories →
`<plugins dir>/node_modules` → this repo's `node_modules` (that last one is how preset packages
ship); duplicate ids are first-come-first-served. **A failing plugin only records an error and
never blocks startup** (errors show up in `GET /api/languages` under `errors`).

The frontend no longer hardcodes “extension → language / language → Monaco grammar · colour”:
the backend hands those over via `/api/languages`, so a new language needs nothing in `frontend/`
(the 81 grammars Monaco ships with are already in the bundle). The snapshot carries a language-set
signature, so a changed set triggers a full reindex.

When you write one, the bar is the same for every language — ten capabilities (highlighting,
colour dot, outline, symbol search, go-to-definition, find-references, hover, honest failure
explanations, density bar, signature flattening), three tiers, and a self-check list, all
specified in [`08-language-plugin-spec.md`](08-language-plugin-spec.md). The C / C++
plugin in the separate `wcr-lang-cpp` repo is the full-featured reference implementation.

## Platform (performance / reliability)

- **Second open is instant**: an index snapshot (NDJSON + gzip, **symbol facts only, no file bodies**)
  lands in `~/.ide/index/<id>/`; when the fingerprint matches, nothing is re-parsed or rewritten.
  Measured on a synthetic 1000-file repo: file tree **71 ms**, symbols jumpable in **1.0 s**
- **File bodies are read on demand**: hover / density / search read source code only when needed;
  the restore path performs **zero reads** (lazy reads with an LRU cache)
- **Parallel parsing**: multiple parse workers (`READER_PARSE_WORKERS`, 0 = serial), with automatic
  fallback to serial when workers are unavailable
- **Configurable ignore rules**: built-in blacklist < `.gitignore` < `.wcrignore` (negation with `!`,
  `**`, `/` anchoring) < global custom rules in Settings; `node_modules` / `.git` can never be opened
- **Degraded indexing for large files**: source files of 1–5 MB use “top-level symbol mode”
  (top-level definitions and imports only) and still appear in the outline / symbol search;
  files above 5 MB are text-viewable and text-searchable only
- **Non-UTF-8 encodings**: BOM / UTF-8 / UTF-16 / GBK detection and decoding; GBK comments display
  correctly and symbol positions stay accurate
- **Consistency reconciliation**: compares index against disk every 10 minutes by default
  (`READER_VERIFY_MS`) and heals missed watcher events; `POST /verify` triggers it manually
- **Incremental updates**: chokidar watching (300 ms debounce) reflects file changes immediately
- **Monorepos**: tsconfig `paths`/`baseUrl`, `go.work`, Python src layouts / `package-dir` all resolve
  across packages
- **One-command start / single instance**: `wcr [directory]` — a busy port yields to the next one, and
  repeated starts reuse the running instance
- **Settings & i18n**: “Model” and “Settings” sit side by side in the top bar; Settings groups
  Appearance (theme / font size / sidebar width / language), Editor (word wrap / indent / minimap /
  whitespace), Interface (reduced motion / Changes panel expanded by default), Index (custom ignore
  rules) and About (version + shortcut table); Chinese and English UI
- **Engineering**: `npm run lint` (ESLint 9, 0 errors), `npm run format`, `npm run test:unit`
  (vitest, 38 tests / 6 files), `.github/workflows/ci.yml` (typecheck + lint + backend/frontend tests
  + build + Chromium UI regression)

## Directory layout

```
backend/src/
  indexer/     parser (tree-sitter wrapper) / walker (generic AST traversal) / resolver / store
  indexer/insight.ts   project-map aggregation (overview / hotspots / orphans / cycles / complexity / roles)
  indexer/graph.ts     dependency graph and reverse dependencies (dir aggregation, expansion, Tarjan SCC, swimlanes)
  indexer/timeline.ts  time and origin (read-only git + mtime)
  indexer/callgraph.ts call hierarchy / type hierarchy / implementations
  indexer/flow.ts / explain.ts / summary.ts   call-flow view / structural explanation / file summary
  indexer/gitread.ts / gitwrite.ts            read-only git reads / the four write actions
  indexer/ignore.ts / encoding.ts / snapshot.ts / parse-pool.ts / parse-worker.ts   platform layer
  languages/   python / typescript / go / java / rust / shell / json / yaml / toml /
               markdown / css / html (AST) + dockerfile / ini / sql (line scan)
               manifests.ts (dependency/build manifests → highlight preview only, never indexed)
  agent/       types.ts (interface & events) / adapter.ts (factory) / builtin.ts (built-in loop) /
               tools.ts (tool set) / pi.ts (pi backend) / runtime.ts (pi lookup chain) /
               runtime-config.ts (backend path config) / openai.ts / model-config.ts / sessions.ts
  commands.ts  command discovery / risk levels / foreground execution / background worker hosting
  services.ts  restarting / stopping the reader itself (delegated to a detached worker)
  api/routes.ts        HTTP routes
  api/agent.ts         read-only agent tools (symbols / definitions / references / outline / text / line ranges)
  api/agent-session.ts Code Agent session and model-config routes
  registry.ts / watcher.ts / bootstrap.ts / cli.ts / config.ts / log.ts
frontend/src/
  App.tsx          shell (top bar / left panel / main area / right dock) + global shortcuts
  TopBar.tsx       top bar (project / add project / index status / model / settings / help)
  Editor.tsx       Monaco wrapper (model pool, read-only, positioning, position reporting, actions, highlighting)
  monaco-setup.ts  worker environment + Definition/Reference/DocumentSymbol/Hover/Link providers
  SidePanel.tsx    outline + references panel (references has no UI entry any more)
  FileTree.tsx / FileSearch.tsx / QuickOpen.tsx   file tree / file+content search / quick open
  Overview.tsx / GraphView.tsx / mapApi.ts / mapState.ts   project map / graph / map data
  ChangesPanel.tsx / changesState.ts                       right-dock “Changes” (git)
  CommandPanel.tsx / service.css                           right-dock “Commands” (FR-0005)
  AgentView.tsx / AgentSessions.tsx / agentStore.ts / agentApi.ts   Code Agent
  ShareMenu.tsx / share.ts / report.ts / snapshot.ts / bridge.ts    share / export / host bridge
  SettingsPanel.tsx / ModelSettings.tsx / ModelDialog.tsx / prefs.ts   settings / model / preferences
  Dialog.tsx / Notice.tsx / Welcome.tsx / FolderBrowser.tsx            dialogs / notices / welcome / folder picker
  i18n/            zh.ts / en.ts / index.ts (Chinese & English strings)
shared/types.ts    API contract shared by both sides (positions are 1-based, columns are UTF-16)
```

## API

`GET /api/integration/manifest` is the capability manifest (with the deep-link template and endpoint
list) — hosts can negotiate from it. Every path is validated against the project root; out-of-bounds
requests return 400. Routes marked **local** return 403 in share mode.

### Basics / settings

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Liveness (version, share mode, sharing hints) |
| GET | `/api/integration/manifest` | Capability manifest (endpoints / agentTools / deep-link template) |
| GET / POST | `/api/settings/ignore` | Read / write the global custom ignore rules |
| GET / POST | `/api/settings/agent` | Read / write the Code Agent backend (pi path, source, version, drop-in dir and install commands); POST is 403 in share mode |

### Projects and files

| Method | Path | Description |
|---|---|---|
| GET | `/api/projects` | Project list |
| POST | `/api/projects` | `{ root, name?, id? }` open / register a local directory (same root reuses the same id) |
| GET | `/api/projects/lookup?root=` | Look up a project by local path (for host integration) |
| GET | `/api/projects/:id` | Project info |
| DELETE | `/api/projects/:id` | Remove from the list (**never deletes files from disk**) |
| POST | `/api/projects/:id/reindex` | Full reindex |
| GET | `/api/projects/:id/status` | Index status |
| GET | `/api/projects/:id/ignore` | Effective ignore rules and hit statistics |
| GET | `/api/projects/:id/snapshot` | Snapshot state (exists / fingerprint hit / directory) |
| POST | `/api/projects/:id/verify` | Reconcile now and heal (added / changed / deleted) |
| GET | `/api/projects/:id/files` | File tree of indexable files |
| GET | `/api/projects/:id/all-files` | File tree of all files (incl. binaries / assets / ignored) |
| GET | `/api/projects/:id/file?path=` | File contents (415 for binary, 413 when too large) |
| GET | `/api/fs/dirs?path=` | Directory picker (**local**; 403 in share mode) |

### Code intelligence (navigation)

| Method | Path | Description |
|---|---|---|
| POST | `/api/projects/:id/goto-definition` | `{ file, line, col }` → `{ locations, reason, symbol, external? }` |
| POST | `/api/projects/:id/find-references` | `{ file, line, col, includeDeclaration? }` → references (with `isTest`) |
| GET | `/api/projects/:id/document-symbols?file=` | Symbol tree of a file |
| GET | `/api/projects/:id/workspace-symbols?q=&kind=&limit=` | Workspace symbol search |
| POST | `/api/projects/:id/search` | Text search (`options.dirs` scopes directories) |
| POST | `/api/projects/:id/search-stream` | Same as search, but SSE chunks per file (interruptible) |
| POST | `/api/projects/:id/call-hierarchy` | `{ file, line, col, direction: 'in' \| 'out', depth: 1~3 }` |
| POST | `/api/projects/:id/type-hierarchy` | Explicit extends / implements in both directions + unresolved base names |
| POST | `/api/projects/:id/implementations` | Implementations of an interface / abstract method |
| POST | `/api/projects/:id/hover` | Hover explanation (definition / literal / failure states) |
| GET | `/api/projects/:id/density?file=` | Whole-file density (code / comment / blank per 20 lines) |
| GET | `/api/projects/:id/highlights?file=` | Three-tier highlight data (`revision` = index version) |
| POST | `/api/projects/:id/explain` | Structural explanation (404 `no-symbol` when unresolvable) |
| POST | `/api/projects/:id/flow` | `{ kind: 'calls' \| 'callers' \| 'data', depth }` call flow |

`reason` values: `resolved` / `external` (external dependency or built-in, no jump) /
`unresolved` (needs type inference) / `no-symbol` (no symbol at the cursor).

### Project map / dependency graph

| Method | Path | Description |
|---|---|---|
| GET | `/api/projects/:id/overview` | `?hot=files\|refs\|symbols\|defined\|unique\|recent&denoise&limit&files=1` overview |
| GET | `/api/projects/:id/graph` | `?level=dir\|file&expand=<dir>&external=<n>&focus=` dependency graph |
| GET | `/api/projects/:id/dir-dependents` | `?dir=&depth=` directory-level reverse dependencies |
| GET | `/api/projects/:id/dependents` | `?file=&depth=` file-level reverse dependencies + upstream + covering tests |
| GET | `/api/projects/:id/routes` | Four reading routes (dependency order / entry downward / by heat / by freshness) |
| GET | `/api/projects/:id/file-summary?file=` | File-level structural summary |
| GET | `/api/projects/:id/readmap` | Reading snapshot data source (mtime / size / line count) |

### Changes / git

| Method | Path | Description |
|---|---|---|
| GET | `/api/projects/:id/git-changes` | `git status` + `git diff --numstat HEAD` (max 500) |
| POST | `/api/projects/:id/git-write` | `{ action: add \| commit \| pull \| push }` (**local**; push needs `?confirm=1`) |
| GET | `/api/projects/:id/file-diff?path=&rev=` | Read-only diff (working tree vs HEAD by default) |
| GET | `/api/projects/:id/blame?path=` | Per-line blame (truncated above 5000 lines / 8 MB) |
| GET | `/api/projects/:id/file-history?path=&limit=` | Commit history (`--follow`) |
| GET | `/api/projects/:id/git-show?rev=&path=` | Historical file contents |
| POST | `/api/projects/:id/changes` | `{ at, files }` → change list (M / A / D) |
| GET | `/api/projects/:id/timeline` | `?window=<minutes>` time and origin (git batches + mtime groups) |
| POST | `/api/projects/:id/origin` | Host reports “files / line ranges produced by this agent round” |
| GET | `/api/projects/:id/agent-lines?file=` | Agent-changed lines declared by the host for a file |

### Commands and service (**local only**)

| Method | Path | Description |
|---|---|---|
| GET | `/api/projects/:id/commands` | Stored command plan for the project (null if never analysed) |
| POST | `/api/projects/:id/commands/discover` | `{ prompt }` read-only agent derives commands (180 s default) |
| POST | `/api/projects/:id/commands/run?confirm=1` | `{ command, kind?, background? }` runs in the project root |
| POST | `/api/projects/:id/commands/stop` | `{ runId }` stops a background run |
| GET | `/api/projects/:id/commands/runs` | Run records (running background tasks include log tails) |
| GET | `/api/projects/:id/commands/risk?command=` | Risk level (`none` / `warn` / `block`) and reason |
| GET | `/api/service/status` | The reader’s own pid / port / uptime |
| POST | `/api/service/restart` / `/api/service/stop` | Restart / stop the reader (`?confirm=1`, delegated to a detached worker) |

### Code Agent and read-only tools

| Method | Path | Description |
|---|---|---|
| GET | `/api/agent/tools` | Read-only tool list (name / description / params schema / endpoint) |
| POST | `/api/agent/:id/call` | `{ tool, args }` unified call (use `_` as `:id` for global tools) |
| GET | `/api/agent/:id/symbols?q=&kind=&limit=` | Convenience: find symbol definitions by name |
| GET | `/api/agent/:id/outline?file=` | Convenience: file outline |
| GET | `/api/agent/:id/file?path=&start=&end=` | Convenience: read a line range (400 lines max by default) |
| GET / POST | `/api/agent/model-config` | Model providers (masked keys) / add or update one |
| POST | `/api/agent/model-config/remove` | Remove a provider |
| POST | `/api/agent/model-config/default` | Set / clear the default model |
| GET / POST | `/api/agent/sessions` | Session list / create (`{ projectId, name?, backend?, provider?, modelId?, readOnly? }`) |
| GET / DELETE | `/api/agent/sessions/:id` | Session detail / delete |
| GET | `/api/agent/sessions/:id/messages` | Session history |
| POST | `/api/agent/sessions/:id/prompt` | Send a message (progress over SSE) |
| POST | `/api/agent/sessions/:id/abort` / `/model` / `/rename` | Abort the turn / switch model / rename |
| GET | `/api/agent/sessions/:id/events` | SSE: `session_state`, `agent_start`, `message_*`, `tool_execution_*`, `agent_settled` |

### Lifecycle

| Method | Path | Description |
|---|---|---|
| GET | `/api/projects/:id/events` | SSE: `status` / `file-changed` / `file-deleted` / `index-ready` |
| GET | `/api/projects/:id/resources` | Resource view `{ watcher, streams, indexed, filesIndexed }` |
| POST | `/api/projects/:id/dispose` | Release resources: close watcher, drop SSE, free the in-memory index; **keeps the registry entry**, touches no files (idempotent) |

## Integration (for hosts such as xchen)

1. **Open a project**: `POST /api/projects { root }`, or check first with
   `GET /api/projects/lookup?root=`; the same directory always yields the same id, so the host can
   store it in its own project list.
2. **Jump to a location**: embed `/?project=<id>&file=<relative-path>&line=<n>&col=<n>`, or send
   `postMessage({ type: 'wcr:open', root, file, line, col })` to the iframe.
3. **Two-way handshake** (the reader always replies with a concrete `targetOrigin`, never `*`):

   | Direction | Message | When / what |
   |---|---|---|
   | Reader → host | `wcr:ready` | Project ready or index progress changed: `{ projectId, projectName, status }` |
   | Reader → host | `wcr:state` | Immediately on file switch, debounced on cursor moves: `{ projectId, file, line, col, selection? }` |
   | Reader → host | `wcr:bye` | Resources released as the host requested: `{ projectId, stoppedWatcher, releasedIndex, closedStreams, kept }` |
   | Host → reader | `wcr:dispose` | Collapsing the panel: the reader calls `POST /api/projects/:id/dispose` and replies `wcr:bye` |

   Release semantics: close the watcher, drop that project’s SSE, free the in-memory index, **keep the
   registry entry** (reopening by the host needs no re-registration; the index rebuilds
   automatically); not a single file in the read directory is touched. Verify cleanliness with
   `GET /api/projects/:id/resources`.
4. **Trust boundary (tight by default)**: only messages from the allow-list are handled —
   same origin + `?hostOrigin=https://host.example` on the iframe URL (comma-separated) + host
   origins registered in the reader. For debugging, `?hostOrigin=*` opens it up entirely
   (an explicit choice, never the default).
5. **CORS** is open by default; tighten with `READER_CORS_ORIGIN=a.com,b.com`.
6. **Agent tools**: fetch the list from `GET /api/agent/tools` and call
   `POST /api/agent/<projectId>/call { tool, args }`; answers are **symbol-level** (`file` / `line` /
   resolution `reason`) and unresolvable cases honestly return `unresolved` — nothing is invented.
7. The Monaco instance is reachable in-page via `window.__wcrMonaco` (debugging and deep integration).

## Shortcuts

| Key | Action |
|---|---|
| `F12` / `Ctrl+F12` / Ctrl+Click | Go to definition |
| `Shift+F12` | Find references |
| `Ctrl/Cmd+P` | Quick open file (empty query lists recent files) |
| `Ctrl/Cmd+T` | Workspace symbol search |
| `Ctrl/Cmd+Shift+F` | Project-wide text search (focuses the Search panel) |
| `Ctrl/Cmd+Shift+O` | File outline |
| `Ctrl/Cmd+Shift+E` | Focus the Files panel |
| `Ctrl/Cmd+Shift+R` | Continue reading (back to the last file, line and column) |
| `Ctrl/Cmd+1..4` / `Ctrl/Cmd+0` | Switch left panel (Files / Outline / Search / Code sessions); `0` = last |
| `Alt+←` / `Alt+→` | Back / forward |
| `Ctrl/Cmd+Alt+C` | Copy current position as `path:line:col` |
| `Ctrl/Cmd+Alt+E` | Explain the symbol at the cursor (structural, no model) |
| `Ctrl/Cmd+Alt+B` | Toggle the whole-file blame view |
| `Ctrl/Cmd+,` | Open Settings |
| Middle-click a tab | Open to the side (split view) |

`Ctrl/Cmd+F` (find in file) and `Ctrl/Cmd+G` (go to line) are built into Monaco.
Some browsers also grab `F12` / `Shift+F12` — the editor context menu and `Ctrl+F12` are equivalent
paths. The `?` button in the top-right corner has the full list plus the highlight legend.

## Known limitations

- **No type inference**: when `obj` in `obj.method()` is a local variable its type cannot be
  determined; only module / package / class-qualified names (`os.path.join`, `pkg.Func`, `Foo.bar`,
  `self.x` / `this.x`) resolve across files. In real-project sampling, about **53% of references jump
  precisely, 31% are correctly marked external**, and the remaining 16% are the cases above.
- Files inside dependencies (node_modules / site-packages, …) are not indexed; matches are marked `external`.
- CommonJS imports via `require('...')` are not resolved (ESM `import` works).
- Source files above 1 MB (and up to 5 MB) use **degraded indexing**: top-level definitions and
  imports only (no references or literals); above 5 MB they are text-viewable and text-searchable
  only. Reasons for every degradation or skip are visible in the index report.
- The index **has a snapshot but stores no file bodies** (`~/.ide/index/<id>/snapshot.ndjson.gz`);
  bodies are read from disk on demand. Second-open measurements (synthetic 1000-file repo): file tree
  71 ms, symbols jumpable in 1.0 s; on **10k files**: file tree 0.48 s, symbols jumpable in 11.5 s —
  the bottleneck is JSON-parsing 180k records, with a columnar binary format planned
  (`docs/06-platform-plan.md` §8).
- **The first `overview` takes about 2–3 seconds** (3.1 s on a real 191-file repo): it resolves every
  reference in the project once, then caches per index version, after which `overview` / `graph` /
  `dependents` are milliseconds; any file change invalidates the cache.
- **Git boundaries**: reads use only six **read-only** commands (`log` / `status` / `rev-parse` /
  `diff` / `blame` / `show`, array arguments, no shell, with timeouts); writes are exactly the four
  in the Changes panel (`add` / `commit` / `pull --ff-only` / `push`, local-only, push re-confirmed).
  Outside a git repo everything degrades honestly: time comes from mtime and the Changes panel simply
  does not appear.
- **Navigation boundaries**: call-hierarchy completeness is capped by the reference resolution rate;
  the type hierarchy only sees **explicitly written** `extends` / `implements` / embedded fields —
  dynamic registration and duck typing are not covered (and are labelled as such rather than faked).
- **Local data is written in only two places**: browser `localStorage` (preferences `wcr:prefs`,
  per-project position memory, search history, reading queue, host allow-list)
  and `~/.ide/` (project list, index snapshots, model config, command plans and logs). The trade-off
  is that preferences are lost when you switch machines.
- **UI entries that were removed (components and endpoints kept)**: Guide, References, Call hierarchy
  and Type hierarchy — on 2026-10-03 the user asked to remove only the UI entries and tabs; the
  capabilities remain available over the API (`/routes`, `/find-references`, `/call-hierarchy`,
  `/type-hierarchy`, `/explain`, `/flow`). The file tree no longer shows read / unread / agent-output
  badges either (`POST /origin` and `/agent-lines` are kept).
- **Code Agent boundaries**:
  - It **writes project files** — one of the few entries that write to the read directory; every write
    path must stay inside the project root, otherwise it is rejected outright (400 `path_escape`).
  - **The built-in agent does not execute commands** (no bash in its tool set); use the Commands panel
    for tests / installs, or choose the pi backend (whose limits are pi’s own — it runs commands and
    reads/writes files as needed).
  - **Session history is memory-only**: gone when the backend restarts, and sessions do not span projects.
  - **The plaintext key is stored on disk**: `~/.ide/model-config.json` (0o600; on Windows chmod is
    mostly a no-op, so it relies on directory permissions).
  - Messages render as plain text (thinking and tool calls are collapsible); one session runs one turn
    at a time.
  - Not implemented: permission prompts, sandboxing, token budgets (only the hard cap of N tool calls
    per turn).
- **Commands panel boundaries**:
  - “Analyse” starts a **read-only** Code Agent session (no `write_file` / `edit_file` in the tool
    set), so commands the repo does not have are only suggested — nothing is written to the repo.
  - “Run / Run in background” **really executes** (project root + confirmation); `warn` commands need
    an extra tick, `block` commands are rejected by the backend.
  - Local-only (403 in share mode); **run records are memory-only**, so after a backend restart you can
    neither see nor stop them (the background process may still be running).
  - The panel only describes **the currently open project**: lines that cannot be fetched simply do
    not appear, never an empty placeholder.
- **Sharing boundaries**: same machine / same directory only; screenshots and printing cover **the
  currently visible range**, not a paginated whole-file export; the public `/api/agent/tools` stays
  **read-only** (no file writes, no command execution).
- **Service commands**: `POST /api/service/restart|stop` restart / stop **the reader itself** and have
  no UI entry (removed from the Commands panel on 2026-10-03 so that “the tool’s own process” never
  leaks into a project view); local-only.

## Tests and engineering

```bash
npm test              # all backend tests (node:test + tsx, 40 files)
npm run typecheck     # typecheck backend and frontend
npm run lint          # ESLint 9 (0 errors required)
npm run format:check  # Prettier format check
npm run test:unit     # frontend unit tests (vitest, 38 tests / 6 files)
npm run test:ui       # browser UI regression (real Chromium; creates and removes its own fixture project, port 8799)
npm run bench         # benchmarks: synthetic-repo first open / index / second open / query P50-P95 / incremental
```

The UI regression suite lives in `tests/ui/` and `run.mjs` sets up the fixture project and backend:
`navigator.mjs` (navigation and courier: the file tree collapsed by default with two colours,
Ctrl+P file open and tabs, the search panel (fullscreen / stop / directory grouping), the notice bar
when pressing F12 on an external dependency, copy location, **copy selection with provenance**,
**share deep links**, print-view header, the right-dock Commands tab showing the current project’s
state, file nodes in the graph sticking to their own directory), `guide.mjs` (recommended routes on
the first screen, “Start reading” entering step 1, **the Changes panel docked on the right with git
as the source of truth** — clicking the added/removed counts opens a diff — structural explanation),
`platform.mjs` (Model next to Settings in the top bar, the five settings groups, switching to light
theme actually re-themes, font size landing in `wcr:prefs` with immediate effect, switching to
English, four permanent left-panel tabs with Overview beside Changes / Commands in the right dock,
the “Add project” dialog picking a directory, no console errors throughout) and `panel.mjs` (the open
action for the four permanent left-panel tabs).

Backend-specific suites include `dispose.test.ts` (resource view / release / idempotence / SSE
teardown), `agent.test.ts` (read-only tool manifest and each tool), `agent-builtin.test.ts` (Code
Agent: masked model config, a loop that really executes tools and writes files, result feedback,
error paths, path escapes, glob semantics — using a local fake OpenAI endpoint, so no real key is
needed) and `commands.test.ts` (command discovery / risk levels / execution).
CI (`.github/workflows/ci.yml`) runs typecheck, lint, backend and frontend tests, the build and the UI
regression on every push and PR; `bench` deliberately stays out of CI (it takes minutes) and is run
locally or overnight.
