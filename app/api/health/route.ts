/** Unauthenticated liveness probe for the host. */
export function GET(): Response {
  return Response.json({ ok: true });
}
