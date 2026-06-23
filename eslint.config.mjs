// ESLint flat config. Cubre solo el código modular y testeable: la capa de
// cálculo (core/) y el Worker (worker/src/). El script inline del HTML queda
// fuera a propósito (es un único bloque grande con patrones intencionales).
import js from '@eslint/js';

export default [
    js.configs.recommended,
    {
        // core/calc.js: módulo UMD (se carga como <script>, no como ES module).
        files: ['core/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                module: 'readonly', window: 'readonly', self: 'readonly', globalThis: 'readonly'
            }
        },
        rules: {
            'no-unused-vars': 'warn'
        }
    },
    {
        // worker/src: ES modules sobre el runtime de Cloudflare Workers (Web APIs).
        files: ['worker/src/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                crypto: 'readonly', fetch: 'readonly', Response: 'readonly', Request: 'readonly',
                URL: 'readonly', URLSearchParams: 'readonly', btoa: 'readonly', atob: 'readonly',
                Blob: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', console: 'readonly',
                setTimeout: 'readonly', Date: 'readonly'
            }
        },
        rules: {
            'no-unused-vars': 'warn'
        }
    }
];
