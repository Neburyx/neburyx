import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/dist/**', 'node_modules/**', 'tools/workspace-checks/fixtures/**'] },
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': true, 'ts-expect-error': 'allow-with-description' }],
      'no-console': 'error',
    },
  },
];
