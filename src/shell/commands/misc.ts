import { Command } from './types';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const whoami: Command = {
  run(ctx) { ctx.out(ctx.cred.user + '\n'); return 0; },
  help: { summary: 'print the effective user name', usage: 'whoami', examples: [['sudo whoami', 'prints root: sudo changes who you are for one command']] },
};

const id: Command = {
  run(ctx) {
    const { users } = ctx.state;
    const name = ctx.args[0] ?? ctx.cred.user;
    const u = users.get(name);
    if (!u) { ctx.err(`id: '${name}': no such user\n`); return 1; }
    const groups = u.groups.map((g) => `${users.groups.get(g)}(${g})`).join(',');
    ctx.out(`uid=${u.uid}(${u.name}) gid=${u.gid}(${u.name}) groups=${groups}\n`);
    return 0;
  },
  help: { summary: 'print user and group IDs', usage: 'id [USER]', notes: 'Membership of the sudo group is what lets a user run commands as root.' },
};

const hostname: Command = {
  run(ctx) { ctx.out(ctx.state.hostname + '\n'); return 0; },
  help: { summary: 'show the system host name', usage: 'hostname' },
};

const date: Command = {
  run(ctx) {
    const d = new Date(ctx.state.vfs.now * 1000);
    const p = (n: number): string => String(n).padStart(2, '0');
    ctx.out(`${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC ${d.getUTCFullYear()}\n`);
    return 0;
  },
  help: { summary: 'print the (simulated, frozen) system date and time', usage: 'date', notes: 'Each level has a fixed clock so output is reproducible.' },
};

const clear: Command = {
  run(ctx) { if (ctx.tty) ctx.out('\x1b[H\x1b[2J\x1b[3J'); return 0; },
  help: { summary: 'clear the terminal screen', usage: 'clear', notes: 'Ctrl+L does the same.' },
};

const history: Command = {
  run(ctx) {
    ctx.state.history.forEach((h, i) => ctx.out(`${String(i + 1).padStart(5)}  ${h}\n`));
    return 0;
  },
  help: { summary: 'show the commands you have run in this level', usage: 'history', notes: 'On real systems, ~/.bash_history is valuable forensic evidence.' },
};

const true_: Command = { run: () => 0, help: { summary: 'do nothing, successfully', usage: 'true' } };
const false_: Command = { run: () => 1, help: { summary: 'do nothing, unsuccessfully', usage: 'false' } };

export const misc = { whoami, id, hostname, date, clear, history, true: true_, false: false_ };
