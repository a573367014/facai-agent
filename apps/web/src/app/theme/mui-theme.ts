import { createTheme } from "@mui/material/styles";

export const appTheme = createTheme({
  palette: {
    mode: "light",
    primary: {
      main: "#0f766e",
      dark: "#115e59",
      light: "#ccfbf1",
      contrastText: "#ffffff"
    },
    secondary: {
      main: "#475467",
      dark: "#344054",
      light: "#f2f4f7",
      contrastText: "#ffffff"
    },
    error: {
      main: "#dc2626",
      light: "#fef2f2",
      dark: "#b91c1c"
    },
    background: {
      default: "#f7f8fa",
      paper: "#ffffff"
    },
    text: {
      primary: "#101828",
      secondary: "#667085"
    },
    divider: "#eaecf0",
    success: {
      main: "#16a34a",
      light: "#f0fdf4",
      dark: "#15803d"
    },
    warning: {
      main: "#d97706",
      light: "#fffbeb",
      dark: "#b45309"
    }
  },
  shape: {
    borderRadius: 12
  },
  typography: {
    fontFamily:
      'Inter, "PingFang SC", "Microsoft YaHei", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    body1: {
      fontSize: "0.9375rem",
      lineHeight: 1.65
    },
    body2: {
      fontSize: "0.875rem",
      lineHeight: 1.55
    },
    button: {
      textTransform: "none",
      fontWeight: 600
    }
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          margin: 0,
          minWidth: 320,
          minHeight: "100vh",
          background: "#f7f8fa",
          color: "#101828"
        }
      }
    },
    MuiButton: {
      defaultProps: {
        disableElevation: true
      },
      styleOverrides: {
        root: {
          borderRadius: 10,
          minHeight: 44
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
          borderRadius: 12,
          background: "#ffffff"
        },
        notchedOutline: {
          borderColor: "#d0d5dd"
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
          borderRadius: 8,
          fontWeight: 600
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
    },
    MuiAlert: {
      styleOverrides: {
        root: {
          borderRadius: 12
        }
      }
    },
    MuiDrawer: {
      styleOverrides: {
        paper: {
          backgroundImage: "none",
          borderLeft: "1px solid #eaecf0",
          boxShadow: "-12px 0 32px rgb(16 24 40 / 0.08)"
        }
      }
    },
    MuiTab: {
      styleOverrides: {
        root: {
          minHeight: 44,
          textTransform: "none",
          fontWeight: 600
        }
      }
    }
  }
});
