// ─── Crew roles for daily payroll ───
// Five fixed roles agreed with ops. Each daily-pay doc stores per-role
// { count, hours, rate } so the cost rolls up as count * hours * rate.
//
// Backward-compat: legacy `dailyPay` docs only have `employees: [{name, hours, rate}]`
// and a precomputed `totalPay`. Readers should prefer `roles` when present.

export const ROLES = [
  { key: 'openers',     label: 'Openers',     defaultRate: 19 },
  { key: 'runners',     label: 'Runners',     defaultRate: 19 },
  { key: 'floaters',    label: 'Floaters',    defaultRate: 19 },
  { key: 'supervisors', label: 'Supervisors', defaultRate: 19 },
  { key: 'scanners',    label: 'Scanners',    defaultRate: 19 },
];

export const ROLE_KEYS = ROLES.map((r) => r.key);

export function emptyRoles() {
  const out = {};
  for (const r of ROLES) out[r.key] = { count: 0, hours: 0, rate: r.defaultRate };
  return out;
}

export function normalizeRoles(input) {
  const out = emptyRoles();
  if (input && typeof input === 'object') {
    for (const r of ROLES) {
      const v = input[r.key] || {};
      out[r.key] = {
        count: Number(v.count) || 0,
        hours: Number(v.hours) || 0,
        rate:  Number(v.rate)  || r.defaultRate,
      };
    }
  }
  return out;
}

export function rolesTotal(roles) {
  const r = normalizeRoles(roles);
  let total = 0;
  let headcount = 0;
  for (const k of ROLE_KEYS) {
    total += r[k].count * r[k].hours * r[k].rate;
    headcount += r[k].count;
  }
  return { total: Math.round(total * 100) / 100, headcount };
}

// Pull the labor total from a dailyPay doc, preferring the new roles shape
// and falling back to the legacy `totalPay` field for older docs.
export function dailyPayTotal(doc) {
  if (!doc) return 0;
  if (doc.roles) return rolesTotal(doc.roles).total;
  return Number(doc.totalPay) || 0;
}
