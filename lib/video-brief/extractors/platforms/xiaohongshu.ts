import { normalizeVideoBriefAssetUrl } from "@/lib/video-brief/urls";
import { matchesAnyDomain } from "@/lib/video-brief/extractors/domains";
import { VideoSourceError } from "@/lib/video-brief/extractors/errors";
import { getMediaHeaders, getPageHeaders } from "@/lib/video-brief/extractors/headers";
import {
  extractAssignedJson,
  getMetaContent,
  resolvePublicUrl,
} from "@/lib/video-brief/extractors/html";
import {
  fetchPublicText,
  MAX_REMOTE_VIDEO_BYTES,
} from "@/lib/video-brief/extractors/http";
import type { VideoPlatformExtractor } from "@/lib/video-brief/extractors/platform";

function getNoteId(url: URL) {
  const match = url.pathname.match(/\/(?:explore|discovery\/item)\/([0-9a-f]+)/i);
  if (!match?.[1]) {
    throw new VideoSourceError("无法识别小红书视频编号", 422);
  }
  return match[1];
}

function collectStreamItems(value: any, output: any[] = [], path = "") {
  if (Array.isArray(value)) {
    for (const item of value) collectStreamItems(item, output, path);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  if (typeof value.masterUrl === "string" && value.masterUrl) {
    output.push({ ...value, streamPath: path });
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    collectStreamItems(child, output, path ? `${path}.${key}` : key);
  }
  return output;
}

function pickStream(note: any) {
  const streams = collectStreamItems(note?.video?.media?.stream)
    .map((stream) => ({
      ...stream,
      compatibility: /(?:h264|avc)/i.test(
        [
          stream?.videoCodec,
          stream?.codec,
          stream?.codecType,
          stream?.streamPath,
        ].join(" "),
      )
        ? 1
        : 0,
      size: Number(stream?.size) || 0,
      pixels:
        (Number(stream?.width) || 0) * (Number(stream?.height) || 0),
    }))
    .filter(
      (stream) =>
        (stream.size === 0 || stream.size <= MAX_REMOTE_VIDEO_BYTES),
    )
    .sort((left, right) => {
      if (left.compatibility !== right.compatibility) {
        return right.compatibility - left.compatibility;
      }
      if (left.pixels !== right.pixels) return right.pixels - left.pixels;
      return (
        (Number(right?.avgBitrate) || 0) -
        (Number(left?.avgBitrate) || 0)
      );
    });
  if (!streams[0]?.masterUrl) {
    throw new VideoSourceError("小红书没有返回可分析的视频流", 422);
  }
  return streams[0];
}

function getCover(note: any) {
  const image = Array.isArray(note?.imageList) ? note.imageList[0] : null;
  return normalizeVideoBriefAssetUrl(
    String(image?.urlDefault || image?.urlPre || note?.cover?.urlDefault || ""),
  );
}

export const xiaohongshuExtractor: VideoPlatformExtractor = {
  id: "xiaohongshu",
  name: "小红书",
  match(url) {
    if (
      matchesAnyDomain(url, ["xiaohongshu.com"]) &&
      /^\/(?:explore|discovery\/item)\/[0-9a-f]+(?:\/|$)/i.test(url.pathname)
    ) {
      return true;
    }
    return (
      matchesAnyDomain(url, ["xhslink.com"]) &&
      url.pathname !== "/"
    );
  },
  async extract({ sourceUrl, signal }) {
    const page = await fetchPublicText(
      sourceUrl,
      { headers: getPageHeaders("https://www.xiaohongshu.com/"), signal },
      { label: "小红书视频页面" },
    );
    if (!page.ok) {
      throw new VideoSourceError(`小红书视频页面读取失败（${page.status}）`, 502);
    }

    const canonicalUrl = page.url;
    const noteId = getNoteId(new URL(canonicalUrl));
    const state = extractAssignedJson(
      page.text,
      "window.__INITIAL_STATE__",
      "小红书视频信息",
    );
    const note = state?.note?.noteDetailMap?.[noteId]?.note;
    if (!note) {
      throw new VideoSourceError("小红书没有返回视频详情", 422);
    }

    const stream = pickStream(note);
    const durationMilliseconds = Number(stream?.duration);
    return {
      sourceUrl,
      canonicalUrl,
      platformId: "xiaohongshu",
      platform: "小红书",
      title: getMetaContent(page.text, ["og:title"]),
      author:
        typeof note?.user?.nickname === "string" ? note.user.nickname.trim() : "",
      coverUrl: getCover(note),
      durationSeconds: Number.isFinite(durationMilliseconds)
        ? Math.max(0, durationMilliseconds / 1000)
        : 0,
      media: {
        kind: "file",
        url: resolvePublicUrl(stream.masterUrl, canonicalUrl),
        extension: "mp4",
        headers: getMediaHeaders(),
      },
    };
  },
};
