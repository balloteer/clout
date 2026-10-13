// tailwind.config.js (extend)
module.exports = {
  theme: {
    extend: {
      colors: {
        'pink': '#FF3D8B',
        'lime': '#C6FF3D',
        'ink': '#15121C',
        'cream': '#FFF8EE',
        'white': '#FFFFFF',
        'yellow': '#FFD23F',
        'purple': '#2B0B5E',
        'sky': '#3DB8FF',
        'orange': '#FF7A2F',
      },
      fontFamily: {
        display: ['"Titan One"', '"Arial Rounded MT Bold"', 'sans-serif'],
        body: ['"DM Sans"', 'system-ui', 'sans-serif'],
      },
      boxShadow: { sticker: '0 6px 0 #15121C' },
    },
  },
};
