/**
 * Domain matching for search source controls.
 *
 * Every provider applies these as a strict post-filter regardless of whether
 * its API natively supports include/exclude lists, so `only_domains` /
 * `excluded_domains` source policies hold even when an upstream API ignores
 * or partially honors the filter parameters.
 */

/** Lowercase, trim, strip a leading `*.`/`.` wildcard and any trailing dot. */
export const normalizeDomain = (domain: string): string =>
  domain
    .trim()
    .toLowerCase()
    .replace(/^\*?\./, '')
    .replace(/\.$/, '');

/** True when `hostname` is `domain` or a subdomain of it. */
export const hostMatchesDomain = (hostname: string, domain: string): boolean => {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  const dom = normalizeDomain(domain);
  if (dom.length === 0) return false;
  return host === dom || host.endsWith(`.${dom}`);
};

/**
 * True when `url` passes the include/exclude domain filters. Unparseable URLs
 * fail closed. Exclusion wins over inclusion.
 */
export const urlMatchesDomainFilters = (
  url: string,
  includeDomains?: string[] | undefined,
  excludeDomains?: string[] | undefined,
): boolean => {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  if (excludeDomains?.some((d) => hostMatchesDomain(hostname, d))) return false;
  if (includeDomains && includeDomains.length > 0) {
    return includeDomains.some((d) => hostMatchesDomain(hostname, d));
  }
  return true;
};

/** Strict post-filter over search results by their URL's domain. */
export const filterResultsByDomains = <T extends { url: string }>(
  results: T[],
  includeDomains?: string[] | undefined,
  excludeDomains?: string[] | undefined,
): T[] => {
  if (!includeDomains?.length && !excludeDomains?.length) return results;
  return results.filter((r) =>
    urlMatchesDomainFilters(r.url, includeDomains, excludeDomains),
  );
};

/** Combine an optional caller signal with a timeout into one AbortSignal. */
export const combineTimeoutSignal = (
  timeoutMs: number,
  signal?: AbortSignal | undefined,
): AbortSignal => {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
};
