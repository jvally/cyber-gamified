import type { Level } from './types';
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
