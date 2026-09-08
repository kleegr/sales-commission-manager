/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // GHL-style primary blue (Untitled UI blue scale).
        brand: {
          50: "#eff4ff", 100: "#d1e0ff", 200: "#b2ccff", 300: "#84adff",
          400: "#528bff", 500: "#2970ff", 600: "#155eef", 700: "#004eeb",
          800: "#0040c1", 900: "#00359e", 950: "#002266",
        },
        // Neutral gray tuned to the GHL / Untitled UI gray scale. Overrides
        // Tailwind's slate so the whole app picks up the new neutrals.
        slate: {
          50: "#f9fafb", 100: "#f2f4f7", 200: "#eaecf0", 300: "#d0d5dd",
          400: "#98a2b3", 500: "#667085", 600: "#475467", 700: "#344054",
          800: "#1d2939", 900: "#101828", 950: "#0c111d",
        },
      },
      boxShadow: {
        xs: "0 1px 2px 0 rgb(16 24 40 / 0.05)",
        card: "0 1px 2px 0 rgb(16 24 40 / 0.05)",
        dropdown: "0 4px 6px -2px rgb(16 24 40 / 0.03), 0 12px 16px -4px rgb(16 24 40 / 0.08)",
        modal: "0 8px 8px -4px rgb(16 24 40 / 0.03), 0 20px 24px -4px rgb(16 24 40 / 0.08)",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
    },
  },
  plugins: [],
};
