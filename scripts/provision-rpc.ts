#!/usr/bin/env ts-node
// scripts/provision-rpc.ts
// ─────────────────────────────────────────────────────────────────────────────
// Automatically provisions a Solana RPC endpoint via API.
// Tries providers in order: Helius (free tier) → QuickNode → public fallback.
// Writes the endpoint to your .env file automatically.
//
// Usage:
//   npx ts-node scripts/provision-rpc.ts
//   npx ts-node scripts/provision-rpc.ts --provider helius --api-key YOUR_KEY
//   npx ts-node scripts/provision-rpc.ts --provider quicknode --api-key YOUR_KEY --plan free
// ─────────────────────────────────────────────────────────────────────────────

import axios, { AxiosError } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : undefined;
};

const PROVIDER = getArg('provider') || 'auto';    // helius | quicknode | triton | auto
const API_KEY  = getArg('api-key');
const PLAN     = getArg('plan') || 'free';
const ENV_FILE = getArg('env') || path.resolve(process.cwd(), '.env');

// ── Colours ───────────────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m',  green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m',   cyan: '\x1b[36m',  bold: '\x1b[1m',
  dim: '\x1b[2m',
};
const log  = (msg: string) => console.log(`${c.cyan}[RPC]${c.reset} ${msg}`);
const ok   = (msg: string) => console.log(`${c.green}✔${c.reset}  ${msg}`);
const warn = (msg: string) => console.log(`${c.yellow}⚠${c.reset}  ${msg}`);
const err  = (msg: string) => console.log(`${c.red}✘${c.reset}  ${msg}`);
const head = (msg: string) => console.log(`\n${c.bold}${c.cyan}${msg}${c.reset}\n`);

// ── .env helper ───────────────────────────────────────────────────────────────
function updateEnv(key: string, value: string, envPath: string): void {
  let content = '';
  if (fs.existsSync(envPath)) content = fs.readFileSync(envPath, 'utf8');

  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content += `\n${key}=${value}`;
  }
  fs.writeFileSync(envPath, content.trim() + '\n');
}

// ── Latency test ──────────────────────────────────────────────────────────────
async function testLatency(rpcUrl: string): Promise<number | null> {
  try {
    const start = Date.now();
    await axios.post(rpcUrl, {
      jsonrpc: '2.0', id: 1,
      method: 'getSlot', params: [{ commitment: 'processed' }],
    }, { timeout: 5000 });
    return Date.now() - start;
  } catch {
    return null;
  }
}

async function testRpc(rpcUrl: string, label: string): Promise<boolean> {
  log(`Testing ${label}...`);
  const latency = await testLatency(rpcUrl);
  if (latency === null) {
    err(`${label} — unreachable`);
    return false;
  }
  const color = latency < 300 ? c.green : latency < 800 ? c.yellow : c.red;
  ok(`${label} — ${color}${latency}ms${c.reset}`);
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// PROVIDER IMPLEMENTATIONS
// ══════════════════════════════════════════════════════════════════════════════

// ── 1. Helius ─────────────────────────────────────────────────────────────────
// Free tier: 100k credits/day, no CC required
// Signup API: https://docs.helius.dev/
async function provisionHelius(apiKey?: string): Promise<string | null> {
  head('🔵 Helius RPC');

  if (!apiKey) {
    log('No Helius API key provided.');
    log('Get a FREE key at: https://dev.helius.xyz/dashboard/app');
    log('Then rerun: npx ts-node scripts/provision-rpc.ts --provider helius --api-key YOUR_KEY');
    return null;
  }

  // Verify the key works by calling the Helius API
  try {
    log('Verifying Helius API key...');
    const res = await axios.get(`https://api.helius.xyz/v0/addresses/So11111111111111111111111111111111111111112/balances?api-key=${apiKey}`, {
      timeout: 8000,
    });

    if (res.status === 200) {
      const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
      const wsUrl  = `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`;

      ok(`Helius key verified!`);
      const latency = await testLatency(rpcUrl);
      ok(`RPC latency: ${latency}ms`);

      return JSON.stringify({ rpcUrl, wsUrl, provider: 'helius', tier: 'free' });
    }
  } catch (e: any) {
    if (e?.response?.status === 401) {
      err('Invalid Helius API key');
    } else {
      err(`Helius verification failed: ${e?.message}`);
    }
  }
  return null;
}

// ── 2. QuickNode ──────────────────────────────────────────────────────────────
// Free tier: 10M credits/month
// Requires API key from: https://www.quicknode.com/
async function provisionQuickNode(apiKey?: string): Promise<string | null> {
  head('🟣 QuickNode RPC');

  if (!apiKey) {
    log('No QuickNode API key provided.');
    log('Get a FREE endpoint at: https://www.quicknode.com/');
    log('Then rerun: npx ts-node scripts/provision-rpc.ts --provider quicknode --api-key YOUR_ENDPOINT_URL');
    return null;
  }

  // QuickNode keys ARE the endpoint URL themselves
  // e.g. https://example-endpoint.quiknode.pro/abc123/
  const rpcUrl = apiKey.startsWith('http') ? apiKey : `https://${apiKey}.quiknode.pro/`;
  const wsUrl  = rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');

  try {
    log('Verifying QuickNode endpoint...');
    const reachable = await testRpc(rpcUrl, 'QuickNode');
    if (!reachable) return null;

    ok('QuickNode endpoint verified!');
    return JSON.stringify({ rpcUrl, wsUrl, provider: 'quicknode', tier: PLAN });
  } catch (e: any) {
    err(`QuickNode verification failed: ${e?.message}`);
    return null;
  }
}

// ── 3. Triton One ─────────────────────────────────────────────────────────────
// High-performance dedicated RPC. Requires account.
// https://triton.one/
async function provisionTriton(apiKey?: string): Promise<string | null> {
  head('🔴 Triton One RPC');

  if (!apiKey) {
    log('Triton requires an API key from https://triton.one/');
    log('Rerun: npx ts-node scripts/provision-rpc.ts --provider triton --api-key YOUR_KEY');
    return null;
  }

  const rpcUrl = `https://rpc.triton.one/solana?apiKey=${apiKey}`;
  const wsUrl  = `wss://rpc.triton.one/solana?apiKey=${apiKey}`;

  const reachable = await testRpc(rpcUrl, 'Triton');
  if (!reachable) return null;
  return JSON.stringify({ rpcUrl, wsUrl, provider: 'triton', tier: 'paid' });
}

// ── 4. Public fallback ────────────────────────────────────────────────────────
async function provisionPublic(): Promise<string> {
  head('⚪ Public RPC (fallback)');
  warn('Public RPC is rate-limited and NOT recommended for production sniping.');
  warn('Get a private RPC for best performance.');

  const endpoints = [
    { rpc: 'https://api.mainnet-beta.solana.com', ws: 'wss://api.mainnet-beta.solana.com', name: 'Solana mainnet-beta' },
    { rpc: 'https://solana-api.projectserum.com', ws: 'wss://solana-api.projectserum.com', name: 'Project Serum' },
    { rpc: 'https://rpc.ankr.com/solana',         ws: 'wss://rpc.ankr.com/solana/ws',      name: 'Ankr public' },
  ];

  let best = endpoints[0];
  let bestLatency = Infinity;

  for (const ep of endpoints) {
    const latency = await testLatency(ep.rpc);
    if (latency !== null && latency < bestLatency) {
      bestLatency = latency;
      best = ep;
    }
  }

  ok(`Best public endpoint: ${best.name} (${bestLatency}ms)`);
  return JSON.stringify({ rpcUrl: best.rpc, wsUrl: best.ws, provider: 'public', tier: 'free' });
}

// ── 5. Interactive wizard ─────────────────────────────────────────────────────
async function runWizard(): Promise<{ provider: string; apiKey?: string }> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

  console.log(`\n${c.bold}${c.cyan}╔══════════════════════════════════════╗`);
  console.log(`║   Solana RPC Provisioner Wizard      ║`);
  console.log(`╚══════════════════════════════════════╝${c.reset}\n`);

  console.log('Choose a provider:\n');
  console.log(`  ${c.green}1.${c.reset} Helius     — Free 100k credits/day  ${c.dim}(Recommended)${c.reset}`);
  console.log(`  ${c.green}2.${c.reset} QuickNode  — Free 10M credits/month`);
  console.log(`  ${c.green}3.${c.reset} Triton One — High-performance paid`);
  console.log(`  ${c.green}4.${c.reset} Public     — Free, rate-limited fallback\n`);

  const choice = await ask('Enter 1-4: ');
  const providers: Record<string, string> = { '1': 'helius', '2': 'quicknode', '3': 'triton', '4': 'public' };
  const provider = providers[choice.trim()] || 'public';

  let apiKey: string | undefined;
  if (provider !== 'public') {
    const urls: Record<string, string> = {
      helius:    'https://dev.helius.xyz/dashboard/app',
      quicknode: 'https://www.quicknode.com/',
      triton:    'https://triton.one/',
    };
    console.log(`\n${c.yellow}→ Get your API key at: ${urls[provider]}${c.reset}\n`);
    apiKey = (await ask(`Enter your ${provider} API key (or press Enter to skip): `)).trim() || undefined;
  }

  rl.close();
  return { provider, apiKey };
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log(`\n${c.bold}${c.cyan}━━━ Solana RPC Provisioner ━━━${c.reset}`);
  log(`ENV file: ${ENV_FILE}`);

  let provider = PROVIDER;
  let apiKey   = API_KEY;

  // Interactive wizard if no args given
  if (PROVIDER === 'auto' && !API_KEY) {
    const wizard = await runWizard();
    provider = wizard.provider;
    apiKey   = wizard.apiKey;
  }

  let result: string | null = null;

  if (provider === 'helius' || provider === 'auto') {
    result = await provisionHelius(apiKey);
  }
  if (!result && (provider === 'quicknode' || provider === 'auto')) {
    result = await provisionQuickNode(apiKey);
  }
  if (!result && (provider === 'triton')) {
    result = await provisionTriton(apiKey);
  }
  if (!result) {
    result = await provisionPublic();
  }

  if (!result) {
    err('All providers failed. Check your API keys and try again.');
    process.exit(1);
  }

  const { rpcUrl, wsUrl, provider: chosenProvider, tier } = JSON.parse(result);

  // ── Write to .env ───────────────────────────────────────────────────────────
  head('📝 Writing to .env');

  updateEnv('SOLANA_RPC_URL', rpcUrl, ENV_FILE);
  updateEnv('SOLANA_WS_URL',  wsUrl,  ENV_FILE);

  ok(`SOLANA_RPC_URL = ${rpcUrl}`);
  ok(`SOLANA_WS_URL  = ${wsUrl}`);
  ok(`.env updated at ${ENV_FILE}`);

  // ── Final verification ──────────────────────────────────────────────────────
  head('🔍 Final Verification');

  log('Running 3 latency tests...');
  const latencies: number[] = [];
  for (let i = 0; i < 3; i++) {
    const ms = await testLatency(rpcUrl);
    if (ms !== null) latencies.push(ms);
    await new Promise(r => setTimeout(r, 500));
  }

  if (latencies.length === 0) {
    err('RPC is not reachable. Check your key/endpoint.');
    process.exit(1);
  }

  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const min = Math.min(...latencies);
  const verdict = avg < 200 ? `${c.green}Excellent` : avg < 500 ? `${c.yellow}Good` : `${c.red}Slow`;

  console.log(`\n  Provider : ${c.bold}${chosenProvider}${c.reset} (${tier})`);
  console.log(`  Avg      : ${c.bold}${avg.toFixed(0)}ms${c.reset}`);
  console.log(`  Min      : ${min}ms`);
  console.log(`  Rating   : ${verdict}${c.reset}`);

  // Sniper recommendation
  console.log();
  if (avg < 200) {
    ok('This RPC is fast enough for sniping! 🎯');
  } else if (avg < 500) {
    warn('Decent for trading. For sniping, consider a dedicated Helius/Triton plan.');
  } else {
    warn('High latency — not ideal for time-sensitive sniping.');
    warn('Upgrade to a private RPC: https://dev.helius.xyz/dashboard/app');
  }

  console.log(`\n${c.green}${c.bold}✅ RPC provisioned successfully!${c.reset}`);
  console.log(`${c.dim}Run your bot with: npm run dev${c.reset}\n`);
}

main().catch(e => {
  err(`Fatal: ${e?.message || e}`);
  process.exit(1);
});
