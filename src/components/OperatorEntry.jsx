import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ScanLine, Boxes, Layers } from 'lucide-react';
import { displayOperatorName, normalizeOperatorKey } from '../utils/operator';
import { getOperator, setOperator } from '../lib/stationIdentity';

// Unified worker entry: type your name (or tap a recent one), then choose your
// work area. Picking the current page's area starts it here; picking another
// hands off to that area carrying your name (shared identity), so a person
// never re-enters their name when switching jobs.
const HISTORY_KEY = 'operator-history';

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}

export function rememberOperator(name) {
  const disp = displayOperatorName(name);
  if (!disp) return disp;
  const key = normalizeOperatorKey(disp);
  const hist = loadHistory().filter((n) => normalizeOperatorKey(n) !== key);
  hist.unshift(disp);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(hist.slice(0, 12)));
  setOperator(disp);
  return disp;
}

const AREAS = [
  { key: 'scan', label: 'Scan books', hint: 'Into bins / gaylords', to: '/pods', icon: ScanLine },
  { key: 'pack', label: 'Pack boxes', hint: 'Books into PO boxes', to: '/pack', icon: Boxes },
  { key: 'pallet', label: 'Build pallets', hint: 'Boxes onto pallets', to: '/pallet', icon: Layers },
];

export default function OperatorEntry({ current, title, subtitle, stationLabel, stationDefault = '', stationPlaceholder = '', onStart }) {
  const [name, setName] = useState(() => getOperator());
  const [station, setStation] = useState(stationDefault);
  const [history] = useState(loadHistory);
  const navigate = useNavigate();
  const disp = displayOperatorName(name);

  const choose = (area) => {
    if (!disp) return;
    rememberOperator(disp);
    if (area.key === current) onStart({ name: disp, station: station.trim() || stationDefault });
    else navigate(area.to);
  };

  return (
    <div style={s.wrap}>
      <Link to="/" style={s.back}>{'\u2190 Home'}</Link>
      <div style={s.card}>
        <h2 style={s.h2}>{title}</h2>
        {subtitle && <p style={s.hint}>{subtitle}</p>}

        <label style={s.label}>Your name</label>
        <input style={s.input} value={name} autoFocus placeholder="Type your name"
          onChange={(e) => setName(e.target.value)} />
        {history.length > 0 && !name.trim() && (
          <div style={{ marginTop: 12 }}>
            <p style={s.recentLabel}>Recent employees</p>
            <div style={s.recentRow}>
              {history.slice(0, 8).map((n) => (
                <button key={n} style={s.recentBtn} onClick={() => setName(n)}>{n}</button>
              ))}
            </div>
          </div>
        )}

        {stationLabel && (
          <>
            <label style={s.label}>{stationLabel}</label>
            <input style={s.input} value={station} placeholder={stationPlaceholder}
              onChange={(e) => setStation(e.target.value)} />
          </>
        )}

        <div style={s.areaHead}>{disp ? 'Choose your work area' : 'Enter your name to choose an area'}</div>
        <div style={s.areas}>
          {AREAS.map((a) => {
            const Icon = a.icon;
            const isCurrent = a.key === current;
            return (
              <button key={a.key} disabled={!disp}
                style={{ ...s.area, ...(isCurrent ? s.areaPrimary : {}), ...(!disp ? s.areaDisabled : {}) }}
                onClick={() => choose(a)}>
                <Icon size={26} />
                <span style={s.areaLabel}>{a.label}</span>
                <span style={s.areaHint}>{a.hint}</span>
                {isCurrent && <span style={s.areaTag}>You{'\u2019'}re here</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const s = {
  wrap: { minHeight: '100vh', background: 'var(--bg, #0f0f0f)', color: 'var(--text, #f0f0f0)', fontFamily: 'var(--font-sans)', padding: '20px clamp(16px, 2.5vw, 36px) 40px', boxSizing: 'border-box' },
  back: { color: 'var(--text-tertiary, #888)', textDecoration: 'none', fontSize: 13, fontWeight: 600 },
  card: { maxWidth: 560, margin: '32px auto', background: 'linear-gradient(180deg, var(--bg-elev,#1b2030), var(--bg-card,#161a24))', border: '1px solid var(--border,#252b3a)', borderRadius: 16, padding: 24, boxShadow: 'var(--shadow-card)' },
  h2: { fontSize: 24, fontWeight: 800, margin: '0 0 6px', fontFamily: 'var(--font-display)' },
  hint: { color: 'var(--text-secondary, #9aa4b2)', fontSize: 14, margin: '0 0 8px' },
  label: { display: 'block', color: 'var(--text-secondary, #aaa)', fontSize: 13, fontWeight: 700, margin: '16px 0 6px' },
  input: { width: '100%', padding: '14px', borderRadius: 10, border: '1px solid var(--border, #444)', background: 'var(--bg-input, #1a1a1a)', color: 'var(--text, #fff)', fontSize: 17, boxSizing: 'border-box' },
  recentLabel: { color: 'var(--text-tertiary,#999)', fontSize: 13, fontWeight: 600, margin: '0 0 6px' },
  recentRow: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  recentBtn: { padding: '10px 16px', borderRadius: 8, border: '1px solid var(--border, #444)', background: 'var(--bg-input, #222)', color: 'var(--text, #ddd)', fontSize: 15, fontWeight: 700, cursor: 'pointer' },
  areaHead: { margin: '22px 0 10px', color: 'var(--text-tertiary,#999)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 },
  areas: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 },
  area: { position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '20px 14px', borderRadius: 14, border: '1px solid var(--border,#444)', background: 'var(--bg-input,#222)', color: 'var(--text,#fff)', cursor: 'pointer', textAlign: 'center' },
  areaPrimary: { borderColor: 'var(--accent,#4d7cff)', background: 'var(--accent-soft,rgba(77,124,255,.14))', color: 'var(--accent,#7da2ff)' },
  areaDisabled: { opacity: 0.45, cursor: 'not-allowed' },
  areaLabel: { fontSize: 15, fontWeight: 800 },
  areaHint: { fontSize: 12, color: 'var(--text-tertiary,#888)', fontWeight: 600 },
  areaTag: { position: 'absolute', top: 8, right: 8, fontSize: 9, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--accent,#7da2ff)', border: '1px solid var(--accent,#4d7cff)', borderRadius: 999, padding: '2px 6px' },
};
