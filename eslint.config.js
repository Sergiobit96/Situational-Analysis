import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    // ({ bot: _bot, ...resto }) es la forma de quitar una clave de un objeto
    rules: { 'no-unused-vars': ['error', { ignoreRestSiblings: true }] },
  },
  // el servidor, las funciones de Vercel, los scripts y los tests corren en Node, no en el navegador
  {
    files: ['server/**/*.{js,mjs}', 'api/**/*.js', 'scripts/**/*.{js,mjs}', 'test/**/*.{js,mjs}', '*.config.js'],
    languageOptions: { globals: globals.node },
  },
])
