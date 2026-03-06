// src/chains/registry.ts
import { ChainPlugin } from './ChainPlugin';

const plugins = new Map<string, ChainPlugin>();

export function registerChain(plugin: ChainPlugin): void {
  plugins.set(plugin.chainId, plugin);
  console.log(`[Registry] Chain plugin registered: ${plugin.chainName} (${plugin.chainId})`);
}

export function getChain(chainId: string): ChainPlugin {
  const plugin = plugins.get(chainId);
  if (!plugin) throw new Error(`Chain plugin not found: "${chainId}". Register it first.`);
  return plugin;
}

export function listChains(): ChainPlugin[] {
  return Array.from(plugins.values());
}

export function supportedChainIds(): string[] {
  return Array.from(plugins.keys());
}
