import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Home from './pages/Home';
import Pod from './pages/Pod';
import AuthGate from './components/AuthGate';
import { AuthProvider } from './contexts/AuthContext';

// Lazy load non-critical pages
const Setup = lazy(() => import('./pages/Setup'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const JobHistory = lazy(() => import('./pages/JobHistory'));
const Kiosk = lazy(() => import('./pages/Kiosk'));
const CustomerPortal = lazy(() => import('./pages/CustomerPortal'));
const PhotoUpload = lazy(() => import('./pages/PhotoUpload'));
const Users = lazy(() => import('./pages/Users'));

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

const Loading = () => (
  <div style={{ minHeight: '100vh', backgroundColor: '#111', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', fontFamily: 'system-ui' }}>
    Loading...
  </div>
);

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <BrowserRouter>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={<AuthGate><Home /></AuthGate>} />
              <Route path="/setup" element={<AuthGate requiredRole="admin"><Setup /></AuthGate>} />
              <Route path="/pod" element={<AuthGate><Pod /></AuthGate>} />
              <Route path="/dashboard" element={<AuthGate requiredRole="manager"><Dashboard /></AuthGate>} />
              <Route path="/kiosk" element={<AuthGate><Kiosk /></AuthGate>} />
              <Route path="/portal" element={<CustomerPortal />} />
              <Route path="/upload" element={<PhotoUpload />} />
              <Route path="/history" element={<AuthGate requiredRole="manager"><JobHistory /></AuthGate>} />
              <Route path="/users" element={<AuthGate requiredRole="admin"><Users /></AuthGate>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  );
}
