import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
if (!existsSync('.env')) {
  writeFileSync('.env', `LOGIN_TOKEN=${randomBytes(24).toString('base64url')}\nAGENT_BRIDGE_TOKEN=${randomBytes(32).toString('base64url')}\nAGENT_BRIDGE_URL=http://127.0.0.1:4311\n`, { mode: 0o600 });
  console.log('Created .env with private login/bridge tokens. Tokens are not printed.');
} else console.log('Existing .env preserved.');
mkdirSync('ops', { recursive: true });
mkdirSync('data', { recursive: true });
