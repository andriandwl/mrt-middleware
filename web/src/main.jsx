import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Box, CircularProgress, CssBaseline, GlobalStyles } from '@mui/material';
import { ThemeProvider } from '@mui/material/styles';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
import { theme, tokens } from './theme';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { LiveProvider } from './live/LiveContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Overview from './pages/Overview';
import Telemetry from './pages/Telemetry';
import Events from './pages/Events';
import TrainInfo from './pages/TrainInfo';
import Connectors from './pages/Connectors';

function App() {
  const { me, checking, hasRole } = useAuth();

  if (checking) {
    return (
      <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <CircularProgress aria-label="Memeriksa sesi" />
      </Box>
    );
  }
  if (!me) return <Login />;

  return (
    <LiveProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="telemetri" element={<Telemetry />} />
          <Route path="event" element={<Events />} />
          <Route path="kereta" element={<TrainInfo />} />
          <Route path="konektor" element={hasRole('operator') ? <Connectors /> : <Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </LiveProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <GlobalStyles
        styles={{
          '@keyframes mwFlash': {
            from: { backgroundColor: `${tokens.line}33` },
            to: { backgroundColor: 'transparent' },
          },
        }}
      />
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
);
