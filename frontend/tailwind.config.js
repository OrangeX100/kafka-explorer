/** Dark-first palette tuned for a dense data tool (dense-tool style). */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontSize: {
        // Type scale (bumped +1px across the board after user feedback —
        // larger palettes read noticeably larger). Dense-data UI sits between
        // Tailwind's defaults.
        // rem-based so the 界面字号 setting (root font-size) scales text
        // AND tailwind spacing together — CSS zoom broke sticky/fixed math.
        "10": ["0.6875rem", { lineHeight: "0.9375rem" }],
        "11": ["0.75rem", { lineHeight: "1rem" }],
        xs: ["0.8125rem", { lineHeight: "1.125rem" }],
        sm: ["0.9375rem", { lineHeight: "1.3125rem" }],
        base: ["0.875rem", { lineHeight: "1.25rem" }],
      },
      colors: {
        // Values live in styles.css as RGB-triplet CSS variables; the
        // <alpha-value> placeholder keeps Tailwind's /opacity modifiers
        // (e.g. border-danger/40) working on top of the token layer.
        ink: {
          950: "rgb(var(--ink-950) / <alpha-value>)",
          900: "rgb(var(--ink-900) / <alpha-value>)",
          850: "rgb(var(--ink-850) / <alpha-value>)",
          800: "rgb(var(--ink-800) / <alpha-value>)",
          700: "rgb(var(--ink-700) / <alpha-value>)",
          600: "rgb(var(--ink-600) / <alpha-value>)",
          500: "rgb(var(--ink-500) / <alpha-value>)",
          400: "rgb(var(--ink-400) / <alpha-value>)",
          300: "rgb(var(--ink-300) / <alpha-value>)",
          200: "rgb(var(--ink-200) / <alpha-value>)",
          100: "rgb(var(--ink-100) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
          hover: "rgb(var(--accent-hover) / <alpha-value>)",
          muted: "rgb(var(--accent-muted) / <alpha-value>)",
        },
        ok: "rgb(var(--ok) / <alpha-value>)",
        warn: "rgb(var(--warn) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)",
      },
      fontFamily: {
        mono: ["Consolas", "JetBrains Mono", "monospace"],
      },
    },
  },
  plugins: [],
};
