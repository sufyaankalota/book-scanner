import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { displayOperatorName, normalizeOperatorKey } from '../utils/operator';
import StationBar from './StationBar';

// Shared "who are you?" entry for the pack + pallet stations, matching the POD
// flow: type your name (or tap a recent one) + a station, then start. Names are
// kept in the SAME `operator-history` list POD uses, so the whole floor shares
// one employee roster and Title-Case normalization.
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
  return disp;
}

export default function OperatorEntry({ title, subtitle, area, stationLabel = 'Station', stationDefault = '', stationPlaceholder = '', cta = 'Start', onStart }) {
  const [name, setName] = useState('');
  const [station, setStation] = useState(stationDefault);
  const [history] = useState(loadHistory);

  const submit = () => {
    const disp = rememberOperator(name);
    if (!disp) return;
    onStart({ name: disp, station: station.trim() || stationDefault });
  };

  return (
    <div style={s.wrap}>
      <Link to="/" style={s.back}>{'\u2190 Home'}</Link>
      <div style={s.card}>
        {area && <StationBar area={area} />}
        <h2 style={s.h2}>{title}</h2>
        {subtitle && <p style={s.hint}>{subtitle}</p>}
        <label style={s.label}>Your name</label>
        <input style={s.input} value={name} autoFocus placeholder="Type your name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) submit(); }} />
        {history.length > 0 && !name.trim() && (
          <div style={{ marginTop: 14 }}>
            <p style={s.recentLabel}>Recent employees</p>
            <div style={s.recentRow}>
              {history.slice(0, 8).map((n) => (
                <button key={n} style={s.recentBtn} onClick={() => setName(n)}>{n}</button>
              ))}
            </div>
          </div>
        )}
        <label style={s.label}>{stationLabel}</label>
        <input style={s.input} value={station} placeholder={stationPlaceholder}
          onChange={(e) => setStation(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) submit(); }} />
        <button style={{ ...s.primary, opacity: name.trim() ? 1 : 0.5 }} disabled={!name.trim()} onClick={submit}>{cta}</button>
      </div>
    </div>
  );
}

const s = {
  wrap: { minHeight: '100vh', background: 'var(--bg, #0f0f0f)', color: 'var(--text, #f0f0f0)', fontFamily: 'var(--font-sans)', padding: '20px clamp(16px, 2.5vw, 36px) 40px', boxSizing: 'border-box' },
  back: { color: 'var(--text-tertiary, #888)', textDecoration: 'none', fontSize: 13, fontWeight: 600 },
  card: { maxWidth: 520, margin: '32px auto', background: 'linear-gradient(180deg, var(--bg-elev,#1b2030), var(--bg-card,#161a24))', border: '1px solid var(--border,#252b3a)', borderRadius: 16, padding: 24, boxShadow: 'var(--shadow-card)' },
  h2: { fontSize: 24, fontWeight: 800, margin: '0 0 6px', fontFamily: 'var(--font-display)' },
  hint: { color: 'var(--text-secondary, #9aa4b2)', fontSize: 14, margin: '0 0 8px' },
  label: { display: 'block', color: 'var(--text-secondary, #aaa)', fontSize: 13, fontWeight: 700, margin: '16px 0 6px' },
  input: { width: '100%', padding: '14px', borderRadius: 10, border: '1px solid var(--border, #444)', background: 'var(--bg-input, #1a1a1a)', color: 'var(--text, #fff)', fontSize: 17, boxSizing: 'border-box' },
  recentLabel: { color: 'var(--text-tertiary,#999)', fontSize: 13, fontWeight: 600, margin: '0 0 6px' },
  recentRow: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  recentBtn: { padding: '10px 16px', borderRadius: 8, border: '1px solid var(--border, #444)', background: 'var(--bg-input, #222)', color: 'var(--text, #ddd)', fontSize: 15, fontWeight: 700, cursor: 'pointer' },
  primary: { marginTop: 20, padding: '16px 20px', borderRadius: 12, border: 'none', background: 'var(--accent, #4d7cff)', color: 'var(--accent-contrast, #fff)', fontSize: 17, fontWeight: 800, cursor: 'pointer', width: '100%' },
};
