import React, { createContext, useContext, useState, useCallback } from 'react';

const ToastContext = createContext({ show: () => {} });

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const show = useCallback((message, type = 'info', durationMs = 2500) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), durationMs);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div style={{ position: 'fixed', top: 16, right: 16, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 9999, pointerEvents: 'none' }}>
        {toasts.map((t) => (
          <div key={t.id} className={`app-toast app-toast--${t.type}`} style={{ position: 'relative', top: 0, right: 0, pointerEvents: 'auto' }}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
