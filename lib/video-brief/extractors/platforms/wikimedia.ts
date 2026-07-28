import { normalizeVideoBriefAssetUrl } from "@/lib/video-brief/urls";
import { matchesAnyDomain } from "@/lib/video-brief/extractors/domains";
import { VideoSourceError } from "@/lib/video-brief/extractors/errors";
import { decodeHtml, resolvePublicUrl } from "@/lib/video-brief/extractors/html";
import {
  fetchPublicJson,
  MAX_REMOTE_VIDEO_BYTES,
} from "@/lib/video-brief/extractors/http";
import type { VideoPlatformExtractor } from "@/lib/video-brief/extractors/platform";

const COMMONS_ORIGIN = "https://commons.wikimedia.org";
const WIKIMEDIA_USER_AGENT =
  "CPEC-VA/1.0 (https://github.com/Asher-S-Wu/CPEC-VA)";

function getFileTitle(url: URL) {
  const match = url.pathname.match(/^\/wiki\/File:(.+)$/i);
  if (!match?.[1]) {
    throw new VideoSourceError("无法识别 Wikimedia Commons 文件名", 422);
  }
  try {
    return `File:${decodeURIComponent(match[1])}`;
  } catch {
    throw new VideoSourceError("Wikimedia Commons 文件名格式不正确", 400);
  }
}

function hasMixedCodecs(type: string) {
  const normalized = type.toLowerCase();
  const hasVideo = /\b(vp8|vp9|av1|av01(?:\.[\w.]+)?|theora)\b/.test(
    normalized,
  );
  const hasAudio = /\b(opus|vorbis)\b/.test(normalized);
  return (
    /^video\/(?:webm|ogg)\b/.test(normalized) &&
    hasVideo &&
    hasAudio
  );
}

function pickDerivative(videoInfo: any) {
  const candidates = (Array.isArray(videoInfo?.derivatives)
    ? videoInfo.derivatives
    : []
  )
    .filter(
      (item: any) =>
        typeof item?.src === "string" &&
        item.src &&
        hasMixedCodecs(String(item?.type || "")),
    )
    .map((item: any, index: number) => ({
      ...item,
      index,
      height: Number(item?.height) || 0,
      bandwidth: Number(item?.bandwidth) || 0,
      estimatedBytes:
        Number(item?.bandwidth) > 0 && Number(videoInfo?.duration) > 0
          ? (Number(item.bandwidth) * Number(videoInfo.duration)) / 8
          : 0,
    }))
    .filter(
      (item: any) =>
        (item.height === 0 || item.height <= 720) &&
        (item.estimatedBytes === 0 ||
          item.estimatedBytes <= MAX_REMOTE_VIDEO_BYTES),
    )
    .sort((left: any, right: any) => {
      const heightDifference = right.height - left.height;
      if (heightDifference !== 0) return heightDifference;
      const bandwidthDifference = left.bandwidth - right.bandwidth;
      if (bandwidthDifference !== 0) return bandwidthDifference;
      return left.index - right.index;
    });
  if (!candidates[0]) {
    throw new VideoSourceError(
      "Wikimedia Commons 没有返回 720P 以内的混合 WebM/Ogg 视频",
      422,
    );
  }
  return candidates[0];
}

function cleanMetadataText(value: unknown) {
  if (typeof value !== "string") return "";
  return decodeHtml(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
}

export const wikimediaExtractor: VideoPlatformExtractor = {
  id: "wikimedia-commons",
  name: "Wikimedia Commons",
  match(url) {
    return (
      matchesAnyDomain(url, ["commons.wikimedia.org"]) &&
      /^\/wiki\/File:/i.test(url.pathname)
    );
  },
  async extract({ sourceUrl, url, signal }) {
    const fileTitle = getFileTitle(url);
    const apiUrl = new URL("/w/api.php", COMMONS_ORIGIN);
    apiUrl.searchParams.set("action", "query");
    apiUrl.searchParams.set("format", "json");
    apiUrl.searchParams.set("formatversion", "2");
    apiUrl.searchParams.set("prop", "videoinfo");
    apiUrl.searchParams.set("titles", fileTitle);
    apiUrl.searchParams.set(
      "viprop",
      "timestamp|user|url|size|derivatives|timedtext|extmetadata",
    );
    apiUrl.searchParams.set("viurlwidth", "640");
    const headers = {
      Accept: "application/json",
      "User-Agent": WIKIMEDIA_USER_AGENT,
    };
    const response = await fetchPublicJson<any>(
      apiUrl,
      { headers, signal },
      { label: "Wikimedia Commons 视频接口" },
    );
    if (!response.ok) {
      throw new VideoSourceError(
        `Wikimedia Commons 视频接口读取失败（${response.status}）`,
        response.status === 404 ? 422 : 502,
      );
    }

    const page = response.data?.query?.pages?.[0];
    const videoInfo = page?.videoinfo?.[0];
    if (!page?.pageid || !videoInfo) {
      throw new VideoSourceError(
        "Wikimedia Commons 没有返回可用的视频信息",
        422,
      );
    }
    const derivative = pickDerivative(videoInfo);
    const mediaType = String(derivative.type || "").toLowerCase();
    const extension = mediaType.startsWith("video/ogg") ? "ogv" : "webm";
    const normalizedTitle = String(page.title || fileTitle)
      .replace(/^File:/i, "")
      .replace(/ /g, "_");
    const canonicalUrl = `${COMMONS_ORIGIN}/wiki/File:${encodeURIComponent(
      normalizedTitle,
    )}`;

    return {
      sourceUrl,
      canonicalUrl,
      platformId: "wikimedia-commons",
      platform: "Wikimedia Commons",
      title:
        cleanMetadataText(videoInfo?.extmetadata?.ObjectName?.value) ||
        String(page.title || fileTitle).replace(/^File:/i, "").replace(/_/g, " "),
      author:
        cleanMetadataText(videoInfo?.extmetadata?.Artist?.value) ||
        (typeof videoInfo?.user === "string" ? videoInfo.user.trim() : ""),
      coverUrl: normalizeVideoBriefAssetUrl(
        typeof videoInfo?.thumburl === "string" ? videoInfo.thumburl : "",
      ),
      durationSeconds: Number.isFinite(Number(videoInfo?.duration))
        ? Math.max(0, Number(videoInfo.duration))
        : 0,
      media: {
        kind: "file",
        url: resolvePublicUrl(derivative.src, COMMONS_ORIGIN),
        extension,
        mimeType: extension === "ogv" ? "video/ogg" : "video/webm",
        headers: {
          "User-Agent": WIKIMEDIA_USER_AGENT,
        },
      },
    };
  },
};
