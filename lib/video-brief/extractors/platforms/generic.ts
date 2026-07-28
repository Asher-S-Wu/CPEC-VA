import { normalizeVideoBriefAssetUrl } from "@/lib/video-brief/urls";
import { VideoSourceError } from "@/lib/video-brief/extractors/errors";
import { getMediaHeaders, getPageHeaders } from "@/lib/video-brief/extractors/headers";
import {
  collectTags,
  getCanonicalUrl,
  getHtmlTitle,
  getMetaContent,
  parseAttributes,
  parseDurationSeconds,
  resolvePublicUrl,
} from "@/lib/video-brief/extractors/html";
import {
  fetchPublicResource,
  fetchPublicText,
  MAX_PAGE_BYTES,
} from "@/lib/video-brief/extractors/http";
import type { VideoPlatformExtractor } from "@/lib/video-brief/extractors/platform";
import type { VideoMediaSource } from "@/types/video-brief";

const DIRECT_VIDEO_RE = /\.(mp4|m3u8|flv|mov|webm|ogv)(?:$|[?#])/i;
const HLS_MIME_TYPES = new Set([
  "application/x-mpegurl",
  "application/vnd.apple.mpegurl",
]);

function getMimeType(value: string) {
  return value.trim().toLowerCase().split(";")[0];
}

function isVideoMimeType(value: string) {
  const mimeType = getMimeType(value);
  return mimeType.startsWith("video/") || HLS_MIME_TYPES.has(mimeType);
}

function isDirectVideoUrl(value: string) {
  try {
    const url = new URL(value);
    return DIRECT_VIDEO_RE.test(`${url.pathname}${url.search}`);
  } catch {
    return false;
  }
}

function getExtension(value: string) {
  try {
    const match = new URL(value).pathname.match(/\.(mp4|flv|mov|webm|ogv|ts)$/i);
    return (match?.[1]?.toLowerCase() || undefined) as
      | "mp4"
      | "flv"
      | "mov"
      | "webm"
      | "ogv"
      | "ts"
      | undefined;
  } catch {
    return undefined;
  }
}

function buildMedia(
  url: string,
  referer?: string,
  contentType = "",
): VideoMediaSource {
  const mimeType = getMimeType(contentType);
  const isHls =
    /\.m3u8(?:$|[?#])/i.test(url) ||
    HLS_MIME_TYPES.has(mimeType);
  if (isHls) {
    return {
      kind: "hls",
      url,
      headers: getMediaHeaders(referer),
    };
  }
  return {
    kind: "file",
    url,
    extension: getExtension(url),
    mimeType: mimeType || undefined,
    headers: getMediaHeaders(referer),
  };
}

function getDirectTitle(url: string) {
  const pathname = new URL(url).pathname;
  const name = pathname.split("/").filter(Boolean).pop() || "";
  try {
    return decodeURIComponent(name).replace(/\.(mp4|m3u8|flv|mov|webm|ogv)$/i, "");
  } catch {
    return name.replace(/\.(mp4|m3u8|flv|mov|webm|ogv)$/i, "");
  }
}

function buildDirectSource(sourceUrl: string, finalUrl = sourceUrl, contentType = "") {
  return {
    sourceUrl,
    canonicalUrl: finalUrl,
    platformId: "direct",
    platform: "视频直链",
    title: getDirectTitle(finalUrl),
    author: "",
    coverUrl: "",
    durationSeconds: 0,
    media: buildMedia(finalUrl, undefined, contentType),
  };
}

function getVideoCandidate(html: string, pageUrl: string) {
  const metaType = getMetaContent(html, [
    "og:video:type",
    "twitter:player:stream:content_type",
  ]);
  const metaCandidates = [
    getMetaContent(html, ["og:video:secure_url"]),
    getMetaContent(html, ["og:video:url"]),
    getMetaContent(html, ["og:video"]),
    getMetaContent(html, ["twitter:player:stream"]),
  ].filter(Boolean);

  for (const candidate of metaCandidates) {
    const url = resolvePublicUrl(candidate, pageUrl);
    if (isDirectVideoUrl(url) || isVideoMimeType(metaType)) {
      return { url, contentType: metaType };
    }
  }

  const mediaTags = [
    ...collectTags(html, "video"),
    ...collectTags(html, "source"),
  ];
  for (const tag of mediaTags) {
    const attrs = parseAttributes(tag);
    if (!attrs.src) continue;
    const url = resolvePublicUrl(attrs.src, pageUrl);
    if (isDirectVideoUrl(url) || isVideoMimeType(attrs.type || "")) {
      return { url, contentType: attrs.type || "" };
    }
  }
  return null;
}

function collectJsonLdObjects(value: any): any[] {
  if (Array.isArray(value)) return value.flatMap(collectJsonLdObjects);
  if (!value || typeof value !== "object") return [];
  const nested = Array.isArray(value["@graph"])
    ? value["@graph"].flatMap(collectJsonLdObjects)
    : [];
  return [value, ...nested];
}

function getJsonLdVideo(html: string, pageUrl: string) {
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const attrs = parseAttributes(`<script ${match[1]}>`);
    if ((attrs.type || "").toLowerCase() !== "application/ld+json") continue;
    try {
      const objects = collectJsonLdObjects(JSON.parse(match[2]));
      const video = objects.find((item) => {
        const type = item?.["@type"];
        return type === "VideoObject" || (Array.isArray(type) && type.includes("VideoObject"));
      });
      if (!video?.contentUrl) continue;
      const url = resolvePublicUrl(video.contentUrl, pageUrl);
      if (!isDirectVideoUrl(url) && !isVideoMimeType(String(video.encodingFormat || ""))) {
        continue;
      }
      const thumbnail = Array.isArray(video.thumbnailUrl)
        ? video.thumbnailUrl[0]
        : video.thumbnailUrl;
      return {
        url,
        contentType: String(video.encodingFormat || ""),
        title: typeof video.name === "string" ? video.name.trim() : "",
        author:
          typeof video.author?.name === "string"
            ? video.author.name.trim()
            : typeof video.publisher?.name === "string"
              ? video.publisher.name.trim()
              : "",
        coverUrl: thumbnail ? resolvePublicUrl(String(thumbnail), pageUrl) : "",
        durationSeconds: parseDurationSeconds(video.duration),
      };
    } catch {
      continue;
    }
  }
  return null;
}

export const directVideoExtractor: VideoPlatformExtractor = {
  id: "direct",
  name: "视频直链",
  match(url) {
    return isDirectVideoUrl(url.toString());
  },
  async extract({ sourceUrl }) {
    return buildDirectSource(sourceUrl);
  },
};

export const genericWebVideoExtractor: VideoPlatformExtractor = {
  id: "generic-web",
  name: "公开视频",
  match() {
    return true;
  },
  async extract({ sourceUrl, signal }) {
    const probe = await fetchPublicResource(
      sourceUrl,
      { headers: getPageHeaders(sourceUrl), signal },
      {
        maxBytes: 0,
        readBody: false,
        label: "视频页面",
      },
    );
    if (!probe.ok) {
      throw new VideoSourceError(`视频页面读取失败（${probe.status}）`, 502);
    }

    const contentType = probe.headers.get("content-type") || "";
    if (isVideoMimeType(contentType) || isDirectVideoUrl(probe.url)) {
      return buildDirectSource(sourceUrl, probe.url, contentType);
    }
    if (!contentType.toLowerCase().includes("text/html")) {
      throw new VideoSourceError("该地址不是可读取的视频页面", 422);
    }

    const page = await fetchPublicText(
      probe.url,
      { headers: getPageHeaders(sourceUrl), signal },
      { maxBytes: MAX_PAGE_BYTES, label: "视频页面" },
    );
    if (!page.ok) {
      throw new VideoSourceError(`视频页面读取失败（${page.status}）`, 502);
    }

    const canonicalUrl = getCanonicalUrl(page.text, page.url);
    const jsonLd = getJsonLdVideo(page.text, page.url);
    const candidate = jsonLd || getVideoCandidate(page.text, page.url);
    if (!candidate) {
      throw new VideoSourceError(
        "无法读取该网页里的视频源。该视频可能需要登录、会员权限、DRM 或被平台反爬限制。",
        422,
      );
    }

    const durationText = getMetaContent(page.text, [
      "video:duration",
      "og:video:duration",
      "duration",
    ]);
    const coverCandidate =
      jsonLd?.coverUrl ||
      getMetaContent(page.text, [
        "og:image:secure_url",
        "og:image",
        "twitter:image",
      ]);
    return {
      sourceUrl,
      canonicalUrl,
      platformId: "generic-web",
      platform: "公开视频",
      title: jsonLd?.title || getHtmlTitle(page.text),
      author:
        jsonLd?.author ||
        getMetaContent(page.text, ["author", "article:author", "og:site_name"]),
      coverUrl: normalizeVideoBriefAssetUrl(
        coverCandidate ? resolvePublicUrl(coverCandidate, page.url) : "",
      ),
      durationSeconds:
        jsonLd?.durationSeconds || parseDurationSeconds(durationText),
      media: buildMedia(candidate.url, canonicalUrl, candidate.contentType),
    };
  },
};
