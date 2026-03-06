// src/chains/solana/SolanaPlugin.ts
import {
  Connection, Keypair, PublicKey, VersionedTransaction,
  LAMPORTS_PER_SOL, SystemProgram
} from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import axios from 'axios';
import * as bs58 from 'bs58';
import * as nacl from 'tweetnacl';
import { ChainPlugin, TokenInfo, WalletInfo, SwapResult, NewPoolEvent } from '../ChainPlugin';
import { encrypt, decrypt } from '../../utils/crypto';
import { logger } from '../../utils/logger';

const JUPITER_API = process.env.JUPITER_API_URL || 'https://quote-api.jup.ag/v6';
const DEXSCREENER = process.env.DEXSCREENER_API || 'https://api.dexscreener.com/latest';
const NATIVE_MINT = 'So11111111111111111111111111111111111111112'; // Wrapped SOL

export class SolanaPlugin implements ChainPlugin {
  chainId = 'solana';
  chainName = 'Solana';
  nativeSymbol = 'SOL';

  private connection: Connection;

  constructor() {
    this.connection = new Connection(
      process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
      { commitment: 'confirmed', wsEndpoint: process.env.SOLANA_WS_URL }
    );
  }

  // ── Wallet ────────────────────────────────────────────────────────────────

  async createWallet(): Promise<WalletInfo> {
    const keypair = Keypair.generate();
    const privateKey = bs58.encode(keypair.secretKey);
    return {
      address: keypair.publicKey.toBase58(),
      privateKeyEncrypted: encrypt(privateKey),
      chain: this.chainId,
      balances: {},
      nativeBalance: 0,
    };
  }

  async importWallet(privateKey: string): Promise<WalletInfo> {
    try {
      const secret = bs58.decode(privateKey);
      const keypair = Keypair.fromSecretKey(secret);
      return {
        address: keypair.publicKey.toBase58(),
        privateKeyEncrypted: encrypt(privateKey),
        chain: this.chainId,
        balances: {},
        nativeBalance: 0,
      };
    } catch {
      throw new Error('Invalid Solana private key');
    }
  }

  async getBalance(address: string): Promise<{ native: number; tokens: Record<string, number> }> {
    const pubkey = new PublicKey(address);
    const lamports = await this.connection.getBalance(pubkey);
    const native = lamports / LAMPORTS_PER_SOL;

    // Fetch token accounts
    const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(pubkey, {
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    });

    const tokens: Record<string, number> = {};
    for (const { account } of tokenAccounts.value) {
      const parsed = account.data.parsed.info;
      const mint: string = parsed.mint;
      const amount = parseFloat(parsed.tokenAmount.uiAmountString);
      if (amount > 0) tokens[mint] = amount;
    }

    return { native, tokens };
  }

  // ── Trading ───────────────────────────────────────────────────────────────

  async buy(params: {
    wallet: WalletInfo;
    tokenAddress: string;
    amountNative: number;
    slippageBps: number;
    priorityFee?: number;
  }): Promise<SwapResult> {
    const { wallet, tokenAddress, amountNative, slippageBps, priorityFee } = params;
    const amountLamports = Math.floor(amountNative * LAMPORTS_PER_SOL);

    // 1. Get Jupiter quote
    const quoteRes = await axios.get(`${JUPITER_API}/quote`, {
      params: {
        inputMint: NATIVE_MINT,
        outputMint: tokenAddress,
        amount: amountLamports,
        slippageBps,
      }
    });
    const quote = quoteRes.data;

    // 2. Get swap transaction
    const swapRes = await axios.post(`${JUPITER_API}/swap`, {
      quoteResponse: quote,
      userPublicKey: wallet.address,
      prioritizationFeeLamports: priorityFee || 50000,
    });

    // 3. Sign and send
    const privateKey = decrypt(wallet.privateKeyEncrypted);
    const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    const txBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);

    const txHash = await this.connection.sendTransaction(tx, { maxRetries: 3 });
    await this.connection.confirmTransaction(txHash, 'confirmed');

    const amountOut = parseInt(quote.outAmount) / Math.pow(10, quote.outputDecimals || 6);
    const priceImpact = parseFloat(quote.priceImpactPct || '0') * 100;

    logger.info(`[Solana] BUY ${amountNative} SOL → ${amountOut} token | tx: ${txHash}`);

    return {
      txHash,
      amountIn: amountNative,
      amountOut,
      tokenIn: NATIVE_MINT,
      tokenOut: tokenAddress,
      fee: (priorityFee || 50000) / LAMPORTS_PER_SOL,
      priceImpact,
    };
  }

  async sell(params: {
    wallet: WalletInfo;
    tokenAddress: string;
    amountPercent: number;
    slippageBps: number;
    priorityFee?: number;
  }): Promise<SwapResult> {
    const { wallet, tokenAddress, amountPercent, slippageBps, priorityFee } = params;

    // Get token balance
    const { tokens } = await this.getBalance(wallet.address);
    const tokenBalance = tokens[tokenAddress] || 0;
    if (tokenBalance === 0) throw new Error('No token balance to sell');

    // Get token decimals
    const info = await this.getTokenInfo(tokenAddress);
    const amountTokens = tokenBalance * (amountPercent / 100);
    const amountRaw = Math.floor(amountTokens * Math.pow(10, info.decimals));

    // Jupiter quote (token → SOL)
    const quoteRes = await axios.get(`${JUPITER_API}/quote`, {
      params: {
        inputMint: tokenAddress,
        outputMint: NATIVE_MINT,
        amount: amountRaw,
        slippageBps,
      }
    });
    const quote = quoteRes.data;

    const swapRes = await axios.post(`${JUPITER_API}/swap`, {
      quoteResponse: quote,
      userPublicKey: wallet.address,
      prioritizationFeeLamports: priorityFee || 50000,
    });

    const privateKey = decrypt(wallet.privateKeyEncrypted);
    const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    const txBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);

    const txHash = await this.connection.sendTransaction(tx, { maxRetries: 3 });
    await this.connection.confirmTransaction(txHash, 'confirmed');

    const amountOut = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;
    logger.info(`[Solana] SELL ${amountPercent}% of ${info.symbol} → ${amountOut} SOL | tx: ${txHash}`);

    return {
      txHash,
      amountIn: amountTokens,
      amountOut,
      tokenIn: tokenAddress,
      tokenOut: NATIVE_MINT,
      fee: (priorityFee || 50000) / LAMPORTS_PER_SOL,
      priceImpact: parseFloat(quote.priceImpactPct || '0') * 100,
    };
  }

  // ── Token Info ─────────────────────────────────────────────────────────────

  async getTokenInfo(address: string): Promise<TokenInfo> {
    try {
      const res = await axios.get(`${DEXSCREENER}/dex/tokens/${address}`);
      const pairs = res.data?.pairs;
      if (!pairs || pairs.length === 0) throw new Error('Token not found on DexScreener');

      // Pick highest-liquidity pair
      const pair = pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

      return {
        address,
        symbol: pair.baseToken.symbol,
        name: pair.baseToken.name,
        decimals: 6, // Default for SPL; override if known
        price_usd: parseFloat(pair.priceUsd || '0'),
        market_cap_usd: pair.fdv || 0,
        liquidity_usd: pair.liquidity?.usd || 0,
        volume_24h: pair.volume?.h24 || 0,
        price_change_24h: pair.priceChange?.h24 || 0,
        chain: this.chainId,
      };
    } catch (err) {
      throw new Error(`Failed to fetch token info for ${address}: ${err}`);
    }
  }

  async getTokenPrice(address: string): Promise<number> {
    const info = await this.getTokenInfo(address);
    return info.price_usd;
  }

  // ── Sniper ─────────────────────────────────────────────────────────────────

  async subscribeNewPools(callback: (event: NewPoolEvent) => void): Promise<() => void> {
    const WebSocket = require('ws');
    const ws = new WebSocket(process.env.PUMPFUN_WS_URL || 'wss://pumpportal.fun/api/data');

    ws.on('open', () => {
      // Subscribe to new token creation events on Pump.fun
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      logger.info('[Solana Sniper] Subscribed to Pump.fun new token stream');
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.mint) {
          const event: NewPoolEvent = {
            chain: this.chainId,
            poolAddress: msg.bondingCurveKey || msg.mint,
            tokenAddress: msg.mint,
            tokenSymbol: msg.symbol || '???',
            tokenName: msg.name || 'Unknown',
            createdAt: new Date(),
            initialLiquidityUsd: msg.marketCapSol ? msg.marketCapSol * 150 : 0,
            deployer: msg.traderPublicKey || '',
          };
          callback(event);
        }
      } catch { /* ignore parse errors */ }
    });

    ws.on('error', (err: Error) => logger.error('[Solana Sniper] WS error:', err.message));
    ws.on('close', () => logger.warn('[Solana Sniper] WS closed'));

    // Return unsubscribe function
    return () => ws.close();
  }

  // ── Copy Trading ───────────────────────────────────────────────────────────

  async watchWallet(
    targetAddress: string,
    callback: (tx: { type: 'buy' | 'sell'; tokenAddress: string; amountNative: number; tokenSymbol: string }) => void
  ): Promise<() => void> {
    const pubkey = new PublicKey(targetAddress);

    const subId = this.connection.onLogs(pubkey, async (logs) => {
      try {
        const tx = await this.connection.getParsedTransaction(logs.signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (!tx) return;

        // Detect swap direction by looking at SOL balance change
        const preBalances = tx.meta?.preBalances || [];
        const postBalances = tx.meta?.postBalances || [];
        const solDelta = (postBalances[0] - preBalances[0]) / LAMPORTS_PER_SOL;
        const type: 'buy' | 'sell' = solDelta < 0 ? 'buy' : 'sell';

        // Find token involved (simplistic: first post token balance)
        const postTokenBalances = tx.meta?.postTokenBalances || [];
        if (postTokenBalances.length === 0) return;

        const tokenMint = postTokenBalances[0].mint;
        const info = await this.getTokenInfo(tokenMint).catch(() => null);

        callback({
          type,
          tokenAddress: tokenMint,
          amountNative: Math.abs(solDelta),
          tokenSymbol: info?.symbol || 'UNKNOWN',
        });
      } catch { /* ignore */ }
    }, 'confirmed');

    return () => this.connection.removeOnLogsListener(subId);
  }

  // ── Trends ─────────────────────────────────────────────────────────────────

  async getTrendingTokens(limit = 10): Promise<TokenInfo[]> {
    const res = await axios.get(`${DEXSCREENER}/dex/search?q=solana&orderBy=volume`);
    const pairs = res.data?.pairs || [];

    return pairs
      .filter((p: any) => p.chainId === 'solana' && p.liquidity?.usd > 10000)
      .slice(0, limit)
      .map((p: any): TokenInfo => ({
        address: p.baseToken.address,
        symbol: p.baseToken.symbol,
        name: p.baseToken.name,
        decimals: 6,
        price_usd: parseFloat(p.priceUsd || '0'),
        market_cap_usd: p.fdv || 0,
        liquidity_usd: p.liquidity?.usd || 0,
        volume_24h: p.volume?.h24 || 0,
        price_change_24h: p.priceChange?.h24 || 0,
        chain: 'solana',
      }));
  }
}
