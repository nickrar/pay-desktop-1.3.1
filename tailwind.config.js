/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/index.html'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        body: ['Inter', '"Plus Jakarta Sans"', 'sans-serif'],
      },
      colors: {
        backdrop: '#E4E7EF',
        shell: '#F6F7FB',
        panel: '#F5F6FA',
        obsidian: '#18191D',
        muted: '#8D92A0',
        mint: {
          bg: '#E3F6EC',
          text: '#1F7A4C',
        },
        amberpill: {
          bg: '#FEF2D8',
          text: '#A36A14',
        },
        skypill: {
          bg: '#EBF2FC',
          text: '#3568B5',
        }
      },
      boxShadow: {
        shell: '0 26px 70px rgba(24, 25, 29, 0.08)',
        workspace: '0 8px 32px rgba(24, 25, 29, 0.03)',
        card: '0 14px 34px rgba(24, 25, 29, 0.16)',
        popover: '0 18px 40px rgba(24, 25, 29, 0.28)',
        pill: '0 3px 12px rgba(24, 25, 29, 0.04)',
      }
    }
  }
};
