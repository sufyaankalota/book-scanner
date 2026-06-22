import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import Home from './pages/Home';
import Pod from './pages/Pod';
import AuthGate from './components/AuthGate';
import { AuthProvider } from './contexts/AuthContext';
import { ToastProvider } from './components/Toast';

// Lazy load non-critical pages
const Setup = lazy(() => import('./pages/Setup'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const JobHistory = lazy(() => import('./pages/JobHistory'));
const Kiosk = lazy(() => import('./pages/Kiosk'));
const PodSelect = lazy(() => import('./pages/PodSelect'));
const CustomerPortal = lazy(() => import('./pages/CustomerPortal'));
const Users = lazy(() => import('./pages/Users'));
const Billing = lazy(() => import('./pages/Billing'));
const Reports = lazy(() => import('./pages/Reports'));

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
          minHeight: '100vh', display: 'flex',
          flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--font-sans)', padding: 24, color: 'var(--text)',
        }}>
          <div className="ui-card scale-enter" style={{ maxWidth: 380, width: '100%', padding: '32px 28px', textAlign: 'center' }}>
            <div style={{ width: 56, height: 56, borderRadius: 'var(--radius-lg)', margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--error-soft)', color: 'var(--error)' }}>
              <AlertTriangle size={26} />
            </div>
            <h1 style={{ color: 'var(--text)', fontSize: 22, marginBottom: 8 }}>
              Something went wrong
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 24, lineHeight: 1.5 }}>
              The app hit an unexpected error. A refresh usually clears it.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="ui-btn ui-btn-primary"
              style={{ width: '100%' }}
            >
              Refresh page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const Loading = () => (
  <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, fontFamily: 'var(--font-sans)' }}>
    <div className="spinner spinner-lg" />
    <span style={{ fontFamily: 'var(--font-display)', fontSize: 13, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary, #69728a)' }}>Loading</span>
  </div>
);

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <ToastProvider>
          <BrowserRouter>
            <Suspense fallback={<Loading />}>
              <Routes>
                <Route path="/" element={<AuthGate><Home /></AuthGate>} />
                <Route path="/setup" element={<AuthGate requiredRole="admin"><Setup /></AuthGate>} />
                <Route path="/pod" element={<Pod />} />
                <Route path="/pods" element={<PodSelect />} />
                <Route path="/dashboard" element={<AuthGate requiredRole="manager"><Dashboard /></AuthGate>} />
                <Route path="/kiosk" element={<Kiosk />} />
                <Route path="/portal" element={<CustomerPortal />} />
                <Route path="/history" element={<AuthGate requiredRole="manager"><JobHistory /></AuthGate>} />
                <Route path="/users" element={<AuthGate requiredRole="admin"><Users /></AuthGate>} />
                <Route path="/billing" element={<AuthGate requiredRole="manager"><Billing /></AuthGate>} />
                <Route path="/reports" element={<AuthGate requiredRole="manager"><Reports /></AuthGate>} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
        </ToastProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
