# Web-based Code Reader (web-code-reader)

**English** | [中文](README.zh-CN.md)

A code reader that runs in your browser: the backend builds an index with tree-sitter, the frontend
uses Monaco purely for rendering and querying. VS Code-style navigation (F12 / Shift+F12 /
Ctrl+Shift+O and friends) all work.

Positioning (see `FR/FR-0002-fr.md`): **built for reading** — no compiling, debugging, refactoring
or type checking.

Reading itself is read-only: indexing and browsing **never modify a single file in the directory
being read**. Only four things write to disk, and every one of them must be triggered by you
explicitly: **git write actions in the Changes panel** (add / commit / pull / push),
**running commands in the Commands panel**, **the Code Agent editing files**, and the command
endpoints a host calls itself.

## UI at a glance

| Area | Contents |
|---|---|
| **Top bar** | Project dropdown, Add project (type a path or pick from a folder dialog), Reindex, Remove, project root, indexing progress, Copy file link, Model, Settings, `?` (shortcuts & highlight legend) |
| **Left panel** (4 permanent tabs, drag-resizable 240–560) | Files / Outline / Search / Code sessions |
| **Main area** (three states) | Code · Project map · Agent; the code top bar holds tabs on the left (max 8) and “← → · Share ▾” on the right; the project-map toggle sits in the bottom-right rail, above the layout toggles |
| **Right dock** (permanent, expanded by default, drag-resizable 220–560, collapsible) | Changes / Commands / Overview |

Since 2026-10-03 the sidebar no longer has a “More ▾” submenu, and the Guide / References /
Call hierarchy / Type hierarchy panels no longer have UI entries (their components and backend
endpoints are kept — see “Known limitations”). Auxiliary information now lives in the right dock.

## Quick start

```bash
# 1) Install dependencies (once, from the repo root)
npm run install:all

# 2) Build the frontend (the backend serves frontend/dist directly)
npm run build

# 3) Start (default http://127.0.0.1:8787)
npm start
```

One-command start (auto-picks a port, reuses a running instance, opens the browser):

```bash
npm run cli -- <local-directory>   # same as npx tsx backend/src/cli.ts <local-directory>
npm run cli -- --help              # all options (--port / --host / --no-open / --no-watch / --workers)
```

Development mode (frontend hot reload; `/api` is proxied to 8787):

```bash
npm run dev:backend    # terminal 1
npm run dev:frontend   # terminal 2 → http://127.0.0.1:5173
```

In the page, click “Add project” and type an absolute path (e.g. `D:/code/my-project`) or use the
folder icon to pick a directory. Deep links jump straight to a location:

```
http://127.0.0.1:8787/?project=<project-id>&file=src/app.py&line=42&col=5
```

### Shipping it to someone else (two paths, see `docs/06-platform.md`)

**A. npx / tarball (they have Node)**

```bash
npm run build && npm pack              # produces web-code-reader-0.1.0.tgz
npx ./web-code-reader-0.1.0.tgz D:/code/my-project
```

**B. Docker (no Node needed; a read-only mount is the strongest guarantee)**

```bash
docker build -t web-code-reader .
docker run --rm -p 8787:8787 -v D:/code:/work:ro web-code-reader
# open http://127.0.0.1:8787 and enter /work/my-project as the project path
```

Inside the container the server binds `0.0.0.0` (otherwise the host cannot reach it), but the mount
is `ro` — the directory being read is **physically unwritable**; `/data` is a writable container
volume holding only the project list, index snapshots and command plans.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Listen port (0 = OS-assigned) |
| `HOST` | `127.0.0.1` | Listen address; **anything outside the local-host set means “share mode”**, where command execution / directory browsing / git writes / service management all return 403 |
| `READER_DATA_DIR` | `~/.ide` | Data directory (project list, model config, index snapshots, command plans and logs); a legacy `<repo>/data` is copied over once at startup (copy only, never delete) |
| `READER_FRONTEND_DIST` | `<repo>/frontend/dist` | Frontend build output directory |
| `READER_WATCH` | on | `0` disables file watching |
| `READER_PERSIST` | on | `0` disables index snapshot persistence |
| `READER_PARSE_WORKERS` | `min(4, max(2, cpus-1))` | Number of parse workers; `0` = serial |
| `READER_VERIFY_MS` | `600000` | Index reconciliation interval; `<=0` disables |
| `READER_IGNORE_BUILTIN` | on | `0` disables the built-in ignore blacklist |
| `READER_USER_IGNORE` | `~/.ide/ignore-user.txt` | Global custom ignore-rule file |
| `READER_CORS_ORIGIN` | `*` | CORS allow-list, comma separated |
| `READER_LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |
| `READER_LOG_FILE` | none | Also write logs to a file |
| `READER_MODEL_CONFIG` | `~/.ide/model-config.json` | Code Agent model configuration |
| `READER_AGENT_MAX_STEPS` | `24` | Max tool calls per turn for the built-in agent |
| `READER_PI_COMMAND` / `READER_PI_TIMEOUT_MS` | `pi` / `30000` | pi backend executable and response timeout (highest-priority link of the lookup chain) |
| `READER_AGENT_RUNTIME` | `~/.ide/agent-runtime.json` | Code Agent backend path configuration (rarely needed) |
| `READER_COMMAND_TIMEOUT_MS` | `180000` | Command discovery (read-only agent) timeout |
| `READER_COMMAND_DIR` | `~/.ide/commands` | Command plans and background logs |
| `READER_PERF` | unset | Set to `1` to run the performance tests |

### Sharing on the same machine / LAN

By default the server only binds `127.0.0.1` (local access only). To let a colleague on the same
machine or LAN read too, restart with `HOST=0.0.0.0 npm start` — the startup log and “Share with a
colleague” will show a reachable address (`http://<host-ip>:8787/?project=<id>`); tighten origins
with `READER_CORS_ORIGIN=https://host-a,https://host-b` when needed. In share mode, command
execution, directory browsing, git writes and restarting / stopping the reader itself are all
disabled at the endpoint level (403).

## Language support


**Indexable languages** (symbol index, jump-to-definition, part of language distribution): 20 built in.
More can be added as plugin packages, without touching this repo — see “Installing another language”
below:

| Parsing | Languages (id) | Extensions / filenames |
|---|---|---|
| tree-sitter AST | Python, TypeScript (`typescript` / `tsx` / `javascript` / `jsx`), Go, Java, Rust, Shell (Bash grammar), JSON, YAML, TOML, Markdown, CSS (`css` / `scss` / `less`), HTML | `.py`, `.ts/.tsx/.js/.jsx/.mjs/.cjs`, `.go`, `.java`, `.rs`, `.sh/.bash/.zsh`, `.json/.jsonc`, `.yml/.yaml`, `.toml`, `.md`, `.css/.scss/.less`, `.html/.htm` |
| Line scan `lineSymbols` (no tree-sitter grammar available) | Dockerfile, INI / ENV, SQL | `Dockerfile`/`Containerfile`, `.ini/.cfg/.conf/.properties/.env`, `.sql` |

Shell additionally supports function / variable jumps and `source` dependencies. SQL objects (tables /
views / indexes) are jumpable too: object names after `FROM` / `JOIN` / `INTO` / `UPDATE` / `TABLE` …
count as references, so go-to-definition / find-references / hover work (and `CREATE` names feed the
outline); resolution is library-wide across `.sql` files. **Package
dependency / build manifest files** (`go.mod`/`go.sum`, `requirements*.txt`, `Pipfile`,
`poetry.lock`/`uv.lock`, `pom.xml`/`*.csproj`, `build.gradle`/`*.kts`/`*.sbt`,
`Gemfile`/`*.gemspec`/`*.podspec`, `mix.exs`, `Package.swift`, `Cargo.lock`/`composer.lock`/
`pubspec.lock`, `.npmrc`/`.yarnrc`, `Makefile`, …) are **highlighted and previewed only** — they never
enter the symbol index, the language distribution or reading routes. Language detection for them
lives in `languages/manifests.ts`, separate from `specForFile`.


#### Installing another language (language plugins)

`wcr` is this package's CLI (`bin/wcr.mjs`, from `npm i -g .` or the packed tarball); without a
global install, run the same thing from the repo root as `npm run cli -- lang <subcommand>`. A
language is a **standalone plugin package**: install one and restart — no change to this repo's
source, no frontend rebuild.

```bash
wcr lang list                            # loaded languages + origin + load failures
wcr lang add wcr-lang-zig                # install a language package (into <data dir>/languages)
wcr lang add D:/my-langs/demo-lang       # or a local directory
wcr lang link D:/my-langs/demo-lang      # symlink a plugin you are developing (restart reloads it)
wcr lang new zig --dir ../wcr-lang-zig   # scaffold a plugin project (skeleton + self-check)
wcr lang remove wcr-lang-zig             # uninstall (by package name or language id)
```

The plugin directory defaults to `<data dir>/languages` (`READER_PLUGINS_DIR` overrides it);
`READER_PLUGINS=0` loads no plugins at all. `add` / `remove` / `link` **take effect after a
restart** (a changed language set triggers a full reindex). How to write one and the bar it must
meet: [`docs/08-language-plugin-spec.md`](docs/08-language-plugin-spec.md).


## Known limitations

- **No type inference**: `obj.method()` cannot be resolved when `obj` is a local variable; package
  internals are not indexed and resolve to `external`.
- CommonJS `require('...')` imports are not resolved (ESM `import` works).
- Source files of 1–5 MB fall back to **degraded indexing** (top-level definitions and imports only,
  no references or literals); above 5 MB they are text-viewable and text-searchable only.
- The first "Overview" takes 2–3 seconds (it resolves every reference in the project); later opens
  are cached.
- The Guide / References / Call hierarchy / Type hierarchy UI entries were removed (their components
  and backend endpoints are kept).

Full list (with the boundaries and measured basis of each item) in
[`docs/10-features.en.md`](docs/10-features.en.md#known-limitations).


## Docs

- [Features and implementation details](docs/10-features.en.md) — full capability list, API,
  shortcuts, known limitations
- Topics: [01 Project map](docs/01-map.md) · [02 Lens](docs/02-lens.md) · [03 Navigator](docs/03-navigator.md) ·
  [04 Guide](docs/04-guide.md) · [05 Share](docs/05-share.md) · [06 Platform](docs/06-platform.md)
- Language plugins: [07 plan](docs/07-languages-plugin-plan.md) · [08 spec (ten capabilities)](docs/08-language-plugin-spec.md)
- The topic docs are written in Chinese (the project's primary language); `*-plan.md` /
  `*-decisions.md` / `*-verify.md` are decision and acceptance records. Requirements live in `FR/`.


## License

Released under the [MIT License](LICENSE). © 2026 yiluo-ya
