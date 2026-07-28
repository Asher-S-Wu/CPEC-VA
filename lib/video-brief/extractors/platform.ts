import type { ExtractedVideoSource } from "@/types/video-brief";

export interface VideoExtractorContext {
  sourceUrl: string;
  url: URL;
  signal?: AbortSignal;
}

export interface VideoPlatformExtractor {
  id: string;
  name: string;
  match(url: URL): boolean;
  extract(context: VideoExtractorContext): Promise<ExtractedVideoSource>;
}
