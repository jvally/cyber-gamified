import { at, baseFiles, baseProcs, DAY, dir, file, text } from './builders';
import { lastAnswer } from './engine';
import type { Level } from './types';

const NOW = at('2026-11-15T09:00:00Z');
const W = { owner: 'www-data', mtime: NOW - 30 * DAY };
// AWS's own documentation example credentials: safe to publish, never valid.
const KEY_ID = 'AKIAIOSFODNN7EXAMPLE';

export const leakedEnv: Level = {
  id: 'leaked-env',
  module: 'linux',
  title: 'The Leaked .env',
  story: text(`
    Ticket SEC-1042: a scanner got HTTP 200 for a dotfile on the shop site.
    A .env file holds an app's secrets. Inside the web root, anyone can download it.
    Sites live under /var/www.
  `),
  objective: 'Find the exposed .env under /var/www and submit its AWS access key ID.',
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
    'Dotfiles are hidden from plain `ls`. Search the tree by name or by content.',
    '`find /var/www -name ".env"` or `grep -r AWS_ACCESS_KEY_ID /var/www`. Skip `.env.example` files: they hold placeholders.',
    '`cat /var/www/shop/public/.env`, then `submit` the AWS_ACCESS_KEY_ID value.',
  ],
  conceptCard: {
    attack: [
      'A .env file deployed inside the web root is one HTTP request away from anyone.',
      'Bots request /.env on every site they find and use leaked cloud keys within minutes.',
    ],
    detection: [
      'By name: find -name ".env" across served directories.',
      'By content: grep -r for AKIA, PASSWORD=, BEGIN PRIVATE KEY.',
      'In access logs: requests for /.env or /.git/config.',
    ],
    mitigation: [
      'Rotate the leaked key. Deleting the file does not un-leak it.',
      'Keep secrets outside the web root and deny dotfiles in the server config.',
      'Prefer a secrets manager or short-lived role credentials over key files.',
    ],
    commands: [
      { cmd: 'find /var/www -name ".env"', explain: 'match file names in a tree; quotes stop the shell expanding the pattern' },
      { cmd: 'ls -la /var/www/shop/public', explain: '-a shows dotfiles, -l shows who can read them' },
      { cmd: 'grep -r AWS_ACCESS_KEY_ID /var/www', explain: 'search file contents recursively' },
      { cmd: 'cat /var/www/shop/public/.env', explain: 'see exactly what was exposed' },
    ],
  },
  intel: 'The leaked key was used from outside overnight. Check who has been trying to log in: /var/log/auth.log.',
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
