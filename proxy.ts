import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authMode, SESSION_COOKIE } from "@/lib/auth/mode";

/**
 * Redirects signed-out users to /login. AUTH_MODE=supabase also refreshes the
 * Supabase session cookie here; AUTH_MODE=app only checks that the session
 * cookie is present (the session itself is checked on the server, in
 * getCurrentActor). Authorisation is still enforced inside every page, server
 * action (requireActor*) and by Postgres RLS; this is only the first gate.
 */
const PUBLIC_PATHS = ["/login", "/auth", "/forbidden"];

function toLogin(request: NextRequest) {
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  return NextResponse.redirect(loginUrl);
}

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
  if (authMode() === "app") {
    // API routes answer 401 themselves; pages go to the sign-in page.
    if (!isPublic && !path.startsWith("/api/") && !request.cookies.get(SESSION_COOKIE)?.value) return toLogin(request);
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return response;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        toSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);
  if (!signedIn && !isPublic) return toLogin(request);
  return response;
}

export const config = {
  // Integration endpoints authenticate with an API key, not cookies.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/integrations|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
