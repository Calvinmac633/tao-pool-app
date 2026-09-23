import { NextResponse, type NextRequest } from "next/server";

/**
 * Password gate. When APP_PASSWORD is set, every request must carry HTTP
 * basic auth with that password (any username). Unset locally for no gate.
 * The health check route stays open so the host can probe it.
 */
export function proxy(request: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();

  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const supplied = decoded.slice(decoded.indexOf(":") + 1);
      if (supplied === password) return NextResponse.next();
    } catch {
      // fall through to 401
    }
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="tao-pool-app", charset="UTF-8"' },
  });
}

export const config = {
  // Everything except static assets and the health check.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health).*)"],
};
