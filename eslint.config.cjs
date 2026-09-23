'use strict';

const metarhia = require('eslint-config-metarhia');

module.exports = [
  ...metarhia,
  {
    files: ['**/*.js'],
    languageOptions: {
      globals: {
        api: 'readonly',
        application: 'readonly',
        config: 'readonly',
        context: 'readonly',
        db: 'readonly',
        domain: 'readonly',
        lib: 'readonly',
        metarhia: 'readonly',
        npm: 'readonly',
      },
    },
    rules: {
      'arrow-body-style': 'off',
      'linebreak-style': 'off',
      'max-len': 'off',
      'no-unused-vars': 'off',
      'prefer-template': 'off',
      strict: 'off',
    },
  },
  {
    files: ['application/static/**/*.js'],
    languageOptions: {
      sourceType: 'module',
    },
  },
];
