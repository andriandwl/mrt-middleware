import { Box, Button, Tab, Tabs, Typography } from "@mui/material";
import LogoutIcon from "@mui/icons-material/Logout";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { tokens } from "../theme";
import LineMap from "./LineMap";

const NAV = [
  { to: "/", label: "Ringkasan" },
  { to: "/telemetri", label: "Telemetri" },
  { to: "/event", label: "Event & alarm" },
  { to: "/kereta", label: "Info kereta" },
  { to: "/konektor", label: "Konektor", role: "operator" },
];

const ROLE_LABEL = { viewer: "Viewer", operator: "Operator", admin: "Admin" };

export default function Layout() {
  const { me, signOut, hasRole } = useAuth();
  const { pathname } = useLocation();
  const items = NAV.filter((n) => !n.role || hasRole(n.role));
  const current =
    items.find((n) => n.to !== "/" && pathname.startsWith(n.to))?.to ?? "/";

  return (
    <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
      <Box
        component="header"
        sx={{
          bgcolor: tokens.line,
          color: "#fff",
          px: { xs: 2, md: 4 },
          py: 1.25,
          display: "flex",
          alignItems: "center",
          gap: 2,
        }}
      >
        <Typography
          component="h1"
          sx={{
            fontFamily: tokens.font.display,
            fontWeight: 600,
            fontSize: "1.35rem",
            letterSpacing: "0.04em",
            flexGrow: 1,
          }}
        >
          MONITORING INTEGRASI
        </Typography>
        <Box sx={{ textAlign: "right", display: { xs: "none", sm: "block" } }}>
          <Typography
            sx={{ fontSize: "0.85rem", fontWeight: 600, lineHeight: 1.2 }}
            title={me?.name}
          >
            {me?.displayName ?? me?.name}
          </Typography>
          <Typography
            sx={{
              fontFamily: tokens.font.mono,
              fontSize: "0.7rem",
              opacity: 0.8,
            }}
          >
            {ROLE_LABEL[me?.role]} · {me?.scopes?.join(" ")}
            {me?.authType === "api_key" ? " · API key" : ""}
          </Typography>
        </Box>
        <Button
          onClick={signOut}
          startIcon={<LogoutIcon />}
          sx={{ color: "#fff", borderColor: "rgba(255,255,255,0.5)" }}
          variant="outlined"
          size="small"
        >
          Keluar
        </Button>
      </Box>

      <LineMap />

      <Box
        sx={{
          bgcolor: tokens.surface,
          borderBottom: `1px solid ${tokens.rule}`,
          px: { xs: 1, md: 3 },
        }}
      >
        <Tabs
          value={current}
          variant="scrollable"
          allowScrollButtonsMobile
          aria-label="Navigasi"
        >
          {items.map((n) => (
            <Tab
              key={n.to}
              value={n.to}
              label={n.label}
              component={Link}
              to={n.to}
            />
          ))}
        </Tabs>
      </Box>

      <Box
        component="main"
        sx={{ px: { xs: 2, md: 4 }, py: 3, maxWidth: 1400 }}
      >
        <Outlet />
      </Box>
    </Box>
  );
}
