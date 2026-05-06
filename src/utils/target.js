// ─── Daily target calculation ───
// We pay/budget 2,200 books per pod per shift. Crews vary day to day
// (sometimes 6 pods, sometimes 10), so the target must scale with the
// number of pods configured for the job, not a static value.
export const PER_POD_DAILY_TARGET = 2200;

export function computeDailyTarget(job) {
  const pods = job?.meta?.pods?.length || 0;
  return pods * PER_POD_DAILY_TARGET;
}

export function computePodTarget(/* job */) {
  return PER_POD_DAILY_TARGET;
}
