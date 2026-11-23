import type { WebProvider } from './types.js';
import { DefuddleWebProvider } from './providers/defuddle.js';
import { ExaWebProvider } from './providers/exa.js';
import { KeenableWebProvider } from './providers/keenable.js';
import { TavilyWebProvider } from './providers/tavily.js';

export function createWebProvider(
  providerName: string,
  apiKey?: string,
): WebProvider {
  switch (providerName) {
    case 'defuddle':
      return new DefuddleWebProvider();
    case 'exa':
      if (!apiKey) throw new Error('EXA_API_KEY is required for the exa web provider');
      return new ExaWebProvider(apiKey);
    case 'tavily':
      if (!apiKey) throw new Error('TAVILY_API_KEY is required for the tavily web provider');
      return new TavilyWebProvider(apiKey);
    case 'keenable':
      // Key optional: without KEENABLE_API_KEY it uses the keyless public endpoints.
      return new KeenableWebProvider(apiKey);
    default:
      throw new Error(`Unknown web provider: ${providerName}`);
  }
}
