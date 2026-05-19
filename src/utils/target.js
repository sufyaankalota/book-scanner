// ─── Daily target calculation ───
// We pay/budget 2,200 books per pod per shift. Crews vary day to day
// (sometimes 6 pods, sometimes 10), so the target must scale with the
// number of pods configured for the job, not a static value.
export const PER_POD_DAILY_TARGET = 2200;
// Minimum acceptable output per scanner per shift. Below this is a
// performance concern. Above PER_POD_BONUS_TARGET earns a daily gift card.
export const PER_POD_DAILY_MIN = 1800;
export const PER_POD_BONUS_TARGET = 2200;
// Per-person daily goal used by the leaderboard total. The leaderboard
// counts unique operators (people, not pods), so the crew target is
// PER_PERSON_DAILY_TARGET × number of distinct operators who scanned today.
export const PER_PERSON_DAILY_TARGET = 1800;

export function computeDailyTarget(job) {
  const pods = job?.meta?.pods?.length || 0;
  return pods * PER_POD_DAILY_TARGET;
}

// Crew-based daily target: 1,800 × number of people who scanned today.
// Falls back to the pod-count budget if no operators have scanned yet so the
// progress chip never shows "0% of 0" before the first scan of the day.
export function computeCrewDailyTarget(job, operatorCount) {
  if (operatorCount && operatorCount > 0) return operatorCount * PER_PERSON_DAILY_TARGET;
  const pods = job?.meta?.pods?.length || 0;
  return pods * PER_PERSON_DAILY_TARGET;
}

export function computePodTarget(/* job */) {
  return PER_POD_DAILY_TARGET;
}
