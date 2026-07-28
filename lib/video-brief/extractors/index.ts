import { assertPublicHttpUrl } from "@/lib/video-brief/extractors/http";
import type { VideoPlatformExtractor } from "@/lib/video-brief/extractors/platform";
import { acfunExtractor } from "@/lib/video-brief/extractors/platforms/acfun";
import { archiveOrgExtractor } from "@/lib/video-brief/extractors/platforms/archive-org";
import { bilibiliExtractor } from "@/lib/video-brief/extractors/platforms/bilibili";
import { cctvExtractor } from "@/lib/video-brief/extractors/platforms/cctv";
import {
  directVideoExtractor,
  genericWebVideoExtractor,
} from "@/lib/video-brief/extractors/platforms/generic";
import { mgtvExtractor } from "@/lib/video-brief/extractors/platforms/mgtv";
import { peerTubeExtractor } from "@/lib/video-brief/extractors/platforms/peertube";
import { weiboExtractor } from "@/lib/video-brief/extractors/platforms/weibo";
import { wikimediaExtractor } from "@/lib/video-brief/extractors/platforms/wikimedia";
import { xiaohongshuExtractor } from "@/lib/video-brief/extractors/platforms/xiaohongshu";
import { youkuExtractor } from "@/lib/video-brief/extractors/platforms/youku";

export { VideoSourceError } from "@/lib/video-brief/extractors/errors";

const PLATFORM_EXTRACTORS: VideoPlatformExtractor[] = [
  bilibiliExtractor,
  youkuExtractor,
  mgtvExtractor,
  acfunExtractor,
  weiboExtractor,
  xiaohongshuExtractor,
  cctvExtractor,
  archiveOrgExtractor,
  wikimediaExtractor,
  peerTubeExtractor,
  directVideoExtractor,
  genericWebVideoExtractor,
];

export async function extractVideoSource(
  inputUrl: string,
  signal?: AbortSignal,
) {
  const url = assertPublicHttpUrl(String(inputUrl || "").trim());
  const sourceUrl = url.toString();
  const extractor = PLATFORM_EXTRACTORS.find((candidate) =>
    candidate.match(url),
  )!;
  return extractor.extract({ sourceUrl, url, signal });
}
