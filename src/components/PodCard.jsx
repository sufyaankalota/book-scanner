import React from 'react';

function PodCard({ pod, presence, operatorStats, notes, onNotesChange }) {
  const paceRatio = pod.targetPerHour > 0 ? pod.pace / pod.targetPerHour : 1;
  const paceColor =
    paceRatio >= 1 ? '#22C55E' : paceRatio >= 0.8 ? '#EAB308' : '#EF4444';
  const paceLabel =
    paceRatio >= 1 ? 'ON PACE' : paceRatio >= 0.8 ? 'SLIGHTLY BEHIND' : 'BEHIND';

  const isOnline = presence?.online;
  const isPaused = presence?.status === 'paused';
  const statusLabel = isPaused ? 'PAUSED' : isOnline ? 'ONLINE' : 'OFFLINE';
  const statusColor = isPaused ? '#EAB308' : isOnline ? '#22C55E' : '#555';

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <h2 style={styles.podId}>Pod {pod.id}</h2>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ ...styles.statusBadge, backgroundColor: statusColor }}>
            {statusLabel}
          </span>
          {(isOnline || pod.scanCount > 0) && (
            <span style={{ ...styles.paceIndicator, backgroundColor: paceColor }}>
              {paceLabel}
            </span>
          )}
        </div>
      </div>

      {presence?.operator && isOnline && (
        <p style={styles.operatorLine}>
          Operator: <strong style={{ color: '#fff' }}>{presence.operator}</strong>
          {isPaused && <span style={{ color: '#EAB308', marginLeft: 8 }}>⏸</span>}
        </p>
      )}

      <div style={styles.statsGrid}>
        <div style={styles.stat}>
          <div style={styles.statValue}>{pod.scanCount.toLocaleString()}</div>
          <div style={styles.statLabel}>Scanned</div>
        </div>
        <div style={styles.stat}>
          <div style={{ ...styles.statValue, color: paceColor }}>{pod.pace}</div>
          <div style={styles.statLabel}>Scans/hr</div>
        </div>
        <div style={styles.stat}>
          <div style={{ ...styles.statValue, color: pod.exceptionCount > 0 ? '#F97316' : '#888' }}>
            {pod.exceptionCount}
          </div>
          <div style={styles.statLabel}>Exceptions</div>
        </div>
      </div>

      {operatorStats && Object.keys(operatorStats).length > 0 && (
        <div style={styles.operatorSection}>
          {Object.entries(operatorStats).sort((a, b) => b[1] - a[1]).map(([name, count]) => (
            <div key={name} style={styles.operatorRow}>
              <span style={styles.opName}>{name}</span>
              <span style={styles.opCount}>{count.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}

      {pod.scanners.length > 0 && (
        <div style={styles.scanners}>
          {pod.scanners.map((s, i) => (
            <span key={i} style={styles.scannerBadge}>{s}</span>
          ))}
        </div>
      )}

      {onNotesChange && (
        <div style={{ marginTop: 10 }}>
          <input
            type="text"
            value={notes || ''}
            onChange={(e) => onNotesChange(e.target.value)}
            placeholder="Pod notes..."
            style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border, #333)', backgroundColor: 'var(--bg-input, #111)', color: 'var(--text-secondary, #ccc)', fontSize: 12, boxSizing: 'border-box' }}
          />
        </div>
      )}
    </div>
  );
}

export default React.memo(PodCard);

const styles = {
  card: {
    backgroundColor: 'var(--bg-card, #161616)',
    borderRadius: 12,
    padding: '16px 18px',
    border: '1px solid var(--border, #222)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    flexWrap: 'wrap',
    gap: 8,
  },
  podId: {
    fontSize: 20,
    fontWeight: 800,
    margin: 0,
    color: 'var(--text, #f0f0f0)',
    letterSpacing: '-0.3px',
  },
  statusBadge: {
    padding: '3px 10px',
    borderRadius: 20,
    fontSize: 10,
    fontWeight: 700,
    color: '#fff',
    letterSpacing: 0.5,
  },
  paceIndicator: {
    padding: '3px 10px',
    borderRadius: 20,
    fontSize: 10,
    fontWeight: 700,
    color: '#fff',
    letterSpacing: 0.5,
  },
  operatorLine: {
    color: '#888',
    fontSize: 12,
    margin: '0 0 10px',
  },
  statsGrid: {
    display: 'flex',
    gap: 10,
    justifyContent: 'space-between',
  },
  stat: {
    textAlign: 'center',
    flex: 1,
  },
  statValue: {
    fontSize: 24,
    fontWeight: 800,
    color: 'var(--text, #f0f0f0)',
    lineHeight: 1,
  },
  statLabel: {
    fontSize: 10,
    color: 'var(--text-secondary, #666)',
    marginTop: 3,
    textTransform: 'uppercase',
    fontWeight: 600,
    letterSpacing: '0.3px',
  },
  operatorSection: {
    marginTop: 10,
    borderTop: '1px solid var(--border, #222)',
    paddingTop: 8,
  },
  operatorRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '3px 0',
  },
  opName: { color: 'var(--text-secondary, #888)', fontSize: 12 },
  opCount: { color: 'var(--text, #f0f0f0)', fontSize: 12, fontWeight: 600 },
  scanners: {
    marginTop: 10,
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap',
  },
  scannerBadge: {
    padding: '3px 8px',
    borderRadius: 6,
    backgroundColor: 'rgba(34,197,94,0.1)',
    color: '#86efac',
    fontSize: 11,
    fontWeight: 600,
    border: '1px solid rgba(34,197,94,0.2)',
  },
};
