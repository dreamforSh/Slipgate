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
        "glow-sm": "0 4px 14px -4px rgb(var(--accent-glow) / 0.5)",
        "glow-danger": "0 4px 14px -4px rgb(var(--danger) / 0.5)",
      },
      /* Motion tokens mirror the --ease-* / --dur-* custom properties in style.css. */
      transitionTimingFunction: {
        out: "cubic-bezier(0.16, 1, 0.3, 1)",
        nav: "cubic-bezier(0.2, 0, 0, 1)",
        spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
        drawer: "cubic-bezier(0.32, 0.72, 0, 1)",
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
        "fade-up": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "fade-down": {
          from: { opacity: "0", transform: "translateY(-6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "pop-in": {
          "0%": { opacity: "0", transform: "scale(0.5)" },
          "60%": { opacity: "1", transform: "scale(1.1)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        shake: {
          "0%, 100%": { transform: "translateX(0)" },
          "15%": { transform: "translateX(-7px)" },
          "30%": { transform: "translateX(6px)" },
          "45%": { transform: "translateX(-4px)" },
          "60%": { transform: "translateX(3px)" },
          "75%": { transform: "translateX(-1px)" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-4px)" },
        },
        drift: {
          "0%, 100%": { transform: "translate3d(0, 0, 0) scale(1)" },
          "33%": { transform: "translate3d(24px, -18px, 0) scale(1.06)" },
          "66%": { transform: "translate3d(-18px, 14px, 0) scale(0.96)" },
        },
        countdown: { from: { transform: "scaleX(1)" }, to: { transform: "scaleX(0)" } },
        "grow-x": { from: { transform: "scaleX(0)" }, to: { transform: "scaleX(1)" } },
        draw: { from: { strokeDashoffset: "1" }, to: { strokeDashoffset: "0" } },
      },
      animation: {
        "fade-in": "fade-in 160ms ease-out",
        "slide-up": "slide-up 220ms cubic-bezier(0.2, 0, 0, 1)",
        "slide-in-right": "slide-in-right 240ms cubic-bezier(0.16, 1, 0.3, 1)",
        "scale-in": "scale-in 160ms cubic-bezier(0.16, 1, 0.3, 1)",
        "fade-up": "fade-up 420ms cubic-bezier(0.16, 1, 0.3, 1) backwards",
        "fade-down": "fade-down 260ms cubic-bezier(0.16, 1, 0.3, 1) backwards",
        "pop-in": "pop-in 380ms cubic-bezier(0.34, 1.56, 0.64, 1) backwards",
        shake: "shake 420ms cubic-bezier(0.36, 0.07, 0.19, 0.97)",
        float: "float 5s ease-in-out infinite",
        drift: "drift 22s ease-in-out infinite",
        countdown: "countdown 3s linear forwards",
        "grow-x": "grow-x 700ms cubic-bezier(0.16, 1, 0.3, 1) backwards",
        draw: "draw 900ms cubic-bezier(0.65, 0, 0.35, 1) backwards",
      },
    },
  },
  plugins: [],
};
