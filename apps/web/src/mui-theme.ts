import { createTheme } from "@mui/material/styles";

export const appTheme = createTheme({
  palette: {
    mode: "light",
    primary: {
      main: "#247a73",
      dark: "#15514d",
      light: "#e7f1d9",
      contrastText: "#fffdf4"
    },
    secondary: {
      main: "#8b6f24",
      dark: "#5b4716",
      light: "#f6e9bb",
      contrastText: "#2f3028"
    },
    error: {
      main: "#a44824",
      light: "#fff0e7",
      dark: "#753016"
    },
    background: {
      default: "#fff2c6",
      paper: "#fff8df"
    },
    text: {
      primary: "#2f3028",
      secondary: "#766f5f"
    }
  },
  shape: {
    borderRadius: 8
  },
  typography: {
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    button: {
      textTransform: "none",
      fontWeight: 800
    }
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          margin: 0,
          minWidth: 320,
          minHeight: "100vh",
          background: "#fff2c6",
          color: "#2f3028"
        }
      }
    },
    MuiButton: {
      defaultProps: {
        disableElevation: true
      },
      styleOverrides: {
        root: {
          borderRadius: 8,
          minHeight: 40
        }
      }
    },
    MuiTextField: {
      defaultProps: {
        variant: "outlined",
        size: "small"
      }
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          background: "#fffdf4"
        },
        notchedOutline: {
          borderColor: "#eadfaf"
        }
      }
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none"
        }
      }
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 999,
          fontWeight: 800
        }
      }
    },
    MuiTooltip: {
      defaultProps: {
        disableInteractive: true
      }
    },
    MuiAccordion: {
      defaultProps: {
        disableGutters: true,
        elevation: 0
      }
    }
  }
});
