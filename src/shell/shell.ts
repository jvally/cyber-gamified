// Executor: runs a parsed command list against the simulated machine.
import { FsError, normalize } from '../vfs/vfs';
import type { Cred } from '../vfs/vfs';
import { syncProcfs } from '../sim/processes';
import { expandWord } from './expand';
import { CommandList, parse, Pipeline, SimpleCommand } from './parser';
import { ShellSyntaxError } from './tokenizer';
import type { GameState } from './state';
import type { Command, Ctx } from './commands/types';
import { registry, formatHelp } from './commands/index';

export interface RunResult { output: string; stdout: string; stderr: string; code: number }
export interface RunOpts { tty?: boolean; cols?: number; record?: boolean }

type Target = { kind: 'tty' } | { kind: 'pipe' } | { kind: 'null' } | { kind: 'file'; path: string; buf: string };
interface Sink { tty(fd: 1 | 2, s: string): void }

export class Shell {
  commands: Record<string, Command>;
  constructor(public state: GameState, commands: Record<string, Command> = registry) {
    this.commands = commands;
  }

  get cred(): Cred { return this.state.users.cred(this.state.user); }

  run(line: string, opts: RunOpts = {}): RunResult {
    const res: RunResult = { output: '', stdout: '', stderr: '', code: 0 };
    const sink: Sink = {
      tty: (fd, s) => { res.output += s; if (fd === 1) res.stdout += s; else res.stderr += s; },
    };
    if (line.trim() === '') return res;
    if (opts.record !== false) this.state.history.push(line.trim());
    syncProcfs(this.state.vfs, this.state.procs);
    let list: CommandList;
    try {
      list = parse(line);
    } catch (e) {
      if (!(e instanceof ShellSyntaxError)) throw e;
      sink.tty(2, `bash: ${e.message}\n`);
      this.state.lastExit = res.code = 2;
      return res;
    }
    for (const item of list) {
      if (item.op === '&&' && this.state.lastExit !== 0) continue;
      if (item.op === '||' && this.state.lastExit === 0) continue;
      this.state.lastExit = this.runPipeline(item.pipeline, sink, opts);
    }
    res.code = this.state.lastExit;
    return res;
  }

  private runPipeline(p: Pipeline, sink: Sink, opts: RunOpts): number {
    let stdin = '';
    let code = 0;
    const expanded = p.commands.map((c) => c.argv.flatMap((w) => expandWord(w, this.state)));
    const pipelineArgv = expanded.map((a) => a.join(' '));
    p.commands.forEach((cmd, i) => {
      const last = i === p.commands.length - 1;
      const r = this.runSimple(cmd, expanded[i], stdin, i > 0, last, sink, opts, pipelineArgv);
      stdin = r.piped;
      code = r.code;
    });
    return code;
  }

  private runSimple(
    cmd: SimpleCommand, argv: string[], stdin: string, piped: boolean, last: boolean,
    sink: Sink, opts: RunOpts, pipelineArgv: string[],
  ): { piped: string; code: number } {
    const { vfs } = this.state;
    const shellCred = this.cred;
    let hasStdin = piped;
    let fd1: Target = last ? { kind: 'tty' } : { kind: 'pipe' };
    let fd2: Target = { kind: 'tty' };
    const files: Extract<Target, { kind: 'file' }>[] = [];
    let pipeBuf = '';

    // Redirections are set up left to right, as the *shell* user, before the command runs.
    for (const r of cmd.redirects) {
      if (r.op === '2>&1') { fd2 = fd1; continue; }
      const words = expandWord(r.target!, this.state);
      if (words.length !== 1) {
        sink.tty(2, 'bash: ambiguous redirect\n');
        return { piped: '', code: 1 };
      }
      const path = normalize(words[0], this.state.cwd);
      try {
        if (path === '/dev/null') {
          if (r.op === '<') { stdin = ''; hasStdin = true; }
          else if (r.op === '>' || r.op === '>>') fd1 = { kind: 'null' };
          else fd2 = { kind: 'null' };
          continue;
        }
        if (r.op === '<') {
          stdin = vfs.readFile(path, shellCred);
          hasStdin = true;
          continue;
        }
        const append = r.op === '>>' || r.op === '2>>';
        vfs.writeFile(path, '', shellCred, append);
        const target: Target = { kind: 'file', path, buf: '' };
        files.push(target);
        if (r.op === '>' || r.op === '>>') fd1 = target; else fd2 = target;
      } catch (e) {
        sink.tty(2, `bash: ${words[0]}: ${(e as FsError).message}\n`);
        return { piped: '', code: 1 };
      }
    }

    const write = (fd: 1 | 2, s: string): void => {
      const t = fd === 1 ? fd1 : fd2;
      if (t.kind === 'tty') sink.tty(fd, s);
      else if (t.kind === 'pipe') pipeBuf += s;
      else if (t.kind === 'file') t.buf += s;
    };
    const code = argv.length === 0 ? 0 : this.dispatch(argv, {
      stdin, hasStdin, out: (s) => write(1, s), err: (s) => write(2, s),
      tty: fd1.kind === 'tty' && opts.tty === true, cols: opts.cols ?? 80, pipeline: pipelineArgv,
    }, shellCred);
    for (const f of files) {
      try { vfs.writeFile(f.path, f.buf, undefined, true); } catch { /* target vanished mid-command */ }
    }
    return { piped: pipeBuf, code };
  }

  /** Run one already-expanded argv. Also used by `find -exec`. */
  dispatch(
    argv: string[], io: Pick<Ctx, 'stdin' | 'hasStdin' | 'out' | 'err' | 'tty' | 'cols' | 'pipeline'>, cred: Cred,
  ): number {
    let [name, ...args] = argv;
    if (name === 'sudo') {
      let target = 'root';
      if (args[0] === '-u') {
        if (args.length < 2) { io.err('sudo: option requires an argument -- \'u\'\n'); return 1; }
        target = args[1];
        args = args.slice(2);
      }
      if (args.length === 0) { io.err('usage: sudo [-u user] command [arg ...]\n'); return 1; }
      if (!this.state.users.get(cred.user)?.groups.includes('sudo') && cred.user !== 'root') {
        io.err(`${cred.user} is not in the sudoers file.\n`);
        return 1;
      }
      if (!this.state.users.get(target)) { io.err(`sudo: unknown user ${target}\n`); return 1; }
      if (args[0] === 'cd' || !(args[0] in this.commands)) {
        io.err(`sudo: ${args[0]}: command not found\n`);
        return 1;
      }
      cred = this.state.users.cred(target);
      [name, ...args] = args;
    }
    const command = Object.hasOwn(this.commands, name) ? this.commands[name] : undefined;
    if (!command) {
      if (/^[A-Za-z_]\w*=/.test(name)) {
        io.err('bash: variable assignment is not supported in this simulator\n');
        return 1;
      }
      if (name.includes('/')) {
        const node = this.state.vfs.tryGet(normalize(name, this.state.cwd));
        if (!node) io.err(`bash: ${name}: No such file or directory\n`);
        else if (node.type === 'dir') io.err(`bash: ${name}: Is a directory\n`);
        else if (!(node.mode & 0o111)) { io.err(`bash: ${name}: Permission denied\n`); return 126; }
        else { io.err(`bash: ${name}: running programs from disk is not supported in this simulator\n`); return 126; }
        return node ? 126 : 127;
      }
      io.err(`bash: ${name}: command not found\n`);
      return 127;
    }
    if (name !== 'echo' && args.includes('--help') && !args.slice(0, args.indexOf('--help')).includes('--')) {
      io.out(formatHelp(name, command.help));
      return 0;
    }
    const ctx: Ctx = { ...io, state: this.state, shell: this, name, args, cred };
    try {
      return command.run(ctx);
    } catch (e) {
      if (e instanceof FsError) { io.err(`${name}: ${e.path}: ${e.message}\n`); return 1; }
      io.err(`bash: ${name}: internal simulator error: ${(e as Error).message}\n`);
      return 70;
    }
  }
}
