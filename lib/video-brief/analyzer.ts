import { resolveBailianProviderConfig } from "@/lib/ai/modelRoutes";
import {
  assertPublicHttpUrl,
  BROWSER_USER_AGENT,
  decodeResourceText,
  fetchPublicResource,
  fetchPublicText,
  MAX_PLAYLIST_BYTES,
  MAX_REMOTE_VIDEO_BYTES,
} from "@/lib/video-brief/extractors/http";
import { VideoSourceError } from "@/lib/video-brief/extractors/errors";
import type { ExtractedVideoSource, VideoBriefAnalysis } from "@/types/video-brief";

export const VIDEO_BRIEF_MODEL = "qwen3.5-omni-flash";

const HLS_URL_RE = /\.m3u8(?:$|[?#])/i;
const HLS_MIME_TYPES = new Set(["application/x-mpegurl", "application/vnd.apple.mpegurl"]);
const MAX_HLS_SEGMENTS = 800;
const REMOTE_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const POLICY_REQUEST_TIMEOUT_MS = 30_000;
const VIDEO_UPLOAD_TIMEOUT_MS = 3 * 60_000;
const MODEL_REQUEST_TIMEOUT_MS = 10 * 60_000;
const MAX_POLICY_RESPONSE_BYTES = 1024 * 1024;
const MAX_MODEL_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_ERROR_BYTES = 64 * 1024;

class VideoBriefAnalysisError extends Error {
  status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

interface DownloadedVideoFile {
  blob: Blob;
  filename: string;
}

class DownloadByteBudget {
  private used = 0;

  constructor(private readonly maximum: number) {}

  get remaining() {
    return Math.max(0, this.maximum - this.used);
  }

  consume(bytes: number) {
    this.used += bytes;
    if (this.used > this.maximum) {
      throw new VideoBriefAnalysisError("视频文件超过允许的大小", 413);
    }
  }
}

function createTimedSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  timeoutMessage: string,
) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) {
    abortFromParent();
  } else {
    parent?.addEventListener("abort", abortFromParent, { once: true });
  }
  const timeoutId = setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort(new DOMException(timeoutMessage, "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    cleanup() {
      clearTimeout(timeoutId);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

async function runWithStageTimeout<T>(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
  task: (signal: AbortSignal) => Promise<T>,
) {
  const operation = createTimedSignal(parent, timeoutMs, `${label}超时`);
  try {
    return await task(operation.signal);
  } catch (error) {
    if (operation.timedOut) {
      throw new VideoBriefAnalysisError(`${label}超时`, 504);
    }
    if (parent?.aborted) {
      throw new VideoBriefAnalysisError("视频处理已取消", 499);
    }
    if (error instanceof VideoBriefAnalysisError) throw error;
    throw new VideoBriefAnalysisError(`${label}失败`, 502);
  } finally {
    operation.cleanup();
  }
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  label: string,
) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    throw new VideoBriefAnalysisError(`${label}返回内容过大`, 502);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new VideoBriefAnalysisError(`${label}返回内容过大`, 502);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function getChoiceText(payload: any) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

function parseJsonObject(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = (fenced ? fenced[1] : trimmed).trim();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new VideoBriefAnalysisError("模型没有返回可用的 JSON 结果");
  }
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch {
    throw new VideoBriefAnalysisError("模型返回的 JSON 格式不正确");
  }
}

function requireString(value: unknown, fieldName: string) {
  if (typeof value !== "string") {
    throw new VideoBriefAnalysisError(`模型结果缺少 ${fieldName}`);
  }
  return value.trim();
}

function requireStringArray(value: unknown, fieldName: string) {
  if (!Array.isArray(value)) {
    throw new VideoBriefAnalysisError(`模型结果缺少 ${fieldName}`);
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function requireTimeline(value: unknown) {
  if (!Array.isArray(value)) {
    throw new VideoBriefAnalysisError("模型结果缺少 timeline");
  }
  return value
    .map((item) => ({
      time: typeof item?.time === "string" ? item.time.trim() : "",
      content: typeof item?.content === "string" ? item.content.trim() : "",
    }))
    .filter((item) => item.time || item.content);
}

function normalizeAnalysis(raw: any): VideoBriefAnalysis {
  const tags = requireStringArray(raw?.tags, "tags").slice(0, 12);
  if (tags.length === 0) {
    throw new VideoBriefAnalysisError("模型没有返回有效标签");
  }

  return {
    summary: requireString(raw?.summary, "summary"),
    interpretation: requireString(raw?.interpretation, "interpretation"),
    keyPoints: requireStringArray(raw?.keyPoints, "keyPoints"),
    timeline: requireTimeline(raw?.timeline),
    tags,
    people: requireStringArray(raw?.people, "people"),
    places: requireStringArray(raw?.places, "places"),
    organizations: requireStringArray(raw?.organizations, "organizations"),
    uncertainPoints: requireStringArray(raw?.uncertainPoints, "uncertainPoints"),
  };
}

function buildPrompt(source: ExtractedVideoSource) {
  return [
    "你是视频速览与归档助手。请认真观看完整视频，结合画面、字幕、口播、屏幕文字和声音信息生成归档内容。",
    "不要只根据标题判断；看不到、听不清或无法确定的信息必须放进 uncertainPoints，不要编造。",
    "请只返回 JSON，不要输出解释、Markdown 或代码块。",
    "字段要求：",
    "summary：一段 80 字以内的视频速览。",
    "interpretation：一段 180 字以内的重点解读，说明视频核心内容、表达意图和重要信息。",
    "keyPoints：3 到 6 条重点，每条不超过 30 字。",
    "timeline：最多 6 条关键片段，time 写成 00:00-00:15，content 写片段内容。",
    "tags：5 到 12 个中文短标签，由你根据视频内容自由生成。",
    "people、places、organizations：视频里能明确确认的人物、地点、机构，没有则返回空数组。",
    "uncertainPoints：不确定或证据不足的信息，没有则返回空数组。",
    "",
    "视频来源信息：",
    `平台：${source.platform}`,
    `标题：${source.title || "未提供"}`,
    `作者：${source.author || "未提供"}`,
    `原始地址：${source.sourceUrl}`,
    "",
    "输出格式：",
    "{\"summary\":\"\",\"interpretation\":\"\",\"keyPoints\":[],\"timeline\":[{\"time\":\"\",\"content\":\"\"}],\"tags\":[],\"people\":[],\"places\":[],\"organizations\":[],\"uncertainPoints\":[]}",
  ].join("\n");
}

function getDownloadHeaders(source: ExtractedVideoSource) {
  return {
    "User-Agent": BROWSER_USER_AGENT,
    ...(source.media.headers || {}),
  };
}

function isHlsUrl(url: string) {
  try {
    const parsed = new URL(url);
    return HLS_URL_RE.test(`${parsed.pathname}${parsed.search}`);
  } catch {
    return false;
  }
}

function isHlsMimeType(value: string) {
  return HLS_MIME_TYPES.has(value.trim().toLowerCase().split(";")[0]);
}

function getVideoExtension(url: string) {
  try {
    const match = new URL(url).pathname.match(/\.(mp4|flv|mov|webm|ogv|ts)$/i);
    return match?.[1]?.toLowerCase() || "mp4";
  } catch {
    return "mp4";
  }
}

function parseHlsAttributes(value: string) {
  const attrs: Record<string, string> = {};
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    attrs[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, "");
  }
  return attrs;
}

function resolveMediaUrl(value: string, baseUrl: string) {
  return assertPublicHttpUrl(new URL(value, baseUrl).toString()).toString();
}

function parseHlsPlaylist(text: string, playlistUrl: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const variants: Array<{ url: string; bandwidth: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;

    const attrs = parseHlsAttributes(line.slice(line.indexOf(":") + 1));
    const nextUri = lines.slice(index + 1).find((item) => !item.startsWith("#"));
    if (!nextUri) continue;

    variants.push({
      url: resolveMediaUrl(nextUri, playlistUrl),
      bandwidth: Number(attrs.BANDWIDTH) || Number.MAX_SAFE_INTEGER,
    });
  }

  if (variants.length > 0) {
    variants.sort((left, right) => left.bandwidth - right.bandwidth);
    return { variantUrl: variants[0].url, segments: [], initUrl: "" };
  }

  let initUrl = "";
  const segments: string[] = [];
  for (const line of lines) {
    if (line.startsWith("#EXT-X-KEY")) {
      const attrs = parseHlsAttributes(line.slice(line.indexOf(":") + 1));
      const method = attrs.METHOD?.toUpperCase();
      if (method && method !== "NONE") {
        throw new VideoBriefAnalysisError("该视频流已加密，暂时无法解读", 422);
      }
      continue;
    }

    if (line.startsWith("#EXT-X-MAP")) {
      const attrs = parseHlsAttributes(line.slice(line.indexOf(":") + 1));
      if (attrs.URI) {
        initUrl = resolveMediaUrl(attrs.URI, playlistUrl);
      }
      continue;
    }

    if (!line.startsWith("#")) {
      segments.push(resolveMediaUrl(line, playlistUrl));
    }
  }

  return { variantUrl: "", segments, initUrl };
}

function toArrayBuffer(bytes: Uint8Array<ArrayBuffer>) {
  return bytes.buffer;
}

async function fetchPlaylist(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
) {
  try {
    const response = await fetchPublicText(
      url,
      { headers, signal },
      {
        maxBytes: MAX_PLAYLIST_BYTES,
        timeoutMs: 30_000,
        label: "视频流",
      },
    );
    if (!response.ok) {
      throw new VideoBriefAnalysisError(`视频流读取失败（${response.status}）`, 502);
    }
    return { text: response.text, url: response.url };
  } catch (error) {
    if (error instanceof VideoSourceError) {
      throw new VideoBriefAnalysisError(error.message, error.status);
    }
    throw error;
  }
}

async function fetchSegment(
  url: string,
  headers: Record<string, string>,
  budget: DownloadByteBudget,
  signal?: AbortSignal,
) {
  if (budget.remaining <= 0) {
    throw new VideoBriefAnalysisError("视频文件超过允许的大小", 413);
  }
  try {
    const response = await fetchPublicResource(
      url,
      { headers, signal },
      {
        maxBytes: budget.remaining,
        timeoutMs: 30_000,
        label: "视频片段",
      },
    );
    if (!response.ok) {
      throw new VideoBriefAnalysisError(`视频片段下载失败（${response.status}）`, 502);
    }
    budget.consume(response.body.byteLength);
    return response.body;
  } catch (error) {
    if (error instanceof VideoSourceError) {
      throw new VideoBriefAnalysisError(error.message, error.status);
    }
    throw error;
  }
}

async function downloadHlsVideo(
  initialText: string,
  initialUrl: string,
  headers: Record<string, string>,
  budget: DownloadByteBudget,
  signal?: AbortSignal,
): Promise<DownloadedVideoFile> {
  let playlistText = initialText;
  let playlistUrl = initialUrl;
  budget.consume(new TextEncoder().encode(initialText).byteLength);

  for (let depth = 0; depth < 4; depth += 1) {
    const playlist = parseHlsPlaylist(playlistText, playlistUrl);
    if (playlist.variantUrl) {
      const next = await fetchPlaylist(playlist.variantUrl, headers, signal);
      budget.consume(new TextEncoder().encode(next.text).byteLength);
      playlistText = next.text;
      playlistUrl = next.url;
      continue;
    }

    if (playlist.segments.length === 0) {
      throw new VideoBriefAnalysisError("视频流里没有可下载的视频片段", 422);
    }
    if (playlist.segments.length > MAX_HLS_SEGMENTS) {
      throw new VideoBriefAnalysisError("视频片段过多，请换一个更短的视频", 400);
    }

    const parts: Uint8Array<ArrayBuffer>[] = [];
    if (playlist.initUrl) {
      parts.push(await fetchSegment(playlist.initUrl, headers, budget, signal));
    }

    for (const segmentUrl of playlist.segments) {
      parts.push(await fetchSegment(segmentUrl, headers, budget, signal));
    }

    const extension = playlist.initUrl ? "mp4" : "ts";
    const blob = new Blob(parts.map(toArrayBuffer), { type: playlist.initUrl ? "video/mp4" : "video/mp2t" });
    if (blob.size === 0) {
      throw new VideoBriefAnalysisError("视频内容为空", 502);
    }

    return {
      blob,
      filename: `video-${Date.now()}.${extension}`,
    };
  }

  throw new VideoBriefAnalysisError("视频流层级过深，暂时无法解读", 422);
}

// 把视频原文件下载到内存。B 站等有防盗链的平台需要带上来源页 Referer。
async function downloadVideo(source: ExtractedVideoSource, signal?: AbortSignal): Promise<DownloadedVideoFile> {
  const headers = getDownloadHeaders(source);
  const budget = new DownloadByteBudget(MAX_REMOTE_VIDEO_BYTES);
  const download = createTimedSignal(
    signal,
    REMOTE_DOWNLOAD_TIMEOUT_MS,
    "视频下载超时",
  );

  try {
    if (source.media.kind === "hls") {
      const playlist = await fetchPlaylist(
        source.media.url,
        headers,
        download.signal,
      );
      return await downloadHlsVideo(
        playlist.text,
        playlist.url,
        headers,
        budget,
        download.signal,
      );
    }

    const response = await fetchPublicResource(
      source.media.url,
      { headers, signal: download.signal },
      {
        maxBytes: MAX_REMOTE_VIDEO_BYTES,
        timeoutMs: 2 * 60_000,
        label: "视频文件",
      },
    );
    if (!response.ok) {
      throw new VideoBriefAnalysisError(`视频下载失败（${response.status}）`, 502);
    }
    if (response.body.byteLength === 0) {
      throw new VideoBriefAnalysisError("视频内容为空", 502);
    }
    const contentType = response.headers.get("content-type") || source.media.mimeType || "";
    if (isHlsUrl(response.url) || isHlsMimeType(contentType)) {
      return await downloadHlsVideo(
        decodeResourceText(response),
        response.url,
        headers,
        budget,
        download.signal,
      );
    }
    budget.consume(response.body.byteLength);
    const mimeType = contentType || "application/octet-stream";
    const blob = new Blob([toArrayBuffer(response.body)], { type: mimeType });
    return {
      blob,
      filename: `video-${Date.now()}.${
        source.media.extension || getVideoExtension(response.url)
      }`,
    };
  } catch (error) {
    if (download.timedOut) {
      throw new VideoBriefAnalysisError("视频下载超时", 504);
    }
    if (signal?.aborted) {
      throw new VideoBriefAnalysisError("视频处理已取消", 499);
    }
    if (error instanceof VideoSourceError) {
      throw new VideoBriefAnalysisError(error.message, error.status);
    }
    throw error;
  } finally {
    download.cleanup();
  }
}

interface BailianUploadPolicy {
  policy: string;
  signature: string;
  upload_dir: string;
  upload_host: string;
  oss_access_key_id: string;
  x_oss_object_acl: string;
  x_oss_forbid_overwrite: string;
}

// 向百炼申请临时上传凭证（免费临时存储，48 小时有效）。
async function fetchBailianUploadPolicy(
  apiKey: string,
  dashScopeBaseUrl: string,
  model: string,
  signal?: AbortSignal,
): Promise<BailianUploadPolicy> {
  return runWithStageTimeout(
    signal,
    POLICY_REQUEST_TIMEOUT_MS,
    "获取视频上传凭证",
    async (stageSignal) => {
      const url = `${dashScopeBaseUrl}/uploads?action=getPolicy&model=${encodeURIComponent(model)}`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: stageSignal,
      });

      const text = await readBoundedResponseText(
        response,
        MAX_POLICY_RESPONSE_BYTES,
        "视频上传凭证",
      );
      let payload: any = {};
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { message: text };
        }
      }

      if (!response.ok || payload?.code) {
        throw new VideoBriefAnalysisError(
          payload?.message || `获取视频上传凭证失败（${response.status}）`,
          response.ok ? 502 : response.status,
        );
      }

      const data = payload?.data;
      if (!data?.policy || !data?.upload_host || !data?.upload_dir) {
        throw new VideoBriefAnalysisError("视频上传凭证格式不正确", 502);
      }

      return data as BailianUploadPolicy;
    }
  );
}

// 把视频上传到百炼临时存储，返回阿里云内网地址 oss://...，模型从内网读取，彻底绕开 60 秒下载超时。
async function uploadVideoToBailian(policy: BailianUploadPolicy, file: DownloadedVideoFile, signal?: AbortSignal) {
  return runWithStageTimeout(
    signal,
    VIDEO_UPLOAD_TIMEOUT_MS,
    "视频上传",
    async (stageSignal) => {
      const key = `${policy.upload_dir}/${file.filename}`;
      const form = new FormData();
      form.append("OSSAccessKeyId", policy.oss_access_key_id);
      form.append("Signature", policy.signature);
      form.append("policy", policy.policy);
      form.append("key", key);
      form.append("x-oss-object-acl", policy.x_oss_object_acl);
      form.append("x-oss-forbid-overwrite", policy.x_oss_forbid_overwrite);
      form.append("success_action_status", "200");
      form.append("file", file.blob, file.filename);

      const response = await fetch(policy.upload_host, {
        method: "POST",
        body: form,
        signal: stageSignal,
      });
      if (!response.ok) {
        const body = await readBoundedResponseText(
          response,
          MAX_UPLOAD_ERROR_BYTES,
          "视频上传",
        );
        throw new VideoBriefAnalysisError(
          `视频上传失败（${response.status}）${
            body ? `：${body.slice(0, 200)}` : ""
          }`,
          502,
        );
      }
      await response.body?.cancel();
      return `oss://${key}`;
    },
  );
}

// 共用的"上传百炼 → 调 AI → 解析"流程。无论是从网址下载还是用户直传，拿到视频 Blob 后都走这里。
async function runBailianAnalysis(file: DownloadedVideoFile, source: ExtractedVideoSource, signal?: AbortSignal) {
  const { apiKey, openAIBaseUrl, dashScopeBaseUrl } = resolveBailianProviderConfig();

  const policy = await fetchBailianUploadPolicy(apiKey, dashScopeBaseUrl, VIDEO_BRIEF_MODEL, signal);
  const ossUrl = await uploadVideoToBailian(policy, file, signal);

  return runWithStageTimeout(
    signal,
    MODEL_REQUEST_TIMEOUT_MS,
    "视频理解",
    async (stageSignal) => {
      const response = await fetch(`${openAIBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          // 必需：让百炼解析 oss:// 内网地址
          "X-DashScope-OssResourceResolve": "enable",
        },
        body: JSON.stringify({
          model: VIDEO_BRIEF_MODEL,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "video_url",
                  video_url: {
                    url: ossUrl,
                    fps: 10,
                    min_pixels: 65536,
                    max_pixels: 2048000,
                    total_pixels: 184549376,
                  },
                },
                {
                  type: "text",
                  text: buildPrompt(source),
                },
              ],
            },
          ],
          modalities: ["text"],
          stream: false,
        }),
        signal: stageSignal,
      });

      const text = await readBoundedResponseText(
        response,
        MAX_MODEL_RESPONSE_BYTES,
        "视频理解",
      );
      let payload: any = {};
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { message: text };
        }
      }

      if (!response.ok || payload?.error) {
        const message =
          payload?.error?.message ||
          payload?.message ||
          `视频理解失败（${response.status}）`;
        throw new VideoBriefAnalysisError(
          message,
          response.ok ? 502 : response.status,
        );
      }

      const outputText = getChoiceText(payload);
      if (!outputText) {
        throw new VideoBriefAnalysisError("模型没有返回视频解读结果");
      }

      return normalizeAnalysis(parseJsonObject(outputText));
    },
  );
}

export async function analyzeVideo(source: ExtractedVideoSource, signal?: AbortSignal) {
  // 先把视频下载下来，再上传到百炼临时存储，避免百炼跨境下载公网视频时 60 秒超时。
  const file = await downloadVideo(source, signal);
  return runBailianAnalysis(file, source, signal);
}

// 处理用户直接上传的本地视频文件，跳过下载步骤，直接进入"上传百炼 → 调 AI"流程。
export async function analyzeVideoFromBlob(
  blob: Blob,
  filename: string,
  sourceMeta: { platform: string; title: string; author?: string },
  signal?: AbortSignal,
) {
  const file: DownloadedVideoFile = { blob, filename };
  const source: ExtractedVideoSource = {
    sourceUrl: `local://${filename}`,
    canonicalUrl: `local://${filename}`,
    platformId: "local",
    platform: sourceMeta.platform,
    title: sourceMeta.title,
    author: sourceMeta.author || "",
    coverUrl: "",
    durationSeconds: 0,
    media: {
      kind: "file",
      url: "",
    },
  };
  return runBailianAnalysis(file, source, signal);
}
