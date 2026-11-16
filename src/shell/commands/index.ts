import type { Command } from './types';
import { ls } from './ls';
import { fileops } from './fileops';
import { grep } from './grep';
import { text } from './text';
import { find } from './find';
import { perms } from './perms';
import { proc } from './proc';
import { crypto } from './crypto';
import { misc } from './misc';
import { game, formatHelp, GAME_COMMANDS } from './game';

export const registry: Record<string, Command> = {
  ls, ...fileops, grep, ...text, find, ...perms, ...proc, ...crypto, ...misc, ...game,
};
export { formatHelp, GAME_COMMANDS };
