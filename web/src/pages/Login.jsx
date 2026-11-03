import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Collapse,
  Divider,
  Link,
  Paper,
  TextField,
  Typography,
} from "@mui/material";
import LoginIcon from "@mui/icons-material/Login";
import { useAuth } from "../auth/AuthContext";
import { tokens } from "../theme";

export default function Login() {
  const {
    config,
    error,
    ssoAccount,
    signInWithMicrosoft,
    signInWithApiKey,
    signOut,
  } = useAuth();
  const sso = config?.sso;
  const [showKey, setShowKey] = useState(!sso);
  const [key, setKey] = useState("");
  const [keyError, setKeyError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submitKey = async (e) => {
    e.preventDefault();
    setBusy(true);
    setKeyError(null);
    try {
      await signInWithApiKey(key.trim());
    } catch (err) {
      setKeyError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        bgcolor: "background.default",
        px: 2,
      }}
    >
      <Paper
        sx={{
          width: "100%",
          maxWidth: 420,
          p: 4,
          borderTop: `6px solid ${tokens.line}`,
        }}
      >
        <Typography variant="overline" sx={{ color: tokens.line }}>
          Middleware Integration Service
        </Typography>
        <Typography variant="h1" component="h1" sx={{ mb: 1 }}>
          Monitoring Integrasi
        </Typography>
        <Typography sx={{ color: "text.secondary", mb: 3, fontSize: "0.9rem" }}>
          {sso
            ? "Masuk dengan akun Microsoft MRT Jakarta. Data yang tampil mengikuti role dan scope akun Anda."
            : "Masuk dengan API key dari admin middleware. Data yang tampil mengikuti role dan scope key tersebut."}
        </Typography>

        {error && ssoAccount && (
          <Alert
            severity="warning"
            sx={{ mb: 2 }}
            action={
              <Button color="inherit" size="small" onClick={signOut}>
                Keluar
              </Button>
            }
          >
            {ssoAccount.username}: {error}
          </Alert>
        )}

        {sso && (
          <Button
            fullWidth
            size="large"
            variant="contained"
            startIcon={<LoginIcon />}
            onClick={signInWithMicrosoft}
            sx={{ mb: 2 }}
          >
            Masuk dengan akun Microsoft
          </Button>
        )}

        {config?.apiKeyLogin && (
          <>
            {sso && (
              <>
                <Divider sx={{ my: 2 }} />
                <Link
                  component="button"
                  type="button"
                  variant="body2"
                  onClick={() => setShowKey((v) => !v)}
                >
                  {showKey
                    ? "Sembunyikan login API key"
                    : "Masuk dengan API key (aplikasi / darurat)"}
                </Link>
              </>
            )}
            <Collapse in={showKey}>
              <Box
                component="form"
                onSubmit={submitKey}
                sx={{ mt: sso ? 2 : 0 }}
              >
                {keyError && (
                  <Alert severity="error" sx={{ mb: 2 }}>
                    {keyError}
                  </Alert>
                )}
                <TextField
                  label="API key"
                  type="password"
                  autoComplete="off"
                  fullWidth
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  inputProps={{ style: { fontFamily: tokens.font.mono } }}
                  sx={{ mb: 2 }}
                />
                <Button
                  type="submit"
                  variant={sso ? "outlined" : "contained"}
                  fullWidth
                  size="large"
                  disabled={busy || key.trim().length < 20}
                >
                  {busy ? "Memeriksa…" : "Masuk dengan API key"}
                </Button>
              </Box>
            </Collapse>
          </>
        )}

        {!sso && !config?.apiKeyLogin && (
          <Alert severity="error">
            Tidak ada metode login yang diaktifkan di server. Hubungi admin
            middleware.
          </Alert>
        )}
      </Paper>
    </Box>
  );
}
