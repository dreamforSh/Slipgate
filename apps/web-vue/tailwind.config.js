/** Design tokens live in src/style.css as RGB triplets so every color supports `/alpha`. */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{vue,ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: token("bg"),
        surface: {
          DEFAULT: token("surface"),
          2: token("surface-2"),
          3: token("surface-3"),
        },
        line: {
          DEFAULT: token("border"),
          strong: token("border-strong"),
        },
        fg: {
          DEFAULT: token("fg"),
          muted: token("fg-muted"),
          subtle: token("fg-subtle"),
        },
        accent: {
          /** Text, icons, indicators and soft `/10` tints. */
          DEFAULT: token("accent"),
          /** Solid fills that carry `accent-fg` text (primary buttons, avatars). */
          solid: token("accent-solid"),
          hover: token("accent-hover"),
          fg: token("accent-fg"),
        },
        success: token("success"),
        warning: token("warning"),
        danger: token("danger"),
        info: token("info"),
        violet: token("violet"),
      },
      borderColor: {
        DEFAULT: token("border"),
      },
      ringColor: {
        DEFAULT: token("accent"),
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "PingFang SC",
          "Hiragino Sans GB",
          "Microsoft YaHei",
          "Noto Sans CJK SC",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "Fira Code",
          "ui-monospace",
          "SFMono-Regular",
          "Cascadia Code",
          "Consolas",
          "Menlo",
          "monospace",
        ],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      boxShadow: {
        card: "0 1px 3px 0 rgb(var(--shadow) / 0.04), 0 1px 2px 0 rgb(var(--shadow) / 0.06)",
        "card-hover": "0 10px 32px -6px rgb(var(--shadow) / 0.12), 0 2px 6px -2px rgb(var(--shadow) / 0.06)",
        pop: "0 16px 40px -12px rgb(var(--shadow) / 0.3), 0 2px 6px -2px rgb(var(--shadow) / 0.12)",
        glow: "0 6px 20px -4px rgb(var(--accent-glow) / 0.45)",
      },
      transitionTimingFunction: {
        out: "cubic-bezier(0.16, 1, 0.3, 1)",
        nav: "cubic-bezier(0.2, 0, 0, 1)",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-right": {
          from: { opacity: "0", transform: "translateX(16px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "translateY(-4px) scale(0.97)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
      },
      animation: {
        "fade-in": "fade-in 160ms ease-out",
        "slide-up": "slide-up 220ms cubic-bezier(0.2, 0, 0, 1)",
        "slide-in-right": "slide-in-right 240ms cubic-bezier(0.16, 1, 0.3, 1)",
        "scale-in": "scale-in 160ms cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [],
};
