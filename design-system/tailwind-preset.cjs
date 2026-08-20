// Kleegr shared Tailwind preset (Tailwind v3).
//
// Drop into an app's tailwind.config.js:
//   const kleegr = require("./src/ds/tailwind-preset.cjs");
//   module.exports = { presets: [kleegr], content: [...], /* app extends */ };
//
// It contributes ONLY the shared design tokens (brand blue ramp + Inter). Apps
// keep their own `content` globs and may extend further. Tailwind v4 apps do NOT
// use this file — they import ds/theme.css instead (see DESIGN_SYSTEM.md).
/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef4ff",
          100: "#d9e6ff",
          200: "#bcd2ff",
          300: "#8eb4ff",
          400: "#598cff",
          500: "#3366ff",
          600: "#1f47f5",
          700: "#1837e1",
          800: "#1a30b6",
          900: "#1c2f8f",
          950: "#161e57",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
    },
  },
};
