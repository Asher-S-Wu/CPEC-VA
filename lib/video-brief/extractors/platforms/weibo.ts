import { normalizeVideoBriefAssetUrl } from "@/lib/video-brief/urls";
import { matchesAnyDomain } from "@/lib/video-brief/extractors/domains";
import { VideoSourceError } from "@/lib/video-brief/extractors/errors";
import {
  getJsonHeaders,
  getMediaHeaders,
  getPageHeaders,
} from "@/lib/video-brief/extractors/headers";
import {
  buildCookieHeader,
  fetchPublicJson,
  fetchPublicResource,
  fetchPublicText,
  getSetCookieHeaders,
  MAX_REMOTE_VIDEO_BYTES,
} from "@/lib/video-brief/extractors/http";
import { resolvePublicUrl } from "@/lib/video-brief/extractors/html";
import type { VideoPlatformExtractor } from "@/lib/video-brief/extractors/platform";

const WEIBO_ORIGIN = "https://weibo.com";
const PASSPORT_ORIGIN = "https://passport.weibo.com";
const VISITOR_URL = `${PASSPORT_ORIGIN}/visitor/visitor`;
const ALLOWED_COOKIE_NAMES = new Set([
  "SUB",
  "SUBP",
  "WBPSESS",
  "XSRF-TOKEN",
  "SINAGLOBAL",
  "ULV",
  "SCF",
]);

type WeiboReference =
  | { kind: "status"; id: string }
  | { kind: "tv"; fid: string };

function getWeiboReference(url: URL): WeiboReference {
  const tvPath = url.pathname.match(/^\/tv\/show\/([^/?#]+)/i)?.[1];
  const tvQuery =
    /^video\./i.test(url.hostname) && /^\/show\/?$/i.test(url.pathname)
      ? url.searchParams.get("fid")
      : "";
  const fid = tvPath || tvQuery || "";
  if (fid) {
    if (!/^\d+(?::(?:[a-f0-9]{32}|\d{16,}))$/i.test(fid)) {
      throw new VideoSourceError("无法识别微博视频编号", 422);
    }
    return { kind: "tv", fid };
  }

  const mobileId = url.pathname.match(/^\/(?:status|detail)\/([A-Za-z0-9]+)/i)?.[1];
  if (mobileId) return { kind: "status", id: mobileId };

  const segments = url.pathname.split("/").filter(Boolean);
  if (
    segments.length >= 2 &&
    /^\d+$/.test(segments[0]) &&
    /^[A-Za-z0-9]+$/.test(segments[1])
  ) {
    return { kind: "status", id: segments[1] };
  }
  throw new VideoSourceError("无法识别微博视频编号", 422);
}

function parseJsonp(text: string, label: string) {
  const match = text.trim().match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
  if (!match?.[1]) {
    throw new VideoSourceError(`${label}返回格式异常`, 502);
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    throw new VideoSourceError(`${label}返回格式异常`, 502);
  }
}

function keepWeiboCookies(values: string[]) {
  return values.filter((value) => {
    const name = value.split("=", 1)[0]?.trim();
    return Boolean(name && ALLOWED_COOKIE_NAMES.has(name));
  });
}

async function getVisitorEntry(entryUrl: string, signal?: AbortSignal) {
  const response = await fetchPublicResource(
    entryUrl,
    {
      headers: getPageHeaders(`${WEIBO_ORIGIN}/`),
      signal,
    },
    {
      maxBytes: 0,
      readBody: false,
      label: "微博游客入口",
    },
  );
  if (!response.ok) {
    throw new VideoSourceError(
      `微博游客入口读取失败（${response.status}）`,
      502,
    );
  }
  const finalUrl = new URL(response.url);
  if (
    finalUrl.origin !== PASSPORT_ORIGIN ||
    finalUrl.pathname !== "/visitor/visitor"
  ) {
    throw new VideoSourceError("微博没有返回可用的游客入口", 502);
  }
  return {
    visitorReferer: finalUrl.toString(),
    cookies: keepWeiboCookies(
      getSetCookieHeaders(response, [
        new URL(entryUrl).origin,
        WEIBO_ORIGIN,
        PASSPORT_ORIGIN,
      ]),
    ),
  };
}

async function createVisitorCookie(entryUrl: string, signal?: AbortSignal) {
  const visitorEntry = await getVisitorEntry(entryUrl, signal);
  const visitorReferer = visitorEntry.visitorReferer;
  const entryCookieHeader = buildCookieHeader(visitorEntry.cookies);
  const fingerprint = JSON.stringify({
    os: "1",
    browser: "Chrome149,0,0,0",
    fonts: "undefined",
    screenInfo: "1920*1080*24",
    plugins: "",
  });
  const form = new URLSearchParams({
    cb: "gen_callback",
    fp: fingerprint,
  });
  const first = await fetchPublicText(
    `${PASSPORT_ORIGIN}/visitor/genvisitor`,
    {
      method: "POST",
      headers: {
        ...getJsonHeaders(visitorReferer, PASSPORT_ORIGIN),
        ...(entryCookieHeader ? { Cookie: entryCookieHeader } : {}),
      },
      body: form,
      signal,
    },
    { label: "微博游客凭证" },
  );
  if (!first.ok) {
    throw new VideoSourceError(
      `微博游客凭证读取失败（${first.status}）`,
      502,
    );
  }
  const visitor = parseJsonp(first.text, "微博游客凭证")?.data;
  const tid = typeof visitor?.tid === "string" ? visitor.tid : "";
  if (!tid) {
    throw new VideoSourceError("微博游客凭证为空", 502);
  }

  const firstCookies = [
    ...visitorEntry.cookies,
    ...keepWeiboCookies(getSetCookieHeaders(first, [PASSPORT_ORIGIN])),
  ];
  const incarnationUrl = new URL(VISITOR_URL);
  incarnationUrl.searchParams.set("a", "incarnate");
  incarnationUrl.searchParams.set("t", tid);
  incarnationUrl.searchParams.set("w", visitor?.new_tid ? "3" : "2");
  incarnationUrl.searchParams.set(
    "c",
    String(Number(visitor?.confidence) || 100).padStart(3, "0"),
  );
  incarnationUrl.searchParams.set("gc", "");
  incarnationUrl.searchParams.set("cb", "cross_domain");
  incarnationUrl.searchParams.set("from", "weibo");
  incarnationUrl.searchParams.set("_rand", String(Math.random()));
  const firstCookieHeader = buildCookieHeader(firstCookies);
  const second = await fetchPublicText(
    incarnationUrl,
    {
      headers: {
        ...getJsonHeaders(VISITOR_URL, PASSPORT_ORIGIN),
        Referer: visitorReferer,
        ...(firstCookieHeader ? { Cookie: firstCookieHeader } : {}),
      },
      signal,
    },
    { label: "微博游客凭证" },
  );
  if (!second.ok) {
    throw new VideoSourceError(
      `微博游客凭证确认失败（${second.status}）`,
      502,
    );
  }

  const cookieHeader = buildCookieHeader([
    ...firstCookies,
    ...keepWeiboCookies(getSetCookieHeaders(second, [PASSPORT_ORIGIN])),
  ]);
  if (!cookieHeader) {
    throw new VideoSourceError("微博没有下发可用的游客凭证", 502);
  }
  return cookieHeader;
}

function getWeiboHeaders(cookie: string, referer = `${WEIBO_ORIGIN}/`) {
  return {
    ...getJsonHeaders(referer, WEIBO_ORIGIN),
    Cookie: cookie,
  };
}

async function resolveTvStatusId(
  fid: string,
  cookie: string,
  sourceUrl: string,
  signal?: AbortSignal,
) {
  const endpoint = new URL("/tv/api/component", WEIBO_ORIGIN);
  endpoint.searchParams.set("page", `/tv/show/${fid}`);
  const body = new URLSearchParams({
    data: JSON.stringify({
      Component_Play_Playinfo: { oid: fid },
    }),
  });
  const response = await fetchPublicJson<any>(
    endpoint,
    {
      method: "POST",
      headers: getWeiboHeaders(cookie, sourceUrl),
      body,
      signal,
    },
    { label: "微博视频页接口" },
  );
  if (!response.ok) {
    throw new VideoSourceError(
      `微博视频页接口读取失败（${response.status}）`,
      502,
    );
  }
  const mid = response.data?.data?.Component_Play_Playinfo?.mid;
  if (typeof mid !== "string" && typeof mid !== "number") {
    throw new VideoSourceError("微博视频页没有返回对应的微博编号", 422);
  }
  return String(mid);
}

async function fetchStatus(
  statusId: string,
  cookie: string,
  signal?: AbortSignal,
) {
  const endpoint = new URL("/ajax/statuses/show", WEIBO_ORIGIN);
  endpoint.searchParams.set("id", statusId);
  const response = await fetchPublicJson<any>(
    endpoint,
    {
      headers: getWeiboHeaders(cookie),
      signal,
    },
    { label: "微博视频接口" },
  );
  if (!response.ok) {
    throw new VideoSourceError(
      `微博视频接口读取失败（${response.status}）`,
      502,
    );
  }
  if (Number(response.data?.ok) === -100) {
    throw new VideoSourceError("微博游客凭证未生效，请稍后再试", 502);
  }
  if (
    !response.data?.id &&
    !response.data?.idstr &&
    !response.data?.id_str &&
    !response.data?.mid
  ) {
    throw new VideoSourceError("微博没有返回可用的视频详情", 422);
  }
  return response.data;
}

function getMediaInfo(status: any) {
  const mixItems = Array.isArray(status?.mix_media_info?.items)
    ? status.mix_media_info.items.filter(
        (item: any) =>
          String(item?.type || "").toLowerCase() !== "pic" &&
          item?.data?.media_info,
      )
    : [];
  if (mixItems.length > 1) {
    throw new VideoSourceError(
      "该微博包含多个视频，当前只能处理单个视频的微博",
      422,
    );
  }
  if (mixItems.length === 1) return mixItems[0].data.media_info;
  const mediaInfo = status?.page_info?.media_info;
  if (!mediaInfo) {
    throw new VideoSourceError("这条微博不包含可分析的视频", 422);
  }
  return mediaInfo;
}

function pickPlayback(mediaInfo: any) {
  const candidates = (Array.isArray(mediaInfo?.playback_list)
    ? mediaInfo.playback_list
    : []
  )
    .map((entry: any, index: number) => {
      const info = entry?.play_info || {};
      const codec = String(info?.video_codecs || "");
      const audioCodec = String(info?.audio_codecs || "");
      const size = Number(info?.size) || 0;
      return {
        info,
        index,
        compatibility:
          /(?:avc|h\.?264)/i.test(codec) &&
          /(?:aac|mp4a)/i.test(audioCodec)
            ? 2
            : 1,
        pixels: (Number(info?.width) || 0) * (Number(info?.height) || 0),
        bitrate: Number(info?.bitrate) || 0,
        size,
      };
    })
    .filter(
      (item) =>
        typeof item.info?.url === "string" &&
        item.info.url &&
        /^video\//i.test(String(item.info?.mime || "")) &&
        (item.size === 0 || item.size <= MAX_REMOTE_VIDEO_BYTES),
    )
    .sort((left, right) => {
      if (left.compatibility !== right.compatibility) {
        return right.compatibility - left.compatibility;
      }
      if (left.pixels !== right.pixels) return right.pixels - left.pixels;
      if (left.bitrate !== right.bitrate) return right.bitrate - left.bitrate;
      if (left.size !== right.size) return right.size - left.size;
      return left.index - right.index;
    });
  if (!candidates[0]) {
    throw new VideoSourceError("微博没有返回可分析的混合视频文件", 422);
  }
  return candidates[0].info;
}

function firstNonEmptyText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export const weiboExtractor: VideoPlatformExtractor = {
  id: "weibo",
  name: "微博",
  match(url) {
    if (!matchesAnyDomain(url, ["weibo.com", "weibo.cn"])) return false;
    try {
      getWeiboReference(url);
      return true;
    } catch {
      return false;
    }
  },
  async extract({ sourceUrl, url, signal }) {
    const reference = getWeiboReference(url);
    const tvPageUrl =
      reference.kind === "tv"
        ? `${WEIBO_ORIGIN}/tv/show/${reference.fid}`
        : "";
    const visitorEntryUrl =
      reference.kind === "tv"
        ? tvPageUrl
        : `${WEIBO_ORIGIN}/0/${encodeURIComponent(reference.id)}`;
    const cookie = await createVisitorCookie(visitorEntryUrl, signal);
    const statusId =
      reference.kind === "tv"
        ? await resolveTvStatusId(reference.fid, cookie, tvPageUrl, signal)
        : reference.id;
    const status = await fetchStatus(statusId, cookie, signal);
    const mediaInfo = getMediaInfo(status);
    const playback = pickPlayback(mediaInfo);
    const user = status?.user || {};
    const displayId = String(status?.mblogid || statusId);
    const userId = String(user?.idstr || user?.id_str || user?.id || "0");
    const canonicalUrl = `${WEIBO_ORIGIN}/${encodeURIComponent(
      userId,
    )}/${encodeURIComponent(displayId)}`;

    return {
      sourceUrl,
      canonicalUrl,
      platformId: "weibo",
      platform: "微博",
      title: firstNonEmptyText(
        mediaInfo?.video_title,
        mediaInfo?.kol_title,
        mediaInfo?.name,
      ),
      author:
        typeof user?.screen_name === "string" ? user.screen_name.trim() : "",
      coverUrl: normalizeVideoBriefAssetUrl(
        typeof status?.page_info?.page_pic === "string"
          ? status.page_info.page_pic
          : "",
      ),
      durationSeconds: Number.isFinite(Number(mediaInfo?.duration))
        ? Math.max(0, Number(mediaInfo.duration))
        : 0,
      media: {
        kind: "file",
        url: resolvePublicUrl(playback.url, WEIBO_ORIGIN),
        extension: "mp4",
        mimeType: "video/mp4",
        headers: getMediaHeaders(`${WEIBO_ORIGIN}/`),
      },
    };
  },
};
