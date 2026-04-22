import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Home from './pages/Home';
import Setup from './pages/Setup';
import Pod from './pages/Pod';
import Dashboard from './pages/Dashboard';
import JobHistory from './pages/JobHistory';
import Kiosk from './pages/Kiosk';
import SupervisorGate from './components/SupervisorGate';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh', backgroundColor: 'var(--bg, #111)', display: 'flex',
          flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif', padding: 24, color: 'var(--text, #fff)',
        }}>
          <h1 style={{ color: '#EF4444', fontSize: 32, marginBottom: 12 }}>
            Something went wrong
          </h1>
          <p style={{ color: 'var(--text-secondary, #888)', fontSize: 16, marginBottom: 24 }}>
            The app encountered an error. Please refresh the page.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '12px 32px', borderRadius: 8, border: 'none',
              backgroundColor: '#3B82F6', color: '#fff', fontSize: 16,
              fontWeight: 600, cursor: 'pointer',
            }}
          >
            Refresh Page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/setup" element={<SupervisorGate><Setup /></SupervisorGate>} />
          <Route path="/pod" element={<Pod />} />
          <Route path="/dashboard" element={<SupervisorGate><Dashboard /></SupervisorGate>} />
          <Route path="/kiosk" element={<Kiosk />} />
          <Route path="/history" element={<SupervisorGate><JobHistory /></SupervisorGate>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
