import React from 'react';

export default function PodCard({ pod }) {
  const paceRatio = pod.targetPerHour > 0 ? pod.pace / pod.targetPerHour : 1;
  const paceColor =
    paceRatio >= 1 ? '#22C55E' : paceRatio >= 0.8 ? '#EAB308' : '#EF4444';
  const paceLabel =
    paceRatio >= 1 ? 'ON PACE' : paceRatio >= 0.8 ? 'SLIGHTLY BEHIND' : 'BEHIND';

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <h2 style={styles.podId}>Pod {pod.id}</h2>
        <span
          style={{
            ...styles.paceIndicator,
            backgroundColor: paceColor,
          }}
        >
          {paceLabel}
        </span>
      </div>

      <div style={styles.statsGrid}>
        <div style={styles.stat}>
          <div style={styles.statValue}>
            {pod.scanCount.toLocaleString()}
          </div>
          <div style={styles.statLabel}>Scanned</div>
        </div>
        <div style={styles.stat}>
          <div style={{ ...styles.statValue, color: paceColor }}>
            {pod.pace}
          </div>
          <div style={styles.statLabel}>Scans/hr</div>
        </div>
        <div style={styles.stat}>
          <div
            style={{
              ...styles.statValue,
              color: pod.exceptionCount > 0 ? '#F97316' : '#888',
            }}
          >
            {pod.exceptionCount}
          </div>
          <div style={styles.statLabel}>Exceptions</div>
        </div>
      </div>

      {pod.scanners.length > 0 && (
        <div style={styles.scanners}>
          {pod.scanners.map((s, i) => (
            <span key={i} style={styles.scannerBadge}>
              {s}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const styles = {
  card: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 20,
    border: '1px solid #333',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  podId: {
    fontSize: 24,
    fontWeight: 800,
    margin: 0,
    color: '#fff',
  },
  paceIndicator: {
    padding: '4px 12px',
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 700,
    color: '#000',
    letterSpacing: 0.5,
  },
  statsGrid: {
    display: 'flex',
    gap: 16,
    justifyContent: 'space-between',
  },
  stat: {
    textAlign: 'center',
    flex: 1,
  },
  statValue: {
    fontSize: 28,
    fontWeight: 800,
    color: '#fff',
    lineHeight: 1,
  },
  statLabel: {
    fontSize: 12,
    color: '#888',
    marginTop: 4,
  },
  scanners: {
    marginTop: 12,
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap',
  },
  scannerBadge: {
    padding: '2px 8px',
    borderRadius: 4,
    backgroundColor: '#333',
    color: '#aaa',
    fontSize: 12,
  },
};
