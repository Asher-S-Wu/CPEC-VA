"use client";

import { useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Link2, Loader2, Sparkles, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { readJson } from "@/lib/client/api";

const MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;

interface UploadedFile {
  file: File;
  name: string;
  size: number;
  coverDataUrl: string;
}

function getErrorMessage(error: unknown, defaultMessage: string) {
  return error instanceof Error ? error.message : defaultMessage;
}

function resizeTextarea(element: HTMLTextAreaElement) {
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// 用浏览器 <video> 解码视频并截取第一帧，转成 JPEG base64，作为本地上传视频的封面。
function captureFirstFrame(file: File): Promise<string> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = url;

    let settled = false;

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      video.load();
    };

    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const draw = () => {
      if (settled) return;
      try {
        const canvas = document.createElement("canvas");
        const width = video.videoWidth || 640;
        const height = video.videoHeight || 360;
        // 限制封面尺寸，避免 base64 太大
        const scale = Math.min(1, 640 / width);
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          finish("");
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL("image/jpeg", 0.8));
      } catch {
        finish("");
      }
    };

    // 第一帧画面就绪时绘制
    video.addEventListener("loadeddata", draw);
    // 兜底：有些格式 loadeddata 不触发，再监听 canplay
    video.addEventListener("canplay", draw);
    video.addEventListener("error", () => finish(""));
    // 防止某些浏览器不触发事件导致一直挂着
    const timeoutId = window.setTimeout(() => finish(""), 5000);
  });
}

export function HomeUrlInput() {
  const router = useRouter();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [uploadedFile, setUploadedFile] = useState<UploadedFile | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  const [coverLoading, setCoverLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setError("");
    const file = event.target.files?.[0];
    // 重置 input 的 value，方便再次选择同一个文件
    event.target.value = "";
    if (!file) return;

    if (file.size > MAX_UPLOAD_FILE_BYTES) {
      setError(`视频文件不能超过 50 MB，当前文件 ${formatFileSize(file.size)}`);
      return;
    }
    if (!file.type.toLowerCase().startsWith("video/")) {
      setError("只支持上传视频文件");
      return;
    }

    setUrl("");
    setUploadProgress(0);
    setCoverLoading(true);
    // 先占位，封面字段稍后异步补上
    setUploadedFile({ file, name: file.name, size: file.size, coverDataUrl: "" });

    const coverDataUrl = await captureFirstFrame(file);
    setCoverLoading(false);
    setUploadedFile((prev) =>
      prev && prev.file === file ? { ...prev, coverDataUrl } : prev,
    );
  }

  function clearUploadedFile() {
    setUploadedFile(null);
    setUploadProgress(0);
    setCoverLoading(false);
    setError("");
  }

  function handleUploadSubmit() {
    if (!uploadedFile) return;
    setLoading(true);
    setError("");
    setUploadProgress(0);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/video-brief/analyze-upload");

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        setUploadProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      let data: { ok?: boolean; message?: string; archive?: { id: string } } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = { message: "视频速览失败" };
      }

      if (xhr.status >= 200 && xhr.status < 300 && data.archive?.id) {
        router.push(`/v/${data.archive.id}`);
      } else {
        setError(data.message || "视频速览失败");
        setLoading(false);
        setUploadProgress(0);
      }
    };

    xhr.onerror = () => {
      setError("网络异常，视频上传失败");
      setLoading(false);
      setUploadProgress(0);
    };

    const form = new FormData();
    form.append("file", uploadedFile.file);
    if (uploadedFile.coverDataUrl) {
      form.append("coverDataUrl", uploadedFile.coverDataUrl);
    }
    xhr.send(form);
  }

  async function handleUrlSubmit() {
    setLoading(true);
    try {
      const response = await fetch("/api/video-brief/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await readJson(response);
      const archive = data.archive as { id: string } | undefined;
      if (archive?.id) {
        router.push(`/v/${archive.id}`);
      } else {
        setError("分析完成，但未返回视频详情");
        setLoading(false);
      }
    } catch (analyzeError) {
      setError(getErrorMessage(analyzeError, "视频速览失败"));
      setLoading(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");

    if (uploadedFile) {
      if (coverLoading) {
        setError("正在生成视频封面，请稍候");
        return;
      }
      void handleUploadSubmit();
      return;
    }

    if (!url.trim()) {
      setError("请输入视频网址");
      return;
    }

    void handleUrlSubmit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSubmit(event as unknown as FormEvent);
    }
  }

  function handleChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    // 手动输入网址时清掉已选的本地文件
    if (uploadedFile) {
      clearUploadedFile();
    }
    setUrl(event.target.value);
    resizeTextarea(event.target);
  }

  // 本地文件模式下，封面图截取完成前禁止提交，保证每次上传都带封面
  const submitDisabled = loading || coverLoading || (!uploadedFile && !url.trim());

  return (
    <div className="home-input-wrapper">
      <form onSubmit={handleSubmit} className="home-input-form">
        <div className="home-input">
          <Link2 className="home-input-icon" />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
            className="home-input-upload-btn"
            aria-label="上传本地视频"
            title="上传本地视频"
          >
            <Upload className="h-[18px] w-[18px]" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            onChange={handleFileChange}
            className="home-input-file-input"
          />
          {uploadedFile ? (
            <div className="home-input-file-card">
              <div className="home-input-file-info">
                <span className="home-input-file-name" title={uploadedFile.name}>
                  {uploadedFile.name}
                </span>
                <span className="home-input-file-size">{formatFileSize(uploadedFile.size)}</span>
              </div>
              {coverLoading ? (
                <span className="home-input-cover-status">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  生成封面中
                </span>
              ) : loading ? (
                <div className="home-input-progress">
                  <div
                    className="home-input-progress-bar"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              ) : null}
              {coverLoading || loading ? null : (
                <button
                  type="button"
                  onClick={clearUploadedFile}
                  className="home-input-file-cancel"
                  aria-label="取消上传"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              value={url}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder="粘贴 B 站、优酷、芒果 TV 或视频直链"
              rows={1}
              disabled={loading}
              className="home-input-field"
            />
          )}
          <Button
            type="submit"
            disabled={submitDisabled}
            className="home-input-send"
            aria-label="开始速览"
          >
            {loading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Sparkles className="h-5 w-5" />
            )}
          </Button>
        </div>
      </form>
      {error ? <p className="home-input-error">{error}</p> : null}
      <p className="home-input-hint">
        支持粘贴 B 站、优酷、芒果 TV 或视频直链（限 10 分钟以内），也可点击左侧上传图标上传本地视频（限 50 MB 以内）
      </p>
    </div>
  );
}
