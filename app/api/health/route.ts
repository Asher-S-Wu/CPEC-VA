import { getDb } from "@/lib/db";
import { logError } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });

    return Response.json({
      ok: true,
      database: "connected",
    });
  } catch (error) {
    logError("health", "mongodb ping", error);

    return Response.json(
      {
        ok: false,
        database: "unavailable",
      },
      { status: 503 },
    );
  }
}
