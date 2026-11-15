# ShellShock Academy

A browser puzzle game for learning defensive security while practising Linux shell commands.
You play a security analyst on a compromised web server and solve eight levels from a terminal:
reading logs, fixing permissions, hunting a backdoor, verifying file integrity, removing persistence.

Everything runs in a **simulated shell over a virtual filesystem** inside the page. There is no backend,
nothing touches your real OS or network, and the content is defensive only: no exploit code, no malware,
no scanning.

## Run it

Requires Node 20.19+ or 22.12+ (what Vite 8 needs).

```bash
npm install
```

```bash
npm run dev
```

Then open the URL Vite prints (http://localhost:5173 by default).

| Command | What it does |
|---|---|
| `npm run dev` | dev server with hot reload |
| `npm test` | run the Vitest suite once |
| `npm run test:watch` | tests in watch mode |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | typecheck, then production build into `dist/` |
| `npm run preview` | serve the production build |

`dist/` is fully static and uses relative paths, so it can be hosted anywhere (GitHub Pages, any file server).

## How to play

- Type commands in the terminal. `help` lists them; `help <cmd>` (or `<cmd> --help`, `man <cmd>`) explains one, with security-flavoured examples.
- The side panel shows the mission, the single objective, hints and your score.
- **Tab** completes commands, flags and paths. **Up/Down** recall history. Ctrl+A/E/U/K/W/L/C work as in bash.
- Some levels are solved by changing the machine (fix a permission, kill a process). Others ask a question: answer with `submit <answer>`.
- Game commands: `hint`, `mission`, `levels`, `reset`, `next`, `submit`.
- After each level a **concept card** explains the attack, how defenders detect it, the real-world mitigation, and the commands used.

**Scoring.** 100 points per level. Hints cost 10, 20 and 30 points (nudge, approach, exact commands). Finishing within
`ideal solution length + 2` commands earns a +10 efficiency bonus. Levels unlock in order; completed levels can be
replayed from the Levels menu and a replay never lowers your best score. Progress is stored in `localStorage`
under `shellshock:v1`.

## Levels

| # | Level | Concept | Core commands |
|---|---|---|---|
| 1 | The Leaked .env | secrets exposed in a web root | `find`, `ls -la`, `grep -r`, `cat` |
| 2 | Knocking at the Door | SSH brute force in `auth.log` | `grep`, `grep -c`, `wc -l` |
| 3 | Who Is Knocking Loudest? | top attacker by frequency | `grep -o`, `cut`, `sort`, `uniq -c`, `head` |
| 4 | Too Many Eyes on the Key | over-permissive private key | `ls -l`, `chmod` (octal and symbolic) |
| 5 | An Unexpected Open Door | rogue listening process | `ss -tlnp`, `ps`, `/proc`, `sudo kill` |
| 6 | Trust, but Verify | file integrity baseline | `sha256sum -c`, `sort`, `uniq -u` |
| 7 | It Keeps Coming Back | cron persistence | `grep -r`, `ls -lt`, `find -mtime`, `sudo rm`/`mv` |
| 8 | Hidden in Plain Sight | base64-obfuscated config | `cut`, `base64 -d`, `echo` |

Every level has exactly one objective and at least two tested solution paths.

## Architecture

```
keystrokes -> LineEditor -> Shell.run(line)
                              tokenizer -> parser (AST) -> expander ($VAR, ~, globs) -> executor (pipes, redirects)
                              -> command registry -> GameState { vfs, procs, users, env, cwd, submitted }
Game (level engine): after every command runs failCheck, then goalCheck; tracks hints, commands, score
App (xterm.js): terminal rendering, mission panel, concept cards, level select; ProgressStore (localStorage)
```

Everything except `src/ui/app.ts` and `src/main.ts` is DOM-free TypeScript and is unit tested in Node.

```
src/
  vfs/        vfs.ts (tree, permissions, sticky bit), perms.ts (mode strings, chmod parsing)
  sim/        processes.ts (process table, signals, generated /proc), users.ts
  crypto/     sha256.ts, base64.ts (synchronous, dependency-free)
  shell/      tokenizer.ts, parser.ts, expand.ts, glob.ts, shell.ts (executor), state.ts
    commands/ ls, fileops (cd pwd cat head tail rm cp mv mkdir touch), grep, text (sort uniq wc cut echo),
              find, perms (chmod chown), proc (ps kill ss), crypto (sha256sum base64), misc, game
  levels/     types.ts (schema), engine.ts, builders.ts (base machine), authlog.ts (log generator), 01..08-*.ts
  progress/   store.ts
  ui/         lineEditor.ts, completion.ts, app.ts, styles.css
tests/        vfs, syntax, shell, commands, golden, levels, ui
docs/PLAN.md  the original plan, assumptions and extension ideas
```

### Tests

- **Golden tests** (`tests/golden.test.ts`): 234 command lines are run both through the simulator and through the
  real GNU tools on the machine (`LC_ALL=C`), comparing stdout, stderr and exit status. They are skipped automatically
  where GNU coreutils are not installed (for example macOS).
- **Level tests** (`tests/levels.test.ts`): every level's ideal solution and every alternative solution is run through
  the real interpreter and must satisfy `goalCheck`; every listed wrong solution must not; the tier-3 hint must quote
  commands that work.
- Unit tests for the filesystem, permission model, tokenizer, parser, expansion, each command, line editor, tab
  completion and the progress store.

### Adding a level

Create `src/levels/NN-name.ts` exporting a `Level` (see `types.ts`) and add it to `src/levels/index.ts`.
A level is data: `story`, `objective`, `initialFS`, `initialProcesses`, `goalCheck(state)`, optional `failCheck(state)`,
three `hints`, a `conceptCard`, an `idealSolution`, at least one entry in `altSolutions`, and `wrongSolutions`.
The test suite then checks it automatically.

## Supported shell subset

**Commands:** `ls cd pwd cat head tail grep find chmod chown ps kill ss sort uniq wc cut sha256sum base64 echo`
plus `rm cp mv mkdir touch whoami id hostname date history clear true false sudo`.
Run `help <cmd>` for the exact flags each one supports.

**Syntax:** pipes `|`; redirects `>`, `>>`, `<`, `2>`, `2>>`, `2>&1`, `/dev/null`; lists `;`, `&&`, `||`;
single and double quotes, backslash escapes; `$VAR`, `${VAR}`, `$?`; `~`; globs `*`, `?`, `[...]`; `#` comments;
`sudo` and `sudo -u USER` for a single command.

## Unsupported shell features and known differences

**Syntax that is not supported:**

- command substitution `$(...)` and backticks; subshells `( ... )`; process substitution `<(...)`
- here-documents `<<`; background jobs `&`; job control (`fg`, `bg`, `jobs`, Ctrl+Z)
- variable assignment and `export`; arithmetic `$(( ))`; brace expansion `{a,b}`; `~user`
- loops, `if`, `case`, functions, aliases, history expansion (`!!`, `!$`)
- redirect forms `&>`, `>&2`, `1>`, and file descriptors other than 1 and 2
- running programs or scripts from disk (`./script.sh`)

**Commands that do not exist here:** `awk`, `sed`, `xargs`, `tr`, `tee`, `diff`, `less`/`more`, editors, `stat`,
`file`, `strings`, `which`, `env`, `netstat`, `lsof`, `pgrep`/`pkill`/`killall`, `top`, `systemctl`, `journalctl`,
`crontab`, `ssh`, `curl`, `wget`. Options outside each command's `help` list are rejected the way GNU does
(`invalid option -- 'x'`).

**Behaviour that differs from a real GNU/Linux system:**

- Ordering is byte order (`LC_ALL=C`) in `ls`, `sort` and globs: uppercase sorts before lowercase.
- `find` and `grep -r` visit entries in sorted order; the real tools use on-disk order.
- Reading from the terminal is not simulated: `cat`, `grep pattern`, `sort` and friends with no file and no pipe see empty input instead of waiting.
- In the game UI, output that does not end in a newline (for example `base64 -d`) gets one added so the prompt starts on its own line.
- Files hold text. `base64 -d` decodes to UTF-8 text; binary data is not preserved. `head -c`/`tail -c` count characters.
- No symlinks or hard links. SUID/SGID bits are displayed and searchable (`find -perm -4000`) but have no effect. The sticky bit is enforced for deletion.
- The process table is static: nothing forks, respawns or uses CPU. Every signal except 0, STOP, CONT, TSTP and CHLD terminates the target; PID 1 and your own shell are protected.
- `/proc/<pid>/cmdline` is space-separated with a trailing newline (the real file is NUL-separated). Only `cmdline`, `comm` and `status` exist.
- `ps` supports `ps`, `ps aux`, `ps -ef`, `ps -e`, `ps -u USER`, `ps -p PID`; no `-o` formats or trees. Lines are not truncated to the terminal width.
- `ss` shows listening sockets only, and its column spacing differs slightly. As on Linux, `-p` reveals other users' processes only to root.
- `grep` uses the JavaScript regex engine behind a BRE/ERE translation layer: alternation is leftmost-first rather than POSIX leftmost-longest, which can change what `-o` prints for overlapping alternatives. No `-z`, `--include`/`--exclude`, or colour output.
- `sort` has no `-o`, `-c`, `-M`, `-V`; character offsets in keys (`-k2.3`) are ignored. `cut` has no `--complement` or `--output-delimiter`. `ls` column layout is approximate and there is no `-i`/`-F`. `tail -f` is not supported.
- `sudo` never asks for a password. As on a real system it does not apply to redirections: `sudo echo x > /etc/file` fails.
- The clock is frozen per level, so `date` and `ls -l` output are reproducible.

## Suggested next levels

1. **SUID audit.** `find / -perm -4000 -type f` lists set-uid binaries; one of them (a copy of a shell in `/usr/local/bin`) is not on the distribution's list. Concept: privilege escalation through SUID files; detection by baseline comparison.
2. **The extra key.** `~/.ssh/authorized_keys` of a service account contains a key nobody recognises. Remove only that line (`grep -v ... > tmp && mv`). Concept: SSH key persistence; compare against a known-keys list.
3. **A second root.** `/etc/passwd` has an innocently named account with UID 0. Find it with `cut -d: -f1,3 /etc/passwd | grep ':0$'`. Concept: backdoor accounts; why UID, not name, is what the kernel checks.
4. **Web shell hunt.** A PHP file was dropped into a world-writable uploads directory. Combine `find -mtime`, `find -perm /o+w` and `grep -rl` for suspicious function names to locate it, then quarantine it. Concept: web shells and upload-directory hardening.
5. **The missing hour.** `auth.log` has a gap: an intruder deleted the lines covering their session. Use `cut`, `uniq -c` on the hour field and `find -newer` on the log files to identify the window. Concept: log tampering, and why logs should be shipped off-host.

More extension ideas (pipe visualiser, mistake-aware hints, randomised level data, levels as JSON) are in
[docs/PLAN.md](docs/PLAN.md).
