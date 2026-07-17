import { readFileSync } from 'node:fs';
const m = readFileSync('.env', 'utf8').match(/^DISCORD_PUBLIC_WEBHOOK_URL=(.+)$/m);
if (!m) { console.log('no webhook line in .env'); process.exit(1); }
const url = m[1].trim();
console.log('webhook chars:', url.length);
const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: readFileSync('box-message.txt', 'utf8') }),
});
console.log('discord says:', res.status);
