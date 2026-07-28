import type { ObjectId } from "mongodb";

export interface VideoBriefTimelineItem {
  time: string;
  content: string;
}

export interface VideoBriefAnalysis {
  summary: string;
  interpretation: string;
  keyPoints: string[];
  timeline: VideoBriefTimelineItem[];
  tags: string[];
  people: string[];
  places: string[];
  organizations: string[];
  uncertainPoints: string[];
}

export interface VideoBriefArchiveDoc {
  _id?: ObjectId;
  userId: ObjectId | string;
  sourceUrl: string;
  canonicalUrl: string;
  platform: string;
  title: string;
  author: string;
  coverUrl: string;
  durationSeconds: number;
  analysis: VideoBriefAnalysis;
  model: string;
  createdAt: Date;
}

export interface SerializedVideoBriefArchive {
  id: string;
  sourceUrl: string;
  canonicalUrl: string;
  platform: string;
  title: string;
  author: string;
  coverUrl: string;
  durationSeconds: number;
  analysis: VideoBriefAnalysis;
  model: string;
  createdAt: string;
}

export interface VideoMediaRequest {
  url: string;
  headers?: Record<string, string>;
}

export interface VideoFileMediaSource extends VideoMediaRequest {
  kind: "file";
  extension?: "mp4" | "flv" | "mov" | "webm" | "ogv" | "ts";
  mimeType?: string;
}

export interface VideoHlsMediaSource extends VideoMediaRequest {
  kind: "hls";
}

export type VideoMediaSource = VideoFileMediaSource | VideoHlsMediaSource;

export interface ExtractedVideoSource {
  sourceUrl: string;
  canonicalUrl: string;
  platformId: string;
  platform: string;
  title: string;
  author: string;
  coverUrl: string;
  durationSeconds: number;
  // 真实可下载的媒体来源，以及下载时必须携带的平台请求头。
  media: VideoMediaSource;
}
