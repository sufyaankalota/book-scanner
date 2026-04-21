import React from 'react';

export default function ScannerSelector({
  scanner1,
  scanner2,
  activeScanner,
  onSetActive,
  onRegister2,
  setScanner2Name,
}) {
  return (
    <div style={styles.container}>
      <div style={styles.row}>
        {/* Scanner 1 - always registered */}
        <button
          onClick={() => onSetActive(1)}
          style={activeScanner === 1 ? styles.activeBtn : styles.btn}
        >
          🔵 {scanner1 || 'Scanner 1'}
        </button>

        {/* Scanner 2 */}
        {scanner2 ? (
          <button
            onClick={() => onSetActive(2)}
            style={activeScanner === 2 ? styles.activeBtn : styles.btn}
          >
            🟢 {scanner2}
          </button>
        ) : (
          <button onClick={onRegister2} style={styles.registerBtn}>
            + Register Scanner 2
          </button>
        )}
      </div>
      <p style={styles.label}>
        Active: <strong>{activeScanner === 1 ? scanner1 : scanner2}</strong>
      </p>
    </div>
  );
}

const styles = {
  container: {
    marginBottom: 8,
  },
  row: {
    display: 'flex',
    gap: 12,
  },
  btn: {
    padding: '8px 16px',
    borderRadius: 6,
    border: '1px solid #555',
    backgroundColor: '#222',
    color: '#aaa',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
  activeBtn: {
    padding: '8px 16px',
    borderRadius: 6,
    border: '2px solid #22C55E',
    backgroundColor: '#1a3a25',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
  registerBtn: {
    padding: '8px 16px',
    borderRadius: 6,
    border: '1px dashed #666',
    backgroundColor: 'transparent',
    color: '#888',
    fontSize: 14,
    cursor: 'pointer',
  },
  label: {
    color: '#888',
    fontSize: 13,
    marginTop: 6,
  },
};
