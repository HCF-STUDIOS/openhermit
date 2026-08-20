export type {
  WebProvider,
  WebProviderCapabilities,
  WebSearchResult,
  WebSearchOptions,
  WebFetchResult,
  WebFetchOptions,
  WebAcquisition,
} from './types.js';

export { createWebProvider } from './factory.js';
export { DefuddleWebProvider } from './providers/defuddle.js';
export { ExaWebProvider } from './providers/exa.js';
export { TavilyWebProvider } from './providers/tavily.js';
export {
  normalizeDomain,
  hostMatchesDomain,
  urlMatchesDomainFilters,
  filterResultsByDomains,
} from './domains.js';
