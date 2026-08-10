import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Basic ")) {
    try {
      const [username, suppliedPassword] = atob(authorization.slice(6)).split(":");
      if (username === (process.env.APP_USERNAME || "radar") && suppliedPassword === password) return NextResponse.next();
    } catch {
      // Malformed authentication headers are handled as unauthorized.
    }
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Roblox Trend Radar"' },
  });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
