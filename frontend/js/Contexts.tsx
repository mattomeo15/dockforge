import React, { createContext, useContext } from 'react';

// --- Theme Context ---
export interface ThemeContextType {
  theme: 'dark' | 'light';
  setTheme: (theme: 'dark' | 'light') => void;
  toggleTheme: () => void;
}

export const ThemeContext = createContext<ThemeContextType>({
  theme: 'dark',
  setTheme: () => {},
  toggleTheme: () => {},
});

export const useTheme = () => useContext(ThemeContext);

// --- Settings Context ---
export interface SettingsType {
  github_token?: string;
  dockerhub_username?: string;
  dockerhub_token?: string;
  theme?: string;
}

export interface SettingsContextType {
  settings: SettingsType;
  updateSettings: (newSettings: Partial<SettingsType>) => Promise<void>;
  loading: boolean;
}

export const SettingsContext = createContext<SettingsContextType>({
  settings: {
    github_token: '',
    dockerhub_username: '',
    dockerhub_token: '',
    theme: 'dark',
  },
  updateSettings: async () => {},
  loading: false,
});

export const useSettings = () => useContext(SettingsContext);

// --- Auth Context ---
export interface AuthContextType {
  user: string | null;
  token: string | null;
  login: (username: string, token: string) => void;
  logout: () => void;
  isAuthenticated: boolean;
}

export const AuthContext = createContext<AuthContextType>({
  user: null,
  token: null,
  login: () => {},
  logout: () => {},
  isAuthenticated: false,
});

export const useAuth = () => useContext(AuthContext);
