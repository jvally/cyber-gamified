import { at, baseFiles, baseProcs, DAY, dir, file, text } from './builders';
import { lastAnswer } from './engine';
import type { Level } from './types';

const NOW = at('2026-11-15T09:00:00Z');
const W = { owner: 'www-data', mtime: NOW - 30 * DAY };
// AWS's own documentation example credentials: safe to publish, never valid.
const KEY_ID = 'AKIAIOSFODNN7EXAMPLE';

export const leakedEnv: Level = {
  id: 'leaked-env',
  title: 'The Leaked .env',
  story: text(`
    Ticket SEC-1042, 08:47. An external scanner reports that the shop site on web01 answers
    HTTP 200 for a dotfile that should never be reachable from the internet. Dotfiles like
    .env hold an application's secrets: database passwords, API keys, cloud credentials.
    If one sits inside the directory the web server publishes, anyone can download it.

    The web sites live under /var/www. Find the exposed file before someone else does.
  `),
  objective: 'Find the .env file exposed under /var/www and submit the AWS access key ID it leaks (submit <key-id>).',
  now: NOW,
  initialFS: [
    ...baseFiles(NOW),
    file('/home/analyst/ticket.txt', text(`
      SEC-1042  priority: high
      Scanner finding: "sensitive dotfile served over HTTP" on shop.web01
      Action: locate the file, record which credential is exposed so it can be rotated.
    `), { owner: 'analyst', mtime: NOW - 800 }),
    dir('/var/www/shop', W), dir('/var/www/shop/public', W), dir('/var/www/shop/public/css', W),
    dir('/var/www/shop/config', W), dir('/var/www/shop/storage/logs', W), dir('/var/www/shop/storage', W),
    file('/var/www/shop/README.md', '# Shop\n\nCopy `.env.example` to `.env` (outside `public/`!) and fill in the values.\n', W),
    file('/var/www/shop/composer.json', '{\n  "name": "acme/shop",\n  "require": { "php": "^8.3" }\n}\n', W),
    file('/var/www/shop/.env.example', text(`
      APP_NAME=Shop
      APP_ENV=local
      DB_PASSWORD=change-me
      AWS_ACCESS_KEY_ID=your-key-id-here
      AWS_SECRET_ACCESS_KEY=your-secret-here
    `), W),
    file('/var/www/shop/config/app.php', "<?php\nreturn [\n  'name' => getenv('APP_NAME'),\n  'debug' => getenv('APP_DEBUG'),\n];\n", W),
    file('/var/www/shop/storage/logs/app.log', '[2026-11-14 22:10:03] production.INFO: order 5521 paid\n[2026-11-14 23:41:17] production.INFO: order 5522 paid\n', W),
    file('/var/www/shop/public/index.php', "<?php\nrequire __DIR__ . '/../vendor/autoload.php';\n$app = require __DIR__ . '/../config/app.php';\necho 'Welcome to ' . $app['name'];\n", W),
    file('/var/www/shop/public/robots.txt', 'User-agent: *\nDisallow: /admin\n', W),
    file('/var/www/shop/public/.htaccess', 'RewriteEngine On\nRewriteRule ^ index.php [L]\n', W),
    file('/var/www/shop/public/css/style.css', 'body { font-family: sans-serif; }\n', W),
    file('/var/www/shop/public/.env', text(`
      APP_NAME=Shop
      APP_ENV=production
      APP_DEBUG=true
      DB_HOST=127.0.0.1
      DB_DATABASE=shop
      DB_PASSWORD=training-placeholder-not-a-real-password
      AWS_ACCESS_KEY_ID=${KEY_ID}
      AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
      AWS_DEFAULT_REGION=eu-west-1
    `), { owner: 'www-data', mode: 0o644, mtime: NOW - 3 * DAY }),
    dir('/var/www/blog', W),
    file('/var/www/blog/index.html', '<h1>Engineering blog</h1>\n', W),
    file('/var/www/blog/.env.example', 'BLOG_TITLE=Engineering blog\nAWS_ACCESS_KEY_ID=\n', W),
  ],
  initialProcesses: baseProcs(),
  goalCheck: (s) => lastAnswer(s) === KEY_ID,
  hints: [
    'Files whose names start with a dot are hidden from a plain `ls`. You need a tool that searches a whole directory tree by name, or one that searches file contents.',
    'Either search by name with `find /var/www -name ".env"`, or by content with `grep -r AWS_ACCESS_KEY_ID /var/www`. Ignore the `.env.example` templates: they hold placeholders.',
    'Run `cat /var/www/shop/public/.env`, copy the value of AWS_ACCESS_KEY_ID, and `submit` it.',
  ],
  conceptCard: {
    attack: 'Secrets exposure. Frameworks read credentials from a .env file. If it is deployed inside the web root (or committed to git), anyone can fetch it with a single HTTP request. Attackers scan the whole internet for /.env continuously, then use the cloud keys they find to steal data or run up bills.',
    detection: 'Search for stray secret files by name (find -name ".env") and for secret-shaped strings by content (grep -r for AKIA, PASSWORD=, BEGIN PRIVATE KEY). Web access logs show the scanners: requests for /.env, /.git/config, /backup.zip. Tools such as gitleaks and trufflehog automate the content search.',
    mitigation: 'Keep secrets outside the served directory and block dotfiles in the web server config. Better: do not keep long-lived keys in files at all; use a secrets manager or short-lived role credentials. When a key leaks, rotating it is the only fix. Deleting the file does not un-leak it.',
    commands: [
      { cmd: 'find /var/www -name ".env"', explain: 'walk a directory tree and match file names; the quotes stop the shell expanding the pattern' },
      { cmd: 'ls -la /var/www/shop/public', explain: '-a reveals dotfiles, -l shows who can read them' },
      { cmd: 'grep -r AWS_ACCESS_KEY_ID /var/www', explain: 'search file contents recursively when you know what the secret looks like' },
      { cmd: 'cat /var/www/shop/public/.env', explain: 'read the file to see exactly what was exposed' },
    ],
  },
  idealSolution: ['find /var/www -name ".env"', 'cat /var/www/shop/public/.env', `submit ${KEY_ID}`],
  altSolutions: [
    ['grep -r AWS_ACCESS_KEY_ID /var/www', `submit ${KEY_ID}`],
    ['cd /var/www/shop/public', 'ls -la', 'grep AWS_ACCESS .env | cut -d= -f2', `submit ${KEY_ID}`],
  ],
  wrongSolutions: [
    ['cat /var/www/shop/.env.example', 'submit your-key-id-here'],
    ['submit wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
  ],
};
