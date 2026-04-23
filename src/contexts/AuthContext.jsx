import React, { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null);

  useEffect(() => {
    const stored = sessionStorage.getItem('bookflow-user');
    if (stored) {
      try { setCurrentUser(JSON.parse(stored)); } catch { sessionStorage.removeItem('bookflow-user'); }
    }
  }, []);

  const login = (user) => {
    const u = { id: user.id, email: user.email, name: user.name, role: user.role };
    setCurrentUser(u);
    sessionStorage.setItem('bookflow-user', JSON.stringify(u));
  };

  const logout = () => {
    setCurrentUser(null);
    sessionStorage.removeItem('bookflow-user');
    sessionStorage.removeItem('supervisorAuth');
  };

  return (
    <AuthContext.Provider value={{ currentUser, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
