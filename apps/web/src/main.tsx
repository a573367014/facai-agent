import { CssBaseline, ThemeProvider } from "@mui/material";
import ReactDOM from "react-dom/client";
import App from "./App";
import { appTheme } from "./mui-theme";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <ThemeProvider theme={appTheme}>
    <CssBaseline />
    <App />
  </ThemeProvider>
);
