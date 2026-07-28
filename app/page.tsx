import { connection } from "next/server";
import { requirePageSession } from "@/lib/auth";
import { HomeUrlInput } from "@/components/home/url-input";
import { ChatShell } from "@/components/layout/chat-shell";
import { VideoBriefArchiveRepository } from "@/lib/video-brief/repository";
import type { SerializedVideoBriefArchive } from "@/types/video-brief";

const RECENT_LIMIT = 25;

async function loadRecentArchives(userId: string): Promise<SerializedVideoBriefArchive[]> {
  try {
    const result = await VideoBriefArchiveRepository.listByUser({
      userId,
      page: 1,
      pageSize: RECENT_LIMIT,
    });
    return result.archives;
  } catch {
    return [];
  }
}

export default async function HomePage() {
  await connection();
  const current = await requirePageSession();
  const archives = await loadRecentArchives(current.user._id.toString());

  return (
    <ChatShell
      archives={archives}
    >
      <div className="home-welcome">
        <h1 className="home-welcome-title">粘贴视频链接，AI 自动解读</h1>
        <p className="home-welcome-subtitle">支持多种视频平台、开放视频站与视频直链</p>
        <HomeUrlInput />
      </div>
    </ChatShell>
  );
}
