import cds from "@sap/cds/eslint.config.mjs"

export default [
  ...cds,
  {
    ignores: ["**/.n8n-data/**"],
  },
  {
    files: ["**/*.js"],
    rules: {
      "no-await-in-loop": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["tests/**", "scripts/**"],
    rules: {
      "no-console": "off",
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-redeclare": "off",
    },
  },
]
