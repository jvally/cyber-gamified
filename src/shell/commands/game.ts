// Game-layer commands. They are not Unix tools; they talk to the level engine.
import { Command, Ctx, Help } from './types';

export const GAME_COMMANDS = ['submit', 'help', 'man', 'hint', 'mission', 'levels', 'reset', 'next'];

export function formatHelp(name: string, h: Help): string {
  let out = `\x1b[1m${name}\x1b[0m - ${h.summary}\n\n\x1b[1mUsage:\x1b[0m ${h.usage}\n`;
  if (h.options?.length) {
    const w = Math.min(28, Math.max(...h.options.map((o) => o[0].length)));
    out += '\n\x1b[1mOptions:\x1b[0m\n' + h.options.map(([f, d]) => `  ${f.padEnd(w)}  ${d}\n`).join('');
  }
  if (h.notes) out += `\n\x1b[1mNotes:\x1b[0m ${h.notes}\n`;
  if (h.examples?.length) {
    out += '\n\x1b[1mExamples:\x1b[0m\n' + h.examples.map(([c, d]) => `  \x1b[36m${c}\x1b[0m\n      ${d}\n`).join('');
  }
  return out;
}

function helpCmd(ctx: Ctx): number {
  const cmds = ctx.shell.commands;
  const topic = ctx.args[0];
  if (topic) {
    if (!Object.hasOwn(cmds, topic)) {
      ctx.err(ctx.name === 'man' ? `No manual entry for ${topic}\n` : `bash: help: no help topics match \`${topic}'. Type 'help' for the list.\n`);
      return ctx.name === 'man' ? 16 : 1;
    }
    ctx.out(formatHelp(topic, cmds[topic].help));
    return 0;
  }
  if (ctx.name === 'man') { ctx.err("What manual page do you want?\nFor example, try 'man grep'.\n"); return 1; }
  const names = Object.keys(cmds).filter((n) => !GAME_COMMANDS.includes(n)).sort();
  ctx.out('\x1b[1mShell commands\x1b[0m (type \x1b[36mhelp <command>\x1b[0m for details)\n');
  for (const n of names) ctx.out(`  ${n.padEnd(10)} ${cmds[n].help.summary}\n`);
  ctx.out('\n\x1b[1mGame commands\x1b[0m\n');
  for (const n of GAME_COMMANDS) ctx.out(`  ${n.padEnd(10)} ${cmds[n].help.summary}\n`);
  ctx.out('\n\x1b[1mShell syntax\x1b[0m\n  a | b      pipe stdout of a into b\n  > >> <     redirect stdout (truncate / append) and stdin\n  2> 2>&1    redirect stderr\n  ; && ||    sequence / run if previous succeeded / failed\n  \'..\' ".."  quoting; $VAR, ~ and * ? [..] globs expand\n  sudo CMD   run one command as root\n');
  return 0;
}

const hook = (name: 'hint' | 'mission' | 'levels' | 'reset' | 'next', summary: string): Command => ({
  run(ctx) {
    const fn = ctx.state.game?.[name];
    if (!fn) { ctx.err(`${name}: only available inside the game\n`); return 1; }
    ctx.out(fn());
    return 0;
  },
  help: { summary, usage: name },
});

export const game: Record<string, Command> = {
  submit: {
    run(ctx) {
      const answer = ctx.args.join(' ').trim();
      if (!answer) { ctx.err('usage: submit <answer>\n'); return 1; }
      ctx.state.submitted.push(answer);
      ctx.out(`Answer submitted: ${answer}\n`);
      return 0;
    },
    help: { summary: 'submit your answer for levels that ask a question', usage: 'submit <answer>', examples: [['submit 203.0.113.7', 'answer an "which IP?" objective']] },
  },
  help: { run: helpCmd, help: { summary: 'list commands, or explain one', usage: 'help [COMMAND]' } },
  man: { run: helpCmd, help: { summary: 'same as help <command>', usage: 'man COMMAND' } },
  hint: hook('hint', 'reveal the next hint (costs points)'),
  mission: hook('mission', 'show the current mission briefing again'),
  levels: hook('levels', 'list levels and your progress'),
  reset: hook('reset', 'restart the current level from its initial state'),
  next: hook('next', 'go to the next level (once this one is complete)'),
};
