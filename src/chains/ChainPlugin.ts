// src/chains/ChainPlugin.ts
// Every chain (Solana, ETH, BSC…) implements this interface.
// Register plugins in src/chains/registry.ts

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  price_usd: number;
  market_cap_usd?: number;
  liquidity_usd?: number;
  volume_24h?: number;
  price_change_24h?: number;
  chain: string;
}

export interface WalletInfo {
  address: string;
  privateKeyEncrypted: string; // always stored encrypted
  chain: string;
  balances: Record<string, number>; // token address → amount
  nativeBalance: number;
}

export interface SwapResult {
  txHash: string;
  amountIn: number;
  amountOut: number;
  tokenIn: string;
  tokenOut: string;
  fee: number;
  priceImpact: number;
}

export interface NewPoolEvent {
  chain: string;
  poolAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  createdAt: Date;
  initialLiquidityUsd: number;
  deployer: string;
}

export interface ChainPlugin {
  /** Unique identifier e.g. 'solana', 'ethereum', 'bsc' */
  chainId: string;
  /** Human-readable name */
  chainName: string;
  /** Native token symbol */
  nativeSymbol: string;

  // ── Wallet ─────────────────────────────────────────────────
  createWallet(): Promise<WalletInfo>;
  importWallet(privateKey: string): Promise<WalletInfo>;
  getBalance(address: string): Promise<{ native: number; tokens: Record<string, number> }>;

  // ── Trading ────────────────────────────────────────────────
  buy(params: {
    wallet: WalletInfo;
    tokenAddress: string;
    amountNative: number;
    slippageBps: number;
    priorityFee?: number;
  }): Promise<SwapResult>;

  sell(params: {
    wallet: WalletInfo;
    tokenAddress: string;
    amountPercent: number; // 0-100
    slippageBps: number;
    priorityFee?: number;
  }): Promise<SwapResult>;

  // ── Token Info ─────────────────────────────────────────────
  getTokenInfo(address: string): Promise<TokenInfo>;
  getTokenPrice(address: string): Promise<number>;

  // ── Sniper ─────────────────────────────────────────────────
  /** Subscribe to new pool/token launches. Calls callback on each new pool. */
  subscribeNewPools(callback: (event: NewPoolEvent) => void): Promise<() => void>;

  // ── Copy Trading ───────────────────────────────────────────
  /** Watch a wallet's swaps and mirror them. Returns unsubscribe fn. */
  watchWallet(
    targetAddress: string,
    callback: (tx: {
      type: 'buy' | 'sell';
      tokenAddress: string;
      amountNative: number;
      tokenSymbol: string;
    }) => void
  ): Promise<() => void>;

  // ── Trends ─────────────────────────────────────────────────
  getTrendingTokens(limit?: number): Promise<TokenInfo[]>;
}
