import { normalizeVideoBriefAssetUrl } from "@/lib/video-brief/urls";
import { matchesAnyDomain } from "@/lib/video-brief/extractors/domains";
import { VideoSourceError } from "@/lib/video-brief/extractors/errors";
import { getMediaHeaders, getPageHeaders } from "@/lib/video-brief/extractors/headers";
import { extractAssignedJson, resolvePublicUrl } from "@/lib/video-brief/extractors/html";
import { fetchPublicText } from "@/lib/video-brief/extractors/http";
import type { VideoPlatformExtractor } from "@/lib/video-brief/extractors/platform";

const WEB_ORIGIN = "https://www.acfun.cn";

type AcFunReference =
  | { kind: "video"; id: string; part: number }
  | { kind: "bangumi"; pageId: string; ac: string };

function getVideoReference(url: URL): AcFunReference {
  const videoMatch = url.pathname.match(/^\/v\/ac(\d+)(?:_(\d+))?/i);
  if (videoMatch?.[1]) {
    return {
      kind: "video",
      id: videoMatch[1],
      part: Number(videoMatch[2] || 1),
    };
  }
  const bangumiMatch = url.pathname.match(/^\/bangumi\/(aa[\d_]+)(?:\/|$)/i);
  if (!bangumiMatch?.[1]) {
    throw new VideoSourceError("无法识别 AcFun 视频编号", 422);
  }
  const ac = url.searchParams.get("ac") || "";
  if (ac && !/^\d+$/.test(ac)) {
    throw new VideoSourceError("AcFun 番剧特别视频编号格式不正确", 422);
  }
  return { kind: "bangumi", pageId: bangumiMatch[1], ac };
}

function pickRepresentation(playData: any) {
  const representations = Array.isArray(playData?.adaptationSet?.[0]?.representation)
    ? playData.adaptationSet[0].representation
    : [];
  const candidates = representations
    .filter((item: any) => typeof item?.url === "string" && item.url)
    .sort((left: any, right: any) => {
      const leftHeight = Number(left?.height) || 0;
      const rightHeight = Number(right?.height) || 0;
      const leftAllowed = leftHeight > 0 && leftHeight <= 720;
      const rightAllowed = rightHeight > 0 && rightHeight <= 720;
      if (leftAllowed !== rightAllowed) return leftAllowed ? -1 : 1;
      if (leftAllowed && rightAllowed && leftHeight !== rightHeight) {
        return rightHeight - leftHeight;
      }
      const leftBitrate = Number(left?.avgBitrate) || Number.MAX_SAFE_INTEGER;
      const rightBitrate = Number(right?.avgBitrate) || Number.MAX_SAFE_INTEGER;
      return leftBitrate - rightBitrate;
    });
  if (!candidates[0]?.url) {
    throw new VideoSourceError("AcFun 没有返回可分析的视频流", 422);
  }
  return candidates[0];
}

function getCoverUrl(data: any) {
  const cover = Array.isArray(data?.coverCdnUrls)
    ? data.coverCdnUrls.find((item: any) => item?.url)?.url
    : "";
  return normalizeVideoBriefAssetUrl(String(cover || data?.coverUrl || ""));
}

function getRegularVideoTitle(pageData: any, videoInfo: any) {
  const mainTitle =
    typeof pageData?.title === "string" ? pageData.title.trim() : "";
  const currentId = String(videoInfo?.id || "");
  const part = (Array.isArray(pageData?.videoList) ? pageData.videoList : [])
    .find((item: any) => String(item?.id || "") === currentId);
  const partTitle =
    typeof part?.title === "string" ? part.title.trim() : "";
  return [mainTitle, partTitle]
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index)
    .join(" - ");
}

export const acfunExtractor: VideoPlatformExtractor = {
  id: "acfun",
  name: "AcFun",
  match(url) {
    return (
      matchesAnyDomain(url, ["acfun.cn"]) &&
      /^\/(?:v\/ac\d+|bangumi\/aa[\d_]+)/i.test(url.pathname)
    );
  },
  async extract({ sourceUrl, url, signal }) {
    const videoRef = getVideoReference(url);
    const page = await fetchPublicText(
      sourceUrl,
      { headers: getPageHeaders(WEB_ORIGIN), signal },
      { label: "AcFun 视频页面" },
    );
    if (!page.ok) {
      throw new VideoSourceError(`AcFun 视频页面读取失败（${page.status}）`, 502);
    }

    const pageData = extractAssignedJson(
      page.text,
      videoRef.kind === "bangumi"
        ? "window.bangumiData"
        : "window.videoInfo",
      "AcFun 视频信息",
    );
    const videoInfo =
      videoRef.kind === "bangumi"
        ? videoRef.ac
          ? pageData?.hlVideoInfo
          : pageData?.currentVideoInfo
        : pageData?.currentVideoInfo;
    if (!videoInfo?.ksPlayJson) {
      throw new VideoSourceError("AcFun 视频缺少播放信息", 422);
    }

    let playData: any;
    try {
      playData = JSON.parse(videoInfo.ksPlayJson);
    } catch {
      throw new VideoSourceError("AcFun 播放信息格式异常", 502);
    }
    const representation = pickRepresentation(playData);
    const canonicalUrl =
      videoRef.kind === "bangumi"
        ? `${WEB_ORIGIN}/bangumi/${videoRef.pageId}${
            videoRef.ac ? `?ac=${encodeURIComponent(videoRef.ac)}` : ""
          }`
        : `${WEB_ORIGIN}/v/ac${videoRef.id}${
            videoRef.part > 1 ? `_${videoRef.part}` : ""
          }`;
    const title =
      videoRef.kind === "bangumi"
        ? videoRef.ac
          ? typeof pageData?.hlVideoInfo?.title === "string"
            ? pageData.hlVideoInfo.title.trim()
            : ""
          : typeof pageData?.showTitle === "string"
            ? pageData.showTitle.trim()
            : ""
        : getRegularVideoTitle(pageData, videoInfo);

    return {
      sourceUrl,
      canonicalUrl,
      platformId: "acfun",
      platform: "AcFun",
      title,
      author:
        videoRef.kind === "bangumi"
          ? ""
          : typeof pageData?.user?.name === "string"
            ? pageData.user.name.trim()
            : typeof pageData?.user?.userName === "string"
              ? pageData.user.userName.trim()
              : "",
      coverUrl:
        videoRef.kind === "bangumi"
          ? videoRef.ac
            ? ""
            : normalizeVideoBriefAssetUrl(
                typeof pageData?.image === "string" ? pageData.image : "",
              )
          : getCoverUrl(pageData),
      durationSeconds: Number.isFinite(Number(videoInfo?.durationMillis))
        ? Math.max(0, Number(videoInfo.durationMillis) / 1000)
        : 0,
      media: {
        kind: "hls",
        url: resolvePublicUrl(representation.url, canonicalUrl),
        headers: getMediaHeaders(`${WEB_ORIGIN}/`),
      },
    };
  },
};
