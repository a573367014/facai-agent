import { CssBaseline, ThemeProvider } from "@mui/material";
import ReactDOM from "react-dom/client";
import App from "@/app/App";
import { appTheme } from "@/app/theme/mui-theme";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <ThemeProvider theme={appTheme}>
    <CssBaseline />
    <App />
  </ThemeProvider>
);
