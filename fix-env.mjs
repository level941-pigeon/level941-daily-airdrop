import { readFileSync, writeFileSync } from 'node:fs';
let t = readFileSync('.env', 'utf8');
const m = t.match(/DISCORD_PUBLIC_WEBHOOK_URL=(https:\/\/discord\.com\/api\/webhooks\/\S+)/);
if (!m) { console.log('NO WEBHOOK FOUND ANYWHERE IN .env'); process.exit(1); }
const url = m[1];
t = t.replace(/DISCORD_PUBLIC_WEBHOOK_URL=https:\/\/discord\.com\/api\/webhooks\/\S*/g, '');
t = t.split('\n').map((l) => l.trimEnd()).join('\n');
if (!t.endsWith('\n')) t += '\n';
writeFileSync('.env', t + `DISCORD_PUBLIC_WEBHOOK_URL=${url}\n`);
console.log('repaired. webhook on its own line. chars:', url.length);
