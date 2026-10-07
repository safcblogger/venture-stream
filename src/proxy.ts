import { NextResponse, type NextRequest } from "next/server";

/** Optimistic gate: bounce visitors with no session cookie. Real session checks happen server-side on every page and action. */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const open = pathname === "/login" || pathname === "/register";
  if (!open && !req.cookies.get("vs_session")) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Please sign in to continue." }, { status: 401 });
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
