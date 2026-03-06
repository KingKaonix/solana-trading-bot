// src/chains/ethereum/EthereumPlugin.ts
// ─────────────────────────────────────────────────────────────────────────────
// Ethereum chain plugin. Uses ethers.js v6 + Uniswap V3 for swaps.
// Install deps:  npm install ethers
// ─────────────────────────────────────────────────────────────────────────────
import { ChainPlugin, TokenInfo, WalletInfo, SwapResult, NewPoolEvent } from '../ChainPlugin';
import { encrypt, decrypt } from '../../utils/crypto';
import { logger } from '../../utils/logger';
import axios from 'axios';

// Dynamic import — bot boots fine without ethers installed
let ethers: any;
try { ethers = require('ethers'); } catch { /* optional */ }

const DEXSCREENER = process.env.DEXSCREENER_API || 'https://api.dexscreener.com/latest';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const UNISWAP_V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const UNISWAP_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const SWAP_ROUTER_ABI = [
  `function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) calldata params) external payable returns (uint256 amountOut)`,
];

const FACTORY_ABI = [
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
];

export class EthereumPlugin implements ChainPlugin {
  chainId = 'ethereum';
  chainName = 'Ethereum';
  nativeSymbol = 'ETH';
  private provider: any = null;

  constructor() {
    if (!ethers) { logger.warn('[Ethereum] ethers not installed. Run: npm install ethers'); return; }
    const rpcUrl = process.env.ETH_RPC_URL;
    if (!rpcUrl) { logger.warn('[Ethereum] ETH_RPC_URL not set'); return; }
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    logger.info('[Ethereum] Plugin initialized');
  }

  private require(): void {
    if (!ethers || !this.provider) throw new Error('Ethereum plugin: set ETH_RPC_URL and run npm install ethers');
  }

  async createWallet(): Promise<WalletInfo> {
    this.require();
    const w = ethers.Wallet.createRandom();
    return { address: w.address, privateKeyEncrypted: encrypt(w.privateKey), chain: this.chainId, balances: {}, nativeBalance: 0 };
  }

  async importWallet(privateKey: string): Promise<WalletInfo> {
    this.require();
    try {
      const w = new ethers.Wallet(privateKey);
      return { address: w.address, privateKeyEncrypted: encrypt(privateKey), chain: this.chainId, balances: {}, nativeBalance: 0 };
    } catch { throw new Error('Invalid Ethereum private key'); }
  }

  async getBalance(address: string): Promise<{ native: number; tokens: Record<string, number> }> {
    this.require();
    const raw = await this.provider.getBalance(address);
    return { native: parseFloat(ethers.formatEther(raw)), tokens: {} };
  }

  async buy(params: { wallet: WalletInfo; tokenAddress: string; amountNative: number; slippageBps: number; priorityFee?: number }): Promise<SwapResult> {
    this.require();
    const { wallet, tokenAddress, amountNative, slippageBps } = params;
    const signer = new ethers.Wallet(decrypt(wallet.privateKeyEncrypted), this.provider);
    const router = new ethers.Contract(UNISWAP_V3_ROUTER, SWAP_ROUTER_ABI, signer);
    const amountIn = ethers.parseEther(amountNative.toString());
    const deadline = Math.floor(Date.now() / 1000) + 300;

    const tx = await router.exactInputSingle({
      tokenIn: WETH, tokenOut: tokenAddress, fee: 3000,
      recipient: wallet.address, deadline, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
    }, { value: amountIn });
    const receipt = await tx.wait();
    logger.info(`[Ethereum] BUY ${amountNative} ETH → ${tokenAddress} | tx: ${receipt.hash}`);
    return { txHash: receipt.hash, amountIn: amountNative, amountOut: 0, tokenIn: WETH, tokenOut: tokenAddress, fee: 0, priceImpact: 0 };
  }

  async sell(params: { wallet: WalletInfo; tokenAddress: string; amountPercent: number; slippageBps: number }): Promise<SwapResult> {
    this.require();
    const { wallet, tokenAddress, amountPercent } = params;
    const signer = new ethers.Wallet(decrypt(wallet.privateKeyEncrypted), this.provider);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const balance = await token.balanceOf(wallet.address);
    const decimals = await token.decimals();
    const amountIn = (balance * BigInt(amountPercent)) / 100n;
    await (await token.approve(UNISWAP_V3_ROUTER, amountIn)).wait();
    const router = new ethers.Contract(UNISWAP_V3_ROUTER, SWAP_ROUTER_ABI, signer);
    const tx = await router.exactInputSingle({
      tokenIn: tokenAddress, tokenOut: WETH, fee: 3000,
      recipient: wallet.address, deadline: Math.floor(Date.now() / 1000) + 300,
      amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
    });
    const receipt = await tx.wait();
    return { txHash: receipt.hash, amountIn: parseFloat(ethers.formatUnits(amountIn, decimals)), amountOut: 0, tokenIn: tokenAddress, tokenOut: WETH, fee: 0, priceImpact: 0 };
  }

  async getTokenInfo(address: string): Promise<TokenInfo> {
    const res = await axios.get(`${DEXSCREENER}/dex/tokens/${address}`);
    const pairs = (res.data?.pairs || []).filter((p: any) => p.chainId === 'ethereum');
    if (!pairs.length) throw new Error('Token not found on Ethereum');
    const pair = pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return { address, symbol: pair.baseToken.symbol, name: pair.baseToken.name, decimals: 18, price_usd: parseFloat(pair.priceUsd || '0'), market_cap_usd: pair.fdv || 0, liquidity_usd: pair.liquidity?.usd || 0, volume_24h: pair.volume?.h24 || 0, price_change_24h: pair.priceChange?.h24 || 0, chain: this.chainId };
  }

  async getTokenPrice(address: string): Promise<number> {
    return (await this.getTokenInfo(address)).price_usd;
  }

  async subscribeNewPools(callback: (event: NewPoolEvent) => void): Promise<() => void> {
    this.require();
    const factory = new ethers.Contract(UNISWAP_V3_FACTORY, FACTORY_ABI, this.provider);
    const listener = async (token0: string, token1: string, _fee: number, _tick: number, pool: string) => {
      const newToken = token0.toLowerCase() === WETH.toLowerCase() ? token1 : token0;
      let info: TokenInfo | null = null;
      try { info = await this.getTokenInfo(newToken); } catch { /* skip */ }
      callback({ chain: this.chainId, poolAddress: pool, tokenAddress: newToken, tokenSymbol: info?.symbol || '???', tokenName: info?.name || 'Unknown', createdAt: new Date(), initialLiquidityUsd: info?.liquidity_usd || 0, deployer: '' });
    };
    factory.on('PoolCreated', listener);
    logger.info('[Ethereum Sniper] Watching Uniswap V3 PoolCreated events');
    return () => factory.off('PoolCreated', listener);
  }

  async watchWallet(targetAddress: string, callback: (tx: { type: 'buy' | 'sell'; tokenAddress: string; amountNative: number; tokenSymbol: string }) => void): Promise<() => void> {
    this.require();
    const listener = async (txHash: string) => {
      try {
        const tx = await this.provider.getTransaction(txHash);
        if (!tx || tx.to?.toLowerCase() !== UNISWAP_V3_ROUTER.toLowerCase() || tx.from?.toLowerCase() !== targetAddress.toLowerCase()) return;
        const type: 'buy' | 'sell' = tx.value > 0n ? 'buy' : 'sell';
        callback({ type, tokenAddress: '', amountNative: parseFloat(ethers.formatEther(tx.value || '0')), tokenSymbol: '???' });
      } catch { /* skip */ }
    };
    this.provider.on('pending', listener);
    return () => this.provider.off('pending', listener);
  }

  async getTrendingTokens(limit = 10): Promise<TokenInfo[]> {
    const res = await axios.get(`${DEXSCREENER}/dex/search?q=ethereum&orderBy=volume`);
    return (res.data?.pairs || [])
      .filter((p: any) => p.chainId === 'ethereum' && p.liquidity?.usd > 50000)
      .slice(0, limit)
      .map((p: any): TokenInfo => ({ address: p.baseToken.address, symbol: p.baseToken.symbol, name: p.baseToken.name, decimals: 18, price_usd: parseFloat(p.priceUsd || '0'), market_cap_usd: p.fdv || 0, liquidity_usd: p.liquidity?.usd || 0, volume_24h: p.volume?.h24 || 0, price_change_24h: p.priceChange?.h24 || 0, chain: 'ethereum' }));
  }
}
