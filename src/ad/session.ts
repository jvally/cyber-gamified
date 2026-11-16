// Active Directory module session: a simulated domain plus a PowerShell-like console.
import { Session, RunOptions } from '../levels/session';
import type { Completion } from '../levels/types';
import type { GameHooks } from '../shell/state';
import { baseDirectory, Directory } from './directory';
import { CMDLETS, resolveCmdlet } from './cmdlets';
import { bind, formatDefault, Item, parse, PsError } from './powershell';
import type { AdLevel, AdState } from './types';

export class AdShell {
  constructor(public state: AdState, private hooks: GameHooks = {}) {}

  run(line: string, opts: RunOptions = {}): { output: string; code: number } {
    if (line.trim() === '') return { output: '', code: 0 };
    this.state.history.push(line.trim());
    const red = (s: string): string => (opts.tty ? `\x1b[31m${s}\x1b[0m` : s);
    let output = '', code = 0;
    let statements;
    try { statements = parse(line); } catch (e) {
      if (!(e instanceof PsError)) throw e;
      return { output: red(e.message) + '\n', code: 1 };
    }
    for (const pipeline of statements) {
      let items: Item[] = [];
      let label = '';
      try {
        for (const stage of pipeline) {
          const key = resolveCmdlet(stage.name);
          label = key ?? stage.name;
          if (!key) throw new PsError(`The term '${stage.name}' is not recognized as the name of a cmdlet, function, script file, or operable program.`);
          const cmdlet = CMDLETS[key];
          const p = cmdlet.raw ? {} : bind(key, [...stage.args], cmdlet.spec);
          items = cmdlet.run({ dir: this.state.dir, state: this.state, p, args: stage.args, input: items, hooks: this.hooks, tty: !!opts.tty });
        }
        output += formatDefault(items);
      } catch (e) {
        if (!(e instanceof PsError)) throw e;
        output += red(`${label} : ${e.message}`) + '\n';
        code = 1;
      }
    }
    return { output, code };
  }
}

export class AdGame extends Session<AdLevel> {
  declare state: AdState;
  declare shell: AdShell;

  constructor(level: AdLevel, hooks: GameHooks = {}) {
    super(level, hooks);
    this.reset();
  }
  get dir(): Directory { return this.state.dir; }

  protected build(): void {
    const dir = baseDirectory(this.level.now);
    this.level.setup(dir);
    this.state = { dir, submitted: [], history: [] };
    this.shell = new AdShell(this.state, this.hooks);
  }
  protected runLine(line: string, opts: RunOptions): { output: string; code: number } { return this.shell.run(line, opts); }
  protected goalMet(): boolean { return this.level.goalCheck(this.state); }
  protected failure(): string | null { return this.level.failCheck?.(this.state) ?? null; }
  protected submissionCount(): number { return this.state.submitted.length; }

  prompt(): { text: string; length: number } {
    const p = 'PS C:\\Users\\adm.analyst> ';
    return { text: `\x1b[1;36m${p}\x1b[0m`, length: p.length };
  }

  /** Complete cmdlet names, parameter names, and directory object names. */
  complete(line: string, cursor: number): Completion {
    const none: Completion = { line, cursor, candidates: [] };
    const head = line.slice(0, cursor);
    let start = cursor;
    while (start > 0 && !/[\s|;,]/.test(head[start - 1])) start--;
    const word = head.slice(start);
    const stage = head.slice(0, start).split(/[|;]/).pop() ?? '';
    const prior = stage.trim().split(/\s+/).filter(Boolean);
    const low = word.toLowerCase();
    let options: string[];
    if (prior.length === 0 || (prior.length === 1 && /^(get-help|help|man)$/i.test(prior[0]))) {
      options = Object.keys(CMDLETS);
    } else if (word.startsWith('-')) {
      const key = resolveCmdlet(prior[0]);
      options = key ? Object.keys(CMDLETS[key].spec.params).map((p) => '-' + p) : [];
    } else {
      const { dir } = this.state;
      const quote = (s: string): string => (/[\s,]/.test(s) ? `'${s}'` : s);
      options = [
        ...dir.users.map((u) => u.sam), ...dir.groups.map((g) => quote(g.name)), ...dir.computers.map((c) => c.name),
        ...dir.gpos.map((g) => quote(g.name)), ...dir.ous.map((o) => `'${dir.dn(o)}'`),
      ];
    }
    const bare = low.replace(/^'/, '');
    const matches = [...new Set(options)].filter((o) => o.toLowerCase().replace(/^'/, '').startsWith(bare)).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    if (matches.length === 0) return none;
    if (matches.length > 1) {
      let prefix = matches[0];
      for (const m of matches) while (!m.toLowerCase().startsWith(prefix.toLowerCase())) prefix = prefix.slice(0, -1);
      if (prefix.replace(/^'/, '').length <= bare.length) return { ...none, candidates: matches };
      return { line: line.slice(0, start) + prefix + line.slice(cursor), cursor: start + prefix.length, candidates: matches };
    }
    const inserted = matches[0] + ' ';
    return { line: line.slice(0, start) + inserted + line.slice(cursor), cursor: start + inserted.length, candidates: [] };
  }
}
