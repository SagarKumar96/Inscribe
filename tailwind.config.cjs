/** @type {import('tailwindcss').Config} */
module.exports = {
	content: [
		'./index.html',
		'./src/**/*.{ts,tsx}',
		'./src-tauri/**/*.{rs}',
	],
	theme: {
		extend: {},
	},
	plugins: [require('daisyui')],
};


