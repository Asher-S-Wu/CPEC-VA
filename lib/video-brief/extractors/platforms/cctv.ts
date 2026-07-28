import { normalizeVideoBriefAssetUrl } from "@/lib/video-brief/urls";
import { matchesAnyDomain } from "@/lib/video-brief/extractors/domains";
import { VideoSourceError } from "@/lib/video-brief/extractors/errors";
import {
  getJsonHeaders,
  getMediaHeaders,
  getPageHeaders,
} from "@/lib/video-brief/extractors/headers";
import {
  fetchPublicJson,
  fetchPublicText,
} from "@/lib/video-brief/extractors/http";
import { resolvePublicUrl } from "@/lib/video-brief/extractors/html";
import type { VideoPlatformExtractor } from "@/lib/video-brief/extractors/platform";

const DOMAINS = ["cctv.com", "cctv.cn", "cntv.com", "cntv.cn"];
const VIDEO_API = "https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do";
const GUID = "([0-9a-fA-F]{32})";

function extractGuid(html: string) {
  const patterns = [
    new RegExp(`\\bvar\\s+guid\\s*=\\s*["']${GUID}["']`, "i"),
    new RegExp(`["']?videoCenterId["']?\\s*[:=]\\s*["']${GUID}["']`, "i"),
    new RegExp(
      `addVariable\\(\\s*["']videoCenterId["']\\s*,\\s*["']${GUID}["']`,
      "i",
    ),
    new RegExp(`\\bchangePlayer\\(\\s*["']${GUID}["']`, "i"),
    new RegExp(`\\bloadVideo\\(\\s*["']${GUID}["']`, "i"),
    new RegExp(`\\bvar\\s+initMyAray\\s*=\\s*["']${GUID}["']`, "i"),
    new RegExp(`\\bvar\\s+ids\\s*=\\s*\\[\\s*["']${GUID}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1].toLowerCase();
  }
  throw new VideoSourceError("无法识别央视网视频编号", 422);
}

function ensurePlayable(data: any) {
  if (
    String(data?.ack || "").toLowerCase() !== "yes" ||
    String(data?.status || "") !== "001" ||
    String(data?.play || "") !== "1"
  ) {
    throw new VideoSourceError(
      typeof data?.err_msg === "string"
        ? data.err_msg
        : "央视网没有返回可播放的视频",
      422,
    );
  }
  if (
    String(data?.is_protected || "0") === "1" ||
    (data?.public != null && String(data.public) !== "1")
  ) {
    throw new VideoSourceError("该央视网视频不是公开内容", 422);
  }
}

export const cctvExtractor: VideoPlatformExtractor = {
  id: "cctv",
  name: "央视网",
  match(url) {
    return (
      matchesAnyDomain(url, DOMAINS) &&
      (/\.s?html?$/i.test(url.pathname) ||
        /\/video(?:\/|$)/i.test(url.pathname))
    );
  },
  async extract({ sourceUrl, signal }) {
    const page = await fetchPublicText(
      sourceUrl,
      { headers: getPageHeaders(), signal },
      { label: "央视网视频页面" },
    );
    if (!page.ok) {
      throw new VideoSourceError(
        `央视网视频页面读取失败（${page.status}）`,
        502,
      );
    }

    const guid = extractGuid(page.text);
    const apiUrl = new URL(VIDEO_API);
    apiUrl.searchParams.set("pid", guid);
    apiUrl.searchParams.set("url", page.url);
    apiUrl.searchParams.set("idl", "32");
    apiUrl.searchParams.set("idlr", "32");
    apiUrl.searchParams.set("modifyed", "false");
    const response = await fetchPublicJson<any>(
      apiUrl,
      { headers: getJsonHeaders(), signal },
      { label: "央视网播放接口" },
    );
    if (!response.ok) {
      throw new VideoSourceError(
        `央视网播放接口读取失败（${response.status}）`,
        502,
      );
    }
    ensurePlayable(response.data);

    const hlsUrl =
      typeof response.data?.hls_url === "string"
        ? response.data.hls_url.trim()
        : "";
    if (!hlsUrl) {
      throw new VideoSourceError("央视网没有返回可分析的视频流", 422);
    }

    const video = response.data?.video || {};
    return {
      sourceUrl,
      canonicalUrl: page.url,
      platformId: "cctv",
      platform: "央视网",
      title:
        typeof response.data?.title === "string"
          ? response.data.title.trim()
          : "",
      author: "",
      coverUrl: normalizeVideoBriefAssetUrl(
        typeof response.data?.image === "string" ? response.data.image : "",
      ),
      durationSeconds: Number.isFinite(Number(video?.totalLength))
        ? Math.max(0, Number(video.totalLength))
        : 0,
      media: {
        kind: "hls",
        url: resolvePublicUrl(hlsUrl, VIDEO_API),
        headers: getMediaHeaders(),
      },
    };
  },
};
