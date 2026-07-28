import { normalizeVideoBriefAssetUrl } from "@/lib/video-brief/urls";
import { VideoSourceError } from "@/lib/video-brief/extractors/errors";
import { getJsonHeaders, getMediaHeaders } from "@/lib/video-brief/extractors/headers";
import { resolvePublicUrl } from "@/lib/video-brief/extractors/html";
import {
  fetchPublicJson,
  MAX_REMOTE_VIDEO_BYTES,
} from "@/lib/video-brief/extractors/http";
import type { VideoPlatformExtractor } from "@/lib/video-brief/extractors/platform";

const FEDERATED_VIDEO_ID =
  "(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{22})";
const PATH_PATTERN = new RegExp(
  `^/(?:videos/(?:watch|embed)|w)/(${FEDERATED_VIDEO_ID})(?:/|$)|^/api/v1/videos/(${FEDERATED_VIDEO_ID}|\\d+)(?:/|$)`,
  "i",
);

function getVideoId(url: URL) {
  const match = url.pathname.match(PATH_PATTERN);
  const id = match?.[1] || match?.[2];
  if (!id) {
    throw new VideoSourceError("无法识别 PeerTube 视频编号", 422);
  }
  return id;
}

function isMixedMp4(file: any) {
  const url = String(file?.fileUrl || file?.fileDownloadUrl || "");
  return (
    file?.hasAudio === true &&
    file?.hasVideo === true &&
    /\.mp4(?:$|[?#])/i.test(url)
  );
}

function getResolution(file: any) {
  return (
    Number(file?.resolution?.id) ||
    Number(file?.height) ||
    Number(String(file?.resolution?.label || "").match(/\d+/)?.[0]) ||
    0
  );
}

function pickFile(data: any) {
  const playlistFiles = (Array.isArray(data?.streamingPlaylists)
    ? data.streamingPlaylists
    : []
  ).flatMap((playlist: any) =>
    Array.isArray(playlist?.files) ? playlist.files : [],
  );
  const candidates = [
    ...(Array.isArray(data?.files) ? data.files : []),
    ...playlistFiles,
  ]
    .filter(isMixedMp4)
    .filter((file: any) => {
      const height = getResolution(file);
      const size = Number(file?.size);
      return (
        (height === 0 || height <= 720) &&
        (!Number.isFinite(size) || size <= 0 || size <= MAX_REMOTE_VIDEO_BYTES)
      );
    })
    .sort((left: any, right: any) => {
      const resolutionDifference = getResolution(right) - getResolution(left);
      if (resolutionDifference !== 0) return resolutionDifference;
      const fpsDifference = (Number(right?.fps) || 0) - (Number(left?.fps) || 0);
      if (fpsDifference !== 0) return fpsDifference;
      return (Number(left?.size) || 0) - (Number(right?.size) || 0);
    });
  return candidates[0] || null;
}

function pickHlsPlaylist(data: any) {
  const playlists = Array.isArray(data?.streamingPlaylists)
    ? data.streamingPlaylists
    : [];
  return (
    playlists.find(
      (playlist: any) =>
        Number(playlist?.type) === 1 &&
        typeof playlist?.playlistUrl === "string" &&
        playlist.playlistUrl,
    ) || null
  );
}

function getThumbnail(data: any, pageUrl: string) {
  const thumbnails = (Array.isArray(data?.thumbnails) ? data.thumbnails : [])
    .filter((item: any) => typeof item?.fileUrl === "string" && item.fileUrl)
    .sort(
      (left: any, right: any) =>
        (Number(right?.width) || 0) - (Number(left?.width) || 0),
    );
  return thumbnails[0]?.fileUrl
    ? normalizeVideoBriefAssetUrl(
        resolvePublicUrl(thumbnails[0].fileUrl, pageUrl),
      )
    : "";
}

export const peerTubeExtractor: VideoPlatformExtractor = {
  id: "peertube",
  name: "PeerTube",
  match(url) {
    return PATH_PATTERN.test(url.pathname);
  },
  async extract({ sourceUrl, url, signal }) {
    const videoId = getVideoId(url);
    const apiUrl = new URL(`/api/v1/videos/${encodeURIComponent(videoId)}`, url.origin);
    const response = await fetchPublicJson<any>(
      apiUrl,
      { headers: getJsonHeaders(), signal },
      { label: "PeerTube 视频接口" },
    );
    if (!response.ok) {
      throw new VideoSourceError(
        `PeerTube 视频接口读取失败（${response.status}）`,
        response.status === 404 ? 422 : 502,
      );
    }
    const data = response.data;
    if (!data?.uuid || typeof data?.name !== "string") {
      throw new VideoSourceError("该地址不是可识别的 PeerTube 视频", 422);
    }
    if (data?.isLive === true && Number(data?.duration) <= 0) {
      throw new VideoSourceError("暂不支持正在直播的 PeerTube 视频", 422);
    }

    const canonicalUrl = new URL(`/w/${data.shortUUID || data.uuid}`, url.origin).toString();
    const directFile = pickFile(data);
    const hlsPlaylist = pickHlsPlaylist(data);
    if (!directFile && !hlsPlaylist) {
      throw new VideoSourceError(
        "PeerTube 没有返回 720P 以内的公开混合视频流",
        422,
      );
    }

    const account = data?.account || {};
    return {
      sourceUrl,
      canonicalUrl,
      platformId: "peertube",
      platform: "PeerTube",
      title: data.name.trim(),
      author:
        typeof account?.displayName === "string" && account.displayName.trim()
          ? account.displayName.trim()
          : typeof account?.name === "string"
            ? account.name.trim()
            : "",
      coverUrl: getThumbnail(data, canonicalUrl),
      durationSeconds: Number.isFinite(Number(data?.duration))
        ? Math.max(0, Number(data.duration))
        : 0,
      media: directFile
        ? {
            kind: "file",
            url: resolvePublicUrl(
              directFile.fileUrl || directFile.fileDownloadUrl,
              canonicalUrl,
            ),
            extension: "mp4",
            mimeType: "video/mp4",
            headers: getMediaHeaders(),
          }
        : {
            kind: "hls",
            url: resolvePublicUrl(hlsPlaylist.playlistUrl, canonicalUrl),
            headers: getMediaHeaders(),
          },
    };
  },
};
