export default [
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module" },
    rules: {
      "no-unused-vars": "error",
      "no-undef": "error",
      "no-console": "off"
    }
  }
];