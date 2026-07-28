export function getUrlHost(value: string | URL) {
  try {
    const url = value instanceof URL ? value : new URL(value);
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

export function isDomainOrSubdomain(hostname: string, domain: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const target = domain.toLowerCase().replace(/\.$/, "");
  return host === target || host.endsWith(`.${target}`);
}

export function matchesAnyDomain(value: string | URL, domains: string[]) {
  const hostname = getUrlHost(value);
  return domains.some((domain) => isDomainOrSubdomain(hostname, domain));
}
