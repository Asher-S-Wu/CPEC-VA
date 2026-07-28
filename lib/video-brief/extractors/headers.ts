import { BROWSER_USER_AGENT } from "@/lib/video-brief/extractors/http";

export function getPageHeaders(referer?: string) {
  const headers: Record<string, string> = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "User-Agent": BROWSER_USER_AGENT,
  };
  if (referer) headers.Referer = referer;
  return headers;
}

export function getJsonHeaders(referer?: string, origin?: string) {
  const headers: Record<string, string> = {
    Accept: "application/json,text/plain,*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "User-Agent": BROWSER_USER_AGENT,
  };
  if (referer) headers.Referer = referer;
  if (origin) headers.Origin = origin;
  return headers;
}

export function getMediaHeaders(
  referer?: string,
  extra: Record<string, string> = {},
) {
  return {
    "User-Agent": BROWSER_USER_AGENT,
    ...(referer ? { Referer: referer } : {}),
    ...extra,
  };
}
