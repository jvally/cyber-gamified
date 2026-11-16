import type { Level, LevelMeta } from './types';
import { AD_LEVELS } from '../ad/levels';
import { leakedEnv } from './01-leaked-env';
import { failedLogins } from './02-failed-logins';
import { topAttacker } from './03-top-attacker';
import { privateKey } from './04-private-key';
import { rogueListener } from './05-rogue-listener';
import { integrity } from './06-integrity';
import { cronPersistence } from './07-cron-persistence';
import { base64Config } from './08-base64-config';

export const LEVELS: Level[] = [
  leakedEnv, failedLogins, topAttacker, privateKey, rogueListener, integrity, cronPersistence, base64Config,
];

export interface Module { id: 'linux' | 'ad'; name: string; place: string; blurb: string; levels: LevelMeta[] }
/** The two wings of the facility. Tasks inside a module unlock in order. */
export const MODULES: Module[] = [
  { id: 'linux', name: 'Linux', place: 'Server Room', blurb: 'Investigate a compromised web server from its shell.', levels: LEVELS },
  { id: 'ad', name: 'Active Directory', place: 'IT Office', blurb: 'Harden the corp.example domain from a PowerShell console.', levels: AD_LEVELS },
];
export const ALL_LEVELS: LevelMeta[] = MODULES.flatMap((m) => m.levels);
export { AD_LEVELS };
