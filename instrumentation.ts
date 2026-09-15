// Next.js calls register() once per server start. This is where the
// background snapshot loop is started so `npm run dev` is all that's needed.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { startTracker } = await import("./lib/tracker");
  startTracker();
}
