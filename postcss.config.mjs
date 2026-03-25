// postcss.config.mjs — PostCSS Configuration
// Registers the Tailwind CSS 4 PostCSS plugin for processing utility classes.
// This is the only build-time CSS transform needed for the project.
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
