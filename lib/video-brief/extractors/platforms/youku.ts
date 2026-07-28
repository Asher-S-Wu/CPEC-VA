import { normalizeVideoBriefAssetUrl } from "@/lib/video-brief/urls";
import { matchesAnyDomain } from "@/lib/video-brief/extractors/domains";
import { VideoSourceError } from "@/lib/video-brief/extractors/errors";
import { getJsonHeaders, getMediaHeaders } from "@/lib/video-brief/extractors/headers";
import {
  fetchPublicJson,
  fetchPublicResource,
  MAX_PAGE_BYTES,
} from "@/lib/video-brief/extractors/http";
import { resolvePublicUrl } from "@/lib/video-brief/extractors/html";
import type { VideoPlatformExtractor } from "@/lib/video-brief/extractors/platform";

const API_ORIGIN = "https://ups.youku.com";
const WEB_ORIGIN = "https://v.youku.com";
const LOG_URL = "https://log.mmstat.com/eg.js";
const DOMAINS = ["youku.com", "tudou.com"];

function createCookie() {
  const suffix = Array.from(
    { length: 3 },
    () => String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join("");
  return `__ysuid=${Math.floor(Date.now() / 1000)}${suffix}; xreferrer=http://www.youku.com`;
}

function getHeaders(referer: string, cookie: string) {
  return {
    ...getJsonHeaders(referer),
    Cookie: cookie,
  };
}

function getVideoId(sourceUrl: string) {
  const match = sourceUrl.match(
    /(?:v_show\/id_|player\.php\/sid\/|video\.tudou\.com\/v\/)([A-Za-z0-9=]+)/i,
  );
  if (!match?.[1]) {
    throw new VideoSourceError("无法识别优酷视频编号", 422);
  }
  return match[1];
}

async function fetchCna(cookie: string, signal?: AbortSignal) {
  const response = await fetchPublicResource(
    LOG_URL,
    { headers: getHeaders(WEB_ORIGIN, cookie), signal },
    { maxBytes: MAX_PAGE_BYTES, label: "优酷播放凭证" },
  );
  if (!response.ok) {
    throw new VideoSourceError(`优酷播放凭证读取失败（${response.status}）`, 502);
  }
  const cna = (response.headers.get("etag") || "").replace(/^"|"$/g, "");
  if (!cna) {
    throw new VideoSourceError("优酷播放凭证为空", 502);
  }
  return cna;
}

async function fetchVideoData(
  videoId: string,
  referer: string,
  signal?: AbortSignal,
) {
  const cookie = createCookie();
  const cna = await fetchCna(cookie, signal);
  const apiUrl = new URL("/ups/get.json", API_ORIGIN);
  apiUrl.searchParams.set("vid", videoId);
  apiUrl.searchParams.set("ccode", "0564");
  apiUrl.searchParams.set("client_ip", "192.168.1.1");
  apiUrl.searchParams.set("utid", cna);
  apiUrl.searchParams.set("client_ts", String(Math.floor(Date.now() / 1000)));

  const response = await fetchPublicJson<any>(
    apiUrl,
    { headers: getHeaders(referer, cookie), signal },
    { label: "优酷接口" },
  );
  if (!response.ok) {
    throw new VideoSourceError(`优酷接口读取失败（${response.status}）`, 502);
  }
  const data = response.data?.data;
  if (data?.error) {
    const message = typeof data.error.note === "string"
      ? data.error.note
      : "优酷接口没有返回可用数据";
    throw new VideoSourceError(message.replace(/<[^>]*>/g, ""), 422);
  }
  if (!data?.video || !Array.isArray(data?.stream)) {
    throw new VideoSourceError("优酷接口返回格式异常", 502);
  }
  return data;
}

function pickStream(data: any) {
  const streams = (Array.isArray(data?.stream) ? data.stream : [])
    .filter((stream: any) => stream?.m3u8_url && stream?.channel_type !== "tail")
    .sort((left: any, right: any) => {
      const leftSize = Number(left?.size) || Number.MAX_SAFE_INTEGER;
      const rightSize = Number(right?.size) || Number.MAX_SAFE_INTEGER;
      return leftSize - rightSize;
    });
  const stream = streams[0];
  if (!stream?.m3u8_url) {
    throw new VideoSourceError("优酷没有返回可分析的视频流", 422);
  }
  return resolvePublicUrl(stream.m3u8_url, WEB_ORIGIN);
}

export const youkuExtractor: VideoPlatformExtractor = {
  id: "youku",
  name: "优酷",
  match(url) {
    return matchesAnyDomain(url, DOMAINS);
  },
  async extract({ sourceUrl, signal }) {
    const videoId = getVideoId(sourceUrl);
    const canonicalUrl = `${WEB_ORIGIN}/v_show/id_${videoId}.html`;
    const data = await fetchVideoData(videoId, canonicalUrl, signal);
    const video = data.video || {};

    return {
      sourceUrl,
      canonicalUrl,
      platformId: "youku",
      platform: "优酷",
      title: typeof video.title === "string" ? video.title.trim() : "",
      author: typeof video.username === "string" ? video.username.trim() : "",
      coverUrl: normalizeVideoBriefAssetUrl(
        typeof video.logo === "string" ? video.logo : "",
      ),
      durationSeconds: Number.isFinite(Number(video.seconds))
        ? Math.max(0, Number(video.seconds))
        : 0,
      media: {
        kind: "hls",
        url: pickStream(data),
        headers: getMediaHeaders(canonicalUrl),
      },
    };
  },
};
