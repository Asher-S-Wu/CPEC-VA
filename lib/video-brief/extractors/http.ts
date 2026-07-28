import { lookup } from "dns/promises";
import { request as requestHttp, type IncomingMessage } from "http";
import { request as requestHttps } from "https";
import { BlockList, isIP } from "net";
import { VideoSourceError } from "@/lib/video-brief/extractors/errors";

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export const MAX_PAGE_BYTES = 3 * 1024 * 1024;
export const MAX_JSON_BYTES = 5 * 1024 * 1024;
export const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
export const MAX_REMOTE_VIDEO_BYTES = 100 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 5;
const MAX_URL_LENGTH = 4_096;
const MAX_RESPONSE_HEADER_BYTES = 16 * 1024;
const MAX_TIMEOUT_MS = 2 * 60_000;
const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".home",
  ".home.arpa",
  ".lan",
  ".test",
  ".invalid",
  ".example",
  ".onion",
];
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "forwarded",
  "proxy-authorization",
  "proxy-authenticate",
]);

const blockedAddresses = new BlockList();
const publicIpv6Addresses = new BlockList();
publicIpv6Addresses.addSubnet("2000::", 3, "ipv6");
[
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
].forEach(([address, prefix]) =>
  blockedAddresses.addSubnet(String(address), Number(prefix), "ipv4"),
);
[
  ["::", 96],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3ffe::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
].forEach(([address, prefix]) =>
  blockedAddresses.addSubnet(String(address), Number(prefix), "ipv6"),
);

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface PublicResource {
  url: string;
  status: number;
  ok: boolean;
  headers: Headers;
  setCookies: Array<{ url: string; value: string }>;
  body: Uint8Array<ArrayBuffer>;
}

export interface PublicFetchOptions {
  maxBytes: number;
  readBody?: boolean;
  timeoutMs?: number;
  maxRedirects?: number;
  label?: string;
}

function normalizedHostname(url: URL) {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isBlockedIp(value: string) {
  const version = isIP(value);
  if (version === 4) return blockedAddresses.check(value, "ipv4");
  if (version === 6) {
    return (
      !publicIpv6Addresses.check(value, "ipv6") ||
      blockedAddresses.check(value, "ipv6")
    );
  }
  return true;
}

function isAllowedPort(url: URL) {
  if (!url.port) return true;
  return (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  );
}

export function assertPublicHttpUrl(input: string | URL) {
  let parsed: URL;
  try {
    const rawValue = input instanceof URL ? input.toString() : input;
    if (rawValue.length > MAX_URL_LENGTH) {
      throw new VideoSourceError("视频网址过长", 400);
    }
    parsed = new URL(rawValue);
  } catch (error) {
    if (error instanceof VideoSourceError) throw error;
    throw new VideoSourceError("请输入正确的视频网址", 400);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new VideoSourceError("只支持 http 或 https 视频网址", 400);
  }
  if (parsed.username || parsed.password) {
    throw new VideoSourceError("视频网址不能包含账号或密码", 400);
  }
  if (!isAllowedPort(parsed)) {
    throw new VideoSourceError("视频网址使用了不支持的网络端口", 400);
  }

  const hostname = normalizedHostname(parsed);
  if (
    !hostname ||
    hostname === "localhost" ||
    (isIP(hostname) === 0 && !hostname.includes(".")) ||
    BLOCKED_HOST_SUFFIXES.some(
      (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
    ) ||
    (isIP(hostname) > 0 && isBlockedIp(hostname))
  ) {
    throw new VideoSourceError("不支持读取本地或内网地址", 400);
  }

  parsed.hash = "";
  return parsed;
}

async function lookupWithSignal(hostname: string, signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      lookup(hostname, { all: true, order: "verbatim" }),
      abortPromise,
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function resolvePublicAddress(
  url: URL,
  signal: AbortSignal,
): Promise<ResolvedAddress> {
  const hostname = normalizedHostname(url);
  const literalFamily = isIP(hostname);
  if (literalFamily > 0) {
    if (isBlockedIp(hostname)) {
      throw new VideoSourceError("不支持读取本地或内网地址", 400);
    }
    return { address: hostname, family: literalFamily as 4 | 6 };
  }

  let addresses: Array<{ address: string; family: number }> = [];
  try {
    addresses = await lookupWithSignal(hostname, signal);
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new VideoSourceError("视频网址无法解析", 502);
  }

  if (
    addresses.length === 0 ||
    addresses.some(
      (item) =>
        (item.family !== 4 && item.family !== 6) || isBlockedIp(item.address),
    )
  ) {
    throw new VideoSourceError("不支持读取指向本地或内网的视频网址", 400);
  }

  const selected = addresses[0];
  return {
    address: selected.address,
    family: selected.family as 4 | 6,
  };
}

function createCombinedSignal(
  parent: AbortSignal | null | undefined,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) {
    abortFromParent();
  } else {
    parent?.addEventListener("abort", abortFromParent, { once: true });
  }

  const timeoutId = setTimeout(
    () => controller.abort(new DOMException("请求超时", "TimeoutError")),
    timeoutMs,
  );

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeoutId);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

function validateRequestHeaders(headers: Headers) {
  for (const [name] of headers) {
    const normalized = name.toLowerCase();
    if (
      FORBIDDEN_REQUEST_HEADERS.has(normalized) ||
      normalized.startsWith("x-forwarded-")
    ) {
      throw new VideoSourceError("远程请求包含不允许使用的请求头", 400);
    }
  }
}

function validateFetchOptions(options: PublicFetchOptions) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 0 ||
    options.maxBytes > MAX_REMOTE_VIDEO_BYTES
  ) {
    throw new VideoSourceError("远程请求的大小限制配置无效", 500);
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new VideoSourceError("远程请求的超时配置无效", 500);
  }
  if (
    !Number.isSafeInteger(maxRedirects) ||
    maxRedirects < 0 ||
    maxRedirects > MAX_REDIRECTS
  ) {
    throw new VideoSourceError("远程请求的跳转限制配置无效", 500);
  }
}

function serializeRequestBody(body: BodyInit | null | undefined, headers: Headers) {
  if (body == null) return undefined;

  let bytes: Uint8Array;
  if (typeof body === "string") {
    bytes = Buffer.from(body);
  } else if (body instanceof URLSearchParams) {
    bytes = Buffer.from(body.toString());
    if (!headers.has("content-type")) {
      headers.set(
        "content-type",
        "application/x-www-form-urlencoded;charset=UTF-8",
      );
    }
  } else if (body instanceof ArrayBuffer) {
    bytes = new Uint8Array(body);
  } else if (ArrayBuffer.isView(body)) {
    bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  } else {
    throw new VideoSourceError("远程请求使用了不支持的数据格式", 500);
  }

  headers.set("content-length", String(bytes.byteLength));
  return bytes;
}

function responseHeadersToWeb(
  responseHeaders: Record<string, string | string[] | undefined>,
) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(responseHeaders)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (typeof value === "string") {
      headers.set(name, value);
    }
  }
  return headers;
}

function performPinnedRequest(
  url: URL,
  address: ResolvedAddress,
  method: string,
  headers: Headers,
  body: Uint8Array | undefined,
  signal: AbortSignal,
  maxBytes: number,
  readBody: boolean,
  label: string,
): Promise<PublicResource> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (resource: PublicResource) => {
      if (settled) return;
      settled = true;
      resolve(resource);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const nodeHeaders: Record<string, string> = {};
    for (const [name, value] of headers) nodeHeaders[name] = value;
    nodeHeaders.host = url.host;
    const requestOptions = {
      protocol: url.protocol,
      hostname: address.address,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers: nodeHeaders,
      agent: false,
      family: address.family,
      autoSelectFamily: false,
      maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
      signal,
      servername:
        url.protocol === "https:" && isIP(normalizedHostname(url)) === 0
          ? normalizedHostname(url)
          : undefined,
      rejectUnauthorized: true,
    };
    const handleResponse = (response: IncomingMessage) => {
      const status = response.statusCode || 0;
      const webHeaders = responseHeadersToWeb(response.headers);
      const setCookies = Array.isArray(response.headers["set-cookie"])
        ? response.headers["set-cookie"].map((value) => ({
            url: url.toString(),
            value,
          }))
        : [];
      const baseResource = {
        url: url.toString(),
        status,
        ok: status >= 200 && status < 300,
        headers: webHeaders,
        setCookies,
      };

      if (REDIRECT_STATUSES.has(status) || !readBody) {
        finish({ ...baseResource, body: new Uint8Array() });
        response.destroy();
        return;
      }

      const contentLength = Number(response.headers["content-length"]);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        fail(new VideoSourceError(`${label}超过允许的大小`, 413));
        response.destroy();
        return;
      }

      const parts: Uint8Array[] = [];
      const allocatedBody =
        Number.isSafeInteger(contentLength) && contentLength >= 0
          ? new Uint8Array(contentLength)
          : null;
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        const offset = total;
        total += chunk.byteLength;
        if (total > maxBytes) {
          fail(new VideoSourceError(`${label}超过允许的大小`, 413));
          response.destroy();
          return;
        }
        if (allocatedBody) {
          if (total > allocatedBody.byteLength) {
            fail(new VideoSourceError(`${label}长度与响应头不一致`, 502));
            response.destroy();
            return;
          }
          allocatedBody.set(chunk, offset);
        } else {
          parts.push(chunk);
        }
      });
      response.on("end", () => {
        if (settled) return;
        if (allocatedBody && total !== allocatedBody.byteLength) {
          fail(new VideoSourceError(`${label}内容不完整`, 502));
          return;
        }
        const bodyBytes = allocatedBody || new Uint8Array(total);
        if (!allocatedBody) {
          let offset = 0;
          for (const part of parts) {
            bodyBytes.set(part, offset);
            offset += part.byteLength;
          }
        }
        finish({ ...baseResource, body: bodyBytes });
      });
      response.on("aborted", () =>
        fail(new VideoSourceError(`${label}读取中断`, 502)),
      );
      response.on("error", fail);
    };
    const requestHandle =
      url.protocol === "https:"
        ? requestHttps(requestOptions, handleResponse)
        : requestHttp(requestOptions, handleResponse);

    requestHandle.on("error", fail);
    if (body && body.byteLength > 0) requestHandle.write(body);
    requestHandle.end();
  });
}

function removeSensitiveRedirectHeaders(headers: Headers) {
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("origin");
  headers.delete("referer");
  headers.delete("proxy-authorization");
}

export async function fetchPublicResource(
  input: string | URL,
  init: RequestInit,
  options: PublicFetchOptions,
): Promise<PublicResource> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const label = options.label || "远程内容";
  validateFetchOptions(options);
  let currentUrl = assertPublicHttpUrl(input);
  let method = String(init.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "POST"].includes(method)) {
    throw new VideoSourceError("远程请求方法不受支持", 500);
  }
  let body = init.body;
  const headers = new Headers(init.headers);
  const visitedUrls = new Set<string>();
  const capturedSetCookies: Array<{ url: string; value: string }> = [];
  validateRequestHeaders(headers);
  headers.set("accept-encoding", "identity");
  const combined = createCombinedSignal(init.signal, timeoutMs);

  try {
    for (
      let redirectCount = 0;
      redirectCount <= maxRedirects;
      redirectCount += 1
    ) {
      const normalizedUrl = currentUrl.toString();
      if (visitedUrls.has(normalizedUrl)) {
        throw new VideoSourceError(`${label}出现循环跳转`, 502);
      }
      visitedUrls.add(normalizedUrl);
      const resolvedAddress = await resolvePublicAddress(
        currentUrl,
        combined.signal,
      );
      const requestHeaders = new Headers(headers);
      const requestBody =
        method === "GET" || method === "HEAD"
          ? undefined
          : serializeRequestBody(body, requestHeaders);
      const response = await performPinnedRequest(
        currentUrl,
        resolvedAddress,
        method,
        requestHeaders,
        requestBody,
        combined.signal,
        options.maxBytes,
        options.readBody !== false,
        label,
      );
      capturedSetCookies.push(...response.setCookies);

      if (!REDIRECT_STATUSES.has(response.status)) {
        return { ...response, setCookies: capturedSetCookies };
      }

      const location = response.headers.get("location");
      if (!location) {
        throw new VideoSourceError(`${label}跳转地址为空`, 502);
      }
      if (redirectCount === maxRedirects) {
        throw new VideoSourceError(`${label}跳转次数过多`, 502);
      }

      const nextUrl = assertPublicHttpUrl(new URL(location, currentUrl));
      if (nextUrl.origin !== currentUrl.origin) {
        removeSensitiveRedirectHeaders(headers);
      }
      if (
        (response.status === 303 && method !== "HEAD") ||
        ((response.status === 301 || response.status === 302) &&
          method === "POST")
      ) {
        method = "GET";
        body = undefined;
        headers.delete("content-type");
      }
      currentUrl = nextUrl;
    }
  } catch (error) {
    if (combined.signal.aborted) {
      if (
        (combined.signal.reason as { name?: unknown } | undefined)?.name ===
        "TimeoutError"
      ) {
        throw new VideoSourceError(`${label}读取超时`, 504);
      }
      if (init.signal?.aborted) {
        throw new VideoSourceError("视频处理已取消", 499);
      }
      throw new VideoSourceError(`${label}读取超时`, 504);
    }
    if (error instanceof VideoSourceError) throw error;
    throw new VideoSourceError(`${label}读取失败`, 502);
  } finally {
    combined.cleanup();
  }

  throw new VideoSourceError(`${label}读取失败`, 502);
}

export async function fetchPublicHeaders(
  input: string | URL,
  init: RequestInit = {},
  options: Omit<PublicFetchOptions, "maxBytes" | "readBody"> = {},
) {
  return fetchPublicResource(
    input,
    { ...init, method: "HEAD", body: undefined },
    {
      ...options,
      maxBytes: 0,
      readBody: false,
    },
  );
}

export function decodeResourceText(resource: PublicResource) {
  return new TextDecoder("utf-8").decode(resource.body);
}

export async function fetchPublicText(
  input: string | URL,
  init: RequestInit = {},
  options: Omit<PublicFetchOptions, "maxBytes"> & { maxBytes?: number } = {},
) {
  const resource = await fetchPublicResource(input, init, {
    ...options,
    maxBytes: options.maxBytes ?? MAX_PAGE_BYTES,
  });
  return {
    ...resource,
    text: decodeResourceText(resource),
  };
}

export async function fetchPublicJson<T = any>(
  input: string | URL,
  init: RequestInit = {},
  options: Omit<PublicFetchOptions, "maxBytes"> & { maxBytes?: number } = {},
) {
  const resource = await fetchPublicText(input, init, {
    ...options,
    maxBytes: options.maxBytes ?? MAX_JSON_BYTES,
  });
  let data: T;
  try {
    data = JSON.parse(resource.text) as T;
  } catch {
    throw new VideoSourceError(
      `${options.label || "远程接口"}返回格式异常`,
      502,
    );
  }
  return { ...resource, data };
}

export function getSetCookieHeaders(
  source: Pick<PublicResource, "setCookies">,
  allowedOrigins: string[],
) {
  const origins = new Set(allowedOrigins.map((value) => new URL(value).origin));
  return source.setCookies
    .filter(
      (item) =>
        origins.size > 0 && origins.has(new URL(item.url).origin),
    )
    .map((item) => item.value);
}

export function buildCookieHeader(setCookieValues: string[]) {
  const cookies = new Map<string, string>();
  for (const value of setCookieValues) {
    const pair = value.split(";", 1)[0]?.trim();
    const separator = pair?.indexOf("=") ?? -1;
    if (!pair || separator <= 0) continue;
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return Array.from(cookies, ([name, value]) => `${name}=${value}`).join("; ");
}
