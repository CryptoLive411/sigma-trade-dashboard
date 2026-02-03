/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './pages/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
    './app/**/*.{js,ts,jsx,tsx}'
  ],
  theme: {
    extend: {
      colors: {},
      boxShadow: {
        card: '0 1px 2px 0 rgb(0 0 0 / 0.05)'
      }
    }
  },
  plugins: [require('@tailwindcss/forms')],
}
