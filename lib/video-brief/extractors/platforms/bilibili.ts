import { normalizeVideoBriefAssetUrl } from "@/lib/video-brief/urls";
import { matchesAnyDomain } from "@/lib/video-brief/extractors/domains";
import { VideoSourceError } from "@/lib/video-brief/extractors/errors";
import { getJsonHeaders, getMediaHeaders } from "@/lib/video-brief/extractors/headers";
import {
  assertPublicHttpUrl,
  fetchPublicJson,
  fetchPublicText,
} from "@/lib/video-brief/extractors/http";
import type { VideoPlatformExtractor } from "@/lib/video-brief/extractors/platform";

const API_ORIGIN = "https://api.bilibili.com";
const WEB_ORIGIN = "https://www.bilibili.com";
const BVID_RE = /(BV[0-9A-Za-z]+)/i;
const DOMAINS = ["bilibili.com", "b23.tv"];

function getBvid(value: string) {
  return String(value || "").match(BVID_RE)?.[1] || "";
}

function getPageNumber(value: string) {
  try {
    const page = Number(new URL(value).searchParams.get("p"));
    return Number.isInteger(page) && page > 0 ? page : 1;
  } catch {
    return 1;
  }
}

async function resolveVideoRef(sourceUrl: string, signal?: AbortSignal) {
  const directBvid = getBvid(new URL(sourceUrl).pathname);
  if (directBvid) {
    return {
      bvid: directBvid,
      pageNumber: getPageNumber(sourceUrl),
      pageUrl: sourceUrl,
    };
  }

  const page = await fetchPublicText(
    sourceUrl,
    { headers: getJsonHeaders(sourceUrl, WEB_ORIGIN), signal },
    { label: "B 站短链接" },
  );
  if (!page.ok) {
    throw new VideoSourceError(`B 站短链接解析失败（${page.status}）`, 502);
  }

  const redirectedBvid = getBvid(new URL(page.url).pathname);
  const bvid = redirectedBvid || getBvid(page.text);
  if (!bvid) {
    throw new VideoSourceError("无法识别 B 站视频编号", 422);
  }
  return {
    bvid,
    pageNumber: getPageNumber(page.url),
    pageUrl: page.url,
  };
}

async function readApi(url: URL, referer: string, signal?: AbortSignal) {
  const response = await fetchPublicJson<any>(
    url,
    { headers: getJsonHeaders(referer, WEB_ORIGIN), signal },
    { label: "B 站接口" },
  );
  if (!response.ok) {
    throw new VideoSourceError(`B 站接口读取失败（${response.status}）`, 502);
  }
  if (response.data?.code !== 0) {
    throw new VideoSourceError(
      response.data?.message || "B 站接口没有返回可用数据",
      422,
    );
  }
  return response.data?.data;
}

function pickPage(viewData: any, pageNumber: number) {
  const pages = Array.isArray(viewData?.pages) ? viewData.pages : [];
  const page = pages.length > 0
    ? pages.find((item: any) => Number(item?.page) === pageNumber)
    : viewData;
  if (!page) {
    throw new VideoSourceError(`B 站视频没有第 ${pageNumber} 个分 P`, 422);
  }
  const cid = Number(page?.cid);
  if (!Number.isFinite(cid) || cid <= 0) {
    throw new VideoSourceError("B 站视频缺少可播放分集信息", 422);
  }
  return {
    cid,
    part: typeof page?.part === "string" ? page.part.trim() : "",
    durationSeconds: Number.isFinite(Number(page?.duration))
      ? Math.max(0, Number(page.duration))
      : 0,
  };
}

function pickMediaUrl(playData: any) {
  const items = Array.isArray(playData?.durl)
    ? playData.durl.filter((entry: any) => entry?.url)
    : [];
  if (items.length > 1) {
    throw new VideoSourceError(
      "该 B 站视频由多个分段文件组成，当前无法完整处理",
      422,
    );
  }
  const url = String(items[0]?.url || "");
  if (!url) {
    throw new VideoSourceError("B 站没有返回可分析的视频流", 422);
  }
  return assertPublicHttpUrl(url).toString();
}

export const bilibiliExtractor: VideoPlatformExtractor = {
  id: "bilibili",
  name: "哔哩哔哩",
  match(url) {
    return matchesAnyDomain(url, DOMAINS);
  },
  async extract({ sourceUrl, signal }) {
    const ref = await resolveVideoRef(sourceUrl, signal);
    const viewApi = new URL("/x/web-interface/view", API_ORIGIN);
    viewApi.searchParams.set("bvid", ref.bvid);
    const viewData = await readApi(viewApi, ref.pageUrl, signal);
    const page = pickPage(viewData, ref.pageNumber);
    const canonicalUrl = ref.pageNumber > 1
      ? `${WEB_ORIGIN}/video/${ref.bvid}?p=${ref.pageNumber}`
      : `${WEB_ORIGIN}/video/${ref.bvid}`;

    const playApi = new URL("/x/player/playurl", API_ORIGIN);
    playApi.searchParams.set("bvid", ref.bvid);
    playApi.searchParams.set("cid", String(page.cid));
    playApi.searchParams.set("qn", "32");
    playApi.searchParams.set("fnval", "0");
    playApi.searchParams.set("fnver", "0");
    playApi.searchParams.set("fourk", "0");
    playApi.searchParams.set("platform", "html5");
    const playData = await readApi(playApi, canonicalUrl, signal);

    const title = [viewData?.title, page.part]
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
      .filter((item, index, list) => list.indexOf(item) === index)
      .join(" - ");

    return {
      sourceUrl,
      canonicalUrl,
      platformId: "bilibili",
      platform: "哔哩哔哩",
      title,
      author: typeof viewData?.owner?.name === "string" ? viewData.owner.name.trim() : "",
      coverUrl: normalizeVideoBriefAssetUrl(
        typeof viewData?.pic === "string" ? viewData.pic : "",
      ),
      durationSeconds: page.durationSeconds,
      media: {
        kind: "file",
        url: pickMediaUrl(playData),
        extension: "mp4",
        headers: getMediaHeaders(canonicalUrl),
      },
    };
  },
};
