import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/constants";

const PUBLIC_PAGE_PATHS = new Set(["/login"]);
const PUBLIC_API_PREFIXES = [
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/logout",
  "/api/health"
];

function isStaticPath(pathname: string) {
  return (
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    pathname.endsWith(".aac")
  );
}

function isPublicApi(pathname: string) {
  return PUBLIC_API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function isProtectedApi(pathname: string) {
  return pathname.startsWith("/api/video-brief");
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, success: false, message }, { status });
}

function buildReturnTo(pathname: string, search: string) {
  return pathname === "/" && !search ? "/" : `${pathname}${search}`;
}

function redirectToLogin(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";

  const returnTo = buildReturnTo(request.nextUrl.pathname, request.nextUrl.search);
  if (returnTo !== "/") {
    url.searchParams.set("return_to", returnTo);
  }

  return NextResponse.redirect(url);
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isStaticPath(pathname)) {
    return NextResponse.next();
  }

  if (PUBLIC_PAGE_PATHS.has(pathname) || isPublicApi(pathname)) {
    return NextResponse.next();
  }

  const hasSessionCookie = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!hasSessionCookie) {
    if (pathname.startsWith("/api/")) {
      return jsonError("未登录或登录已失效", 401);
    }
    return redirectToLogin(request);
  }

  if (isProtectedApi(pathname)) {
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|aac)$).*)"]
};
