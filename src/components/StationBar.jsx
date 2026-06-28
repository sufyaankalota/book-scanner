import React from 'react';
import { Link } from 'react-router-dom';
import { ScanLine, Boxes, Layers, LogOut } from 'lucide-react';

// Shared station chrome so Scan (pods), Pack, and Pallet feel like ONE system:
// it always shows which area you're in, lets a worker jump between areas, and
// shows / switches the current operator. The workflows stay separate; only the
// identity + navigation are unified.
const AREAS = [
  { key: 'scan', label: 'Scan', to: '/pods', icon: ScanLine },
  { key: 'pack', label: 'Pack', to: '/pack', icon: Boxes },
  { key: 'pallet', label: 'Pallet', to: '/pallet', icon: Layers },
];

export default function StationBar({ area, operator, onSwitchOperator }) {
  return (
    <div style={s.bar}>
      <div style={s.areas}>
        {AREAS.map((a) => {
          const Icon = a.icon;
          if (a.key === area) {
            return <span key={a.key} style={{ ...s.area, ...s.areaActive }}><Icon size={15} /> {a.label}</span>;
          }
          return <Link key={a.key} to={a.to} style={s.area}><Icon size={15} /> {a.label}</Link>;
        })}
      </div>
      {operator && (
        <div style={s.who}>
          <span style={s.dot} /> {operator}
          {onSwitchOperator && (
            <button style={s.switch} onClick={onSwitchOperator}><LogOut size={13} /> Switch</button>
          )}
        </div>
      )}
    </div>
  );
}

const s = {
  bar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16, paddingBottom: 12, borderBottom: '1px solid var(--border,#252b3a)' },
  areas: { display: 'inline-flex', gap: 4, background: 'var(--bg-input,#161a24)', border: '1px solid var(--border,#252b3a)', borderRadius: 10, padding: 4 },
  area: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, color: 'var(--text-secondary,#9aa4b2)', textDecoration: 'none', fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  areaActive: { background: 'var(--accent,#4d7cff)', color: 'var(--accent-contrast,#fff)' },
  who: { display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary,#bbb)', fontSize: 14, fontWeight: 700 },
  dot: { width: 8, height: 8, borderRadius: 999, background: 'var(--success,#2fbf71)', flexShrink: 0 },
  switch: { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border,#444)', background: 'var(--bg-input,#222)', color: 'var(--text-secondary,#bbb)', fontWeight: 700, fontSize: 13, cursor: 'pointer' },
};
