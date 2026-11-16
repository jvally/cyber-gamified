# ShellShock Academy — Implementation Plan

> Written before implementation. Where the code differs, the README is authoritative
> (for example `&&`/`||`, `find -exec` and `2>` were built in v1 rather than deferred).

Browser puzzle game: simulated Linux shell over a virtual filesystem, teaching defensive security.
Stack: TypeScript (strict), Vite, xterm.js (`@xterm/xterm` + `@xterm/addon-fit`), Vitest. No backend; progress in localStorage.

---

## 1. Assumptions (flagged)

| # | Assumption | Why |
|---|---|---|
| A1 | Add commands beyond the required list: `ss` (`-tlnp`), `rm`, `cp`, `mv`, `mkdir`, `touch`, `whoami`, `id`, `clear`, `history`, `sudo`, plus game commands `submit`, `help`, `hint`, `levels`, `reset` | Level 5 needs a way to see listening sockets; level 7 needs a way to delete cron entries; recon levels need an answer mechanic |
| A2 | Virtual `/proc/<pid>/{cmdline,status}` generated from the process table | Gives level 5 a second solution path |
| A3 | Analysis levels (1, 2, 3, 6, 8) end with `submit <answer>`; remediation levels (4, 5, 7) are checked against FS/process state | Keeps "exactly one clear goal" checkable |
| A4 | `sort`, `uniq`, `ls` ordering emulate `LC_ALL=C` (byte order) | GNU default collation is locale-dependent; C locale is deterministic. Documented |
| A5 | Player is a non-root user (`analyst`) with `sudo` as a prefix that runs one command as root | Teaches least privilege; needed to touch `/etc` and root processes |
| A6 | Fixed simulated clock per level (e.g. `2026-11-15 09:00`) | Deterministic `ls -l` / mtime output and tests |
| A7 | Pure-TS synchronous SHA-256 (tested against NIST vectors) | Web Crypto is async; the interpreter stays synchronous |
| A8 | No git remote exists. Commits are local; the container is ephemeral | **You need to create/point to a GitHub repo for the work to survive the session** |
| A9 | No shell scripting (loops, functions, `$(...)`) in v1 | Scope; listed under unsupported |

---

## 2. Architecture

```
xterm.js ──keystrokes──> LineEditor (pure, testable) ──line──> Shell.run(line)
                                                               │
                         tokenizer → parser (AST) → expander (vars, ~, globs) → executor
                                                               │
                                     Command registry (one module per command)
                                                               │
                              GameState { vfs, procs, env, cwd, user, submitted, history }
                                                               │
                         LevelEngine: goalCheck(state) / failCheck(state) after every command
                                                               │
                              UI panel (mission, hints, concept card)  ·  Progress (localStorage)
```

Everything below `Shell.run` is pure TS with no DOM → fully unit-testable in Node.

---

## 3. File layout

```
shellshock-academy/
  index.html
  package.json  tsconfig.json  vite.config.ts  vitest.config.ts
  README.md     docs/UNSUPPORTED.md
  src/
    main.ts                      # bootstraps UI
    vfs/
      vfs.ts                     # Node tree, resolve(), read/write/mkdir/unlink, stat
      perms.ts                   # mode bits, canRead/Write/Exec, symbolic+octal chmod parser
      path.ts                    # normalize, join, ~ expansion, basename/dirname
      users.ts                   # simulated /etc/passwd + /etc/group lookups
    sim/
      processes.ts               # process table, signals, socket listing
      procfs.ts                  # virtual /proc view
      clock.ts
    shell/
      tokenizer.ts               # quotes, escapes, operators
      parser.ts                  # → AST
      expand.ts                  # $VAR, $?, ~, globbing against VFS
      executor.ts                # pipelines, redirects, exit codes
      getopt.ts                  # -la, -n5, -n 5, --long, --long=v, --
      shell.ts                   # public API: run(line) → {stdout, stderr, code}
      commands/
        index.ts                 # registry: {name, run, help, usage, completeFlags}
        ls.ts cd.ts pwd.ts cat.ts head.ts tail.ts grep.ts find.ts chmod.ts chown.ts
        ps.ts kill.ts sort.ts uniq.ts wc.ts cut.ts sha256sum.ts base64.ts echo.ts
        ss.ts rm.ts cp.ts mv.ts mkdir.ts touch.ts whoami.ts id.ts sudo.ts history.ts
        game.ts                  # submit, help, hint, levels, reset
    crypto/sha256.ts  crypto/base64.ts
    levels/
      types.ts                   # Level schema
      engine.ts                  # load level, build state, check goal/fail, scoring
      builders.ts                # helpers: file(), dir(), proc(), authLog generator
      01-leaked-env.ts … 08-base64-config.ts
      index.ts
    progress/store.ts            # versioned localStorage, schema-validated, safe fallback
    ui/
      lineEditor.ts              # cursor, history, ctrl keys (pure)
      completion.ts              # command + path + flag completion (pure)
      terminal.ts                # xterm wiring
      panel.ts  conceptCard.ts  levelSelect.ts  styles.css
  tests/
    vfs/*.test.ts  shell/*.test.ts  commands/<cmd>.test.ts
    pipelines.test.ts            # multi-stage chains
    levels.solutions.test.ts     # runs every solution path through the real interpreter
    levels.schema.test.ts        # structural checks on every level
    ui/lineEditor.test.ts  ui/completion.test.ts  progress.test.ts
    fixtures/gnu/                # golden outputs captured from real GNU coreutils
```

---

## 4. Interpreter design

**Tokenizer** — produces `WORD` (with per-segment quote info, so globs/vars only expand in unquoted parts), `PIPE |`, `GT >`, `DGT >>`, `LT <`, `ERR 2>`, `ERR_APPEND 2>>`, `DUP 2>&1`, `SEMI ;`, `AND &&`, `OR ||`.
- Single quotes: literal. Double quotes: `$VAR` and `\"` `\\` `\$` escapes only. Backslash outside quotes escapes next char.
- Errors mirror bash: `bash: syntax error near unexpected token '|'`, unterminated quote → `bash: unexpected EOF while looking for matching '''`.

**Parser** — AST:
```ts
type List     = { items: { pipeline: Pipeline; op: ';' | '&&' | '||' | null }[] }
type Pipeline = { commands: SimpleCommand[] }
type SimpleCommand = { argv: Word[]; redirects: Redirect[] }
type Redirect = { fd: 1 | 2 | 0; kind: '>' | '>>' | '<' | 'dup'; target: Word }
```

**Expander** — `~`, `$HOME $USER $PWD $?`, globs `* ? [abc] [!a]` against VFS (no match → literal, like bash default); hidden files only matched by explicit leading dot.

**Executor** — buffered model: each stage gets `stdin: string`, returns `{stdout, stderr, code}`; stdout feeds the next stage. Stderr goes to terminal unless redirected. Pipeline exit code = last stage. Redirects resolved before execution (bash creates/truncates `>` targets first, so `sort f > f` empties f — replicate it). Permission checks on redirect targets.
- Command context: `{ state, args, stdin, env, cwd, user, stdout(), stderr() }`.
- Unknown command → `bash: foo: command not found`, exit 127.

**Command fidelity strategy**
- Error format per GNU: `cat: x: No such file or directory`, `ls: cannot access 'x': No such file or directory`, `bash: cd: x: No such file or directory`, `chmod: changing permissions of 'x': Operation not permitted`, `kill: (123) - No such process`.
- Exit codes: 0 / 1 / 2 (usage) like GNU.
- Golden tests: generate fixture trees, run the real GNU command in this container once, store the output, compare against the simulator (`ls -l`, `wc`, `uniq -c`, `sort -rn`, `cut`, `grep -c/-n/-v/-i/-o/-E/-r`, `head/tail -n`, `sha256sum`, `base64`).

**Flag coverage (v1)**
| Cmd | Flags |
|---|---|
| ls | -l -a -A -h -R -t -r -1 -d |
| cat | -n |
| head/tail | -n N, -N, -c N; tail -n +N |
| grep | -i -v -c -n -r/-R -l -o -E -F -w -h -H, multiple files |
| find | path, -name -iname -type f/d -perm (-/exact, e.g. -4000, /o+w) -user -mtime -newer -size, -maxdepth |
| chmod | octal, symbolic (u/g/o/a, +-=, rwxX), -R |
| chown | user, user:group, :group, -R |
| ps | aux, -ef, -u user |
| kill | PID…, -9, -SIGKILL, -KILL, -15, -l |
| sort | -n -r -k N[,M] -t -u -h |
| uniq | -c -d -u -i |
| wc | -l -w -c |
| cut | -d -f (ranges/lists) -c |
| sha256sum | files, stdin, -c manifest |
| base64 | encode, -d, -w N |
| echo | -n -e |
| ss | -t -l -n -p (combined) |

---

## 5. Level schema

```ts
interface Level {
  id: string; order: number; title: string;
  story: string;                    // narrative intro
  objective: string;                // the single goal, one sentence
  user: string; cwd: string;
  clock: string;                    // fixed ISO time
  initialFS: FSSpec;                // declarative tree via builders
  initialProcesses: ProcSpec[];
  goalCheck(state: GameState): boolean;
  failCheck?(state: GameState): string | null;   // e.g. "You killed sshd — production is down."
  hints: [string, string, string];  // nudge → approach → near-solution
  conceptCard: { attack: string; detection: string; mitigation: string; commands: { cmd: string; explain: string }[] };
  idealSolution: string[];
  altSolutions: string[][];         // ≥1 → guarantees ≥2 valid paths
  wrongSolutions?: string[][];      // must NOT pass (e.g. kill every process, chmod 000)
}
```

**Tests enforced on every level:** initial state fails `goalCheck`; `idealSolution` and every `altSolutions` entry pass; every `wrongSolutions` entry fails or trips `failCheck`; `altSolutions.length ≥ 1`; 3 hints present; concept card fields non-empty; every command in a solution is in the registry.

---

## 6. The eight levels

| # | Title | Goal (single) | Path A | Path B |
|---|---|---|---|---|
| 1 | Leaked .env recon | `submit` the leaked AWS access key ID found in a web-root `.env` | `find / -name ".env"` → `cat` | `grep -r AWS_ACCESS_KEY_ID /var/www` |
| 2 | Failed SSH logins | `submit` count of failed password attempts in `/var/log/auth.log` | `grep "Failed password" auth.log \| wc -l` | `grep -c "Failed password" auth.log` |
| 3 | Top attacker IP | `submit` IP with the most failed logins | `grep Failed … \| cut -d' ' -f11 \| sort \| uniq -c \| sort -rn \| head -1` | `grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' … \| sort \| uniq -c \| sort -n \| tail -1` |
| 4 | Over-permissive private key | `~/.ssh/id_ed25519` mode `600`, owned by analyst | `chmod 600 …` | `chmod go-rwx …` / `chmod u=rw,go= …` |
| 5 | Suspicious listener | Kill only the rogue process on port 4444 (sshd/nginx must survive) | `ss -tlnp` → `kill <pid>` | `ps aux \| grep -v …` / `cat /proc/<pid>/cmdline` → `sudo kill -9 <pid>` |
| 6 | Integrity check | `submit` the tampered binary's path | `sha256sum -c /opt/manifest/SHA256SUMS \| grep FAILED` | `sha256sum /usr/local/bin/*` and compare to manifest with `grep`/`sort` |
| 7 | Cron persistence | Remove the malicious cron entry; legitimate jobs stay | `grep -r curl /etc/cron.d /etc/crontab` → `sudo rm /etc/cron.d/system-update` | `ls -lt /etc/cron.d` or `find /etc -type f -mtime -3` → `sudo mv` it to a quarantine directory |
| 8 | Base64 config | `submit` the C2 domain hidden in a base64 field | `grep c2 conf \| cut -d= -f2 \| base64 -d` | `echo '<blob>' \| base64 -d` |

Fail states: L5 killing sshd/nginx; L7 deleting legit cron files; L4 `chmod 000` (key unusable) — each shows why and offers `reset`.

---

## 7. UI

- xterm.js terminal; custom `LineEditor` (insert, backspace, ←/→, Home/End, Ctrl+A/E/U/K/W/C/L, ↑/↓ history).
- Tab completion: first word → commands; otherwise paths (dirs get `/`), `-` → flags; double-Tab lists candidates.
- Side panel: story, objective, hint button (shows tier N, deducts points, confirms first), score, commands used.
- `help` lists commands; `help <cmd>` prints usage + flags + one security-flavoured example.
- Level complete → concept card modal (attack / detection / mitigation / your commands vs ideal) → next level.
- Level select grid: locked/unlocked/completed, best score, Replay button.

## 8. Scoring & progress

- 100 base per level; hint tiers cost 10 / 20 / 30 (cumulative max −60); floor 10. Optional par bonus +10 if command count ≤ ideal length + 2.
- localStorage key `shellshock:v1` → `{ version, levels: { [id]: { completed, bestScore, hintsUsed, attempts } }, settings }`. Validate on load; corrupted → reset with console warning.
- Replay: completed levels restart from initial state; best score kept; replay never lowers best.

---

## 9. Milestones (each: tests green → local commit)

| M | Deliverable | Exit criteria |
|---|---|---|
| 0 | Scaffold: Vite vanilla-ts, strict TS, Vitest, git init | `npm test`, `npm run build` pass |
| 1 | VFS + perms + interpreter + 20 commands + ss/rm/cp/mv/mkdir/touch/sudo | ~250+ unit tests incl. quoting, redirects, pipe chains, error messages, golden GNU fixtures |
| 2 | Level schema + engine + solutions test harness (with 1 sample level) | solutions test runs ideal + alt paths through real interpreter |
| 3 | Terminal UI, completion, history, panel, hints, `help <cmd>` | LineEditor/completion unit tests; manual + Playwright smoke screenshot |
| 4 | Eight levels | all level tests pass, ≥2 paths each, wrong paths rejected |
| 5 | Concept cards | schema test enforces fields; modal renders |
| 6 | Progress, scoring, level select, replay | store tests (corruption, migration, replay rules) |
| 7 | Final: full suite + `tsc --noEmit` + build; README, UNSUPPORTED.md, 5 next levels | all green |

---

## 10. Unsupported in v1 (to be documented)

Command substitution `$(…)`/backticks, subshells `( )`, here-docs, loops/conditionals/functions, job control (`&`, `fg`, `bg`), brace expansion, aliases, variable assignment/`export`, `awk`/`sed`/`xargs`/`tr`/`diff`, symlinks and hardlinks, ACLs/SELinux, sticky/SUID semantics (bits displayed but not enforced), real signals beyond terminate, non-C locales, binary files, interactive programs (`less`, `vim`, `top`).

---

## 11. Improvements and extensions (post-v1, ranked by learning value)

**Learning**
1. **Pipe visualizer** — `explain <pipeline>` shows the output of each stage side by side. Biggest single aid to understanding pipes.
2. **Mistake-aware hints** — inspect the last command's error/exit code to tailor the hint ("you grep'd for `failed` but logs say `Failed`; try `-i`").
3. **Randomised level data per seed** — attacker IPs, PIDs, keys regenerated each playthrough; goal values computed from generated data. Stops answer memorisation; replay stays meaningful.
4. **Free-play sandbox** with all commands and a scratch FS.
5. **Command mastery tracker** — which commands/flags you've used, with spaced-repetition micro-challenges for weak ones.
6. **Golf mode** — leaderboard (local) for fewest commands / shortest pipeline.

**Engine**
7. `&&`/`||` already in v1; next: `$(…)`, `xargs`, `tr`, `sed -n/s///`, `awk '{print $N}'` subset, `diff`, `stat`, `file`, `strings`, `find -exec … {} \;`, `less`-style pager.
8. Simulated services: `journalctl`, `last`/`lastlog`, `crontab -l/-e`, `systemctl list-units`, `netstat`.
9. Enforce SUID/sticky semantics so permission levels become richer.

**Authoring & quality**
10. Levels as JSON + declarative goal predicates (`fileMode`, `processAbsent`, `submittedEquals`, `fileNotContains`) → custom/community levels importable without code.
11. `npm run validate-levels` CLI that runs every solution and prints a report.
12. Property-based tests (fast-check): e.g. `sort | uniq -c` counts equal a JS reference; `base64 -d (base64 x) == x`.
13. Playwright e2e test that plays level 1 end-to-end through the real terminal.
14. Accessibility: xterm screen-reader mode, high-contrast theme, reduced motion; keyboard-only level select.

**Candidate next levels** (final 5 chosen at M7): SUID binary audit (`find / -perm -4000`), rogue key in `authorized_keys`, UID-0 backdoor account in `/etc/passwd`, web shell in an uploads directory (pattern hunting), log-tampering timeline via `find -newer` / mtime gaps, world-writable files in `/etc`, `.bash_history` forensics, DNS-exfil detection from long subdomains in resolver logs.
