import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'dist/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Domain layer must stay framework-free (README §6): no NestJS, no ORM, no infra.
    files: ['src/**/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@nestjs/*'], message: 'Domain must not depend on NestJS.' },
            { group: ['@mikro-orm/*'], message: 'Domain must not depend on the ORM.' },
            { group: ['**/infrastructure/**', '**/application/**', '**/presentation/**'], message: 'Domain must not import outer layers.' },
          ],
        },
      ],
    },
  },
);
