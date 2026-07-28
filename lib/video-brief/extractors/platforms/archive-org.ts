import { normalizeVideoBriefAssetUrl } from "@/lib/video-brief/urls";
import { matchesAnyDomain } from "@/lib/video-brief/extractors/domains";
import { VideoSourceError } from "@/lib/video-brief/extractors/errors";
import { getJsonHeaders, getMediaHeaders, getPageHeaders } from "@/lib/video-brief/extractors/headers";
import {
  collectTags,
  parseAttributes,
  parseDurationSeconds,
  resolvePublicUrl,
} from "@/lib/video-brief/extractors/html";
import {
  fetchPublicJson,
  fetchPublicText,
  MAX_REMOTE_VIDEO_BYTES,
} from "@/lib/video-brief/extractors/http";
import type { VideoPlatformExtractor } from "@/lib/video-brief/extractors/platform";

const ARCHIVE_ORIGIN = "https://archive.org";

function decodePathValue(value: string) {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    throw new VideoSourceError("互联网档案馆视频文件名格式不正确", 400);
  }
}

function getArchiveRef(url: URL) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (!["details", "embed"].includes(parts[0]) || !parts[1]) {
    throw new VideoSourceError("无法识别互联网档案馆条目标识", 422);
  }
  return {
    identifier: decodePathValue(parts[1]),
    entryName:
      parts.length > 2 ? decodePathValue(parts.slice(2).join("/")) : "",
  };
}

function firstText(value: unknown) {
  if (Array.isArray(value)) {
    return value.find((item) => typeof item === "string" && item.trim())?.trim() || "";
  }
  return typeof value === "string" ? value.trim() : "";
}

function extractPlayerEntries(html: string) {
  const tag = collectTags(html, "play-av")[0];
  if (!tag) {
    throw new VideoSourceError("互联网档案馆没有返回视频播放清单", 422);
  }
  const playlist = parseAttributes(tag).playlist;
  if (!playlist) {
    throw new VideoSourceError("互联网档案馆视频播放清单为空", 422);
  }
  try {
    const entries = JSON.parse(playlist);
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error("empty");
    }
    return entries;
  } catch {
    throw new VideoSourceError("互联网档案馆视频播放清单格式异常", 502);
  }
}

function selectEntry(entries: any[], requestedName: string) {
  if (requestedName) {
    const selected = entries.find(
      (entry) => String(entry?.orig || "") === requestedName,
    );
    if (!selected) {
      throw new VideoSourceError("互联网档案馆条目中没有这个视频文件", 422);
    }
    return selected;
  }
  if (entries.length !== 1) {
    throw new VideoSourceError(
      "该互联网档案馆条目包含多个视频，请使用具体视频文件页面",
      422,
    );
  }
  return entries[0];
}

function getDownloadName(value: string, identifier: string) {
  const url = new URL(value, ARCHIVE_ORIGIN);
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    parts[0] !== "download" ||
    !parts[1] ||
    decodePathValue(parts[1]) !== identifier ||
    parts.length < 3
  ) {
    return "";
  }
  return decodePathValue(parts.slice(2).join("/"));
}

function isPrivateFile(file: any) {
  return (
    file?.private === true ||
    ["true", "1", "yes"].includes(String(file?.private || "").toLowerCase())
  );
}

function selectMp4Source(entry: any, files: any[], identifier: string) {
  const fileByName = new Map(
    files
      .filter((file: any) => typeof file?.name === "string")
      .map((file: any) => [String(file.name), file]),
  );
  const candidates = (Array.isArray(entry?.sources) ? entry.sources : [])
    .filter(
      (source: any) =>
        String(source?.type || "").toLowerCase() === "mp4" &&
        typeof source?.file === "string" &&
        source.file,
    )
    .map((source: any, index: number) => {
      const url = resolvePublicUrl(source.file, ARCHIVE_ORIGIN);
      const file = fileByName.get(getDownloadName(url, identifier));
      return {
        source,
        file,
        url,
        index,
        height: Number(source?.height || file?.height) || 0,
        size: Number(file?.size) || 0,
      };
    })
    .filter(
      (item) =>
        Boolean(item.file) &&
        !isPrivateFile(item.file) &&
        (item.height === 0 || item.height <= 720) &&
        (item.size === 0 || item.size <= MAX_REMOTE_VIDEO_BYTES),
    )
    .sort((left, right) => {
      const heightDifference = right.height - left.height;
      if (heightDifference !== 0) return heightDifference;
      const sizeDifference = left.size - right.size;
      if (sizeDifference !== 0) return sizeDifference;
      return left.index - right.index;
    });
  if (!candidates[0]) {
    throw new VideoSourceError(
      "互联网档案馆没有返回 720P 以内的公开 MP4 视频",
      422,
    );
  }
  return candidates[0];
}

export const archiveOrgExtractor: VideoPlatformExtractor = {
  id: "internet-archive",
  name: "互联网档案馆",
  match(url) {
    return (
      matchesAnyDomain(url, ["archive.org"]) &&
      /^\/(?:details|embed)\//i.test(url.pathname)
    );
  },
  async extract({ sourceUrl, url, signal }) {
    const ref = getArchiveRef(url);
    const identifierPath = encodeURIComponent(ref.identifier);
    const metadataUrl = `${ARCHIVE_ORIGIN}/metadata/${identifierPath}`;
    const embedUrl = `${ARCHIVE_ORIGIN}/embed/${identifierPath}`;
    const [metadataResponse, embedResponse] = await Promise.all([
      fetchPublicJson<any>(
        metadataUrl,
        { headers: getJsonHeaders(ARCHIVE_ORIGIN), signal },
        { label: "互联网档案馆元数据" },
      ),
      fetchPublicText(
        embedUrl,
        { headers: getPageHeaders(ARCHIVE_ORIGIN), signal },
        { label: "互联网档案馆播放页面" },
      ),
    ]);
    if (!metadataResponse.ok) {
      throw new VideoSourceError(
        `互联网档案馆元数据读取失败（${metadataResponse.status}）`,
        metadataResponse.status === 404 ? 422 : 502,
      );
    }
    if (!embedResponse.ok) {
      throw new VideoSourceError(
        `互联网档案馆播放页面读取失败（${embedResponse.status}）`,
        embedResponse.status === 404 ? 422 : 502,
      );
    }

    const metadata = metadataResponse.data?.metadata || {};
    const files = Array.isArray(metadataResponse.data?.files)
      ? metadataResponse.data.files
      : [];
    const entry = selectEntry(
      extractPlayerEntries(embedResponse.text),
      ref.entryName,
    );
    const selected = selectMp4Source(entry, files, ref.identifier);
    const canonicalUrl = `${ARCHIVE_ORIGIN}/details/${identifierPath}${
      ref.entryName
        ? `/${ref.entryName
            .split("/")
            .map((part) => encodeURIComponent(part))
            .join("/")}`
        : ""
    }`;
    const preciseDuration = parseDurationSeconds(selected.file?.length);

    return {
      sourceUrl,
      canonicalUrl,
      platformId: "internet-archive",
      platform: "互联网档案馆",
      title:
        ref.entryName && firstText(entry?.title)
          ? firstText(entry.title)
          : firstText(metadata?.title),
      author: firstText(metadata?.creator),
      coverUrl: normalizeVideoBriefAssetUrl(
        entry?.image
          ? resolvePublicUrl(String(entry.image), ARCHIVE_ORIGIN)
          : "",
      ),
      durationSeconds:
        preciseDuration > 0
          ? preciseDuration
          : parseDurationSeconds(entry?.duration),
      media: {
        kind: "file",
        url: selected.url,
        extension: "mp4",
        mimeType: "video/mp4",
        headers: getMediaHeaders(),
      },
    };
  },
};
