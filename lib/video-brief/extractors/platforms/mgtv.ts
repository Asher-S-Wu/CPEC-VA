import { randomUUID } from "crypto";
import { normalizeVideoBriefAssetUrl } from "@/lib/video-brief/urls";
import { matchesAnyDomain } from "@/lib/video-brief/extractors/domains";
import { VideoSourceError } from "@/lib/video-brief/extractors/errors";
import { getJsonHeaders, getMediaHeaders } from "@/lib/video-brief/extractors/headers";
import { resolvePublicUrl } from "@/lib/video-brief/extractors/html";
import { fetchPublicJson } from "@/lib/video-brief/extractors/http";
import type { VideoPlatformExtractor } from "@/lib/video-brief/extractors/platform";

const API_ORIGIN = "https://pcweb.api.mgtv.com";

function getVideoId(sourceUrl: string) {
  const pathname = new URL(sourceUrl).pathname;
  const match = pathname.match(/\/[bv]\/(?:[^/]+\/)*(\d+)\.html$/i);
  if (!match?.[1]) {
    throw new VideoSourceError("无法识别芒果 TV 视频编号", 422);
  }
  return match[1];
}

function buildTk2() {
  const raw =
    `did=${randomUUID()}|pno=1030|ver=0.3.0301|clit=${Math.floor(Date.now() / 1000)}`;
  const encoded = Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return encoded.split("").reverse().join("");
}

async function readJson(url: URL | string, referer: string, signal?: AbortSignal) {
  const response = await fetchPublicJson<any>(
    url,
    { headers: getJsonHeaders(referer), signal },
    { label: "芒果 TV 接口" },
  );
  if (!response.ok) {
    throw new VideoSourceError(`芒果 TV 接口读取失败（${response.status}）`, 502);
  }
  return response.data;
}

async function readApi(url: URL | string, referer: string, signal?: AbortSignal) {
  const result = await readJson(url, referer, signal);
  if (!result?.data) {
    throw new VideoSourceError(
      result?.msg || "芒果 TV 接口没有返回可用数据",
      422,
    );
  }
  return result.data;
}

function pickStream(streamData: any) {
  const streamDomain = Array.isArray(streamData?.stream_domain)
    ? streamData.stream_domain.find((item: any) => typeof item === "string" && item)
    : "";
  const qualityRank: Record<string, number> = {
    "标清": 1,
    "高清": 2,
    "超清": 3,
    "蓝光": 4,
  };
  const streams = (Array.isArray(streamData?.stream) ? streamData.stream : [])
    .filter((stream: any) => stream?.url)
    .sort((left: any, right: any) => {
      const leftRank =
        qualityRank[String(left?.name || left?.standardName || left?.barName || "")] || 99;
      const rightRank =
        qualityRank[String(right?.name || right?.standardName || right?.barName || "")] || 99;
      return leftRank - rightRank;
    });
  if (!streams[0]?.url || !streamDomain) {
    throw new VideoSourceError("芒果 TV 没有返回可分析的视频流", 422);
  }
  return resolvePublicUrl(streams[0].url, streamDomain);
}

export const mgtvExtractor: VideoPlatformExtractor = {
  id: "mgtv",
  name: "芒果TV",
  match(url) {
    return matchesAnyDomain(url, ["mgtv.com"]);
  },
  async extract({ sourceUrl, signal }) {
    const videoId = getVideoId(sourceUrl);
    const tk2 = buildTk2();

    const videoApi = new URL("/player/video", API_ORIGIN);
    videoApi.searchParams.set("tk2", tk2);
    videoApi.searchParams.set("video_id", videoId);
    videoApi.searchParams.set("type", "pch5");
    const videoData = await readApi(videoApi, sourceUrl, signal);

    const sourceApi = new URL("/player/getSource", API_ORIGIN);
    sourceApi.searchParams.set("tk2", tk2);
    sourceApi.searchParams.set("pm2", String(videoData?.atc?.pm2 || ""));
    sourceApi.searchParams.set("video_id", videoId);
    sourceApi.searchParams.set("type", "pch5");
    sourceApi.searchParams.set("src", "intelmgtv");
    const streamData = await readApi(sourceApi, sourceUrl, signal);

    const formatApiUrl = pickStream(streamData);
    const formatData = await readJson(formatApiUrl, sourceUrl, signal);
    const videoUrl = typeof formatData?.info === "string" ? formatData.info : "";
    if (!videoUrl) {
      throw new VideoSourceError("芒果 TV 视频流地址为空", 422);
    }

    const info = videoData?.info || {};
    return {
      sourceUrl,
      canonicalUrl: sourceUrl,
      platformId: "mgtv",
      platform: "芒果TV",
      title: typeof info.title === "string" ? info.title.trim() : "",
      author: "",
      coverUrl: normalizeVideoBriefAssetUrl(
        typeof info.thumb === "string" ? info.thumb : "",
      ),
      durationSeconds: Number.isFinite(Number(info.duration))
        ? Math.max(0, Number(info.duration))
        : 0,
      media: {
        kind: "hls",
        url: resolvePublicUrl(videoUrl, formatApiUrl),
        headers: getMediaHeaders(sourceUrl),
      },
    };
  },
};
