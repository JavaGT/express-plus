import globals from 'globals';

export default [
	{
		files: ['src/**/*.mjs', 'projects/**/*.mjs', '*.mjs'],
		languageOptions: {
			ecmaVersion: 2024,
			sourceType: 'module',
			globals: {
				...globals.node,
				Bun: 'readonly',
			},
		},
		rules: {
			'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
			'no-undef': 'error',
			'no-console': 'off',
		},
	},
	{
		files: ['public/**/*.mjs', 'samples/**/*.mjs'],
		languageOptions: {
			ecmaVersion: 2024,
			sourceType: 'module',
			globals: {
				...globals.browser,
				...globals.node,
			},
		},
		rules: {
			'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
			'no-undef': 'error',
			'no-console': 'off',
		},
	},
	{
		files: ['test/**/*.mjs'],
		languageOptions: {
			ecmaVersion: 2024,
			sourceType: 'module',
			globals: {
				...globals.node,
				...globals.browser,
			},
		},
		rules: {
			'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
			'no-undef': 'error',
			'no-console': 'off',
		},
	},
	{
		ignores: ['node_modules/**', 'coverage/**'],
	},
];
