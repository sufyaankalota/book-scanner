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
          <span style={{ ...styles.paceIndicator, backgroundColor: paceColor }}>
            {paceLabel}
          </span>
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
    backgroundColor: 'var(--bg-card, #1a1a1a)',
    borderRadius: 12,
    padding: 20,
    border: '1px solid var(--border, #333)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    flexWrap: 'wrap',
    gap: 8,
  },
  podId: {
    fontSize: 24,
    fontWeight: 800,
    margin: 0,
    color: 'var(--text, #fff)',
  },
  statusBadge: {
    padding: '3px 10px',
    borderRadius: 20,
    fontSize: 11,
    fontWeight: 700,
    color: '#fff',
    letterSpacing: 0.5,
  },
  paceIndicator: {
    padding: '3px 10px',
    borderRadius: 20,
    fontSize: 11,
    fontWeight: 700,
    color: '#fff',
    letterSpacing: 0.5,
  },
  operatorLine: {
    color: '#aaa',
    fontSize: 13,
    margin: '0 0 12px',
  },
  statsGrid: {
    display: 'flex',
    gap: 12,
    justifyContent: 'space-between',
  },
  stat: {
    textAlign: 'center',
    flex: 1,
  },
  statValue: {
    fontSize: 28,
    fontWeight: 800,
    color: 'var(--text, #fff)',
    lineHeight: 1,
  },
  statLabel: {
    fontSize: 11,
    color: 'var(--text-secondary, #888)',
    marginTop: 4,
  },
  operatorSection: {
    marginTop: 12,
    borderTop: '1px solid var(--border, #333)',
    paddingTop: 10,
  },
  operatorRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '3px 0',
  },
  opName: { color: 'var(--text-secondary, #aaa)', fontSize: 13 },
  opCount: { color: 'var(--text, #fff)', fontSize: 13, fontWeight: 600 },
  scanners: {
    marginTop: 12,
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
  },
  scannerBadge: {
    padding: '4px 10px',
    borderRadius: 6,
    backgroundColor: '#14532d',
    color: '#bbf7d0',
    fontSize: 12,
    fontWeight: 600,
  },
};
