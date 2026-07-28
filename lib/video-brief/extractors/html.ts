import { assertPublicHttpUrl } from "@/lib/video-brief/extractors/http";
import { VideoSourceError } from "@/lib/video-brief/extractors/errors";

export function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

export function parseAttributes(tag: string) {
  const attrs: Record<string, string> = {};
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tag))) {
    attrs[match[1].toLowerCase()] = decodeHtml(match[2] || match[3] || match[4] || "");
  }
  return attrs;
}

export function collectTags(html: string, name: string) {
  const pattern = new RegExp(`<${name}\\b[^>]*>`, "gi");
  return html.match(pattern) || [];
}

export function getMetaContent(html: string, keys: string[]) {
  const normalizedKeys = new Set(keys.map((key) => key.toLowerCase()));
  for (const tag of collectTags(html, "meta")) {
    const attrs = parseAttributes(tag);
    const key = (attrs.property || attrs.name || attrs.itemprop || "").toLowerCase();
    if (normalizedKeys.has(key) && attrs.content) {
      return attrs.content;
    }
  }
  return "";
}

export function getHtmlTitle(html: string) {
  const metaTitle = getMetaContent(html, ["og:title", "twitter:title", "title"]);
  if (metaTitle) return metaTitle;
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml(match[1].replace(/\s+/g, " ")) : "";
}

export function resolvePublicUrl(value: string, baseUrl: string) {
  return assertPublicHttpUrl(new URL(decodeHtml(value), baseUrl)).toString();
}

export function getCanonicalUrl(html: string, pageUrl: string) {
  for (const tag of collectTags(html, "link")) {
    const attrs = parseAttributes(tag);
    if ((attrs.rel || "").toLowerCase() === "canonical" && attrs.href) {
      return resolvePublicUrl(attrs.href, pageUrl);
    }
  }
  return pageUrl;
}

function extractBalancedValue(source: string, start: number) {
  const opener = source[start];
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : "";
  if (!closer) return "";

  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === opener) depth += 1;
    if (char === closer) {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return "";
}

function replaceUndefinedValues(value: string) {
  let result = "";
  let index = 0;
  let quote = "";
  let escaped = false;
  while (index < value.length) {
    const char = value[index];
    if (quote) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      index += 1;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      result += char;
      index += 1;
      continue;
    }
    if (
      value.startsWith("undefined", index) &&
      !/[\w$]/.test(value[index - 1] || "") &&
      !/[\w$]/.test(value[index + "undefined".length] || "")
    ) {
      result += "null";
      index += "undefined".length;
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

export function extractAssignedJson(html: string, marker: string, label: string) {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) {
    throw new VideoSourceError(`无法读取${label}`, 422);
  }
  const objectStart = html.slice(markerIndex + marker.length).search(/[\[{]/);
  if (objectStart < 0) {
    throw new VideoSourceError(`${label}格式异常`, 502);
  }
  const absoluteStart = markerIndex + marker.length + objectStart;
  const raw = extractBalancedValue(html, absoluteStart);
  if (!raw) {
    throw new VideoSourceError(`${label}不完整`, 502);
  }
  try {
    return JSON.parse(replaceUndefinedValues(raw));
  } catch {
    throw new VideoSourceError(`${label}格式异常`, 502);
  }
}

export function getScriptTextById(html: string, id: string) {
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const attrs = parseAttributes(`<script ${match[1]}>`);
    if (attrs.id === id) return match[2].trim();
  }
  return "";
}

export function parseDurationSeconds(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  const text = String(value || "").trim();
  if (!text) return 0;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.max(0, Number(text));

  const iso = text.match(
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i,
  );
  if (iso) {
    return (
      Number(iso[1] || 0) * 86400 +
      Number(iso[2] || 0) * 3600 +
      Number(iso[3] || 0) * 60 +
      Number(iso[4] || 0)
    );
  }

  const clock = text.split(":").map(Number);
  if (clock.length >= 2 && clock.length <= 3 && clock.every(Number.isFinite)) {
    return clock.reduce((total, part) => total * 60 + part, 0);
  }
  return 0;
}
